type DiscordApiLikeError = {
  code?: unknown;
  message?: unknown;
};

function isDiscordApiLikeError(error: unknown): error is DiscordApiLikeError {
  return typeof error === "object" && error !== null;
}

export function formatStartCommandErrorForUser(error: unknown): string | null {
  if (!isDiscordApiLikeError(error)) {
    return null;
  }

  const code = error.code;
  if (code === 50001) {
    return "チャンネルへのアクセス権限が足りません。Bot にこのチャンネルを閲覧・送信できる権限を付与してください。";
  }

  if (code === 50013) {
    return "Bot に必要な権限が足りません。チャンネル権限を確認してください。";
  }

  if (code === 10003) {
    return "対象のチャンネルを取得できませんでした。チャンネルが削除されていないか確認してください。";
  }

  if (typeof error.message === "string" && error.message.trim().length > 0) {
    return `start コマンドに失敗しました: ${error.message}`;
  }

  return null;
}
