import { assertEquals } from "std/assert/mod.ts";
import { generateBranchName, parseRepository } from "../src/git-utils.ts";

Deno.test("parseRepository関数のテスト", async (t) => {
  await t.step("正常なリポジトリ名をパースできる", () => {
    const result = parseRepository("owner/repo");
    assertEquals(result.isOk(), true);
    if (result.isOk()) {
      assertEquals(result.value.org, "owner");
      assertEquals(result.value.repo, "repo");
      assertEquals(result.value.fullName, "owner/repo");
      assertEquals(result.value.localPath, "owner/repo");
    }
  });

  await t.step(
    "ハイフンとアンダースコアを含むリポジトリ名をパースできる",
    () => {
      const result = parseRepository("my-org_123/my-repo.test");
      assertEquals(result.isOk(), true);
      if (result.isOk()) {
        assertEquals(result.value.org, "my-org_123");
        assertEquals(result.value.repo, "my-repo.test");
        assertEquals(result.value.fullName, "my-org_123/my-repo.test");
        assertEquals(result.value.localPath, "my-org_123/my-repo.test");
      }
    },
  );

  await t.step("不正なフォーマットでエラーが発生する", () => {
    const result = parseRepository("invalid");
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
  });

  await t.step("スラッシュが複数ある場合エラーが発生する", () => {
    const result = parseRepository("org/repo/invalid");
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
  });

  await t.step("空文字列でエラーが発生する", () => {
    const result = parseRepository("");
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
  });
});

Deno.test("generateBranchName関数のテスト", async (t) => {
  await t.step("正しいフォーマットのブランチ名を生成する", () => {
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

  await t.step("日付と時刻が正しい形式で含まれる", () => {
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

  await t.step("異なるworkerNameでも正しく動作する", () => {
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

  await t.step("連続して呼び出しても異なるブランチ名を生成する", () => {
    const workerName = "test-worker";
    const branchName1 = generateBranchName(workerName);
    // 1秒待機して異なる時刻を確保
    const start = Date.now();
    while (Date.now() - start < 1000) {
      // 1秒待機
    }
    const branchName2 = generateBranchName(workerName);

    // 時刻が異なるため、ブランチ名も異なるはず
    assertEquals(branchName1 !== branchName2, true);
  });
});
