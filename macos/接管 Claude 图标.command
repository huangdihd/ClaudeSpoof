#!/bin/zsh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="${1:-${CLAUDE_SPOOF_APP:-/Applications/Claude.app}}"
echo "请先完全退出 Claude。真正的 App 会保留为同目录的 .Claude 原版.app。"
echo "若只是修复旧版签名导致的启动失败，请改用‘修复启动失败.command’。"
echo "原位置将换成同名、同图标的自动补丁启动器。"
node "$DIR/src/cli.js" install-launcher --app "$APP_PATH"
echo "完成。以后点击原来的 Claude 图标，就会先检查补丁再启动。"
