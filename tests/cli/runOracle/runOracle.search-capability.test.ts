import { describe, expect, test } from "vitest";

import { runOracle } from "@src/oracle.ts";
import type { ModelName } from "@src/oracle.ts";
import { MockClient, MockStream, buildResponse } from "./helpers.ts";

async function captureSearchRequest(model: ModelName, search?: boolean) {
  const client = new MockClient(new MockStream([], buildResponse()));
  const logs: string[] = [];
  await runOracle(
    {
      model,
      prompt: "Verify search tool capabilities for this request",
      search,
      background: false,
    },
    { apiKey: "test-only", client, log: (line) => logs.push(line), allowStdout: false },
  );
  return { request: client.lastRequest, logs };
}

describe("runOracle search capability", () => {
  test.each(["claude-4.6-sonnet", "claude-4.1-opus"] as const)(
    "%s omits unsupported web search by default and warns",
    async (model) => {
      const { request, logs } = await captureSearchRequest(model);
      expect(request?.tools).toBeUndefined();
      expect(logs.join("\n")).toContain(
        "Search tool is not supported for this model; ignoring --search.",
      );
    },
  );

  test("Claude also gates explicit --search, but --no-search needs no warning", async () => {
    const enabled = await captureSearchRequest("claude-4.6-sonnet", true);
    expect(enabled.request?.tools).toBeUndefined();
    expect(enabled.logs.join("\n")).toContain("ignoring --search");

    const disabled = await captureSearchRequest("claude-4.6-sonnet", false);
    expect(disabled.request?.tools).toBeUndefined();
    expect(disabled.logs.join("\n")).not.toContain("ignoring --search");
  });

  test.each([
    ["gpt-5.6-sol", "web_search_preview"],
    ["gemini-3.5-flash", "web_search_preview"],
    ["grok-4.1", "web_search"],
  ] as const)("%s keeps supported search type %s", async (model, type) => {
    const { request, logs } = await captureSearchRequest(model);
    expect(request?.tools).toEqual([{ type }]);
    expect(logs.join("\n")).not.toContain("ignoring --search");
  });
});
