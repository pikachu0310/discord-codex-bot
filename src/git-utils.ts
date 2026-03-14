import { join } from "std/path/mod.ts";
import { WorkspaceManager } from "./workspace/workspace.ts";
import { GIT } from "./constants.ts";
import { err, ok, Result } from "neverthrow";
import { exec } from "./utils/exec.ts";

// エラー型定義
export type GitUtilsError =
  | { type: "INVALID_REPOSITORY_NAME"; message: string }
  | { type: "REPOSITORY_NOT_FOUND"; path: string }
  | { type: "CLONE_FAILED"; error: string }
  | { type: "UPDATE_FAILED"; error: string }
  | { type: "WORKTREE_CREATE_FAILED"; error: string }
  | { type: "COMMAND_EXECUTION_FAILED"; command: string; error: string }
  | { type: "PERMISSION_ERROR"; path: string; error: string }
  | { type: "GH_CLI_ERROR"; command: string; error: string }
  | {
    type: "FILESYSTEM_ERROR";
    operation: string;
    path: string;
    error: string;
  };

export interface GitRepository {
  org: string;
  repo: string;
  fullName: string;
  localPath: string;
}

// ファイルシステム操作のヘルパー関数
async function statFile(
  path: string,
): Promise<Result<Deno.FileInfo, GitUtilsError>> {
  try {
    const stat = await Deno.stat(path);
    return ok(stat);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return err({
        type: "FILESYSTEM_ERROR",
        operation: "stat",
        path,
        error: "File or directory not found",
      });
    }
    return err({
      type: "FILESYSTEM_ERROR",
      operation: "stat",
      path,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function mkdirRecursive(
  path: string,
): Promise<Result<void, GitUtilsError>> {
  try {
    await Deno.mkdir(path, { recursive: true });
    return ok(undefined);
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      return err({
        type: "PERMISSION_ERROR",
        path,
        error: error.message,
      });
    }
    return err({
      type: "FILESYSTEM_ERROR",
      operation: "mkdir",
      path,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export function parseRepository(
  repoSpec: string,
): Result<GitRepository, GitUtilsError> {
  const match = repoSpec.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (!match) {
    return err({
      type: "INVALID_REPOSITORY_NAME",
      message: "リポジトリ名は <org>/<repo> 形式で指定してください",
    });
  }

  const [, org, repo] = match;
  return ok({
    org,
    repo,
    fullName: `${org}/${repo}`,
    localPath: join(org, repo),
  });
}

export async function ensureRepository(
  repository: GitRepository,
  workspaceManager: WorkspaceManager,
): Promise<
  Result<
    { path: string; wasUpdated: boolean; metadata?: RepoMetadata },
    GitUtilsError
  >
> {
  const fullPath = workspaceManager.getRepositoryPath(
    repository.org,
    repository.repo,
  );

  // ディレクトリが存在するかチェック
  const statResult = await statFile(fullPath);
  if (statResult.isOk() && statResult.value.isDirectory) {
    // 既存リポジトリを最新に更新
    const updateResult = await updateRepositoryWithGh(
      fullPath,
      GIT.DEFAULT_BRANCH,
    );
    if (updateResult.isErr()) {
      return err(updateResult.error);
    }
    return ok({ path: fullPath, wasUpdated: true });
  }

  // 親ディレクトリを作成
  const parentDir = join(workspaceManager.getRepositoriesDir(), repository.org);
  const mkdirResult = await mkdirRecursive(parentDir);
  if (mkdirResult.isErr()) {
    return err(mkdirResult.error);
  }

  // ghコマンドでリポジトリをclone
  const cloneResult = await cloneRepository(repository.fullName, fullPath);
  if (cloneResult.isErr()) {
    return err(cloneResult.error);
  }

  return ok({ path: fullPath, wasUpdated: false });
}

export interface RepoMetadata {
  name: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  language: string;
  updatedAt: string;
  isPrivate: boolean;
}

/**
 * ghコマンドを使用してリポジトリをクローンする
 */
async function cloneRepository(
  fullName: string,
  fullPath: string,
): Promise<Result<void, GitUtilsError>> {
  const execResult = await exec(`gh repo clone ${fullName} ${fullPath}`);

  if (execResult.isErr()) {
    const error = execResult.error;
    if (error.type === "COMMAND_FAILED") {
      return err({
        type: "GH_CLI_ERROR",
        command: "gh repo clone",
        error: `リポジトリのcloneに失敗しました: ${
          error.error || error.message
        }`,
      });
    }
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "gh repo clone",
      error: error.message,
    });
  }

  return ok(undefined);
}

async function updateRepositoryWithGh(
  repoPath: string,
  defaultBranch: string,
): Promise<Result<void, GitUtilsError>> {
  // リモートリポジトリから最新情報を取得
  const fetchResult = await exec(`cd "${repoPath}" && git fetch origin`);
  if (fetchResult.isErr()) {
    const error = fetchResult.error;
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "git fetch",
      error: `git fetchに失敗しました: ${error.error || error.message}`,
    });
  }

  // 現在のブランチがデフォルトブランチでない場合は切り替え
  const currentBranchResult = await getCurrentBranch(repoPath);
  if (currentBranchResult.isErr()) {
    return err(currentBranchResult.error);
  }
  const currentBranch = currentBranchResult.value;
  if (currentBranch !== defaultBranch) {
    // デフォルトブランチに切り替え
    const checkoutResult = await exec(
      `cd "${repoPath}" && git checkout ${defaultBranch}`,
    );
    if (checkoutResult.isErr()) {
      const error = checkoutResult.error;
      return err({
        type: "COMMAND_EXECUTION_FAILED",
        command: "git checkout",
        error: `git checkoutに失敗しました: ${error.error || error.message}`,
      });
    }
  }

  // デフォルトブランチを最新にリセット
  const resetResult = await exec(
    `cd "${repoPath}" && git reset --hard origin/${defaultBranch}`,
  );
  if (resetResult.isErr()) {
    const error = resetResult.error;
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "git reset",
      error: `git resetに失敗しました: ${error.error || error.message}`,
    });
  }
  return ok(undefined);
}

