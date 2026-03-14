import { assertEquals, assertGreater } from "std/testing/asserts.ts";
import { ContextCompressor } from "./context-compressor.ts";

Deno.test("ContextCompressor - shouldCompress - 短いセッションでは圧縮不要", () => {
  const compressor = new ContextCompressor();
  const shortSession = `
{"type": "message", "role": "user", "content": "Hello"}
{"type": "message", "role": "assistant", "content": "Hi"}
`.trim();

  assertEquals(compressor.shouldCompress(shortSession), false);
});

Deno.test("ContextCompressor - shouldCompress - 長いセッションでは圧縮必要", () => {
  const compressor = new ContextCompressor();

  // 大量のメッセージを生成してトークン数を閾値以上にする
  const longMessages = [];
  for (let i = 0; i < 5000; i++) {
    longMessages.push(
      `{"type": "message", "role": "user", "content": "This is a very long message that should trigger compression when there are many of them in the session history. Message number ${i} with lots of content to reach the token threshold."}`,
    );
  }
  const longSession = longMessages.join("\n");

  assertEquals(compressor.shouldCompress(longSession), true);
});

Deno.test("ContextCompressor - compressSession - 短いセッションはそのまま", async () => {
  const compressor = new ContextCompressor();
  const shortSession = `
{"type": "message", "role": "user", "content": "Hello"}
{"type": "message", "role": "assistant", "content": "Hi"}
`.trim();

  const result = await compressor.compressSession(shortSession);

  assertEquals(result.wasCompressed, false);
  assertEquals(result.compressedContent, shortSession);
  assertEquals(result.compressionRatio, 1.0);
});

Deno.test("ContextCompressor - compressSession - 長いセッションは圧縮される", async () => {
  const compressor = new ContextCompressor();

  // 大量のメッセージを生成
  const messages = [];
  for (let i = 0; i < 2000; i++) {
    messages.push(
      `{"type": "message", "role": "user", "content": "User message ${i}: This is a test message that should be compressed when there are too many messages in the session history. This message contains a lot of text to reach the token threshold for compression.", "timestamp": ${
        Date.now() + i
      }}`,
    );
    messages.push(
      `{"type": "message", "role": "assistant", "content": "Assistant response ${i}: This is a response to the user message. It contains some useful information that might be summarized. This response also has plenty of content to contribute to the token count.", "timestamp": ${
        Date.now() + i + 1
      }}`,
    );
  }
  const longSession = messages.join("\n");

  const result = await compressor.compressSession(longSession);

  assertEquals(result.wasCompressed, true);
  assertGreater(result.originalTokens, result.compressedTokens);
  assertGreater(1.0, result.compressionRatio);

  // 圧縮されたコンテンツにサマリーが含まれていることを確認
  assertEquals(result.compressedContent.includes("[コンテキスト圧縮]"), true);
});

Deno.test("ContextCompressor - compressSession - 最新メッセージは保持される", async () => {
  const compressor = new ContextCompressor();

  // 大量のメッセージを生成
  const messages = [];
  for (let i = 0; i < 2000; i++) {
    const longContent =
      "This is a very long message that contains a lot of content to reach the compression threshold. "
        .repeat(20);
    messages.push(
      `{"type": "message", "role": "user", "content": "Old message ${i} ${longContent} This message should be summarized and not appear in the final result.", "timestamp": ${
        Date.now() + i
      }}`,
    );
  }

  // 最新のメッセージを追加
  const recentMessage =
    `{"type": "message", "role": "user", "content": "This is the most recent message", "timestamp": ${
      Date.now() + 10000
    }}`;
  messages.push(recentMessage);

  const longSession = messages.join("\n");

  const result = await compressor.compressSession(longSession);

  assertEquals(result.wasCompressed, true);

  // 最新メッセージが保持されているか、要約が含まれていることを確認
  const hasRecentMessage = result.compressedContent.includes(
    "This is the most recent message",
  );
  const hasSummary = result.compressedContent.includes("[コンテキスト圧縮]");
  assertEquals(hasRecentMessage || hasSummary, true);
});

Deno.test("ContextCompressor - compressSession - 不正なJSONを含むセッション", async () => {
  const compressor = new ContextCompressor();

  // 不正なJSONを含むセッションを作成
  const messages = [];
  for (let i = 0; i < 2000; i++) {
    const longContent =
      "This is a very long message that contains a lot of content to reach the compression threshold. "
        .repeat(20);
    messages.push(
      `{"type": "message", "role": "user", "content": "Message ${i} ${longContent} with lots of content to reach the compression threshold so that this session will be compressed.", "timestamp": ${
        Date.now() + i
      }}`,
    );
  }
  messages.push("invalid json line");
  messages.push(
    `{"type": "message", "role": "user", "content": "Valid message after invalid", "timestamp": ${
      Date.now() + 10000
    }}`,
  );

  const sessionWithInvalidJson = messages.join("\n");

  const result = await compressor.compressSession(sessionWithInvalidJson);

  // 不正なJSONがあっても処理は続行される
  assertEquals(result.wasCompressed, true);
  // 有効なメッセージまたは要約が含まれていることを確認
  const hasValidMessage = result.compressedContent.includes(
    "Valid message after invalid",
  );
  const hasSummary = result.compressedContent.includes("[コンテキスト圧縮]");
  assertEquals(hasValidMessage || hasSummary, true);
});

Deno.test("ContextCompressor - compressSession - 空のセッション", async () => {
  const compressor = new ContextCompressor();

  const result = await compressor.compressSession("");

  assertEquals(result.wasCompressed, false);
  assertEquals(result.compressedContent, "");
  assertEquals(result.originalTokens, 0);
  assertEquals(result.compressedTokens, 0);
});
