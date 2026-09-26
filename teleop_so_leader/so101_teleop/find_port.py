"""Find the USB/COM port of one SO-101 arm. Unplug when prompted."""

from __future__ import annotations

import platform
import time
from pathlib import Path

import _bootstrap  # noqa: F401

try:
    from serial.tools import list_ports
except ImportError as exc:
    raise SystemExit("pyserial is not installed. From this folder run: pip install -r requirements.txt") from exc


def find_available_ports() -> list[str]:
    if platform.system() == "Windows":
        return [port.device for port in list_ports.comports()]
    return [str(path) for path in Path("/dev").glob("tty*")]


def main() -> None:
    print("Finding all available ports for the MotorsBus.")
    ports_before = find_available_ports()
    print("Ports before disconnecting:", ports_before)

    input("Unplug the USB cable from ONE arm, then press Enter.")
    time.sleep(0.5)
    ports_after = find_available_ports()
    ports_diff = list(set(ports_before) - set(ports_after))

    if len(ports_diff) == 1:
        print(f"The port of this arm is '{ports_diff[0]}'")
        print("Plug the USB cable back in.")
        return
    if not ports_diff:
        raise OSError("Could not detect the port. No difference was found. Unplug only one USB cable.")
    raise OSError(f"Could not detect the port. More than one port disappeared: {ports_diff}")


if __name__ == "__main__":
    main()
