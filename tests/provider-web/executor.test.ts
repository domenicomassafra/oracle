import { describe, expect, test } from "vitest";
import { resolveProviderWebTarget } from "../../src/provider-web/executor.js";

describe("resolveProviderWebTarget", () => {
  test.each([
    ["claude-sonnet-5", "claude", "Sonnet 5"],
    ["claude-haiku-4.5", "claude", "Haiku 4.5"],
    ["grok-4.1", "grok", "Veloce"],
  ])("maps %s to %s / %s", (model, provider, label) => {
    expect(resolveProviderWebTarget(model)).toMatchObject({ provider, label });
  });

  test("rejects unsupported providers", () => {
    expect(() => resolveProviderWebTarget("llama")).toThrow(/Unsupported provider web model/);
  });
});
