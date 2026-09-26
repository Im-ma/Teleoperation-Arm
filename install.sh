#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Install Python 3.12 or newer."
  exit 1
fi

python3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)" || {
  echo "This kit needs Python 3.12 or newer."
  python3 --version
  exit 1
}

if [ ! -d .venv ]; then
  echo "Creating .venv ..."
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
echo
echo "Setup finished. Activate with: source .venv/bin/activate"
echo "Then: python teleoperate.py --port COM3 --id my_arm"
