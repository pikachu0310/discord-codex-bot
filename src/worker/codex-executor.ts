import { err, ok, Result } from "neverthrow";
import { CODEX } from "../constants.ts";
import type { CodexExecutorError } from "./types.ts";

export interface CodexCommandExecutor {
  executeStreaming(
    args: string[],
    cwd: string,
    onData: (data: Uint8Array) => void,
    abortSignal?: AbortSignal,
    onProcessStart?: (childProcess: Deno.ChildProcess) => void,
  ): Promise<Result<{ code: number; stderr: Uint8Array }, CodexExecutorError>>;
}

export class DefaultCodexCommandExecutor implements CodexCommandExecutor {
  constructor(private readonly verbose = false) {}

  async executeStreaming(
    args: string[],
    cwd: string,
    onData: (data: Uint8Array) => void,
    abortSignal?: AbortSignal,
    onProcessStart?: (childProcess: Deno.ChildProcess) => void,
  ): Promise<Result<{ code: number; stderr: Uint8Array }, CodexExecutorError>> {
    try {
      if (this.verbose) {
        console.log(
          `[${new Date().toISOString()}] [CodexExecutor] run ${CODEX.COMMAND} ${
            JSON.stringify(args)
          } @ ${cwd}`,
        );
      }

      const command = new Deno.Command(CODEX.COMMAND, {
        args,
        cwd,
        stdout: "piped",
        stderr: "piped",
        signal: abortSignal,
      });
      const process = command.spawn();
      onProcessStart?.(process);

      const stderrChunks: Uint8Array[] = [];
      const stdoutReader = process.stdout.getReader();
      const stderrReader = process.stderr.getReader();

      const stdoutPromise = (async () => {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          if (value) onData(value);
        }
      })();

      const stderrPromise = (async () => {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          if (value) stderrChunks.push(value);
        }
      })();

      const [status] = await Promise.all([
        process.status,
        stdoutPromise,
        stderrPromise,
      ]);
      stdoutReader.releaseLock();
      stderrReader.releaseLock();

      const stderrLength = stderrChunks.reduce(
        (sum, chunk) => sum + chunk.length,
        0,
      );
      const stderr = new Uint8Array(stderrLength);
      let offset = 0;
      for (const chunk of stderrChunks) {
        stderr.set(chunk, offset);
        offset += chunk.length;
      }

      return ok({
        code: status.code,
        stderr,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return err({
          type: "STREAM_PROCESSING_ERROR",
          error: "実行が中断されました",
        });
      }
      return err({
        type: "STREAM_PROCESSING_ERROR",
        error: (error as Error).message,
      });
    }
  }
}
