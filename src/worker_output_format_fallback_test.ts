import { assertEquals } from "https://deno.land/std@0.214.0/assert/mod.ts";
import { describe, it } from "https://deno.land/std@0.214.0/testing/bdd.ts";
import { Worker } from "./worker/worker.ts";
import { CodexCommandExecutor } from "./worker/codex-executor.ts";
import { resetOutputFormatDetectionForTests } from "./worker/codex-cli-capabilities.ts";
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

class VerboseFallbackExecutor implements CodexCommandExecutor {
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
  ) {
    this.attempts++;
    this.argsHistory.push([...args]);
    const encoder = new TextEncoder();

    if (this.attempts === 1) {
      const stderrMessage =
        "error: unexpected argument '--output-format' found\n";
      return ok({ code: 2, stderr: encoder.encode(stderrMessage) });
    }

    if (this.attempts === 2) {
      const stderrMessage = "error: unexpected argument '--verbose' found\n";
      return ok({ code: 2, stderr: encoder.encode(stderrMessage) });
    }

    if (this.attempts === 3) {
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

describe("Worker --output-format フラグ自動再試行", () => {
  it("Codex CLIが--output-formatを拒否した場合に自動でフラグを無効化する", async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      const workspaceManager = new WorkspaceManager(tempDir);
      await workspaceManager.initialize();

      const executor = new OutputFormatFallbackExecutor();

      resetOutputFormatDetectionForTests();
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
      resetOutputFormatDetectionForTests();
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

      resetOutputFormatDetectionForTests();
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
      resetOutputFormatDetectionForTests();
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

        resetOutputFormatDetectionForTests();
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
          resetOutputFormatDetectionForTests();
        }
      } finally {
        await Deno.remove(tempDir, { recursive: true });
      }
    },
  );
});

describe("Worker Codex CLI互換フラグの多段再試行", () => {
  it(
    "--output-format・--verbose・--dangerously-skip-permissionsが順に非対応でも順次無効化して成功する",
    async () => {
      const tempDir = await Deno.makeTempDir();
      try {
        const workspaceManager = new WorkspaceManager(tempDir);
        await workspaceManager.initialize();

        const executor = new MultipleFlagFallbackExecutor();

        resetOutputFormatDetectionForTests();
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
          assertEquals(executor.attempts, 4);

          const firstArgs = executor.argsHistory[0];
          const secondArgs = executor.argsHistory[1];
          const thirdArgs = executor.argsHistory[2];
          const fourthArgs = executor.argsHistory[3];

          assertEquals(firstArgs.includes("--output-format"), true);
          assertEquals(firstArgs.includes("--verbose"), true);
          assertEquals(
            firstArgs.includes("--dangerously-skip-permissions"),
            true,
          );

          assertEquals(secondArgs.includes("--output-format"), false);
          assertEquals(secondArgs.includes("--verbose"), true);
          assertEquals(
            secondArgs.includes("--dangerously-skip-permissions"),
            true,
          );

          assertEquals(thirdArgs.includes("--output-format"), false);
          assertEquals(thirdArgs.includes("--verbose"), false);
          assertEquals(
            thirdArgs.includes("--dangerously-skip-permissions"),
            true,
          );

          assertEquals(fourthArgs.includes("--output-format"), false);
          assertEquals(fourthArgs.includes("--verbose"), false);
          assertEquals(
            fourthArgs.includes("--dangerously-skip-permissions"),
            false,
          );
        } finally {
          await Deno.remove(repoPath, { recursive: true });
        }
      } finally {
        await Deno.remove(tempDir, { recursive: true });
        resetOutputFormatDetectionForTests();
      }
    },
  );
});
