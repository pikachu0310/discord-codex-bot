import type { SavedAttachment } from "../attachments.ts";

export interface PendingQuestion {
  id: string;
  title: string;
  options: readonly string[];
  position: number;
  total: number;
}

export interface QuestionAnswer {
  questionId: string;
  optionIndex: number;
}

export type ProgressCallback = (
  content: string,
  questions?: readonly PendingQuestion[],
) => Promise<void>;

export type WorkerError =
  | { type: "REPOSITORY_NOT_SET" }
  | { type: "CODEX_EXECUTION_FAILED"; error: string }
  | {
    type: "RATE_LIMIT";
    timestamp?: number;
    retryAt?: number;
    message: string;
  }
  | { type: "WORKSPACE_ERROR"; operation: string; error: string }
  | { type: "SESSION_LOG_FAILED"; operation: string; error: string };

export type CodexExecutorError =
  | { type: "COMMAND_EXECUTION_FAILED"; code: number; stderr: string }
  | { type: "STREAM_PROCESSING_ERROR"; error: string };

export interface IWorker {
  processMessage(
    message: string,
    attachments?: readonly SavedAttachment[],
    onProgress?: ProgressCallback,
    onReaction?: (emoji: string) => Promise<void>,
    questionAnswer?: QuestionAnswer,
  ): Promise<import("neverthrow").Result<string, WorkerError>>;
  isRunning?(): boolean;
  getPendingQuestion?(): string | null;
  getPendingQuestions?(): readonly PendingQuestion[];
  getName(): string;
  getRepository(): import("../git-utils.ts").GitRepository | null;
  setRepository(
    repository: import("../git-utils.ts").GitRepository,
    localPath: string,
  ): Promise<import("neverthrow").Result<void, WorkerError>>;
  save(): Promise<import("neverthrow").Result<void, WorkerError>>;
  stopExecution(
    onProgress?: (content: string) => Promise<void>,
  ): Promise<boolean>;
  isPlanMode(): boolean;
  setPlanMode(planMode: boolean): void;
}
