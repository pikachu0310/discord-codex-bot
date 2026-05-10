const LOCATION_PREVIEW_LENGTH = 10;
const MESSAGE_PREVIEW_LENGTH = 20;

export function createLocationPreview(name: string): string {
  return name
    .slice(0, LOCATION_PREVIEW_LENGTH)
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

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
  return `${createLocationPreview(serverName)}/${
    createLocationPreview(channelName)
  }/${createLocationPreview(threadName)}「${createMessagePreview(content)}」`;
}
