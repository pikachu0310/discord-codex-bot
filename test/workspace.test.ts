import { assertEquals, assertExists, assertRejects } from "std/assert/mod.ts";
import { dirname, fromFileUrl } from "std/path/mod.ts";
import { stub } from "std/testing/mock.ts";
import {
  type WorkerState,
  WorkspaceManager,
} from "../src/workspace/workspace.ts";

const testRoot = dirname(fromFileUrl(import.meta.url));
const fixtureRoot = `${testRoot}/fixtures`;

async function createTestDir(prefix: string): Promise<string> {
  await Deno.mkdir(fixtureRoot, { recursive: true });
  return await Deno.makeTempDir({ dir: fixtureRoot, prefix });
}

async function listFileNames(dir: string): Promise<string[]> {
  return (await Array.fromAsync(Deno.readDir(dir)))
    .map((entry) => entry.name)
    .sort();
}

Deno.test("WorkspaceManager: worker state を保存・読み込みできる", async () => {
  const baseDir = await createTestDir("workspace_test_");
  try {
    const manager = new WorkspaceManager(baseDir);
    await manager.initialize();

    const now = new Date().toISOString();
    const state: WorkerState = {
      workerName: "w1",
      threadId: "123",
      status: "active",
      createdAt: now,
      lastActiveAt: now,
      sessionId: "s1",
    };
    await manager.saveWorkerState(state);

    const loaded = await manager.loadWorkerState("123");
    assertExists(loaded);
    assertEquals(loaded?.workerName, "w1");
    assertEquals(loaded?.sessionId, "s1");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test(
  "WorkspaceManager: thread info は初回メッセージ関連フィールドを補完する",
  async () => {
    const baseDir = await createTestDir("workspace_test_");
    try {
      const manager = new WorkspaceManager(baseDir);
      await manager.initialize();

      await manager.saveThreadInfo({
        threadId: "thread-1",
        repositoryFullName: "a/b",
        repositoryLocalPath: "a/b",
        worktreePath: "/tmp/worktree",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: "active",
      });

      const loaded = await manager.loadThreadInfo("thread-1");
      assertExists(loaded);
      assertEquals(loaded?.firstUserMessageReceivedAt, null);
      assertEquals(loaded?.autoRenamedByFirstMessage, false);
    } finally {
      await Deno.remove(baseDir, { recursive: true });
    }
  },
);

Deno.test("WorkspaceManager: 添付ファイルをメッセージ単位で保存できる", async () => {
  const baseDir = await createTestDir("workspace_test_");
  try {
    const manager = new WorkspaceManager(baseDir);
    await manager.initialize();

    const saved = await manager.saveMessageAttachments(
      "thread-1",
      "message-1",
      [
        {
          id: "att-1",
          name: "hello world.txt",
          url: "data:text/plain;base64,aGVsbG8=",
          contentType: "text/plain",
          size: 5,
        },
      ],
    );

    assertEquals(saved.length, 1);
    assertEquals(saved[0].originalName, "hello world.txt");
    assertEquals(saved[0].savedName, "001_att-1_hello_world.txt");
    assertEquals(await Deno.readTextFile(saved[0].path), "hello");
    assertEquals(saved[0].isImage, false);

    const metadataPath = `${
      manager.getMessageAttachmentsDir(
        "thread-1",
        "message-1",
      )
    }/attachments.json`;
    assertEquals(JSON.parse(await Deno.readTextFile(metadataPath)), saved);
    assertEquals(
      await listFileNames(manager.getMessageAttachmentsDir(
        "thread-1",
        "message-1",
      )),
      [saved[0].savedName, "attachments.json"],
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("WorkspaceManager: 添付stream失敗時は既存ファイルとmanifestを保全する", async () => {
  const baseDir = await createTestDir("workspace_test_");
  try {
    const manager = new WorkspaceManager(baseDir);
    const attachments = [
      {
        id: "att-1",
        name: "first.txt",
        url: "data:,first",
        contentType: "text/plain",
        size: 5,
      },
      {
        id: "att-2",
        name: "photo.png",
        url: "data:,complete",
        contentType: "image/png",
        size: 8,
      },
    ];
    const original = await manager.saveMessageAttachments(
      "thread-1",
      "message-1",
      attachments,
    );
    const dir = manager.getMessageAttachmentsDir("thread-1", "message-1");
    const manifest = await Deno.readTextFile(`${dir}/attachments.json`);
    // These files belong to another job/recovery and must never be cleanup targets.
    await Deno.writeTextFile(`${dir}/.attachment-other-job.tmp`, "in progress");
    await Deno.writeTextFile(`${dir}/recovery.json`, "recover me");
    const names = await listFileNames(dir);
    const other = await manager.saveMessageAttachments(
      "thread-1",
      "message-2",
      [attachments[0]],
    );
    let sentChunk = false;
    const fetchStub = stub(globalThis, "fetch", (input) =>
      Promise.resolve(
        String(input) === attachments[0].url
          ? new Response("updated first")
          : new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (sentChunk) {
                  controller.error(new Error("attachment stream failed"));
                } else {
                  sentChunk = true;
                  controller.enqueue(new TextEncoder().encode("partial"));
                }
              },
            }, { highWaterMark: 0 }),
          ),
      ));
    try {
      await assertRejects(
        () =>
          manager.saveMessageAttachments("thread-1", "message-1", attachments),
        Error,
        "attachment stream failed",
      );
    } finally {
      fetchStub.restore();
    }

    assertEquals(sentChunk, true);
    assertEquals(await Deno.readTextFile(original[0].path), "updated first");
    assertEquals(await Deno.readTextFile(original[1].path), "complete");
    assertEquals(await Deno.readTextFile(`${dir}/attachments.json`), manifest);
    assertEquals(
      await Deno.readTextFile(`${dir}/.attachment-other-job.tmp`),
      "in progress",
    );
    assertEquals(await Deno.readTextFile(`${dir}/recovery.json`), "recover me");
    assertEquals(await Deno.readTextFile(other[0].path), "first");
    assertEquals(await listFileNames(dir), names);

    const retried = await manager.saveMessageAttachments(
      "thread-1",
      "message-1",
      [
        attachments[0],
        { ...attachments[1], url: "data:,replacement" },
      ],
    );
    assertEquals(await Deno.readTextFile(retried[1].path), "replacement");
    assertEquals(retried[1].isImage, true);
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${dir}/attachments.json`)),
      retried,
    );
    assertEquals(await listFileNames(dir), names);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("WorkspaceManager: 添付のwrite/rename失敗時は今回の一時ファイルだけ削除する", async (t) => {
  for (const operation of ["writeFile", "rename"] as const) {
    await t.step(operation, async () => {
      const baseDir = await createTestDir("workspace_test_");
      try {
        const manager = new WorkspaceManager(baseDir);
        const attachments = [{
          id: "att-1",
          name: "file.txt",
          url: "data:,complete",
          contentType: "text/plain",
          size: 8,
        }];
        const original = await manager.saveMessageAttachments(
          "thread-1",
          "message-1",
          attachments,
        );
        const dir = manager.getMessageAttachmentsDir("thread-1", "message-1");
        const manifest = await Deno.readTextFile(`${dir}/attachments.json`);
        await Deno.writeTextFile(
          `${dir}/.attachment-other-job.tmp`,
          "in progress",
        );
        const names = await listFileNames(dir);
        const failureStub = stub(
          Deno,
          operation,
          () => Promise.reject(new Error(`${operation} failed`)),
        );
        try {
          await assertRejects(
            () =>
              manager.saveMessageAttachments(
                "thread-1",
                "message-1",
                attachments,
              ),
            Error,
            `${operation} failed`,
          );
        } finally {
          failureStub.restore();
        }
        assertEquals(await Deno.readTextFile(original[0].path), "complete");
        assertEquals(
          await Deno.readTextFile(`${dir}/attachments.json`),
          manifest,
        );
        assertEquals(
          await Deno.readTextFile(`${dir}/.attachment-other-job.tmp`),
          "in progress",
        );
        assertEquals(await listFileNames(dir), names);
      } finally {
        await Deno.remove(baseDir, { recursive: true });
      }
    });
  }
});

Deno.test("WorkspaceManager: 一時ファイルはWORK_BASE_DIR配下に作成する", async () => {
  const baseDir = await createTestDir("workspace_test_");
  const originalTmpDir = Deno.env.get("TMPDIR");
  try {
    const manager = new WorkspaceManager(baseDir);
    await manager.initialize();

    Deno.env.set("TMPDIR", "tmpfile");
    const tempPath = await manager.createTempFile({
      prefix: "last-message-",
      suffix: ".txt",
    });

    assertEquals(tempPath.startsWith(`${manager.getTempDir()}/`), true);
    await Deno.writeTextFile(tempPath, "ok");
    assertEquals(await Deno.readTextFile(tempPath), "ok");
    await Deno.remove(tempPath);
  } finally {
    if (originalTmpDir === undefined) {
      Deno.env.delete("TMPDIR");
    } else {
      Deno.env.set("TMPDIR", originalTmpDir);
    }
    await Deno.remove(baseDir, { recursive: true });
  }
});
