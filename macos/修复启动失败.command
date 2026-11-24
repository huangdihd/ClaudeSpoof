#!/bin/zsh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="${1:-${CLAUDE_SPOOF_APP:-/Applications/Claude.app}}"
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 18 或更新版本。"
  exit 1
fi
echo "请先完全退出 Claude。此操作只修复签名，不会改写官方还原备份。"
node "$DIR/src/cli.js" repair-sign --app "$APP_PATH"
echo
echo "签名修复完成。现在可以重新点击原来的 Claude 图标。"
