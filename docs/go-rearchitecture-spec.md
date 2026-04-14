# Discord Codex Bot 現行実装 完全仕様書（Goリアーキテクト用）

最終更新: 2026-04-09\
対象: 本リポジトリの Deno/TypeScript 実装

## 1. 目的

本仕様書は、現行実装を **Goで挙動差分なく再構築**
するための基準書である。以下を統合する。

- 実行時仕様
- 状態遷移とフォールバック
- 永続化フォーマット（JSON/JSONL）
- Discordコマンド仕様
- テスト保証範囲
- ファイル構成

## 2. システム概要

Discord Bot が `/start owner/repo` でスレッドを作成し、スレッド単位で Codex CLI
実行を管理する。\
基本構成は `main` / `Admin` / `Worker` / `WorkspaceManager` の4層。

- `main.ts`: Discordイベント、Slash Command、起動処理
- `Admin`: Worker管理、ルーティング、復旧、レート制限・devcontainer統制
- `Worker`: Codex実行・ストリーム解析・セッション保存・中断
- `WorkspaceManager`: 全永続化（threads/workers/sessions/audit/pats 等）

## 3. 実行環境

### 3.1 依存

- Deno 2.x
- discord.js v14
- neverthrow
- zod
- @google/genai

### 3.2 必須/推奨コマンド

必須:

- `git`
- `codex`

推奨:

- `gh`
- `devcontainer`

実装上の注意:

- システムチェック上 `gh` は推奨扱いだが、新規cloneは `gh repo clone`
  固定実装であり、`gh` が無いと新規取得は失敗する。

### 3.3 環境変数

必須:

- `DISCORD_TOKEN`
- `WORK_BASE_DIR`

任意:

- `VERBOSE`
- `CODEX_APPEND_SYSTEM_PROMPT`
- `CODEX_CODE_MAX_OUTPUT_TOKENS`
- `CODEX_CLI_OUTPUT_FORMAT_MODE` (`auto|always|never`)
- `GEMINI_API_KEY`
- `PLAMO_TRANSLATOR_URL`
- `CODEX_LIMIT_5H_TOKENS`
- `CODEX_LIMIT_1W_TOKENS`

## 4. 主要定数

- レート制限自動再開: 5分 (`300000ms`)
- Discord分割長: `1500`（上限2000より低く運用）
- Devcontainer進捗更新: `2000ms`
- Devcontainer通知最短間隔: `1000ms`
- Devcontainerログ保持行: `30`
- Worker停止猶予: `5000ms`
- Codex最大出力トークン既定: `25000`
- コンテキスト圧縮閾値: `180000 token`
- 圧縮後目標: `100000 token`
- 圧縮時に保持する最新件数: `10`

## 5. ディレクトリと永続化

`WORK_BASE_DIR` 配下:

- `repositories/{org}/{repo}`: ベースclone
- `worktrees/{threadId}`: スレッド作業コピー
- `threads/{threadId}.json`: ThreadInfo
- `workers/{threadId}.json`: WorkerState
- `admin/active_threads.json`: AdminState
- `sessions/{owner}/{repo}/{timestamp}_{sessionId}.jsonl`: 生セッションログ
- `audit/{yyyy-mm-dd}/activity.jsonl`: 監査ログ
- `pats/{owner_repo}.json`: PAT保存
- `queued_messages/{threadId}.json`: キュー保存

### 5.1 ThreadInfo

- `threadId`
- `repositoryFullName: string | null`
- `repositoryLocalPath: string | null`
- `worktreePath: string | null`
- `createdAt`
- `lastActiveAt`
- `status: active | inactive | archived`

### 5.2 WorkerState

- `workerName`
- `threadId`
- `threadName?`
- `repository? { fullName, org, repo }`
- `repositoryLocalPath?`
- `worktreePath?: string | null`
- `devcontainerConfig`
  - `useDevcontainer`
  - `useFallbackDevcontainer`
  - `hasDevcontainerFile`
  - `hasAnthropicsFeature`
  - `containerId?`
  - `isStarted`
- `sessionId?: string | null`
- `status: active | inactive | archived`
- `rateLimitTimestamp?`
- `autoResumeAfterRateLimit?`
- `queuedMessages?`
- `createdAt`
- `lastActiveAt`
- `isPlanMode?`

### 5.3 AdminState

- `activeThreadIds: string[]`
- `lastUpdated`

### 5.4 重要な実装事実

- PATは実装上は平文JSON保存（暗号化なし）。
- Queue機構は `QueueManager` と `workerState.queuedMessages`
  の2系統があり、レート制限実処理は後者を主に利用。

## 6. Discord仕様

### 6.1 Slash Command

