import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { readDevToolsPort } from "../browser/profileState.js";
import type { BrowserRunOptions, BrowserRunResult } from "../browser/types.js";
import { estimateTokenCount } from "../browser/utils.js";

type Provider = "claude" | "grok";

const CLAUDE_URL = "https://claude.ai/new";
const GROK_URL = "https://grok.com/?q=&reasoningMode=none&voice=false";

export function resolveProviderWebTarget(model: string): {
  provider: Provider;
  url: string;
  label: string;
} {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("claude")) {
    return {
      provider: "claude",
      url: CLAUDE_URL,
      label: normalized.includes("haiku") ? "Haiku 4.5" : "Sonnet 5",
    };
  }
  if (normalized.startsWith("grok")) {
    return { provider: "grok", url: GROK_URL, label: "Veloce" };
  }
  throw new Error(`Unsupported provider web model: ${model}`);
}

async function resolveBrowserUrl(config: BrowserRunOptions["config"]): Promise<string> {
  if (config?.remoteChrome) {
    return `http://${config.remoteChrome.host}:${config.remoteChrome.port}`;
  }
  if (config?.debugPort) {
    return `http://127.0.0.1:${config.debugPort}`;
  }
  const profileDir =
    config?.manualLoginProfileDir ??
    path.join(os.homedir(), ".local", "state", "oracle", "browser-profile");
  const port = await readDevToolsPort(profileDir);
  if (!port) {
    throw new Error(
      `No signed-in Oracle browser is running for ${profileDir}. Start the manual-login browser or pass --remote-chrome host:port.`,
    );
  }
  return `http://127.0.0.1:${port}`;
}

async function clickButtonByText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((expected) => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === expected,
    );
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  }, text);
}

async function closeGrokOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    const exactButton = (text: string) =>
      Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === text,
      );
    const rejectX = exactButton("Rifiuta") ?? exactButton("Reject");
    if (rejectX instanceof HTMLElement) rejectX.click();
    const privacyClose = Array.from(document.querySelectorAll("button")).find((candidate) =>
      /close privacy preference center|chiudi il centro preferenze/i.test(
        candidate.getAttribute("aria-label") ?? "",
      ),
    );
    if (privacyClose instanceof HTMLElement) privacyClose.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function selectClaudeModel(page: Page, label: string): Promise<string> {
  const opened = await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
      /^(model|modello):/i.test(candidate.getAttribute("aria-label") ?? ""),
    );
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  });
  if (!opened) throw new Error("Claude model picker is not available in the signed-in session.");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const selected = await page.evaluate((expected) => {
    const option = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(
      (candidate) => candidate.textContent?.trim().startsWith(expected),
    );
    if (!(option instanceof HTMLElement)) return false;
    option.click();
    return true;
  }, label);
  if (!selected) throw new Error(`Claude web model ${label} is not offered by this account.`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const active = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll("button"))
        .map((candidate) => candidate.getAttribute("aria-label") ?? "")
        .find((value) => /^(model|modello):/i.test(value)) ?? "",
  );
  if (!active.includes(label)) {
    throw new Error(`Claude model selection did not stick (expected ${label}, got ${active}).`);
  }
  return active.replace(/^(model|modello):\s*/i, "");
}

async function submitClaude(page: Page, prompt: string): Promise<string> {
  const initialCount = await page.$$eval(".font-claude-response", (nodes) => nodes.length);
  const typed = await page.evaluate((value) => {
    const editor = Array.from(document.querySelectorAll('[contenteditable="true"]')).find(
      (candidate) => /prompt.*claude|claude.*prompt/i.test(candidate.getAttribute("aria-label") ?? ""),
    );
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    document.execCommand("selectAll");
    document.execCommand("insertText", false, value);
    editor.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
    );
    return editor.textContent?.trim().length === value.length;
  }, prompt);
  if (!typed) throw new Error("Claude prompt composer is not ready.");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (before) => {
      const responses = Array.from(document.querySelectorAll(".font-claude-response"));
      if (responses.length <= before) return false;
      const latest = responses.at(-1);
      const container = latest?.parentElement;
      return (
        container?.getAttribute("data-is-streaming") === "false" &&
        Boolean(latest?.textContent?.trim())
      );
    },
    { timeout: 120_000 },
    initialCount,
  );
  return page.$eval(".font-claude-response:last-of-type", (node) => node.textContent?.trim() ?? "");
}

