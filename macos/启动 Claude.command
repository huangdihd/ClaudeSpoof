#!/bin/zsh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="${1:-${CLAUDE_SPOOF_APP:-/Applications/Claude.app}}"
node "$DIR/src/cli.js" start --app "$APP_PATH"
