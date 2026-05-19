import { assertEquals } from "std/assert/mod.ts";
import { formatStartCommandErrorForUser } from "../src/start-command-error.ts";

Deno.test("formatStartCommandErrorForUser: Missing Access を具体化する", () => {
  assertEquals(
    formatStartCommandErrorForUser({
      code: 50001,
      message: "Missing Access",
    }),
    "チャンネルへのアクセス権限が足りません。Bot にこのチャンネルを閲覧・送信できる権限を付与してください。",
  );
});

Deno.test("formatStartCommandErrorForUser: Missing Permissions を具体化する", () => {
  assertEquals(
    formatStartCommandErrorForUser({
      code: 50013,
      message: "Missing Permissions",
    }),
    "Bot に必要な権限が足りません。チャンネル権限を確認してください。",
  );
});

Deno.test("formatStartCommandErrorForUser: Unknown Channel を具体化する", () => {
  assertEquals(
    formatStartCommandErrorForUser({
      code: 10003,
      message: "Unknown Channel",
    }),
    "対象のチャンネルを取得できませんでした。チャンネルが削除されていないか確認してください。",
  );
});

Deno.test("formatStartCommandErrorForUser: その他のエラーはメッセージを返す", () => {
  assertEquals(
    formatStartCommandErrorForUser({
      code: 99999,
      message: "Something went wrong",
    }),
    "start コマンドに失敗しました: Something went wrong",
  );
});
