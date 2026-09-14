#!/usr/bin/env python3

"""yt-dlpを使ったYouTube検索とバージョン診断。"""

from __future__ import annotations

import importlib.util
import json
import math
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib import metadata
from typing import Any, Callable
from app_runtime import worker_command, subprocess_options
from ytdlp_update import managed_executable


PYPI_URL = "https://pypi.org/pypi/yt-dlp/json"
VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
CHANNEL_ID_PATTERN = re.compile(r"^UC[A-Za-z0-9_-]{22}$")
LATEST_VERSION_CACHE_SECONDS = 6 * 60 * 60
FAILED_VERSION_CACHE_SECONDS = 5 * 60
MAX_PYPI_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_QUERY_LENGTH = 200
MIN_JS_RUNTIMES_VERSION = (2025, 11, 12)
RUNTIME_MINIMUMS = {
    "deno": (2, 3),
    "node": (22, 0),
}


def python_update_command() -> str:
    """現在このアプリを動かしているPython用の更新コマンド。"""

    if getattr(sys, "frozen", False):
        return "設定 → yt-dlpを更新 を使い、アプリを再起動してください。"
    if os.name == "nt":
        executable = sys.executable.replace('"', '`"')
        return f'& "{executable}" -m pip install -U "yt-dlp[default]"'
    return f'{shlex.quote(sys.executable)} -m pip install -U "yt-dlp[default]"'


@dataclass(frozen=True)
class YtDlpRunner:
    """実際に検索へ使うyt-dlpコマンド。"""

    command: tuple[str, ...]
    source: str
    update_command: str


