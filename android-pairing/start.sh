#!/data/data/com.termux/files/usr/bin/bash
set -eu
task_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v python >/dev/null 2>&1; then
  pkg install -y python
fi
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
  trap 'termux-wake-unlock >/dev/null 2>&1 || true' EXIT
fi
python "$task_dir/bridge.py"
