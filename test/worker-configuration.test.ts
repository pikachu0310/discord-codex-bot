import { assertEquals } from "std/assert/mod.ts";
import { WorkerConfiguration } from "../src/worker/worker-configuration.ts";

Deno.test("WorkerConfiguration: App Serverの設定でモデル設定を上書きしない", () => {
  const config = new WorkerConfiguration();
  assertEquals(
    config.buildExecutionOptions("--help", "/work", "session-1", [
      "/image.png",
    ]),
    {
      prompt: "--help",
      cwd: "/work",
      sessionId: "session-1",
      imagePaths: ["/image.png"],
    },
  );
});

Deno.test("WorkerConfiguration: 追加の指示をdeveloperInstructionsへ渡す", () => {
  const config = new WorkerConfiguration("日本語で回答");
  assertEquals(
    config.buildExecutionOptions("依頼", "/work").developerInstructions,
    "日本語で回答",
  );
});
