#!/usr/bin/env python3

"""ClipNestローカルWebアプリのHTTPサーバー。"""

from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import os
import re
import threading
import uuid
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit
import urllib.error
import urllib.request

from library_service import LibraryService, UnknownLibraryItemError
from youtube_service import SearchError, YtDlpService
from compatible_audio import CompatibleAudio
from dubbing_service import DubbingService
from transcription_service import TranscriptionService
from rvc_service import RVCService, MAX_INDEX_BYTES, MAX_MODEL_BYTES
from related_service import RelatedService
from app_runtime import Settings, StartupError, configure_logging, data_directory, dependency_report, prepare_environment, setup_user_data
from ytdlp_update import YtDlpUpdater
from version import APP_VERSION


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DEFAULT_DATABASE_PATH = data_directory() / "clipnest.sqlite3"
STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/styles.css": "styles.css",
    "/app-layout.css": "app-layout.css",
    "/favicon.svg": "favicon.svg",
}
MODULES_DIR = STATIC_DIR / "modules"
CORE_DIR = STATIC_DIR / "core"
MAX_REQUEST_BYTES = 4 * 1024
MAX_CONNECTIONS = 16
MAX_CONCURRENT_MEDIA_STREAMS = 4
MAX_CONCURRENT_SEARCHES = 2
MAX_REFRESH_CHANNELS = 4
VIDEOS_PER_CHANNEL_REFRESH = 8
REQUEST_BODY_TIMEOUT_SECONDS = 5.0
MEDIA_UPSTREAM_TIMEOUT_SECONDS = 45.0
MEDIA_CHUNK_BYTES = 64 * 1024
MEDIA_UPSTREAM_RANGE_BYTES = 4 * 1024 * 1024
MEDIA_CLIENT_TIMEOUT_SECONDS = 30.0
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
PORT_IN_USE_ERRNOS = {48, 98, 10048}


def open_ended_range_start(value: str | None) -> int | None:
    """`bytes=<開始>-` の開始位置だけを安全に取り出す。"""
    if not value:
        return None
    unit, separator, range_spec = value.strip().partition("=")
    if separator != "=" or unit.lower() != "bytes" or not range_spec.endswith("-"):
        return None
    start_text = range_spec[:-1]
    if not start_text.isdigit():
        return None
    return int(start_text)


def parse_content_range(value: str | None) -> tuple[int, int, int] | None:
    """`bytes <開始>-<終了>/<全体>` を数値へ変換する。"""
    if not value:
        return None
    unit, separator, range_and_total = value.strip().partition(" ")
    if separator != " " or unit.lower() != "bytes":
        return None
    positions, slash, total_text = range_and_total.partition("/")
    start_text, dash, end_text = positions.partition("-")
    if slash != "/" or dash != "-":
        return None
    if not all(part.isdigit() for part in (start_text, end_text, total_text)):
        return None
    start, end, total = int(start_text), int(end_text), int(total_text)
    if start < 0 or end < start or total <= end:
        return None
    return start, end, total


class LimitedThreadingHTTPServer(ThreadingHTTPServer):
    """ローカル接続が無制限にスレッドを生成しないHTTPサーバー。"""

    daemon_threads = True
    request_queue_size = MAX_CONNECTIONS

    def __init__(self, *args: Any, max_connections: int = MAX_CONNECTIONS, **kwargs: Any) -> None:
        self._connection_slots = threading.BoundedSemaphore(max_connections)
        super().__init__(*args, **kwargs)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._connection_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._connection_slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._connection_slots.release()

    def handle_error(self, request: Any, client_address: Any) -> None:
        logging.getLogger("clipnest").error("request_failed")


