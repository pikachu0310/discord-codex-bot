import { assert, assertEquals } from "std/assert/mod.ts";
import {
  buildQuestionButtons,
  parseQuestionButton,
} from "../src/utils/discord-question.ts";

Deno.test("Question buttons: Discordの行数・ラベル・ID制限を守り、無効化できる", () => {
  const question = {
    id: crypto.randomUUID() + ":0",
    title: "選択してください",
    options: Array.from({ length: 27 }, (_, i) => `${i} ${"🦊".repeat(60)}`),
    position: 1,
    total: 1,
  };
  const rows = buildQuestionButtons(question, true).map((row) => row.toJSON());
  assertEquals(rows.length, 5);
  assertEquals(rows.flatMap((row) => row.components).length, 25);
  for (const row of rows) {
    assert(row.components.length <= 5);
    for (const raw of row.components) {
      const button = raw as {
        custom_id: string;
        label: string;
        disabled: boolean;
      };
      assert(button.label.length <= 80);
      assert(button.custom_id.length <= 100);
      assertEquals(button.disabled, true);
      assertEquals(
        parseQuestionButton(button.custom_id)?.questionId,
        question.id,
      );
      assert(!/[\uD800-\uDBFF]$/.test(button.label));
    }
  }
  assertEquals(buildQuestionButtons({ ...question, options: [] }), []);
  assertEquals(parseQuestionButton("unrelated:1"), null);
  assertEquals(parseQuestionButton("codex-answer:token:-1"), null);
});
