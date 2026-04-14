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
  assertEquals(args.at(-1), "hello");
});

Deno.test("WorkerConfiguration: resumeあり引数を組み立てる", () => {
  const config = new WorkerConfiguration();
  const args = config.buildCodexArgs("prompt", "session-1");

  const resumeIndex = args.indexOf("resume");
  assertEquals(resumeIndex > -1, true);
  assertEquals(args[resumeIndex + 1], "session-1");
  assertEquals(args.at(-1), "prompt");
});
