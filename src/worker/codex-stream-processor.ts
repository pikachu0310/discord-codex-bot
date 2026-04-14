export interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
  dedupeKey?: string;
}

export interface ParsedCodexLine {
  raw: string;
  json?: Record<string, unknown>;
  text?: string;
  finalText?: string;
  sessionId?: string;
  usage?: ParsedUsage;
  rateLimitTimestamp?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
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
    obj.output_text,
    obj.stdout,
    obj.stderr,
  ]
    .map((item) => flattenText(item))
    .filter(Boolean)
    .join("\n");
  if (direct) return direct;

  return [obj.content, obj.delta, obj.command_output, obj.message]
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
      const eventType = typeof json.type === "string" ? json.type : "";
      const sessionId = this.extractSessionId(json);
      const text = this.extractProgressText(json);
      const finalText = this.extractFinalText(json);
      const usage = this.extractUsage(json);

      const rateFromText = extractRateLimitTimestamp(
        [text, finalText].filter(Boolean).join("\n"),
      );

      return {
        raw: line,
        json,
        text: text || undefined,
        finalText: finalText || undefined,
        sessionId,
        usage: usage
          ? {
            ...usage,
            dedupeKey: usage.dedupeKey ??
              (sessionId ? `${sessionId}:${eventType}` : undefined),
          }
          : undefined,
        rateLimitTimestamp: rateFromText,
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
    if (eventType === "turn.completed" || eventType === "response.completed") {
      return flattenText(json.response) || flattenText(json.result) ||
        flattenText(json.item);
    }
    return "";
  }

  private extractUsage(json: Record<string, unknown>): ParsedUsage | undefined {
    const usageObj = asRecord(json.usage);
    if (!usageObj) return undefined;

    const inputTokens = Number(usageObj.input_tokens ?? 0) +
      Number(usageObj.cache_creation_input_tokens ?? 0) +
      Number(usageObj.cache_read_input_tokens ?? 0);
    const outputTokens = Number(usageObj.output_tokens ?? 0);

    if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
      return undefined;
    }

    return {
      inputTokens,
      outputTokens,
    };
  }
}
