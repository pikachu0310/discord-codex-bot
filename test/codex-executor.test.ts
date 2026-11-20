import {
  buildQuestionButtons,
  captureDiscordAnswer,
  parseQuestionButton,
} from "../src/utils/discord-question.ts";
import { Worker } from "../src/worker/worker.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";
import { assertEquals, assertRejects } from "std/assert/mod.ts";
import { WorkerConfiguration } from "../src/worker/worker-configuration.ts";
import {
  type CodexExecutionOptions,
  DefaultCodexCommandExecutor,
} from "../src/worker/codex-executor.ts";

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
    run(signal?: AbortSignal, options: CodexExecutionOptions = {
      prompt: "依頼",
      cwd: Deno.cwd(),
      sessionId: "previous-session",
      imagePaths: ["/tmp/image.png"],
      developerInstructions: "日本語で回答",
    }) {
      return executor.executeStreaming(options, (data) => {
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

Deno.test("App Server: 選択ボタンと自由文を併用し、前の質問への再回答を拒否する", async () => {
  const test = setup("questions");
  const shown = test.wait("question");
  const run = test.run();
  await shown;
  const first = test.executor.getPendingQuestions()[0];
  assertEquals(first.options, ["日本語", "英語"]);
  const answer = { questionId: first.id, optionIndex: 1 };
  assertEquals(
    await test.executor.sendInput({
      prompt: "",
      cwd: Deno.cwd(),
      questionAnswer: answer,
    }),
    true,
  );
  assertEquals(test.executor.getPendingQuestions()[0].id === first.id, false);
  await assertRejects(
    () =>
      test.executor.sendInput({
        prompt: "",
        cwd: Deno.cwd(),
        questionAnswer: answer,
      }),
    Error,
    "回答済み",
  );
  assertEquals(
    await test.executor.sendInput({ prompt: "自由な補足", cwd: Deno.cwd() }),
    true,
  );
  assertEquals((await run).isOk(), true);
  assertEquals(test.params("test/answer"), {
    answers: {
      language: { answers: ["英語"] },
      details: { answers: ["自由な補足"] },
    },
  });
});

Deno.test("App Server: 同じボタンの連続クリックを一度だけ届ける", async () => {
  const test = setup("async-questions");
  const shown = test.wait("question");
  const run = test.run();
  await shown;
  const question = test.executor.getPendingQuestions()[0];
  const options = {
    prompt: "",
    cwd: Deno.cwd(),
    questionAnswer: { questionId: question.id, optionIndex: 1 },
  };
  const results = await Promise.allSettled([
    test.executor.sendInput(options),
    test.executor.sendInput(options),
  ]);
  assertEquals(
    results.filter((result) => result.status === "fulfilled" && result.value)
      .length,
    1,
  );
  assertEquals((await run).isOk(), true);
  assertEquals(
    test.packets.filter((packet) => packet.method === "test/steer").length,
    1,
  );
  assertEquals(
    (test.params("test/steer") as { input: { text: string }[] }).input[0].text,
    "質問「確認用の色は？」への回答: 緑",
  );
});

Deno.test("App Server: turn終了後のボタンで再開し、回答済みボタンは新規実行しない", async () => {
  const test = setup("async-idle");
  assertEquals((await test.run()).isOk(), true);
  const question = test.executor.getPendingQuestions()[0];
  const options = {
    prompt: "",
    cwd: Deno.cwd(),
    sessionId: "thread-1",
    questionAnswer: { questionId: question.id, optionIndex: 1 },
  };
  const collect = (data: Uint8Array) =>
    test.packets.push(JSON.parse(new TextDecoder().decode(data)));
  assertEquals(
    (await test.executor.executeStreaming(options, collect)).isOk(),
    true,
  );
  const count = test.packets.length;
  assertEquals(
    (await test.executor.executeStreaming(options, collect)).isErr(),
    true,
  );
  assertEquals(test.packets.length, count);
});

Deno.test("App Server: stopで質問ボタンも取り消す", async () => {
  const test = setup("async-questions");
  const abort = new AbortController();
  const shown = test.wait("question");
  const run = test.run(abort.signal);
  await shown;
  assertEquals(test.executor.getPendingQuestions().length, 1);
  abort.abort();
  await run;
  assertEquals(test.executor.getPendingQuestions(), []);
});

Deno.test("App Server: 本文・画像・追加指示を新規と再開の両方で独立して送る", async (t) => {
  for (const sessionId of [undefined, "previous-session"]) {
    for (const prompt of ["hello", "--help"]) {
      for (const images of [[], ["/tmp/image 1.png", "/tmp/image-2.jpg"]]) {
        for (
          const instructions of [
            undefined,
            "Follow project instructions.\nPreserve user input.",
          ]
        ) {
          await t.step(
            JSON.stringify({ sessionId, prompt, images, instructions }),
            async () => {
              const server = setup("complete");
              const options = new WorkerConfiguration(instructions)
                .buildExecutionOptions(prompt, Deno.cwd(), sessionId, images);
              assertEquals((await server.run(undefined, options)).isOk(), true);
              assertEquals(
                server.params("test/thread-method"),
                sessionId ? "thread/resume" : "thread/start",
              );
              const thread = server.params("test/thread") as Record<
                string,
                unknown
              >;
              assertEquals(thread.threadId, sessionId);
              assertEquals(thread.developerInstructions, instructions);
              assertEquals(server.params("test/input"), {
                threadId: "thread-1",
                input: [
                  { type: "text", text: prompt, text_elements: [] },
                  ...images.map((path) => ({ type: "localImage", path })),
                ],
              });
              assertEquals(
                server.packets.some((packet) =>
                  packet.type === "item.completed"
                ),
                true,
              );
            },
          );
        }
      }
    }
  }
});

Deno.test("Discord: ボタン直後の遅い自由文を次の質問に渡さない", async () => {
  const test = setup("questions");
  const abort = new AbortController();
  const run = test.run(abort.signal);
  try {
    await test.wait("question");
    const [shown] = test.executor.getPendingQuestions();
    const id = (buildQuestionButtons(shown)[0].components[1].toJSON() as {
      custom_id: string;
    }).custom_id;
    const button = parseQuestionButton(id!)!;
    // Both events arrived while Discord was displaying the first question.
    const message = {
      id: "101",
      reference: { messageId: "100" },
      content: "同じ質問への別回答",
      fetchReference: () =>
        Promise.resolve({ author: { id: "bot" }, content: "❓ 言語" }),
    };
    const text = await captureDiscordAnswer(message, [{
      question: shown,
      message: { id: "100" },
    }], "bot");
    if (!text || text === "expired") throw new Error("Missing question");
    await test.executor.sendInput({
      prompt: "",
      cwd: Deno.cwd(),
      questionAnswer: button,
    });
    await assertRejects(
      () =>
        test.executor.sendInput({
          prompt: text.text,
          cwd: Deno.cwd(),
          questionAnswer: text,
        }),
      Error,
      "回答済み",
    );
    const [next] = test.executor.getPendingQuestions();
    assertEquals(next.title, "補足を教えてください");
  } finally {
    abort.abort();
    await run;
  }
});

Deno.test("Discord: 中断直後に質問を無効化して回答を受理しない", async () => {
  const test = setup("async-questions");
  const abort = new AbortController();
  const run = test.run(abort.signal);
  try {
    await test.wait("question");
    abort.abort();
    assertEquals(test.executor.getPendingQuestions(), []);
  } finally {
    await run;
  }
});

Deno.test("Discord: 添付つきセッションの待機中にstopした後は、古いボタンも遅延回答も再開させない", async () => {
  const server = setup("async-idle");
  const dir = await Deno.makeTempDir();
  try {
    const manager = new WorkspaceManager(dir);
    await manager.initialize();
    const state = {
      workerName: "bot",
      threadId: "discord-1",
      repository: { fullName: "example/repo", org: "example", repo: "repo" },
      worktreePath: dir,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: "active" as const,
    };
    const worker = new Worker(state, manager, server.executor);
    const assets = await manager.saveMessageAttachments(state.threadId, "101", [
      {
        id: "file",
        name: "notes.txt",
        url: "data:,notes",
        contentType: "text/plain",
        size: 5,
      },
    ]);
    assertEquals(
      (await worker.processMessage("この資料について質問して", assets)).isOk(),
      true,
    );
    const [shown] = worker.getPendingQuestions();
    const message = {
      id: "103",
      reference: { messageId: "102" },
      content: "緑",
      fetchReference: () =>
        Promise.resolve({
          author: { id: "bot" },
          content: "❓ 確認用の色は？",
        }),
    };
    const captured = await captureDiscordAnswer(message, [{
      question: shown,
      message: { id: "102" },
    }], "bot");
    if (!captured || captured === "expired") throw new Error("Missing reply");
    const click = parseQuestionButton(
      (buildQuestionButtons(shown)[0].components[1].toJSON() as {
        custom_id: string;
      }).custom_id!,
    )!;
    assertEquals(worker.isRunning(), false);
    assertEquals(await worker.stopExecution(), true);
    assertEquals(worker.getPendingQuestions(), []);
    assertEquals(
      (await worker.processMessage("緑", [], undefined, undefined, click))
        .isErr(),
      true,
    );
    assertEquals(
      (await worker.processMessage("緑", [], undefined, undefined, captured))
        .isErr(),
      true,
    );
    assertEquals(await captureDiscordAnswer(message, [], "bot"), "expired");
    // Restart with persisted state, then open a new question in the same channel.
    const fresh = new Worker(
      (await manager.loadWorkerState(state.threadId))!,
      manager,
      setup("async-idle").executor,
    );
    assertEquals((await fresh.processMessage("もう一度確認して")).isOk(), true);
    const [next] = fresh.getPendingQuestions();
    assertEquals(next.id === shown.id, false);
    assertEquals(
      (await fresh.processMessage("緑", [], undefined, undefined, click))
        .isErr(),
      true,
    );
    assertEquals(fresh.getPendingQuestions()[0].id, next.id);
    assertEquals(
      (await fresh.processMessage("青", [], undefined, undefined, {
        questionId: next.id,
        text: "青",
      }))._unsafeUnwrap(),
      "最終返信です。",
    );
    assertEquals(fresh.getPendingQuestions(), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Discord: 2問目への返信に添えた資料と画像が届き、1問目のボタンは有効なまま残る", async () => {
  const test = setup("async-multiple");
  const run = test.run();
  await test.wait("question");
  const [color, shape] = test.executor.getPendingQuestions();
  const posts = [{ question: color, message: { id: "100" } }, {
    question: shape,
    message: { id: "101" },
  }];
  const message = {
    id: "102",
    reference: { messageId: "101" },
    content: "まる",
    fetchReference: () => Promise.reject(new Error("already visible")),
  };
  const answer = await captureDiscordAnswer(message, posts, "bot");
  if (!answer || answer === "expired") throw new Error("Missing reply");
  assertEquals(answer.questionId, shape.id);
  assertEquals(
    await test.executor.sendInput({
      prompt: message.content,
      cwd: Deno.cwd(),
      questionAnswer: answer,
      imagePaths: ["/sample/picture.png"],
      attachmentContext: "saved_path: /sample/notes.txt",
    }),
    true,
  );
  assertEquals(test.params("test/steer"), {
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [
      {
        type: "text",
        text: "質問「形は？」への回答: まる\n\nsaved_path: /sample/notes.txt",
        text_elements: [],
      },
      { type: "localImage", path: "/sample/picture.png" },
    ],
  });
  assertEquals((await run).isOk(), true);
  assertEquals(test.executor.getPendingQuestions().map((q) => q.id), [
    color.id,
  ]);
});

Deno.test("Discord: 受付応答だけが失われたボタンを自動再送しない", async () => {
  const test = setup("async-disconnect");
  const run = test.run();
  await test.wait("question");
  const [q] = test.executor.getPendingQuestions();
  const input = {
    prompt: "緑",
    cwd: Deno.cwd(),
    questionAnswer: { questionId: q.id, optionIndex: 1 },
  };
  const delivery = test.executor.sendInput(input);
  await assertRejects(() => delivery, Error);
  await run;
  assertEquals(test.packets.filter((p) => p.method === "test/steer").length, 1);
  assertEquals(test.executor.getPendingQuestions(), []);
  const resumed = await test.executor.executeStreaming(input, () => {});
  assertEquals(resumed.isErr(), true);
});

Deno.test("App Server: 追加の質問も未回答なら保持し、同じ通知の再配信でボタンを作り直さない", async () => {
  const test = setup("question-batches");
  const abort = new AbortController();
  const run = test.run(abort.signal);
  try {
    await test.wait("test/batches-ready");
    const questions = test.executor.getPendingQuestions();
    assertEquals(questions.map((q) => q.title), ["色は？", "形は？"]);
    assertEquals(
      test.packets.filter((p) => p.type === "progress" && p.questions).length,
      2,
    );
    const update = test.packets.find((p) =>
      (p.item as { text?: string })?.text === "添付を読み終えました。"
    );
    assertEquals((update?.item as { phase: string })?.phase, "commentary");
  } finally {
    abort.abort();
    await run;
  }
});

Deno.test("Discord: 再起動後は待機中の質問だけを新しいIDで復元し、回答・stopを再実行しない", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const manager = new WorkspaceManager(dir);
    await manager.initialize();
    const now = new Date().toISOString();
    const state = {
      threadId: "discord",
      workerName: "local",
      repository: { org: "local", repo: "fixture", fullName: "local/fixture" },
      worktreePath: dir,
      status: "active" as const,
      createdAt: now,
      lastActiveAt: now,
    };
    const original = new Worker(state, manager, setup("async-idle").executor);
    assertEquals((await original.processMessage("質問して")).isOk(), true);
    const [old] = original.getPendingQuestions();
    const recorded = await manager.loadWorkerState("discord");
    assertEquals(recorded?.pendingQuestions?.map((q) => q.title), [old.title]);
    assertEquals(
      JSON.stringify(recorded?.pendingQuestions).includes(old.id),
      false,
    );
    const server = setup("async-idle");
    const restored = new Worker(recorded!, manager, server.executor);
    const [question] = restored.getPendingQuestions();
    assertEquals(question.id === old.id, false);
    assertEquals(
      (await restored.processMessage("", [], undefined, undefined, {
        questionId: old.id,
        optionIndex: 1,
      })).isErr(),
      true,
    );
    const result = await restored.processMessage(
      "緑",
      [],
      undefined,
      undefined,
      { questionId: question.id, optionIndex: 1 },
    );
    assertEquals(result._unsafeUnwrap(), "最終返信です。");
    assertEquals(
      (await manager.loadWorkerState("discord"))?.pendingQuestions,
      undefined,
    );
    const logs = `${dir}/sessions/local/fixture`;
    const answers = [];
    for await (const file of Deno.readDir(logs)) {
      const raw = await Deno.readTextFile(`${logs}/${file.name}`);
      answers.push(
        ...raw.trim().split("\n").map((line) => JSON.parse(line)).filter(
          (packet) => packet.method === "test/answer-input",
        ).map((packet) => packet.params.text),
      );
    }
    assertEquals(answers, ["質問「確認用の色は？」への回答: 緑"]);
    assertEquals(
      (await restored.processMessage("さらに質問して")).isOk(),
      true,
    );
    const beforeStop = await manager.loadWorkerState("discord");
    const idle = new Worker(beforeStop!, manager, setup("async-idle").executor);
    assertEquals(await idle.stopExecution(), true);
    const afterStop = (await manager.loadWorkerState("discord"))!;
    assertEquals(afterStop.pendingQuestions, undefined);
    assertEquals(
      (await Worker.fromState(afterStop, manager)).getPendingQuestions(),
      [],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
