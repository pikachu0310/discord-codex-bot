# Discord Codex Bot 再調査・新仕様書（TypeScript/Deno 再実装版）

最終更新: 2026-04-14  
対象リポジトリ: `discord-codex-bot`  
対象ブランチ: `worker/2026-04-09/worker-150249-wise-crow`

---

## 1. 本書の目的

本書は、現行実装を再調査した上で、次回の再実装を行うための新仕様を1つに統合したドキュメントである。  
以下を同時に満たすことを目的とする。

1. 現行リポジトリの仕様・挙動・実装構造をできる限り正確に記録する。
2. 不要機能を撤廃し、運用負荷を下げた新仕様を明文化する。
3. 新仕様の実装言語は現行と同じ **TypeScript/Deno** とする。
4. 実装時の判断ブレを防ぐため、削除対象・再実装対象・移行方針・テスト方針まで定義する。

---

## 2. 今回の前提と意思決定（重要）

### 2.1 言語方針

- 以前の「Goで再構築」方針は現時点では採用しない。
- 今回の再実装言語は、現行と同じ **TypeScript + Deno**。

### 2.2 機能削減方針（今回の主眼）

以下は「完全撤廃」対象。

1. devcontainer関連機能一式
2. CLIオプション/モードのフォールバック機能一式
3. 翻訳機能（PLaMo連携）
4. Gemini連携（スレッド名生成含む）
5. PAT管理機能一式（保存・読込・一覧・削除）
6. レート制限時の再実行・キュー・自動再開

### 2.3 追加・再実装方針（今回の主眼）

以下は「新実装/再実装」対象。

1. Codex CLI実行形式の統一（resume有無だけ分岐）
2. `/status` コマンドで「残り使用量%」を表示
3. Discordプロフィール表示でも「残り使用量%」を表示
4. スレッド名生成はGeminiではなくCodexを利用

---

## 3. 現行実装の全体像（調査結果）

## 3.1 実行時アーキテクチャ

現行は大きく4層。

1. `src/main.ts`
2. `src/admin/*`
3. `src/worker/*`
4. `src/workspace/*`

責務は以下。

1. `main.ts`: Discordイベント、Slashコマンド登録、メッセージ入口、スレッド名変更トリガー、定期Presence更新。
2. `Admin`: Worker管理、ルーティング、復旧、終了処理、devcontainer統制、rate limit統制のハブ。
3. `Worker`: Codex CLI実行、ストリーム解析、レスポンス整形、翻訳、セッション保存、中断。
4. `WorkspaceManager`: JSON/JSONLベースの永続化管理。

## 3.2 現行Slashコマンド

`src/main.ts` で登録されているコマンド。

1. `/start`
2. `/set-pat`
3. `/list-pats`
4. `/delete-pat`
5. `/stop`
6. `/plan`
7. `/close`

注記:

- `/status` は未実装。
- `/config devcontainer on|off` はSlashではなくメッセージコマンドで処理。

## 3.3 現行の起動時チェック

`src/system-check.ts`:

1. 必須: `git`, `codex`
2. 推奨: `gh`, `devcontainer`

注記:

- 推奨扱いだが、実際のcloneは `gh repo clone` 固定実装であり `gh` 依存が強い。

## 3.4 現行のCodex実行フロー

`Worker.processMessage` 概略:

1. repository/worktree存在チェック
2. 設定完了チェック（devcontainer選択済み想定）
3. 任意翻訳（PLaMo）
4. 進捗送信（「Codexが考えています」）
5. Codex実行
6. JSONL/イベント解析し進捗・最終結果生成
7. session保存

## 3.5 現行のCLIフォールバック挙動

`src/worker/worker.ts` + `src/worker/worker-configuration.ts` + `src/worker/codex-cli-capabilities.ts` により、失敗時に段階的フォールバックを行う。

1. `--output-format` 無効化
2. `--verbose` 無効化
3. `--dangerously-skip-permissions` 無効化
4. `--search` 無効化
5. `exec --json` モードから legacyへ切替
6. `--color` 無効化
7. `--dangerously-bypass-approvals-and-sandbox` 無効化
8. TTY要求時は `script` 経由の擬似TTY再試行

これは保守性・追跡可能性を下げる主要因。

## 3.6 現行のレート制限挙動

`RateLimitManager` + `MessageRouter`:

1. 制限中判定時はメッセージをキューへ積む。
2. 5分後に自動再開するタイマーを持つ。
3. 再起動後もタイマーを復旧する。
4. 自動再開時はキュー先頭を再送し、キューをクリアする。

