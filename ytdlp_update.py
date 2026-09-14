"""Opt-in installation of official yt-dlp standalone releases (not system pip)."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

from app_runtime import atomic_json, data_directory

RELEASE_API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
ALLOWED_HOSTS = {"api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
VERSION = re.compile(r"\d{4}\.\d{2}\.\d{2}(?:\.\d+)?")


def asset_name() -> str:
    if sys.platform == "darwin":
        return "yt-dlp_macos"
    if sys.platform == "win32":
        return "yt-dlp_arm64.exe" if platform.machine().lower() in ("arm64", "aarch64") else "yt-dlp.exe"
    if sys.platform.startswith("linux"):
        return "yt-dlp_linux_aarch64" if platform.machine().lower() in ("arm64", "aarch64") else "yt-dlp_linux"
    raise RuntimeError("このOSでは設定画面からの更新に対応していません。")


def safe_url(url: str) -> bool:
    parsed = urllib.parse.urlsplit(url)
    return parsed.scheme == "https" and parsed.hostname in ALLOWED_HOSTS and not parsed.username and not parsed.password and parsed.port in (None, 443)


class ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not safe_url(newurl):
            raise RuntimeError("更新元を確認できないため中止しました。")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url: str, limit: int) -> bytes:
    if not safe_url(url):
        raise RuntimeError("更新元を確認できないため中止しました。")
    opener = urllib.request.build_opener(ReleaseRedirect())
    accept = "application/vnd.github+json" if urllib.parse.urlsplit(url).hostname == "api.github.com" else "application/octet-stream"
    request = urllib.request.Request(url, headers={"User-Agent": "ClipNest-updater", "Accept": accept})
    deadline = time.monotonic() + 180
    chunks, size = [], 0
    with opener.open(request, timeout=20) as response:
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError()
            chunk = response.read(min(256 * 1024, limit + 1 - size))
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
            size += len(chunk)
            if size > limit:
                raise RuntimeError("更新ファイルが制限サイズを超えています。")


def managed_executable(directory: Path | None = None) -> Path | None:
    root = (directory or data_directory()) / "tools"
    try:
        metadata = json.loads((root / "active.json").read_text(encoding="utf-8"))
        version, name = metadata["version"], metadata["asset"]
        if not VERSION.fullmatch(version) or name != asset_name():
            return None
        path = root / f"{version}-{name}"
        if path.is_symlink() or not path.is_file() or not os.access(path, os.X_OK):
            return None
        if hashlib.sha256(path.read_bytes()).hexdigest() != metadata["sha256"]:
            return None
        return path
    except (OSError, ValueError, KeyError, TypeError, RuntimeError):
        return None


class YtDlpUpdater:
    def __init__(self, directory: Path, *, fetch=download, run=subprocess.run):
        self.directory, self.fetch, self.run = directory, fetch, run
        self.lock = threading.Lock()
        self.state = {"state": "idle", "message": "更新は自動実行しません。"}

    def status(self) -> dict:
        with self.lock:
            return dict(self.state)

    def start(self) -> dict:
        with self.lock:
            if self.state["state"] == "running":
                return dict(self.state)
            self.state = {"state": "running", "message": "公式の安定版を取得・検証しています…"}
        threading.Thread(target=self._work, daemon=True).start()
        return self.status()

    def reset(self) -> dict:
        with self.lock:
            if self.state["state"] == "running":
                raise ValueError("更新の完了後に切り替えてください。")
            atomic_json(self.directory / "tools" / "active.json", {})
            self.state = {"state": "done", "message": "管理用更新版の利用を解除しました。アプリを終了して起動し直してください。"}
            return dict(self.state)

    def _work(self) -> None:
        try:
            version = self.install()
            result = {"state": "done", "message": f"yt-dlp {version} を保存しました。アプリを終了して起動し直すと反映されます。"}
        except Exception:
            result = {"state": "error", "message": "更新できませんでした。通信・空き容量・GitHubの取得制限を確認してください。現在の版は変更していません。"}
        with self.lock:
            self.state = result

    def install(self) -> str:
        release = json.loads(self.fetch(RELEASE_API, 2 * 1024 * 1024))
        version = release.get("tag_name", "")
        if not isinstance(version, str) or not VERSION.fullmatch(version) or release.get("prerelease") or release.get("draft"):
            raise ValueError("Invalid release")
        name = asset_name()
        assets = {item["name"] for item in release.get("assets", [])}
        if name not in assets or "SHA2-256SUMS" not in assets:
            raise ValueError("Missing asset")
        base = f"https://github.com/yt-dlp/yt-dlp/releases/download/{version}/"
        checksums = self.fetch(base + "SHA2-256SUMS", 128 * 1024).decode("ascii")
        expected = None
        for line in checksums.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1].lstrip("*") == name and re.fullmatch(r"[a-fA-F0-9]{64}", parts[0]):
                expected = parts[0].lower()
        content = self.fetch(base + name, 128 * 1024 * 1024)
        actual = hashlib.sha256(content).hexdigest()
        if expected is None or actual != expected:
            raise ValueError("Checksum mismatch")
        root = self.directory / "tools"
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(prefix=".yt-dlp-", suffix=".exe" if name.endswith(".exe") else "", dir=root)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
            os.chmod(temporary, 0o700)
            result = self.run([temporary, "--version"], capture_output=True, text=True, timeout=30, check=False,
                              **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
            if result.returncode or result.stdout.strip() != version:
                raise ValueError("Version verification failed")
            destination = root / f"{version}-{name}"
            if destination.exists():
                if destination.is_symlink() or hashlib.sha256(destination.read_bytes()).hexdigest() != actual:
                    raise ValueError("Existing asset differs")
            else:
                os.replace(temporary, destination)
            atomic_json(root / "active.json", {"version": version, "asset": name, "sha256": actual})
        finally:
            Path(temporary).unlink(missing_ok=True)
        return version
