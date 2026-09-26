"""Make this folder importable no matter where you launch the scripts from."""

from __future__ import annotations

import sys
from pathlib import Path

if sys.version_info < (3, 12):
    raise SystemExit("so101_teleop needs Python 3.12 or newer. Check with: python --version")

KIT_ROOT = Path(__file__).resolve().parent
if str(KIT_ROOT) not in sys.path:
    sys.path.insert(0, str(KIT_ROOT))
