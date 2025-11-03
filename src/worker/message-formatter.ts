import type { Anthropic } from "npm:@anthropic-ai/sdk";
import { validateTodoWriteInput } from "../schemas/external-api-schema.ts";

/**
 * メッセージフォーマット関連の責務を担当するクラス
 */
export class MessageFormatter {
  private readonly worktreePath?: string;

  constructor(worktreePath?: string) {
    this.worktreePath = worktreePath;
  }

  /**
   * Discordの文字数制限を考慮してレスポンスをフォーマット
   */
  formatResponse(response: string): string {
    return this.stripAnsiCodes(response);
  }

  /**
   * ANSIエスケープシーケンスを除去
   */
  private stripAnsiCodes(text: string): string {
    // ANSIエスケープシーケンスを除去する正規表現
    // \x1b (ESC) は制御文字ですが、ANSIエスケープシーケンスの開始を示すため必要です
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSIエスケープシーケンスの処理に必要
    // deno-lint-ignore no-control-regex
    return text.replace(/\x1b\[[0-9;]*[mGKHF]/g, "");
  }

  /**
   * ツール使用を進捗メッセージとしてフォーマット
   */
  formatToolUse(item: Anthropic.Messages.ToolUseBlock): string | null {
    // TodoWriteツールの場合は特別処理
    if (item.name === "TodoWrite") {
      const todoWriteInput = item.input as {
        todos?: Array<{
          status: string;
          content: string;
        }>;
      };
      if (todoWriteInput?.todos && Array.isArray(todoWriteInput.todos)) {
        return this.formatTodoList(todoWriteInput.todos);
      }
      return null;
    }

    // その他のツール（Bash、Read、Write等）の場合
    const toolIcon = this.getToolIcon(item.name);
    const description = this.getToolDescription(
      item.name,
      item.input as Record<string, unknown>,
    );
    const details = this.getToolDetails(
      item.name,
      item.input as Record<string, unknown>,
    );

    return details
      ? `${toolIcon} **${item.name}**: ${description}\n${details}`
      : `${toolIcon} **${item.name}**: ${description}`;
  }

  /**
   * ツール実行結果を長さと内容に応じてフォーマット
   */
  formatToolResult(content: string, _isError: boolean): string {
    if (!content.trim()) {
      return "```\n(空の結果)\n```";
    }

    return `\`\`\`\n${this.stripAnsiCodes(content)}\n\`\`\``;
  }

  /**
   * TODOリストをチェックマーク付きリスト形式でフォーマット
   */
  formatTodoList(
    todos: Array<{
      status: string;
      content: string;
    }>,
  ): string {
    const todoList = todos.map((todo) => {
      const checkbox = todo.status === "completed"
        ? "✅"
        : todo.status === "in_progress"
        ? "🔄"
        : "⬜";
      return `${checkbox} ${todo.content}`;
    }).join("\n");

    return `📋 **TODOリスト更新:**\n${todoList}`;
  }

  /**
   * TODOリストの更新ログから変更後の状態を抽出
   */
  extractTodoListUpdate(textContent: string): string | null {
    try {
      // TodoWriteツールの使用を検出
      if (
        !textContent.includes('"name": "TodoWrite"') &&
        !textContent.includes("TodoWrite")
      ) {
        return null;
      }

      // JSONからtodosを抽出する正規表現
      const todoWriteMatch = textContent.match(/"todos":\s*(\[[\s\S]*?\])/);
      if (!todoWriteMatch) {
        return null;
      }

      // 安全なスキーマ検証でJSONをパース
      let parsedData: unknown;
      try {
        parsedData = JSON.parse(todoWriteMatch[1]);
      } catch {
        return null;
      }

      // TodoWriteInputスキーマで検証
      const validatedInput = validateTodoWriteInput({ todos: parsedData });
      if (!validatedInput || validatedInput.todos.length === 0) {
        return null;
      }

      return this.formatTodoList(validatedInput.todos);
    } catch (_error) {
      // エラーの場合は通常の処理を続行
      return null;
    }
  }

  /**
   * TodoWrite成功メッセージかどうかを判定
   */
  isTodoWriteSuccessMessage(content: string): boolean {
    // TodoWrite成功時の定型文パターン
    const successPatterns = [
      "Todos have been modified successfully",
      "Todo list has been updated",
      "Todos updated successfully",
      "Task list updated successfully",
    ];

    return successPatterns.some((pattern) => content.includes(pattern));
  }

  /**
   * ファイルパスから作業ディレクトリを除外した相対パスを取得
   */
  private getRelativePath(filePath: string): string {
    if (!filePath) return "";

    // worktreePathが設定されている場合はそれを基準に
    if (
      this.worktreePath && filePath.startsWith(this.worktreePath)
    ) {
      return filePath.slice(this.worktreePath.length).replace(/^\//, "");
    }

    // worktreePathがない場合は、リポジトリのパスパターンを探す
    const repoPattern = /\/repositories\/[^\/]+\/[^\/]+\//;
    const match = filePath.match(repoPattern);
    if (match && match.index !== undefined) {
      // リポジトリディレクトリ以降のパスを返す
      return filePath.slice(match.index + match[0].length);
    }

    // threadsディレクトリのパターンも探す
    const threadsPattern = /\/threads\/[^\/]+\/worktree\//;
    const threadsMatch = filePath.match(threadsPattern);
    if (threadsMatch && threadsMatch.index !== undefined) {
      // worktreeディレクトリ以降のパスを返す
      return filePath.slice(threadsMatch.index + threadsMatch[0].length);
    }

    // それ以外はファイル名のみ返す
    return filePath.split("/").pop() || "";
  }

  /**
   * ツール名に対応するアイコンを取得
   */
  private getToolIcon(toolName: string): string {
    const iconMap: Record<string, string> = {
      "Bash": "⚡",
      "Read": "📖",
      "Write": "✏️",
      "Edit": "🔧",
      "MultiEdit": "🔧",
      "Glob": "🔍",
      "Grep": "🔍",
      "LS": "📁",
      "Task": "🤖",
      "WebFetch": "🌐",
      "WebSearch": "🔎",
      "NotebookRead": "📓",
      "NotebookEdit": "📝",
      "TodoRead": "📋",
      "TodoWrite": "📋",
    };
    return iconMap[toolName] || "🔧";
  }

  /**
   * ツールの説明を生成
   */
  private getToolDescription(
    toolName: string,
    input?: Record<string, unknown>,
  ): string {
    switch (toolName) {
      case "Bash": {
        const command = input?.command as string;
        const description = input?.description as string;
        if (description) {
          return description;
        }
        if (command) {
          // コマンドが長い場合は短縮
          return command.length > 50
            ? `${command.substring(0, 50)}...`
            : command;
        }
        return "コマンド実行";
      }
      case "Read":
        return `ファイル読み込み: ${
          this.getRelativePath(input?.file_path as string || "")
        }`;
      case "Write":
        return `ファイル書き込み: ${
          this.getRelativePath(input?.file_path as string || "")
        }`;
      case "Edit":
        return `ファイル編集: ${
          this.getRelativePath(input?.file_path as string || "")
        }`;
      case "MultiEdit":
        return `ファイル一括編集: ${
          this.getRelativePath(input?.file_path as string || "")
        }`;
      case "Glob":
        return `ファイル検索: ${input?.pattern || ""}`;
      case "Grep":
        return `コンテンツ検索: ${input?.pattern || ""}`;
      case "LS":
        return `ディレクトリ一覧: ${
          this.getRelativePath(input?.path as string || "")
        }`;
      case "Task":
        return `エージェントタスク: ${input?.description || ""}`;
      case "WebFetch":
        return `Web取得: ${input?.url || ""}`;
      case "WebSearch":
        return `Web検索: ${input?.query || ""}`;
      case "NotebookRead":
        return `ノートブック読み込み: ${
          this.getRelativePath(input?.notebook_path as string || "")
        }`;
      case "NotebookEdit":
        return `ノートブック編集: ${
          this.getRelativePath(input?.notebook_path as string || "")
        }`;
      case "TodoRead":
        return "TODOリスト確認";
      default:
        return `${toolName}実行`;
    }
  }

  /**
   * ツール固有の詳細情報を生成
   */
  private getToolDetails(
    toolName: string,
    input?: Record<string, unknown>,
  ): string | null {
    switch (toolName) {
      case "Bash": {
        const command = typeof input?.command === "string"
          ? input.command.trim()
          : "";
        if (command) {
          return `\`\`\`bash\n${command}\n\`\`\``;
        }
        return null;
      }
      default:
        return null;
    }
  }
}
