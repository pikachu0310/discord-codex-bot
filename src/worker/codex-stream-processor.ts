export interface ParsedCodexLine {
  raw: string;
  json?: Record<string, unknown>;
  text?: string;
  finalText?: string;
  sessionId?: string;
  rateLimitTimestamp?: number;
  usage?: ParsedUsage;
}

export interface ParsedUsage {
  inputTokens: number;
  cachedInputTokens: number;
  processingTokens: number;
  outputTokens: number;
  totalTokens?: number;
  costUsd?: number;
  model?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim().replaceAll(",", "");
    const direct = Number(normalized);
    if (Number.isFinite(direct)) return direct;
    const match = normalized.match(/-?\d+(?:\.\d+)?/);
    if (!match) return undefined;
    const extracted = Number(match[0]);
    return Number.isFinite(extracted) ? extracted : undefined;
  }
  return undefined;
}

function firstNumber(
  container: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  if (!container) return undefined;
  for (const key of keys) {
    const value = asNumber(container[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstString(
  container: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!container) return undefined;
  for (const key of keys) {
    const value = container[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function extractUsageFromJson(
  json: Record<string, unknown>,
): ParsedUsage | undefined {
  const response = asRecord(json.response);
  const usage = asRecord(json.usage) ?? asRecord(response?.usage);
  if (!usage) return undefined;
  const usageCost = asRecord(usage.cost);
  const responseCost = asRecord(response?.cost);

  const inputTokens = firstNumber(usage, [
    "input_tokens",
    "prompt_tokens",
  ]) ?? 0;
  const cachedInputTokens = firstNumber(usage, [
    "cached_input_tokens",
    "input_cached_tokens",
    "cache_read_input_tokens",
  ]) ?? 0;
  const processingTokens = firstNumber(usage, [
    "reasoning_tokens",
    "reasoning_output_tokens",
    "processing_tokens",
  ]) ?? 0;
  const outputTokens = firstNumber(usage, [
    "output_tokens",
    "completion_tokens",
  ]) ?? 0;

  const totalTokens = firstNumber(usage, [
    "total_tokens",
  ]);
  const costUsd = firstNumber(usage, [
    "total_cost_usd",
    "cost_usd",
    "price_usd",
    "total_cost",
    "cost",
  ]) ??
    firstNumber(usageCost, [
      "usd",
      "total_usd",
      "value",
      "amount",
    ]) ??
    firstNumber(responseCost, [
      "usd",
      "total_usd",
      "value",
      "amount",
    ]);
  const model = firstString(json, ["model"]) ??
    firstString(response, ["model"]) ??
    firstString(usage, ["model"]);

  if (
    inputTokens === 0 && cachedInputTokens === 0 && processingTokens === 0 &&
    outputTokens === 0 &&
    totalTokens === undefined && costUsd === undefined && model === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    cachedInputTokens,
    processingTokens,
    outputTokens,
    totalTokens,
    costUsd,
    model,
  };
}

function flattenText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => flattenText(item)).filter(Boolean).join("\n");
  }
  const obj = asRecord(value);
  if (!obj) return "";

  const direct = [
    obj.text,
    obj.text_delta,
    obj.summary_text,
    obj.output_text,
    obj.stdout,
    obj.stderr,
  ]
    .map((item) => flattenText(item))
    .filter(Boolean)
    .join("\n");
  if (direct) return direct;

  return [obj.content, obj.delta, obj.command_output, obj.message, obj.summary]
    .map((item) => flattenText(item))
    .filter(Boolean)
    .join("\n");
}

export function extractRateLimitTimestamp(text: string): number | undefined {
  const match = text.match(/Codex AI usage limit reached[\|\s](\d+)/);
  if (!match) return undefined;
  const timestamp = Number.parseInt(match[1], 10);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export class CodexStreamProcessor {
  parseLine(line: string): ParsedCodexLine {
    const trimmed = line.trim();
    if (!trimmed) return { raw: line };

    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      const sessionId = this.extractSessionId(json);
      const text = this.extractProgressText(json);
      const finalText = this.extractFinalText(json);

      const rateFromText = extractRateLimitTimestamp(
        [text, finalText].filter(Boolean).join("\n"),
      );

      return {
        raw: line,
        json,
        text: text || undefined,
        finalText: finalText || undefined,
        sessionId,
        rateLimitTimestamp: rateFromText,
        usage: extractUsageFromJson(json),
      };
    } catch {
      // JSONでない行は生ログとして扱う
      return {
        raw: line,
        text: line,
        rateLimitTimestamp: extractRateLimitTimestamp(line),
      };
    }
  }

  private extractSessionId(json: Record<string, unknown>): string | undefined {
    const direct = json.session_id;
    if (typeof direct === "string" && direct) return direct;

    const threadId = json.thread_id;
    if (typeof threadId === "string" && threadId) return threadId;

    const session = asRecord(json.session);
    if (session && typeof session.id === "string" && session.id) {
      return session.id;
    }
    return undefined;
  }

  private extractProgressText(json: Record<string, unknown>): string {
    const eventType = typeof json.type === "string" ? json.type : "";
    if (eventType === "turn.completed" || eventType === "response.completed") {
      return "";
    }
    return flattenText(json.item) || flattenText(json.delta) ||
      flattenText(json.command_output);
  }

  private extractFinalText(json: Record<string, unknown>): string {
    const eventType = typeof json.type === "string" ? json.type : "";
    if (eventType === "result") {
      return flattenText(json.result);
    }
    if (eventType === "turn.completed" || eventType === "response.completed") {
      return flattenText(json.response) || flattenText(json.result) ||
        flattenText(json.item);
    }

    if (eventType === "item.completed") {
      const item = asRecord(json.item);
      if (!item) return "";

      if (item.type === "agent_message") {
        return flattenText(item);
      }

      if (item.type === "message" && item.role === "assistant") {
        return flattenText(item.content) || flattenText(item);
      }
    }

    if (eventType === "assistant") {
      const message = asRecord(json.message);
      if (
        message?.role === "assistant" &&
        typeof message.stop_reason === "string" &&
        message.stop_reason === "end_turn"
      ) {
        return flattenText(message.content);
      }
    }

    return "";
  }
}
