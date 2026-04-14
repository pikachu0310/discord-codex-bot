export const DISCORD = {
  MAX_MESSAGE_LENGTH: 2000,
  MESSAGE_CHUNK_LENGTH: 1500,
  PRESENCE_UPDATE_INTERVAL_MS: 10 * 60 * 1000,
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
  STATUS_USAGE_BASE_TOKENS: 100000,
} as const;

export const PROCESS = {
  TERMINATION_TIMEOUT_MS: 5000,
} as const;
