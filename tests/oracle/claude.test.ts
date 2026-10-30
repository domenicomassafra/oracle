import { afterEach, describe, expect, test, vi } from "vitest";
import { createClaudeClient, resolveClaudeModelId } from "../../src/oracle/claude.js";
import type { OracleRequestBody } from "../../src/oracle/types.js";

const mockBody: OracleRequestBody = {
  model: "claude-4.1-opus",
  instructions: "respond helpfully",
  input: [
    {
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  ],
};

describe("claude client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("resolveClaudeModelId normalizes known aliases", () => {
    expect(resolveClaudeModelId("claude-4.1-opus")).toBe("claude-opus-4-1");
    expect(resolveClaudeModelId("claude-4.6-sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveClaudeModelId("claude-4.5-sonnet")).toBe("claude-sonnet-4-5");
    expect(resolveClaudeModelId("claude-something-else")).toBe("claude-something-else");
  });

  test("createClaudeClient maps text output", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      text: async () =>
        JSON.stringify({
          id: "abc",
          content: [{ text: "hi there" }],
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClaudeClient("sk-test", "claude-4.1-opus");
    const resp = await client.responses.create(mockBody);

    expect(fetchMock).toHaveBeenCalled();
    expect(resp.output_text?.[0]).toBe("hi there");
    expect(resp.usage?.total_tokens).toBe(3);
  });

  test("forwards all input text, system instructions and output limit through both request paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      text: async () => JSON.stringify({ id: "mock", content: [{ text: "done" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const body: OracleRequestBody = {
      ...mockBody,
      instructions: "Follow these system rules.",
      max_output_tokens: 777,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "first" },
            { type: "input_text", text: "second" },
          ],
        },
        { role: "user", content: [{ type: "input_text", text: "third" }] },
      ],
    };
    const client = createClaudeClient(
      "sk-test",
      "claude-4.6-sonnet",
      undefined,
      "https://mock.invalid/v1/messages",
    );
    await client.responses.create(body);
    const stream = await client.responses.stream(body);
    const deltas: string[] = [];
    for await (const event of stream) {
      if (event.delta) deltas.push(event.delta);
    }
    expect(deltas).toEqual(["done"]);
    expect((await stream.finalResponse()).output_text?.[0]).toBe("done");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("https://mock.invalid/v1/messages");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        "content-type": "application/json",
        "x-api-key": "sk-test",
        "anthropic-version": "2023-06-01",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "claude-sonnet-4-6",
        max_tokens: 777,
        system: "Follow these system rules.",
        messages: [{ role: "user", content: "first\n\nsecond\n\nthird" }],
        stream: false,
      });
    }
  });

  test("keeps the default output limit and omits blank system text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      text: async () => JSON.stringify({ id: "mock", content: [{ text: "done" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await createClaudeClient("sk-test", "claude-4.1-opus").responses.create({
      ...mockBody,
      instructions: "  ",
      input: [],
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "claude-opus-4-1",
      max_tokens: 2048,
      messages: [{ role: "user", content: "" }],
      stream: false,
    });
  });

  test("createClaudeClient reports empty responses clearly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 529,
        statusText: "Overloaded",
        text: async () => "",
      }),
    );

    const client = createClaudeClient("sk-test", "claude-4.1-opus");
    await expect(client.responses.create(mockBody)).rejects.toThrow(
      "Claude request failed (529 Overloaded): empty response",
    );
  });

  test("createClaudeClient reports invalid JSON responses clearly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 502,
        statusText: "Bad Gateway",
        text: async () => "<html>bad gateway</html>",
      }),
    );

    const client = createClaudeClient("sk-test", "claude-4.1-opus");
    await expect(client.responses.create(mockBody)).rejects.toThrow(
      "Claude request failed (502 Bad Gateway): invalid JSON response: <html>bad gateway</html>",
    );
  });
});