- `/start <repository>`
- `/set-pat <repository> <token> [description]`
- `/list-pats`
- `/delete-pat <repository>`
- `/stop`
- `/plan`
- `/close`

### 6.2 `/start` 処理

1. `owner/repo` を厳格パース
2. `ensureRepository` 実行
   - 既存repo: `git fetch` + 必要に応じ checkout main +
     `git reset --hard origin/main`
   - 新規repo: `gh repo clone`
3. Discordスレッド作成（1週間 auto archive）
4. `Admin.createWorker(threadId)`
5. `worker.setRepository(repository, localPath)`（worktreeコピー作成）
6. devcontainer有無チェック、必要なら選択ボタン表示
7. 挨拶メッセージ投稿

### 6.3 `/stop`

- スレッド内限定。
- Worker未存在でエラーメッセージ。
- 実行中なら中断（Abort + SIGTERM + 必要ならSIGKILL）。

### 6.4 `/plan`

- スレッド内限定。
- Workerの `isPlanMode` を true にし永続化。
- 次回実行時、append-system-promptに plan mode 指示文を付加。

### 6.5 `/close`

- スレッド内限定 + 確認ボタン付き。
- 実行時 `terminateThread` 相当で完全クリーンアップ。

### 6.6 テキストコマンド

`/config devcontainer on|off` は MessageCreate で処理される（Slash Command
ではない）。

### 6.7 ThreadUpdate

`archived: false -> true` へ変化時のみ `Admin.terminateThread(threadId)` 実行。

## 7. Admin仕様

Adminは以下サブマネージャを保持:

- `WorkerManager`
- `MessageRouter`
- `RateLimitManager`
- `DevcontainerManager`

### 7.1 Worker作成

- 既存Workerがあれば再利用。
- 新規は `generateWorkerName()`（`adjective-animal`）。
- ThreadInfo/WorkerState保存。
- `activeThreadIds` へ追加。
- 監査ログ `worker_created` を記録。

### 7.2 復旧

`restoreActiveThreads()`:

1. activeThreadIds走査
2. ThreadInfo不在またはarchivedを除外
3. worktree実体確認
4. `git worktree list --porcelain` 整合確認
5. 欠損時はスレッドを archived 化
6. WorkerStateがあれば `Worker.fromState` で復元
7. レート制限タイマーを復旧

### 7.3 終了

`terminateThread(threadId)`:

1. Workerを管理Mapから除去
2. devcontainer削除
3. worktree削除
4. レート制限タイマー削除
5. WorkerState/ThreadInfo を `archived` 化
6. activeThreadIds から削除
7. 監査ログ記録
8. Discord thread archive callback 呼び出し

## 8. MessageRouter仕様

処理順:

1. レート制限中判定
2. 制限中なら `queueMessage` して即時案内文返却
3. Worker取得（なければ `WORKER_NOT_FOUND`）
4. リアクション `👀`
5. 監査ログ `message_received`
6. `worker.processMessage(...)`
7. RATE_LIMIT発生時は RateLimitManager へ委譲して案内文返却

## 9. RateLimitManager仕様

### 9.1 検出時

- `workerState.rateLimitTimestamp` 設定
- `autoResumeAfterRateLimit=true`
- 5分後タイマー設定
- Presenceを制限中表示へ変更

### 9.2 自動再開

- 期限到達後、状態が有効なら `queuedMessages` の先頭1件のみ再送。
- 再送後にキュー配列を空にして保存。
- Presenceを通常へ復帰。

### 9.3 再起動復旧

- `workers/*.json` から rate-limit対象を抽出。
- 期限超過済みは即時実行、未到達は残時間で再設定。

### 9.4 トークン使用量

- 入出力トークンを集計。
- Presenceに使用率を表示。
- 24h基準 + 任意5h/1w上限の%表示。

## 10. Devcontainer仕様

### 10.1 検出

探索順:

1. `.devcontainer/devcontainer.json`
2. `.devcontainer.json`

`features` に anthropics/devcontainer-features があるか判定。

### 10.2 config選択

- リポジトリ設定があればそれを使用
- なければ `fallback_devcontainer/.devcontainer/devcontainer.json`

### 10.3 起動

`devcontainer up --workspace-folder ... --config ... --log-level debug --log-format json`

- stdout JSON行を解析
- 重要イベントは即時通知
- 周期タイマーでも進捗投稿
- 成功時は containerId を state保存

### 10.4 実行分岐

- devcontainerファイルなし: ローカル実行 + 権限skip trueへ自動設定
- devcontainerファイルあり + CLIなし:
  ローカル実行を案内（権限チェック有/無ボタン）
- devcontainerファイルあり + CLIあり: devcontainer利用/ローカル選択ボタン
- fallback devcontainer選択経路あり

