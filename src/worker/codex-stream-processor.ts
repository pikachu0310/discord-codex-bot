import { MessageFormatter } from "./message-formatter.ts";
import Anthropic from "npm:@anthropic-ai/sdk";

/**
 * JSON解析エラー
 */
export class JsonParseError extends Error {
  public readonly line: string;
  public override readonly cause: unknown;

  constructor(line: string, cause: unknown) {
    super(`Failed to parse JSON: ${cause}`);
    this.name = "JsonParseError";
    this.line = line;
    this.cause = cause;
  }
}

/**
 * スキーマ検証エラー
 */
export class SchemaValidationError extends Error {
  constructor(public readonly data: unknown, message: string) {
    super(`Schema validation failed: ${message}`);
    this.name = "SchemaValidationError";
  }
}

// Codex Code SDK message schema based on https://docs.anthropic.com/en/docs/codex-code/sdk#message-schema
export type CodexStreamMessage =
  // アシスタントメッセージ
  | {
    type: "assistant";
    message: Anthropic.Message & {
      usage?: {
        input_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens: number;
        service_tier?: string;
      };
    }; // Anthropic SDKから
    session_id: string;
  }
  // ユーザーメッセージ
  | {
    type: "user";
    message: Anthropic.MessageParam; // Anthropic SDKから
    session_id: string;
  }
  // 最後のメッセージとして出力される
  | {
    type: "result";
    subtype: "success";
    duration_ms: number;
    duration_api_ms: number;
    is_error: boolean;
    num_turns: number;
    result: string;
    session_id: string;
    total_cost_usd: number;
    usage?: {
      input_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens: number;
      server_tool_use?: {
        web_search_requests: number;
      };
      service_tier?: string;
    };
  }
  // 最大ターン数に達した場合、最後のメッセージとして出力される
  | {
    type: "result";
    subtype: "error_max_turns" | "error_during_execution";
    duration_ms: number;
    duration_api_ms: number;
    is_error: boolean;
    num_turns: number;
    session_id: string;
    total_cost_usd: number;
    usage?: {
      input_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens: number;
      server_tool_use?: {
        web_search_requests: number;
      };
      service_tier?: string;
    };
  }
  // 会話の開始時に最初のメッセージとして出力される
  | {
    type: "system";
    subtype: "init";
    apiKeySource: string;
    cwd: string;
    session_id: string;
    tools: string[];
    mcp_servers: {
      name: string;
      status: string;
    }[];
    model: string;
    permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  };

export type CodexExecItemContent =
  | string
  | {
    type?: string;
    text?: string;
    text_delta?: string;
    data?: string;
  };

export interface CodexExecItem {
  id?: string;
  type?: string;
  text?: string;
  delta?: string | { text?: string; text_delta?: string };
  content?: CodexExecItemContent[];
  output_text?: string | CodexExecItemContent[];
  message?: string;
  session_id?: string;
  is_error?: boolean;
}

export interface CodexExecJsonEvent {
  type: string;
  item?: CodexExecItem;
  session_id?: string;
  session?: { id?: string };
  result?: string;
  response?: {
    output_text?: string | CodexExecItemContent[];
  };
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
    server_tool_use?: {
      web_search_requests?: number;
    };
    service_tier?: string;
  };
  error?: { message?: string };
  [key: string]: unknown;
}

export function isLegacyCodexStreamMessage(
  value: unknown,
): value is CodexStreamMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") {
    return false;
  }

  return ["assistant", "user", "result", "system"].includes(type);
}

export function isCodexExecJsonEvent(
  value: unknown,
): value is CodexExecJsonEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") {
    return false;
  }

  return type.startsWith("item.") ||
    type.startsWith("turn.") ||
    type.startsWith("response.") ||
    type.startsWith("session.") ||
    type.startsWith("error");
}

export class CodexCodeRateLimitError extends Error {
  public readonly timestamp: number;
  public readonly retryAt: number;