async function submitGrok(page: Page, prompt: string): Promise<string> {
  await closeGrokOverlays(page);
  const initialCount = await page.$$eval('[data-testid="assistant-message"]', (nodes) => nodes.length);
  const typed = await page.evaluate((value) => {
    const editor = Array.from(document.querySelectorAll('[contenteditable="true"]')).find(
      (candidate) => /ask grok/i.test(candidate.getAttribute("aria-label") ?? ""),
    );
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    document.execCommand("selectAll");
    document.execCommand("insertText", false, value);
    editor.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
    );
    return editor.textContent?.trim().length === value.length;
  }, prompt);
  if (!typed) throw new Error("Grok prompt composer is not ready.");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const sent = await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
      /^(send|invia)$/i.test(candidate.getAttribute("aria-label") ?? ""),
    );
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  });
  if (!sent) throw new Error("Grok send button is not available.");
  await page.waitForFunction(
    (before) => {
      const responses = Array.from(document.querySelectorAll('[data-testid="assistant-message"]'));
      return responses.length > before && Boolean(responses.at(-1)?.textContent?.trim());
    },
    { timeout: 120_000 },
    initialCount,
  );
  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await page.$eval(
      '[data-testid="assistant-message"]:last-of-type',
      (node) => node.textContent?.trim() ?? "",
    );
    stable = current && current === previous ? stable + 1 : 0;
    if (stable >= 2) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return previous;
}

export function createProviderWebExecutor(): (
  runOptions: BrowserRunOptions,
) => Promise<BrowserRunResult> {
  return async (runOptions) => {
    const startedAt = Date.now();
    const target = resolveProviderWebTarget(runOptions.config?.desiredModel ?? "");
    const browserUrl = await resolveBrowserUrl(runOptions.config);
    let browser: Browser | undefined;
    let page: Page | undefined;
    try {
      browser = await puppeteer.connect({ browserURL: browserUrl });
      page = await browser.newPage();
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await new Promise((resolve) => setTimeout(resolve, 800));
      let selectedLabel = target.label;
      let answerText: string;
      if (target.provider === "claude") {
        selectedLabel = await selectClaudeModel(page, target.label);
        answerText = await submitClaude(page, runOptions.prompt);
      } else {
        await closeGrokOverlays(page);
        const fastVisible = await clickButtonByText(page, target.label);
        if (fastVisible) await page.keyboard.press("Escape");
        answerText = await submitGrok(page, runOptions.prompt);
      }
      const tookMs = Date.now() - startedAt;
      runOptions.log?.(
        `[${target.provider}-web] Completed with ${selectedLabel} in ${tookMs}ms; account identity redacted.`,
      );
      return {
        answerText,
        answerMarkdown: answerText,
        tookMs,
        answerTokens: estimateTokenCount(answerText),
        answerChars: answerText.length,
        browserTransport: "cdp",
        chromeHost: new URL(browserUrl).hostname,
        chromePort: Number(new URL(browserUrl).port),
        tabUrl: page.url(),
        promptSubmitted: true,
        modelSelection: {
          requestedModel: target.label,
          resolvedLabel: selectedLabel,
          strategy: "select",
          status: "switched",
          verified: true,
          source: "config",
          capturedAt: new Date().toISOString(),
        },
      };
    } finally {
      if (page && !runOptions.config?.keepBrowser) await page.close().catch(() => undefined);
      await browser?.disconnect().catch(() => undefined);
    }
  };
}
