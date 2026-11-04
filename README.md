# Discord Codex Bot

Discord のスレッドから Codex CLI を動かすための Bot です。

`/start owner/repo` で GitHub
リポジトリごとの作業スレッドを作成し、そのスレッドに投稿されたメッセージを Codex
CLI へ渡します。Codex の途中出力と最終応答は Discord
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
   - Manage Threads（`/close` を使う場合）

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
```

`WORK_BASE_DIR` は絶対パスを推奨します。`.env` 内の `~`
はシェルのようには展開されないため、`/home/your-user/codex-bot-work`
のように書いてください。

## 環境変数

| 変数                         | 必須 | 説明                                                                     |
| ---------------------------- | ---- | ------------------------------------------------------------------------ |
| `DISCORD_TOKEN`              | 必須 | Discord Bot Token。                                                      |
| `WORK_BASE_DIR`              | 必須 | Bot がリポジトリ、作業コピー、スレッド状態、ログを保存するディレクトリ。 |
| `CODEX_APPEND_SYSTEM_PROMPT` | 任意 | Codex CLI に渡す追加システムプロンプト。Bot 全体で共通適用されます。     |
| `CODEX_STATUS_TIME_ZONE`     | 任意 | Codex limit reset 時刻の表示タイムゾーン。例: `Asia/Tokyo`。             |

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
Codex CLI に渡し、進捗と応答を同じスレッドへ返します。

画像添付がある場合、Bot は添付ファイルを `WORK_BASE_DIR/attachments/`
に保存し、対応する画像パスを Codex CLI の `--image` として渡します。

### 3. 継続して会話する

同じスレッドへの次の投稿は、前回の Codex セッションを `resume`
して実行されます。スレッドごとにセッションと作業コピーが分かれるため、別スレッドの作業と混ざりません。

`!` から始まるメッセージは Bot
が無視するため、同じスレッド内でユーザー同士の会話に使えます。

## スラッシュコマンド

| コマンド                       | 実行場所       | 説明                                                                               |
| ------------------------------ | -------------- | ---------------------------------------------------------------------------------- |
| `/start repository:owner/repo` | 通常チャンネル | リポジトリを準備し、新しい作業スレッドを作ります。                                 |
| `/stop`                        | 作業スレッド   | 実行中の Codex プロセスを中断します。                                              |
| `/plan`                        | 作業スレッド   | 次回以降の依頼で、実装前に計画を返すよう Codex へ指示します。                      |
| `/status`                      | どこでも       | Codex の 5h / Weekly limit を確認します。                                          |
| `/update`                      | どこでも       | Codex CLI を最新版へ更新します。update 通知で `/status` が塞がる場合に使います。   |
| `/active-threads`              | どこでも       | 現在アクティブな作業スレッドから、実行者宛てに silent mention を送ります。         |
| `/close`                       | 作業スレッド   | Worker を終了し、Discord スレッドをクローズします。Manage Threads 権限が必要です。 |

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

## Codex CLI の実行形式

Bot は概ね次の形式で Codex CLI を実行します。

新規セッション:

```text
codex --search exec --json --color never --dangerously-bypass-approvals-and-sandbox --output-last-message <path> "<prompt>"
```

継続セッション:

```text
codex --search exec --json --color never --dangerously-bypass-approvals-and-sandbox resume --output-last-message <path> <session_id> "<prompt>"
```

画像添付がある場合は `--image <path>`
が追加されます。`CODEX_APPEND_SYSTEM_PROMPT` を設定している場合は
`--append-system-prompt` も追加されます。

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

## 履歴の読取CLI（運用者向け）

`src/read-history.ts` はBot本体を起動しない独立したGET専用入口です。
`Client`・Worker復旧・コマンド登録を呼ばず、投稿・既読更新・参加・権限変更もしません。
同じ運用環境の既存 `.env`
を使い、tokenを引数・ログ・別ファイルへコピーしないでください。
対象サーバーとチャンネルの両IDが必須で、所属を確認してから取得します。

既存checkoutのrootで、対象の実IDへ置き換えて実行します。

```bash
deno run --env-file=.env --allow-env --allow-net=discord.com \
  src/read-history.ts messages --guild 'GUILD_ID' --channel 'CHANNEL_ID' --limit 100

deno run --env-file=.env --allow-env --allow-net=discord.com \
  src/read-history.ts threads-active --guild 'GUILD_ID' --channel 'PARENT_CHANNEL_ID'

deno run --env-file=.env --allow-env --allow-net=discord.com \
  src/read-history.ts threads-archived --guild 'GUILD_ID' --channel 'PARENT_CHANNEL_ID' \
  --visibility public --limit 100
```

各呼出しは1ページだけです。messagesの続きには返った `next_cursor` を `--before`
へ渡します。 メッセージAPIに終端情報はないため `has_more` は `null`、`complete`
は常に `false` です。 空配列も、履歴がないことや全件取得の証明にはしません。

archiveの `has_more` はAPIの値を保持します。public/privateの `--before` は
`archive_timestamp` のISO日時、joined-privateはthread IDです。
`--visibility private` は権限で見える非公開アーカイブ、`joined-private`
はBotが参加済みの範囲です。
activeは指定した親チャンネルの可視threadだけを返し、archiveを含みません。
フォーラムでは親チャンネルからthreadを列挙し、そのthread
IDでmessagesを読みます。

Botが参加・閲覧できる範囲だけが対象で、本人アカウントの全DMや全サーバーを代替しません。
`VIEW_CHANNEL`・`READ_MESSAGE_HISTORY`、非公開threadのアクセス条件、Message
Content Intentによって
取得範囲と本文が制限されます。HTTP/認証エラーは固定コードで返し、例外全文や認証値は出力しません。
[公式メッセージ仕様](https://docs.discord.com/developers/resources/message#get-channel-messages)・
[thread仕様](https://docs.discord.com/developers/topics/threads)を参照してください。

導入時はDiscord
APIへのネットワーク権限を与えず、実tokenの読取を明示拒否した合成transportの9ケースと型検査で確認しました。
実際のサーバーでの取得・OCI配置・Bot再起動は未実施です。

SDKの自動再試行は0回、1要求15秒・全体30秒で中断します。rate
limitはSDK内で待たず、 `RATE_LIMITED` と `retry_after_ms`
を返します。次の呼出しはその待機時間以降に行います。

`discord.js` のNode互換依存も環境変数を参照するため、既存Botと同じ `--allow-env`
を使います。 CLI自身が読む認証変数は `DISCORD_TOKEN`
だけで、環境変数一覧は出力しません。 依存を更新せず使う場合は既存の
`deno.json`・`deno.lock` とキャッシュを用い、 `--cached-only --frozen`
を追加します。キャッシュ不足なら取得成功として進めず終了します。

認証・ネットワーク権限なしの使い方確認は
`deno run --cached-only src/read-history.ts --help` です。