  constructor(timestamp: number) {
    super(`Codex AI usage limit reached|${timestamp}`);
    this.name = "CodexCodeRateLimitError";
    this.timestamp = timestamp;
    this.retryAt = timestamp;
  }
}

/**
 * Codex CLIのストリーミング出力を処理するクラス
 */
export class CodexStreamProcessor {
  private readonly formatter: MessageFormatter;

  constructor(formatter: MessageFormatter) {
    this.formatter = formatter;
  }

  /**
   * JSONライン文字列を安全に解析して型検証を行う
   * @param line JSON文字列の行
   * @returns パースされ、検証されたCodexStreamMessage
   * @throws {JsonParseError} JSON解析に失敗した場合
   * @throws {SchemaValidationError} スキーマ検証に失敗した場合
   */
  parseJsonLine(line: string): CodexStreamMessage | CodexExecJsonEvent {
    // JSON解析
    try {
      return JSON.parse(line) as CodexStreamMessage | CodexExecJsonEvent;
    } catch (error) {
      throw new JsonParseError(line, error);
    }
  }

  /**
   * プロセスストリームを処理する
   */
  async processStreams(
    stdout: ReadableStream<Uint8Array>,
    stderr: ReadableStream<Uint8Array>,
    onData: (data: Uint8Array) => void,
  ): Promise<Uint8Array> {
    const stdoutReader = stdout.getReader();
    const stderrReader = stderr.getReader();
    let stderrOutput = new Uint8Array();

    // stdoutの読み取りPromise
    const stdoutPromise = (async () => {
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          if (value) {
            onData(value);
          }
        }
      } catch (error) {
        if (error instanceof CodexCodeRateLimitError) {
          throw error; // レートリミットエラーはそのまま投げる
        }

        console.error("stdout読み取りエラー:", error);
      } finally {
        stdoutReader.releaseLock();
      }
    })();

    // stderrの読み取りPromise
    const stderrPromise = (async () => {
      try {
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
          }
        }
        // stderrの内容を結合
        const totalLength = chunks.reduce(
          (sum, chunk) => sum + chunk.length,
          0,
        );
        stderrOutput = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          stderrOutput.set(chunk, offset);
          offset += chunk.length;
        }
      } catch (error) {
        console.error("stderr読み取りエラー:", error);
      } finally {
        stderrReader.releaseLock();
      }
    })();

    await Promise.all([stdoutPromise, stderrPromise]);
    return stderrOutput;
  }

  /**
   * JSONL行からCodex Codeの実際の出力メッセージを抽出する
   */
  extractOutputMessage(
    parsed: CodexStreamMessage | CodexExecJsonEvent,
  ): string | null {
    if (isLegacyCodexStreamMessage(parsed)) {
      switch (parsed.type) {
        case "assistant":
          return this.extractAssistantMessage(parsed.message.content);
        case "user":
          return this.extractUserMessage(parsed.message.content);
        case "system":
          return this.extractSystemMessage(parsed);
        case "result":
          return null;
      }
      return null;
    }

    if (isCodexExecJsonEvent(parsed)) {
      if (parsed.type.startsWith("item.")) {
        const text = this.extractExecItemText(parsed.item);
        if (!text) {
          return null;
        }

        const itemType = parsed.item?.type;
        switch (itemType) {
          case "reasoning":
            return `🤔 ${text}`;
          case "tool_result":
          case "tool_response":
          case "command_result":
            return `${parsed.item?.is_error ? "❌" : "✅"} **ツール実行結果:**\n${
              this.formatter.formatToolResult(
                text,
                parsed.item?.is_error ?? false,
              )
            }`;
          default:
            return text;
        }
      }

      if (parsed.type === "response.error" && parsed.error?.message) {
        return `❌ Codexエラー: ${parsed.error.message}`;
      }

      if (parsed.type === "turn.completed" ||
        parsed.type === "response.completed") {
        return this.extractExecResponseText(parsed);
      }
    }

    return null;
  }

  extractSessionId(
    parsed: CodexStreamMessage | CodexExecJsonEvent,
  ): string | null {
    if (isLegacyCodexStreamMessage(parsed)) {
      return parsed.session_id ?? null;
    }

    if (!isCodexExecJsonEvent(parsed)) {
      return null;
    }

    if (typeof parsed.session_id === "string" && parsed.session_id) {
      return parsed.session_id;
    }

    if (parsed.session && typeof parsed.session === "object") {
      const sessionId = (parsed.session as { id?: unknown }).id;
      if (typeof sessionId === "string" && sessionId) {
        return sessionId;
      }
    }

    if (parsed.item && typeof parsed.item.session_id === "string") {
      return parsed.item.session_id;
    }

    return null;
  }

  extractUsageCounts(
    parsed: CodexStreamMessage | CodexExecJsonEvent,
  ): { inputTokens: number; outputTokens: number } | null {
    const usage = isLegacyCodexStreamMessage(parsed) ? parsed.usage :
      (isCodexExecJsonEvent(parsed) ? parsed.usage : undefined);

    if (!usage) {
      return null;
    }

    const inputTokens = (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0);
    const outputTokens = usage.output_tokens || 0;

    if (inputTokens === 0 && outputTokens === 0) {
      return null;
    }

    return { inputTokens, outputTokens };
  }

  extractExecResponseText(parsed: CodexExecJsonEvent): string | null {
    if (parsed.result && typeof parsed.result === "string") {
      return parsed.result;
    }

    if (parsed.response?.output_text) {
      const outputText = parsed.response.output_text;
      if (typeof outputText === "string") {
        return outputText;
      }
      if (Array.isArray(outputText)) {
        const joined = outputText.map((item) => {
          if (typeof item === "string") {
            return item;
          }
          if (item && typeof item === "object") {
            const text = (item as { text?: unknown }).text;
            if (typeof text === "string") {
              return text;
            }
            const textDelta = (item as { text_delta?: unknown }).text_delta;
            if (typeof textDelta === "string") {
              return textDelta;
            }
          }
          return "";
        }).join("");
        return joined || null;
      }
    }

    return null;
  }

  /**
   * assistantメッセージのcontentを処理する
   */
  private extractAssistantMessage(
    content: Anthropic.Message["content"],
  ): string | null {
    let textContent = "";

    for (const item of content) {
      switch (item.type) {
        case "text":
          textContent += item.text || "";
          break;
        case "tool_use":
          textContent += this.formatter.formatToolUse(item);
          break;
        case "web_search_tool_result":
          if (Array.isArray(item.content)) {
            textContent += `🔍 **検索結果:** ${item.content.length}件\n`;
          } else {
            textContent +=
              `🔍 **Web検索に失敗しました:** ${item.content.error_code}\n`;
          }
          break;
        case "thinking":
          textContent += `🤔 **思考中...**: ${item.thinking}\n`;
          break;
        case "redacted_thinking":
          textContent += `🤔 **思考中...**: ${item.data}\n`;
          break;
        case "server_tool_use":
          textContent += `**server tool use**: ${JSON.stringify(item.input)}`;
          break;
        default:
          throw new Error(item satisfies never);
      }
    }
    return textContent || null;
  }

  /**
   * userメッセージのcontentを処理する（tool_result等）
   */
  private extractUserMessage(
    content: Anthropic.MessageParam["content"],
  ): string | null {
    if (typeof content === "string") {
      // contentが文字列の場合はそのまま返す
      return content;
    }

    for (const item of content) {
      if (item.type === "tool_result") {
        let resultContent = "";

        // contentが配列の場合（タスクエージェントなど）
        if (Array.isArray(item.content)) {
          for (const contentItem of item.content) {
            if (contentItem.type === "text" && contentItem.text) {
              resultContent += contentItem.text;
            }
          }
        } else {
          // contentが文字列の場合（通常のツール結果）
          resultContent = item.content || "";
        }

        // TodoWrite成功の定型文はスキップ
        if (
          !item.is_error &&
          this.formatter.isTodoWriteSuccessMessage(resultContent)
        ) {
          return null;
        }

        // ツール結果を進捗として投稿
        const resultIcon = item.is_error ? "❌" : "✅";

        // 長さに応じて処理を分岐
        const formattedContent = this.formatter.formatToolResult(
          resultContent,
          item.is_error || false,
        );

        return `${resultIcon} **ツール実行結果:**\n${formattedContent}`;
      } else if (item.type === "text" && item.text) {
        return item.text;
      }
    }
    return null;
  }

  /**
   * systemメッセージの処理
   */
  private extractSystemMessage(
    parsed: CodexStreamMessage,
  ): string | null {
    if (parsed.type === "system" && parsed.subtype === "init") {
      const tools = parsed.tools?.join(", ") || "なし";
      const mcpServers = parsed.mcp_servers?.map((s) =>
        `${s.name}(${s.status})`
      ).join(", ") || "なし";
      return `🔧 **システム初期化:** ツール: ${tools}, MCPサーバー: ${mcpServers}`;
    }
    return null;
  }

  private extractExecItemText(item?: CodexExecItem): string | null {
    if (!item) {
      return null;
    }

    const parts: string[] = [];

    if (typeof item.text === "string") {
      parts.push(item.text);
    }

    if (typeof item.delta === "string") {
      parts.push(item.delta);
    } else if (item.delta && typeof item.delta === "object") {
      const deltaText = (item.delta as { text?: unknown }).text;
      if (typeof deltaText === "string") {
        parts.push(deltaText);
      }
      const deltaTextDelta = (item.delta as { text_delta?: unknown }).text_delta;
      if (typeof deltaTextDelta === "string") {
        parts.push(deltaTextDelta);
      }
    }

    if (typeof item.message === "string") {
      parts.push(item.message);
    }

    if (item.output_text) {
      const output = item.output_text;
      if (typeof output === "string") {
        parts.push(output);
      } else if (Array.isArray(output)) {
        for (const entry of output) {
          if (typeof entry === "string") {
            parts.push(entry);
          } else if (entry && typeof entry === "object") {
            const text = (entry as { text?: unknown }).text;
            if (typeof text === "string") {
              parts.push(text);
            }
            const textDelta = (entry as { text_delta?: unknown }).text_delta;
            if (typeof textDelta === "string") {
              parts.push(textDelta);
            }
            const data = (entry as { data?: unknown }).data;
            if (typeof data === "string") {
              parts.push(data);
            }
          }
        }
      }
    }

    if (Array.isArray(item.content)) {
      for (const content of item.content) {
        if (typeof content === "string") {
          parts.push(content);
          continue;
        }

        if (content && typeof content === "object") {
          const text = (content as { text?: unknown }).text;
          if (typeof text === "string") {
            parts.push(text);
          }
          const textDelta = (content as { text_delta?: unknown }).text_delta;
          if (typeof textDelta === "string") {
            parts.push(textDelta);
          }
          const data = (content as { data?: unknown }).data;
          if (typeof data === "string") {
            parts.push(data);
          }
        }
      }
    }

    if (parts.length === 0) {
      return null;
    }

    return parts.join("");
  }

  /**
   * Codex Codeのレートリミットメッセージかを判定する
   */
  isCodexCodeRateLimit(result: string): boolean {
    // より包括的な検知を行う
    return result.includes("Codex AI usage limit reached");
  }

  /**
   * レートリミットメッセージからタイムスタンプを抽出する
   */
  extractRateLimitTimestamp(result: string): number | null {
    // より柔軟な正規表現で検知（パイプまたはスペース区切り）
    const match = result.match(/Codex AI usage limit reached[\|\s](\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
    return null;
  }
}
