import { join } from "std/path/mod.ts";
import { err, ok, Result } from "neverthrow";
import { exec } from "./utils/exec.ts";
import { WorkspaceManager } from "./workspace/workspace.ts";

export type GitUtilsError =
  | { type: "INVALID_REPOSITORY_NAME"; message: string }
  | { type: "CLONE_FAILED"; error: string }
  | { type: "UPDATE_FAILED"; error: string }
  | { type: "WORKTREE_CREATE_FAILED"; error: string }
  | { type: "COMMAND_EXECUTION_FAILED"; command: string; error: string };

export interface GitRepository {
  org: string;
  repo: string;
  fullName: string;
  localPath: string;
}

export interface RepoSetupResult {
  path: string;
  wasUpdated: boolean;
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
): Promise<Result<RepoSetupResult, GitUtilsError>> {
  const fullPath = workspaceManager.getRepositoryPath(
    repository.org,
    repository.repo,
  );

  const exists = await directoryExists(fullPath);
  if (exists) {
    const updateResult = await updateRepository(fullPath);
    if (updateResult.isErr()) {
      return err(updateResult.error);
    }
    return ok({ path: fullPath, wasUpdated: true });
  }

  await Deno.mkdir(
    join(workspaceManager.getRepositoriesDir(), repository.org),
    {
      recursive: true,
    },
  );

  const cloneResult = await exec(
    `git clone https://github.com/${repository.fullName}.git "${fullPath}"`,
  );
  if (cloneResult.isErr()) {
    return err({
      type: "CLONE_FAILED",
      error: cloneResult.error.error || cloneResult.error.message,
    });
  }

  return ok({ path: fullPath, wasUpdated: false });
}

async function updateRepository(
  repoPath: string,
): Promise<Result<void, GitUtilsError>> {
  const fetch = await exec(`cd "${repoPath}" && git fetch --all --prune`);
  if (fetch.isErr()) {
    return err({
      type: "UPDATE_FAILED",
      error: fetch.error.error || fetch.error.message,
    });
  }

  const defaultBranchResult = await exec(
    `cd "${repoPath}" && git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'`,
  );
  const defaultBranch = defaultBranchResult.isOk() &&
      defaultBranchResult.value.output.trim()
    ? defaultBranchResult.value.output.trim()
    : "main";

  const checkout = await exec(
    `cd "${repoPath}" && git checkout ${defaultBranch}`,
  );
  if (checkout.isErr()) {
    return err({
      type: "UPDATE_FAILED",
      error: checkout.error.error || checkout.error.message,
    });
  }

  const reset = await exec(
    `cd "${repoPath}" && git reset --hard origin/${defaultBranch}`,
  );
  if (reset.isErr()) {
    return err({
      type: "UPDATE_FAILED",
      error: reset.error.error || reset.error.message,
    });
  }
  return ok(undefined);
}

export async function isWorktreeCopyExists(
  worktreePath: string,
): Promise<boolean> {
  return await directoryExists(worktreePath);
}

export function generateBranchName(workerName: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const date = `${year}-${month}-${day}`;
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `worker/${date}/worker-${hh}${mm}${ss}-${workerName}`;
}

export async function createWorktreeCopy(
  repositoryPath: string,
  workerName: string,
  worktreePath: string,
): Promise<Result<void, GitUtilsError>> {
  await Deno.mkdir(worktreePath, { recursive: true });
  const rsync = await exec(`rsync -a "${repositoryPath}/" "${worktreePath}/"`);
  if (rsync.isErr()) {
    return err({
      type: "WORKTREE_CREATE_FAILED",
      error: rsync.error.error || rsync.error.message,
    });
  }

  const branchName = generateBranchName(workerName);
  const createBranch = await exec(
    `cd "${worktreePath}" && git checkout -b ${branchName}`,
  );

  if (createBranch.isErr()) {
    // テストや.gitが無いケース向けに最小初期化
    const init = await exec(`cd "${worktreePath}" && git init`);
    if (init.isErr()) {
      return err({
        type: "WORKTREE_CREATE_FAILED",
        error: init.error.error || init.error.message,
      });
    }
    await exec(`cd "${worktreePath}" && git config user.name "Discord Bot"`);
    await exec(
      `cd "${worktreePath}" && git config user.email "bot@example.com"`,
    );
    await exec(`cd "${worktreePath}" && git add .`);
    await exec(
      `cd "${worktreePath}" && git commit -m "Initial worktree copy for ${workerName}" || true`,
    );
    const rename = await exec(
      `cd "${worktreePath}" && git branch -m ${branchName}`,
    );
    if (rename.isErr()) {
      return err({
        type: "WORKTREE_CREATE_FAILED",
        error: rename.error.error || rename.error.message,
      });
    }
  }

  return ok(undefined);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch {
    return false;
  }
}
