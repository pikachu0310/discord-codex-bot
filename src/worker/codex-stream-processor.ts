export interface ParsedCodexLine {
  raw: string;
  json?: Record<string, unknown>;
  text?: string;
  finalText?: string;
  sessionId?: string;
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
