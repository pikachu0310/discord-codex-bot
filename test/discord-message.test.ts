import { assertEquals } from "std/assert/mod.ts";
import { Collection, MessageType } from "discord.js";
import type { Message } from "discord.js";
import {
  shouldProcessDiscordMessage,
  splitIntoDiscordChunks,
} from "../src/utils/discord-message.ts";

function incomingMessage(
  type: MessageType,
  content: string,
  bot = false,
  attachmentCount = 0,
): Parameters<typeof shouldProcessDiscordMessage>[0] {
  return {
    author: { bot } as Message["author"],
    system: type !== MessageType.Default && type !== MessageType.Reply,
    content,
    attachments: new Collection(
      Array.from(
        { length: attachmentCount },
        (_, i) =>
          [
            String(i),
            {} as Message["attachments"] extends Collection<string, infer T> ? T
              : never,
          ] as const,
      ),
    ),
  };
}

Deno.test("shouldProcessDiscordMessage: メンバー削除・追加などの通知を無視する", () => {
  for (
    const type of [
      MessageType.RecipientRemove,
      MessageType.RecipientAdd,
      MessageType.ThreadCreated,
      MessageType.ChannelPinnedMessage,
    ]
  ) {
    assertEquals(shouldProcessDiscordMessage(incomingMessage(type, "")), false);
    assertEquals(
      shouldProcessDiscordMessage(incomingMessage(type, "通知の本文")),
      false,
    );
  }
});

Deno.test("shouldProcessDiscordMessage: 既存スレッドでも通常発言・返信・添付を処理する", () => {
  assertEquals(
    shouldProcessDiscordMessage(
      incomingMessage(MessageType.RecipientRemove, ""),
    ),
    false,
  );
  for (const type of [MessageType.Default, MessageType.Reply]) {
    assertEquals(
      shouldProcessDiscordMessage(incomingMessage(type, "続けて")),
      true,
    );
    assertEquals(
      shouldProcessDiscordMessage(incomingMessage(type, "", false, 1)),
      true,
    );
    assertEquals(
      shouldProcessDiscordMessage(incomingMessage(type, " \n ")),
      false,
    );
    assertEquals(
      shouldProcessDiscordMessage(incomingMessage(type, "!stop")),
      false,
    );
    assertEquals(
      shouldProcessDiscordMessage(incomingMessage(type, "応答", true)),
      false,
    );
  }
});

Deno.test("splitIntoDiscordChunks: 空白だけの入力は送信チャンクにしない", () => {
  assertEquals(splitIntoDiscordChunks(" \n\t "), []);
});

Deno.test("splitIntoDiscordChunks: コードブロック間の空白だけの区間を除外する", () => {
  const chunks = splitIntoDiscordChunks(
    "```ts\nconst a = 1;\n```\n\n```ts\nconst b = 2;\n```",
    24,
  );

  assertEquals(chunks, [
    "```ts\nconst a = 1;\n```",
    "```ts\nconst b = 2;\n```",
  ]);
});
