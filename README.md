# Discord Codex Bot

Discord のスレッドから Codex CLI を動かすための Bot です。

`/start owner/repo` で GitHub
リポジトリごとの作業スレッドを作成し、そのスレッドに投稿されたメッセージを Codex
CLI へ渡します。Codex の進捗メッセージと最終応答は Discord
に返され、同じスレッド内では Codex セッションを継続できます。

## できること

- Discord のスラッシュコマンドから作業スレッドを作成
- `owner/repo` 形式の GitHub リポジトリを clone / update
- スレッドごとに独立した作業ディレクトリと Codex セッションを管理
- 通常メッセージと画像添付を Codex CLI に転送
- Codex の JSON ストリームを Discord 向けに整形して返信
- 実行中 Codex の中断、プランモード、スレッドのクローズ
- Bot 再起動後のアクティブスレッド復旧

## Codex BOT 使い方

Bot を使う人向けの基本操作だよ。

- `/start repository:<GitHubの名前/レポジトリ名>`:
  作業用スレッドを作るよ。レポジトリをクローンしてそのスレッド専用の作業用フォルダを作り
  Codex がその中で依頼を実行するよ。
  - 例: `/start repository:pikachu0310/discord-codex-bot`
  - スレッドにメッセージを投稿: その内容が Codex
    への依頼になるよ。修正や実装、調査や説明依頼などをそのまま書けるよ。
  - スレッドに画像やファイルを添付: 添付ファイルも Codex
    に渡せるよ。送信できない巨大な指示をテキストファイルで送ったり、スクショやファイルなどを渡したい時に使えるよ。
  - スレッド内では `!` から始まるメッセージに Bot
    は反応しないよ。ユーザー同士で会話したい時に使えるよ。
- `/stop`: そのスレッドで実行中の Codex
  を止めるよ。間違えたときや処理を中断したい時に使うよ。
- `/plan`:
  そのスレッドをプランモードにするよ。いきなり実装せず、まず方針や作業計画を出してほしい時に使うよ。
- `/active-threads`:
  まだ生きている作業スレッドを確認するよ。各アクティブスレッドから、コマンドを実行した人宛てに
  silent mention が送られるよ。
- `/close`:
  その作業スレッドを終了するよ。作業コピーを片付けて容量を空け、Discord
  のスレッドもクローズするよ。

## 必須コマンド

Bot を起動・運用するホストには次のコマンドが必要です。

| コマンド | 必須 | 用途                                                                                                         |
| -------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| `deno`   | 必須 | Bot 本体の起動、型チェック、テスト実行に使います。Deno 2 系を想定しています。                                |
| `git`    | 必須 | 対象リポジトリの clone / fetch / checkout / 作業ブランチ作成に使います。                                     |
| `codex`  | 必須 | Discord から受け取った依頼を実行する Codex CLI です。                                                        |
| `gh`     | 任意 | Bot 本体の起動には不要です。リポジトリ管理やこのプロジェクトの PR 作成など、開発・運用補助で使うと便利です。 |

起動時のシステムチェックでは `git` と `codex` を検査します。`deno` は
`deno task start` 自体の実行に必要です。

インストール例:

```bash
# Deno
curl -fsSL https://deno.land/install.sh | sh

# Codex CLI
npm install -g @openai/codex
codex --login

# GitHub CLI（任意）
brew install gh
gh auth login
```

`git` は OS のパッケージマネージャ、または https://git-scm.com/downloads
から導入してください。

## Discord 側の準備

1. Discord Developer Portal で Application を作成します。
2. Bot を作成し、Bot Token を取得します。
3. Bot に必要な Intent を有効化します。
   - Server Members Intent は不要です。
   - Message Content Intent はスレッド内メッセージを読むために必要です。
4. OAuth2 URL Generator で `bot` と `applications.commands` scope を選び、Bot
   をサーバーへ招待します。
5. Bot 権限として、少なくとも次を付与します。
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Create Public Threads
   - Read Message History
   - Add Reactions
   - Manage Threads（Botが `/close` でスレッドを閉じるために必要）

## セットアップ

```bash
git clone <this-repository-url>
cd discord-codex-bot

cp .env.example .env
$EDITOR .env

deno task start
```

