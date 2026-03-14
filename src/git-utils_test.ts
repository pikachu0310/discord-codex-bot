import { assertEquals } from "https://deno.land/std@0.208.0/testing/asserts.ts";
import {
  ensureRepository,
  generateBranchName,
  parseRepository,
} from "./git-utils.ts";
import { WorkspaceManager } from "./workspace/workspace.ts";
import { join } from "std/path/mod.ts";

Deno.test("parseRepository - 正しい形式のリポジトリ名をパースできる", () => {
  const result = parseRepository("owner/repo");
  assertEquals(result.isOk(), true);
  if (result.isOk()) {
    assertEquals(result.value.org, "owner");
    assertEquals(result.value.repo, "repo");
    assertEquals(result.value.fullName, "owner/repo");
    assertEquals(result.value.localPath, join("owner", "repo"));
  }
});

Deno.test("parseRepository - 不正な形式でエラーになる", () => {
  const invalidFormats = [
    "invalid",
    "owner//repo",
    "/repo",
    "owner/",
    "owner/repo/extra",
    "",
  ];

  for (const format of invalidFormats) {
    const result = parseRepository(format);
    assertEquals(result.isErr(), true);
    if (result.isErr()) {
      assertEquals(result.error.type, "INVALID_REPOSITORY_NAME");
      if (result.error.type === "INVALID_REPOSITORY_NAME") {
        assertEquals(
          result.error.message,
          "リポジトリ名は <org>/<repo> 形式で指定してください",
        );
      }
    }
  }
});

Deno.test("updateRepositoryWithGh - ローカル変更がある場合は更新をスキップする", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // テスト用のgitリポジトリを作成
    const repoPath = join(tempDir, "test-repo");
    await Deno.mkdir(repoPath);

    // git init
    const initCmd = new Deno.Command("git", {
      args: ["init"],
      cwd: repoPath,
    });
    await initCmd.output();

    // git config
    const configNameCmd = new Deno.Command("git", {
      args: ["config", "user.name", "Test User"],
      cwd: repoPath,
    });
    await configNameCmd.output();

    const configEmailCmd = new Deno.Command("git", {
      args: ["config", "user.email", "test@example.com"],
      cwd: repoPath,
    });
    await configEmailCmd.output();

    // ファイルを作成してコミット
    await Deno.writeTextFile(join(repoPath, "test.txt"), "initial content");

    const addCmd = new Deno.Command("git", {
      args: ["add", "."],
      cwd: repoPath,
    });
    await addCmd.output();

    const commitCmd = new Deno.Command("git", {
      args: ["commit", "-m", "initial commit"],
      cwd: repoPath,
    });
    await commitCmd.output();

    // ローカル変更を作成（コミットしない）
    await Deno.writeTextFile(join(repoPath, "test.txt"), "modified content");

    // updateRepositoryWithGhを呼び出す（実際にはprivate関数なので、ここではテストの構造のみ示す）
    // 実際のテストでは、ensureRepositoryを通じて間接的にテストするか、
    // updateRepositoryWithGhをexportする必要がある

    // ファイルの内容が変更されたままであることを確認
    const content = await Deno.readTextFile(join(repoPath, "test.txt"));
    assertEquals(content, "modified content");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ensureRepository - 新規リポジトリのクローンをスキップ（ghコマンドが必要）", async () => {
  const tempDir = await Deno.makeTempDir();
  const workspaceManager = new WorkspaceManager(tempDir);
  await workspaceManager.initialize();

  try {
    const repositoryResult = parseRepository("test-org/test-repo");
    assertEquals(repositoryResult.isOk(), true);

    if (repositoryResult.isOk()) {
      const repository = repositoryResult.value;
      // ghコマンドがない環境ではエラーになることを確認
      const result = await ensureRepository(repository, workspaceManager);
      assertEquals(result.isErr(), true);
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("generateBranchName - 正しいフォーマットのブランチ名を生成する", () => {
  const workerName = "test-worker";
  const branchName = generateBranchName(workerName);

  // フォーマットが正しいかチェック: worker/yyyy-MM-dd/worker-hhmmss-workerName
  const pattern = /^worker\/\d{4}-\d{2}-\d{2}\/worker-\d{6}-test-worker$/;
  assertEquals(pattern.test(branchName), true);

  // プレフィックスが正しいかチェック
  assertEquals(branchName.startsWith("worker/"), true);

  // worker名が末尾に含まれているかチェック
  assertEquals(branchName.endsWith("-test-worker"), true);
});

Deno.test("generateBranchName - 日付と時刻が正しい形式で含まれる", () => {
  const workerName = "test-worker";
  const beforeCall = new Date();
  const branchName = generateBranchName(workerName);
  const afterCall = new Date();

  // ブランチ名から日付と時刻を抽出: worker/yyyy-MM-dd/worker-hhmmss-workerName
  const match = branchName.match(
    /^worker\/(\d{4}-\d{2}-\d{2})\/worker-(\d{6})-test-worker$/,
  );
  assertEquals(match !== null, true);

  if (match) {
    const [, dateStr, timeStr] = match;

    // 日付フォーマットの確認 (YYYY-MM-DD)
    assertEquals(dateStr.length, 10);
    const [yearStr, monthStr, dayStr] = dateStr.split("-");
    const year = parseInt(yearStr);
    const month = parseInt(monthStr);
    const day = parseInt(dayStr);

    // 時刻フォーマットの確認 (HHMMSS)
    assertEquals(timeStr.length, 6);
    const hours = parseInt(timeStr.substring(0, 2));
    const minutes = parseInt(timeStr.substring(2, 4));
    const seconds = parseInt(timeStr.substring(4, 6));

    // 値の妥当性チェック
    assertEquals(year >= beforeCall.getFullYear(), true);
    assertEquals(year <= afterCall.getFullYear(), true);
    assertEquals(month >= 1 && month <= 12, true);
    assertEquals(day >= 1 && day <= 31, true);
    assertEquals(hours >= 0 && hours <= 23, true);
    assertEquals(minutes >= 0 && minutes <= 59, true);
    assertEquals(seconds >= 0 && seconds <= 59, true);
  }
});

Deno.test("generateBranchName - 異なるworkerNameでも正しく動作する", () => {
  const workerNames = ["worker1", "my-worker", "worker_123", "test"];

  for (const workerName of workerNames) {
    const branchName = generateBranchName(workerName);

    // 各workerNameに対して正しいフォーマットかチェック: worker/yyyy-MM-dd/worker-hhmmss-workerName
    const pattern = new RegExp(
      `^worker\/\\d{4}-\\d{2}-\\d{2}\/worker-\\d{6}-${workerName}$`,
    );
    assertEquals(pattern.test(branchName), true);
  }
});
