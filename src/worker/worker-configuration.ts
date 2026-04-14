import { CODEX } from "../constants.ts";

export class WorkerConfiguration {
  constructor(private appendSystemPrompt?: string) {}

  buildCodexArgs(prompt: string, sessionId?: string | null): string[] {
    const args: string[] = [...CODEX.BASE_ARGS];

    if (this.appendSystemPrompt) {
      args.push("--append-system-prompt", this.appendSystemPrompt);
    }

    if (sessionId) {
      args.push("resume", sessionId);
    }

    args.push(prompt);
    return args;
  }
}
