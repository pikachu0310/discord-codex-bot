export const DISCORD = {
  MAX_MESSAGE_LENGTH: 2000,
  MESSAGE_CHUNK_LENGTH: 1500,
} as const;

export const CODEX = {
  COMMAND: "codex",
  BASE_ARGS: [
    "--search",
    "exec",
    "--json",
    "--color",
    "never",
    "--dangerously-bypass-approvals-and-sandbox",
  ] as const,
  THREAD_NAME_MAX_LENGTH: 30,
  THREAD_METADATA_MODEL: "gpt-5.6-luna",
} as const;

export const PROCESS = {
  TERMINATION_TIMEOUT_MS: 5000,
} as const;

export const MESSAGES = {
  INTERRUPTED: "⛔ Codex実行を中断しました。",
  ANSWER_ACCEPTED: "✅ 回答を受け付けました。作業を続けます。",
  INPUT_ACCEPTED: "📨 実行中のCodexにメッセージを届けました。",
  RATE_LIMIT: "Codexのレート制限に達しました。時間を置いて再実行してください。",
  NO_FINAL_RESPONSE: "Codex からの応答を取得できませんでした。",
} as const;
