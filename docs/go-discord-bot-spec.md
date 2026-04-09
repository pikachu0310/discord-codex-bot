# Go版 Discord Codex Bot 仕様書（v1.0）

## 1. 目的

本仕様書は、現行 `discord-codex-bot` の運用価値を引き継ぎつつ、以下を満たす Go 実装の新規 Discord Bot を定義する。

- `/chat`: 自然言語で CLI 操作・対話を行う汎用セッション
- `/start <owner/repo>`: 対象リポジトリに特化した作業セッション（現行 `/start` 相当）
- すべての実行を `codex exec` で統一
- CI/CD・運用・監査を最初から組み込む
- 「AI Agent が継続的に実装する前提」で、理解しやすいコード構造・文書構造を強制する

## 2. 現行実装から継承する要点

### 2.1 体験要件

- Discord でスレッドを作成し、スレッド単位でセッションを隔離する
- Codex のストリーミング進捗を Discord に逐次投稿する
- 最終回答は進捗と重複させず、返信として返す
- `/stop` で実行中プロセスを中断できる
- セッション状態（session_id, スレッド状態）を永続化し、再起動後に復元する

### 2.2 実装上の改善方針

- 巨大クラス化（Admin/Worker）を禁止し、責務を小さく分離する
- ドメイン状態は SQLite、実行ログは JSONL ファイルへ分離
- 実行ランナー・ストリーム整形・Discord 配信を独立モジュール化する

## 3. スコープ

### 3.1 In Scope

- Discord スラッシュコマンド: `/chat`, `/start`, `/stop`, `/close`, `/status`
- 1スレッド=1セッションの実行制御
- GitHub リポジトリ取得・更新・作業ディレクトリ分離
- Codex JSON ストリームの解析、進捗投稿、最終返信
- 永続化（SQLite + JSONL）
- GitHub Actions による CI/CD

### 3.2 Out of Scope（v1では対象外）

- 複数 LLM 実行エンジン切替
- Web UI 管理画面
- 複雑なマルチテナント認可

## 4. コマンド仕様

### 4.1 `/chat`

- 目的: リポジトリ非依存で自然言語 CLI 対話を行う
- 挙動:
  1. 実行チャンネル直下に作業スレッドを新規作成
  2. モード `chat` の Session を作成
  3. 作業ディレクトリ `workspaces/chat/<thread_id>` を作成
  4. 初期メッセージ投稿（使い方、`/stop` 案内）
- メッセージ入力時:
  - スレッド内のユーザー発言を Prompt として Codex 実行
  - 既存 session_id がある場合は resume 実行

### 4.2 `/start <repository>`

- repository 形式: `owner/repo`
- 目的: 指定リポジトリ作業に特化したセッション開始
- 挙動:
  1. repository を検証
  2. ローカルキャッシュ（`repositories/<owner>/<repo>`）を ensure
     - 未取得: clone
     - 既存: fetch + default branch fast-forward（破壊的 reset は設定で選択可）
  3. スレッド作成
  4. モード `repo` Session 作成
  5. セッション専用作業ディレクトリ生成（`workspaces/repo/<thread_id>`）
  6. 初期ガイダンス投稿

### 4.3 `/stop`

- 対象: スレッド内のアクティブ実行
- 挙動:
  - 対象実行の context cancel
  - SIGTERM 送信
  - タイムアウト時 SIGKILL
  - 実行状態を `stopped` として保存

### 4.4 `/close`

- 対象: スレッドセッション
- 挙動:
  - 実行中なら停止
  - Session 状態を `closed`
  - スレッド archive

### 4.5 `/status`

- 表示内容:
  - mode (`chat` / `repo`)
  - repository（repo mode のみ）
  - run state (`idle` / `running` / `stopped`)
  - 最終実行時刻、最新 session_id

## 5. Codex 実行仕様（最重要）

### 5.1 実行コマンド（標準）

すべての実行は以下の形式を基本とする。

```bash
codex exec \
  --json \
  --search \
  --sandbox danger-full-access \
  --ask-for-approval never \
  --model gpt-5.3-codex \
  -c 'model_reasoning_effort="high"' \
  "$PROMPT"
```

