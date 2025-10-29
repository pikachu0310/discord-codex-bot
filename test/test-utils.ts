import { WorkerState, WorkspaceManager } from "../src/workspace/workspace.ts";
import { Admin } from "../src/admin/admin.ts";
import { Worker } from "../src/worker/worker.ts";
import { IWorker } from "../src/worker/types.ts";
import { CodexCommandExecutor } from "../src/worker/codex-executor.ts";
import { ok } from "neverthrow";
import { GitRepository } from "../src/git-utils.ts";
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * テスト用のWorkspaceManagerとAdminを作成し、クリーンアップ関数と共に返す
 */
export async function createTestContext(
  verbose = false,
): Promise<{
  workspaceManager: WorkspaceManager;
  admin: Admin;
  testDir: string;
  cleanup: () => Promise<void>;
}> {
  const testDir = await Deno.makeTempDir({ prefix: "test_context_" });
  const workspaceManager = new WorkspaceManager(testDir);
  await workspaceManager.initialize();
  const adminState = {
    activeThreadIds: [],
    lastUpdated: new Date().toISOString(),
  };
  const admin = new Admin(adminState, workspaceManager, verbose, undefined);

  const cleanup = async () => {
    try {
      await Deno.remove(testDir, { recursive: true });
    } catch (error) {
      console.warn(`テストディレクトリのクリーンアップに失敗: ${error}`);
    }
  };

  return {
    workspaceManager,
    admin,
    testDir,
    cleanup,
  };
}

/**
 * テスト用のWorkspaceManagerを作成
 */
export async function createTestWorkspaceManager(): Promise<WorkspaceManager> {
  const testDir = await Deno.makeTempDir({ prefix: "workspace_test_" });
  const workspace = new WorkspaceManager(testDir);
  await workspace.initialize();
  return workspace;
}

/**
 * テスト用のWorkerStateを作成
 */
export function createTestWorkerState(
  workerName: string,
  threadId: string,
  options: Partial<WorkerState> = {},
): WorkerState {
  const now = new Date().toISOString();
  return {
    workerName,
    threadId,
    devcontainerConfig: {
      useDevcontainer: false,
      useFallbackDevcontainer: false,
      hasDevcontainerFile: false,
      hasAnthropicsFeature: false,
      isStarted: false,
    },
    status: "active",
    createdAt: now,
    lastActiveAt: now,
    ...options,
  };
}

/**
 * テスト用のWorkerを作成
 */
export async function createTestWorker(
  name: string,
  workspaceManager: WorkspaceManager,
  executor?: CodexCommandExecutor,
  verbose = false,
  threadId = "test-thread-id",
): Promise<Worker> {
  const state = createTestWorkerState(name, threadId);
  const worker = new Worker(
    state,
    workspaceManager,
    executor || createMockCodexCommandExecutor(),
    verbose,
    undefined,
  );
  return worker;
}

/**
 * Workerの基本的な検証を行う
 */
export function assertWorkerValid(worker: IWorker | null): void {
  assertExists(worker);
  assertEquals(typeof worker.getName(), "string");
  assertEquals(worker.getName().includes("-"), true);
}

/**
 * モックCodexCommandExecutorを作成
 */
export function createMockCodexCommandExecutor(
  defaultResponse = "モックレスポンス",
): CodexCommandExecutor & {
  setResponse: (message: string, response: string) => void;
  lastArgs?: string[];
  lastCwd?: string;
  executionCount: number;
} {
  const responses = new Map<string, string>();
  let lastArgs: string[] | undefined;
  let lastCwd: string | undefined;
  let executionCount = 0;

  const executor: CodexCommandExecutor = {
    async executeStreaming(
      args: string[],
      cwd: string,
      onData: (data: Uint8Array) => void,
      _abortSignal?: AbortSignal,
      _onProcessStart?: (childProcess: Deno.ChildProcess) => void,
      _env?: Record<string, string>,
      _options?: { usePty?: boolean },
    ) {
      lastArgs = args;
      lastCwd = cwd;
      executionCount++;

      // メッセージを取得（最後の引数がプロンプト）
      const message = args.length > 0 ? args[args.length - 1] : "";
      const response = responses.get(message) || defaultResponse;

      // JSONレスポンスを作成（改行で終わる必要がある）
      const jsonResponse = `${
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: response,
          session_id: "mock-session-id",
        })
      }\n`;

      // データをストリーミング
      onData(new TextEncoder().encode(jsonResponse));

      return ok({
        code: 0,
        stderr: new Uint8Array(),
      });
    },
  };

  return Object.assign(executor, {
    setResponse: (message: string, response: string) => {
      responses.set(message, response);
    },
    get lastArgs() {
      return lastArgs;
    },
    get lastCwd() {
      return lastCwd;
    },
    get executionCount() {
      return executionCount;
    },
  });
}

/**
 * ストリーミング対応のモックCodexCommandExecutorを作成
 */