### 10.5 削除

`docker rm -f -v <containerId>`

- No such container は許容
- finally で `containerId`/`isStarted` を必ずクリア

## 11. Git仕様

### 11.1 parseRepository

`^([a-zA-Z0-9_-]+)/([a-zA-Z0-9_.-]+)$` を満たす場合のみ成功。

### 11.2 ensureRepository

- 既存repo: fetch + (必要時 checkout main) + hard reset
- 新規repo: `gh repo clone`

### 11.3 worktree（実体はコピー）

`createWorktreeCopy`:

1. `rsync -a` でコピー
2. `.git` があれば新規branch作成
3. `.git` がなければ `git init` -> user config -> add/commit -> branch rename

## 12. Worker仕様（コア）

### 12.1 基本フロー

1. repository/worktree未設定なら `REPOSITORY_NOT_SET`
2. 設定未完了なら `CONFIGURATION_INCOMPLETE`
3. 翻訳（有効時のみ）
4. 進捗通知 `🤖 Codexが考えています...`
5. リアクション `⚙️`
6. Codex実行
7. ストリーム解析して進捗投稿
8. 最終結果返却

### 12.2 Plan mode

`isPlanMode=true` の場合、append-system-promptに計画モード文言を連結注入。

### 12.3 CLI能力判定

`codex --help`, `codex exec --help` を解析して以下を判定:

- exec json
- color
- resume
- dangerously-bypass
- search
- output-format
- verbose
- dangerously-skip-permissions

未判定時は基本的に「対応あり」と仮定して進む実装。

### 12.4 フォールバック挙動（最重要）

非互換エラー検知時に順次無効化・再試行する。テストで順序が固定されている。

- `--output-format` 無効化
- `--verbose` 無効化
- `--dangerously-skip-permissions` 無効化
- `--search` 無効化
- `exec/--json/resume` 非対応ならレガシーモード
- `--color` 無効化
- `--dangerously-bypass-approvals-and-sandbox` 無効化 -> 旧フラグへ

TTY要求 (`stdout is not a terminal`) の場合:

- 次回試行を PTY モード（`script` 経由）へ切替
- それでも失敗なら実行失敗として返却

### 12.5 ストリーム解析

`CodexStreamProcessor` で legacy / exec-json を統合処理。

抽出対象:

- assistant text
- tool_use / tool_result
- command metadata/command output delta
- response error
- turn.completed / response.completed
- session id
- usage token

最終レスポンスイベントは進捗投稿に流さず、最終返信として返す。

### 12.6 セッション保存

- sessionId 更新
- 生JSONLを `sessions/...` へ保存（追記）
- interruptionイベントもJSONLに追記

### 12.7 中断

`stopExecution`:

- 非実行中は `false`
- 実行中は abort + SIGTERM + 5秒超でSIGKILL
- interruptionログを保存

### 12.8 コンテキスト圧縮

閾値超過時、古い履歴を1要約メッセージへ圧縮し最新10件を保持して同ファイルへ上書き。

## 13. メッセージ整形仕様

- ANSI除去
- ツールアイコン付与（Bash/Read/Write/Todo等）
- Bashは `bash` で整形
- ツール結果はコードブロック化
- TodoWrite成功定型文は非表示
- 1500文字ごと分割。コードフェンス整合を保って分割。

## 14. 翻訳・要約仕様

### 14.1 PLaMo翻訳

- `PLAMO_TRANSLATOR_URL` 設定時のみ使用
- `/v1/chat/completions` 呼び出し
- 失敗時は原文継続（フェイルオープン）

### 14.2 Gemini要約

条件:

- `GEMINI_API_KEY` がある
- スレッド名が仮名パターン (`owner/repo-<timestamp>`)

処理:

- 最初のユーザーメッセージを30文字要約
- `要約(repo)` にrename（owner除去）

## 15. エラー処理方針

- `neverthrow.Result` で明示的に伝播
- 監査ログ等の副作用失敗は主要フローを止めない
- CLI/JSON/schema異常は種別ごとにハンドリング

## 16. テストが固定している重要挙動

特に強い保証:

1. CLI互換フォールバック順（`worker_output_format_fallback_test.ts`）
2. レート制限保存/復旧/自動再開
3. Worker中断ログ（interruption reason/executionTime/lastActivity）
4. stream parser の抽出挙動
5. Workspaceの永続化とschema検証
6. Admin復旧とthread terminate

## 17. Go移植時の同等性チェック項目

1. Slash Command入力制約と返信文面
2. 永続化JSONキー/型/nullable仕様
3. レート制限5分遅延と復旧後処理
4. CLIフォールバック順
5. PTYフォールバック（`script`）
6. sessionId復元（stderr hint含む）
7. Discordチャンク分割のコードフェンス維持
8. devcontainer fallback config選択
9. thread archiveイベントでの後始末
10. audit fail-open

