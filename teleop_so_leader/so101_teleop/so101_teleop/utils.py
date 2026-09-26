import logging
import select
import sys


def init_logging(console_level: str = "INFO") -> None:
    class _Formatter(logging.Formatter):
        def format(self, record: logging.LogRecord) -> str:
            record.lerobot_location = f"{record.pathname}:{record.lineno}"[-15:]
            return super().format(record)

    formatter = _Formatter(
        "%(levelname)s %(asctime)s %(lerobot_location)15s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    logger = logging.getLogger()
    logger.handlers.clear()
    logger.setLevel(logging.INFO)
    handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    handler.setLevel(console_level.upper())
    logger.addHandler(handler)


def enter_pressed() -> bool:
    if sys.platform == "win32":
        import msvcrt

        if msvcrt.kbhit():
            key = msvcrt.getch()
            return key in (b"\r", b"\n")
        return False
    ready, _, _ = select.select([sys.stdin], [], [], 0)
    return bool(ready) and sys.stdin.readline().strip() == ""


def move_cursor_up(lines: int) -> None:
    print(f"\033[{lines}A", end="")
