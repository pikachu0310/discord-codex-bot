import { err, ok, Result } from "neverthrow";
import { CODEX } from "./constants.ts";
import { CodexStreamProcessor } from "./worker/codex-stream-processor.ts";

function sanitizeThreadName(name: string): string {
  const cleaned = name
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_~|<>]/g, "")
    .trim();

  if (!cleaned) {
    return "";
  }

  if (cleaned.length <= CODEX.THREAD_NAME_MAX_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, CODEX.THREAD_NAME_MAX_LENGTH);
}

function fallbackThreadName(firstMessage: string): string {
  const line = firstMessage
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0) ?? "";
  return sanitizeThreadName(line);
}

export async function generateThreadNameWithCodex(
  firstMessage: string,
  repositoryName?: string,
  cwd?: string,
): Promise<Result<string, string>> {
  const prompt = [
    "あなたはDiscordスレッド名を生成するアシスタントです。",
    "以下のユーザー要求を30文字以内の日本語タイトルに要約してください。",
    "出力はタイトル文字列のみ。説明文や引用符は禁止。",
    repositoryName ? `参考リポジトリ: ${repositoryName}` : "",
    "",
    `ユーザー要求: ${firstMessage}`,
  ].filter(Boolean).join("\n");

  const args = [...CODEX.BASE_ARGS, prompt];
  const command = new Deno.Command(CODEX.COMMAND, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });

  try {
    const process = command.spawn();
    const stdout = await new Response(process.stdout).text();
    const { code, stderr } = await process.output();
    if (code !== 0) {
      const stderrText = new TextDecoder().decode(stderr);
      const fallback = fallbackThreadName(firstMessage);
      if (fallback) return ok(fallback);
      return err(stderrText || "thread name generation failed");
    }

    const processor = new CodexStreamProcessor();
    let candidate = "";
    for (const line of stdout.split("\n")) {
      const parsed = processor.parseLine(line);
      if (parsed.finalText) {
        candidate = parsed.finalText;
      } else if (parsed.text && !candidate) {
        candidate = parsed.text;
      }
    }

    const finalName = sanitizeThreadName(candidate);
    if (!finalName) {
      const fallback = fallbackThreadName(firstMessage);
      if (fallback) return ok(fallback);
      return err("empty thread name");
    }
    return ok(finalName);
  } catch (error) {
    const fallback = fallbackThreadName(firstMessage);
    if (fallback) return ok(fallback);
    return err((error as Error).message);
  }
}