`.env` には最低限 `DISCORD_TOKEN` と `WORK_BASE_DIR` を設定します。

```dotenv
DISCORD_TOKEN=your_discord_bot_token_here
WORK_BASE_DIR=/absolute/path/to/codex-bot-work
CODEX_STATUS_TIME_ZONE=Asia/Tokyo
CODEX_THREAD_NAMING_MODEL=gpt-5.6-luna
CODEX_THREAD_NAMING_INSTRUCTIONS="threadNameは日本語、branchSlugは英語で作成してください"
```

`WORK_BASE_DIR` は絶対パスを推奨します。`.env` 内の `~`
はシェルのようには展開されないため、`/home/your-user/codex-bot-work`
のように書いてください。

## 環境変数

| 変数                               | 必須 | 説明                                                                      |
| ---------------------------------- | ---- | ------------------------------------------------------------------------- |
| `DISCORD_TOKEN`                    | 必須 | Discord Bot Token。                                                       |
| `WORK_BASE_DIR`                    | 必須 | Bot がリポジトリ、作業コピー、スレッド状態、ログを保存するディレクトリ。  |
| `CODEX_APPEND_SYSTEM_PROMPT`       | 任意 | Codex CLI に渡す追加システムプロンプト。Bot 全体で共通適用されます。      |
| `CODEX_STATUS_TIME_ZONE`           | 任意 | Codex limit reset 時刻の表示タイムゾーン。例: `Asia/Tokyo`。              |
| `CODEX_THREAD_NAMING_MODEL`        | 任意 | 初回応答後のスレッド・ブランチ名生成モデル。既定: `gpt-5.6-luna`。        |
| `CODEX_THREAD_NAMING_INSTRUCTIONS` | 任意 | スレッド名と `/` 以降のブランチ名について、言語や表現を指定する追加指示。 |

## 詳しい使い方

### 1. 作業スレッドを作る

Discord の通常チャンネルで次を実行します。

```text
/start repository:owner/repo
```

Bot は対象リポジトリを `WORK_BASE_DIR/repositories/` に clone
します。すでに存在する場合は fetch
してデフォルトブランチへ更新します。その後、Discord
スレッドを作成し、スレッド専用の作業コピーを `WORK_BASE_DIR/worktrees/`
に用意します。

### 2. スレッドへ依頼を書く

作成されたスレッドに通常の Discord メッセージを投稿します。Bot はその内容を
Codex App Server に渡し、進捗と応答を同じスレッドへ返します。
初回応答の送信後、会話内容を要約して Discord スレッド名と作業ブランチ名を
自動更新します。

画像添付がある場合、Bot は添付ファイルを `WORK_BASE_DIR/attachments/`
に保存し、対応する画像パスを Codex の画像入力として渡します。

### 3. 継続して会話する

作業中の追加投稿は、実行中の Codex にそのまま渡されます。同じセッションの Codex
プロセスを重複起動しません。完了後の投稿は、前回のセッションを再開して実行します。
スレッドごとにセッションと作業コピーが分かれるため、別スレッドの作業と混ざりません。

Codex が質問した場合は、同じスレッドに通常のメッセージで回答してください。
選択肢付きの質問には番号（例: `2`）、または自由文で回答できます。
複数の質問がある場合は1問ずつ表示されます。質問待ち中も `/stop` で中断できます。

`!` から始まるメッセージは Bot
が無視するため、同じスレッド内でユーザー同士の会話に使えます。

## スラッシュコマンド

| コマンド                       | 実行場所       | 説明                                                                          |
| ------------------------------ | -------------- | ----------------------------------------------------------------------------- |
| `/start repository:owner/repo` | 通常チャンネル | リポジトリを準備し、新しい作業スレッドを作ります。                            |
| `/stop`                        | 作業スレッド   | 実行中の Codex プロセスを中断します。                                         |
| `/plan`                        | 作業スレッド   | 次回以降の依頼で、実装前に計画を返すよう Codex へ指示します。                 |
| `/status`                      | どこでも       | Codex の 5h / Weekly limit を確認します。                                     |
| `/active-threads`              | どこでも       | 現在アクティブな作業スレッドから、実行者宛てに silent mention を送ります。    |
| `/close`                       | 作業スレッド   | Worker を終了し、Discord スレッドをクローズします。@everyone で実行できます。 |

