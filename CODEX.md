## 概要

Denoで開発されたDiscord Bot。
テストが充実しており、anyなどを使わないTypeScriptで書かれており、CIなども完備されているため、保守性が高いプロダクトになっている。

## アーキテクチャ

Discord Botのアーキテクチャは、以下のような構成になっている。

### Admin (1748行)

Adminモジュールは以下の特徴を持つ

- プロセスで１つだけ起動される
- Discordから起動のスラッシュコマンドを受け取るとスレッドを作成し、それを担当するWorkerを起動する
  - Workerがスレッドに対してメッセージを返信できるようにコールバックを提供する
- Discordからスレッドに対してメッセージを受け取ると、担当のWorkerに対してメッセージを渡す
- レート制限管理、Devcontainer対応、状態永続化など多くの責務を抱えている

**改善が必要な点:**

- 巨大なクラス（1748行）で責務が多すぎる
- `restoreActiveThreads`（73行）、`checkAndSetupDevcontainer`（192行）などの長大なメソッド
- マジックナンバーの散在（レート制限の5分など）
- WorkerManager、RateLimitManager、DevcontainerManagerなどへの責務分離が必要

### Worker (1667行)

WorkerモジュールはAdminモジュールによって起動・管理される。
1つのWorkerが1つのスレッドを担当する。

**主な機能:**

- Codex CLI実行（ホスト環境/Devcontainer環境）
- ストリーミング処理によるリアルタイム出力
- メッセージフォーマッティング（ツールアイコン、要約、TODOリスト）
- PLaMo翻訳統合

**改善が必要な点:**

- 巨大なクラス（1667行）で責務が多すぎる
- `executeCodexStreaming`メソッドが220行以上
- MessageFormatter、CodexStreamProcessorなどへの分離が必要
- フォーマット関連メソッドの重複

### WorkspaceManager (636行)

WorkspaceManagerモジュールは作業ディレクトリの管理とデータ永続化を担当する。

- 構造化された作業ディレクトリ（repositories/、threads/、sessions/、audit/、worktrees/、pats/、queued_messages/、admin/、workers/）を管理
- スレッド情報、Codexセッションログ、監査ログのJSON永続化
- 再起動後の継続性とaudit log的な検証機能を提供

**改善が必要な点:**

- 11種類のデータ型を1クラスで管理
- ThreadManager、SessionManager、AuditLoggerなどへの分離が必要
- ディレクトリ走査処理の重複
- JSON.parseの結果を直接型アサーション（スキーマ検証なし）

## 作業ディレクトリ構造