追加で、Presenceを制限表示に切替。

## 3.7 現行のトークン使用量挙動

`TokenUsageTracker`:

1. デフォルト上限は100000（24h想定）。
2. `usagePercentage` は「使用率%」を返す。
3. `getStatusString()` は使用済み量ベースの文言。
4. 5h/1w上限が設定されると窓別パーセンテージも付く。

問題:

1. `/status` コマンドが無い。
2. 表示が「残量%」ではなく「使用率%」中心。
3. イベント経路によって usage追跡が多重実行される可能性がある。
4. UTC0時コメントと実装の時刻生成方法にズレ要素がある。

## 3.8 現行のスレッド名変更挙動

`main.ts` の `MessageCreate` 内で、`GEMINI_API_KEY` 存在時のみ動作。

1. 最初のメッセージをGeminiで要約
2. `generateThreadName` で最終名生成
3. `thread.setName` で更新

## 3.9 現行のdevcontainer挙動

`src/devcontainer.ts` と `src/admin/devcontainer-manager.ts`:

1. `.devcontainer/devcontainer.json` / `.devcontainer.json` を検出
2. CLI有無で分岐
3. fallback devcontainer有
4. 起動進捗をDiscordへ送信
5. `docker rm -f -v` で削除
6. PATを環境変数注入して利用可能

## 3.10 現行のPAT挙動

1. `/set-pat`, `/list-pats`, `/delete-pat`
2. `pats/*.json` 平文保存
3. devcontainerやexecutorへ `GH_TOKEN/GITHUB_TOKEN` として注入

## 3.11 現行永続化（WORK_BASE_DIR）

主ディレクトリ:

1. `repositories/`
2. `worktrees/`
3. `threads/`
4. `workers/`
5. `admin/`
6. `sessions/`
7. `audit/`
8. `pats/`
9. `queued_messages/`

---

## 4. 現行実装の複雑化ポイント（再設計根拠）

## 4.1 複雑化の核

1. devcontainer分岐が多段で、Worker/Manager/CLI/設定/永続化に横断的に拡散。
2. CLIフォールバックが多段で、失敗時挙動が読みにくい。
3. レート制限のキュー・タイマー・復旧・ボタン制御が広範囲に存在。
4. PAT管理がclone/devcontainer/executor/workspaceへ横断。
5. 翻訳とGeminiが処理経路を増やし、失敗パスを増加。
6. `/status` 不在で運用上欲しい指標（残量%）確認手段が無い。

## 4.2 不整合の具体例

1. システムチェックでは `gh` は推奨扱いだが、cloneは `gh` 依存。
2. `isConfigurationComplete()` は実質常に真になりやすく、設計意図との差がある。
3. Token usage集計がイベント経路ごとに重複トラッキングされる余地がある。
4. QueueManager系と `workerState.queuedMessages` の2系統が併存。

---

## 5. 新仕様（最終決定版）

以下は再実装時の必須仕様。

## 5.1 非機能要件

1. 実装言語: TypeScript/Denoを継続。
2. 外部依存を最小化し、運用理解しやすい構造にする。
3. 機能削減を優先し、保守性を最大化する。

## 5.2 機能削除仕様

完全削除するもの:

1. devcontainer関連ファイル/ロジック/コマンド/UI/設定/状態
2. fallback devcontainer関連
3. CLIフォールバックロジック一式
4. 翻訳ロジック（PLaMo）
5. Gemini要約ロジック
6. PATロジック（Slashコマンド、保存領域、注入処理）
7. レート制限時のキュー/自動再開/復旧タイマー/ボタン

## 5.3 Codex CLI実行統一仕様

実行形式を以下に統一する。

### 5.3.1 新規ターン（resumeなし）

`codex --search exec --json --color never --dangerously-bypass-approvals-and-sandbox "<prompt>"`

### 5.3.2 継続ターン（resumeあり）

`codex --search exec --json --color never --dangerously-bypass-approvals-and-sandbox resume <resume_id> "<prompt>"`

仕様注記:

1. 分岐は resume有無のみ。
2. capability検出・エラー文言判定による自動フォールバックは禁止。
3. 上記形式で失敗した場合は即時エラー返却。
4. `<resume_id>` の内部実体はCodexが要求するIDに合わせる。UI/設計上 `thread_id` を受ける場合は、内部で `thread_id -> session_id` を解決して実行する。

## 5.4 レート制限仕様（簡素化）

1. レート制限検出時は「エラーを返すだけ」とする。
2. キュー保存しない。
3. 自動再開しない。
4. 再起動復旧しない。
5. ボタンUI提供しない。

