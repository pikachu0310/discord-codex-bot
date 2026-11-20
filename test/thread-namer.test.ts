import { assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import {
  fallbackThreadName,
  generateConversationNamesWithCodex,
  parseConversationNames,
} from "../src/thread-namer.ts";

Deno.test("fallbackThreadName: 最初の空でない行を正規化する", () => {
  assertEquals(
    fallbackThreadName("\n  **タイトル生成** を直したい\n詳細"),
    "タイトル生成 を直したい",
  );
});

Deno.test("parseConversationNames: 名前を正規化する", () => {
  const result = parseConversationNames(`\`\`\`json
    {"threadName":" 初回応答後の名前更新 ","branchPrefix":"FEAT","branchSlug":"Auto Name / First Reply"}
  \`\`\``);

  assertEquals(result._unsafeUnwrap(), {
    threadName: "初回応答後の名前更新",
    branchName: "feat/auto-name-first-reply",
  });
});

Deno.test("parseConversationNames: 未許可prefixを拒否する", () => {
  const result = parseConversationNames(
    '{"threadName":"名前","branchPrefix":"worker","branchSlug":"task"}',
  );
  assertEquals(result.isErr(), true);
});

Deno.test("parseConversationNames: Unicodeのブランチタイトルを保持する", () => {
  const result = parseConversationNames(
    '{"threadName":"命名を改善","branchPrefix":"feat","branchSlug":" 日本語 のタイトル！ "}',
  );
  assertEquals(result._unsafeUnwrap().branchName, "feat/日本語-のタイトル");
});

Deno.test("generateConversationNamesWithCodex: stdoutを一度だけ回収する", async () => {
  const dir = await Deno.makeTempDir();
  const originalPath = Deno.env.get("PATH");
  try {
    const text = JSON.stringify({
      threadName: "タイトル生成修正",
      branchPrefix: "fix",
      branchSlug: "collect-stdout-once",
    });
    const event = JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text },
    });
    const fakeCodex = `${dir}/codex`;
    const argsFile = `${dir}/args`;
    await Deno.writeTextFile(
      fakeCodex,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '%s\\n' '${event}'\n`,
    );
    await Deno.chmod(fakeCodex, 0o755);
    Deno.env.set("PATH", `${dir}:${originalPath ?? ""}`);

    const result = await generateConversationNamesWithCodex(
      "依頼",
      "回答",
      undefined,
      dir,
      "astra-medium",
      "threadNameは英語、branchSlugは日本語で作成してください",
    );
    assertEquals(result._unsafeUnwrap(), {
      threadName: "タイトル生成修正",
      branchName: "fix/collect-stdout-once",
    });
    const argv = await Deno.readTextFile(argsFile);
    assertStringIncludes(
      argv,
      'model_reasoning_effort="medium"\n--model\ngpt-6.2-astra',
    );
    assertStringIncludes(
      argv,
      "threadNameは英語、branchSlugは日本語で作成してください",
    );
  } finally {
    if (originalPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", originalPath);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generateConversationNamesWithCodex: 失敗を最大3回試す", async () => {
  const dir = await Deno.makeTempDir();
  const originalPath = Deno.env.get("PATH");
  try {
    const calls = `${dir}/calls`;
    const fakeCodex = `${dir}/codex`;
    await Deno.writeTextFile(
      fakeCodex,
      `#!/bin/sh\nprintf x >> '${calls}'\nprintf failure >&2\nexit 1\n`,
    );
    await Deno.chmod(fakeCodex, 0o755);
    Deno.env.set("PATH", `${dir}:${originalPath ?? ""}`);

    const failures: number[] = [];
    const result = await generateConversationNamesWithCodex(
      "依頼",
      "回答",
      undefined,
      dir,
      undefined,
      undefined,
      (_error, attempt) => {
        failures.push(attempt);
      },
    );

    assertEquals(result.isErr(), true);
    assertEquals(await Deno.readTextFile(calls), "xxx");
    assertEquals(failures, [1, 2, 3]);
  } finally {
    if (originalPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", originalPath);
    await Deno.remove(dir, { recursive: true });
  }
});
