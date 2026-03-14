import { join } from "std/path/mod.ts";
import { ensureDir } from "std/fs/mod.ts";
import { err, ok, Result } from "neverthrow";
import type { WorkspaceError } from "./types.ts";
import { validateSessionLogSafe } from "./schemas/session-schema.ts";
import type { SessionLog } from "./schemas/session-schema.ts";

export type { SessionLog } from "./schemas/session-schema.ts";

export class SessionManager {
  private readonly sessionsDir: string;

  constructor(baseDir: string) {
    this.sessionsDir = join(baseDir, "sessions");
  }

  async initialize(): Promise<Result<void, WorkspaceError>> {
    try {
      await ensureDir(this.sessionsDir);
      return ok(undefined);
    } catch (error) {
      return err({
        type: "SESSION_INITIALIZATION_FAILED",
        error: `SessionManagerの初期化に失敗しました: ${error}`,
      });
    }
  }

  private getRepositorySessionDirPath(repositoryFullName: string): string {
    return join(this.sessionsDir, repositoryFullName);
  }

  private getRawSessionFilePathWithTimestamp(
    repositoryFullName: string,
    timestamp: string,
    sessionId: string,
  ): string {
    return join(
      this.getRepositorySessionDirPath(repositoryFullName),
      `${timestamp}_${sessionId}.jsonl`,
    );
  }

  async saveRawSessionJsonl(
    repositoryFullName: string,
    sessionId: string,
    rawJsonlContent: string,
  ): Promise<Result<void, WorkspaceError>> {
    try {
      const repositorySessionDir = this.getRepositorySessionDirPath(
        repositoryFullName,
      );
      await ensureDir(repositorySessionDir);

      // 既存のファイルを探す
      let existingFilePath: string | null = null;
      try {
        for await (const entry of Deno.readDir(repositorySessionDir)) {
          if (entry.isFile && entry.name.endsWith(`_${sessionId}.jsonl`)) {
            existingFilePath = join(repositorySessionDir, entry.name);
            break;
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }

      let filePath: string;
      if (existingFilePath) {
        // 既存ファイルに追記
        filePath = existingFilePath;
        await Deno.writeTextFile(filePath, `\n${rawJsonlContent}`, {
          append: true,
        });
      } else {
        // 新規ファイル作成
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        filePath = this.getRawSessionFilePathWithTimestamp(
          repositoryFullName,
          timestamp,
          sessionId,
        );
        await Deno.writeTextFile(filePath, rawJsonlContent);
      }
      return ok(undefined);
    } catch (error) {
      return err({
        type: "SESSION_SAVE_FAILED",
        repositoryFullName,
        sessionId,
        error: `セッションログの保存に失敗しました: ${error}`,
      });
    }
  }

  async loadSessionLogs(
    repositoryFullName: string,
    sessionId: string,
  ): Promise<Result<SessionLog[], WorkspaceError>> {
    const repositorySessionDir = this.getRepositorySessionDirPath(
      repositoryFullName,
    );

    try {
      // セッションIDを含むファイルを探す
      let sessionFilePath: string | null = null;
      for await (const entry of Deno.readDir(repositorySessionDir)) {
        if (entry.isFile && entry.name.endsWith(`_${sessionId}.jsonl`)) {
          sessionFilePath = join(repositorySessionDir, entry.name);
          break;
        }
      }

      if (!sessionFilePath) {
        return ok([]);
      }

      const content = await Deno.readTextFile(sessionFilePath);
      const lines = content.trim().split("\n").filter((line) =>
        line.length > 0
      );

      const logs: SessionLog[] = [];
      for (const line of lines) {
        try {
          const result = validateSessionLogSafe(JSON.parse(line));
          if (result.success) {
            logs.push(result.data);
          } else {
            console.error(`Invalid session log entry:`, result.error);
          }
        } catch (parseError) {
          console.error(`Failed to parse session log line:`, parseError);
        }
      }
      return ok(logs);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return ok([]);
      }
      return err({
        type: "SESSION_LOAD_FAILED",
        repositoryFullName,
        sessionId,
        error: `セッションログの読み込みに失敗しました: ${error}`,
      });
    }
  }

  async getSessionIds(
    repositoryFullName: string,
  ): Promise<Result<string[], WorkspaceError>> {
    const repositorySessionDir = this.getRepositorySessionDirPath(
      repositoryFullName,
    );

    try {
      const sessionIds = new Set<string>();

      for await (const entry of Deno.readDir(repositorySessionDir)) {
        if (entry.isFile && entry.name.endsWith(".jsonl")) {
          // ファイル名から sessionId を抽出 (timestamp_sessionId.jsonl)
          const match = entry.name.match(/_([^_]+)\.jsonl$/);
          if (match) {
            sessionIds.add(match[1]);
          }
        }
      }

      return ok(Array.from(sessionIds).sort());
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return ok([]);
      }
      return err({
        type: "SESSION_LIST_FAILED",
        repositoryFullName,
        error: `セッションID一覧の取得に失敗しました: ${error}`,
      });
    }
  }

  async deleteSessionLogs(
    repositoryFullName: string,
    sessionId: string,
  ): Promise<Result<void, WorkspaceError>> {
    const repositorySessionDir = this.getRepositorySessionDirPath(
      repositoryFullName,
    );

    try {
      for await (const entry of Deno.readDir(repositorySessionDir)) {
        if (entry.isFile && entry.name.endsWith(`_${sessionId}.jsonl`)) {
          const filePath = join(repositorySessionDir, entry.name);
          await Deno.remove(filePath);
          break;
        }
      }
      return ok(undefined);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return ok(undefined);
      }
      return err({
        type: "SESSION_DELETE_FAILED",
        repositoryFullName,
        sessionId,
        error: `セッションログの削除に失敗しました: ${error}`,
      });
    }
  }

  /**
   * 指定されたセッションの生JSONLファイルパスを取得
   */
  async getRawSessionFilePath(
    repositoryFullName: string,
    sessionId: string,
  ): Promise<string | null> {
    try {
      const repositorySessionDir = this.getRepositorySessionDirPath(
        repositoryFullName,
      );

      // 既存のファイルを探す
      try {
        for await (const entry of Deno.readDir(repositorySessionDir)) {
          if (entry.isFile && entry.name.endsWith(`_${sessionId}.jsonl`)) {
            return join(repositorySessionDir, entry.name);
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }

      return null;
    } catch (error) {
      console.error("セッションファイルパス取得エラー:", error);
      return null;
    }
  }
}
