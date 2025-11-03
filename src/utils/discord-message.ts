import { DISCORD } from "../constants.ts";

const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;

function splitTextSegment(
  text: string,
  chunkSize: number,
): string[] {
  const pieces: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
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

    if (slice.length > 0) {
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

  const firstLineEnd = segment.indexOf("\n");
  const header = firstLineEnd !== -1 ? segment.slice(0, firstLineEnd) : "```";
  const closingIndex = segment.lastIndexOf("```");
  const body = closingIndex !== -1
    ? segment.slice(firstLineEnd + 1, closingIndex)
    : segment.slice(firstLineEnd + 1);

  const perChunkLimit = Math.max(
    1,
    chunkSize - (header.length + 1 + 3), // header + newline + closing ```
  );

  if (body.length <= perChunkLimit) {
    const bodyWithNewline = body.endsWith("\n") ? body : `${body}\n`;
    pieces.push(`${header}\n${bodyWithNewline}\`\`\``);
    return pieces;
  }

  let start = 0;
  while (start < body.length) {
    const end = Math.min(start + perChunkLimit, body.length);
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

    pieces.push(`${header}\n${slice}\`\`\``);
  }

  return pieces;
}

export function splitIntoDiscordChunks(
  content: string,
  chunkSize: number = DISCORD.MESSAGE_CHUNK_LENGTH,
): string[] {
  if (content.length === 0) {
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
