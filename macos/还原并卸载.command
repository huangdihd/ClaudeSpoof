#!/bin/zsh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="${1:-${CLAUDE_SPOOF_APP:-/Applications/Claude.app}}"
echo "请先完全退出 Claude。将移除看门狗，并还原最近一次补丁前的官方文件与签名。"
node "$DIR/src/cli.js" uninstall --app "$APP_PATH"