def create_handler(
    service: YtDlpService,
    static_dir: Path = STATIC_DIR,
    library: LibraryService | None = None,
    *,
    media_urlopen: Callable[..., Any] = urllib.request.urlopen,
    max_concurrent_media_streams: int = MAX_CONCURRENT_MEDIA_STREAMS,
    settings: Settings | None = None,
    allow_shutdown: bool = False,
) -> type[BaseHTTPRequestHandler]:
    """依存を注入したリクエストハンドラーを作る。"""

    if library is None:
        library = LibraryService(DEFAULT_DATABASE_PATH)
    settings = settings or Settings(library.database_path.parent)
    updater = YtDlpUpdater(settings.directory)
    search_slots = threading.BoundedSemaphore(MAX_CONCURRENT_SEARCHES)
    media_slots = threading.BoundedSemaphore(max_concurrent_media_streams)
    compatible_audio = CompatibleAudio()
    compatible_slots = threading.BoundedSemaphore(2)
    dubbing = DubbingService(service, settings)
    dubbing_slots = threading.BoundedSemaphore(2)
    transcription = TranscriptionService(APP_DIR, settings)
    rvc = RVCService(settings.directory, APP_DIR)
    related = RelatedService()
    related_slots = threading.BoundedSemaphore(2)

    class ClipNestHandler(BaseHTTPRequestHandler):
        server_version = "ClipNest"

        def version_string(self) -> str:
            return "ClipNest"

        def _security_headers(self) -> dict[str, str]:
            return {
                "Content-Security-Policy": (
                    "default-src 'self'; "
                    "img-src 'self' https://i.ytimg.com https://yt3.googleusercontent.com "
                    "https://yt3.ggpht.com data:; "
                    "frame-src https://www.youtube-nocookie.com; media-src 'self' blob:; "
                    "script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; "
                    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
                ),
                "Referrer-Policy": "strict-origin-when-cross-origin",
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY",
                "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
            }

        def _send_bytes(
            self,
            body: bytes,
            *,
            status: HTTPStatus = HTTPStatus.OK,
            content_type: str = "application/octet-stream",
            cache_control: str = "no-store",
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache_control)
            for name, value in self._security_headers().items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def _send_json(
            self,
            payload: dict[str, Any],
            *,
            status: HTTPStatus = HTTPStatus.OK,
        ) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._send_bytes(
                body,
                status=status,
                content_type="application/json; charset=utf-8",
            )

        def _send_error_json(
            self,
            status: HTTPStatus,
            code: str,
            message: str,
            *,
            request_id: str | None = None,
            hint: str | None = None,
            diagnostics: dict[str, Any] | None = None,
        ) -> None:
            error: dict[str, Any] = {
                "code": code,
                "message": message,
            }
            # Only application-defined codes, never exception text or user inputs.
            safe_code = code if re.fullmatch(r"[a-z_]{1,64}", code) else "request_error"
            logging.getLogger("clipnest").warning("api_error code=%s status=%s", safe_code, int(status))
            if request_id:
                error["requestId"] = request_id
            if hint:
                error["hint"] = hint
            if diagnostics:
                error["diagnostics"] = diagnostics
            self._send_json({"error": error}, status=status)

        def _api_request_allowed(self) -> bool:
            """DNS rebindingとブラウザからのcross-site要求を拒否する。"""

            host_header = self.headers.get("Host", "")
            try:
                host = urlsplit(f"//{host_header}")
                host_port = host.port
            except ValueError:
                return False

            expected_port = self.server.server_address[1]
            if host.hostname not in LOOPBACK_HOSTS:
                return False
            if host_port != expected_port:
                return False

            fetch_site = self.headers.get("Sec-Fetch-Site")
            if fetch_site and fetch_site not in {"same-origin", "none"}:
                return False

            origin_header = self.headers.get("Origin")
            if origin_header:
                if origin_header == "null":
                    return False
                try:
                    origin = urlsplit(origin_header)
                    origin_port = origin.port or (80 if origin.scheme == "http" else 443)
                except ValueError:
                    return False
                if (
                    origin.scheme != "http"
                    or origin.hostname not in LOOPBACK_HOSTS
                    or origin_port != expected_port
                ):
                    return False

            return True

        def _guard_api_request(self) -> bool:
            if self._api_request_allowed():
                return True
            self._send_error_json(
                HTTPStatus.FORBIDDEN,
                "forbidden_request",
                "このAPIは同じローカルアプリからのみ利用できます。",
            )
            return False

        def _read_json_body(self) -> dict[str, Any] | None:
            if self.headers.get_content_type() != "application/json":
                self._send_error_json(
                    HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                    "invalid_content_type",
                    "Content-Typeにはapplication/jsonを指定してください。",
                )
                return None

            content_length_header = self.headers.get("Content-Length")
            try:
                content_length = int(content_length_header or "0")
            except ValueError:
                content_length = 0

            if content_length < 1 or content_length > MAX_REQUEST_BYTES:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST,
                    "invalid_request",
                    "リクエストのサイズが正しくありません。",
                )
                return None

            previous_timeout = self.connection.gettimeout()
            try:
                self.connection.settimeout(REQUEST_BODY_TIMEOUT_SECONDS)
                raw_body = self.rfile.read(content_length)
            except OSError:
                self._send_error_json(
                    HTTPStatus.REQUEST_TIMEOUT,
                    "request_timeout",
                    "リクエストの受信がタイムアウトしました。",
                )
                return None
            finally:
                try:
                    self.connection.settimeout(previous_timeout)
                except OSError:
                    pass

            try:
                payload = json.loads(raw_body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST,
                    "invalid_request",
                    "リクエストを読み取れませんでした。",
                )
                return None

            if not isinstance(payload, dict):
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST,
                    "invalid_request",
                    "JSONオブジェクトを送信してください。",
                )
                return None
            return payload

        def _serve_static(self, route: str) -> None:
            filename = STATIC_FILES.get(route)
            path: Path | None = static_dir / filename if filename else None

            if route.startswith("/modules/") or route.startswith("/core/"):
                relative = route.lstrip("/")
                candidate = (static_dir / relative).resolve()
                static_root = static_dir.resolve()
                try:
                    candidate.relative_to(static_root)
                except ValueError:
                    candidate = None
                if candidate is not None and candidate.suffix == ".js":
                    path = candidate

            if path is None or not path.is_file():
                self._send_error_json(
                    HTTPStatus.NOT_FOUND,
                    "not_found",
                    "ページが見つかりません。",
                )
                return

            try:
                body = path.read_bytes()
            except OSError:
                self._send_error_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "static_file_error",
                    "画面ファイルを読み込めませんでした。",
                )
                return

            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type in {
                "application/javascript",
                "text/javascript",
                "image/svg+xml",
            }:
                content_type = f"{content_type}; charset=utf-8"

            self._send_bytes(
                body,
                content_type=content_type,
                cache_control="no-cache",
            )

        def _compatible_audio(self, video_id: str, *, head_only: bool) -> None:
            if not compatible_slots.acquire(blocking=False):
                self._send_error_json(HTTPStatus.SERVICE_UNAVAILABLE, "media_busy", "互換音声を準備中です。少し待って再試行してください。")
                return
            started = False
            try:
                # Fixed local origin, never use the request's Host header as a fetch target.
                url = f"http://127.0.0.1:{self.server.server_port}/api/media/{video_id}?format=m4a"
                with compatible_audio.open(video_id, url) as (stream, size):
                    start, end = 0, size - 1
                    raw_range = self.headers.get("Range")
                    if raw_range:
                        match = re.fullmatch(r"bytes=(\d*)-(\d*)", raw_range)
                        if not match or not any(match.groups()):
                            self._send_error_json(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "invalid_range", "単一のバイト範囲を指定してください。")
                            return
                        first, last = match.groups()
                        if first:
                            start = int(first)
                            end = min(int(last), end) if last else end
                        else:
                            start = max(0, size - int(last))
                        if start > end or start >= size:
                            self.send_response(416)
                            self.send_header("Content-Range", f"bytes */{size}")
                            self.send_header("Content-Length", "0")
                            self.end_headers()
                            return
                    self.send_response(206 if raw_range else 200)
                    self.send_header("Content-Type", "audio/mp4")
                    self.send_header("Content-Length", str(end - start + 1))
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Cache-Control", "no-store")
                    if raw_range:
                        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                    for name, value in self._security_headers().items():
                        self.send_header(name, value)
                    self.end_headers()
                    started = True
                    if not head_only:
                        self.connection.settimeout(MEDIA_CLIENT_TIMEOUT_SECONDS)
                        stream.seek(start)
                        remaining = end - start + 1
                        while remaining:
                            chunk = stream.read(min(64 * 1024, remaining))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            remaining -= len(chunk)
            except Exception as exc:
                if not started:
                    message = str(exc) if isinstance(exc, (ValueError, RuntimeError)) else "互換音声の準備に失敗しました。ffmpegと通信状態を確認してください。"
                    self._send_error_json(HTTPStatus.SERVICE_UNAVAILABLE, "compatible_audio_failed", message)
            finally:
                compatible_slots.release()

        def _proxy_audio(
            self,
            video_id: str,
            *,
            head_only: bool = False,
            force_refresh: bool = False,
        ) -> None:
            """yt-dlpで解決した音声をlocalhost経由でRange対応プロキシする。"""
            if parse_qs(urlsplit(self.path).query).get("format") == ["m4a-safe"]:
                self._compatible_audio(video_id, head_only=head_only)
                return
            if not media_slots.acquire(blocking=False):
                self._send_error_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    "media_busy",
                    "ほかの音声接続を終了しています。少し待って再読み込みしてください。",
                    hint="長時間動画のタブを複数開いている場合は、不要なプレーヤーを閉じてください。",
                )
                return
            try:
                self._proxy_audio_unlocked(
                    video_id,
                    head_only=head_only,
                    force_refresh=force_refresh,
                )
            finally:
                media_slots.release()

        def _proxy_audio_unlocked(
            self,
            video_id: str,
            *,
            head_only: bool = False,
            force_refresh: bool = False,
        ) -> None:
            audio_format = parse_qs(
                urlsplit(self.path).query, keep_blank_values=True
            ).get("format", ["m4a"])[0]
            try:
                stream = service.resolve_audio_stream(
                    video_id,
                    max_age_seconds=0 if force_refresh else 600,
                    audio_format=audio_format,
                )
            except ValueError as exc:
                self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid_video", str(exc))
                return
            except SearchError as exc:
                status = (
                    HTTPStatus.GATEWAY_TIMEOUT
                    if exc.code in {"stream_timeout", "search_timeout"}
                    else HTTPStatus.SERVICE_UNAVAILABLE
                )
                self._send_error_json(
                    status,
                    exc.code,
                    str(exc),
                    hint=exc.hint,
                    diagnostics=exc.diagnostics,
                )
                return

            headers = dict(stream.get("headers") or {})
            range_header = self.headers.get("Range")
            if range_header:
                headers["Range"] = range_header
            windowed_start = (
                open_ended_range_start(range_header)
                if range_header
                else 0
            )
            requested_end = None
            if range_header and windowed_start is None:
                unit, _, spec = range_header.partition("=")
                first, _, last = spec.partition("-")
                if (
                    unit.lower() == "bytes"
                    and first.isascii() and first.isdigit()
                    and last.isascii() and last.isdigit()
                    and int(last) >= int(first)
                ):
                    windowed_start, requested_end = int(first), int(last)
            if windowed_start is not None:
                first_end = windowed_start + MEDIA_UPSTREAM_RANGE_BYTES - 1
                if requested_end is not None:
                    first_end = min(first_end, requested_end)
                headers["Range"] = (
                    f"bytes={windowed_start}-"
                    f"{first_end}"
                )
            upstream_range_header = headers.get("Range")
            headers.setdefault("Accept-Encoding", "identity")

            request = urllib.request.Request(
                str(stream["url"]),
                headers=headers,
                method="GET",
            )
            try:
                upstream = media_urlopen(
                    request, timeout=MEDIA_UPSTREAM_TIMEOUT_SECONDS
                )
            except urllib.error.HTTPError as exc:
                if exc.code in {401, 403, 410}:
                    try:
                        stream = service.resolve_audio_stream(
                            video_id, max_age_seconds=0, audio_format=audio_format
                        )
                        headers = dict(stream.get("headers") or {})
                        if upstream_range_header:
                            headers["Range"] = upstream_range_header
                        headers.setdefault("Accept-Encoding", "identity")
                        request = urllib.request.Request(
                            str(stream["url"]), headers=headers, method="GET"
                        )
                        upstream = media_urlopen(
                            request, timeout=MEDIA_UPSTREAM_TIMEOUT_SECONDS
                        )
                    except Exception:
                        self._send_error_json(
                            HTTPStatus.BAD_GATEWAY,
                            "media_proxy_error",
                            "音声データを取得できませんでした。",
                        )
                        return
                else:
                    self._send_error_json(
                        HTTPStatus.BAD_GATEWAY,
                        "media_proxy_error",
                        "音声データを取得できませんでした。",
                    )
                    return
            except (TimeoutError, OSError):
                self._send_error_json(
                    HTTPStatus.BAD_GATEWAY,
                    "media_proxy_error",
                    "音声配信先へ接続できませんでした。",
                )
                return

            try:
                upstream_status = getattr(upstream, "status", 200)
                upstream_range = parse_content_range(
                    upstream.headers.get("Content-Range")
                )
                windowed_range = (
                    upstream_range
                    if windowed_start is not None
                    and upstream_range is not None
                    and upstream_range[0] == windowed_start
                    else None
                )
                status = (
                    HTTPStatus.PARTIAL_CONTENT
                    if range_header and upstream_status == 206
                    else HTTPStatus.OK
                )
                self.send_response(status)
                content_type = upstream.headers.get("Content-Type") or (
                    "audio/webm" if audio_format == "webm" else "audio/mp4"
                )
                self.send_header("Content-Type", content_type)
                if windowed_range is not None:
                    start, _first_end, total = windowed_range
                    response_end = min(requested_end, total - 1) if requested_end is not None else total - 1
                    self.send_header("Content-Length", str(response_end - start + 1))
                    if range_header:
                        self.send_header(
                            "Content-Range",
                            f"bytes {start}-{response_end}/{total}",
                        )
                else:
                    for name in ("Content-Length", "Content-Range"):
                        value = upstream.headers.get(name)
                        if value:
                            self.send_header(name, value)
                if not upstream.headers.get("Accept-Ranges"):
                    self.send_header("Accept-Ranges", "bytes")
                else:
                    self.send_header("Accept-Ranges", upstream.headers["Accept-Ranges"])
                self.send_header("Cache-Control", "no-store")
                for name, value in self._security_headers().items():
                    self.send_header(name, value)
                self.end_headers()

                if head_only:
                    return
                self.connection.settimeout(MEDIA_CLIENT_TIMEOUT_SECONDS)
                next_start = windowed_range[1] + 1 if windowed_range else None
                total_size = response_end + 1 if windowed_range else None
                while True:
                    read_chunk = getattr(upstream, "read1", upstream.read)
                    while True:
                        chunk = read_chunk(MEDIA_CHUNK_BYTES)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                    if (
                        next_start is None
                        or total_size is None
                        or next_start >= total_size
                    ):
                        break
                    upstream.close()
                    next_end = min(
                        next_start + MEDIA_UPSTREAM_RANGE_BYTES - 1,
                        total_size - 1,
                    )
                    next_headers = dict(headers)
                    next_headers["Range"] = f"bytes={next_start}-{next_end}"
                    next_request = urllib.request.Request(
                        str(stream["url"]),
                        headers=next_headers,
                        method="GET",
                    )
                    upstream = media_urlopen(
                        next_request,
                        timeout=MEDIA_UPSTREAM_TIMEOUT_SECONDS,
                    )
                    next_range = parse_content_range(
                        upstream.headers.get("Content-Range")
                    )
                    if (
                        next_range is None
                        or next_range[0] != next_start
                        or next_range[1] > next_end
                        or next_range[2] != windowed_range[2]
                    ):
                        self.log_error("unexpected media range: %s", video_id)
                        break
                    next_start = next_range[1] + 1
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (TimeoutError, OSError):
                self.log_error("media stream interrupted: %s", video_id)
            finally:
                upstream.close()

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            try:
                self._get()
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error", "処理を完了できませんでした。設定の診断情報を確認し、再試行してください。")

        def _get(self) -> None:
            route = urlsplit(self.path).path
            if route.startswith("/api/") and not self._guard_api_request():
                return

            if route == "/api/settings":
                self._send_json({"settings": settings.scoped("app"), "dataDirectory": str(settings.directory), "canQuit": allow_shutdown})
                return
            if route == "/api/dubbing/settings":
                self._send_json({"settings": settings.scoped("dubbing")})
                return
            if route in {'/api/rvc/status', '/api/rvc/job', '/api/rvc/audio'}:
                try:
                    params = parse_qs(urlsplit(self.path).query)
                    job_id = params.get('jobId', [''])[0]
                    if route.endswith('/audio'):
                        self._send_bytes(rvc.audio(job_id, params.get('stem', [''])[0]), content_type='audio/wav')
                    else:
                        self._send_json(rvc.status() if route.endswith('/status') else rvc.get(job_id))
                except ValueError as exc:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, 'invalid_rvc', str(exc))
                return
            if route == "/api/diagnostics":
                self._send_json(dependency_report(settings, service))
                return
            if route == "/api/ytdlp/update":
                self._send_json(updater.status())
                return

            if route in {"/api/video/details", "/api/channel/videos"}:
                if not search_slots.acquire(blocking=False):
                    self._send_error_json(HTTPStatus.TOO_MANY_REQUESTS, "busy", "取得処理中です。しばらく待って再試行してください。")
                    return
                try:
                    params = parse_qs(urlsplit(self.path).query)
                    if route.endswith("details"):
                        response = service.video_details(params.get("videoId", [""])[0])
                    else:
                        channel_id = params.get("channelId", [""])[0]
                        offset = int(params.get("offset", ["0"])[0])
                        response = service.channel_videos(channel_id, limit=24, offset=offset)
                        library.record_channel_videos(channel_id, response.get("channel", ""), response.get("items", []))
                        response["nextOffset"] = offset + 24
                        response["hasMore"] = len(response.get("items", [])) == 24 and offset < 480
                    self._send_json(response)
                except ValueError as exc:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid_request", str(exc))
                except SearchError as exc:
                    self._send_error_json(HTTPStatus.SERVICE_UNAVAILABLE, exc.code, str(exc), hint=exc.hint)
                except Exception:
                    self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "details_error", "公開情報を取得できませんでした。")
                finally:
                    search_slots.release()
                return

            if route in {'/api/dubbing/asr-status', '/api/dubbing/transcription'}:
                try:
                    params = parse_qs(urlsplit(self.path).query)
                    self._send_json(transcription.status() if route.endswith('asr-status') else transcription.get(params.get('jobId', [''])[0]))
                except ValueError as exc:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, 'invalid_transcription', str(exc))
                return

            if route in {"/api/dubbing/voices", "/api/dubbing/subtitles"}:
                if not dubbing_slots.acquire(blocking=False):
                    self._send_error_json(HTTPStatus.TOO_MANY_REQUESTS, "dubbing_busy", "吹替処理中です。しばらく待って再試行してください。")
                    return
                try:
                    params = parse_qs(urlsplit(self.path).query)
                    result = dubbing.voices() if route.endswith('/voices') else dubbing.subtitles(params.get('videoId', [''])[0], params.get('language', ['ja'])[0])
                    self._send_json(result)
                except ValueError as exc:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid_dubbing", str(exc))
                except RuntimeError as exc:
                    self._send_error_json(HTTPStatus.SERVICE_UNAVAILABLE, "dubbing_unavailable", str(exc))
                except Exception:
                    self._send_error_json(HTTPStatus.SERVICE_UNAVAILABLE, "dubbing_unavailable", "字幕・話者の取得に失敗しました。エンジンとyt-dlpの状態を確認してください。")
                finally:
                    dubbing_slots.release()
                return

            if route.startswith("/api/media/"):
                parsed = urlsplit(self.path)
                video_id = route.removeprefix("/api/media/")
                force_refresh = parse_qs(
                    parsed.query, keep_blank_values=True
                ).get("fresh", ["0"])[0] == "1"
                self._proxy_audio(video_id, force_refresh=force_refresh)
                return

            if route == "/api/suggestions":
                parsed = urlsplit(self.path)
                parameters = parse_qs(parsed.query, keep_blank_values=True)
                query = parameters.get("q", [""])[0]
                raw_limit = parameters.get("limit", ["8"])[0]

                try:
                    limit = int(raw_limit)
                except (TypeError, ValueError, OverflowError):
                    limit = 8

                try:
                    items = library.search_suggestions(query, limit=limit)
                except Exception:
                    self.log_error("suggestion read failed")
                    self._send_error_json(
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                        "suggestion_error",
                        "検索候補を読み込めませんでした。",
                    )
                    return

                self._send_json({"query": query, "items": items, "count": len(items)})
                return

            if route == "/api/next":
                if not related_slots.acquire(blocking=False):
                    self._send_error_json(HTTPStatus.TOO_MANY_REQUESTS, "related_busy", "関連候補を取得中です。少し待って再試行してください。")
                    return
                parsed = urlsplit(self.path)
                video_id = parse_qs(parsed.query, keep_blank_values=True).get(
                    "videoId", [""]
                )[0]
                try:
                    library.next_candidates(video_id)  # Validate the seed before a remote request.
                    preferences = library.recommendation_preferences()
                    fresh = parse_qs(parsed.query).get('fresh', [''])[0] == '1'
                    items = related.fetch(video_id, region=preferences["region"], language=preferences["language"], limit=12, fresh=fresh)
                    library.record_related_candidates(video_id, items)
                    response = library.next_payload(video_id, limit=12)
                except ValueError as exc:
                    self._send_error_json(
                        HTTPStatus.BAD_REQUEST,
                        "invalid_video",
                        str(exc),
                    )
                    return
                except UnknownLibraryItemError as exc:
                    self._send_error_json(
                        HTTPStatus.NOT_FOUND,
                        "unknown_video",
                        str(exc),
                    )
                    return
                except RuntimeError as exc:
                    self._send_error_json(HTTPStatus.SERVICE_UNAVAILABLE, "related_unavailable", str(exc))
                    return
                except Exception:
                    self.log_error("next candidates read failed")
                    self._send_error_json(
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                        "library_error",
                        "次の候補を読み込めませんでした。",
                    )
                    return
                finally:
                    related_slots.release()
                self._send_json(response)
                return

            if route == "/api/channel":
                parsed = urlsplit(self.path)
                channel_id = parse_qs(parsed.query, keep_blank_values=True).get(
                    "channelId", [""]
                )[0]
                try:
                    response = library.channel_payload(channel_id, limit=24)
                except ValueError as exc:
                    self._send_error_json(
                        HTTPStatus.BAD_REQUEST,
                        "invalid_channel",
                        str(exc),
                    )
                    return
                except UnknownLibraryItemError as exc:
                    self._send_error_json(
                        HTTPStatus.NOT_FOUND,
                        "unknown_channel",
                        str(exc),
                    )
                    return
                except Exception:
                    self.log_error("channel read failed")
                    self._send_error_json(
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                        "library_error",
                        "チャンネル情報を読み込めませんでした。",
                    )
                    return

                if not search_slots.acquire(blocking=False):
                    response["warning"] = "保存済みのチャンネル情報を表示しています。"
                    self._send_json(response)
                    return
                try:
                    remote = service.channel_videos(channel_id, limit=18)
                    channel_title = (
                        remote.get("channel")
                        if remote.get("channel") != "チャンネル不明"
                        else response["channel"]
                    )
                    library.record_channel_videos(
                        channel_id,
                        channel_title,
                        remote.get("items", []),
                    )
                    response = library.channel_payload(channel_id, limit=24)
                    for field in (
                        "description",
                        "subscriberCount",
                        "avatar",
                        "handle",
                        "url",
                    ):
                        if remote.get(field) is not None:
                            response[field] = remote[field]
                except SearchError as exc:
                    response["warning"] = (
                        f"最新の概要を取得できませんでした。{exc.hint or ''}"
                    ).strip()
                except Exception:
                    self.log_error("channel refresh failed: %s", channel_id)
                    response["warning"] = "保存済みのチャンネル情報を表示しています。"
                finally:
                    search_slots.release()

                self._send_json(response)
                return

            if route == "/api/modules":
                try:
                    modules_dir = static_dir / "modules"
                    items = []
                    if modules_dir.is_dir():
                        for path in sorted(modules_dir.glob("*.js")):
                            if path.name.startswith("_"):
                                continue
                            items.append({
                                "file": path.name,
                                "url": f"/modules/{path.name}",
                            })
                except OSError:
                    self._send_error_json(
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                        "module_scan_error",
                        "モジュール一覧を読み込めませんでした。",
                    )
                    return
                self._send_json({"items": items, "count": len(items)})
                return

            if route == "/api/status":
                try:
                    status = service.local_status()
                except Exception:
                    self._send_error_json(
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                        "status_error",
                        "yt-dlpの状態を確認できませんでした。",
                    )
                    return
                self._send_json({"appVersion": APP_VERSION, "ytDlp": status})
                return

            library_getters = {
                "/api/home": library.home_payload,
                "/api/history": library.history_payload,
                "/api/subscriptions": library.subscriptions_payload,
            }
            if route in library_getters:
                try:
                    if route == "/api/home":
                        raw_offset = parse_qs(urlsplit(self.path).query).get("offset", ["0"])[0]
                        if not raw_offset.isascii() or not raw_offset.isdigit() or len(raw_offset) > 4 or int(raw_offset) > 1200:
                            self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid_offset", "候補の読み込み位置が不正です。")
                            return
                        response = library.home_payload(offset=int(raw_offset))
                    else:
                        response = library_getters[route]()
                except Exception:
                    self.log_error("library read failed: %s", route)
                    self._send_error_json(
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                        "library_error",
                        "端末内ライブラリを読み込めませんでした。",
                    )
                    return
                self._send_json(response)
                return

            if route == "/api/version":
                self._send_error_json(
                    HTTPStatus.METHOD_NOT_ALLOWED,
                    "method_not_allowed",
                    "最新版の確認にはPOSTを使用してください。",
                )
                return

            if route.startswith("/api/"):
                self._send_error_json(
                    HTTPStatus.NOT_FOUND,
                    "not_found",
                    "APIが見つかりません。",
                )
                return

            self._serve_static(route)

        def do_HEAD(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            route = urlsplit(self.path).path
            if route.startswith("/api/media/"):
                if not self._guard_api_request():
                    return
                parsed = urlsplit(self.path)
                video_id = route.removeprefix("/api/media/")
                force_refresh = parse_qs(
                    parsed.query, keep_blank_values=True
                ).get("fresh", ["0"])[0] == "1"
                self._proxy_audio(
                    video_id,
                    head_only=True,
                    force_refresh=force_refresh,
                )
                return
            self.send_response(HTTPStatus.NOT_FOUND)
            self.end_headers()

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            try:
                self._post()
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error", "変更を完了できませんでした。設定の診断情報を確認し、再試行してください。")

        def _post(self) -> None:
            route = urlsplit(self.path).path
            allowed_routes = {
                "/api/settings",
                "/api/dubbing/settings",
                "/api/ytdlp/update",
                "/api/ytdlp/reset",
                "/api/quit",
                "/api/search",
                "/api/version",
                "/api/history/open",
                "/api/history/clear",
                "/api/subscriptions/set",
                "/api/subscriptions/refresh",
                "/api/recommendations/preferences",
                "/api/recommendations/refresh",
                "/api/dubbing/synthesize",
                "/api/dubbing/transcribe",
                "/api/dubbing/transcribe/cancel",
                "/api/rvc/start",
                "/api/rvc/cancel",
                "/api/rvc/import",
                "/api/rvc/import-index",
            }
            if route not in allowed_routes:
                self._send_error_json(
                    HTTPStatus.NOT_FOUND,
                    "not_found",
                    "APIが見つかりません。",
                )
                return

            if not self._guard_api_request():
                return

            if route in {'/api/rvc/import', '/api/rvc/import-index'}:
                try:
                    params = parse_qs(urlsplit(self.path).query)
                    size = int(self.headers.get('Content-Length', '0'))
                    limit = MAX_INDEX_BYTES if route.endswith('import-index') else MAX_MODEL_BYTES
                    if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/octet-stream' or self.headers.get('Transfer-Encoding') or not 0 < size <= limit:
                        raise ValueError('インポートの形式・サイズを確認してください。')
                    self.connection.settimeout(30)
                    self._send_json(rvc.import_model(self.rfile, size, params.get('name', [''])[0],
                        params.get('modelId', [''])[0] if route.endswith('import-index') else None))
                except (ValueError, RuntimeError) as exc:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, 'invalid_rvc_import', str(exc))
                finally:
                    self.close_connection = True
                return

            payload = self._read_json_body()
            if payload is None:
                return
            if route in {'/api/rvc/start', '/api/rvc/cancel'}:
                try:
                    result = rvc.cancel(payload.get('jobId', '')) if route.endswith('/cancel') else rvc.start(payload, f'http://127.0.0.1:{self.server.server_port}')
                    self._send_json(result)
                except ValueError as exc:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, 'invalid_rvc', str(exc))
                except RuntimeError as exc:
                    self._send_error_json(HTTPStatus.SERVICE_UNAVAILABLE, 'rvc_unavailable', str(exc))
                return

            if route in {"/api/settings", "/api/dubbing/settings", "/api/ytdlp/update", "/api/ytdlp/reset", "/api/quit"}:
                try:
                    if route == "/api/settings":
                        self._send_json({"settings": settings.save_scoped("app", payload)})
                    elif route == "/api/dubbing/settings":
                        self._send_json({"settings": settings.save_scoped("dubbing", payload)})
                    elif route == "/api/ytdlp/update":
                        self._send_json(updater.start())
                    elif route == "/api/ytdlp/reset":
                        self._send_json(updater.reset())
                    elif allow_shutdown:
                        self._send_json({"message": "ClipNestを終了しました。このタブを閉じてください。"})
                        threading.Thread(target=self.server.shutdown, daemon=True).start()
                    else:
                        self._send_error_json(HTTPStatus.FORBIDDEN, "quit_disabled", "ターミナルでCtrl+Cを押して終了してください。")
                except ValueError as exc:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid_settings", str(exc))
                return

            if route == "/api/version":
                try:
                    status = service.check_version(force=True)
                except Exception:
                    self._send_error_json(
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                        "version_check_error",
                        "最新版を確認できませんでした。",
                    )
                    return
                self._send_json({"appVersion": APP_VERSION, "ytDlp": status})
                return

            request_id = uuid.uuid4().hex[:10]

            if route in {'/api/dubbing/transcribe', '/api/dubbing/transcribe/cancel'}:
                try:
                    result = transcription.cancel(payload.get('jobId', '')) if route.endswith('/cancel') else transcription.start(payload, f'http://127.0.0.1:{self.server.server_port}')
                    self._send_json(result)
                except ValueError as exc:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, 'invalid_transcription', str(exc))
                except RuntimeError as exc:
                    self._send_error_json(HTTPStatus.SERVICE_UNAVAILABLE, 'transcription_unavailable', str(exc))
                return

            if route == "/api/dubbing/synthesize":
                if not dubbing_slots.acquire(blocking=False):
                    self._send_error_json(HTTPStatus.TOO_MANY_REQUESTS, "dubbing_busy", "吹替音声を生成中です。")
                    return
                try:
                    self._send_bytes(dubbing.synthesize(payload), content_type="audio/wav")
                except ValueError as exc:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid_dubbing", str(exc))
                except RuntimeError as exc:
                    self._send_error_json(HTTPStatus.SERVICE_UNAVAILABLE, "dubbing_unavailable", str(exc))
                except Exception:
                    self._send_error_json(HTTPStatus.SERVICE_UNAVAILABLE, "dubbing_unavailable", "音声を生成できませんでした。VOICEVOXの状態を確認してください。")
                finally:
                    dubbing_slots.release()
                return

            if route == "/api/recommendations/preferences":
                try:
                    preferences = library.set_recommendation_preferences(payload.get("region"), payload.get("language"))
                    self._send_json({"preferences": preferences})
                except ValueError as exc:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid_preferences", str(exc))
                except Exception:
                    self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "library_error", "おすすめ設定を保存できませんでした。")
                return

            if route == "/api/recommendations/refresh":
                if not search_slots.acquire(blocking=False):
                    self._send_error_json(HTTPStatus.TOO_MANY_REQUESTS, "search_busy", "別の検索を処理中です。少し待ってから再試行してください。")
                    return
                try:
                    query, preferences = library.regional_search()
                    result = service.search(query)
                    saved = library.record_regional_candidates(result.get("items", []), preferences)
                    self._send_json({"count": saved, "query": query})
                except ValueError as exc:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid_preferences", str(exc))
                except SearchError as exc:
                    self._send_error_json(HTTPStatus.SERVICE_UNAVAILABLE, exc.code, str(exc), hint=exc.hint)
                except Exception:
                    self.log_error("regional refresh failed [%s]", request_id)
                    self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "refresh_error", "地域候補を取得できませんでした。保存済みのおすすめは引き続き使えます。")
                finally:
                    search_slots.release()
                return

            if route == "/api/history/open":
                video_id = payload.get("videoId")
                if not isinstance(video_id, str):
                    self._send_error_json(
                        HTTPStatus.BAD_REQUEST,
                        "invalid_request",
                        "動画IDを読み取れませんでした。",
                        request_id=request_id,
                    )
                    return
                try:
                    history_item = library.record_open(video_id)
                except ValueError as exc:
                    self._send_error_json(
                        HTTPStatus.BAD_REQUEST,
                        "invalid_video",
                        str(exc),
                        request_id=request_id,
                    )
                    return
                except UnknownLibraryItemError as exc:
                    self._send_error_json(
                        HTTPStatus.NOT_FOUND,
                        "unknown_video",
                        str(exc),
                        request_id=request_id,
                    )
                    return
                except Exception:
                    self.log_error("history write failed [%s]", request_id)
                    self._send_error_json(
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                        "library_error",
                        "視聴履歴を保存できませんでした。",
                        request_id=request_id,
                    )
                    return
                self._send_json({"history": history_item})
                return

            if route == "/api/history/clear":
                try:
                    cleared = library.clear_history()
                except Exception:
                    self.log_error("history clear failed [%s]", request_id)
                    self._send_error_json(
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                        "library_error",
                        "履歴を消去できませんでした。",
                        request_id=request_id,
                    )
                    return
                self._send_json({"cleared": cleared})
                return

            if route == "/api/subscriptions/set":
                channel_id = payload.get("channelId")
                subscribed = payload.get("subscribed")
                if not isinstance(channel_id, str) or not isinstance(subscribed, bool):
                    self._send_error_json(
                        HTTPStatus.BAD_REQUEST,
                        "invalid_request",
                        "チャンネルIDと登録状態を正しく指定してください。",
                        request_id=request_id,
                    )
                    return
                try:
                    subscription = library.set_subscription(channel_id, subscribed)
                except ValueError as exc:
                    self._send_error_json(
                        HTTPStatus.BAD_REQUEST,
                        "invalid_channel",
                        str(exc),
                        request_id=request_id,
                    )
                    return
                except UnknownLibraryItemError as exc:
                    self._send_error_json(
                        HTTPStatus.NOT_FOUND,
                        "unknown_channel",
                        str(exc),
                        request_id=request_id,
                    )
                    return
                except Exception:
                    self.log_error("subscription write failed [%s]", request_id)
                    self._send_error_json(
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                        "library_error",
                        "チャンネル登録を保存できませんでした。",
                        request_id=request_id,
                    )
                    return
                self._send_json({"subscription": subscription})
                return

            if route == "/api/subscriptions/refresh":
                channels = library.channels_to_refresh(limit=MAX_REFRESH_CHANNELS)
                refreshed = 0
                failed: list[str] = []
                first_error: SearchError | None = None
                for channel in channels:
                    if not search_slots.acquire(blocking=False):
                        failed.append(channel["channel"])
                        continue
                    try:
                        result = service.channel_videos(
                            channel["channelId"],
                            limit=VIDEOS_PER_CHANNEL_REFRESH,
                        )
                        library.record_channel_videos(
                            channel["channelId"],
                            (
                                result.get("channel")
                                if result.get("channel") != "チャンネル不明"
                                else channel["channel"]
                            ),
                            result.get("items", []),
                        )
                        refreshed += 1
                    except SearchError as exc:
                        first_error = first_error or exc
                        failed.append(channel["channel"])
                    except Exception:
                        self.log_error(
                            "subscription refresh failed [%s]: %s",
                            request_id,
                            channel["channelId"],
                        )
                        failed.append(channel["channel"])
                    finally:
                        search_slots.release()

                if channels and refreshed == 0 and first_error is not None:
                    status = (
                        HTTPStatus.GATEWAY_TIMEOUT
                        if first_error.code == "search_timeout"
                        else HTTPStatus.SERVICE_UNAVAILABLE
                    )
                    self._send_error_json(
                        status,
                        first_error.code,
                        str(first_error),
                        request_id=request_id,
                        hint=first_error.hint,
                        diagnostics=first_error.diagnostics,
                    )
                    return

                response = library.subscriptions_payload()
                response["refresh"] = {
                    "attemptedChannels": len(channels),
                    "refreshedChannels": refreshed,
                    "failedChannels": failed,
                    "hasMore": response["channelCount"] > len(channels),
                }
                self._send_json(response)
                return

            query = payload.get("query", "")
            if not isinstance(query, str):
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST,
                    "invalid_request",
                    "検索内容を読み取れませんでした。",
                )
                return

            if not search_slots.acquire(blocking=False):
                self._send_error_json(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    "search_busy",
                    "別の検索を処理中です。少し待ってから再試行してください。",
                    request_id=request_id,
                )
                return
            try:
                result = service.search(query)
                library.record_search(result.get("query", query), result.get("items", []))
                result["items"] = library.annotate_items(result.get("items", []))
                result["subscriptionCount"] = library.subscription_count()
            except ValueError as exc:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST,
                    "invalid_query",
                    str(exc),
                    request_id=request_id,
                )
                return
            except SearchError as exc:
                status = (
                    HTTPStatus.GATEWAY_TIMEOUT
                    if exc.code == "search_timeout"
                    else HTTPStatus.SERVICE_UNAVAILABLE
                )
                self.log_error("search failed [%s]: %s", request_id, exc.code)
                self._send_error_json(
                    status,
                    exc.code,
                    str(exc),
                    request_id=request_id,
                    hint=exc.hint,
                    diagnostics=exc.diagnostics,
                )
                return
            except Exception:
                self.log_error("unexpected search error [%s]", request_id)
                self._send_error_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "予期しないエラーが発生しました。",
                    request_id=request_id,
                )
                return
            finally:
                search_slots.release()

            self._send_json(result)

        def log_message(self, format_string: str, *args: Any) -> None:
            # BaseHTTPRequestHandler arguments may contain search terms, signed
            # URLs or channel IDs. Deliberately do not interpolate any of them.
            if format_string != '"%s" %s %s':
                logging.getLogger("clipnest").warning("request_notice")

    return ClipNestHandler


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="yt-dlpで検索し、ClipNest独自プレーヤーで再生するローカルアプリ",
    )
    parser.add_argument("--port", type=int, default=8000, help="待受ポート")
    parser.add_argument("--version", action="version", version=APP_VERSION)
    parser.add_argument("--no-browser", action="store_true", help="配布版でもブラウザを自動で開かない")
    parser.add_argument(
        "--open-browser",
        action="store_true",
        help="起動後に既定ブラウザを開く",
    )
    parser.add_argument(
        "--database",
        type=Path,
        default=DEFAULT_DATABASE_PATH,
        help="端末内の履歴・登録情報を保存するSQLiteファイル",
    )
    return parser.parse_args()