### 5.2 Resume 実行

session_id が存在する場合は resume 実行を使用する。

```bash
codex exec \
  --json \
  --search \
  --sandbox danger-full-access \
  --ask-for-approval never \
  --model gpt-5.3-codex \
  -c 'model_reasoning_effort="high"' \
  resume "$SESSION_ID" "$PROMPT"
```

### 5.3 実行ルール

- 標準出力の JSONL を 1 行ずつ解析
- 解析不能行は raw テキストとして進捗投稿（落とさない）
- `turn.completed` / `response.completed` の本文は進捗投稿せず、最終返信にのみ使う
- stderr は進捗に垂れ流さず、失敗時の要約に含める

## 6. リアルタイム投稿仕様（Discord）

### 6.1 進捗投稿

- 投稿間隔: デフォルト 2 秒デバウンス
- 分割: 1500 文字チャンク
- 通知抑制フラグを利用
- 代表フォーマット:
  - `🤖 Codexが考えています...`
  - `💻 Command:` + code block
  - `✅/❌ ツール実行結果:` + code block
  - `🤔 reasoning`

### 6.2 リアクション

- メッセージ受信時: `👀`
- Codex 実行開始時: `⚙️`

### 6.3 最終返信

- 進捗とは別に `reply` で返す
- 長文は複数メッセージに分割

## 7. アーキテクチャ

### 7.1 設計原則

- Small Interfaces, Small Packages
- 依存方向は `interface -> implementation`
- 1 package 1責務
- 例外的にしか global state を持たない
- すべての I/O は context 対応

### 7.2 レイヤ構成

```text
cmd/bot
  -> internal/app
     -> internal/discord      (Discord Gateway, command handlers)
     -> internal/orchestrator (session lifecycle, routing)
     -> internal/codex        (process runner, stream parser)
     -> internal/workspace    (repo cache, worktree)
     -> internal/store        (SQLite repositories)
     -> internal/logstream    (JSONL writer, progress formatter)
     -> internal/config       (env, validation)
```

### 7.3 主要コンポーネント

- `SessionOrchestrator`
  - スレッドIDに対する session/run を管理
  - 同時実行制御（1 session = 1 active run）
- `CodexRunner`
  - `os/exec` と stream 読取、stop 制御
- `EventFormatter`
  - Codex JSON event -> Discord 表示文字列
- `WorkspaceService`
  - repo ensure / workspace ensure / cleanup
- `SessionRepository`（SQLite）
  - session/run/message metadata 管理

## 8. データ設計

### 8.1 SQLite（メタデータ）

- `sessions`
  - id, thread_id, mode, repository, workspace_path, codex_session_id, status, created_at, updated_at
- `runs`
  - id, session_id, user_message_id, prompt, status, started_at, ended_at, exit_code, error_summary
- `events`
  - id, run_id, seq, type, content_preview, created_at

インデックス:

- `idx_sessions_thread_id`
- `idx_runs_session_id_started_at`
- `idx_events_run_id_seq`

### 8.2 JSONL（詳細ログ）

- 保存先: `logs/sessions/<session_id>/<run_id>.jsonl`
- 内容: Codex 生イベントをそのまま保存
- 用途: 監査・再解析・障害調査

## 9. ワークスペース設計

```text
$WORK_BASE_DIR/
  repositories/
    owner/repo/                  # cache
  workspaces/
    repo/<thread_id>/            # /start セッション
    chat/<thread_id>/            # /chat セッション
  logs/
    sessions/<session_id>/<run_id>.jsonl
  state/
    bot.db
```

## 10. エラーハンドリング

- User Error（入力不正）: 明確なユーザー向け文言
- Transient Error（ネットワーク等）: リトライ + 要約通知
- System Error（永続化失敗等）: run を failed とし、操作ID付きで通知

エラーコード例:

- `E_INVALID_REPOSITORY`
- `E_SESSION_NOT_FOUND`
- `E_CODEX_EXEC_FAILED`
- `E_CODEX_TIMEOUT`
- `E_DB_WRITE_FAILED`

