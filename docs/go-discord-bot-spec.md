# Go版 Discord Codex Bot 仕様書（シンプル版 v2）

## 1. 目的

この Bot は **4コマンドのみ** を確実に動かすことを目的とする。

- `/chat`
- `/start <owner/repo>`
- `/stop`
- `/status`

上記以外の機能（例: devcontainer, PAT管理, 自動再開キュー, 翻訳, 複雑な権限UI）は v1 では実装しない。

---

## 2. 設計方針（最重要）

- 仕様は最小限、実装も最小限
- 1スレッド=1セッション
- 1セッション=同時に1実行のみ
- すべての実行は `codex exec`（現行レポジトリの新方式）で統一
- 失敗時は分かりやすい文言で返し、内部は構造化ログに記録

---

## 3. コマンド仕様

## 3.1 `/chat`

### 目的

リポジトリ非依存で、自然言語指示から Codex による CLI 作業を行う。

### 挙動

1. 実行チャンネルに新規スレッドを作成
2. `mode=chat` のセッションを作成
3. 作業ディレクトリ `workspaces/chat/<thread_id>` を作成
4. 初期メッセージを投稿

### スレッド内メッセージ

- 入力を Prompt として Codex に渡す
- 既存の `codex_session_id` があれば resume 実行

## 3.2 `/start <owner/repo>`

### 目的

現行 `/start` 相当の「特定レポジトリ作業スレッド」を開始する。

### repository 形式

- `owner/repo` のみ許可

### 挙動

1. repository 文字列を検証
2. ローカルキャッシュを ensure
   - パス: `repositories/<owner>/<repo>`
   - 未取得なら clone
   - 既存なら fetch + default branch 更新
3. 新規スレッドを作成
4. `mode=repo` セッション作成
5. 作業ディレクトリ `workspaces/repo/<thread_id>` を作成
   - 方式は「簡単で壊れにくい方法」を採用（コピーまたは worktree）
6. 初期メッセージを投稿

## 3.3 `/stop`

### 目的

スレッドの実行中 Codex プロセスを中断する。

### 挙動

1. 該当セッションの active run を取得
2. context cancel
3. SIGTERM
4. 一定時間で終了しなければ SIGKILL
5. run 状態を `stopped`

## 3.4 `/status`

### 目的

スレッドの現在状態と、残りトークン割合を確認する。

### 表示項目

- mode: `chat` or `repo`
- repository（repoモードのみ）
- 実行状態: `idle` / `running` / `stopped`
- 現在セッションID（あれば）
- トークン残り割合:
  - 5時間枠の残り割合
  - 1週間枠の残り割合

### 例

```text
Mode: repo
Repository: owner/repo
Run: running
Session: sess_xxx
Token Remaining: 5h 72% | 1w 91%
```

---

## 4. Codex 実行仕様（現行新方式に合わせる）

## 4.1 標準実行コマンド

以下の並びを標準とする（現行実装の新方式）。

```bash
codex --search exec --json --color never --dangerously-bypass-approvals-and-sandbox "$PROMPT"
```

## 4.2 resume 実行

```bash
codex --search exec --json --color never --dangerously-bypass-approvals-and-sandbox resume "$SESSION_ID" "$PROMPT"
```

## 4.3 備考

- `--verbose` はアプリの verbose 設定時のみ追加可
- 互換性フォールバック（旧 `--output-format stream-json` など）は v1 では実装しない
- 起動時に `codex exec --help` を確認し、必要フラグ非対応なら起動失敗とする

---

## 5. ストリーミング投稿仕様（シンプル）

## 5.1 進捗投稿

- Codex stdout(JSONL)を1行ずつ処理
- 表示用テキストが取れた行だけ Discord に進捗投稿
- 投稿間隔は 2 秒デバウンス
- 1,500文字でチャンク分割

## 5.2 最終返信

- `turn.completed` / `response.completed` の最終本文は進捗へは出さず、最終返信で返す
- 進捗と最終返信の二重投稿を防ぐ

## 5.3 失敗時

- JSON解析できない行は raw テキストで投稿して捨てない
- stderr は内部ログに保持し、ユーザーには要約して返す

---

## 6. トークン残量仕様（/status用）

## 6.1 取得方法

- Codex の usage 情報からトークン使用量を加算
- 加算式:
  - `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`

## 6.2 制限値

環境変数:

- `CODEX_LIMIT_5H_TOKENS`（必須）
- `CODEX_LIMIT_1W_TOKENS`（必須）

## 6.3 計算

- `usage_5h`: 直近5時間の合計
- `usage_1w`: 直近1週間の合計
- `remaining_ratio = max(0, 1 - usage/limit)`
- 表示は `%`（整数丸め）で返す

## 6.4 保存

- `token_usage_events` に `(timestamp_utc, tokens)` を保存
- /status 実行時に SQL 集計して算出

---

## 7. 最小アーキテクチャ

```text
cmd/bot/main.go
internal/config
internal/discord
internal/session
internal/codex
internal/workspace
internal/store
```

## 7.1 責務

- `discord`: コマンド受信、スレッド投稿
- `session`: セッション状態遷移と実行制御
- `codex`: プロセス起動、stdout/stderr処理、停止
- `workspace`: repo取得、作業ディレクトリ準備
- `store`: SQLite CRUD

## 7.2 同時実行制約

- 同一スレッドで実行中に新規メッセージが来たら:
  - 「実行中です。/stop で中断してください」を返す
  - キューは持たない（シンプル優先）

---

## 8. データモデル（SQLite）

## 8.1 tables

- `sessions`
  - `id`
  - `thread_id` (unique)
  - `mode` (`chat`/`repo`)
  - `repository` (nullable)
  - `workspace_path`
  - `codex_session_id` (nullable)
  - `status` (`active`/`closed`)
  - `created_at`, `updated_at`
- `runs`
  - `id`
  - `session_id`
  - `status` (`running`/`succeeded`/`failed`/`stopped`)
  - `prompt`
  - `exit_code` (nullable)
  - `error_summary` (nullable)
  - `started_at`, `ended_at`
- `token_usage_events`
  - `id`
  - `timestamp_utc`
  - `tokens`

## 8.2 ログファイル

- 生JSONL保存先:
  - `logs/sessions/<session_id>/<run_id>.jsonl`

---

## 9. エラーハンドリング

- 入力不正: 明確なメッセージ（例: `owner/repo 形式で指定してください`）
- 実行失敗: `Codex実行に失敗しました: <要約>`
- DB失敗: `内部エラーが発生しました。`
- すべての失敗を構造化ログへ記録

---

## 10. CI/CD（必要十分）

## 10.1 CI（PR）

1. `gofmt -s` check
2. `go vet ./...`
3. `golangci-lint run`
4. `go test ./... -race`

## 10.2 CD（main）

- Linux amd64 バイナリをビルド
- Docker image を GHCR へ push

## 10.3 リリース（tag）

- `v*` タグで GitHub Release 作成

---

## 11. AI Agent 実装ルール（簡潔）

- 変更は小さく（1PR=1責務）
- 仕様変更時はこのファイルを同時更新
- public interface にはコメントを付ける
- テストがないコードを merge しない

---

## 12. 受け入れ基準（DoD）

- `/chat`, `/start`, `/stop`, `/status` が動作する
- Codex は新方式コマンドで実行される
- `/status` で 5h/1w の残りトークン割合が見える
- 同一スレッド同時実行が防止される
- CI が常時グリーン
