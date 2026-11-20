import { DISCORD } from "../constants.ts";

const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;

function isSendableDiscordContent(content: string): boolean {
  return content.trim().length > 0;
}

function chunkEnd(text: string, start: number, limit: number): number {
  const end = Math.min(start + limit, text.length);
  const next = text.charCodeAt(end);
  return next >= 0xdc00 && next <= 0xdfff && end > start + 1 ? end - 1 : end;
}

function splitTextSegment(
  text: string,
  chunkSize: number,
): string[] {
  const pieces: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = chunkEnd(text, start, chunkSize);
    let slice = text.slice(start, end);

    if (end < text.length) {
      // 優先的に改行やスペースで区切る
      const newlineIndex = slice.lastIndexOf("\n");
      const spaceIndex = slice.lastIndexOf(" ");
      const splitIndex = Math.max(newlineIndex, spaceIndex);

      if (splitIndex > -1 && splitIndex > slice.length * 0.5) {
        slice = text.slice(start, start + splitIndex + 1);
        start += splitIndex + 1;
      } else {
        start = end;
      }
    } else {
      start = end;
    }

    if (isSendableDiscordContent(slice)) {
      pieces.push(slice);
    }
  }

  return pieces;
}

function splitCodeBlockSegment(
  segment: string,
  chunkSize: number,
): string[] {
  const pieces: string[] = [];

  if (segment.length <= chunkSize) return [segment];
  const closingIndex = segment.lastIndexOf("```");
  if (closingIndex < 3 || closingIndex !== segment.length - 3) {
    return splitTextSegment(segment, chunkSize);
  }
  const firstLineEnd = segment.indexOf("\n");
  const header = firstLineEnd === -1 ? "```" : segment.slice(0, firstLineEnd);
  const body = segment.slice(
    firstLineEnd === -1 ? 3 : firstLineEnd + 1,
    closingIndex,
  );
  // Reserve both surrounding newlines as well as the closing fence.
  const perChunkLimit = chunkSize - header.length - 5;
  if (perChunkLimit < 2) return splitTextSegment(segment, chunkSize);

  let start = 0;
  while (start < body.length) {
    const end = chunkEnd(body, start, perChunkLimit);
    let slice = body.slice(start, end);

    if (end < body.length) {
      const newlineIndex = slice.lastIndexOf("\n");
      if (newlineIndex > -1 && newlineIndex > slice.length * 0.5) {
        slice = body.slice(start, start + newlineIndex + 1);
        start += newlineIndex + 1;
      } else {
        start = end;
      }
    } else {
      start = end;
    }

    if (!slice.endsWith("\n")) {
      slice = `${slice}\n`;
    }

    const chunk = `${header}\n${slice}\`\`\``;
    if (isSendableDiscordContent(chunk)) {
      pieces.push(chunk);
    }
  }

  return pieces;
}

export function splitIntoDiscordChunks(
  content: string,
  chunkSize: number = DISCORD.MESSAGE_CHUNK_LENGTH,
): string[] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 2) {
    throw new RangeError("chunkSize must be at least 2");
  }
  if (!isSendableDiscordContent(content)) {
    return [];
  }

  if (content.length <= chunkSize) {
    return [content];
  }

  const segments: string[] = [];
  let lastIndex = 0;
  for (const match of content.matchAll(CODE_BLOCK_REGEX)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push(content.slice(lastIndex, index));
    }
    segments.push(match[0]);
    lastIndex = index + match[0].length;
  }

  if (lastIndex < content.length) {
    segments.push(content.slice(lastIndex));
  }

  const chunks: string[] = [];

  for (const segment of segments) {
    if (segment.startsWith("```")) {
      const codeChunks = splitCodeBlockSegment(segment, chunkSize);
      chunks.push(...codeChunks);
    } else {
      const textChunks = splitTextSegment(segment, chunkSize);
      chunks.push(...textChunks);
    }
  }

  return chunks;
}