class SearchError(RuntimeError):
    """UIへ安全に返せる検索エラー。"""

    def __init__(
        self,
        message: str,
        *,
        code: str = "search_failed",
        hint: str | None = None,
        diagnostics: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.hint = hint
        self.diagnostics = diagnostics


def version_key(value: str | None) -> tuple[int, ...] | None:
    """yt-dlpの日付形式バージョンを比較可能なtupleにする。"""

    if not value:
        return None

    numbers = re.findall(r"\d+", value)
    if not numbers:
        return None

    return tuple(int(number) for number in numbers)


def is_newer_version(latest: str | None, current: str | None) -> bool | None:
    """latestがcurrentより新しいか判定する。不明ならNone。"""

    latest_key = version_key(latest)
    current_key = version_key(current)
    if latest_key is None or current_key is None:
        return None

    width = max(len(latest_key), len(current_key))
    return latest_key + (0,) * (width - len(latest_key)) > current_key + (0,) * (
        width - len(current_key)
    )


def runtime_status(name: str) -> dict[str, Any]:
    """JavaScriptランタイムの存在とyt-dlp推奨最低版を確認する。"""

    executable = shutil.which(name)
    if executable is None:
        return {"available": False, "version": None, "supported": False}

    try:
        result = subprocess.run(
            [executable, "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=2,
            check=False,
            **subprocess_options(),
        )
    except (OSError, subprocess.SubprocessError):
        return {"available": True, "version": None, "supported": False}

    output = result.stdout.strip() or result.stderr.strip()
    first_line = output.splitlines()[0] if output else ""
    key = version_key(first_line)
    minimum = RUNTIME_MINIMUMS[name]
    supported = (
        result.returncode == 0
        and key is not None
        and key[: len(minimum)] >= minimum
    )
    version_match = re.search(r"\d+(?:\.\d+)+", first_line)
    return {
        "available": True,
        "version": version_match.group(0) if version_match else None,
        "supported": supported,
    }


def discover_runner() -> YtDlpRunner | None:
    """Pythonパッケージ版を優先し、なければPATH上のCLIを使う。"""

    configured_path = os.environ.get("YTDLP_PATH")
    if configured_path:
        path = os.path.abspath(os.path.expanduser(configured_path))
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return YtDlpRunner(
                command=(path,),
                source="YTDLP_PATHで指定された実行ファイル",
                update_command="yt-dlpの導入方法に合わせて更新してください",
            )

    managed = managed_executable()
    if managed:
        return YtDlpRunner(command=(str(managed),), source="ClipNest管理の更新版", update_command="設定 → yt-dlpを更新")

    if importlib.util.find_spec("yt_dlp") is not None:
        return YtDlpRunner(
            command=tuple(worker_command("yt-dlp")),
            source="アプリ同梱版" if getattr(sys, "frozen", False) else "このアプリのPython環境",
            update_command=python_update_command(),
        )

    executable = shutil.which("yt-dlp")
    if executable is None:
        return None

    if "homebrew" in executable.lower() or executable.startswith("/opt/homebrew/"):
        update_command = "brew upgrade yt-dlp"
        source = "システムPATH（Homebrew）"
    else:
        update_command = "導入元のパッケージ管理ツールでyt-dlpを更新してください"
        source = "システムPATH"

    return YtDlpRunner(
        command=(executable,),
        source=source,
        update_command=update_command,
    )


def _package_version(distribution_name: str) -> str | None:
    try:
        return metadata.version(distribution_name)
    except metadata.PackageNotFoundError:
        return None


def _youtube_url(value: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(value)
    except ValueError:
        return False

    if parsed.scheme not in {"http", "https"}:
        return False

    hostname = (parsed.hostname or "").lower().rstrip(".")
    return (
        hostname == "youtu.be"
        or hostname == "youtube.com"
        or hostname.endswith(".youtube.com")
        or hostname == "youtube-nocookie.com"
        or hostname.endswith(".youtube-nocookie.com")
    )


def _video_id_from_entry(entry: dict[str, Any]) -> str | None:
    candidate = str(entry.get("id") or "")
    if VIDEO_ID_PATTERN.fullmatch(candidate):
        return candidate

    url = str(entry.get("url") or entry.get("webpage_url") or "")
    if VIDEO_ID_PATTERN.fullmatch(url):
        return url

    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return None

    hostname = (parsed.hostname or "").lower()
    if hostname == "youtu.be":
        candidate = parsed.path.strip("/").split("/", 1)[0]
    else:
        candidate = urllib.parse.parse_qs(parsed.query).get("v", [""])[0]

    return candidate if VIDEO_ID_PATTERN.fullmatch(candidate) else None


def _channel_id_from_entry(entry: dict[str, Any]) -> str | None:
    for key in ("channel_id", "uploader_id"):
        candidate = str(entry.get(key) or "")
        if CHANNEL_ID_PATTERN.fullmatch(candidate):
            return candidate
    return None


def _published_timestamp(entry: dict[str, Any]) -> int | None:
    for key in ("timestamp", "release_timestamp"):
        value = entry.get(key)
        try:
            timestamp = int(value)
        except (TypeError, ValueError, OverflowError):
            continue
        if timestamp >= 0:
            return timestamp

    upload_date = str(entry.get("upload_date") or "")
    if re.fullmatch(r"\d{8}", upload_date):
        try:
            return int(datetime.strptime(upload_date, "%Y%m%d").replace(tzinfo=UTC).timestamp())
        except (ValueError, OverflowError):
            pass
    return None


def _normalise_result(
    entry: dict[str, Any],
    *,
    default_channel_id: str | None = None,
    default_channel_title: str | None = None,
) -> dict[str, Any] | None:
    video_id = _video_id_from_entry(entry)
    if video_id is None:
        return None

    duration = entry.get("duration")
    try:
        duration_value = int(float(duration)) if duration is not None else None
    except (TypeError, ValueError, OverflowError):
        duration_value = None

    view_count = entry.get("view_count")
    try:
        view_count_value = int(view_count) if view_count is not None else None
    except (TypeError, ValueError, OverflowError):
        view_count_value = None

    title = str(entry.get("title") or "タイトル不明").strip() or "タイトル不明"
    channel = str(
        entry.get("channel")
        or entry.get("uploader")
        or default_channel_title
        or entry.get("channel_id")
        or "チャンネル不明"
    ).strip()
    channel_id = _channel_id_from_entry(entry) or default_channel_id
    if channel_id and CHANNEL_ID_PATTERN.fullmatch(channel_id) is None:
        channel_id = None

    return {
        "id": video_id,
        "title": title,
        "channel": channel,
        "channelId": channel_id,
        "duration": duration_value,
        "viewCount": view_count_value,
        "isLive": bool(entry.get("is_live")) or entry.get("live_status") == "is_live",
        "isUpcoming": entry.get("live_status") == "is_upcoming",
        "publishedAt": _published_timestamp(entry),
        "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        "url": f"https://www.youtube.com/watch?v={video_id}",
    }


class YtDlpService:
    """検索、ローカル状態確認、PyPI上の最新版確認をまとめる。"""

    def __init__(
        self,
        *,
        runner: YtDlpRunner | None = None,
        auto_discover: bool = True,
        command_runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
        urlopen: Callable[..., Any] = urllib.request.urlopen,
        search_timeout: float = 28.0,
        stream_timeout: float = 60.0,
        version_timeout: float = 3.5,
    ) -> None:
        self.auto_discover = auto_discover
        self.runner = runner if runner is not None else (discover_runner() if auto_discover else None)
        self.command_runner = command_runner
        self.urlopen = urlopen
        self.search_timeout = search_timeout
        self.stream_timeout = stream_timeout
        self.version_timeout = version_timeout
        self._version_lock = threading.Lock()
        self._latest_cache: tuple[float, str | None, bool] | None = None
        self._stream_lock = threading.Lock()
        self._stream_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
        self._stream_resolution_locks: dict[tuple[str, str], threading.Lock] = {}

    def _run(
        self,
        arguments: list[str],
        *,
        timeout: float,
        input_text: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        if self.runner is None:
            raise FileNotFoundError("yt-dlpが見つかりません。")

        return self.command_runner(
            [*self.runner.command, *arguments],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
            input=input_text,
            **subprocess_options(),
        )


    def resolve_audio_stream(self, video_id: str, *, max_age_seconds: float = 600.0, audio_format: str = "m4a") -> dict[str, Any]:
        """YouTube動画の音声ストリームURLと必要なHTTPヘッダーを解決する。

        URLは期限付きなので短時間だけキャッシュする。ブラウザへURL自体は返さず、
        ClipNestのローカルHTTPサーバーがプロキシして同一オリジンで再生する。
        """
        if VIDEO_ID_PATTERN.fullmatch(video_id) is None:
            raise ValueError("動画IDの形式が正しくありません。")
        if audio_format not in {"m4a", "webm"}:
            raise ValueError("音声形式はm4aまたはwebmを指定してください。")
        cache_key = (video_id, audio_format)

        with self._stream_lock:
            now = time.monotonic()
            cached = self._stream_cache.get(cache_key)
            if cached is not None and now - cached[0] < max_age_seconds:
                return dict(cached[1])
            resolution_lock = self._stream_resolution_locks.setdefault(
                cache_key, threading.Lock()
            )

        with resolution_lock:
            with self._stream_lock:
                now = time.monotonic()
                cached = self._stream_cache.get(cache_key)
                if cached is not None and now - cached[0] < max_age_seconds:
                    return dict(cached[1])

            return self._resolve_audio_stream_uncached(video_id, audio_format=audio_format)

    def _resolve_audio_stream_uncached(self, video_id: str, *, audio_format: str = "m4a") -> dict[str, Any]:
        """期限付きURLを実際に解決し、成功した結果だけキャッシュする。"""

        if self.runner is None and self.auto_discover:
            self.runner = discover_runner()
        if self.runner is None:
            hint, diagnostics = self._diagnose_failure("yt-dlp missing")
            raise SearchError(
                "yt-dlpがインストールされていません。",
                code="yt_dlp_unavailable",
                hint=hint,
                diagnostics=diagnostics,
            )

        target = f"https://www.youtube.com/watch?v={video_id}"
        arguments = [
            "--ignore-config",
            "--dump-single-json",
            "--no-playlist",
            "--skip-download",
            "--socket-timeout",
            "20",
            "--retries",
            "2",
            "--extractor-retries",
            "2",
            "--format",
            f"bestaudio[ext={audio_format}][protocol=https]/bestaudio[ext={audio_format}][protocol=http]",
            *self._runtime_arguments(),
            "--batch-file",
            "-",
        ]

        try:
            result = self._run(arguments, timeout=self.stream_timeout, input_text=f"{target}\n")
        except subprocess.TimeoutExpired as exc:
            hint, diagnostics = self._diagnose_failure(str(exc))
            raise SearchError(
                "音声ストリームの準備がタイムアウトしました。",
                code="stream_timeout",
                hint=hint,
                diagnostics=diagnostics,
            ) from exc
        except OSError as exc:
            hint, diagnostics = self._diagnose_failure(str(exc))
            raise SearchError(
                "yt-dlpを実行できませんでした。",
                code="yt_dlp_unavailable",
                hint=hint,
                diagnostics=diagnostics,
            ) from exc

        if result.returncode != 0:
            hint, diagnostics = self._diagnose_failure(result.stderr or result.stdout)
            raise SearchError(
                "音声ストリームを取得できませんでした。",
                code="stream_unavailable",
                hint=hint,
                diagnostics=diagnostics,
            )

        try:
            payload = json.loads(result.stdout)
        except (TypeError, json.JSONDecodeError) as exc:
            raise SearchError(
                "音声ストリーム情報を読み取れませんでした。",
                code="invalid_response",
            ) from exc

        stream_url = str(payload.get("url") or "").strip()
        if not stream_url.startswith(("https://", "http://")):
            raise SearchError(
                "再生可能な音声ストリームが見つかりませんでした。",
                code="stream_unavailable",
            )

        raw_headers = payload.get("http_headers")
        headers = {
            str(key): str(value)
            for key, value in (raw_headers.items() if isinstance(raw_headers, dict) else [])
            if str(key).lower() not in {"host", "content-length", "range"}
        }
        info = {
            "url": stream_url,
            "headers": headers,
            "ext": str(payload.get("ext") or ""),
            "acodec": str(payload.get("acodec") or ""),
            "title": str(payload.get("title") or ""),
            "description": str(payload.get("description") or "")[:30000],
            "chapters": payload.get("chapters") if isinstance(payload.get("chapters"), list) else [],
        }
        with self._stream_lock:
            self._stream_cache[(video_id, audio_format)] = (time.monotonic(), info)
            if len(self._stream_cache) > 64:
                oldest = min(self._stream_cache.items(), key=lambda item: item[1][0])[0]
                self._stream_cache.pop(oldest, None)
                self._stream_resolution_locks.pop(oldest, None)
        return dict(info)

    def video_details(self, video_id: str) -> dict[str, Any]:
        if not VIDEO_ID_PATTERN.fullmatch(video_id):
            raise ValueError("動画IDの形式が正しくありません。")
        info = self.resolve_audio_stream(video_id)
        chapters = []
        for raw in info.get("chapters", [])[:300]:
            if not isinstance(raw, dict):
                continue
            start = raw.get("start_time")
            if isinstance(start, (int, float)) and math.isfinite(start) and 0 <= start <= 604800:
                chapters.append({"start": start, "title": str(raw.get("title") or "チャプター")[:300]})
        return {"videoId": video_id, "description": info.get("description", ""), "chapters": chapters}

    def local_status(self) -> dict[str, Any]:
        """ネットワークへ接続せず、実際に使うyt-dlpの状態を返す。"""

        if self.runner is None and self.auto_discover:
            self.runner = discover_runner()

        runtime_details = {
            "deno": runtime_status("deno"),
            "node": runtime_status("node"),
        }
        runtimes = {
            name: details["supported"]
            for name, details in runtime_details.items()
        }
        base: dict[str, Any] = {
            "available": False,
            "currentVersion": None,
            "source": self.runner.source if self.runner else None,
            "updateCommand": self.runner.update_command if self.runner else None,
            "ejsVersion": (
                _package_version("yt-dlp-ejs")
                if self.runner and self.runner.command[:2] in ((sys.executable, "-m"), (sys.executable, "--worker"))
                else None
            ),
            "runtimes": runtimes,
            "runtimeDetails": runtime_details,
        }

        if self.runner is None:
            base["message"] = "yt-dlpが見つかりません。requirements.txtから導入してください。"
            base["updateCommand"] = python_update_command()
            return base

        try:
            result = self._run(["--version"], timeout=self.version_timeout)
        except (OSError, subprocess.SubprocessError) as exc:
            base["message"] = "yt-dlpを実行できませんでした。設定から依存関係を確認してください。"
            return base

        current_version = result.stdout.strip().splitlines()[0] if result.stdout.strip() else None
        if result.returncode != 0 or current_version is None:
            base["message"] = "yt-dlpのバージョンを取得できませんでした。"
            return base

        base.update(
            {
                "available": True,
                "currentVersion": current_version,
                "message": "yt-dlpを利用できます。",
            }
        )
        return base

    def check_version(self, *, force: bool = False) -> dict[str, Any]:
        """ローカル版とPyPIの最新安定版を比較する。更新は行わない。"""

        status = self.local_status()
        latest_version, checked_latest = self._latest_version(force=force)
        status.update(
            {
                "checkedLatest": checked_latest,
                "latestVersion": latest_version,
                "updateAvailable": (
                    is_newer_version(latest_version, status.get("currentVersion"))
                    if checked_latest
                    else None
                ),
            }
        )

        if not checked_latest:
            status["versionMessage"] = "最新版を確認できませんでした。"
        elif not status["available"]:
            status["versionMessage"] = "yt-dlpをインストールしてください。"
        elif status["updateAvailable"] is True:
            status["versionMessage"] = "新しいyt-dlpを利用できます。"
        elif status["updateAvailable"] is False:
            status["versionMessage"] = "現在版は最新安定版より古くありません。"
        else:
            status["versionMessage"] = "バージョンを比較できませんでした。"

        return status

    def _latest_version(self, *, force: bool = False) -> tuple[str | None, bool]:
        """PyPIの最新安定版だけをキャッシュして返す。"""

        with self._version_lock:
            if not force and self._latest_cache is not None:
                cached_at, cached_version, cached_success = self._latest_cache
                cache_seconds = (
                    LATEST_VERSION_CACHE_SECONDS
                    if cached_success
                    else FAILED_VERSION_CACHE_SECONDS
                )
                if time.monotonic() - cached_at < cache_seconds:
                    return cached_version, cached_success

            try:
                request = urllib.request.Request(
                    PYPI_URL,
                    headers={"User-Agent": "ClipNest/1.0 version-check"},
                )
                with self.urlopen(request, timeout=self.version_timeout) as response:
                    response_body = response.read(MAX_PYPI_RESPONSE_BYTES + 1)
                if len(response_body) > MAX_PYPI_RESPONSE_BYTES:
                    raise ValueError("PyPI response is too large")
                payload = json.loads(response_body.decode("utf-8"))
                latest_version = str(payload["info"]["version"])
            except Exception:
                self._latest_cache = (time.monotonic(), None, False)
                return None, False

            self._latest_cache = (time.monotonic(), latest_version, True)
            return latest_version, True

    def _runtime_arguments(self) -> list[str]:
        deno = runtime_status("deno")
        node = runtime_status("node")
        if deno["supported"]:
            return []
        if node["supported"]:
            current_version = self.local_status().get("currentVersion")
            current_key = version_key(current_version)
            if current_key is not None and current_key >= MIN_JS_RUNTIMES_VERSION:
                return ["--js-runtimes", "node"]
        return []

    def _diagnose_failure(self, error_text: str) -> tuple[str, dict[str, Any]]:
        lowered = error_text.lower()
        diagnostics = self.check_version()
        if any(token in lowered for token in ("failed to resolve", "name resolution", "network")):
            hint = "ネットワーク接続またはDNSを確認してください。"
        elif any(
            token in lowered
            for token in (
                "sign in",
                "not a bot",
                "confirm you’re not a bot",
                "http error 403",
                "http error 429",
                "too many requests",
            )
        ):
            hint = "YouTube側のアクセス確認により検索が制限された可能性があります。"
        elif "javascript runtime" in lowered:
            hint = "対応するJavaScriptランタイム（DenoまたはNode.js）を確認してください。"
        elif any(token in lowered for token in ("timed out", "timeout")):
            hint = "YouTubeへの接続がタイムアウトしました。時間を置いて再試行してください。"
        elif not diagnostics.get("available"):
            hint = "yt-dlpをインストールしてから再試行してください。"
        elif diagnostics.get("updateAvailable") is True:
            hint = "yt-dlpを更新すると復旧する可能性があります。"
        elif diagnostics.get("checkedLatest"):
            hint = "現在版は最新安定版より古くありません。YouTube側の一時的な制限や仕様変更の可能性があります。"
        else:
            hint = "最新版を確認できませんでした。ネットワーク接続を確認してください。"

        return hint, diagnostics

    def _listing_data(
        self,
        target: str,
        *,
        limit: int,
        operation: str,
        default_channel_id: str | None = None,
        default_channel_title: str | None = None,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """安全な固定引数でYouTubeの一覧と公開メタデータを取得する。"""

        if self.runner is None and self.auto_discover:
            self.runner = discover_runner()
        if self.runner is None:
            hint, diagnostics = self._diagnose_failure("yt-dlp missing")
            raise SearchError(
                "yt-dlpがインストールされていません。",
                code="yt_dlp_unavailable",
                hint=hint,
                diagnostics=diagnostics,
            )

        arguments = [
            "--ignore-config",
            "--dump-single-json",
            "--flat-playlist",
            "--playlist-end",
            str(limit + offset),
            *(["--playlist-start", str(offset + 1)] if offset else []),
            "--skip-download",
            "--socket-timeout",
            "12",
            "--retries",
            "1",
            "--extractor-retries",
            "1",
            *self._runtime_arguments(),
            "--batch-file",
            "-",
        ]

        try:
            result = self._run(
                arguments,
                timeout=self.search_timeout,
                input_text=f"{target}\n",
            )
        except subprocess.TimeoutExpired as exc:
            hint, diagnostics = self._diagnose_failure(str(exc))
            raise SearchError(
                f"{operation}がタイムアウトしました。",
                code="search_timeout",
                hint=hint,
                diagnostics=diagnostics,
            ) from exc
        except OSError as exc:
            hint, diagnostics = self._diagnose_failure(str(exc))
            raise SearchError(
                "yt-dlpを実行できませんでした。",
                code="yt_dlp_unavailable",
                hint=hint,
                diagnostics=diagnostics,
            ) from exc

        if result.returncode != 0:
            hint, diagnostics = self._diagnose_failure(result.stderr or result.stdout)
            raise SearchError(
                f"{operation}を実行できませんでした。",
                hint=hint,
                diagnostics=diagnostics,
            )

        try:
            payload = json.loads(result.stdout)
        except (TypeError, json.JSONDecodeError) as exc:
            hint, diagnostics = self._diagnose_failure("invalid yt-dlp json output")
            raise SearchError(
                "yt-dlpの検索結果を読み取れませんでした。",
                code="invalid_response",
                hint=hint,
                diagnostics=diagnostics,
            ) from exc

        if not isinstance(payload, dict):
            hint, diagnostics = self._diagnose_failure("invalid yt-dlp json shape")
            raise SearchError(
                "yt-dlpの検索結果の形式が変わった可能性があります。",
                code="invalid_response",
                hint=hint,
                diagnostics=diagnostics,
            )

        payload_channel_id = _channel_id_from_entry(payload) or default_channel_id
        payload_channel_title = str(
            payload.get("channel")
            or payload.get("uploader")
            or default_channel_title
            or ""
        ).strip() or None
        raw_entries = payload.get("entries")
        entries = raw_entries if isinstance(raw_entries, list) else [payload]
        items = [
            normalised
            for entry in entries
            if isinstance(entry, dict)
            if (
                normalised := _normalise_result(
                    entry,
                    default_channel_id=payload_channel_id,
                    default_channel_title=payload_channel_title,
                )
            )
            is not None
        ]

        if entries and any(isinstance(entry, dict) for entry in entries) and not items:
            hint, diagnostics = self._diagnose_failure("no recognised video entries")
            raise SearchError(
                "検索結果の形式を認識できませんでした。",
                code="invalid_response",
                hint=hint,
                diagnostics=diagnostics,
            )
        return items[:limit], payload

    def _listing(
        self,
        target: str,
        *,
        limit: int,
        operation: str,
        default_channel_id: str | None = None,
        default_channel_title: str | None = None,
    ) -> list[dict[str, Any]]:
        items, _payload = self._listing_data(
            target,
            limit=limit,
            operation=operation,
            default_channel_id=default_channel_id,
            default_channel_title=default_channel_title,
        )
        return items

    def search(self, query: str, *, limit: int = 36) -> dict[str, Any]:
        """キーワードまたはYouTube URLを検索し、表示用項目だけ返す。"""

        query = " ".join(query.split())
        if not query:
            raise ValueError("検索キーワードを入力してください。")
        if len(query) > MAX_QUERY_LENGTH:
            raise ValueError(f"検索キーワードは{MAX_QUERY_LENGTH}文字以内で入力してください。")
        if limit < 1 or limit > 60:
            raise ValueError("検索件数は1〜60件で指定してください。")

        parsed = urllib.parse.urlparse(query)
        if parsed.scheme in {"http", "https"}:
            if not _youtube_url(query):
                raise ValueError("YouTubeのURL、または検索キーワードを入力してください。")
            target = query
        else:
            target = f"ytsearch{limit}:{query}"

        items = self._listing(target, limit=limit, operation="YouTube検索")
        # Keep YouTube's relevance order, but don't show duplicate entries.
        items = list({item["id"]: item for item in items}.values())

        return {
            "query": query,
            "count": len(items),
            "items": items,
        }

    def channel_videos(self, channel_id: str, *, limit: int = 8, offset: int = 0) -> dict[str, Any]:
        """公開チャンネルの動画一覧を取得する。ログイン情報は使用しない。"""

        if CHANNEL_ID_PATTERN.fullmatch(channel_id) is None:
            raise ValueError("チャンネルIDの形式が正しくありません。")
        if limit < 1 or limit > 24:
            raise ValueError("取得件数は1〜24件で指定してください。")
        if not isinstance(offset, int) or offset < 0 or offset > 480:
            raise ValueError("取得位置は0〜480件で指定してください。")

        target = f"https://www.youtube.com/channel/{channel_id}/videos"
        items, metadata = self._listing_data(
            target,
            limit=limit,
            operation="登録チャンネルの更新",
            default_channel_id=channel_id,
            offset=offset,
        )
        channel_title = str(
            metadata.get("channel")
            or metadata.get("uploader")
            or ""
        ).strip() or next(
            (
                str(item.get("channel"))
                for item in items
                if item.get("channel") and item.get("channel") != "チャンネル不明"
            ),
            "チャンネル不明",
        )

        description = str(metadata.get("description") or "").strip()[:5000]
        raw_followers = metadata.get("channel_follower_count")
        try:
            subscriber_count = int(raw_followers) if raw_followers is not None else None
        except (TypeError, ValueError, OverflowError):
            subscriber_count = None
        if subscriber_count is not None and subscriber_count < 0:
            subscriber_count = None

        avatar = None
        thumbnails = metadata.get("thumbnails")
        if isinstance(thumbnails, list):
            safe_thumbnails = []
            for thumbnail in thumbnails:
                if not isinstance(thumbnail, dict):
                    continue
                url = str(thumbnail.get("url") or "").strip()
                try:
                    parsed = urllib.parse.urlparse(url)
                except ValueError:
                    continue
                if parsed.scheme != "https" or parsed.hostname not in {
                    "yt3.googleusercontent.com",
                    "yt3.ggpht.com",
                }:
                    continue
                width = thumbnail.get("width")
                try:
                    sort_width = int(width)
                except (TypeError, ValueError, OverflowError):
                    sort_width = 0
                safe_thumbnails.append((sort_width, url))
            if safe_thumbnails:
                avatar = max(safe_thumbnails)[1]

        raw_handle = str(metadata.get("uploader_id") or "").strip()
        handle = raw_handle[:100] if raw_handle.startswith("@") else None
        return {
            "channelId": channel_id,
            "channel": channel_title,
            "description": description or None,
            "subscriberCount": subscriber_count,
            "avatar": avatar,
            "handle": handle,
            "url": f"https://www.youtube.com/channel/{channel_id}",
            "count": len(items),
            "items": items,
        }
