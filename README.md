# Discord Codex Bot

Discord スレッド上で Codex CLI を実行する Bot です。\
本リポジトリは「シンプル運用」を優先した再実装版で、以下の機能に絞っています。

1. `/start owner/repo` でリポジトリ準備とスレッド開始
2. スレッドメッセージを Codex へ転送して結果を返信
3. `/stop`, `/plan`, `/close`

## 削除済み機能

1. devcontainer 関連機能
2. PAT 管理機能
3. 翻訳機能
4. Gemini 連携
5. CLI フォールバック多段分岐
6. レート制限時のキュー/自動再開

## Codex 実行形式

新規実行:

```text
codex --search exec --json --color never --dangerously-bypass-approvals-and-sandbox "<prompt>"
```

resume 実行:

```text
codex --search exec --json --color never --dangerously-bypass-approvals-and-sandbox resume <session_id> "<prompt>"
```

## 必須コマンド

1. `git`
2. `codex`

## セットアップ

```bash
cp .env.example .env
deno task start
```

`DISCORD_TOKEN` と `WORK_BASE_DIR` は必須です。

## 環境変数

| 変数                         | 必須 | 説明                         |
| ---------------------------- | ---- | ---------------------------- |
| `DISCORD_TOKEN`              | ✅   | Discord Bot トークン         |
| `WORK_BASE_DIR`              | ✅   | 作業ディレクトリ             |
| `CODEX_APPEND_SYSTEM_PROMPT` | ❌   | Codex 追加システムプロンプト |

## 開発コマンド

```bash
deno task fmt
deno task lint
deno task check
deno task test
```

## ディレクトリ

`WORK_BASE_DIR` 配下:

1. `repositories/` クローン本体
2. `worktrees/` スレッド作業領域
3. `threads/` スレッド情報
4. `workers/` Worker状態
5. `admin/` 管理状態
6. `sessions/` Codex生ログ
7. `audit/` 監査ログ
