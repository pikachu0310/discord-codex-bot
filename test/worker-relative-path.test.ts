import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { MessageFormatter } from "../src/worker/message-formatter.ts";

class TestMessageFormatter extends MessageFormatter {
  // テスト用にgetRelativePathをpublicにする
  public testGetRelativePath(filePath: string): string {
    // @ts-ignore - private メソッドにアクセス
    return this.getRelativePath(filePath);
  }
}

Deno.test("MessageFormatter.getRelativePath - worktreePathが設定されている場合", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // worktreePathを設定
    const worktreePath = "/Users/test/workspace/repositories/org/repo";
    const formatter = new TestMessageFormatter(worktreePath);

    // worktreePath内のファイル
    assertEquals(
      formatter.testGetRelativePath(`${worktreePath}/src/main.ts`),
      "src/main.ts",
    );

    // worktreePath外のファイル
    assertEquals(
      formatter.testGetRelativePath("/some/other/path/file.ts"),
      "file.ts",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("MessageFormatter.getRelativePath - リポジトリパターンの場合", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // worktreePathは設定しない
    const formatter = new TestMessageFormatter();

    // repositories ディレクトリ内のファイル
    assertEquals(
      formatter.testGetRelativePath(
        "/work/repositories/myorg/myrepo/src/index.ts",
      ),
      "src/index.ts",
    );

    // 別のリポジトリ
    assertEquals(
      formatter.testGetRelativePath(
        "/var/data/repositories/org2/repo2/README.md",
      ),
      "README.md",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("MessageFormatter.getRelativePath - threadsパターンの場合", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // worktreePathは設定しない
    const formatter = new TestMessageFormatter();

    // threads ディレクトリ内のworktree
    assertEquals(
      formatter.testGetRelativePath(
        "/work/threads/thread123/worktree/src/app.ts",
      ),
      "src/app.ts",
    );

    // 別のスレッド
    assertEquals(
      formatter.testGetRelativePath(
        "/data/threads/thread456/worktree/package.json",
      ),
      "package.json",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("MessageFormatter.getRelativePath - 特殊なケース", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const formatter = new TestMessageFormatter();

    // 空文字列
    assertEquals(formatter.testGetRelativePath(""), "");

    // パターンにマッチしない通常のパス
    assertEquals(
      formatter.testGetRelativePath("/usr/local/bin/some-file"),
      "some-file",
    );

    // worktreePathがルートディレクトリ終端のスラッシュあり
    const formatter2 = new TestMessageFormatter("/work/repo/");
    assertEquals(
      formatter2.testGetRelativePath("/work/repo/file.ts"),
      "file.ts",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("MessageFormatter.getRelativePath - Discord表示時の実際の使用", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // 実際のワークツリーパス例
    const worktreePath =
      "/Users/to-hutohu/workspace/codex-code-repos/worktrees/1234567890";
    const formatter = new TestMessageFormatter(worktreePath);

    // Read ツールの場合
    const filePath = `${worktreePath}/src/main.ts`;
    assertEquals(formatter.testGetRelativePath(filePath), "src/main.ts");

    // ネストしたディレクトリ
    const nestedPath = `${worktreePath}/src/components/Button/index.tsx`;
    assertEquals(
      formatter.testGetRelativePath(nestedPath),
      "src/components/Button/index.tsx",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
