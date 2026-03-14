#!/bin/sh

# Script to install git hooks for the project

echo "🔧 Setting up git hooks..."

# Get the git directory
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)

if [ -z "$GIT_DIR" ]; then
    echo "❌ Not in a git repository"
    exit 1
fi

# Configure git to use .githooks directory
git config core.hooksPath .githooks

echo "✅ Git hooks installed successfully!"
echo "📍 Hooks directory: .githooks/"
echo "🔨 pre-commit hook will run: format, lint, type check, and tests"