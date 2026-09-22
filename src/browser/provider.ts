export type BrowserProvider = "chatgpt" | "gemini" | "claude" | "grok";

export function resolveBrowserProvider(model: unknown): BrowserProvider | undefined {
  if (typeof model !== "string") return undefined;
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("gemini")) return "gemini";
  if (normalized.startsWith("claude")) return "claude";
  if (normalized.startsWith("grok")) return "grok";
  if (normalized.startsWith("gpt-")) return "chatgpt";
  return undefined;
}

export function resolveRemoteBrowserModel(
  model: unknown,
  desiredModel: unknown,
): string | undefined {
  if (model !== undefined) {
    if (typeof model === "string" && resolveBrowserProvider(model)) return model;
    throw new Error(
      `Unsupported browser model: ${String(model)}. Use a GPT, Gemini, Claude, or Grok model.`,
    );
  }
  if (typeof desiredModel === "string" && resolveBrowserProvider(desiredModel)) return desiredModel;
  // Older ChatGPT clients send only a picker label, or omit the selection entirely.
  if (
    desiredModel == null ||
    (typeof desiredModel === "string" &&
      /^(?:|latest|auto|pro|thinking|instant)(?:\s.*)?$/i.test(desiredModel.trim()))
  )
    return undefined;
  throw new Error(
    `Unsupported browser model: ${String(desiredModel)}. Use a GPT, Gemini, Claude, or Grok model.`,
  );
}