返却メッセージ例:

`Codexのレート制限に達しました。時間を置いて再実行してください。`

## 5.5 `/status` 新仕様

### 5.5.1 目的

ユーザーが現在の「残り使用量%」を即時確認できるようにする。

### 5.5.2 出力必須項目

1. 24h枠の残り使用量%
2. 24h枠の使用済みトークン/上限
3. 次回リセット時刻（UTCとJST）
4. 可能なら5h/1w枠の残量%（設定済み時のみ）

### 5.5.3 計算式

1. `used_pct = round((used_tokens / limit_tokens) * 100)`
2. `remaining_pct = clamp(100 - used_pct, 0, 100)`

### 5.5.4 単一真実源（source of truth）

`TokenUsageTracker` を再実装し、以下を必ず満たす。

1. 内部表現は「使用量」を保持
2. 表示APIで「残量%」を返せること
3. `/status` とPresenceが同じ計算結果を共有すること

## 5.6 Discordプロフィール表示仕様（再実装）

Presenceの活動名に「残り使用量%」を表示する。  
更新タイミングは以下。

1. 起動直後
2. トークン使用量更新後
3. 定期更新（現行の10分間隔を継続可）

推奨表示例:

`残量 72% | 24h 28k/100k`

## 5.7 スレッド名生成仕様（Gemini廃止、Codex化）

### 5.7.1 方針

1. Gemini API不使用。
2. Codexを使って短いタイトルを生成。
3. 失敗時は従来の暫定名維持。

### 5.7.2 実行仕様

1. 初回ユーザーメッセージを入力にする。
2. 専用プロンプトで「30文字以内の日本語タイトル」を生成。
3. 記号制限、Discord名長制限を満たす。

プロンプト要件（例）:

1. 最大30文字
2. 意味が明確
3. 不要な装飾禁止
4. 返答はタイトル文字列のみ

---

## 6. 新仕様アーキテクチャ

## 6.1 モジュール構成（再実装後）

最小構成:

1. `main.ts`
2. `admin/`（Worker管理とルーティング）
3. `worker/`（Codex実行と出力処理）
4. `workspace/`（永続化）
5. `token-usage-tracker.ts`

削除により不要:

1. `devcontainer.ts` / `admin/devcontainer-manager.ts`
2. `gemini.ts`
3. `plamo-translator.ts`
4. `worker/codex-cli-capabilities.ts`
5. `workspace/pat-manager.ts`
6. `workspace/queue-manager.ts`

## 6.2 新Worker責務

1. 固定CLI形式でCodexを実行
2. ストリーム解析とDiscord進捗投稿
3. 最終応答返却
4. session_id保存
5. トークンusageを一意に加算

## 6.3 新RateLimit責務

1. 検出
2. エラー整形
3. Presenceへの反映（必要なら）

それ以外（キュー/再開/タイマー）は持たない。

---

## 7. データモデル新仕様（v2）

## 7.1 `WorkerState`（提案）

`devcontainerConfig`, `queuedMessages`, `autoResumeAfterRateLimit` を削除。

提案構造:

```json
{
  "workerName": "worker-xxxx",
  "threadId": "123456789012345678",
  "repository": {
    "fullName": "owner/repo",
    "org": "owner",
    "repo": "repo"
  },
  "repositoryLocalPath": "/abs/path/to/repositories/owner/repo",
  "worktreePath": "/abs/path/to/worktrees/123456789012345678",
  "sessionId": "019a....",
  "status": "active",
  "createdAt": "2026-04-14T00:00:00.000Z",
  "lastActiveAt": "2026-04-14T00:00:00.000Z",
  "isPlanMode": false
}
```

## 7.2 `AdminState`（継続）

継続:

1. `activeThreadIds`
2. `lastUpdated`

## 7.3 Token usage保存（新規または再定義）

運用安定のため、永続化を推奨。

例:

```json
{
  "window24h": {
    "limit": 100000,
    "used": 28000,
    "resetAt": "2026-04-15T00:00:00.000Z"
  },
  "window5h": {
    "limit": 40000,
    "used": 9000
  },
  "window1w": {
    "limit": 300000,
    "used": 24000
  },
  "updatedAt": "2026-04-14T12:34:56.000Z"
}
```

---

## 8. トークン使用量集計の再実装仕様（バグ対策）

## 8.1 既存課題

1. usage情報取得経路が複数あり、同ターン二重加算の可能性。
2. `/status` が未実装で確認経路が無い。
3. 表示値が「残量」基準で統一されていない。

## 8.2 新規集計ルール

