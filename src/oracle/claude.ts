import type {
  ClientLike,
  ModelName,
  OracleRequestBody,
  OracleResponse,
  ResponseStreamEvent,
  ResponseStreamLike,
} from "./types.js";

const DEFAULT_CLAUDE_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

function extractPrompt(body: OracleRequestBody): string {
  return (body.input ?? [])
    .flatMap((item) => item.content ?? [])
    .map((piece) => (piece.type === "input_text" ? piece.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

async function callClaude({
  apiKey,
  model,
  body,
  endpoint,
  stream = false,
}: {
  apiKey: string;
  model: string;
  body: OracleRequestBody;
  endpoint?: string;
  stream?: boolean;
}): Promise<Response> {
  const url = endpoint?.trim() || DEFAULT_CLAUDE_ENDPOINT;
  const payload: Record<string, unknown> = {
    model,
    max_tokens: body.max_output_tokens ?? 2048,
    ...(body.instructions?.trim() ? { system: body.instructions } : {}),
    messages: [
      {
        role: "user",
        content: extractPrompt(body),
      },
    ],
    stream,
  };

  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
  });
}

async function parseClaudeResponse(raw: Response): Promise<OracleResponse> {
  const body = await raw.text();
  if (!body.trim()) {
    throw new Error(
      `Claude request failed (${raw.status} ${raw.statusText || "unknown status"}): empty response`,
    );
  }
  let json: {
    id?: string;
    content?: Array<{ text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  try {
    json = JSON.parse(body) as typeof json;
  } catch (error) {
    const snippet = body.slice(0, 160).replace(/\s+/g, " ").trim();
    throw new Error(
      `Claude request failed (${raw.status} ${raw.statusText || "unknown status"}): invalid JSON response${
        snippet ? `: ${snippet}` : ""
      }`,
      { cause: error },
    );
  }
  if (json.error) {
    throw new Error(json.error.message || "Claude request failed");
  }
  const textParts = json.content?.map((part) => part.text ?? "").filter(Boolean) ?? [];
  const outputText = textParts.join("");
  return {
    id: json.id ?? `claude-${Date.now()}`,
    status: "completed",
    output_text: [outputText],
    output: [{ type: "text", text: outputText }],
    usage: {
      input_tokens: json.usage?.input_tokens ?? 0,
      output_tokens: json.usage?.output_tokens ?? 0,
      total_tokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
    },
  };
}

function parseClaudeStream(raw: Response): ResponseStreamLike {
  if (!raw.body) {
    throw new Error("Claude streaming response has no body");
  }

  const reader = raw.body.getReader();
  const decoder = new TextDecoder();
  const blocks = new Map<number, string>();
  let id = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let completed = false;
  let final: OracleResponse | undefined;
  let streamError: unknown;

  const iterator = (async function* (): AsyncGenerator<ResponseStreamEvent> {
    let buffer = "";
    let eventName = "";
    let dataLines: string[] = [];

    try {
      while (!completed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let endOfLine: number;
        while ((endOfLine = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, endOfLine).replace(/\r$/, "");
          buffer = buffer.slice(endOfLine + 1);
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trimStart();
            continue;
          }
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
            continue;
          }
          if (line !== "" || dataLines.length === 0) continue;

          const data = dataLines.join("\n");
          dataLines = [];
          let event: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(data);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("Expected an event object");
            }
            event = parsed as Record<string, unknown>;
          } catch (error) {
            throw new Error("Claude stream received invalid SSE JSON", { cause: error });
          }
          const type = typeof event.type === "string" ? event.type : eventName;
          eventName = "";

          if (type === "error") {
            const error = event.error as { message?: string } | undefined;
            throw new Error(`Claude stream failed: ${error?.message ?? "unknown provider error"}`);
          }
          if (type === "message_start") {
            const message = event.message as
              | { id?: string; usage?: { input_tokens?: number; output_tokens?: number } }
              | undefined;
            id = message?.id ?? "";
            inputTokens = message?.usage?.input_tokens ?? inputTokens;
            outputTokens = message?.usage?.output_tokens ?? outputTokens;
          } else if (type === "message_delta") {
            const usage = event.usage as
              | { input_tokens?: number; output_tokens?: number }
              | undefined;
            inputTokens = usage?.input_tokens ?? inputTokens;
            outputTokens = usage?.output_tokens ?? outputTokens;
          } else if (type === "content_block_start" || type === "content_block_delta") {
            const index = event.index;
            if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
              throw new Error("Claude stream received invalid content block index");
            }
            const content =
              type === "content_block_start"
                ? (event.content_block as { type?: string; text?: string } | undefined)
                : (event.delta as { type?: string; text?: string } | undefined);
            const isText =
              content?.type === (type === "content_block_start" ? "text" : "text_delta");
            if (isText && typeof content?.text === "string" && content.text) {
              blocks.set(index, (blocks.get(index) ?? "") + content.text);
              yield { type: "response.output_text.delta", delta: content.text };
            }
          } else if (type === "message_stop") {
            if (!id) throw new Error("Claude stream missing message_start");
            completed = true;
            break;
          }
          // Ping and unknown future event types are harmless.
        }
      }

      if (!completed) throw new Error("Claude stream ended before message_stop");
      const text = [...blocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, value]) => value)
        .join("");
      final = {
        id,
        status: "completed",
        output_text: [text],
        output: [{ type: "text", text }],
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      };
    } catch (error) {
      streamError = error;
      throw error;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  })();

  return {
    [Symbol.asyncIterator]: () => iterator,
    finalResponse: async () => {
      if (!final && !streamError) {
        for await (const _ of iterator) {
          // Drain the stream if the caller requested the final result first.
        }
      }
      if (streamError) throw streamError;
      if (!final) throw new Error("Claude stream did not complete");
      return final;
    },
  };
}

