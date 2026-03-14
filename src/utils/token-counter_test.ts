import { assertEquals } from "std/testing/asserts.ts";
import {
  estimateTokenCount,
  estimateTokenCountFromArray,
  estimateTokenCountFromSession,
} from "./token-counter.ts";

Deno.test("estimateTokenCount - 基本的なテキストのトークン数推定", () => {
  // 英語テキストのテスト
  assertEquals(estimateTokenCount("Hello world"), 3); // 11文字 / 4 = 2.75 -> 3
  assertEquals(estimateTokenCount(""), 0);
  assertEquals(estimateTokenCount("a"), 1);
  assertEquals(estimateTokenCount("abcd"), 1);
  assertEquals(estimateTokenCount("abcde"), 2);
});

Deno.test("estimateTokenCount - 日本語テキストのトークン数推定", () => {
  // 日本語テキストのテスト
  assertEquals(estimateTokenCount("こんにちは"), 2); // 5文字 / 4 = 1.25 -> 2
  assertEquals(estimateTokenCount("これはテストです"), 2); // 8文字 / 4 = 2
});

Deno.test("estimateTokenCount - 空白文字の正規化", () => {
  assertEquals(estimateTokenCount("  hello   world  "), 3); // "hello world" = 11文字 / 4 = 2.75 -> 3
  assertEquals(estimateTokenCount("hello\n\nworld"), 3); // "hello world" = 11文字 / 4 = 2.75 -> 3
  assertEquals(estimateTokenCount("hello\tworld"), 3); // "hello world" = 11文字 / 4 = 2.75 -> 3
});

Deno.test("estimateTokenCountFromArray - 配列からのトークン数推定", () => {
  assertEquals(estimateTokenCountFromArray([]), 0);
  assertEquals(estimateTokenCountFromArray(["hello"]), 2); // 5文字 / 4 = 1.25 -> 2
  assertEquals(estimateTokenCountFromArray(["hello", "world"]), 4); // 5 + 5 = 10文字 / 4 = 2.5 -> 3 + 2 = 5
});

Deno.test("estimateTokenCountFromSession - セッションJSONLからのトークン数推定", () => {
  const sessionContent = `
{"type": "message", "role": "user", "content": "Hello world"}
{"type": "message", "role": "assistant", "content": "Hi there!"}
{"type": "message", "role": "user", "content": [{"type": "text", "text": "How are you?"}]}
`.trim();

  // "Hello world" (11) + "Hi there!" (9) + "How are you?" (12) = 32文字 / 4 = 8
  assertEquals(estimateTokenCountFromSession(sessionContent), 9);
});

Deno.test("estimateTokenCountFromSession - 不正なJSONを含むセッション", () => {
  const sessionContent = `
{"type": "message", "role": "user", "content": "Hello world"}
invalid json line
{"type": "message", "role": "assistant", "content": "Hi there!"}
`.trim();

  // "Hello world" (11) + "Hi there!" (9) = 20文字 / 4 = 5
  assertEquals(estimateTokenCountFromSession(sessionContent), 6);
});

Deno.test("estimateTokenCountFromSession - 空のセッション", () => {
  assertEquals(estimateTokenCountFromSession(""), 0);
  assertEquals(estimateTokenCountFromSession("   "), 0);
  assertEquals(estimateTokenCountFromSession("\n\n\n"), 0);
});

Deno.test("estimateTokenCountFromSession - 複雑なメッセージ構造", () => {
  const sessionContent = `
{"type": "message", "role": "user", "content": "Test message"}
{"type": "message", "role": "assistant", "content": [{"type": "text", "text": "Response text"}, {"type": "tool_use", "name": "bash", "input": "ls -la"}]}
{"type": "session", "session_id": "test-session"}
`.trim();

  // "Test message" (12) + "Response text" (13) = 25文字 / 4 = 6.25 -> 7
  assertEquals(estimateTokenCountFromSession(sessionContent), 7);
});