1. 1ターンにつき1回のみ加算する。
2. 加算トリガーは優先順位を定義する。
3. 同一ターン判定キーを導入し重複排除する。

推奨キー:

1. `session_id + turn_index`
2. 上記が無い場合は `session_id + hash(raw_usage_payload)`

## 8.3 表示API

必須メソッド:

1. `getUsageInfo()`
2. `getRemainingPercentage()`
3. `getStatusLineForPresence()`
4. `getStatusObjectForSlashCommand()`

---

## 9. Discord仕様（新）

## 9.1 Slashコマンド構成

維持:

1. `/start`
2. `/stop`
3. `/plan`
4. `/close`
5. `/status`（追加）

削除:

1. `/set-pat`
2. `/list-pats`
3. `/delete-pat`

## 9.2 `/status` レスポンス仕様

例:

```text
📊 Codex使用状況
- 24h 残量: 72%
- 24h 使用量: 28,000 / 100,000
- 次回リセット(UTC): 2026-04-15 00:00
- 次回リセット(JST): 2026-04-15 09:00
- 5h 残量: 77%  (設定時のみ)
- 1w 残量: 92%  (設定時のみ)
```

## 9.3 進捗投稿仕様

現行のDiscord分割ロジック（1500字分割）は継続可能。  
ただし機能削減により、進捗文言は簡素化する。

---

## 10. レート制限エラー仕様（新）

## 10.1 検出

検出ロジックは維持して良いが、状態保存は最小化する。

## 10.2 エラー返却

返却する内部エラー型例:

```ts
type WorkerError =
  | { type: "RATE_LIMIT"; timestamp?: number; message: string }
  | ...
```

## 10.3 監査ログ

監査ログには残す:

1. `rate_limit_detected`
2. `thread_id`
3. `session_id`（あれば）
4. `timestamp`

---

## 11. スレッド名生成のCodex化詳細仕様

## 11.1 目的

Gemini依存をなくし、モデル/認証系統をCodex一本化する。

## 11.2 実装方式

1. thread初回メッセージ受信時に非同期実行。
2. 固定CLI形式で短文生成を実行。
3. 生成結果を正規化して `thread.setName`。

## 11.3 正規化規則

1. 30文字以内
2. 先頭/末尾空白除去
3. 改行除去
4. Discordで扱いにくい記号除去
5. 空文字なら更新しない

---

## 12. 削除対象詳細（ファイル・機能）

## 12.1 削除候補ファイル（高優先）

1. `src/devcontainer.ts`
2. `src/admin/devcontainer-manager.ts`
3. `src/gemini.ts`
4. `src/plamo-translator.ts`
5. `src/worker/codex-cli-capabilities.ts`
6. `src/workspace/pat-manager.ts`
7. `src/workspace/queue-manager.ts`
8. `fallback_devcontainer/**`
9. `.devcontainer/**`

## 12.2 削除候補テスト（機能削除に伴い不要）

1. devcontainer関連テスト群
2. PAT関連テスト群
3. translation関連テスト群
4. fallback関連テスト群
5. rate-limit queue/auto-resume関連テスト群
6. CLI fallback関連テスト群
7. gemini関連テスト

---

## 13. 改修対象詳細（主なファイル）

## 13.1 `src/main.ts`

変更:

1. SlashコマンドからPAT系削除
2. `/status` 追加
3. `/config devcontainer ...` 処理削除
4. Gemini連携削除
5. Codexベースのスレッド名生成ロジック導入

## 13.2 `src/admin/admin.ts`

変更:

1. `DevcontainerManager` 依存削除
2. `RateLimitManager` を簡素版へ差し替え
3. `/status` 用のusage問い合わせAPI追加

## 13.3 `src/admin/message-router.ts`

変更:

1. レート制限時 `queueMessage` 呼び出し削除
2. 即時エラー返却のみ

## 13.4 `src/admin/rate-limit-manager.ts`

変更:

1. タイマー管理削除
2. キュー管理削除
3. auto-resume callback削除
4. token usageの集計・取得APIに集中

## 13.5 `src/worker/worker.ts`

変更:

1. 翻訳関連削除
2. devcontainer関連削除
3. CLIフォールバック削除
4. 固定CLI引数で1回実行
5. usage多重加算防止

## 13.6 `src/worker/worker-configuration.ts`

変更:

1. capabilityベース分岐削除
2. 固定引数ビルダーへ簡素化

## 13.7 `src/system-check.ts`

変更:

1. `devcontainer` 推奨チェック削除
2. `gh` を必須にするか、clone実装を `git clone` へ変更するかを明示決定（要選択）

