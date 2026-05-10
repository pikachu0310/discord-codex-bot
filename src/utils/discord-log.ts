const MESSAGE_PREVIEW_LENGTH = 20;

export function createMessagePreview(content: string): string {
  return content
    .slice(0, MESSAGE_PREVIEW_LENGTH)
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

export function formatDiscordSendLog(
  serverName: string,
  channelName: string,
  threadName: string,
  content: string,
): string {
  return `${serverName}/${channelName}/${threadName}「${
    createMessagePreview(content)
  }」`;
}
