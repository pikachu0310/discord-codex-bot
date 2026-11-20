import {
  DEFAULT_MODEL_PRESET,
  MODEL_PRESETS,
  type ModelPresetId,
} from "./model-presets.ts";
import { err, ok, Result } from "neverthrow";
import { CODEX } from "./constants.ts";
import { CodexStreamProcessor } from "./worker/codex-stream-processor.ts";

const BRANCH_PREFIXES = new Set([
  "feat",
  "fix",
  "docs",
  "refactor",
  "test",
  "chore",
  "perf",
  "build",
  "ci",
]);
const MAX_GENERATION_ATTEMPTS = 3;

export interface ConversationNames {
  threadName: string;
  branchName: string;
}

function sanitizeThreadName(name: string): string {
  return name
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_~|<>]/g, "")
    .trim()
    .slice(0, CODEX.THREAD_NAME_MAX_LENGTH);
}

export function fallbackThreadName(firstMessage: string): string {
  const line = firstMessage
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean) ?? "";
  return sanitizeThreadName(line);
}

function sanitizeBranchSlug(slug: string): string {
  const normalized = slug
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return [...normalized].slice(0, 48).join("").replace(/-+$/g, "");
}

export function parseConversationNames(
  output: string,
): Result<ConversationNames, string> {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return err("metadata is not JSON");

  try {
    const value = JSON.parse(output.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
    if (
      typeof value.threadName !== "string" ||
      typeof value.branchPrefix !== "string" ||
      typeof value.branchSlug !== "string"
    ) {
      return err("metadata fields are missing");
    }

    const threadName = sanitizeThreadName(value.threadName);
    const prefix = value.branchPrefix.trim().toLowerCase();
    const slug = sanitizeBranchSlug(value.branchSlug);
    if (!threadName || !BRANCH_PREFIXES.has(prefix) || !slug) {
      return err("metadata fields are invalid");
    }
    return ok({ threadName, branchName: `${prefix}/${slug}` });
  } catch (error) {
    return err((error as Error).message);
  }
}

export async function generateConversationNamesWithCodex(
  firstMessage: string,
  firstResponse: string,
  repositoryName?: string,
  cwd?: string,
  preset: ModelPresetId = DEFAULT_MODEL_PRESET,
  namingInstructions?: string,
  onFailure?: (error: string, attempt: number) => void | Promise<void>,
): Promise<Result<ConversationNames, string>> {
  const prompt = [
    "Discord上の開発会話を要約し、名前を決めてください。",
    "命名に関する指示:",
    namingInstructions?.trim() ||
    "threadNameは日本語、branchSlugは英語で作成してください。",
    "以下の出力制約は必ず守ってください。",
    "JSON以外は出力しないでください。",
    '{"threadName":"30文字以内の明確なタイトル","branchPrefix":"feat|fix|docs|refactor|test|chore|perf|build|ci","branchSlug":"スラッシュ以降の短いタイトル"}',
    "branchPrefixとbranchSlugから作業目的が一目で分かるようにしてください。",
    repositoryName ? `リポジトリ: ${repositoryName}` : "",
    "",
    `ユーザー:\n${firstMessage}`,
    "",
    `Codex:\n${firstResponse}`,
  ].filter(Boolean).join("\n");

  const command = new Deno.Command(CODEX.COMMAND, {
    args: [
      "exec",
      "--json",
      "--color",
      "never",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--config",
      `model_reasoning_effort="${MODEL_PRESETS[preset].effort}"`,
      "--model",
      MODEL_PRESETS[preset].model,
      prompt,
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });

  let lastError = "metadata generation failed";
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    try {
      const { code, stdout, stderr } = await command.output();
      if (code !== 0) {
        lastError = new TextDecoder().decode(stderr) || lastError;
      } else {
        const processor = new CodexStreamProcessor();
        let candidate = "";
        for (const line of new TextDecoder().decode(stdout).split("\n")) {
          const parsed = processor.parseLine(line);
          if (parsed.finalText) candidate = parsed.finalText;
          else if (parsed.text && !candidate) candidate = parsed.text;
        }
        const parsed = parseConversationNames(candidate);
        if (parsed.isOk()) return parsed;
        lastError = parsed.error;
      }
    } catch (error) {
      lastError = (error as Error).message;
    }
    await onFailure?.(lastError, attempt);
  }
  return err(lastError);
}
