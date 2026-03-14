/**
 * Context compression service for managing Codex conversation history
 */

import { CONTEXT_COMPRESSION } from "../constants.ts";
import { estimateTokenCountFromSession } from "../utils/token-counter.ts";

export interface SessionMessage {
  type?: string;
  role?: string;
  content?:
    | string
    | Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  timestamp?: number;
}

interface MessageWithLine {
  line: string;
  parsed: SessionMessage | null;
  timestamp?: number;
}

interface CompressionResult {
  compressedContent: string;
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  wasCompressed: boolean;
}

export class ContextCompressor {
  /**
   * Checks if the session content exceeds the compression threshold
   */
  shouldCompress(sessionContent: string): boolean {
    const tokenCount = estimateTokenCountFromSession(sessionContent);
    return tokenCount > CONTEXT_COMPRESSION.AUTO_COMPRESS_THRESHOLD;
  }

  /**
   * Compresses the session content by keeping recent messages and summarizing older ones
   */
  async compressSession(sessionContent: string): Promise<CompressionResult> {
    const originalTokens = estimateTokenCountFromSession(sessionContent);

    if (originalTokens <= CONTEXT_COMPRESSION.AUTO_COMPRESS_THRESHOLD) {
      return {
        compressedContent: sessionContent,
        originalTokens,
        compressedTokens: originalTokens,
        compressionRatio: 1.0,
        wasCompressed: false,
      };
    }

    const lines = sessionContent.split("\n").filter((line) => line.trim());
    const messages: MessageWithLine[] = [];

    // Parse all messages
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        messages.push({
          line,
          parsed,
          timestamp: parsed.timestamp || Date.now(),
        });
      } catch {
        // Keep invalid JSON lines as-is
        messages.push({ line, parsed: null });
      }
    }

    // Sort by timestamp to ensure chronological order
    messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // Keep recent messages (last N messages)
    const recentMessages = messages.slice(
      -CONTEXT_COMPRESSION.KEEP_RECENT_MESSAGES,
    );
    const olderMessages = messages.slice(
      0,
      -CONTEXT_COMPRESSION.KEEP_RECENT_MESSAGES,
    );

    // Create summary of older messages
    const summaryMessage = this.createSummaryMessage(olderMessages);

    // Combine summary with recent messages
    const compressedMessages = [summaryMessage, ...recentMessages];
    const compressedContent = compressedMessages.map((msg) => msg.line).join(
      "\n",
    );

    const compressedTokens = estimateTokenCountFromSession(compressedContent);

    return {
      compressedContent,
      originalTokens,
      compressedTokens,
      compressionRatio: compressedTokens / originalTokens,
      wasCompressed: true,
    };
  }

  /**
   * Creates a summary message from older conversation history
   */
  private createSummaryMessage(
    olderMessages: MessageWithLine[],
  ): MessageWithLine {
    // Extract key information from older messages
    const userMessages: string[] = [];
    const assistantMessages: string[] = [];
    const toolUses: string[] = [];

    for (const msg of olderMessages) {
      if (!msg.parsed) continue;

      if (msg.parsed.type === "message" && msg.parsed.role === "user") {
        if (typeof msg.parsed.content === "string") {
          userMessages.push(msg.parsed.content);
        } else if (Array.isArray(msg.parsed.content)) {
          for (const item of msg.parsed.content) {
            if (item.type === "text" && item.text) {
              userMessages.push(item.text);
            }
          }
        }
      } else if (
        msg.parsed.type === "message" && msg.parsed.role === "assistant"
      ) {
        if (typeof msg.parsed.content === "string") {
          assistantMessages.push(msg.parsed.content);
        } else if (Array.isArray(msg.parsed.content)) {
          for (const item of msg.parsed.content) {
            if (item.type === "text" && item.text) {
              assistantMessages.push(item.text);
            } else if (item.type === "tool_use" && item.name) {
              toolUses.push(`${item.name}: ${item.input || ""}`);
            }
          }
        }
      }
    }

    // Create a concise summary
    const summaryParts: string[] = [];

    if (userMessages.length > 0) {
      summaryParts.push(
        `ユーザーの主な要求: ${userMessages.slice(0, 3).join("; ")}`,
      );
    }

    if (assistantMessages.length > 0) {
      summaryParts.push(
        `アシスタントの主な応答: ${assistantMessages.slice(0, 3).join("; ")}`,
      );
    }

    if (toolUses.length > 0) {
      summaryParts.push(`使用したツール: ${toolUses.slice(0, 5).join(", ")}`);
    }

    const summaryText =
      `[コンテキスト圧縮] 過去の${olderMessages.length}件のメッセージを要約:\n${
        summaryParts.join("\n")
      }`;

    // Create a summary message in the same format as other messages
    const summaryMessage = {
      type: "message",
      role: "assistant",
      content: summaryText,
      timestamp: Date.now(),
    };

    return {
      line: JSON.stringify(summaryMessage),
      parsed: summaryMessage,
    };
  }
}