export function createMockStreamingCodexCommandExecutor(
  defaultResponse = "モックレスポンス",
  options: { streamingEnabled?: boolean; streamingDelay?: number } = {},
): CodexCommandExecutor & {
  setResponse: (message: string, response: string) => void;
  lastArgs?: string[];
  lastCwd?: string;
  executionCount: number;
  streamingEnabled: boolean;
  streamingDelay: number;
} {
  const responses = new Map<string, string>();
  let lastArgs: string[] | undefined;
  let lastCwd: string | undefined;
  let executionCount = 0;
  const streamingEnabled = options.streamingEnabled ?? true;
  const streamingDelay = options.streamingDelay ?? 10;

  const executor: CodexCommandExecutor = {
    async executeStreaming(
      args: string[],
      cwd: string,
      onData: (data: Uint8Array) => void,
      _abortSignal?: AbortSignal,
      _onProcessStart?: (childProcess: Deno.ChildProcess) => void,
      _env?: Record<string, string>,
      _options?: { usePty?: boolean },
    ) {
      lastArgs = args;
      lastCwd = cwd;
      executionCount++;

      // メッセージを取得（最後の引数がプロンプト）
      const message = args.length > 0 ? args[args.length - 1] : "";
      const response = responses.get(message) || defaultResponse;

      if (streamingEnabled) {
        // レスポンスが既にJSONL形式の場合はそのまま使用
        if (response.includes('{"type"')) {
          // JSONLフォーマットのレスポンスを行ごとに分割してストリーミング
          const lines = response.split("\n");
          for (const line of lines) {
            if (line.trim()) {
              onData(new TextEncoder().encode(line + "\n"));
              await new Promise((resolve) =>
                setTimeout(resolve, streamingDelay)
              );
            }
          }
        } else {
          // 通常のテキストレスポンスの場合は、JSON形式に変換
          const jsonLines = [
            JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: "mock-session-id",
              tools: [],
            }),
            JSON.stringify({
              type: "assistant",
              message: {
                id: "msg_mock",
                type: "message",
                role: "assistant",
                model: "codex-3-opus",
                content: [{ type: "text", text: response }],
                stop_reason: "end_turn",
              },
              session_id: "mock-session-id",
            }),
            JSON.stringify({
              type: "result",
              subtype: "success",
              is_error: false,
              result: response,
              session_id: "mock-session-id",
            }),
          ];

          for (const jsonLine of jsonLines) {
            onData(new TextEncoder().encode(jsonLine + "\n"));
            await new Promise((resolve) => setTimeout(resolve, streamingDelay));
          }
        }
      } else {
        // ストリーミングなしで一度に送信（JSON形式）
        const jsonResponse = JSON.stringify({
          type: "result",
          result: response,
          session_id: "mock-session-id",
        }) + "\n";
        onData(new TextEncoder().encode(jsonResponse));
      }

      return ok({
        code: 0,
        stderr: new Uint8Array(),
      });
    },
  };

  return Object.assign(executor, {
    setResponse: (message: string, response: string) => {
      responses.set(message, response);
    },
    get lastArgs() {
      return lastArgs;
    },
    get lastCwd() {
      return lastCwd;
    },
    get executionCount() {
      return executionCount;
    },
    streamingEnabled,
    streamingDelay,
  });
}

/**
 * エラーを返すモックCodexCommandExecutorを作成
 */
export function createErrorMockCodexCommandExecutor(
  errorMessage = "Command failed",
  exitCode = 1,
): CodexCommandExecutor {
  return {
    async executeStreaming(
      _args: string[],
      _cwd: string,
      _onData: (data: Uint8Array) => void,
      _abortSignal?: AbortSignal,
      _onProcessStart?: (childProcess: Deno.ChildProcess) => void,
      _env?: Record<string, string>,
      _options?: { usePty?: boolean },
    ) {
      return ok({
        code: exitCode,
        stderr: new TextEncoder().encode(errorMessage),
      });
    },
  };
}

/**
 * テスト用のdevcontainer設定を作成
 */
export function createTestDevcontainerConfig(
  options: {
    useDevcontainer?: boolean;
    hasDevcontainerFile?: boolean;
    hasAnthropicsFeature?: boolean;
    containerId?: string;
    isStarted?: boolean;
  } = {},
) {
  return {
    useDevcontainer: options.useDevcontainer ?? false,
    hasDevcontainerFile: options.hasDevcontainerFile ?? false,
    hasAnthropicsFeature: options.hasAnthropicsFeature ?? false,
    containerId: options.containerId,
    isStarted: options.isStarted ?? false,
  };
}

/**
 * テスト用のリポジトリ情報を作成
 */
export function createTestRepository(
  org = "test-org",
  repo = "test-repo",
): GitRepository {
  return {
    org,
    repo,
    fullName: `${org}/${repo}`,
    localPath: `${org}/${repo}`,
  };
}

/**
 * コンソール出力をキャプチャするヘルパー関数
 */
export function captureConsoleOutput(): {
  logs: string[];
  errors: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };

  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };

  const restore = () => {
    console.log = originalLog;
    console.error = originalError;
  };

  return { logs, errors, restore };
}

/**
 * 共通のエラーメッセージ
 */
export const ERROR_MESSAGES = {
  REPOSITORY_NOT_SET:
    "リポジトリが設定されていません。/start コマンドでリポジトリを指定してください。",
  WORKER_NOT_FOUND: (threadId: string) =>
    `Worker not found for thread: ${threadId}`,
  THREAD_TERMINATED: "スレッドを終了しました。worktreeも削除されました。",
} as const;

/**
 * 一時ファイルを作成してクリーンアップ関数と共に返す
 */
export async function createTempFile(
  content: string,
  suffix = ".txt",
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const tempDir = await Deno.makeTempDir();
  const path = `${tempDir}/temp${suffix}`;
  await Deno.writeTextFile(path, content);

  const cleanup = async () => {
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // エラーは無視
    }
  };

  return { path, cleanup };
}

/**
 * 非同期処理の完了を待つヘルパー関数
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 1000,
  interval = 10,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error("Timeout waiting for condition");
}

/**
 * Codex CLIが利用可能かチェックする
 */
export async function isCodexCliAvailable(): Promise<boolean> {
  try {
    const process = new Deno.Command("codex", {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    });

    const result = await process.output();
    return result.success;
  } catch {
    return false;
  }
}
