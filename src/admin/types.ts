// エラー型定義
export type AdminError =
  | { type: "RATE_LIMIT"; retryAt: number; timestamp: number }
  | { type: "WORKER_NOT_FOUND"; threadId: string }
  | { type: "WORKER_CREATE_FAILED"; threadId: string; reason: string }
  | { type: "DEVCONTAINER_SETUP_FAILED"; threadId: string; error: string }
  | { type: "PERMISSION_ERROR"; message: string }
  | { type: "THREAD_TERMINATED"; threadId: string }
  | { type: "WORKSPACE_ERROR"; operation: string; error: string };

// Discord関連の型定義
export interface DiscordButtonComponent {
  type: 2;
  style: 1 | 2 | 3 | 4 | 5;
  label: string;
  custom_id: string;
  disabled?: boolean;
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordButtonComponent[];
}

export interface DiscordMessage {
  content: string;
  components?: DiscordActionRow[];
}

// Admin関連のインターフェース
export interface IAdmin {
  createWorker(
    threadId: string,
  ): Promise<
    import("neverthrow").Result<
      import("../worker/types.ts").IWorker,
      AdminError
    >
  >;
  getWorker(
    threadId: string,
  ): import("neverthrow").Result<
    import("../worker/types.ts").IWorker,
    AdminError
  >;
  routeMessage(
    threadId: string,
    message: string,
    onProgress?: (content: string) => Promise<void>,
    onReaction?: (emoji: string) => Promise<void>,
    messageId?: string,
    authorId?: string,
  ): Promise<import("neverthrow").Result<string | DiscordMessage, AdminError>>;
  handleButtonInteraction(
    threadId: string,
    customId: string,
  ): Promise<import("neverthrow").Result<string, AdminError>>;
  createInitialMessage(threadId: string): DiscordMessage;
  createRateLimitMessage(threadId: string, timestamp: number): string;
  terminateThread(
    threadId: string,
  ): Promise<import("neverthrow").Result<void, AdminError>>;
  restoreActiveThreads(): Promise<
    import("neverthrow").Result<void, AdminError>
  >;
  setAutoResumeCallback(
    callback: (threadId: string, message: string) => Promise<void>,
  ): void;
  setDiscordClient(client: import("discord.js").Client): void;
  setThreadCloseCallback(
    callback: (threadId: string) => Promise<void>,
  ): void;
  save(): Promise<void>;
  stopExecution(
    threadId: string,
  ): Promise<import("neverthrow").Result<void, AdminError>>;
  setPlanMode(
    threadId: string,
    planMode: boolean,
  ): Promise<import("neverthrow").Result<void, AdminError>>;
  closeThread(
    threadId: string,
  ): Promise<import("neverthrow").Result<void, AdminError>>;
}
