import type { CodexExecutionOptions } from "./codex-executor.ts";

export class WorkerConfiguration {
  constructor(private appendSystemPrompt?: string) {}

  buildExecutionOptions(
    prompt: string,
    cwd: string,
    sessionId?: string | null,
    imagePaths: readonly string[] = [],
  ): CodexExecutionOptions {
    return {
      prompt,
      cwd,
      sessionId,
      imagePaths,
      ...(this.appendSystemPrompt
        ? { developerInstructions: this.appendSystemPrompt }
        : {}),
    };
  }
}