`/start` の repository 入力は、すでに Bot
が取得済みのローカルリポジトリを候補としてオートコンプリートします。

## 作業ディレクトリ

`WORK_BASE_DIR` 配下には次のデータが作られます。

```text
WORK_BASE_DIR/
├── repositories/   # clone した GitHub リポジトリ
├── worktrees/      # スレッドごとの作業コピー
├── threads/        # Discord スレッド情報
├── workers/        # Worker 状態
├── admin/          # Admin 状態
├── sessions/       # Codex の生 JSONL 出力
├── attachments/    # Discord 添付ファイル
├── temp/           # Codex CLI に渡す一時ファイル
└── audit/          # 監査ログ
```

このディレクトリは Bot が直接読み書きします。複数環境で同じ `WORK_BASE_DIR`
を共有しないでください。

## Codex との通信

作業実行には `codex app-server` の標準入出力を使います。 初期化後、新規会話は
`thread/start`、継続会話は `thread/resume`、 作業開始は `turn/start`
で処理します。作業中の追加入力は `turn/steer` で渡します。 質問
(`item/tool/requestUserInput`) への回答は、対応するリクエストへ返します。
作業終了と追加投稿が重なった場合は、終了を待って次の作業として受け付けます。

Discordへ送るのは、Codexの進捗メッセージ・質問・最終回答です。
コマンドの標準出力・標準エラー、ツールの結果、推論や未知のイベントは返信しません。
最終回答は途中経過と重複させずに送信し、生の通信ログは従来どおり
`WORK_BASE_DIR/sessions/` に保存します。 利用枠は `account/rateLimits/read`
から取得します。

画像添付は `localImage` 入力、`CODEX_APPEND_SYSTEM_PROMPT` は
`developerInstructions` として渡します。本文は構造化データで送るため、 `--help`
や `-x` などで始まる本文もそのまま渡せます。 従来どおり、承認ポリシーは
`never`、サンドボックスは `danger-full-access` です。 App Server
の上記メソッドに対応した Codex CLI が必要です。

Bot は `--model` や `model_reasoning_effort` を指定しません。モデル、reasoning
effort、profile などの Codex CLI 設定は、Bot を起動するユーザーの Codex CLI
設定に従います。通常は `$CODEX_HOME/config.toml` または `~/.codex/config.toml`
を確認してください。

この Bot は Codex を自動実行するため、Bot
専用の実行ユーザーと作業ディレクトリを用意することを推奨します。

## 開発

よく使うコマンド:

```bash
deno task fmt
deno task lint
deno task check
deno task test
```

開発中にファイル変更を監視して起動する場合:

```bash
deno task dev
```

pre-commit hook を設定する場合:

```bash
deno task setup-hooks
```

## トラブルシュート

### `DISCORD_TOKEN is not set`

`.env` が存在するか、`DISCORD_TOKEN` が設定されているか確認してください。

### `WORK_BASE_DIR is not set`

`.env` に `WORK_BASE_DIR=/absolute/path/to/workdir`
を設定してください。相対パスや `~` より絶対パスを推奨します。

### `git` または `codex` が見つからない

Bot 起動時のシステムチェックに失敗しています。Bot を起動するユーザーの `PATH`
から `git --version` と `codex --version` が実行できるようにしてください。

### Codex が認証エラーになる

Bot を起動するユーザーで `codex --login` を完了してください。systemd
などで別ユーザーとして起動する場合、その実行ユーザー側で認証が必要です。

### private repository を使いたい

現行実装は `git clone https://github.com/owner/repo.git` を使います。private
repository を扱う場合は、Bot 実行ユーザーの Git
認証情報を事前に設定してください。

## 関連ドキュメント

- `docs/discord.md`: Discord.js 連携メモ
- `docs/autocomplete.md`: `/start` オートコンプリート調査メモ
- `docs/CODEX.md`: 過去のアーキテクチャメモ
- `docs/rearchitecture-spec-v2.md`: 再設計仕様メモ