```
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

## 必要なコマンド

このアプリケーションは起動時に以下のコマンドが利用可能かチェックし、必須コマンドが不足している場合はエラー終了します。

### 必須コマンド

- **git**: Gitバージョン管理システム
  - リポジトリのクローン・更新・worktree操作に使用
  - インストール: https://git-scm.com/downloads
- **codex**: Codex CLI ツール
  - Codex AIとの対話処理に使用
  - インストール: https://docs.anthropic.com/en/docs/codex-code

### 推奨コマンド

- **gh**: GitHub CLI（推奨）
  - リポジトリのメタデータ取得・プライベートリポジトリ対応に使用
  - 利用可能な場合はより洗練されたリポジトリ管理が可能
  - インストール: https://cli.github.com/
- **devcontainer**: Dev Container CLI
  - 開発コンテナサポートに使用
  - 利用可能な場合はdevcontainer.jsonに基づいた実行環境を提供
  - インストール: `npm install -g @devcontainers/cli`
- **script**（util-linux）: Codex CLIがTTYを要求する場合のフォールバックに使用
  - `stdout is not a terminal`エラー発生時に必要
  - 多くのLinuxディストリビューションで標準提供（util-linuxパッケージ）

アプリケーション起動時にシステム要件チェックが実行され、必須コマンドが不足している場合は適切なエラーメッセージとインストール手順が表示されます。

## 環境変数

- `DISCORD_TOKEN`: Discord Botのトークン
- `WORK_BASE_DIR`: 作業ディレクトリのベースパス（旧CLONE_BASE_DIR）
- `CODEX_APPEND_SYSTEM_PROMPT`:
  Codex実行時に追加するシステムプロンプト（オプション）
  - Codex CLIの`--append-system-prompt`オプションに渡される
  - 既存のシステムプロンプトに追加の指示を与えたい場合に使用
- `CODEX_CODE_MAX_OUTPUT_TOKENS`: Codex CLIの最大出力トークン数（オプション）
  - Codex CLIの環境変数`CODEX_CODE_MAX_OUTPUT_TOKENS`として設定される
  - デフォルト値: 25,000（MCPツールのデフォルト制限値と同様）
  - 正の整数値のみ有効、無効な値の場合はデフォルト値を使用
- `CODEX_CLI_OUTPUT_FORMAT_MODE`: Codex
  CLIの`--output-format`フラグ使用モード（オプション）
  - `auto`（デフォルト）で`codex --help`の結果から自動判定
  - `never`でフラグを常に無効化、`always`で常に付与
- `GEMINI_API_KEY`: Google Gemini APIキー（オプション）
  - 設定されている場合、最初のユーザーメッセージを要約してスレッド名を自動生成
  - スレッド名のフォーマット: `${指示の要約}(${リポジトリ名})`
  - Discordのスレッド一覧で見やすくなるよう最大30文字に制限
- `PLAMO_TRANSLATOR_URL`: PLaMo-2-translate API URL（オプション）
  - 設定されている場合、日本語の指示を英語に翻訳してからCodex Codeに渡す
  - mlx_lm.serverで起動したPLaMo-2-translateのURLを指定（例:
    http://localhost:8080）
  - 翻訳エラーが発生した場合は元の日本語テキストをそのまま使用

## 主要モジュール

### src/workspace.ts

- WorkspaceManager: 作業ディレクトリとデータ永続化の管理
- ThreadInfo: スレッド情報の型定義
- SessionLog: Codexセッションログの型定義
- AuditEntry: 監査ログの型定義

### src/admin.ts

- Admin: Workerの作成・管理、メッセージルーティング
- WorkspaceManagerと統合してスレッド情報と監査ログを記録

### src/worker.ts

- Worker: Codexコマンド実行、セッションログ記録
- WorkspaceManagerと統合してセッションログを永続化

### src/git-utils.ts (275行)

- GitRepository: リポジトリ情報の型定義
- parseRepository: リポジトリ名のパース
- ensureRepository: リポジトリのクローン・更新（WorkspaceManager対応）
- createWorktreeCopy: rsyncによるリポジトリコピーと独立ブランチ作成

**改善点:**

- createWorktreeCopy関数が130行以上と長大
- デフォルトブランチ名"main"のハードコード
- Git設定（ユーザー名・メール）のハードコード

### src/devcontainer.ts (403行)

- checkDevcontainerConfig: devcontainer.json存在確認
- checkDevcontainerCli: CLI利用可能性チェック
- startDevcontainer: コンテナ起動とストリーミングログ処理
- execInDevcontainer: コンテナ内コマンド実行

**改善点:**

- startDevcontainer関数が230行と巨大
- マジックナンバー（maxLogLines=30、progressInterval=2000）
- ログ処理とプログレス通知の責務混在

### src/gemini.ts (63行)

- summarizeWithGemini: Gemini APIを使用してテキストを要約
- generateThreadName: 要約とリポジトリ名からスレッド名を生成
- 最初のユーザーメッセージを基にDiscordスレッド名を自動生成

**改善点:**

- ハードコードされたモデル名
- キャッシング未実装
- リトライ機構の不在

### src/plamo-translator.ts (104行)

- PLaMoTranslator: PLaMo-2-translate APIクライアント
- translate: 日本語から英語への翻訳
- isAvailable: APIサーバーの可用性チェック
- コーディング指示に特化したシステムプロンプトを使用

**改善点:**

- temperature、max_tokensなどのマジックナンバー
- エラー種別の区別なし
- 型検証の不在

## テストコマンド

```bash
# 全体チェック
deno task test    # フォーマット、lint、型チェック、テスト実行

# 個別実行
deno task fmt     # フォーマット
deno task lint    # lint
deno task check   # 型チェック
deno test --allow-read --allow-write --allow-env --allow-run  # テストのみ

