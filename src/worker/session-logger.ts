import { err, ok, Result } from "neverthrow";
import { WorkspaceManager } from "../workspace/workspace.ts";

export type SessionLoggerError = { type: "SAVE_FAILED"; error: string };

export class SessionLogger {
  constructor(private readonly workspaceManager: WorkspaceManager) {}

  async saveRawJsonlOutput(
    repositoryFullName?: string,
    sessionId?: string,
    output?: string,
  ): Promise<Result<string | null, SessionLoggerError>> {
    if (!repositoryFullName || !sessionId || !output) {
      return ok(null);
    }

    try {
      const path = await this.workspaceManager.saveRawSessionJsonl(
        repositoryFullName,
        sessionId,
        output,
      );
      return ok(path);
    } catch (error) {
      return err({
        type: "SAVE_FAILED",
        error: (error as Error).message,
      });
    }
  }
}
