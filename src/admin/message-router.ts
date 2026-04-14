import { err, ok, Result } from "neverthrow";
import type { DiscordMessage } from "./types.ts";
import { WorkerManager } from "./worker-manager.ts";

export type MessageRouterError =
  | { type: "WORKER_NOT_FOUND"; threadId: string }
  | {
    type: "RATE_LIMIT_ERROR";
    threadId: string;
    timestamp?: number;
    message: string;
  }
  | { type: "MESSAGE_PROCESSING_ERROR"; threadId: string; error: string };

export class MessageRouter {
  constructor(private readonly workerManager: WorkerManager) {}

  async routeMessage(
    threadId: string,
    message: string,
    onProgress?: (content: string) => Promise<void>,
    onReaction?: (emoji: string) => Promise<void>,
  ): Promise<Result<string | DiscordMessage, MessageRouterError>> {
    const worker = this.workerManager.getWorker(threadId);
    if (!worker) {
      return err({ type: "WORKER_NOT_FOUND", threadId });
    }

    if (onReaction) {
      await onReaction("👀").catch(() => {});
    }

    const result = await worker.processMessage(message, onProgress, onReaction);
    if (result.isErr()) {
      const error = result.error;
      if (error.type === "RATE_LIMIT") {
        return err({
          type: "RATE_LIMIT_ERROR",
          threadId,
          timestamp: error.timestamp,
          message: error.message,
        });
      }
      if (error.type === "REPOSITORY_NOT_SET") {
        return ok(
          "リポジトリが設定されていません。/start でリポジトリを指定してください。",
        );
      }
      return err({
        type: "MESSAGE_PROCESSING_ERROR",
        threadId,
        error: error.type === "CODEX_EXECUTION_FAILED"
          ? error.error
          : JSON.stringify(error),
      });
    }

    return ok(result.value);
  }
}
