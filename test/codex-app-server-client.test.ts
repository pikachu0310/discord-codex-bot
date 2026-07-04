import { assertEquals, assertExists } from "std/assert/mod.ts";
import {
  CodexAppServerClient,
  type CodexAppServerProcess,
} from "../src/worker/codex-app-server-client.ts";

function encodeLine(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

function createFakeProcess(stdoutMessages: unknown[]) {
  const written: string[] = [];
  let killed = false;

  const process: CodexAppServerProcess = {
    stdin: new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(new TextDecoder().decode(chunk));
      },
    }),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const message of stdoutMessages) {
          controller.enqueue(encodeLine(message));
        }
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    status: Promise.resolve({
      success: true,
      code: 0,
      signal: null,
    }),
    kill() {
      killed = true;
    },
  };

  return {
    process,
    written,
    wasKilled: () => killed,
  };
}

Deno.test("CodexAppServerClient: thread/forkを送信してfork先thread idを返す", async () => {
  const fake = createFakeProcess([
    { method: "thread/loaded", params: { threadId: "source-thread" } },
    {
      id: 1,
      result: {
        thread: {
          id: "fork-thread",
          sessionId: "session-tree",
          forkedFromId: "source-thread",
        },
        cwd: "/tmp/fork-worktree",
      },
    },
  ]);
  const client = new CodexAppServerClient(() => fake.process, 1000);

  const result = await client.forkThread({
    threadId: "source-thread",
    cwd: "/tmp/fork-worktree",
    runtimeWorkspaceRoots: ["/tmp/fork-worktree"],
  });

  assertEquals(result.isOk(), true);
  const value = result._unsafeUnwrap();
  assertEquals(value.threadId, "fork-thread");
  assertEquals(value.sessionId, "session-tree");
  assertEquals(value.forkedFromId, "source-thread");
  assertEquals(value.cwd, "/tmp/fork-worktree");
  assertEquals(fake.wasKilled(), true);

  const sent = fake.written.join("").trim().split("\n").map((line) =>
    JSON.parse(line)
  );
  assertEquals(sent[0].method, "initialize");
  assertEquals(sent[1].method, "initialized");
  assertEquals(sent[2].method, "thread/fork");
  assertEquals(sent[2].params, {
    threadId: "source-thread",
    excludeTurns: true,
    cwd: "/tmp/fork-worktree",
    runtimeWorkspaceRoots: ["/tmp/fork-worktree"],
  });
});

Deno.test("CodexAppServerClient: thread/forkのJSON-RPCエラーを返す", async () => {
  const fake = createFakeProcess([
    {
      id: 1,
      error: {
        code: -32602,
        message: "thread not found",
      },
    },
  ]);
  const client = new CodexAppServerClient(() => fake.process, 1000);

  const result = await client.forkThread({ threadId: "missing-thread" });

  assertEquals(result.isErr(), true);
  const error = result._unsafeUnwrapErr();
  assertEquals(error.type, "APP_SERVER_ERROR");
  if (error.type === "APP_SERVER_ERROR") {
    assertEquals(error.message, "thread not found");
    assertEquals(error.code, -32602);
  }
});

Deno.test("CodexAppServerClient: thread.idが無い応答をprotocol errorにする", async () => {
  const fake = createFakeProcess([
    { id: 1, result: { thread: { sessionId: "session-tree" } } },
  ]);
  const client = new CodexAppServerClient(() => fake.process, 1000);

  const result = await client.forkThread({ threadId: "source-thread" });

  assertEquals(result.isErr(), true);
  const error = result._unsafeUnwrapErr();
  assertEquals(error.type, "APP_SERVER_PROTOCOL_ERROR");
  if (error.type === "APP_SERVER_PROTOCOL_ERROR") {
    assertExists(error.error.match(/thread\.id/));
  }
});
