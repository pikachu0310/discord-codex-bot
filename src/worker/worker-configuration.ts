import { CODEX } from "../constants.ts";

export class WorkerConfiguration {
  constructor(
    private verbose = false,
    private appendSystemPrompt?: string,
  ) {}

  isVerbose(): boolean {
    return this.verbose;
  }

  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  buildCodexArgs(prompt: string, sessionId?: string | null): string[] {
    const args: string[] = [...CODEX.BASE_ARGS];

    if (this.verbose) {
      args.push("--verbose");
    }

    if (this.appendSystemPrompt) {
      args.push("--append-system-prompt", this.appendSystemPrompt);
    }

    if (sessionId) {
      args.push("resume", sessionId);
    }

    args.push(prompt);
    return args;
  }

  logVerbose(
    workerName: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (!this.verbose) return;
    const prefix = `[${new Date().toISOString()}] [Worker:${workerName}]`;
    console.log(`${prefix} ${message}`);
    if (metadata) {
      console.log(`${prefix} data:`, metadata);
    }
  }
}
