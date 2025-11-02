import { assertEquals } from "https://deno.land/std@0.214.0/assert/mod.ts";
import { describe, it } from "https://deno.land/std@0.214.0/testing/bdd.ts";
import { Worker } from "./worker/worker.ts";
import { CodexCommandExecutor } from "./worker/codex-executor.ts";
import {
  recordDangerouslyBypassUnsupportedForTests,
  recordExecJsonUnsupportedForTests,
  recordVerboseFlagUnsupportedForTests,
  recordDangerouslySkipPermissionsUnsupportedForTests,
  resetCodexCliCapabilityCacheForTests,
} from "./worker/codex-cli-capabilities.ts";
import { WorkerState, WorkspaceManager } from "./workspace/workspace.ts";
import { parseRepository } from "./git-utils.ts";
import { ok } from "neverthrow";

class OutputFormatFallbackExecutor implements CodexCommandExecutor {
  attempts = 0;
  argsHistory: string[][] = [];

  async executeStreaming(
    args: string[],
    _cwd: string,
    _onData: (data: Uint8Array) => void,
    _abortSignal?: AbortSignal,
    _onProcessStart?: (childProcess: Deno.ChildProcess) => void,
    _env?: Record<string, string>,
    _options?: { usePty?: boolean },
  ) {
    this.attempts++;
    this.argsHistory.push([...args]);
    const encoder = new TextEncoder();

    if (this.attempts === 1) {
      const stderrMessage =
        "error: unexpected argument '--output-format' found\n";
      return ok({ code: 2, stderr: encoder.encode(stderrMessage) });
    }

    const sessionMessage = `${
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "test-session-id",
        apiKeySource: "env",
        cwd: ".",
        tools: [],
        mcp_servers: [],
        model: "test-model",
        permissionMode: "default",
      })
    }\n`;
    _onData(encoder.encode(sessionMessage));

    const resultMessage = `${
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        session_id: "test-session-id",
        total_cost_usd: 0,
      })
    }\n`;
    _onData(encoder.encode(resultMessage));

    return ok({ code: 0, stderr: new Uint8Array() });
  }
}

class ExecJsonFallbackExecutor implements CodexCommandExecutor {
  attempts = 0;
  argsHistory: string[][] = [];

  async executeStreaming(
    args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
  ) {
    this.attempts++;
    this.argsHistory.push([...args]);
    const encoder = new TextEncoder();

    if (this.attempts === 1) {
      const stderrMessage = "error: unexpected argument '--json' found\n";
      return ok({ code: 2, stderr: encoder.encode(stderrMessage) });
    }

    const sessionMessage = `${
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "test-session-id",
        apiKeySource: "env",
        cwd: ".",
        tools: [],
        mcp_servers: [],
        model: "test-model",
        permissionMode: "default",
      })
    }\n`;
    onData(encoder.encode(sessionMessage));

    const resultMessage = `${
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        session_id: "test-session-id",
        total_cost_usd: 0,
      })
    }\n`;
    onData(encoder.encode(resultMessage));

    return ok({ code: 0, stderr: new Uint8Array() });
  }
}

class ExecColorFallbackExecutor implements CodexCommandExecutor {
  attempts = 0;
  argsHistory: string[][] = [];

  async executeStreaming(
    args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
  ) {
    this.attempts++;
    this.argsHistory.push([...args]);
    const encoder = new TextEncoder();

    if (this.attempts === 1) {
      const stderrMessage = "error: unexpected argument '--color' found\n";
      return ok({ code: 2, stderr: encoder.encode(stderrMessage) });
    }

    const sessionMessage = `${
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "test-session-id",
        apiKeySource: "env",
        cwd: ".",
        tools: [],
        mcp_servers: [],
        model: "test-model",
        permissionMode: "default",
      })
    }\n`;
    onData(encoder.encode(sessionMessage));

    const resultMessage = `${
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        session_id: "test-session-id",
        total_cost_usd: 0,
      })
    }\n`;
    onData(encoder.encode(resultMessage));

    return ok({ code: 0, stderr: new Uint8Array() });
  }
}

class VerboseFallbackExecutor implements CodexCommandExecutor {
  attempts = 0;
  argsHistory: string[][] = [];

