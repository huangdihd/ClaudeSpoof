#!/bin/zsh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "直接回车使用括号内默认值。可输入 en-US、zh-Hans、zh-Hant 等语言标签。"
printf "时区 [Europe/London]："
read TIMEZONE
TIMEZONE="${TIMEZONE:-Europe/London}"
printf "语言 [en-GB]："
read LANGUAGE
LANGUAGE="${LANGUAGE:-en-GB}"
node "$DIR/src/cli.js" config --timezone "$TIMEZONE" --language "$LANGUAGE"
echo "请完全退出 Claude，再用“启动 Claude.command”重新打开。"