# トークン節約版（エラー時のみ詳細出力）
deno task test:quiet    # テスト実行（quiet版）
deno task fmt:quiet     # フォーマット（quiet版）
deno task lint:quiet    # lint（quiet版）
deno task check:quiet   # 型チェック（quiet版）
deno task test:all:quiet  # 全チェック（quiet版）
```

## データ永続化機能

- **スレッド情報**: 作成時刻、最終アクティブ時刻、リポジトリ情報、ステータス
- **セッションログ**:
  Codexとのやり取り（コマンド、レスポンス、エラー）を詳細記録
- **監査ログ**: Worker作成、メッセージ受信などのアクティビティをJSONL形式で記録
- **再起動対応**: アプリケーション再起動後もスレッド情報を復旧可能

## 開発方針（最重要）

- ライブラリは導入前に徹底的に調査し情報をdocsディレクトリ以下にまとめる
- ライブラリは最新のものを使用する
- テスト駆動開発により実装を行う
- 最小単位ごとに `deno check`, `deno test`, `deno lint`, `deno fmt`
  を実行して成功することを確認してから先に進む
  - testやlintの修正の中でフォーマットに合わないようになることがあるので必ずこの順番で確認を行う
  - **agent codingでは`deno task check:quiet`, `deno task test:quiet`,
    `deno task lint:quiet`, `deno task fmt:quiet`を使用してトークンを節約する**
- any型やlintの無視をしない
- 指示された作業が終わるごとにコミットする

### サブタスク（Taskツール）の効果的な活用

**同じような作業（特にコード変更）を連続して行う場合は、サブタスクに分割して子エージェントに作業させることを推奨する**。これによりコンテキストを節約でき、効率的な作業が可能になる。

#### 推奨される使用場面

1. **複数ファイルの類似変更**
   - 10個以上のファイルに同じパターンの変更を適用する場合
   - 各ファイルの変更を独立したサブタスクとして実行

2. **大規模リファクタリング**
   - 関数名やクラス名の一括変更
   - インポート文の整理
   - 型定義の更新

3. **テストの大量追加・修正**
   - 複数のテストファイルへの類似テストケース追加
   - テストパターンの統一化

#### サブタスク活用の利点

- **コンテキスト節約**:
  親エージェントは全体計画のみ保持し、詳細な実装は子エージェントが担当
- **並列処理可能**: 独立したタスクは並列で実行でき、全体の処理時間を短縮
- **エラー隔離**: 一つのサブタスクが失敗しても他のタスクに影響しない

## 標準的なものに加えて利用可能なツール

- ripgrep
- ast-grep(sg)
- semgrep

## 重要な実装パターン

### WorkspaceManagerの利用

```typescript
// WorkspaceManagerの初期化
const workspaceManager = new WorkspaceManager(env.WORK_BASE_DIR);
await workspaceManager.initialize();