推奨:

1. cloneを `git clone` 化し、`gh` 依存を削除する。
2. その場合、システムチェック必須は `git`, `codex` のみで矛盾がなくなる。

## 13.8 `src/workspace/workspace.ts` + schema群

変更:

1. PAT関連API削除
2. Queue関連API削除
3. WorkerState schema簡素化
4. 不要ディレクトリ初期化削除

---

## 14. マイグレーション仕様

## 14.1 互換対象

既存ユーザーの運用を壊さないため、以下を継続。

1. 既存thread/worker/adminの読み込み
2. 旧WorkerState読み込み時の補正

## 14.2 旧データ処理

旧stateに以下があっても無視できること。

1. `devcontainerConfig`
2. `queuedMessages`
3. `rateLimitTimestamp`
4. `autoResumeAfterRateLimit`

## 14.3 片付け処理

起動時に以下を段階的に削除可能。

1. `pats/`
2. `queued_messages/`
3. `fallback_devcontainer/`（リポジトリ内構成として）

---

## 15. テスト仕様（再実装後）

## 15.1 必須ユニットテスト

1. 固定CLI引数生成（resume有無）
2. `/status` 残量%計算
3. Presence表示文字列生成
4. usage重複排除ロジック
5. rate-limit時の即時エラー返却
6. Codexベーススレッド名生成の正規化

## 15.2 必須統合テスト

1. `/start` -> メッセージ送信 -> 応答まで
2. `/status` 実行で期待フォーマット返却
3. レート制限イベント時にキューされないこと
4. 再起動後に不要なタイマー復旧処理が発生しないこと

## 15.3 削除/改修対象テスト群

以下は削除または全面改修:

1. devcontainer系
2. PAT系
3. translation系
4. CLI fallback系
5. rate-limit auto-resume/queue系
6. gemini系

---

## 16. 受け入れ基準（Definition of Done）

以下を全て満たしたら完了。

1. 新仕様のコマンド体系で全メッセージ処理が動作する。
2. devcontainer/PAT/翻訳/Gemini/queue/auto-resume/fallbackコードが除去済み。
3. `/status` で残量%が取得・表示できる。
4. Presenceでも残量%が表示される。
5. テストが新仕様でグリーン。
6. READMEと`.env.example`が新仕様と一致。

---

## 17. 実装ステップ推奨順

1. データモデル簡素化（schema/workspace）
2. Workerの固定CLI化
3. RateLimit簡素化
4. `/status` + Presence再実装
5. スレッド名Codex化
6. コマンド/UI整理
7. 不要ファイル削除
8. テスト再編
9. README更新

---

## 18. リスクと対策

## 18.1 resume ID扱い

リスク:

- `thread_id` と `session_id` の混同で resume失敗。

対策:

1. 仕様上の公開パラメータ名と内部実行IDを分ける。
2. `thread_id -> last_session_id` 解決を明示実装。
3. 解決失敗時は新規ターンへフォールバックせず、明示エラー返却。

## 18.2 usage精度

リスク:

- イベント差異で usage取得できないケースがある。

対策:

1. 収集優先順位を定義する。
2. 取得失敗時は「不明」と表示し、0扱いにしない。
3. ログに取得元イベントを記録する。

## 18.3 既存データとの互換

リスク:

- 旧WorkerStateが読めず復旧失敗。

対策:

1. `loadWorkerState` で後方互換補正を維持。
2. 新形式書き戻しを段階移行する。

---

## 19. 変更要点サマリ（短縮版）

1. 言語はTypeScript/Deno継続。
2. 機能は大幅削減し、コアをCodex実行に集中。
3. CLI実行形式を固定化し、フォールバック廃止。
4. レート制限は即時エラー化。
5. `/status` とPresenceで残量%を可視化。
6. スレッド名生成をGeminiからCodexへ統一。

---

## 20. 実装時チェックリスト

1. `main.ts` のSlashコマンドからPAT系削除済み
2. `/status` 追加済み
3. `/config devcontainer ...` 削除済み
4. `devcontainer` 依存コード削除済み
5. `gemini.ts` / `plamo-translator.ts` 参照ゼロ
6. `codex-cli-capabilities.ts` 参照ゼロ
7. rate-limit queue/timer参照ゼロ
8. `pats` / `queued_messages` 初期化ゼロ
9. Presence表示が残量%ベース
10. README/.env.exampleが新仕様と整合

---

## 付録A: 調査対象ファイル一覧

本付録は `git ls-files` に基づく追跡ファイル一覧を後段で追記する。




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