## 11. 設定値

環境変数（最小）:

- `DISCORD_TOKEN`
- `WORK_BASE_DIR`
- `BOT_TIMEZONE`（default: `Asia/Tokyo`）
- `CODEX_MODEL`（default: `gpt-5.3-codex`）
- `CODEX_REASONING_EFFORT`（default: `high`）
- `PROGRESS_INTERVAL_MS`（default: `2000`）
- `MAX_DISCORD_CHUNK`（default: `1500`）

## 12. セキュリティ要件

- 秘匿値は env のみ、ログへ平文出力禁止
- Discord 投稿前に token/credential パターンをマスキング
- 実行コマンドと停止操作を監査ログに記録
- `/chat`・`/start` 実行可能ロールを設定可能にする

## 13. CI/CD 仕様

### 13.1 CI（Pull Request）

GitHub Actions で以下を必須化:

1. `go mod tidy` 差分チェック
2. `gofmt -s` チェック
3. `go vet ./...`
4. `golangci-lint run`
5. `go test ./... -race -coverprofile=coverage.out`
6. `govulncheck ./...`
7. 生成物確認（OpenAPIやdocs整合があれば検証）

### 13.2 CD（main / tag）

- `main`:
  - Linux 向けバイナリ build
  - コンテナイメージ build/push（GHCR）
  - `:sha-<short>` タグ付け
- `v*` tag:
  - goreleaser で multi-arch release
  - SBOM 生成
  - provenance（SLSA provenance）添付

### 13.3 品質ゲート

- PR merge 条件:
  - CI 緑
  - Coverage 70%以上
  - Critical vulnerability 0件
  - 仕様書更新チェック通過

## 14. AI Agent 実装前提の開発規約

### 14.1 リポジトリ構成ルール

- `docs/specs/` に仕様、`docs/adr/` に意思決定を蓄積
- `AGENTS.md` をリポジトリルートに配置し、AI向け規約を明記
- package ごとに `README.md` を置き、責務と依存を1ページで説明

### 14.2 コーディング規約（AI向け）

- 1 PR = 1責務
- 実装時に必ずテストを追加
- 新規 public interface にはコメント必須
- 複雑分岐はテーブル駆動テスト必須
- 変更時は仕様ファイルの「影響範囲」を更新

### 14.3 ドキュメント更新ルール

変更が以下に該当する場合、同一PRで docs 更新を必須とする。

- コマンド仕様変更
- DB schema 変更
- 実行フロー変更
- 監査項目変更

## 15. 非機能要件

- 再起動復元: 5秒以内に session 復元開始
- メッセージ遅延: 通常時 3秒以内に first progress
- 可観測性: run ごとに trace_id を付与
- 可用性: 連続24h運転でメモリリークしないこと

## 16. テスト戦略

### 16.1 Unit

- parser/formatter/repository 各層
- codex event fixture に対する snapshot test

### 16.2 Integration

- fake codex process で stdout/stderr/kill を再現
- Discord adapter は interface mock で検証

### 16.3 E2E（Nightly）

- テスト用 Discord サーバーで `/chat` `/start` `/stop` シナリオ
- run 完了までの進捗投稿を検証

## 17. 初期マイルストーン

### M1: Skeleton（1週間）

- project scaffold
- config/logger/store
- `/chat` 最小実装

### M2: Repo Flow（1-2週間）

- `/start` repo ensure + workspace
- resume 対応
- `/stop`

### M3: Production Hardening（1週間）

- CI/CD 完備
- 監査ログ・マスキング
- 運用 runbook

## 18. 受け入れ基準（Definition of Done）

- `/chat` と `/start` が動作し、進捗ストリーミングされる
- `/stop` で実行停止できる
- 再起動後に session 状態が保持される
- CI が quality gate を満たす
- docs と ADR が実装に一致している

## 19. 実装時の補足

- 本仕様は v1 の固定方針として `codex exec` のみに限定する
- 将来の model/flags 変更は `CodexCommandBuilder` に閉じ込める
- 互換性都合で fallback が必要になっても、仕様上の標準コマンドを崩さない