export function createClaudeClient(
  apiKey: string,
  modelName: ModelName,
  resolvedModelId?: string,
  baseUrl?: string,
): ClientLike {
  const modelId = resolveClaudeModelId(resolvedModelId ?? modelName);

  const stream = async (body: OracleRequestBody): Promise<ResponseStreamLike> => {
    const resp = await callClaude({
      apiKey,
      model: modelId,
      body,
      stream: true,
      endpoint: baseUrl,
    });
    if (!resp.ok) {
      const errorBody = await resp.text();
      let message = errorBody.slice(0, 160);
      try {
        const parsed = JSON.parse(errorBody) as { error?: { message?: string } };
        message = parsed.error?.message ?? message;
      } catch {
        // Preserve a bounded diagnostic for non-JSON provider errors.
      }
      throw new Error(`Claude request failed (${resp.status} ${resp.statusText}): ${message}`);
    }
    return parseClaudeStream(resp);
  };

  const create = async (body: OracleRequestBody): Promise<OracleResponse> => {
    const resp = await callClaude({
      apiKey,
      model: modelId,
      body,
      stream: false,
      endpoint: baseUrl,
    });
    return parseClaudeResponse(resp);
  };

  const retrieve = async (id: string): Promise<OracleResponse> => ({
    id,
    status: "error",
    error: { message: "Retrieve by ID not supported for Claude API yet." },
  });

  return {
    responses: {
      stream,
      create,
      retrieve,
    },
  };
}

export function resolveClaudeModelId(modelName: string): string {
  if (modelName === "claude-4.6-sonnet" || modelName === "claude-sonnet-4-6") {
    return "claude-sonnet-4-6";
  }
  if (
    modelName === "claude-4.5-sonnet" ||
    modelName === "claude-sonnet-4-5" ||
    modelName === "claude-sonnet-4-5-20250929"
  ) {
    return "claude-sonnet-4-5";
  }
  if (modelName === "claude-4.1-opus" || modelName === "claude-opus-4-1-20240808") {
    return "claude-opus-4-1";
  }
  return modelName;
}
