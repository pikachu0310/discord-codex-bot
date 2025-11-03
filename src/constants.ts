/**
 * アプリケーション全体で使用する定数を定義
 */

// レート制限関連の定数
export const RATE_LIMIT = {
  AUTO_RESUME_DELAY_MS: 300_000, // 5分
} as const;

// Discord関連の定数
export const DISCORD = {
  MAX_MESSAGE_LENGTH: 2000,
  MESSAGE_CHUNK_LENGTH: 1500,
} as const;

// メッセージフォーマット関連の定数
export const FORMATTING = {
  SHORT_RESULT_THRESHOLD: 500,
  LONG_RESULT_THRESHOLD: 2000,
} as const;

// DevContainer関連の定数
export const DEVCONTAINER = {
  MAX_LOG_LINES: 30,
  PROGRESS_UPDATE_INTERVAL_MS: 2000,
  PROGRESS_NOTIFY_INTERVAL_MS: 1000,
} as const;

// Git関連の定数
export const GIT = {
  DEFAULT_BRANCH: "main",
  BOT_USER_NAME: "Discord Bot",
  BOT_USER_EMAIL: "bot@example.com",
} as const;

// Gemini API関連の定数
export const GEMINI = {
  MODEL_NAME: "gemini-2.5-flash-preview-05-20",
  MAX_OUTPUT_TOKENS: 10000,
  TEMPERATURE: 0.3,
} as const;

// PLaMo Translator関連の定数
export const PLAMO_TRANSLATOR = {
  TEMPERATURE: 0.1,
  MAX_TOKENS: 2048,
  TIMEOUT_MS: 5000,
} as const;

// プロセス管理関連の定数
export const PROCESS = {
  TERMINATION_TIMEOUT_MS: 5000, // プロセス終了を待つタイムアウト時間（5秒）
} as const;

// Codex CLI関連の定数
export const CODEX_CLI = {
  // Codex CLIのデフォルト最大出力トークン数
  // Codex Code公式ドキュメントには明示的なデフォルト値の記載がないため、
  // MCPツールのデフォルト制限値（25,000）を参考にした適切な値を設定
  DEFAULT_MAX_OUTPUT_TOKENS: 25000,
} as const;

// コンテキスト圧縮関連の定数
export const CONTEXT_COMPRESSION = {
  // 自動圧縮を開始するトークン数の閾値
  AUTO_COMPRESS_THRESHOLD: 180000, // Codex 3.5の200K上限の90%
  // 圧縮後の目標トークン数
  COMPRESSION_TARGET_TOKENS: 100000, // 圧縮後は100Kトークン程度に削減
  // 圧縮時に保持する最新メッセージ数
  KEEP_RECENT_MESSAGES: 10,
} as const;
