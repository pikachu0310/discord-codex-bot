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
  delta?: unknown;
  command_output?: {
    stdout?: string;
    stdout_delta?: string;
    stderr?: string;
    stderr_delta?: string;
    output_text?: string | CodexExecItemContent[];
  };
  content?: unknown;
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
    type.startsWith("thread.") ||
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
      const text = this.extractExecEventText(parsed);
      if (text) {
        const itemType = this.getExecItemType(parsed);
        if (itemType === "reasoning") {
          return `🤔 ${text}`;
        }

        if (this.isToolResultLike(itemType)) {
          return `${parsed.item?.is_error ? "❌" : "✅"} **ツール実行結果:**\n${
            this.formatter.formatToolResult(
              text,
              parsed.item?.is_error ?? false,
            )
          }`;
        }

        if (parsed.type.startsWith("item.")) {
          return text;
        }
      }

      if (parsed.type === "response.error" && parsed.error?.message) {
        return `❌ Codexエラー: ${parsed.error.message}`;
      }

      if (
        parsed.type === "turn.completed" ||
        parsed.type === "response.completed"
      ) {
        return this.extractExecResponseText(parsed);
      }
    }

    return null;
  }

  private extractExecEventText(
    parsed: CodexExecJsonEvent,
  ): string | null {
    const segments: string[] = [];

    if (!this.isCommandOutputEvent(parsed)) {
      const itemText = this.extractExecItemText(parsed.item);
      if (itemText) {
        segments.push(itemText);
      }
    }

    const commandOutputText = this.extractCommandOutputText(parsed);
    if (commandOutputText) {
      segments.push(commandOutputText);
    }

    const commandMetadata = commandOutputText
      ? null
      : this.extractCommandMetadata(parsed);
    if (commandMetadata) {
      segments.push(commandMetadata);
    }

    const deltaText = commandOutputText
      ? null
      : this.extractTextFromUnknown(parsed.delta);
    if (deltaText) {
      segments.push(deltaText);
    }

    const contentText = this.extractTextFromUnknown(parsed.content);
    if (contentText) {
      segments.push(contentText);
    }

    const messageText = this.extractTextFromUnknown(
      (parsed as { message?: unknown }).message,
    );
    if (messageText) {
      segments.push(messageText);
    }

    if (segments.length === 0) {
      return null;
    }

    return segments.join("");
  }

  private extractCommandOutputText(
    parsed: CodexExecJsonEvent,
  ): string | null {
    const candidates = [
      parsed.command_output,
      (parsed.item as { command_output?: unknown })?.command_output,
    ];

    for (const candidate of candidates) {
      const text = this.extractTextFromUnknown(candidate);
      if (text) {
        return text;
      }
    }

    return null;
  }

  private extractCommandMetadata(
    parsed: CodexExecJsonEvent,
  ): string | null {
    const commandString = this.extractCommandString(parsed);
    if (!commandString) {
      return null;
    }

    const shell = this.extractShellName(parsed);
    const language = shell === "fish" ? "fish" : "bash";
    const label = shell ? ` (${shell})` : "";
    return `💻 **Command${label}:**\n\`\`\`${language}\n${commandString}\n\`\`\``;
  }

  private extractCommandString(parsed: CodexExecJsonEvent): string | null {
    const candidates = [
      (parsed.delta as { command?: unknown })?.command,
      (parsed.delta as { command_line?: unknown })?.command_line,
      (parsed.delta as { commandLine?: unknown })?.commandLine,
      (parsed.delta as { command_args?: unknown })?.command_args,
      parsed.command_output,
      (parsed.item as { command?: unknown })?.command,
      (parsed.item as { command_line?: unknown })?.command_line,
      (parsed.item as { commandLine?: unknown })?.commandLine,
      (parsed.item as { command_args?: unknown })?.command_args,
      (parsed as { command?: unknown }).command,
      (parsed as { command_line?: unknown }).command_line,
      (parsed as { commandLine?: unknown }).commandLine,
    ];

    for (const candidate of candidates) {
      const formatted = this.normalizeCommandCandidate(candidate);
      if (formatted) {
        return formatted;
      }
    }

    return null;
  }

  private extractShellName(parsed: CodexExecJsonEvent): string | null {
    const candidates = [
      (parsed.delta as { shell?: unknown })?.shell,
      (parsed.delta as { command_output?: { shell?: unknown } })
        ?.command_output?.shell,
      (parsed.command_output as { shell?: unknown })?.shell,
      (parsed.item as { shell?: unknown })?.shell,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }

    return null;
  }

  private normalizeCommandCandidate(value: unknown): string | null {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    if (Array.isArray(value)) {
      const tokens = value
        .map((token) => this.normalizeCommandCandidate(token))
        .filter((token): token is string => !!token);
      if (tokens.length === 0) {
        return null;
      }
      return tokens.join(" ");
    }

    if (value && typeof value === "object") {
      const maybeValue = (value as { command?: unknown }).command;
      if (maybeValue) {
        return this.normalizeCommandCandidate(maybeValue);
      }
      const maybeLine = (value as { command_line?: unknown }).command_line;
      if (maybeLine) {
        return this.normalizeCommandCandidate(maybeLine);
      }
    }

    return null;
  }

  private extractTextFromUnknown(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    const parts: string[] = [];
    const seen = new WeakSet<object>();

    const visit = (node: unknown, depth: number) => {
      if (node === null || node === undefined || depth > 5) {
        return;
      }

      if (typeof node === "string") {
        if (node.length > 0) {
          parts.push(node);
        }
        return;
      }

      if (typeof node === "number") {
        parts.push(String(node));
        return;
      }

      if (Array.isArray(node)) {
        for (const entry of node) {
          visit(entry, depth + 1);
        }
        return;
      }

      if (typeof node !== "object") {
        return;
      }

      const objectNode = node as Record<string, unknown>;
      if (seen.has(objectNode)) {
        return;
      }
      seen.add(objectNode);

      const keysToTraverse = [
        "text",
        "text_delta",
        "data",
        "stdout",
        "stdout_delta",
        "stderr",
        "stderr_delta",
        "message",
      ];

      for (const key of keysToTraverse) {
        if (key in objectNode) {
          visit(objectNode[key], depth + 1);
        }
      }

      if ("output_text" in objectNode) {
        visit(objectNode.output_text, depth + 1);
      }

      if ("content" in objectNode) {
        visit(objectNode.content, depth + 1);
      }

      if ("delta" in objectNode) {
        visit(objectNode.delta, depth + 1);
      }
    };

    visit(value, 0);
    if (parts.length === 0) {
      return null;
    }

    return parts.join("");
  }

  private getExecItemType(parsed: CodexExecJsonEvent): string | null {
    if (parsed.item?.type) {
      return parsed.item.type;
    }

    if (parsed.type.startsWith("item.")) {
      const [, remainder] = parsed.type.split("item.");
      if (remainder) {
        const [typeCandidate] = remainder.split(".");
        if (typeCandidate) {
          return typeCandidate;
        }
      }
    }

    return null;
  }

  private isCommandOutputEvent(parsed: CodexExecJsonEvent): boolean {
    if (
      parsed.item?.type &&
      parsed.item.type.toLowerCase().includes("command_")
    ) {
      return true;
    }
    if (parsed.type.toLowerCase().includes("command_")) {
      return true;
    }
    return false;
  }

  private isToolResultLike(type: string | null | undefined): boolean {
    if (!type) {
      return false;
    }

    const normalized = type.toLowerCase();
    return [
      "tool_result",
      "tool_response",
      "command_result",
      "command_output",
    ].includes(normalized);
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

    const threadId = this.normalizeSessionId(
      (parsed as { thread_id?: unknown }).thread_id,
    );
    if (threadId) {
      return threadId;
    }

    return this.findSessionIdRecursively(parsed);
  }

  extractSessionIdFromText(text: string | null | undefined): string | null {
    if (!text) {
      return null;
    }

    const searchTargets = Array.isArray(text) ? text : [text];
    for (const target of searchTargets) {
      if (typeof target !== "string") {
        continue;
      }

      const patterns = [
        /\bcodex(?:\s+exec)?\s+resume\s+([0-9a-zA-Z][0-9a-zA-Z\-]{8,})\b/g,
        /\bsession(?:[_\s-]*id)?\s*[:=]\s*([0-9a-zA-Z][0-9a-zA-Z\-]{8,})\b/g,
        /\bthread(?:[_\s-]*id)?\s*[:=]\s*([0-9a-zA-Z][0-9a-zA-Z\-]{8,})\b/g,
      ];

      for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(target)) !== null) {
          const candidate = this.normalizeSessionId(match[1]);
          if (candidate) {
            return candidate;
          }
        }
      }
    }

    return null;
  }

  extractUsageCounts(
    parsed: CodexStreamMessage | CodexExecJsonEvent,
  ): { inputTokens: number; outputTokens: number } | null {
    const usage = isLegacyCodexStreamMessage(parsed)
      ? (parsed as {
        usage?: {
          input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          output_tokens?: number;
        };
      }).usage
      : (isCodexExecJsonEvent(parsed) ? parsed.usage : undefined);

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
      const deltaTextDelta =
        (item.delta as { text_delta?: unknown }).text_delta;
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

  private normalizeSessionId(value: unknown): string | null {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      if (/[\s/\\]/.test(trimmed)) {
        return null;
      }
      return trimmed;
    }

    if (typeof value === "number") {
      return Number.isFinite(value) ? String(value) : null;
    }

    return null;
  }

  private findSessionIdRecursively(
    value: unknown,
    parentKey?: string,
    grandparentKey?: string,
  ): string | null {
    const normalizedParent = parentKey?.toLowerCase();
    const normalizedGrandparent = grandparentKey?.toLowerCase();

    if (
      typeof value === "string" ||
      typeof value === "number"
    ) {
      if (
        normalizedParent === "session" ||
        normalizedParent === "session_id" ||
        normalizedParent === "sessionid" ||
        normalizedParent === "thread_id" ||
        normalizedParent === "threadid"
      ) {
        return this.normalizeSessionId(value);
      }

      if (
        normalizedParent === "id" &&
        normalizedGrandparent &&
        (normalizedGrandparent.includes("session") ||
          normalizedGrandparent.includes("thread"))
      ) {
        return this.normalizeSessionId(value);
      }

      return null;
    }

    if (Array.isArray(value)) {
      for (const element of value) {
        const candidate = this.findSessionIdRecursively(
          element,
          parentKey,
          grandparentKey,
        );
        if (candidate) {
          return candidate;
        }
      }
      return null;
    }

    if (!value || typeof value !== "object") {
      return null;
    }

    for (
      const [key, child] of Object.entries(
        value as Record<string, unknown>,
      )
    ) {
      const normalizedKey = key.toLowerCase();

      if (
        normalizedKey === "session" ||
        normalizedKey === "session_id" ||
        normalizedKey === "sessionid" ||
        normalizedKey === "thread" ||
        normalizedKey === "thread_id" ||
        normalizedKey === "threadid"
      ) {
        const candidate = this.findSessionIdRecursively(
          child,
          key,
          parentKey,
        );
        if (candidate) {
          return candidate;
        }
        continue;
      }

      if (
        normalizedKey === "id" &&
        normalizedParent &&
        (normalizedParent.includes("session") ||
          normalizedParent.includes("thread"))
      ) {
        const candidate = this.findSessionIdRecursively(
          child,
          key,
          parentKey,
        );
        if (candidate) {
          return candidate;
        }
        continue;
      }

      const candidate = this.findSessionIdRecursively(
        child,
        key,
        parentKey,
      );
      if (candidate) {
        return candidate;
      }
    }

    return null;
  }
}
