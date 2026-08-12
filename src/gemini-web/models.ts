import { randomUUID } from "node:crypto";
import type { BrowserLogger } from "../browser/types.js";

export type GeminiWebModelId =
  | "gemini-3.5-flash-lite"
  | "gemini-3.6-flash"
  | "gemini-3.1-pro"
  | "gemini-3-pro-deep-think";

export const DEFAULT_GEMINI_WEB_MODEL: GeminiWebModelId = "gemini-3.1-pro";
export const FALLBACK_GEMINI_WEB_MODEL: GeminiWebModelId = "gemini-3.5-flash-lite";

interface GeminiWebModelSpec {
  hash: string;
  modelCode: number;
  thinkingCode: number;
}

const MODEL_SPECS: Record<GeminiWebModelId, GeminiWebModelSpec> = {
  "gemini-3.5-flash-lite": {
    hash: "cf41b0e0dd7d53e5",
    modelCode: 6,
    thinkingCode: 1,
  },
  "gemini-3.6-flash": {
    hash: "fbb127bbb056c959",
    modelCode: 1,
    thinkingCode: 1,
  },
  "gemini-3.1-pro": {
    hash: "9d8ca3786ebdfbea",
    modelCode: 3,
    thinkingCode: 1,
  },
  "gemini-3-pro-deep-think": {
    hash: "9d8ca3786ebdfbea",
    modelCode: 3,
    thinkingCode: 3,
  },
};

let clientId: string | undefined;

function getGeminiWebClientId(): string {
  clientId ??= randomUUID().toUpperCase();
  return clientId;
}

export function buildGeminiWebModelHeader(
  model: GeminiWebModelId,
  webClientId = getGeminiWebClientId(),
): string {
  const spec = MODEL_SPECS[model];
  return JSON.stringify([
    1,
    null,
    null,
    null,
    spec.hash,
    null,
    null,
    1,
    [4, 5, 6, 8],
    null,
    null,
    3,
    null,
    null,
    spec.modelCode,
    spec.thinkingCode,
    webClientId,
  ]);
}

export function resolveGeminiWebModel(
  desiredModel: string | null | undefined,
  log?: BrowserLogger,
): GeminiWebModelId {
  const desired = typeof desiredModel === "string" ? desiredModel.trim() : "";
  if (!desired) return DEFAULT_GEMINI_WEB_MODEL;
  const normalized = desired.toLowerCase().replace(/[_\s]+/g, "-");

  switch (normalized) {
    case "gemini-3.1-pro":
    case "gemini-3-pro":
    case "gemini-3.0-pro":
      return "gemini-3.1-pro";
    case "gemini-3.6-flash":
      return "gemini-3.6-flash";
    case "gemini-3.5-flash-lite":
    case "gemini-3.5-flashlite":
      return "gemini-3.5-flash-lite";
    case "gemini-3-deep-think":
    case "gemini-3-pro-deep-think":
    case "gemini-3-pro-deepthink":
    case "gemini-3.1-pro-deep-think":
      return "gemini-3-pro-deep-think";
    case "gemini-2.5-pro":
      return "gemini-3.1-pro";
    case "gemini-2.5-flash":
      return "gemini-3.5-flash-lite";
    default:
      if (normalized.startsWith("gemini-") || normalized.includes("gemini")) {
        log?.(
          `[gemini-web] Unsupported Gemini web model "${desired}". Falling back to ${DEFAULT_GEMINI_WEB_MODEL}.`,
        );
      }
      return DEFAULT_GEMINI_WEB_MODEL;
  }
}