  async executeStreaming(
    args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
    _abortSignal?: AbortSignal,
    _onProcessStart?: (childProcess: Deno.ChildProcess) => void,
    _env?: Record<string, string>,
    _options?: { usePty?: boolean },
  ) {
    this.attempts++;
    this.argsHistory.push([...args]);
    const encoder = new TextEncoder();

    if (this.attempts === 1) {
      const stderrMessage = "error: unexpected argument '--verbose' found\n";
      return ok({ code: 2, stderr: encoder.encode(stderrMessage) });
    }

    const sessionMessage = `${
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "test-session-id",
        apiKeySource: "env",
        cwd: ".",
        tools: [],
        mcp_servers: [],
        model: "test-model",
        permissionMode: "default",
      })
    }\n`;
    onData(encoder.encode(sessionMessage));

    const resultMessage = `${
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        session_id: "test-session-id",
        total_cost_usd: 0,
      })
    }\n`;
    onData(encoder.encode(resultMessage));

    return ok({ code: 0, stderr: new Uint8Array() });
  }
}

class MultipleFlagFallbackExecutor implements CodexCommandExecutor {
  attempts = 0;
  argsHistory: string[][] = [];

  async executeStreaming(
    args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
    _abortSignal?: AbortSignal,
    _onProcessStart?: (childProcess: Deno.ChildProcess) => void,
    _env?: Record<string, string>,
    _options?: { usePty?: boolean },
  ) {
    this.attempts++;
    this.argsHistory.push([...args]);
    const encoder = new TextEncoder();

    if (this.attempts === 1) {
      const stderrMessage = "error: unexpected argument '--json' found\n";
      return ok({ code: 2, stderr: encoder.encode(stderrMessage) });
    }

    if (this.attempts === 2) {
      const stderrMessage =
        "error: unexpected argument '--output-format' found\n";
      return ok({ code: 2, stderr: encoder.encode(stderrMessage) });
    }

    if (this.attempts === 3) {
      const stderrMessage = "error: unexpected argument '--verbose' found\n";
      return ok({ code: 2, stderr: encoder.encode(stderrMessage) });
    }

    if (this.attempts === 4) {
      const stderrMessage =
        "error: unexpected argument '--dangerously-skip-permissions' found\n";
      return ok({ code: 2, stderr: encoder.encode(stderrMessage) });
    }

    const sessionMessage = `${
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "test-session-id",
        apiKeySource: "env",
        cwd: ".",
        tools: [],
        mcp_servers: [],
        model: "test-model",
        permissionMode: "default",
      })
    }\n`;
    onData(encoder.encode(sessionMessage));

    const resultMessage = `${
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        session_id: "test-session-id",
        total_cost_usd: 0,
      })
    }\n`;
    onData(encoder.encode(resultMessage));

    return ok({ code: 0, stderr: new Uint8Array() });
  }
}

class DangerouslySkipPermissionsFallbackExecutor implements CodexCommandExecutor {
  attempts = 0;
  argsHistory: string[][] = [];

  async executeStreaming(
    args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
    _abortSignal?: AbortSignal,
    _onProcessStart?: (childProcess: Deno.ChildProcess) => void,
    _env?: Record<string, string>,
    _options?: { usePty?: boolean },
  ) {
    this.attempts++;
    this.argsHistory.push([...args]);
    const encoder = new TextEncoder();

    if (this.attempts === 1) {
      const stderrMessage =
        "error: unexpected argument '--dangerously-skip-permissions' found\n";
      return ok({ code: 2, stderr: encoder.encode(stderrMessage) });
    }

    const sessionMessage = `${
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "test-session-id",
        apiKeySource: "env",
        cwd: ".",
        tools: [],
        mcp_servers: [],
        model: "test-model",
        permissionMode: "default",
      })
    }\n`;
    onData(encoder.encode(sessionMessage));

    const resultMessage = `${
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        session_id: "test-session-id",
        total_cost_usd: 0,
      })
    }\n`;
    onData(encoder.encode(resultMessage));

    return ok({ code: 0, stderr: new Uint8Array() });
  }
}

class DangerouslyBypassFallbackExecutor implements CodexCommandExecutor {
  attempts = 0;
  argsHistory: string[][] = [];

