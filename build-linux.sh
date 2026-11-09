#!/usr/bin/env bash
# Obscura — сборка для Linux: AppImage, .deb и .tar.gz в папке dist/
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Нужен Node.js 22+ (см. ИНСТРУКЦИЯ-LINUX.txt: nvm или NodeSource)"; exit 1; }
command -v npm >/dev/null || { echo "Не найден npm (ставится вместе с Node.js)"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "Нужен Node.js 22 или новее (сейчас $(node -v))"; exit 1; }
npm install
npm test
npm run dist:linux
echo
echo "Готово. Файлы в папке dist/:"
ls -1 dist | grep -E '\.(AppImage|deb|tar\.gz)$' || true
