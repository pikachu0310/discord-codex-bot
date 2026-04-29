import { CODEX } from "../constants.ts";

export class WorkerConfiguration {
  constructor(private appendSystemPrompt?: string) {}

  buildCodexArgs(
    prompt: string,
    sessionId?: string | null,
    imagePaths: readonly string[] = [],
    outputLastMessagePath?: string | null,
  ): string[] {
    const args: string[] = [...CODEX.BASE_ARGS];

    if (this.appendSystemPrompt) {
      args.push("--append-system-prompt", this.appendSystemPrompt);
    }

    if (sessionId) {
      args.push("resume");
      this.appendOutputLastMessageArg(args, outputLastMessagePath);
      this.appendImageArgs(args, imagePaths);
      this.appendOptionTerminator(args, imagePaths);
      args.push(sessionId, prompt);
      return args;
    }

    this.appendOutputLastMessageArg(args, outputLastMessagePath);
    this.appendImageArgs(args, imagePaths);
    this.appendOptionTerminator(args, imagePaths);
    args.push(prompt);
    return args;
  }

  private appendOutputLastMessageArg(
    args: string[],
    outputLastMessagePath?: string | null,
  ): void {
    if (outputLastMessagePath) {
      args.push("--output-last-message", outputLastMessagePath);
    }
  }

  private appendImageArgs(args: string[], imagePaths: readonly string[]): void {
    for (const path of imagePaths) {
      args.push("--image", path);
    }
  }

  private appendOptionTerminator(
    args: string[],
    imagePaths: readonly string[],
  ): void {
    if (imagePaths.length > 0) {
      args.push("--");
    }
  }
}
