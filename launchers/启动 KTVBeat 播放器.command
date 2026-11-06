#!/bin/zsh
ROOT="${0:A:h:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "$ROOT/app/player" || exit 1
if ! command -v node >/dev/null 2>&1; then
  print '未找到 Node.js。需要 Node.js 22 或更新版本。'
  read -r '?按回车关闭'
  exit 1
fi
print 'KTVBeat 三轨播放器'
print '浏览器地址：http://127.0.0.1:17862'
print '请保持此终端打开。'
node server.mjs --open
RESULT=$?
if (( RESULT != 0 )); then
  read -r '?启动失败，按回车关闭'
fi
exit "$RESULT"