## 20. 状態遷移仕様

### 20.1 Session State

- `active`: 通常稼働。入力受付可
- `closing`: close 処理中。新規入力不可
- `closed`: クローズ済み。入力不可

遷移:

- `active -> closing -> closed`
- `active -> closed`（異常終了時の短絡遷移）

### 20.2 Run State

- `queued`: キュー待ち
- `running`: 実行中
- `stopping`: `/stop` 受理後
- `succeeded`: 正常終了
- `failed`: 異常終了
- `stopped`: ユーザー停止

遷移:

- `queued -> running -> succeeded`
- `queued -> running -> failed`
- `queued -> running -> stopping -> stopped`

制約:

- 同一 session で `running` は常に1つ以下
- `closing` 状態の session には `queued` を作らない

## 21. 主要インターフェース契約

実装者（AI Agent）が迷わないよう、最初に interface を固定してから実装する。

```go
type SessionService interface {
    StartChat(ctx context.Context, req StartChatRequest) (Session, error)
    StartRepo(ctx context.Context, req StartRepoRequest) (Session, error)
    CloseSession(ctx context.Context, threadID string) error
    GetSessionByThreadID(ctx context.Context, threadID string) (Session, error)
}

type RunService interface {
    EnqueuePrompt(ctx context.Context, in EnqueuePromptInput) (Run, error)
    StopActiveRun(ctx context.Context, threadID string) error
}

type CodexRunner interface {
    Run(ctx context.Context, req CodexRunRequest, sink CodexEventSink) (CodexRunResult, error)
}

type DiscordSink interface {
    SendProgress(ctx context.Context, threadID string, content string) error
    SendFinal(ctx context.Context, threadID string, content string) error
    React(ctx context.Context, channelID, messageID, emoji string) error
}
```

契約ルール:

- `context.Context` は必須
- domain layer は Discord SDK 型を参照しない
- infra 層だけが `discordgo` と `os/exec` に依存する

## 22. 可観測性（Observability）仕様

### 22.1 ログ

- 構造化 JSON ログ（key-value）
- 必須キー:
  - `timestamp`
  - `level`
  - `trace_id`
  - `session_id`
  - `run_id`
  - `thread_id`
  - `component`
  - `message`

### 22.2 メトリクス（Prometheus）

- `bot_active_sessions` (gauge)
- `bot_active_runs` (gauge)
- `bot_run_total{status=...}` (counter)
- `bot_run_duration_seconds` (histogram)
- `bot_discord_send_errors_total` (counter)
- `bot_codex_exec_errors_total` (counter)

### 22.3 トレース

- OpenTelemetry 対応を前提にインターフェースだけ先に準備
- 最低限 `StartRun`, `CodexExec`, `StreamParse`, `DiscordSend` span を持つ

## 23. デプロイ・運用仕様

### 23.1 実行形態

- 最小構成: 1プロセス + SQLite + ローカルファイル
- 推奨本番構成:
  - systemd または container（Docker）
  - 永続ボリュームを `WORK_BASE_DIR` に割当

### 23.2 リソース推奨値

- CPU: 2 core 以上
- Memory: 2 GB 以上
- Disk: 20 GB 以上（repo cache と JSONL ログ用）

### 23.3 運用 Runbook（必須）

- `docs/runbooks/startup.md`
- `docs/runbooks/incident-stop-failure.md`
- `docs/runbooks/incident-codex-error.md`
- `docs/runbooks/backup-restore.md`

## 24. リポジトリ初期構築チェックリスト

初期コミットで以下を必須化する。

- `AGENTS.md`（AI 開発規約）
- `docs/specs/bot-spec.md`（本仕様）
- `docs/adr/0001-architecture.md`
- `docs/adr/0002-persistence.md`
- `Makefile`（`fmt`, `lint`, `test`, `ci`）
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.golangci.yml`
- `cmd/bot/main.go`（health 起動まで）

受け入れ条件:

- `make ci` がローカルで通る
- PR テンプレートに「仕様差分の記述」欄がある
- 依存導入時に `docs/research/` へ調査メモを残す
