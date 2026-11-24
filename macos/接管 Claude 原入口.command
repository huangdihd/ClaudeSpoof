#!/bin/zsh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="${1:-${CLAUDE_SPOOF_APP:-/Applications/Claude.app}}"
echo "请先完全退出 Claude。原路径会保留同名、同图标的启动入口；真正的官方 App 会移到隐藏目录，窗口名称仍是 Claude。"
node "$DIR/src/cli.js" install-wrapper --app "$APP_PATH"
echo "完成。以后继续从启动台、聚焦或 Dock 原来的 Claude 入口打开。"
