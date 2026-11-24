#!/bin/zsh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="${1:-${CLAUDE_SPOOF_APP:-/Applications/Claude.app}}"
echo "请先完全退出 Claude。将移除原路径启动器，并把真正的官方 App 放回原位置。"
node "$DIR/src/cli.js" remove-wrapper --app "$APP_PATH"
echo "原入口已恢复为官方 Claude.app。"
