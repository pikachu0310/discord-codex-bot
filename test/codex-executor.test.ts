import { assertEquals, assertRejects } from "std/assert/mod.ts";
import { DefaultCodexCommandExecutor } from "../src/worker/codex-executor.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => resolve = r);
  return { promise, resolve };
}

function setup(scenario: string) {
  const packets: Record<string, unknown>[] = [];
  const notifications = new Map<string, ReturnType<typeof deferred<void>>>();
  const executor = new DefaultCodexCommandExecutor((cwd) =>
    new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--quiet",
        "--allow-run",
        "--allow-read",
        new URL("./fake-app-server.ts", import.meta.url).pathname,
        scenario,
      ],
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn()
  );
  return {
    executor,
    packets,
    wait(method: string) {
      if (packets.some((p) => p.method === method)) return Promise.resolve();
      const pending = notifications.get(method) ?? deferred<void>();
      notifications.set(method, pending);
      return pending.promise;
    },
    run(signal?: AbortSignal) {
      return executor.executeStreaming({
        prompt: "依頼",
        cwd: Deno.cwd(),
        sessionId: "previous-session",
        imagePaths: ["/tmp/image.png"],
        developerInstructions: "日本語で回答",
      }, (data) => {
        const packet = JSON.parse(new TextDecoder().decode(data));
        packets.push(packet);
        notifications.get(packet.method)?.resolve();
        if (packet.type === "progress") {
          notifications.get("question")?.resolve();
        }
      }, signal);
    },
    params(method: string) {
      return packets.find((p) => p.method === method)?.params;
    },
  };
}

Deno.test("App Server: 初期化・resume・画像・追加入力・最終応答", async () => {
  const test = setup("steer");
  const run = test.run();
  try {
    await test.wait("test/ready");
    assertEquals(
      await test.executor.sendInput({
        prompt: "追加",
        cwd: Deno.cwd(),
        imagePaths: ["/tmp/next.png"],
      }),
      true,
    );
    assertEquals((await run).isOk(), true);
    const thread = test.params("test/thread") as Record<string, unknown>;
    assertEquals(thread.threadId, "previous-session");
    assertEquals(thread.developerInstructions, "日本語で回答");
    assertEquals(thread.model, undefined);
    assertEquals(test.params("test/steer"), {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [
        { type: "text", text: "追加", text_elements: [] },
        { type: "localImage", path: "/tmp/next.png" },
      ],
    });
    assertEquals(test.packets.some((p) => p.type === "item.completed"), true);
    assertEquals(
      await test.executor.sendInput({ prompt: "終了後", cwd: Deno.cwd() }),
      false,
    );
  } finally {
    await run;
  }
});

Deno.test("App Server: 質問の番号と自由文を順に回答する", async () => {
  const test = setup("questions");
  const question = test.wait("question");
  const run = test.run();
  await question;
  const answers = await Promise.all([
    test.executor.sendInput({ prompt: "2", cwd: Deno.cwd() }),
    test.executor.sendInput({ prompt: "補足です", cwd: Deno.cwd() }),
  ]);
  assertEquals(answers, [true, true]);
  assertEquals((await run).isOk(), true);
  assertEquals(test.params("test/answer"), {
    answers: {
      language: { answers: ["英語"] },
      details: { answers: ["補足です"] },
    },
  });
  assertEquals(test.params("test/steer"), undefined);
});

Deno.test("App Server: 取り消された質問への返信は通常入力として渡す", async () => {
  const test = setup("resolved");
  const run = test.run();
  await test.wait("test/resolved");
  assertEquals(
    await test.executor.sendInput({ prompt: "追加", cwd: Deno.cwd() }),
    true,
  );
  assertEquals((await run).isOk(), true);
  assertEquals(test.params("test/answer"), undefined);
  assertEquals(test.params("test/steer") !== undefined, true);
});