// AdminとWorkerでの利用
const admin = new Admin(workspaceManager);
const worker = new Worker(name, workspaceManager, codexExecutor);
```

### エラーハンドリング

- ファイル操作はtry-catchで適切にエラーハンドリング
- NotFoundエラーは許容し、適切なデフォルト値を返す
- ログ記録失敗は運用に影響させず、console.errorで記録のみ

### テスト作成時の注意

- 各テストで独立したテスト用ディレクトリを使用
- 適切な権限フラグ（--allow-read --allow-write --allow-env）を指定
- テスト後のクリーンアップを確実に実行

## Codexメッセージ処理フロー

### メッセージの種別と処理の流れ

Discord BotがCodexからのメッセージを処理してDiscordに送信するまでの詳細な流れ：

#### 1. メッセージ受信フロー

```
Discord User → main.ts (MessageCreate) → admin.routeMessage() → worker.processMessage()
```

#### 2. Codex実行とストリーミング処理

**Worker.executeCodexStreaming()** (`src/worker.ts:438-527`)

- Codex CLIをJSON出力モードで実行
- ストリーミングで1行ずつJSON処理
- メッセージタイプごとに処理を分岐

#### 3. メッセージタイプ別の処理

**type: "session"**

- セッションIDを記録
- 初回のみ「🤖 Codexが考えています...」を送信

**type: "assistant"**

- `extractOutputMessage()`でコンテンツを抽出
- content配列の各要素を処理：
  - **text**: そのままテキストとして出力
  - **tool_use**: `formatToolUse()`でアイコン付きフォーマット
  - **tool_result**: `formatToolResult()`でスマート要約

**type: "result"**

- 最終結果を処理
- `formatResponse()`で2000文字制限対応

**type: "error"**

- エラーメッセージをそのまま返却
- レート制限エラーは特別処理

#### 4. フォーマット関数の詳細

**formatToolUse()** (`src/worker.ts:644-678`)

- ツール名に応じたアイコンを付与：
  - ⚡ Bash
  - 📖 Read
  - ✏️ Edit/Write
  - 🔍 Glob/Grep
  - 🌐 WebFetch/WebSearch
  - 📋 TodoRead
  - ✅ TodoWrite（特別フォーマット）

**formatToolResult()** (`src/worker.ts:693-758`)

- 結果の長さに応じた処理：
  - 500文字未満: 全文表示
  - 500-2000文字: 先頭・末尾表示
  - 2000文字以上: スマート要約
- エラー結果は error/fatal 行を優先表示

**formatResponse()** (`src/worker.ts:760-779`)

- Discord文字数制限（2000文字）対応
- ANSI エスケープコード除去
- 1900文字で切り詰め + 省略メッセージ

#### 5. Discord送信処理

**main.ts** (`src/main.ts:83-103`)

- 進行中メッセージ: 通知抑制フラグ付き送信
- 最終応答: ユーザーメンション付き送信
- レート制限時: ボタン付きメッセージ送信

#### 6. 特殊な処理

**TodoWrite の特別処理**

- チェックリスト形式に変換
- ✅ 完了、⬜ 未完了、🔄 進行中
- 成功メッセージは非表示

**レート制限対応**

- DiscordMessage型で返却
- 自動再開ボタンを提供
- タイマー永続化機能と連携

**セッションログ記録**

- 全メッセージをWorkspaceManager経由で永続化
- sessions/{thread_id}/{session_id}.json に保存
- 再起動後の継続性を保証

**重要な注意点**

- resultメッセージは進捗として送信されない
- extractOutputMessageでresultタイプはnullを返す
- これにより重複送信を防止（以前は3回送信されていた）

## 推奨されるアーキテクチャ改善

### 責務の分離

現在の主要3クラス（Admin、Worker、WorkspaceManager）は巨大で責務が多すぎるため、以下の分離を推奨：

#### Adminクラスの分離

- **WorkerManager**: Worker管理専用
- **RateLimitManager**: レート制限とタイマー管理
- **DevcontainerManager**: Devcontainer関連処理
- **MessageRouter**: メッセージルーティング専用

#### Workerクラスの分離

- **MessageFormatter**: フォーマット関連
- **CodexStreamProcessor**: ストリーミング処理
- **WorkerConfiguration**: 設定管理
- **SessionLogger**: セッションログ管理

#### WorkspaceManagerクラスの分離

- **ThreadManager**: スレッド情報管理
- **SessionManager**: セッションログ管理
- **AuditLogger**: 監査ログ管理
- **PatManager**: PAT情報管理
- **QueueManager**: メッセージキュー管理

### 設計パターンの適用

- **State Pattern**: Worker/Threadの状態遷移管理
- **Observer Pattern**: イベントベースのアーキテクチャ
- **Factory Pattern**: Worker作成ロジックの抽象化
- **Repository Pattern**: データアクセスロジックの抽象化
- **Strategy Pattern**: フォーマット処理の戦略化

### 共通改善点

- **マジックナンバーの定数化**: 全モジュールで散在
- **エラーハンドリングの統一**: カスタムエラー型の導入
- **型安全性の向上**: スキーマ検証の追加（Zodなど）
- **テスタビリティ向上**: 依存性注入の活用
- **ログ管理**: 専用Loggerクラスの導入

## スラッシュコマンド

### /stop

Codex
Code実行の中断機能を提供するスラッシュコマンド。詳細は[README.md#実行の中断](README.md#実行の中断)を参照。

## PR作成時の注意

PR作成の指示を出すとき、`gh pr create`の作成先がフォーク元のリポジトリになってしまうため、`pikachu0310`のリポジトリにPRを出すよう明示的に指定すること。

```bash
# 正しい例
gh pr create --head pikachu0310:branch-name --title "Title" --body "Body"

# または--repo指定
gh pr create --repo pikachu0310/repository-name --title "Title" --body "Body"
```
