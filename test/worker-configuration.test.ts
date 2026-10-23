import { assertEquals } from "std/assert/mod.ts";
import { WorkerConfiguration } from "../src/worker/worker-configuration.ts";

Deno.test("WorkerConfiguration: 新規実行引数は固定形式", () => {
  const config = new WorkerConfiguration();
  const args = config.buildCodexArgs("hello");

  assertEquals(args.slice(0, 6), [
    "--search",
    "exec",
    "--json",
    "--color",
    "never",
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
  assertEquals(args.slice(6), ["--", "hello"]);
});

Deno.test("WorkerConfiguration: resumeあり引数を組み立てる", () => {
  const config = new WorkerConfiguration();
  const args = config.buildCodexArgs("prompt", "session-1");

  const resumeIndex = args.indexOf("resume");
  assertEquals(resumeIndex > -1, true);
  assertEquals(args.slice(resumeIndex), [
    "resume",
    "--",
    "session-1",
    "prompt",
  ]);
  assertEquals(args.at(-1), "prompt");
});

Deno.test("WorkerConfiguration: 新規実行に画像添付を渡せる", () => {
  const config = new WorkerConfiguration();
  const args = config.buildCodexArgs("prompt", null, [
    "/tmp/image-1.png",
    "/tmp/image-2.jpg",
  ]);

  assertEquals(args.slice(-6), [
    "--image",
    "/tmp/image-1.png",
    "--image",
    "/tmp/image-2.jpg",
    "--",
    "prompt",
  ]);
});

Deno.test("WorkerConfiguration: resume実行に画像添付を渡せる", () => {
  const config = new WorkerConfiguration();
  const args = config.buildCodexArgs("prompt", "session-1", [
    "/tmp/image.png",
  ]);

  const resumeIndex = args.indexOf("resume");
  assertEquals(args.slice(resumeIndex), [
    "resume",
    "--image",
    "/tmp/image.png",
    "--",
    "session-1",
    "prompt",
  ]);
});

Deno.test("WorkerConfiguration: 新規実行に最終メッセージ出力先を渡せる", () => {
  const config = new WorkerConfiguration();
  const args = config.buildCodexArgs(
    "prompt",
    null,
    [],
    "/tmp/last-message.txt",
  );

  assertEquals(args.slice(-4), [
    "--output-last-message",
    "/tmp/last-message.txt",
    "--",
    "prompt",
  ]);
});

Deno.test("WorkerConfiguration: resume実行に最終メッセージ出力先を渡せる", () => {
  const config = new WorkerConfiguration();
  const args = config.buildCodexArgs(
    "prompt",
    "session-1",
    [],
    "/tmp/last-message.txt",
  );

  const resumeIndex = args.indexOf("resume");
  assertEquals(args.slice(resumeIndex), [
    "resume",
    "--output-last-message",
    "/tmp/last-message.txt",
    "--",
    "session-1",
    "prompt",
  ]);
});

Deno.test("WorkerConfiguration: オプションやサブコマンドに見える本文を新規実行に渡せる", () => {
  const config = new WorkerConfiguration();
  for (
    const prompt of [
      "--help",
      "--model other-model",
      "-x",
      "--",
      "resume",
      "help",
    ]
  ) {
    for (const imagePaths of [[], ["/tmp/image.png"]]) {
      const args = config.buildCodexArgs(
        prompt,
        null,
        imagePaths,
        "/tmp/last-message.txt",
      );

      assertEquals(args.slice(6), [
        "--output-last-message",
        "/tmp/last-message.txt",
        ...imagePaths.flatMap((path) => ["--image", path]),
        "--",
        prompt,
      ]);
    }
  }
});

Deno.test("WorkerConfiguration: resumeのsession IDと本文の前でオプションを終端する", () => {
  const config = new WorkerConfiguration();
  for (const sessionId of ["session-1", "--last", "-x"]) {
    for (const prompt of ["--help", "--model other-model", "-x", "--"]) {
      for (const imagePaths of [[], ["/tmp/image.png"]]) {
        const args = config.buildCodexArgs(
          prompt,
          sessionId,
          imagePaths,
          "/tmp/last-message.txt",
        );

        assertEquals(args.slice(args.indexOf("resume")), [
          "resume",
          "--output-last-message",
          "/tmp/last-message.txt",
          ...imagePaths.flatMap((path) => ["--image", path]),
          "--",
          sessionId,
          prompt,
        ]);
      }
    }
  }
});
