import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createClaudeClient } from "../../src/oracle/claude.js";
import { createDefaultClientFactory } from "../../src/oracle/client.js";
import type { OracleRequestBody } from "../../src/oracle/types.js";

const body: OracleRequestBody = {
  model: "claude-4.6-sonnet",
  instructions: "Keep the original instructions",
  max_output_tokens: 777,
  input: [
    { role: "user", content: [{ type: "input_text", text: "part A" }] },
    { role: "user", content: [{ type: "input_text", text: "part B" }] },
  ],
};

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const start = sse("message_start", {
  type: "message_start",
  message: { id: "msg_local", usage: { input_tokens: 13, output_tokens: 1 } },
});
const first = sse("content_block_delta", {
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text: "Hello" },
});
const second = sse("content_block_delta", {
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text: " world" },
});
const end =
  sse("message_delta", { type: "message_delta", usage: { output_tokens: 7 } }) +
  sse("message_stop", { type: "message_stop" });

const servers: Array<ReturnType<typeof createServer>> = [];

async function localServer(
  reply: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer((request, response) => {
    void Promise.resolve(reply(request, response)).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

describe("Claude genuine HTTP/SSE streaming", () => {
  test("clientFactory selects the native Claude streaming client", async () => {
    const requests: Array<{ url: string; payload: { stream: boolean }; key: string | null }> = [];
    const url = await localServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        url: request.url ?? "",
        payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream: boolean },
        key: request.headers["x-api-key"] as string,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(start + first + second + end);
    });
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) =>
      nativeFetch(url, init),
    );

    const factory = createDefaultClientFactory();
    const client = factory("local-key", { model: "claude-4.6-sonnet" });
    const stream = await client.responses.stream(body);
    const deltas: string[] = [];
    for await (const event of stream) {
      if (event.delta) deltas.push(event.delta);
    }
    expect(deltas).toEqual(["Hello", " world"]);
    expect((await stream.finalResponse()).usage?.total_tokens).toBe(20);
    expect(requests).toMatchObject([
      { url: "/v1/messages", payload: { stream: true }, key: "local-key" },
    ]);
  });

  test("delivers successive text deltas before the final SSE and tracks final usage", async () => {
    let sentFinal = false;
    const requests: Array<Record<string, unknown>> = [];
    const url = await localServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.write(start + sse("ping", { type: "ping" }) + first);
      await delay(45);
      response.write(second + end);
      sentFinal = true;
      response.end();
    });

    const stream = await createClaudeClient(
      "local-key",
      "claude-4.6-sonnet",
      undefined,
      url,
    ).responses.stream(body);
    const iterator = stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "response.output_text.delta", delta: "Hello" },
    });
    expect(sentFinal).toBe(false);
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "response.output_text.delta", delta: " world" },
    });
    expect((await iterator.next()).done).toBe(true);
    expect(await stream.finalResponse()).toEqual({
      id: "msg_local",
      status: "completed",
      output_text: ["Hello world"],
      output: [{ type: "text", text: "Hello world" }],
      usage: { input_tokens: 13, output_tokens: 7, total_tokens: 20 },
    });
    expect(requests).toEqual([
      {
        model: "claude-sonnet-4-6",
        max_tokens: 777,
        system: "Keep the original instructions",
        messages: [{ role: "user", content: "part A\n\npart B" }],
        stream: true,
      },
    ]);
  });

  test("finalResponse consumes an uniterated stream, including CRLF and split data lines", async () => {
    const url = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(start.replaceAll("\n", "\r\n"));
      response.write(
        "event: content_block_delta\r\ndata: " +
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hi" },
          }).slice(0, 37),
      );
      response.end(
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" },
        }).slice(37) +
          "\r\n\r\n" +
          end.replaceAll("\n", "\r\n"),
      );
    });
    const stream = await createClaudeClient("key", body.model, undefined, url).responses.stream(
      body,
    );
    expect((await stream.finalResponse()).output_text).toEqual(["Hi"]);
    expect((await stream.finalResponse()).usage?.total_tokens).toBe(20);
  });

  test.each([
    [
      "bad SSE JSON",
      start + "event: content_block_delta\ndata: {bad json}\n\n" + end,
      /invalid SSE JSON/i,
    ],
    [
      "provider SSE error",
      start + sse("error", { type: "error", error: { message: "overloaded" } }),
      /overloaded/i,
    ],
    ["missing message_stop", start + first, /message_stop/i],
  ])("rejects %s instead of returning a successful partial answer", async (_name, wire, error) => {
    const url = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(wire);
    });
    const stream = await createClaudeClient("key", body.model, undefined, url).responses.stream(
      body,
    );
    await expect(stream.finalResponse()).rejects.toThrow(error);
  });

  test("rejects non-2xx HTTP responses and does not treat JSON errors as SSE", async () => {
    const url = await localServer((_request, response) => {
      response.writeHead(529, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Provider overloaded" } }));
    });
    await expect(
      createClaudeClient("key", body.model, undefined, url).responses.stream(body),
    ).rejects.toThrow(/529|Provider overloaded/);
  });
});