  async executeStreaming(
    args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
  ) {
    this.attempts++;
    this.argsHistory.push([...args]);
    const encoder = new TextEncoder();

    if (this.attempts === 1) {
      const stderrMessage =
        "error: unexpected argument '--dangerously-bypass-approvals-and-sandbox' found\n";
      return ok({ code: 2, stderr: encoder.encode(stderrMessage) });
    }

    const sessionMessage = `${
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "test-session-id",
        apiKeySource: "env",
        cwd: ".",
        tools: [],
        mcp_servers: [],
        model: "test-model",
        permissionMode: "default",
      })
    }\n`;
    onData(encoder.encode(sessionMessage));

    const resultMessage = `${
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        session_id: "test-session-id",
        total_cost_usd: 0,
      })
    }\n`;
    onData(encoder.encode(resultMessage));

    return ok({ code: 0, stderr: new Uint8Array() });
  }
}

class ExecJsonAgentMessageExecutor implements CodexCommandExecutor {
  async executeStreaming(
    _args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
  ) {
    const encoder = new TextEncoder();
    const events = [
      {
        type: "item.completed",
        item: {
          id: "item_0",
          type: "reasoning",
          text: "Determining user's message count",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "agent_message",
          text: "ユーザーとして送ったメッセージはこれで2通目です。",
        },
      },
      {
        type: "turn.completed",
        session_id: "session-exec-json",
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        result: "ユーザーとして送ったメッセージはこれで2通目です。",
      },
    ];

    for (const event of events) {
      onData(encoder.encode(`${JSON.stringify(event)}\n`));
    }

    return ok({ code: 0, stderr: new Uint8Array() });
  }
}

class TtyFallbackExecutor implements CodexCommandExecutor {
  attempts = 0;
  optionsHistory: Array<{ usePty?: boolean }> = [];

  async executeStreaming(
    args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
    _abortSignal?: AbortSignal,
    _onProcessStart?: (childProcess: Deno.ChildProcess) => void,
    _env?: Record<string, string>,
    options?: { usePty?: boolean },
  ) {
    this.attempts++;
    this.optionsHistory.push({ usePty: options?.usePty });
    const encoder = new TextEncoder();

    if (this.attempts === 1) {
      const stderrMessage = "Error: stdout is not a terminal\n";
      return ok({ code: 1, stderr: encoder.encode(stderrMessage) });
    }

    const sessionMessage = `${
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "test-session-id",
        apiKeySource: "env",
        cwd: ".",
        tools: [],
        mcp_servers: [],
        model: "test-model",
        permissionMode: "default",
      })
    }\n`;
    onData(encoder.encode(sessionMessage));

    const assistantMessage = `${
      JSON.stringify({
        type: "assistant",
        subtype: "message",
        message: {
          content: "result",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })
    }\n`;
    onData(encoder.encode(assistantMessage));

    const resultMessage = `${
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        session_id: "test-session-id",
        total_cost_usd: 0,
      })
    }\n`;
    onData(encoder.encode(resultMessage));

    return ok({ code: 0, stderr: new Uint8Array() });
  }
}

describe("Worker --output-format フラグ自動再試行", () => {
  it("Codex CLIが--output-formatを拒否した場合に自動でフラグを無効化する", async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      const workspaceManager = new WorkspaceManager(tempDir);
      await workspaceManager.initialize();

      const executor = new OutputFormatFallbackExecutor();

      resetCodexCliCapabilityCacheForTests();
      recordExecJsonUnsupportedForTests();
      const repoPath = await Deno.makeTempDir();
      const gitInit = new Deno.Command("git", { args: ["init"], cwd: repoPath });
      await gitInit.output();

      try {
        const state: WorkerState = {
          workerName: "test-worker",
          threadId: "thread-id",
          devcontainerConfig: {
            useDevcontainer: false,
            useFallbackDevcontainer: false,
            hasDevcontainerFile: false,
            hasAnthropicsFeature: false,
            isStarted: false,
          },
          status: "active",
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        };

        const worker = new Worker(
          state,
          workspaceManager,
          executor,
          true,
        );

        const repositoryResult = parseRepository("test/repo");
        if (repositoryResult.isOk()) {
          await worker.setRepository(repositoryResult.value, repoPath);
        }

        worker.setUseDevcontainer(false);
        Object.defineProperty(worker, "codexExecutor", {
          value: executor,
          writable: true,
          configurable: true,
        });

        const result = await worker.processMessage("テスト");
        assertEquals(result.isOk(), true);
        assertEquals(executor.attempts, 2);

        const firstArgs = executor.argsHistory[0];
        const secondArgs = executor.argsHistory[1];
        assertEquals(firstArgs.includes("--output-format"), true);
        assertEquals(secondArgs.includes("--output-format"), false);
      } finally {
        await Deno.remove(repoPath, { recursive: true });
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      resetCodexCliCapabilityCacheForTests();
    }
  });
});

