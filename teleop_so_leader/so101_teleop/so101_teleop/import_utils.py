import importlib.metadata
import importlib.util

_require_package_cache: dict[str, bool] = {}


def is_package_available(pkg_name: str, import_name: str | None = None) -> bool:
    if import_name is None:
        import_name = pkg_name
    if importlib.util.find_spec(import_name) is None:
        return False
    try:
        importlib.metadata.version(pkg_name)
    except importlib.metadata.PackageNotFoundError:
        return False
    return True


def require_package(pkg_name: str, extra: str, import_name: str | None = None) -> None:
    cache_key = import_name or pkg_name
    if cache_key not in _require_package_cache:
        _require_package_cache[cache_key] = is_package_available(pkg_name, import_name)
    if not _require_package_cache[cache_key]:
        raise ImportError(
            f"'{pkg_name}' is required but not installed. "
            f"Install the deps in so101_teleop/requirements.txt (needed for '{extra}')."
        )


_serial_available = is_package_available("pyserial", import_name="serial")
_deepdiff_available = is_package_available("deepdiff")
_feetech_sdk_available = is_package_available("feetech-servo-sdk", import_name="scservo_sdk")
