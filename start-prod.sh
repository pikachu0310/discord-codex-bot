#!/bin/bash

# 本番環境用の起動スクリプト

echo "🚀 Discord Botを本番モードで起動します..."
echo ""

# 環境変数ファイルの確認
if [ ! -f ".env" ]; then
    echo "❌ .envファイルが見つかりません。"
    echo "📝 .env.exampleをコピーして.envを作成してください。"
    exit 1
fi

# 通常モードで起動（HMRなし）
exec deno run \
    --env-file \
    --allow-read \
    --allow-write \
    --allow-env \
    --allow-net \
    --allow-run \
    src/main.ts