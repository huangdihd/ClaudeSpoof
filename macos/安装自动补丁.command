#!/bin/zsh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="${1:-${CLAUDE_SPOOF_APP:-/Applications/Claude.app}}"
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 18 或更新版本。若已安装 Homebrew，可先执行：brew install node"
  exit 1
fi
if [ ! -d "$DIR/node_modules/@electron/asar" ]; then
  echo "首次运行，正在安装锁定版本的依赖……"
  (cd "$DIR" && npm ci)
fi
echo "目标：$APP_PATH"
echo "请先完全退出 Claude。安装会立即补丁，并注册更新看门狗。"
node "$DIR/src/cli.js" install --app "$APP_PATH"
