import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CLAUDE_COMPOSER_SELECTOR,
  GROK_COMPOSER_SELECTOR,
  resolveProviderWebTarget,
} from "../../src/provider-web/executor.js";
import { FakeDocument, FakeElement } from "../browser/domFixture.js";

describe("resolveProviderWebTarget", () => {
  test("finds the Italian Grok editor by its stable combobox role", () => {
    const document = new FakeDocument([
      new FakeElement("div", {
        contenteditable: "true",
        role: "combobox",
        "aria-label": "Chiedi a Grok qualsiasi cosa",
      }),
    ]);
    expect(document.querySelector(GROK_COMPOSER_SELECTOR)).not.toBeNull();
  });

  test("finds the Italian Claude editor by its stable test id", () => {
    const document = new FakeDocument([
      new FakeElement("div", {
        contenteditable: "true",
        role: "textbox",
        "data-testid": "chat-input",
        "aria-label": "Scrivi il tuo prompt per Claude",
      }),
    ]);
    expect(document.querySelector(CLAUDE_COMPOSER_SELECTOR)).not.toBeNull();
  });

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

  test("ships puppeteer-core as a runtime dependency", () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(packageJson.dependencies?.["puppeteer-core"]).toBeTruthy();
    expect(packageJson.devDependencies?.["puppeteer-core"]).toBeUndefined();
  });
});
