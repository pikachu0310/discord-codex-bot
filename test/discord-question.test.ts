import { assert, assertEquals } from "std/assert/mod.ts";
import {
  buildQuestionButtons,
  parseQuestionButton,
  questionStatusMessages,
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

Deno.test("Question status: 長い質問と自由文の質問を欠落なく再表示し、元のボタンIDを使う", () => {
  const first = {
    id: "one:0",
    title: "動物は？",
    options: ["ねこ", "いぬ".repeat(1000)],
    position: 1,
    total: 2,
  };
  const second = {
    id: "two:0",
    title: "補足は？",
    options: [],
    position: 2,
    total: 2,
  };
  const messages = questionStatusMessages([first, second]);
  assert(messages.every((m) => m.content.length <= 2000));
  assert(messages.some((m) => m.content.includes(first.title)));
  assert(messages.at(-1)!.content.includes(second.title));
  assertEquals(
    messages.filter((m) => m.components.length).map((m) =>
      m.components[0].toJSON()
    ),
    [buildQuestionButtons(first)[0].toJSON()],
  );
  assertEquals(questionStatusMessages([]), []);
});
