"""Writable per-user state, first-run migration and privacy-safe diagnostics."""
from __future__ import annotations

from contextlib import closing
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import platform
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading

from version import APP_VERSION

DEFAULT_SETTINGS = {"voicevoxPort": 50021, "whisperModel": "base", "defaultRate": 1.0}
SETTINGS_SCOPES = {"app": {"defaultRate"}, "dubbing": {"voicevoxPort", "whisperModel"}}


class StartupError(RuntimeError):
    """An application-authored message safe to display in a native dialog."""


def data_directory() -> Path:
    override = os.environ.get("CLIPNEST_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "ClipNest"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "ClipNest"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "ClipNest"


def atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".settings-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def validate_settings(values: dict) -> dict:
    if not isinstance(values, dict) or set(values) - DEFAULT_SETTINGS.keys():
        raise ValueError("未対応の設定が含まれています。")
    merged = {**DEFAULT_SETTINGS, **values}
    port = merged["voicevoxPort"]
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError("VOICEVOXのポートは1024〜65535の整数にしてください。")
    if merged["whisperModel"] not in ("tiny", "base", "small"):
        raise ValueError("Whisperモデルを選択してください。")
    rate = merged["defaultRate"]
    if type(rate) not in (int, float) or rate not in (0.5, 0.75, 1, 1.25, 1.5, 2):
        raise ValueError("既定の速度を選択してください。")
    return merged


class Settings:
    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self.path = self.directory / "settings.json"
        self.lock = threading.RLock()
        self.values = dict(DEFAULT_SETTINGS)
        if self.path.exists():
            try:
                self.values = validate_settings(json.loads(self.path.read_text(encoding="utf-8")))
            except (ValueError, TypeError, OSError):
                # Never silently overwrite an unreadable/newer configuration.
                raise StartupError("設定ファイルを読み込めません。保存先のsettings.jsonを別名で保管してから再起動してください。") from None

    def get(self) -> dict:
        with self.lock:
            return dict(self.values)

    def scoped(self, scope: str) -> dict:
        return {key: value for key, value in self.get().items() if key in SETTINGS_SCOPES[scope]}

    def save_scoped(self, scope: str, values: dict) -> dict:
        if not isinstance(values, dict) or set(values) - SETTINGS_SCOPES[scope]:
            raise ValueError("この画面では変更できない設定が含まれています。")
        with self.lock:
            self.save(values)
            return self.scoped(scope)

    def save(self, values: dict) -> dict:
        with self.lock:
            updated = validate_settings({**self.values, **values})
            atomic_json(self.path, updated)
            self.values = updated
            return self.get()


def setup_user_data(directory: Path, legacy_database: Path | None = None) -> bool:
    """Copy an old live SQLite database, including WAL. Never remove/overwrite it."""
    for child in (directory, directory / "logs", directory / "tools", directory / "asr_models"):
        child.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / "clipnest.sqlite3"
    migrated = False
    if legacy_database and legacy_database.is_file() and not target.exists() and legacy_database.resolve() != target.resolve():
        fd, temporary = tempfile.mkstemp(prefix=".migration-", dir=directory)
        os.close(fd)
        try:
            with closing(sqlite3.connect(legacy_database.resolve().as_uri() + "?mode=ro", uri=True)) as source:
                with closing(sqlite3.connect(temporary)) as destination:
                    source.backup(destination)
            try:
                # Atomic no-clobber publication, including simultaneous launches.
                os.link(temporary, target)
                migrated = True
            except FileExistsError:
                pass
        finally:
            Path(temporary).unlink(missing_ok=True)
    settings = Settings(directory)
    if not settings.path.exists():
        settings.save({})
    return migrated


def configure_logging(directory: Path) -> None:
    logger = logging.getLogger("clipnest")
    if logger.handlers:
        return
    handler = RotatingFileHandler(directory / "logs" / "clipnest.log", maxBytes=256_000, backupCount=3, encoding="utf-8")
    if os.name != "nt":
        os.chmod(handler.baseFilename, 0o600)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


def prepare_environment() -> None:
    # Finder does not inherit a shell's Homebrew PATH. Preserve user precedence.
    if sys.platform == "darwin":
        existing = os.environ.get("PATH", "").split(os.pathsep)
        for entry in ("/opt/homebrew/bin", "/usr/local/bin", str(Path.home() / ".deno" / "bin")):
            if entry not in existing:
                existing.append(entry)
        os.environ["PATH"] = os.pathsep.join(existing)


def worker_command(kind: str, source: Path | None = None) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "--worker", kind]
    if kind == "yt-dlp":
        return [sys.executable, "-m", "yt_dlp"]
    return [sys.executable, str(source)]


def subprocess_options() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def dependency_report(settings: Settings, service) -> dict:
    status = service.local_status()
    ffmpeg = shutil.which("ffmpeg") is not None
    return {
        "appVersion": APP_VERSION,
        "platform": sys.platform,
        "architecture": platform.machine(),
        "packaged": bool(getattr(sys, "frozen", False)),
        "ytDlp": {key: status.get(key) for key in ("available", "currentVersion", "ejsVersion", "runtimeDetails")},
        "ffmpeg": ffmpeg,
        "notes": [message for condition, message in (
            (not ffmpeg, "FFmpegがありません。Safariで音声加工用の互換音声を使う場合に必要です。導入後に再起動してください。"),
            (not any(status.get("runtimes", {}).values()), "Deno 2.3以上またはNode.js 22以上を導入してください。"),
        ) if condition],
        "privacy": "履歴・検索語・動画ID・ユーザー名・保存先・生ログは含めていません。自動送信はしません。",
    }
