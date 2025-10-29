# Codex Discord Bot

Codex AIを活用したDiscord
Bot。GitHubリポジトリをクローンして、Codexがコードを読み込み、修正やレビューを行えます。

## 機能

- **GitHubリポジトリ連携**:
  スラッシュコマンドでGitHubリポジトリを指定すると、自動的にクローン/更新
- **リポジトリ名オートコンプリート**: GitHub
  APIを使用したリアルタイムのリポジトリ名補完機能
- **Codex AI統合**: Codex CLIを使用してコードの読み込み、修正、レビューを実行
- **スレッド管理**:
  1つのスレッドにつき1つのWorkerが割り当てられ、独立した作業環境を提供
- **永続化機能**:
  スレッド情報、セッションログ、監査ログを保存し、再起動後も継続可能
- **Dev Container対応**:
  リポジトリにdevcontainer.jsonがある場合、その環境内でCodexを実行
- **レート制限対応**: Codex APIのレート制限に対応し、自動再開ボタンを提供
- **日本語→英語翻訳機能**:
  PLaMo-2-translateを使用して日本語の指示を英語に翻訳してからCodex
  Codeに渡す（オプション）
- **実行中断機能**: `/stop`コマンドで実行中のCodex Codeを安全に中断

## セットアップ

### 前提条件

#### 必須コマンド

