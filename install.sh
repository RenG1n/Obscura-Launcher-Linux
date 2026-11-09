#!/usr/bin/env bash
# Установка Obscura одной командой (Debian/Ubuntu/Mint -> .deb, остальные -> AppImage в ~/.local/bin).
# Использование: curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/install.sh | bash
set -euo pipefail
REPO="${OBSCURA_REPO:-Admin/Obscura}"   # <- замените на ваш GitHub-репозиторий
[ "$REPO" != "Admin/Obscura" ] || { echo "Укажите репозиторий: OBSCURA_REPO=user/repo bash install.sh"; exit 1; }
API="https://api.github.com/repos/$REPO/releases/latest"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
if command -v apt >/dev/null; then pat='linux-x64\.deb'; else pat='linux-x64\.AppImage'; fi
url="$(curl -fsSL "$API" | grep -oE '"browser_download_url": *"[^"]+"' | grep -E "$pat" | head -1 | sed -E 's/.*"(https[^"]+)"/\1/')"
[ -n "$url" ] || { echo "Не найден файл в последнем релизе $REPO"; exit 1; }
file="$tmp/$(basename "$url")"
curl -fL --progress-bar -o "$file" "$url"
if [[ "$file" == *.deb ]]; then
  sudo apt install -y "$file"
else
  mkdir -p ~/.local/bin && install -m755 "$file" ~/.local/bin/obscura.AppImage
  echo "Готово: ~/.local/bin/obscura.AppImage"
fi
echo "Obscura установлена."