Deno.test("App Server: 終了と追加入力の競合で入力を次のturnに返す", async () => {
  const test = setup("race");
  const run = test.run();
  await test.wait("test/ready");
  assertEquals(
    await test.executor.sendInput({ prompt: "追加", cwd: Deno.cwd() }),
    false,
  );
  assertEquals((await run).isOk(), true);
});

Deno.test("App Server: 入力拒否を報告し、実行中のturnを維持する", async () => {
  const test = setup("steer-error");
  const abort = new AbortController();
  const run = test.run(abort.signal);
  await test.wait("test/ready");
  await assertRejects(
    () => test.executor.sendInput({ prompt: "追加", cwd: Deno.cwd() }),
    Error,
    "Rejected input",
  );
  abort.abort();
  await run;
});

for (
  const scenario of ["complete", "wrapper", "failed", "exit", "disconnect"]
) {
  Deno.test(`App Server: ${scenario}でも接続とプロセスを解放する`, async () => {
    const test = setup(scenario);
    const result = await test.run();
    assertEquals(
      result.isOk(),
      ["complete", "wrapper"].includes(scenario),
      JSON.stringify(test.packets.slice(-3)),
    );
  });
}

Deno.test("App Server: 初期化完了前の入力も同じturnに渡す", async () => {
  const test = setup("early-input");
  const run = test.run();
  assertEquals(
    await test.executor.sendInput({ prompt: "すぐ追加", cwd: Deno.cwd() }),
    true,
  );
  assertEquals((await run).isOk(), true);
});

Deno.test("App Server: 質問待機中のstopをturn/interruptで処理する", async () => {
  const test = setup("questions");
  const abort = new AbortController();
  const question = test.wait("question");
  const run = test.run(abort.signal);
  await question;
  abort.abort();
  assertEquals((await run).isOk(), true);
  assertEquals(test.params("test/interrupted") !== undefined, true);
  assertEquals(
    await test.executor.sendInput({ prompt: "回答", cwd: Deno.cwd() }),
    false,
  );
});

Deno.test("App Server: 非同期の質問を終了前に一度表示し、番号回答で継続する", async () => {
  const test = setup("async-questions");
  const question = test.wait("question");
  const run = test.run();
  await question;
  assertEquals(test.executor.getPendingQuestion(), "確認用の色は？");
  const progress = test.packets.filter((p) => p.type === "progress");
  assertEquals(progress.length, 1);
  assertEquals(
    (progress[0].item as { text: string }).text.match(/確認用の色は？/g)
      ?.length,
    1,
  );
  await assertRejects(
    () => test.executor.sendInput({ prompt: "9", cwd: Deno.cwd() }),
    Error,
    "1〜2",
  );
  assertEquals(test.executor.getPendingQuestion(), "確認用の色は？");
  assertEquals(
    await test.executor.sendInput({ prompt: "2", cwd: Deno.cwd() }),
    true,
  );
  assertEquals((await run).isOk(), true);
  const steer = test.params("test/steer") as { input: { text: string }[] };
  assertEquals(steer.input[0].text, "質問「確認用の色は？」への回答: 緑");
  assertEquals(test.executor.getPendingQuestion(), null);
});

Deno.test("App Server: 非同期の質問はturn完了後も番号回答で同じ会話を再開できる", async () => {
  const test = setup("async-idle");
  assertEquals((await test.run()).isOk(), true);
  assertEquals(test.executor.getPendingQuestion(), "確認用の色は？");
  const result = await test.executor.executeStreaming({
    prompt: "2",
    cwd: Deno.cwd(),
    sessionId: "thread-1",
  }, (data) => test.packets.push(JSON.parse(new TextDecoder().decode(data))));
  assertEquals(result.isOk(), true);
  assertEquals(test.params("test/answer-input"), {
    text: "質問「確認用の色は？」への回答: 緑",
  });
  assertEquals(test.executor.getPendingQuestion(), null);
});
