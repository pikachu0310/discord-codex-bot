# Go Discord Codex Bot

`docs/go-discord-bot-spec.md` に基づく、最小構成の Go 実装です。  
対象機能は次の4コマンドのみです。

- `/chat`
- `/start <owner/repo>`
- `/stop`
- `/status`

## 特徴

- ファイルベース永続化（SQLiteなし）
- 1スレッド=1セッション
- 同一スレッド同時実行禁止
- Codex 実行コマンドを新方式に固定
  - `codex --search exec --json --color never --dangerously-bypass-approvals-and-sandbox ...`

## 必要要件

- Go 1.24+
- `git`
- `codex`
- Discord Bot Token

## 環境変数

- `DISCORD_TOKEN` (必須)
- `WORK_BASE_DIR` (必須)
- `CODEX_LIMIT_5H_TOKENS` (必須)
- `CODEX_LIMIT_1W_TOKENS` (必須)

起動時に必須環境変数のどれかが空の場合、カレントディレクトリの `.env` を自動で読み込みます。  
テンプレートは `.env.example` を参照してください。

## 起動

```bash
cd go-discord-bot
cp .env.example .env
go mod tidy
go run ./cmd/bot
```

## データ保存先

`$WORK_BASE_DIR` 配下に次を作成します。

- `sessions/<thread_id>.json`
- `runs/<thread_id>.json`
- `token_usage/usage.jsonl`
- `logs/sessions/<session_id>/<run_id>.jsonl`
- `repositories/<owner>/<repo>`
- `workspaces/chat/<thread_id>`
- `workspaces/repo/<thread_id>`

## テスト

```bash
go test ./... -race
```

## 非対応（意図的）

- devcontainer
- PAT管理
- 翻訳
- レートリミット自動再開キュー