def running_clipnest_url(
    host: str,
    port: int,
    *,
    urlopen: Callable[..., Any] = urllib.request.urlopen,
) -> str | None:
    """指定ポートですでにClipNestが応答していればURLを返す。"""
    url = f"http://{host}:{port}"
    try:
        with urlopen(f"{url}/api/status", timeout=1.0) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, TimeoutError, ValueError, json.JSONDecodeError):
        return None
    if isinstance(payload, dict) and isinstance(payload.get("appVersion"), str):
        return url
    return None


def main() -> None:
    import sys
    args = parse_args()
    if not 0 <= args.port <= 65535:
        raise SystemExit("ポートは0〜65535の整数で指定してください。")
    packaged = bool(getattr(sys, "frozen", False))
    args.open_browser = not args.no_browser and (args.open_browser or packaged)
    # Do not snapshot an old version's DB then leave that old process running.
    # Let the user exit it first; the next launch performs the migration.
    host = "127.0.0.1"
    existing_url = running_clipnest_url(host, args.port) if args.port else None
    if existing_url:
        print("ClipNestは起動済みです。新版への切り替えは旧アプリを終了してから起動してください。")
        if args.open_browser:
            webbrowser.open(existing_url)
        return
    prepare_environment()
    directory = data_directory()
    legacy = APP_DIR / "data" / "clipnest.sqlite3" if args.database == DEFAULT_DATABASE_PATH and not os.environ.get("CLIPNEST_DATA_DIR") else None
    migrated = setup_user_data(directory, legacy)
    configure_logging(directory)
    logging.getLogger("clipnest").info("startup version=%s migrated=%s", APP_VERSION, migrated)
    settings = Settings(directory)
    service = YtDlpService()
    library = LibraryService(args.database)
    handler = create_handler(service, library=library, settings=settings, allow_shutdown=True)
    host = "127.0.0.1"
    try:
        server = LimitedThreadingHTTPServer((host, args.port), handler)
    except OSError as exc:
        if exc.errno not in PORT_IN_USE_ERRNOS:
            raise
        existing_url = running_clipnest_url(host, args.port)
        if existing_url:
            print(f"ClipNestはすでに起動しています: {existing_url}")
            if args.open_browser:
                webbrowser.open(existing_url)
            return
        raise StartupError(
            f"ポート {args.port} は別のアプリが使用中です。"
            "使用中のアプリを終了してからClipNestを起動してください。"
        ) from exc
    url = f"http://{host}:{server.server_address[1]}"

    print(f"ClipNestを起動しました: {url}")
    print("終了するには Ctrl+C を押してください。")

    if args.open_browser:
        threading.Timer(0.4, webbrowser.open, args=(url,)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nClipNestを終了します。")
    finally:
        server.server_close()


if __name__ == "__main__":
    import sys
    try:
        main()
    except (OSError, RuntimeError) as exc:
        print(str(exc) if isinstance(exc, StartupError) else "起動できませんでした。保存先のアクセス権・空き容量を確認してください。", file=sys.stderr)
        raise SystemExit(1)
