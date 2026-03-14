#!/bin/bash

# 開発環境用の起動スクリプト（HMR有効）

echo "🚀 Discord Botを開発モードで起動します..."
echo "📋 Hot Module Replacement (HMR)が有効です"
echo ""

# 環境変数ファイルの確認
if [ ! -f ".env" ]; then
    echo "❌ .envファイルが見つかりません。"
    echo "📝 .env.exampleをコピーして.envを作成してください。"
    exit 1
fi

# Denoのwatchモードで起動
# --watchオプションでファイル変更を監視
# --allow-*オプションで必要な権限を付与
exec deno run \
    --env-file \
    --watch \
    --allow-read \
    --allow-write \
    --allow-env \
    --allow-net \
    --allow-run \
    src/main.ts