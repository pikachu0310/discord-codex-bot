export class MessageFormatter {
  formatResponse(response: string): string {
    return this.stripAnsiCodes(response);
  }

  formatToolResult(content: string): string {
    if (!content.trim()) {
      return "```\n(空の結果)\n```";
    }
    return `\`\`\`\n${this.stripAnsiCodes(content)}\n\`\`\``;
  }

  private stripAnsiCodes(text: string): string {
    // deno-lint-ignore no-control-regex
    return text.replace(/\x1b\[[0-9;]*[mGKHF]/g, "");
  }
}
