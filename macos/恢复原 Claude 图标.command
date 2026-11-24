#!/bin/zsh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="${1:-${CLAUDE_SPOOF_APP:-/Applications/Claude.app}}"
echo "请先完全退出 Claude。将移除外层启动器，并把真正的 Claude 放回原位置。"
node "$DIR/src/cli.js" uninstall-launcher --app "$APP_PATH"
echo "原图标已恢复；时区语言补丁和更新看门狗仍保留。"
