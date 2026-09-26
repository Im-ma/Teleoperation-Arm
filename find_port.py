"""Show the COM/tty port of the one SO-101 arm."""

from __future__ import annotations

import platform
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
    if platform.system() == "Windows":
        found = [(p.device, p.description) for p in list_ports.comports()]
        if not found:
            raise SystemExit("No COM ports found. Plug in the arm (USB and power), then run this again.")
        print("Connected serial ports:")
        for device, description in found:
            print(f"  {device}  {description}")
        if len(found) == 1:
            print(f"\nUse this port: {found[0][0]}")
        return

    ports = find_available_ports()
    if not ports:
        raise SystemExit("No serial ports found. Plug in the arm (USB and power), then run this again.")
    print("Connected serial ports:")
    for port in ports:
        print(f"  {port}")
    if len(ports) == 1:
        print(f"\nUse this port: {ports[0]}")


if __name__ == "__main__":
    main()
