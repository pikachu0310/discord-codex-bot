import { CODEX } from "../constants.ts";

export class WorkerConfiguration {
  constructor(private appendSystemPrompt?: string) {}

  buildCodexArgs(
    prompt: string,
    sessionId?: string | null,
    imagePaths: readonly string[] = [],
  ): string[] {
    const args: string[] = [...CODEX.BASE_ARGS];

    if (this.appendSystemPrompt) {
      args.push("--append-system-prompt", this.appendSystemPrompt);
    }

    if (sessionId) {
      args.push("resume");
      this.appendImageArgs(args, imagePaths);
      args.push(sessionId, prompt);
      return args;
    }

    this.appendImageArgs(args, imagePaths);
    args.push(prompt);
    return args;
  }

  private appendImageArgs(args: string[], imagePaths: readonly string[]): void {
    for (const path of imagePaths) {
      args.push("--image", path);
    }
  }
}
