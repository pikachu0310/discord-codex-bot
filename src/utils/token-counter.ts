/**
 * Token counting utility for Codex context management
 */

/**
 * Estimates token count from text using a simple heuristic
 * Based on the general rule that 1 token ≈ 4 characters for English text
 * This is an approximation and may not be 100% accurate
 */
export function estimateTokenCount(text: string): number {
  // Remove extra whitespace and normalize
  const normalizedText = text.trim().replace(/\s+/g, " ");

  // Use 4 characters per token as a rough estimate
  // This is based on OpenAI's tokenization patterns and Codex likely uses similar
  return Math.ceil(normalizedText.length / 4);
}

/**
 * Estimates token count from multiple text pieces
 */
export function estimateTokenCountFromArray(texts: string[]): number {
  return texts.reduce((total, text) => total + estimateTokenCount(text), 0);
}

/**
 * Estimates token count from a Codex session JSONL content
 */
export function estimateTokenCountFromSession(sessionContent: string): number {
  const lines = sessionContent.split("\n").filter((line) => line.trim());
  let totalTokens = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "message" && parsed.content) {
        // Count tokens from message content
        if (typeof parsed.content === "string") {
          totalTokens += estimateTokenCount(parsed.content);
        } else if (Array.isArray(parsed.content)) {
          // Handle content array format
          for (const item of parsed.content) {
            if (item.type === "text" && item.text) {
              totalTokens += estimateTokenCount(item.text);
            }
          }
        }
      }
    } catch {
      // Skip invalid JSON lines
      continue;
    }
  }

  return totalTokens;
}