describe("Worker exec --json フラグ自動再試行", () => {
  it("Codex CLIが--jsonを拒否した場合に自動でレガシーモードへ切り替える", async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      const workspaceManager = new WorkspaceManager(tempDir);
      await workspaceManager.initialize();

      const executor = new ExecJsonFallbackExecutor();

      resetCodexCliCapabilityCacheForTests();
      const repoPath = await Deno.makeTempDir();
      const gitInit = new Deno.Command("git", { args: ["init"], cwd: repoPath });
      await gitInit.output();

      try {
        const state: WorkerState = {
          workerName: "test-worker",
          threadId: "thread-id",
          devcontainerConfig: {
            useDevcontainer: false,
            useFallbackDevcontainer: false,
            hasDevcontainerFile: false,
            hasAnthropicsFeature: false,
            isStarted: false,
          },
          status: "active",
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        };

        const worker = new Worker(
          state,
          workspaceManager,
          executor,
          true,
        );

        const repositoryResult = parseRepository("test/repo");
        if (repositoryResult.isOk()) {
          await worker.setRepository(repositoryResult.value, repoPath);
        }

        worker.setUseDevcontainer(false);
        Object.defineProperty(worker, "codexExecutor", {
          value: executor,
          writable: true,
          configurable: true,
        });

        const result = await worker.processMessage("テスト");
        assertEquals(result.isOk(), true);
        assertEquals(executor.attempts, 2);

        const firstArgs = executor.argsHistory[0];
        const secondArgs = executor.argsHistory[1];
        assertEquals(firstArgs.includes("exec"), true);
        assertEquals(firstArgs.includes("--json"), true);
        assertEquals(secondArgs.includes("exec"), false);
        assertEquals(secondArgs.includes("--output-format"), true);
      } finally {
        await Deno.remove(repoPath, { recursive: true });
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      resetCodexCliCapabilityCacheForTests();
    }
  });
});

describe("Worker --color フラグ自動再試行", () => {
  it("Codex CLIが--colorを拒否した場合に自動でフラグを無効化する", async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      const workspaceManager = new WorkspaceManager(tempDir);
      await workspaceManager.initialize();

      const executor = new ExecColorFallbackExecutor();

      resetCodexCliCapabilityCacheForTests();
      const repoPath = await Deno.makeTempDir();
      const gitInit = new Deno.Command("git", { args: ["init"], cwd: repoPath });
      await gitInit.output();

      try {
        const state: WorkerState = {
          workerName: "test-worker",
          threadId: "thread-id",
          devcontainerConfig: {
            useDevcontainer: false,
            useFallbackDevcontainer: false,
            hasDevcontainerFile: false,
            hasAnthropicsFeature: false,
            isStarted: false,
          },
          status: "active",
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        };

        const worker = new Worker(
          state,
          workspaceManager,
          executor,
          true,
        );

        const repositoryResult = parseRepository("test/repo");
        if (repositoryResult.isOk()) {
          await worker.setRepository(repositoryResult.value, repoPath);
        }

        worker.setUseDevcontainer(false);
        Object.defineProperty(worker, "codexExecutor", {
          value: executor,
          writable: true,
          configurable: true,
        });

        const result = await worker.processMessage("テスト");
        assertEquals(result.isOk(), true);
        assertEquals(executor.attempts, 2);

        const firstArgs = executor.argsHistory[0];
        const secondArgs = executor.argsHistory[1];
        assertEquals(firstArgs.includes("--color"), true);
        assertEquals(secondArgs.includes("--color"), false);
        assertEquals(secondArgs.includes("exec"), true);
      } finally {
        await Deno.remove(repoPath, { recursive: true });
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      resetCodexCliCapabilityCacheForTests();
    }
  });
});