- [Deno](https://deno.land/) (v1.40以上)
- [Git](https://git-scm.com/downloads)
- [Codex CLI](https://docs.anthropic.com/en/docs/codex-code)

#### 推奨コマンド

- [GitHub CLI (gh)](https://cli.github.com/) - プライベートリポジトリ対応
- [Dev Container CLI](https://github.com/devcontainers/cli) -
  `npm install -g @devcontainers/cli`

### インストール手順

1. リポジトリをクローン

```bash
git clone https://github.com/[your-org]/codex-discord-bot.git
cd codex-discord-bot
```

2. Discord Botを作成
   - [Discord Developer Portal](https://discord.com/developers/applications)でアプリケーションを作成
   - Botトークンを取得
   - 必要な権限: `Send Messages`, `Read Message History`, `Use Slash Commands`,
     `Create Public Threads`, `Send Messages in Threads`

3. 環境変数を設定

```bash
# .env.exampleをコピーして.envファイルを作成
cp .env.example .env

# .envファイルを編集して、実際の値を設定
# DISCORD_TOKEN: Discord Developer Portalで取得したトークン
# WORK_BASE_DIR: 作業ディレクトリのパス（例: ~/codex-bot-work）
```

4. Git hooksをセットアップ（推奨）

```bash
deno task setup-hooks
```

5. Botを起動

```bash
# 開発モード（ウォッチモード）
deno task dev

# 本番モード
deno task start
```

## 使い方

### Discordでの使用方法

1. Botを招待したサーバーで以下のスラッシュコマンドを実行:

```text
/codex <GitHubリポジトリ名>
```

例: `/codex octocat/Hello-World`

2. Botが自動的にスレッドを作成し、リポジトリをクローン
3. スレッド内でCodexに指示を送信
4. Codexがコードを読み込み、修正やレビューを実行

### コマンド例

- 「このリポジトリの構造を説明して」
- 「READMEを改善して」
- 「テストを追加して」
- 「バグを修正して」

### 実行の中断

実行中のCodex Codeを中断したい場合は、スレッド内で以下のコマンドを送信:

```text
/stop
```

中断後も新しい指示を送信することで作業を継続できます。

## 設定項目

### 環境変数

| 変数名                          | 説明                                                   | 必須 | デフォルト |
| ------------------------------- | ------------------------------------------------------ | ---- | ---------- |
| `DISCORD_TOKEN`                 | Discord Botのトークン                                  | ✅   | -          |
| `WORK_BASE_DIR`                 | 作業ディレクトリのベースパス                           | ✅   | -          |
| `CODEX_APPEND_SYSTEM_PROMPT`   | Codex実行時に追加するシステムプロンプト               | ❌   | -          |
| `CODEX_CODE_MAX_OUTPUT_TOKENS` | Codex CLIの最大出力トークン数                         | ❌   | `25000`    |
| `GEMINI_API_KEY`                | Google Gemini APIキー（スレッド名生成用）              | ❌   | -          |
| `PLAMO_TRANSLATOR_URL`          | PLaMo-2-translate APIのURL                             | ❌   | -          |
| `VERBOSE`                       | 詳細なデバッグログを出力（Codex実行時のコマンドなど） | ❌   | `false`    |

### 作業ディレクトリ構造

```text
WORK_BASE_DIR/
├── repositories/          # クローンされたGitHubリポジトリ
│   └── {org}/
│       └── {repo}/
├── threads/              # スレッド情報の永続化
│   └── {thread_id}.json
├── sessions/             # Codexセッションログ
│   └── {thread_id}/
│       └── {session_id}.json
└── audit/               # 監査ログ（JSONL形式）
    └── {date}/
        └── activity.jsonl
```

## 開発方法

### 開発環境のセットアップ

```bash
# 依存関係のインストール（Denoは自動的に管理）
deno cache src/main.ts

# Git hooksのセットアップ
deno task setup-hooks
```

### 開発コマンド

```bash
# コードフォーマット
deno task fmt

# リント
deno task lint

# 型チェック
deno task check

# テスト実行
deno task test

# 全チェック（フォーマット → リント → 型チェック → テスト）
deno task test:all:quiet
```

### トークン節約版コマンド（CI/CD向け）

エラー時のみ詳細を出力するquiet版:

```bash
deno task fmt:quiet
deno task lint:quiet
deno task check:quiet
deno task test:quiet
deno task test:all:quiet
```

### テスト

```bash
# 全テスト実行
deno test --allow-read --allow-write --allow-env --allow-run

# 特定のテストファイルを実行
deno test --allow-read --allow-write --allow-env --allow-run src/worker_test.ts
```

### デバッグ

1. 開発モードで起動

```bash
deno task dev
```

2. ログの確認

- 標準出力にログが表示されます
- 監査ログ: `WORK_BASE_DIR/audit/{date}/activity.jsonl`
- セッションログ: `WORK_BASE_DIR/sessions/{thread_id}/{session_id}.json`

## アーキテクチャ

### システム概要

Discord
BotはAdmin-Worker型のマルチプロセスアーキテクチャを採用しています。1つのAdminプロセスが複数のWorkerを管理し、各Workerが1つのDiscordスレッドを担当します。

### 主要コンポーネント

#### Admin (`src/admin.ts`) - 1748行

プロセス全体で1つだけ起動される管理モジュール。

- **Worker管理**: スレッドごとにWorkerインスタンスを作成・管理
- **メッセージルーティング**: スレッドIDに基づいてメッセージを適切なWorkerに転送
- **レート制限管理**: Codex APIのレート制限を検出し、自動再開タイマーを管理
- **Devcontainer対応**: リポジトリのdevcontainer.jsonを検出し、実行環境を選択
- **状態永続化**: アプリケーション再起動後のスレッド復旧機能

#### Worker (`src/worker.ts`) - 1667行

各スレッドに1対1で対応する実行モジュール。

- **Codex CLI実行**: ホスト環境またはDevcontainer環境でCodex CLIを実行
- **ストリーミング処理**: JSON Lines形式でCodexの出力をリアルタイム処理
- **メッセージフォーマット**: ツール使用の可視化、長文要約、TODOリストの特別処理
- **翻訳機能統合**: PLaMo-2-translateによる日本語→英語翻訳（オプション）
- **セッションログ記録**: 全てのやり取りを永続化

#### WorkspaceManager (`src/workspace.ts`) - 636行

作業ディレクトリとデータ永続化を一元管理。

- **11種類のディレクトリ管理**:
  repositories、threads、sessions、audit、worktrees等
- **データ永続化**:
  スレッド情報、セッションログ、監査ログ、PAT情報などをJSON形式で保存
- **Worktree管理**: Git worktreeのコピー作成・削除による独立した作業環境
- **メッセージキュー**: レート制限時のメッセージ保存と処理

#### ユーティリティモジュール

- **GitUtils** (`src/git-utils.ts`): GitとGitHub CLIを使用したリポジトリ操作
- **DevContainer** (`src/devcontainer.ts`): Dev Container
  CLIとの連携、ストリーミングログ処理
- **Gemini** (`src/gemini.ts`): Google Gemini APIによるスレッド名自動生成
- **PLaMoTranslator** (`src/plamo-translator.ts`):
  コーディング指示に特化した日本語→英語翻訳

### メッセージ処理フロー

```text
Discord User
    ↓
main.ts (MessageCreate Event)
    ↓
admin.routeMessage()
    ├─ レート制限チェック → キューイング
    └─ Worker検索
          ↓
worker.processMessage()
    ├─ PLaMo翻訳（オプション）
    └─ Codex CLI実行（ストリーミング）
          ↓
メッセージタイプ別処理
    ├─ assistant: フォーマット処理
    ├─ tool_use: アイコン付き表示
    ├─ tool_result: スマート要約
    └─ error: エラーハンドリング
          ↓
Discord送信（2000文字制限対応）
```

### Dev Container統合

リポジトリにdevcontainer.jsonが存在する場合：

1. Dev Container CLIの可用性チェック
2. Anthropics features（Codex Code）の検出
3. ユーザー選択によるDevcontainer起動
4. コンテナ内でのCodex実行

### 状態管理と永続化

- **スレッド情報**: 作成時刻、最終アクティブ時刻、リポジトリ情報、ステータス
- **セッションログ**: Codexとのやり取りを時系列でJSONL形式記録
- **監査ログ**: システムアクションの追跡（Worker作成、メッセージ受信等）
- **再起動対応**: AdminState/WorkerStateによる状態復旧

## トラブルシューティング

### Botが応答しない

- Discord Tokenが正しく設定されているか確認
- Botに必要な権限があるか確認
- ログでエラーメッセージを確認

### Codex CLIエラー

- Codex CLIがインストールされているか確認: `codex --version`
- Codex APIキーが設定されているか確認

### リポジトリクローンエラー

- プライベートリポジトリの場合、GitHub CLIがインストールされ認証済みか確認:
  `gh auth status`
- 作業ディレクトリの権限を確認

## 技術スタック

- **Runtime**: Deno v1.40+
- **Language**: TypeScript (厳格モード)
- **Discord Library**: Discord.js v14.16.3+
- **AI Integration**: Codex CLI
- **Version Control**: Git

## 開発ツール

標準的なものに加えて、以下のツールが利用可能です：

- **ripgrep**: 高速なテキスト検索
- **ast-grep (sg)**: 構文木ベースのコード検索
- **semgrep**: セマンティックなコード分析

## ライセンス

MIT License - 詳細は[LICENSE](LICENSE)ファイルを参照してください。

## 貢献

プルリクエストを歓迎します。大きな変更の場合は、まずissueを作成して変更内容について議論してください。

### 開発方針

- TypeScriptの厳格モードを使用（any型禁止）
- すべての機能にテストを追加
- コミット前に`deno task test:all:quiet`を実行
- テスト駆動開発（TDD）を推奨

### テストカバレッジ

プロジェクトは充実したテストスイートを持っています：

#### 単体テスト (`src/*_test.ts`)

- ✅ 主要モジュール: admin、worker、workspace（部分的）
- ✅ ユーティリティ:
  git-utils、devcontainer、gemini、plamo-translator、system-check
- ❌ 未テスト: main.ts、env.ts、worker-name-generator.ts

#### 統合テスト (`test/*.test.ts`)

- システム全体の統合テスト
- 永続化機能の統合テスト
- レート制限機能のテスト
- ストリーミング処理のテスト
- Devcontainer関連の複数テスト

#### テストの特徴

- 日本語テスト名による高い可読性
- `test-utils.ts`による共通モック機能
- ストリーミング対応の高度なモック
- 適切なクリーンアップ処理