export async function isWorktreeCopyExists(
  worktreePath: string,
): Promise<boolean> {
  const statResult = await statFile(worktreePath);
  return statResult.isOk() && statResult.value.isDirectory;
}

/**
 * ブランチ名を生成する
 * フォーマット: worker/[yyyy-MM-dd]/worker-[hhmmss]-[workerName]
 */
export function generateBranchName(workerName: string): string {
  const now = new Date();

  // 日付部分: yyyy-MM-dd
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dateStr = `${year}-${month}-${day}`;

  // 時刻部分: hhmmss
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const timeStr = `${hours}${minutes}${seconds}`;

  return `worker/${dateStr}/worker-${timeStr}-${workerName}`;
}

/**
 * rsyncでリポジトリをコピーする
 */
async function copyRepository(
  repositoryPath: string,
  worktreePath: string,
): Promise<Result<void, GitUtilsError>> {
  const mkdirResult = await mkdirRecursive(worktreePath);
  if (mkdirResult.isErr()) {
    return err(mkdirResult.error);
  }

  const copyResult = await exec(
    `rsync -a "${repositoryPath}/" "${worktreePath}/"`,
  );
  if (copyResult.isErr()) {
    const error = copyResult.error;
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "rsync",
      error: `リポジトリのコピーに失敗しました: ${
        error.error || error.message
      }`,
    });
  }
  return ok(undefined);
}

/**
 * .gitディレクトリの存在を確認する
 */
async function checkGitDirectory(
  worktreePath: string,
): Promise<Result<boolean, GitUtilsError>> {
  const statResult = await statFile(`${worktreePath}/.git`);
  if (statResult.isErr()) {
    if (
      statResult.error.type === "FILESYSTEM_ERROR" &&
      statResult.error.error === "File or directory not found"
    ) {
      return ok(false);
    }
    return err(statResult.error);
  }
  return ok(true);
}

/**
 * 新しいブランチを作成する
 */
async function createNewBranch(
  worktreePath: string,
  branchName: string,
): Promise<Result<void, GitUtilsError>> {
  const checkoutResult = await exec(
    `cd "${worktreePath}" && git checkout -b ${branchName}`,
  );
  if (checkoutResult.isErr()) {
    const error = checkoutResult.error;
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "git checkout -b",
      error: `ブランチの作成に失敗しました: ${error.error || error.message}`,
    });
  }
  return ok(undefined);
}

/**
 * 新規リポジトリとして初期化する
 */
async function initializeNewRepository(
  worktreePath: string,
): Promise<Result<void, GitUtilsError>> {
  const initResult = await exec(`cd "${worktreePath}" && git init`);
  if (initResult.isErr()) {
    const error = initResult.error;
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "git init",
      error: `git initに失敗しました: ${error.error || error.message}`,
    });
  }
  return ok(undefined);
}

/**
 * Gitユーザー設定を行う
 */
async function configureGitUser(
  worktreePath: string,
): Promise<Result<void, GitUtilsError>> {
  const nameResult = await exec(
    `cd "${worktreePath}" && git config user.name "${GIT.BOT_USER_NAME}"`,
  );
  if (nameResult.isErr()) {
    const error = nameResult.error;
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "git config user.name",
      error: `git config user.nameに失敗しました: ${
        error.error || error.message
      }`,
    });
  }

  const emailResult = await exec(
    `cd "${worktreePath}" && git config user.email "${GIT.BOT_USER_EMAIL}"`,
  );
  if (emailResult.isErr()) {
    const error = emailResult.error;
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "git config user.email",
      error: `git config user.emailに失敗しました: ${
        error.error || error.message
      }`,
    });
  }
  return ok(undefined);
}

/**
 * ファイルのステージングとコミットを行う
 */