describe("Worker --verbose フラグ自動再試行", () => {
  it("Codex CLIが--verboseを拒否した場合に自動でフラグを無効化する", async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      const workspaceManager = new WorkspaceManager(tempDir);
      await workspaceManager.initialize();

      const executor = new VerboseFallbackExecutor();

      resetCodexCliCapabilityCacheForTests();
      const repoPath = await Deno.makeTempDir();
      const gitInit = new Deno.Command("git", { args: ["init"], cwd: repoPath });
      await gitInit.output();

      try {
        const state: WorkerState = {
          workerName: "test-worker",
          threadId: "thread-id",
          devcontainerConfig: {
            useDevcontainer: false,
            useFallbackDevcontainer: false,
            hasDevcontainerFile: false,
            hasAnthropicsFeature: false,
            isStarted: false,
          },
          status: "active",
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        };

        const worker = new Worker(
          state,
          workspaceManager,
          executor,
          true,
        );

        const repositoryResult = parseRepository("test/repo");
        if (repositoryResult.isOk()) {
          await worker.setRepository(repositoryResult.value, repoPath);
        }

        worker.setUseDevcontainer(false);
        Object.defineProperty(worker, "codexExecutor", {
          value: executor,
          writable: true,
          configurable: true,
        });

        const result = await worker.processMessage("テスト");
        assertEquals(result.isOk(), true);
        assertEquals(executor.attempts, 2);

        const firstArgs = executor.argsHistory[0];
        const secondArgs = executor.argsHistory[1];
        assertEquals(firstArgs.includes("--verbose"), true);
        assertEquals(secondArgs.includes("--verbose"), false);
      } finally {
        await Deno.remove(repoPath, { recursive: true });
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      resetCodexCliCapabilityCacheForTests();
    }
  });
});

