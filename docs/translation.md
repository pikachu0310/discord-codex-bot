# 翻訳機能（PLaMo-2-translate）

## 概要

日本語でCodex
Codeに指示を送ると、PLaMo-2-translateを使用して自動的に英語に翻訳してからCodex
Codeに渡す機能です。これにより、より効果的なコーディング指示が可能になります。

## セットアップ

### 1. PLaMo-2-translateのセットアップ

```bash
# Homebrewでmlx-lmをインストール（macOS）
brew install mlx-lm

# または pipでインストール
pip install mlx-lm

# PLaMo-2-translateモデルをダウンロード
mlx_lm.convert --model pfnet/plamo-2-translate

# サーバーを起動
mlx_lm.server --model mlx-community/plamo-2-translate --port 8080
```

### 2. 環境変数の設定

```bash
# .envファイルに追加
PLAMO_TRANSLATOR_URL=http://localhost:8080
```

## 使い方

環境変数が設定されていれば、自動的に日本語のメッセージが英語に翻訳されます。

### 例

**入力（日本語）:**

```
認証機能を実装してください。JWTトークンを使用し、適切なエラーハンドリングを含めてください。
```

**翻訳後（英語）:**

```
Implement authentication functionality. Use JWT tokens and include proper error handling.
```

## 翻訳の特徴

### システムプロンプト

PLaMo-2-translateには、コーディング指示に特化した以下のようなシステムプロンプトが設定されています：

1. **技術用語の保持**:
   API、function、classなどのプログラミング用語はそのまま保持
2. **コードスニペット、ファイルパス、URLは変更しない**
3. **命令形での翻訳**: "Implement...", "Create...",
   "Fix..."のような直接的な指示に変換
4. **明確性と具体性の維持**: コーディングタスクに適した明確な指示に翻訳
5. **曖昧さの排除**: 元のテキストに曖昧さがある場合、より明確な表現に翻訳

### 翻訳例

| 日本語                                                               | 英語                                                |
| -------------------------------------------------------------------- | --------------------------------------------------- |
| 認証機能を実装してください                                           | Implement authentication functionality              |
| エラーハンドリングを追加して、適切なログを出力するようにしてください | Add error handling and ensure proper logging output |
| src/main.tsファイルのbugを修正してください                           | Fix the bug in src/main.ts file                     |
| このコンポーネントにテストを追加してください                         | Add tests to this component                         |
| パフォーマンスを改善してください                                     | Improve performance                                 |

## エラーハンドリング

- **翻訳APIが利用できない場合**: 元の日本語テキストをそのまま使用
- **翻訳エラーが発生した場合**: 元の日本語テキストをそのまま使用
- **ネットワークエラー**: 5秒でタイムアウトし、元のテキストを使用

## VERBOSEモード

`VERBOSE=true`を設定すると、翻訳の詳細がログに出力されます：

```
[2024-01-01T12:00:00.000Z] [Worker:worker-name] 翻訳結果:
  元のメッセージ: "認証機能を実装してください"
  翻訳後: "Implement authentication functionality"
```

## パフォーマンス

- **翻訳時間**: 通常1秒以内
- **キャッシュ**: 現在はキャッシュ機能なし（将来的に実装予定）
- **並行処理**: 各Workerが独立して翻訳を実行

## 注意事項

1. **プライバシー**: 翻訳APIに送信されるテキストには機密情報を含めないでください
2. **コスト**:
   PLaMo-2-translateはローカルで実行されるため、API利用料金は発生しません
3. **精度**:
   100%の翻訳精度は保証されません。重要な指示は英語で直接記述することを推奨します
