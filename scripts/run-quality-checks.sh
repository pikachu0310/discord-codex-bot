#!/bin/sh

# Common quality check script for git hooks
# Runs format, lint, type check, and tests
# Uses quiet versions to minimize token usage

# Function to run a check and handle errors
run_check() {
    local check_name="$1"
    local command="$2"
    local error_message="$3"
    
    echo "$check_name"
    if ! $command; then
        echo "$error_message"
        return 1
    fi
    return 0
}

# Function to run all quality checks
run_all_checks() {
    local mode="${1:-check}"  # Default to check mode
    
    echo "🔍 Running quality checks..."
    
    # Format check/fix
    if [ "$mode" = "fix" ]; then
        echo "📝 Running formatter..."
        # Get list of changed files before formatting
        CHANGED_FILES=$(git diff --name-only)
        deno task fmt:quiet
        # Check if any files were modified by formatter
        if [ -n "$(git diff --name-only)" ]; then
            echo "🔧 Files were auto-formatted. Adding formatted files to commit..."
            # Only add files that were actually changed by the formatter
            git diff --name-only | xargs -r git add
        fi
    else
        # Check mode - don't modify files
        if ! run_check "📝 Checking format..." "deno task fmt:quiet --check" "❌ Format check failed! Run 'deno fmt' で詳細を確認してください。"; then
            return 1
        fi
    fi
    
    # Run linter
    if ! run_check "🧹 Running linter..." "deno task lint:quiet" "❌ Lint check failed! Run 'deno lint' で詳細を確認してください。"; then
        return 1
    fi
    
    # Run type check
    if ! run_check "🔎 Running type check..." "deno task check:quiet" "❌ Type check failed! Run 'deno check' で詳細を確認してください。"; then
        return 1
    fi
    
    # Run tests
    if ! run_check "🧪 Running tests..." "deno task test:quiet" "❌ Tests failed! Run 'deno test --allow-read --allow-write --allow-env --allow-run' で詳細を確認してください。"; then
        return 1
    fi
    
    echo "✅ All quality checks passed!"
    return 0
}

# If script is being sourced, don't run anything
# If script is being executed directly, run the checks
if [ "${0##*/}" = "run-quality-checks.sh" ]; then
    run_all_checks "$@"
    exit $?
fi