describe("Worker --dangerously-skip-permissions フラグ自動再試行", () => {
  it(
    "Codex CLIが--dangerously-skip-permissionsを拒否した場合に自動でフラグを無効化する",
    async () => {
      const tempDir = await Deno.makeTempDir();
      try {
        const workspaceManager = new WorkspaceManager(tempDir);
        await workspaceManager.initialize();

        const executor = new DangerouslySkipPermissionsFallbackExecutor();

        resetCodexCliCapabilityCacheForTests();
        recordDangerouslyBypassUnsupportedForTests();
        const repoPath = await Deno.makeTempDir();
        const gitInit = new Deno.Command("git", { args: ["init"], cwd: repoPath });
        await gitInit.output();

        try {
          const state: WorkerState = {
            workerName: "test-worker",
            threadId: "thread-id",
            devcontainerConfig: {
              useDevcontainer: false,
              useFallbackDevcontainer: false,
              hasDevcontainerFile: false,
              hasAnthropicsFeature: false,
              isStarted: false,
            },
            status: "active",
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
          };

          const worker = new Worker(
            state,
            workspaceManager,
            executor,
            true,
          );

          const repositoryResult = parseRepository("test/repo");
          if (repositoryResult.isOk()) {
            await worker.setRepository(repositoryResult.value, repoPath);
          }

          worker.setUseDevcontainer(false);
          Object.defineProperty(worker, "codexExecutor", {
            value: executor,
            writable: true,
            configurable: true,
          });

        const result = await worker.processMessage("テスト");
        assertEquals(result.isOk(), true);
        assertEquals(executor.attempts, 2);

        const firstArgs = executor.argsHistory[0];
        const secondArgs = executor.argsHistory[1];
        assertEquals(firstArgs.includes("--dangerously-skip-permissions"), true);
        assertEquals(secondArgs.includes("--dangerously-skip-permissions"), false);
      } finally {
        await Deno.remove(repoPath, { recursive: true });
        resetCodexCliCapabilityCacheForTests();
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      resetCodexCliCapabilityCacheForTests();
    }
  },
);
});

describe("Worker --dangerously-bypass フラグ自動再試行", () => {
  it(
    "Codex CLIが--dangerously-bypass-approvals-and-sandboxを拒否した場合に旧フラグへ切り替える",
    async () => {
      const tempDir = await Deno.makeTempDir();
      try {
        const workspaceManager = new WorkspaceManager(tempDir);
        await workspaceManager.initialize();

        const executor = new DangerouslyBypassFallbackExecutor();

        resetCodexCliCapabilityCacheForTests();
        const repoPath = await Deno.makeTempDir();
        const gitInit = new Deno.Command("git", { args: ["init"], cwd: repoPath });
        await gitInit.output();

        try {
          const state: WorkerState = {
            workerName: "test-worker",
            threadId: "thread-id",
            devcontainerConfig: {
              useDevcontainer: false,
              useFallbackDevcontainer: false,
              hasDevcontainerFile: false,
              hasAnthropicsFeature: false,
              isStarted: false,
            },
            status: "active",
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
          };

          const worker = new Worker(
            state,
            workspaceManager,
            executor,
            true,
          );

          const repositoryResult = parseRepository("test/repo");
          if (repositoryResult.isOk()) {
            await worker.setRepository(repositoryResult.value, repoPath);
          }

          worker.setUseDevcontainer(false);
          Object.defineProperty(worker, "codexExecutor", {
            value: executor,
            writable: true,
            configurable: true,
          });

          const result = await worker.processMessage("テスト");
          assertEquals(result.isOk(), true);
          assertEquals(executor.attempts, 2);

          const firstArgs = executor.argsHistory[0];
          const secondArgs = executor.argsHistory[1];
          assertEquals(firstArgs.includes("--dangerously-bypass-approvals-and-sandbox"), true);
          assertEquals(secondArgs.includes("--dangerously-bypass-approvals-and-sandbox"), false);
          assertEquals(secondArgs.includes("--dangerously-skip-permissions"), true);
        } finally {
          await Deno.remove(repoPath, { recursive: true });
          resetCodexCliCapabilityCacheForTests();
        }
      } finally {
        await Deno.remove(tempDir, { recursive: true });
      }
    },
  );
});

describe("Worker Codex CLI TTYフォールバック", () => {
  it(
    "Codex CLIがTTYを要求する場合にscript経由の実行へ切り替える",
    async () => {
      const tempDir = await Deno.makeTempDir();
      try {
        const workspaceManager = new WorkspaceManager(tempDir);
        await workspaceManager.initialize();

        const executor = new TtyFallbackExecutor();

        resetCodexCliCapabilityCacheForTests();
        const repoPath = await Deno.makeTempDir();
        const gitInit = new Deno.Command("git", { args: ["init"], cwd: repoPath });
        await gitInit.output();

        try {
          const state: WorkerState = {
            workerName: "test-worker",
            threadId: "thread-id",
            devcontainerConfig: {
              useDevcontainer: false,
              useFallbackDevcontainer: false,
              hasDevcontainerFile: false,
              hasAnthropicsFeature: false,
              isStarted: false,
            },
            status: "active",
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
          };

          const worker = new Worker(
            state,
            workspaceManager,
            executor,
            true,
          );

          const repositoryResult = parseRepository("test/repo");
          if (repositoryResult.isOk()) {
            await worker.setRepository(repositoryResult.value, repoPath);
          }

          worker.setUseDevcontainer(false);
          Object.defineProperty(worker, "codexExecutor", {
            value: executor,
            writable: true,
            configurable: true,
          });

          const result = await worker.processMessage("テスト");
          assertEquals(result.isOk(), true);
          assertEquals(executor.attempts, 2);
          assertEquals(executor.optionsHistory[0].usePty, false);
          assertEquals(executor.optionsHistory[1].usePty, true);
        } finally {
          await Deno.remove(repoPath, { recursive: true });
          resetCodexCliCapabilityCacheForTests();
        }
      } finally {
        await Deno.remove(tempDir, { recursive: true });
        resetCodexCliCapabilityCacheForTests();
      }
    },
  );
});

describe("Worker Codex CLI互換フラグの多段再試行", () => {
  it(
    "--json・--output-format・--verbose・--dangerously-skip-permissionsが順に非対応でも順次無効化して成功する",
    async () => {
      const tempDir = await Deno.makeTempDir();
      try {
        const workspaceManager = new WorkspaceManager(tempDir);
        await workspaceManager.initialize();

        const executor = new MultipleFlagFallbackExecutor();

        resetCodexCliCapabilityCacheForTests();
        const repoPath = await Deno.makeTempDir();
        const gitInit = new Deno.Command("git", { args: ["init"], cwd: repoPath });
        await gitInit.output();

        try {
          const state: WorkerState = {
            workerName: "test-worker",
            threadId: "thread-id",
            devcontainerConfig: {
              useDevcontainer: false,
              useFallbackDevcontainer: false,
              hasDevcontainerFile: false,
              hasAnthropicsFeature: false,
              isStarted: false,
            },
            status: "active",
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
          };

          const worker = new Worker(
            state,
            workspaceManager,
            executor,
            true,
          );

          const repositoryResult = parseRepository("test/repo");
          if (repositoryResult.isOk()) {
            await worker.setRepository(repositoryResult.value, repoPath);
          }

          worker.setUseDevcontainer(false);
          Object.defineProperty(worker, "codexExecutor", {
            value: executor,
            writable: true,
            configurable: true,
          });

          const result = await worker.processMessage("テスト");
          assertEquals(result.isOk(), true);
          assertEquals(executor.attempts, 5);

          const firstArgs = executor.argsHistory[0];
          const secondArgs = executor.argsHistory[1];
          const thirdArgs = executor.argsHistory[2];
          const fourthArgs = executor.argsHistory[3];
          const fifthArgs = executor.argsHistory[4];

          assertEquals(firstArgs.includes("exec"), true);
          assertEquals(firstArgs.includes("--json"), true);

          assertEquals(secondArgs.includes("exec"), false);
          assertEquals(secondArgs.includes("--output-format"), true);
          assertEquals(secondArgs.includes("--verbose"), true);
          assertEquals(secondArgs.includes("--dangerously-skip-permissions"), true);

          assertEquals(thirdArgs.includes("--output-format"), false);
          assertEquals(thirdArgs.includes("--verbose"), true);
          assertEquals(thirdArgs.includes("--dangerously-skip-permissions"), true);

          assertEquals(fourthArgs.includes("--verbose"), false);
          assertEquals(fourthArgs.includes("--dangerously-skip-permissions"), true);

          assertEquals(fifthArgs.includes("--dangerously-skip-permissions"), false);
        } finally {
          await Deno.remove(repoPath, { recursive: true });
        }
      } finally {
        await Deno.remove(tempDir, { recursive: true });
        resetCodexCliCapabilityCacheForTests();
      }
    },
  );
});


describe("Worker exec JSON agent message handling", () => {
  it("Codex execイベントからエージェントの応答を取り出す", async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      const workspaceManager = new WorkspaceManager(tempDir);
      await workspaceManager.initialize();

      const executor = new ExecJsonAgentMessageExecutor();
      const repoPath = await Deno.makeTempDir();
      const gitInit = new Deno.Command("git", { args: ["init"], cwd: repoPath });
      await gitInit.output();

      try {
        const state: WorkerState = {
          workerName: "test-worker",
          threadId: "thread-id",
          devcontainerConfig: {
            useDevcontainer: false,
            useFallbackDevcontainer: false,
            hasDevcontainerFile: false,
            hasAnthropicsFeature: false,
            isStarted: false,
          },
          status: "active",
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        };

        const worker = new Worker(
          state,
          workspaceManager,
          executor,
          true,
        );

        const repositoryResult = parseRepository("test/repo");
        if (repositoryResult.isOk()) {
          await worker.setRepository(repositoryResult.value, repoPath);
        }

        worker.setUseDevcontainer(false);

        const progressMessages: string[] = [];
        const result = await worker.processMessage(
          "このメッセージなんこめ？",
          async (content) => {
            progressMessages.push(content);
          },
        );

        assertEquals(result.isOk(), true);
        if (result.isOk()) {
          assertEquals(
            result.value,
            "ユーザーとして送ったメッセージはこれで2通目です。",
          );
        }

        assertEquals(
          progressMessages.some((message) =>
            message.includes("ユーザーとして送ったメッセージはこれで2通目です。")
          ),
          true,
        );
        assertEquals(state.sessionId, "session-exec-json");
      } finally {
        await Deno.remove(repoPath, { recursive: true });
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });
});