async function stageAndCommitFiles(
  worktreePath: string,
  workerName: string,
): Promise<Result<void, GitUtilsError>> {
  // 全てのファイルをステージング
  const addResult = await exec(`cd "${worktreePath}" && git add .`);
  if (addResult.isErr()) {
    const error = addResult.error;
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "git add",
      error: `git addに失敗しました: ${error.error || error.message}`,
    });
  }

  // 初期コミット
  const timestamp = Date.now();
  const commitResult = await exec(
    `cd "${worktreePath}" && git commit -m "Initial worktree copy for ${workerName} at ${timestamp}"`,
  );
  if (commitResult.isErr()) {
    const error = commitResult.error;
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "git commit",
      error: `git commitに失敗しました: ${error.error || error.message}`,
    });
  }
  return ok(undefined);
}

/**
 * ブランチ名を設定する
 */
async function renameBranch(
  worktreePath: string,
  branchName: string,
): Promise<Result<void, GitUtilsError>> {
  const branchResult = await exec(
    `cd "${worktreePath}" && git branch -m ${branchName}`,
  );
  if (branchResult.isErr()) {
    const error = branchResult.error;
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "git branch -m",
      error: `ブランチ名の設定に失敗しました: ${error.error || error.message}`,
    });
  }
  return ok(undefined);
}

export async function createWorktreeCopy(
  repositoryPath: string,
  workerName: string,
  worktreePath: string,
): Promise<Result<void, GitUtilsError>> {
  // リポジトリをコピー
  const copyResult = await copyRepository(repositoryPath, worktreePath);
  if (copyResult.isErr()) {
    return err({
      type: "WORKTREE_CREATE_FAILED",
      error: copyResult.error.type === "COMMAND_EXECUTION_FAILED"
        ? copyResult.error.error
        : copyResult.error.type === "PERMISSION_ERROR"
        ? copyResult.error.error
        : "リポジトリのコピーに失敗しました",
    });
  }

  // .gitディレクトリの存在を確認
  const gitDirResult = await checkGitDirectory(worktreePath);
  if (gitDirResult.isErr()) {
    return err({
      type: "WORKTREE_CREATE_FAILED",
      error: gitDirResult.error.type === "FILESYSTEM_ERROR"
        ? gitDirResult.error.error
        : "Gitディレクトリの確認に失敗しました",
    });
  }

  const hasGitDirectory = gitDirResult.value;

  if (hasGitDirectory) {
    // 既存のGitリポジトリの場合は新しいブランチを作成
    const branchName = generateBranchName(workerName);
    const branchResult = await createNewBranch(worktreePath, branchName);
    if (branchResult.isErr()) {
      return err({
        type: "WORKTREE_CREATE_FAILED",
        error: branchResult.error.type === "COMMAND_EXECUTION_FAILED"
          ? branchResult.error.error
          : "ブランチの作成に失敗しました",
      });
    }
  } else {
    // .gitディレクトリが存在しない場合（テスト環境など）
    // 新規リポジトリとして初期化
    const initResult = await initializeNewRepository(worktreePath);
    if (initResult.isErr()) {
      return err({
        type: "WORKTREE_CREATE_FAILED",
        error: initResult.error.type === "COMMAND_EXECUTION_FAILED"
          ? initResult.error.error
          : "リポジトリの初期化に失敗しました",
      });
    }

    // Gitユーザー設定
    const configResult = await configureGitUser(worktreePath);
    if (configResult.isErr()) {
      return err({
        type: "WORKTREE_CREATE_FAILED",
        error: configResult.error.type === "COMMAND_EXECUTION_FAILED"
          ? configResult.error.error
          : "Git設定の適用に失敗しました",
      });
    }

    // ファイルをステージングしてコミット
    const commitResult = await stageAndCommitFiles(worktreePath, workerName);
    if (commitResult.isErr()) {
      return err({
        type: "WORKTREE_CREATE_FAILED",
        error: commitResult.error.type === "COMMAND_EXECUTION_FAILED"
          ? commitResult.error.error
          : "初期コミットの作成に失敗しました",
      });
    }

    // ブランチ名を設定
    const branchName = generateBranchName(workerName);
    const renameResult = await renameBranch(worktreePath, branchName);
    if (renameResult.isErr()) {
      return err({
        type: "WORKTREE_CREATE_FAILED",
        error: renameResult.error.type === "COMMAND_EXECUTION_FAILED"
          ? renameResult.error.error
          : "ブランチ名の設定に失敗しました",
      });
    }
  }

  return ok(undefined);
}

async function getCurrentBranch(
  repoPath: string,
): Promise<Result<string, GitUtilsError>> {
  const branchResult = await exec(
    `cd "${repoPath}" && git branch --show-current`,
  );
  if (branchResult.isErr()) {
    const error = branchResult.error;
    return err({
      type: "COMMAND_EXECUTION_FAILED",
      command: "git branch --show-current",
      error: `現在のブランチの取得に失敗しました: ${
        error.error || error.message
      }`,
    });
  }
  return ok(branchResult.value.output.trim());
}