## 18. 全ファイル一覧

```text
.devcontainer/.env.devcontainer
.devcontainer/devcontainer.json
.env.example
.githooks/commit-msg
.githooks/pre-commit
.githooks/pre-push
.github/workflows/ci.yml
.gitignore
CODEX.md
README.md
deno.json
deno.lock
docs/autocomplete.md
docs/devcontainer-cli-options.md
docs/discord.md
docs/go-rearchitecture-spec.md
docs/images/discord-codex-overview.png
docs/neverthrow.md
docs/translation.md
fallback_devcontainer/.devcontainer/devcontainer.json
sample.txt
scripts/deno-check-quiet.ts
scripts/deno-fmt-quiet.ts
scripts/deno-lint-quiet.ts
scripts/deno-test-quiet.ts
scripts/run-quality-checks.sh
setup-hooks.sh
src/admin/admin.ts
src/admin/admin_devcontainer_test.ts
src/admin/admin_test.ts
src/admin/devcontainer-manager.ts
src/admin/devcontainer-manager_test.ts
src/admin/message-router.ts
src/admin/message-router_test.ts
src/admin/rate-limit-manager.ts
src/admin/rate-limit-manager_test.ts
src/admin/types.ts
src/admin/worker-manager.ts
src/admin/worker-manager_test.ts
src/constants.ts
src/devcontainer.ts
src/devcontainer_fallback_test.ts
src/devcontainer_test.ts
src/env.ts
src/env_test.ts
src/gemini.ts
src/gemini_test.ts
src/git-utils.ts
src/git-utils_test.ts
src/main.ts
src/plamo-translator.ts
src/plamo-translator_test.ts
src/schemas/external-api-schema.ts
src/services/context-compressor.ts
src/services/context-compressor_test.ts
src/system-check.ts
src/system-check_test.ts
src/token-usage-tracker.ts
src/token-usage-tracker_test.ts
src/utils/devcontainer-progress.ts
src/utils/discord-message.ts
src/utils/discord-message_test.ts
src/utils/exec.ts
src/utils/token-counter.ts
src/utils/token-counter_test.ts
src/worker-name-generator.ts
src/worker/codex-cli-capabilities.ts
src/worker/codex-executor.ts
src/worker/codex-stream-processor-extract_test.ts
src/worker/codex-stream-processor-parse_test.ts
src/worker/codex-stream-processor-task-agent_test.ts
src/worker/codex-stream-processor.ts
src/worker/codex-stream-processor_test.ts
src/worker/message-formatter.ts
src/worker/message-formatter_test.ts
src/worker/session-logger.ts
src/worker/session-logger_test.ts
src/worker/types.ts
src/worker/worker-configuration.ts
src/worker/worker-configuration_test.ts
src/worker/worker-configuration_token_test.ts
src/worker/worker.ts
src/worker/worker_interruption_test.ts
src/worker/worker_stop_execution_test.ts
src/worker_append_system_prompt_test.ts
src/worker_devcontainer_test.ts
src/worker_output_format_fallback_test.ts
src/worker_translation_test.ts
src/workspace/audit-logger.ts
src/workspace/audit-logger_test.ts
src/workspace/pat-manager.ts
src/workspace/pat-manager_test.ts
src/workspace/queue-manager.ts
src/workspace/queue-manager_test.ts
src/workspace/schemas/admin-schema.ts
src/workspace/schemas/audit-schema.ts
src/workspace/schemas/index.ts
src/workspace/schemas/pat-schema.ts
src/workspace/schemas/queue-schema.ts
src/workspace/schemas/schema_test.ts
src/workspace/schemas/session-schema.ts
src/workspace/schemas/thread-schema.ts
src/workspace/session-manager.ts
src/workspace/session-manager_test.ts
src/workspace/thread-manager.ts
src/workspace/thread-manager_test.ts
src/workspace/types.ts
src/workspace/workspace.ts
src/workspace_queue_test.ts
start-dev.sh
start-prod.sh
test-format.ts
test/admin.test.ts
test/close-command.test.ts
test/devcontainer-pat.test.ts
test/devcontainer-streaming.test.ts
test/git-utils.test.ts
test/integration.test.ts
test/persistence_integration.test.ts
test/plan-command.test.ts
test/rate-limit.test.ts
test/stop-command-integration.test.ts
test/stop-command.test.ts
test/test-utils.ts
test/thread-close-event.test.ts
test/worker-relative-path.test.ts
test/worker-streaming.test.ts
test/worker.test.ts
test/workspace-pat.test.ts
test/workspace.test.ts
tests/workspace_test.ts
```
