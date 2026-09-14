from __future__ import annotations

import json
from contextlib import nullcontext
import io
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from app import (
    STATIC_DIR,
    LimitedThreadingHTTPServer,
    create_handler,
    open_ended_range_start,
    parse_content_range,
    running_clipnest_url,
)
from library_service import LibraryService
from youtube_service import SearchError


class FakeService:
    def __init__(self) -> None:
        self.stream_max_ages: list[float] = []

    def local_status(self) -> dict:
        return {
            "available": True,
            "currentVersion": "2026.8.19",
            "source": "テスト環境",
            "message": "利用できます。",
            "runtimes": {"node": True, "deno": False},
        }

    def check_version(self, *, force: bool = False) -> dict:
        return {
            **self.local_status(),
            "checkedLatest": True,
            "latestVersion": "2026.8.19",
            "updateAvailable": False,
            "versionMessage": "最新です。",
            "force": force,
        }

    def search(self, query: str) -> dict:
        if query == "fail":
            raise SearchError(
                "検索できませんでした。",
                hint="ネットワークを確認してください。",
                diagnostics=self.check_version(),
            )
        if not query.strip():
            raise ValueError("検索キーワードを入力してください。")
        return {
            "query": query,
            "count": 1,
            "items": [
                {
                    "id": "abcdefghijk",
                    "title": "テスト動画",
                    "channel": "テストチャンネル",
                    "channelId": "UCabcdefghijklmnopqrstuv",
                    "duration": 120,
                    "viewCount": 100,
                    "isLive": False,
                    "isUpcoming": False,
                    "publishedAt": 1_725_000_000,
                    "thumbnail": "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
                    "url": "https://www.youtube.com/watch?v=abcdefghijk",
                }
            ],
        }

    def video_details(self, video_id: str) -> dict:
        return {"videoId": video_id, "description": "公開概要", "chapters": [{"start": 10, "title": "章"}]}

    def channel_videos(self, channel_id: str, *, limit: int = 8, offset: int = 0) -> dict:
        return {
            "channelId": channel_id,
            "channel": "テストチャンネル",
            "description": "テストチャンネルの説明です。",
            "subscriberCount": 1234,
            "avatar": "https://yt3.googleusercontent.com/test=s900",
            "handle": "@test-channel",
            "url": f"https://www.youtube.com/channel/{channel_id}",
            "count": 1,
            "items": [
                {
                    "id": "lmnopqrstuv",
                    "title": "登録チャンネルの新着",
                    "channel": "テストチャンネル",
                    "channelId": channel_id,
                    "duration": 180,
                    "viewCount": 200,
                    "isLive": False,
                    "isUpcoming": False,
                    "publishedAt": 1_726_000_000,
                    "thumbnail": "https://i.ytimg.com/vi/lmnopqrstuv/hqdefault.jpg",
                    "url": "https://www.youtube.com/watch?v=lmnopqrstuv",
                }
            ],
        }

    def resolve_audio_stream(self, video_id: str, *, max_age_seconds: float = 600.0, audio_format: str = "m4a") -> dict:
        self.stream_max_ages.append(max_age_seconds)
        if video_id != "abcdefghijk":
            raise ValueError("動画IDの形式が正しくありません。")
        return {
            "url": "data:audio/mp4;base64,QUJD",
            "headers": {},
            "ext": "m4a",
            "acodec": "aac",
            "title": "テスト動画",
        }


class BlockingMediaResponse:
    """最初の音声チャンク後に、テスト側が解除するまで停止する応答。"""

    status = 206
    headers = {
        "Content-Type": "audio/mp4",
        "Content-Length": "3",
        "Content-Range": "bytes 0-2/3",
        "Accept-Ranges": "bytes",
    }

    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self._sent = False

    def read1(self, _size: int = -1) -> bytes:
        if not self._sent:
            self._sent = True
            self.started.set()
            return b"ABC"
        self.release.wait(timeout=3)
        return b""

    read = read1

    def close(self) -> None:
        pass


class JsonResponse:
    def __init__(self, payload: dict) -> None:
        self.body = json.dumps(payload).encode("utf-8")

    def __enter__(self) -> JsonResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        pass

    def read(self) -> bytes:
        return self.body


class MediaRangeHelpersTests(unittest.TestCase):
    def test_open_ended_range_is_parsed(self) -> None:
        self.assertEqual(open_ended_range_start("bytes=4194304-"), 4_194_304)
        self.assertIsNone(open_ended_range_start("bytes=0-1023"))
        self.assertIsNone(open_ended_range_start("bytes=-1024"))

    def test_content_range_is_parsed_and_validated(self) -> None:
        self.assertEqual(
            parse_content_range("bytes 0-4194303/118532944"),
            (0, 4_194_303, 118_532_944),
        )
        self.assertIsNone(parse_content_range("bytes 0-99/*"))
        self.assertIsNone(parse_content_range("invalid"))


class AppHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.library = LibraryService(Path(self.temp_directory.name) / "test.sqlite3")
        self.service = FakeService()
        handler = create_handler(self.service, STATIC_DIR, self.library)
        self.server = LimitedThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp_directory.cleanup()

    def request_json(self, request: urllib.request.Request | str) -> tuple[int, dict, object]:
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return (
                    response.status,
                    json.loads(response.read().decode("utf-8")),
                    response.headers,
                )
        except urllib.error.HTTPError as error:
            try:
                return (
                    error.code,
                    json.loads(error.read().decode("utf-8")),
                    error.headers,
                )
            finally:
                error.close()

    def get_json(self, path: str) -> tuple[int, dict]:
        status, payload, _headers = self.request_json(f"{self.base_url}{path}")
        return status, payload

    def post_json(self, path: str, payload: dict) -> tuple[int, dict]:
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        status, response_payload, _headers = self.request_json(request)
        return status, response_payload

    def test_settings_persist_and_validate(self) -> None:
        status, data = self.get_json('/api/settings')
        self.assertEqual(status, 200)
        self.assertEqual(data['settings'], {'defaultRate': 1.0})
        status, data = self.post_json('/api/settings', {'defaultRate': 0.75})
        self.assertEqual(status, 200)
        self.assertEqual(data['settings']['defaultRate'], 0.75)
        self.assertEqual(self.post_json('/api/settings', {'voicevoxPort': 0})[0], 400)
        self.assertEqual(self.get_json('/api/settings')[1]['settings']['defaultRate'], 0.75)
        self.assertEqual(self.post_json('/api/quit', {})[0], 403)

    def test_rvc_optional_status_and_invalid_requests(self) -> None:
        status, data = self.get_json('/api/rvc/status')
        self.assertEqual(status, 200)
        self.assertFalse(data['available'])
        self.assertEqual(data['models'], [])
        self.assertFalse((Path(self.temp_directory.name) / 'rvc').exists())
        self.assertEqual(self.get_json('/api/settings')[1]['settings'], {'defaultRate': 1.0})
        for route, payload in [('/api/rvc/start', {'videoId': '../escape'}), ('/api/rvc/cancel', {'jobId': '../escape'})]:
            self.assertEqual(self.post_json(route, payload)[0], 400)
        self.assertEqual(self.get_json('/api/rvc/audio?jobId=bad&stem=../voice')[0], 400)

    def test_rvc_import_is_guarded_and_size_limited(self) -> None:
        for route in ('/api/rvc/start', '/api/rvc/cancel', '/api/rvc/import', '/api/rvc/import-index'):
            request = urllib.request.Request(self.base_url + route, data=b'{}', method='POST',
                headers={'Content-Type': 'application/json', 'Origin': 'https://evil.invalid'})
            self.assertEqual(self.request_json(request)[0], 403)
        for content_type, size in [('application/json', 2), ('application/octet-stream', 128 * 1024**2 + 1), ('application/octet-stream', 0)]:
            request = urllib.request.Request(self.base_url + '/api/rvc/import?name=test', data=b'{}', method='POST',
                headers={'Content-Type': content_type, 'Content-Length': str(size)})
            self.assertEqual(self.request_json(request)[0], 400)

    def test_dubbing_settings_do_not_modify_common_settings(self) -> None:
        status, data = self.get_json('/api/dubbing/settings')
        self.assertEqual(status, 200)
        self.assertEqual(data['settings'], {'voicevoxPort': 50021, 'whisperModel': 'base'})
        self.post_json('/api/settings', {'defaultRate': 0.75})
        self.assertEqual(self.post_json('/api/dubbing/settings', {'voicevoxPort': 50025})[0], 200)
        self.assertEqual(self.post_json('/api/dubbing/settings', {'whisperModel': 'small'})[0], 200)
        self.assertEqual(self.get_json('/api/dubbing/settings')[1]['settings'], {'voicevoxPort': 50025, 'whisperModel': 'small'})
        self.assertEqual(self.get_json('/api/settings')[1]['settings'], {'defaultRate': 0.75})
        for patch in ({'defaultRate': 2}, {'voicevoxPort': 80}, {'whisperModel': 'invalid'}):
            self.assertEqual(self.post_json('/api/dubbing/settings', patch)[0], 400)

    def test_settings_mutations_reject_foreign_origin(self) -> None:
        for route in ('/api/settings', '/api/dubbing/settings', '/api/ytdlp/update', '/api/ytdlp/reset', '/api/quit'):
            request = urllib.request.Request(self.base_url + route, data=b'{}', method='POST',
                headers={'Content-Type': 'application/json', 'Origin': 'https://evil.invalid'})
            self.assertEqual(self.request_json(request)[0], 403)

    def test_diagnostics_are_private_by_construction(self) -> None:
        status, data = self.get_json('/api/diagnostics')
        self.assertEqual(status, 200)
        self.assertNotIn('dataDirectory', data)
        self.assertNotIn('updateCommand', data['ytDlp'])
        self.assertNotIn('whisper', data)
        self.assertNotIn('voicevoxReachable', data)
        self.assertNotIn('VOICEVOX', json.dumps(data))
        self.assertNotIn(self.temp_directory.name, json.dumps(data))
        self.assertEqual(self.get_json('/api/ytdlp/update')[1]['state'], 'idle')

    def test_root_serves_app_with_security_headers(self) -> None:
        with urllib.request.urlopen(f"{self.base_url}/", timeout=2) as response:
            body = response.read().decode("utf-8")
            self.assertEqual(response.status, 200)
            self.assertIn("ClipNest", body)
            self.assertIn("Content-Security-Policy", response.headers)
            self.assertIn("'wasm-unsafe-eval'", response.headers["Content-Security-Policy"])
            self.assertNotIn("'unsafe-eval'", response.headers["Content-Security-Policy"])
            self.assertEqual(response.headers["Server"], "ClipNest")

    def test_home_pagination_parameters(self) -> None:
        status, payload = self.get_json("/api/home?offset=48")
        self.assertEqual(status, 200)
        self.assertIn("hasMore", payload)
        self.assertIn("nextOffset", payload)
        for value in ("-1", "1201", "abc", "1.5", "99999999999"):
            status, _ = self.get_json(f"/api/home?offset={value}")
            self.assertEqual(status, 400)

    def test_details_and_channel_page_routes(self) -> None:
        status, details = self.get_json('/api/video/details?videoId=abcdefghijk')
        self.assertEqual(status, 200)
        self.assertEqual(details['chapters'][0]['start'], 10)
        status, page = self.get_json('/api/channel/videos?channelId=UCabcdefghijklmnopqrstuv&offset=24')
        self.assertEqual(status, 200)
        self.assertEqual(page['nextOffset'], 48)
        self.assertIn('hasMore', page)
        status, _ = self.get_json('/api/channel/videos?channelId=UCabcdefghijklmnopqrstuv&offset=bad')
        self.assertEqual(status, 400)

    def test_status_and_version_endpoints(self) -> None:
        status_code, status = self.get_json("/api/status")
        version_code, version = self.post_json("/api/version", {})

        self.assertEqual(status_code, 200)
        self.assertTrue(status["ytDlp"]["available"])
        self.assertEqual(version_code, 200)
        self.assertTrue(version["ytDlp"]["checkedLatest"])
        self.assertTrue(version["ytDlp"]["force"])

    def test_running_instance_is_detected_from_status_endpoint(self) -> None:
        url = running_clipnest_url(
            "127.0.0.1",
            8000,
            urlopen=lambda *_args, **_kwargs: JsonResponse(
                {"appVersion": "2.3.2", "ytDlp": {"available": True}}
            ),
        )

        self.assertEqual(url, "http://127.0.0.1:8000")

    def test_app_layout_stylesheet_is_served(self) -> None:
        with urllib.request.urlopen(self.base_url + '/app-layout.css', timeout=2) as response:
            self.assertEqual(response.status, 200)
            self.assertIn('text/css', response.headers['Content-Type'])
            self.assertIn(b'.topic-bar', response.read())

    def test_module_endpoint_discovers_extended_features(self) -> None:
        status, payload = self.get_json("/api/modules")
        files = {item["file"] for item in payload["items"]}

        self.assertEqual(status, 200)
        self.assertTrue(
            {"equalizer.js", "loudness-normalizer.js", "sleep-timer.js"}.issubset(
                files
            )
        )

    def test_version_get_is_not_allowed(self) -> None:
        status, payload = self.get_json("/api/version")

        self.assertEqual(status, 405)
        self.assertEqual(payload["error"]["code"], "method_not_allowed")

    def test_cross_site_api_request_is_rejected(self) -> None:
        request = urllib.request.Request(
            f"{self.base_url}/api/search",
            data=b'{"query":"test"}',
            headers={
                "Content-Type": "application/json",
                "Origin": "https://attacker.example",
                "Sec-Fetch-Site": "cross-site",
            },
            method="POST",
        )

        status, payload, _headers = self.request_json(request)

        self.assertEqual(status, 403)
        self.assertEqual(payload["error"]["code"], "forbidden_request")

    def test_non_loopback_host_header_is_rejected(self) -> None:
        request = urllib.request.Request(
            f"{self.base_url}/api/search",
            data=b'{"query":"test"}',
            headers={
                "Content-Type": "application/json",
                "Host": f"attacker.example:{self.server.server_address[1]}",
            },
            method="POST",
        )

        status, payload, _headers = self.request_json(request)

        self.assertEqual(status, 403)
        self.assertEqual(payload["error"]["code"], "forbidden_request")

    def test_non_json_search_request_is_rejected(self) -> None:
        request = urllib.request.Request(
            f"{self.base_url}/api/search",
            data=b'{"query":"test"}',
            headers={"Content-Type": "text/plain"},
            method="POST",
        )

        status, payload, _headers = self.request_json(request)

        self.assertEqual(status, 415)
        self.assertEqual(payload["error"]["code"], "invalid_content_type")

    def test_search_endpoint(self) -> None:
        status, payload = self.post_json("/api/search", {"query": "音楽"})

        self.assertEqual(status, 200)
        self.assertEqual(payload["query"], "音楽")
        self.assertEqual(payload["count"], 1)
        self.assertFalse(payload["items"][0]["isSubscribed"])

    def test_dubbing_api_routes(self) -> None:
        with patch('app.DubbingService.voices', return_value={'voices': [{'id': 1, 'name': 'test'}]}):
            self.assertEqual(self.get_json('/api/dubbing/voices')[1]['voices'][0]['id'], 1)
        with patch('app.DubbingService.subtitles', return_value={'cues': []}):
            self.assertEqual(self.get_json('/api/dubbing/subtitles?videoId=abcdefghijk&language=ja')[0], 200)
        self.assertEqual(self.post_json('/api/dubbing/synthesize', {'text': '', 'speaker': 1})[0], 400)
        with patch('app.DubbingService.synthesize', return_value=b'RIFF1234WAVEdata'):
            request = urllib.request.Request(self.base_url + '/api/dubbing/synthesize', data=b'{"text":"test","speaker":1}', headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=2) as response:
                self.assertEqual(response.headers['Content-Type'], 'audio/wav')
                self.assertEqual(response.read(), b'RIFF1234WAVEdata')

    def test_transcription_api_routes(self) -> None:
        with patch('app.TranscriptionService.status', return_value={'available': False}):
            self.assertFalse(self.get_json('/api/dubbing/asr-status')[1]['available'])
        self.assertEqual(self.get_json('/api/dubbing/transcription?jobId=bad')[0], 400)
        self.assertEqual(self.post_json('/api/dubbing/transcribe/cancel', {'jobId': []})[0], 400)
        self.assertEqual(self.post_json('/api/dubbing/transcribe', {'videoId': '../escape'})[0], 400)
        with patch('app.TranscriptionService.start', return_value={'jobId': 'a' * 32}) as start:
            self.assertEqual(self.post_json('/api/dubbing/transcribe', {'videoId': 'abcdefghijk'})[0], 200)
            self.assertEqual(start.call_args.args[1], self.base_url)

    def test_compatible_audio_supports_seek_ranges(self) -> None:
        for range_header, expected_status, expected_body in [("bytes=2-5", 206, b"2345"), ("bytes=-3", 206, b"789"), ("bytes=50-", 416, b"")]:
            with patch("app.CompatibleAudio.open", return_value=nullcontext((io.BytesIO(b"0123456789"), 10))):
                request = urllib.request.Request(self.base_url + "/api/media/abcdefghijk?format=m4a-safe", headers={"Range": range_header})
                try:
                    response = urllib.request.urlopen(request, timeout=2)
                except urllib.error.HTTPError as exc:
                    response = exc
                with response:
                    self.assertEqual(response.status, expected_status)
                    self.assertEqual(response.read(), expected_body)

    def test_regional_recommendation_endpoints(self) -> None:
        self.assertEqual(self.post_json("/api/recommendations/refresh", {})[0], 400)
        self.assertEqual(self.post_json("/api/recommendations/preferences", {"region": [], "language": "ja"})[0], 400)
        status, data = self.post_json("/api/recommendations/preferences", {"region": "JP", "language": "ja"})
        self.assertEqual(status, 200)
        self.assertEqual(data["preferences"]["region"], "JP")
        status, data = self.post_json("/api/recommendations/refresh", {})
        self.assertEqual(status, 200)
        self.assertEqual(data["count"], 1)
        home = self.get_json("/api/home")[1]
        self.assertEqual(home["signals"]["searches"], 0)
        self.assertTrue(home["items"][0]["regionalCandidate"])

    def test_regional_refresh_failure_keeps_preferences(self) -> None:
        self.post_json("/api/recommendations/preferences", {"region": "JP", "language": "ja"})
        with patch.object(self.service, "search", side_effect=SearchError("取得失敗")):
            self.assertEqual(self.post_json("/api/recommendations/refresh", {})[0], 503)
        self.assertEqual(self.get_json("/api/home")[1]["preferences"]["region"], "JP")
        self.assertEqual(self.post_json("/api/recommendations/refresh", {})[0], 200)

    def test_channel_overview_and_next_candidates(self) -> None:
        self.post_json("/api/search", {"query": "音楽"})

        channel_status, channel = self.get_json(
            "/api/channel?channelId=UCabcdefghijklmnopqrstuv"
        )
        with patch('app.RelatedService.fetch', return_value=[{'id': 'lmnopqrstuv', 'title': '関連動画', 'channel': '関連チャンネル', 'duration': 120}]):
            next_status, next_payload = self.get_json('/api/next?videoId=abcdefghijk')

        self.assertEqual(channel_status, 200)
        self.assertEqual(channel["channel"], "テストチャンネル")
        self.assertEqual(channel["description"], "テストチャンネルの説明です。")
        self.assertEqual(channel["subscriberCount"], 1234)
        self.assertIn("lmnopqrstuv", {item["id"] for item in channel["items"]})
        self.assertEqual(next_status, 200)
        self.assertEqual(next_payload["items"][0]["id"], "lmnopqrstuv")
        self.assertEqual(next_payload["items"][0]["reason"], "再生中の動画の関連候補")
        with patch('app.RelatedService.fetch', return_value=[]):
            self.assertEqual(self.get_json('/api/next?videoId=abcdefghijk')[1]['items'], [])
        with patch('app.RelatedService.fetch', side_effect=RuntimeError('取得できません')):
            self.assertEqual(self.get_json('/api/next?videoId=abcdefghijk')[0], 503)

    def test_local_home_history_and_subscription_endpoints(self) -> None:
        self.post_json("/api/search", {"query": "音楽"})

        home_status, home = self.get_json("/api/home")
        opened_status, _opened = self.post_json(
            "/api/history/open", {"videoId": "abcdefghijk"}
        )
        subscribed_status, subscribed = self.post_json(
            "/api/subscriptions/set",
            {"channelId": "UCabcdefghijklmnopqrstuv", "subscribed": True},
        )
        refresh_status, refreshed = self.post_json("/api/subscriptions/refresh", {})
        history_status, history = self.get_json("/api/history")

        self.assertEqual(home_status, 200)
        self.assertEqual(home["count"], 1)
        self.assertEqual(opened_status, 200)
        self.assertEqual(subscribed_status, 200)
        self.assertTrue(subscribed["subscription"]["subscribed"])
        self.assertEqual(refresh_status, 200)
        self.assertEqual(refreshed["channelCount"], 1)
        self.assertIn("lmnopqrstuv", {item["id"] for item in refreshed["items"]})
        self.assertEqual(history_status, 200)
        self.assertEqual(history["items"][0]["id"], "abcdefghijk")

    def test_media_get_proxies_audio_bytes(self) -> None:
        request = urllib.request.Request(f"{self.base_url}/api/media/abcdefghijk")
        with urllib.request.urlopen(request, timeout=2) as response:
            body = response.read()

        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers.get_content_type(), "audio/mp4")
        self.assertEqual(body, b"ABC")

    def test_bounded_browser_range_is_joined_without_overfetching(self) -> None:
        content = b"0123456789ABCDEF"
        requests = []

        def open_range(request, **_kwargs):
            value = request.get_header("Range")
            requests.append(value)
            first, last = map(int, value.removeprefix("bytes=").split("-"))
            last = min(last, len(content) - 1)
            response = io.BytesIO(content[first:last + 1])
            response.status = 206
            response.headers = {
                "Content-Type": "audio/mp4",
                "Content-Range": f"bytes {first}-{last}/{len(content)}",
                "Content-Length": str(last - first + 1),
            }
            return response

        self.server.RequestHandlerClass = create_handler(
            self.service, STATIC_DIR, self.library, media_urlopen=open_range,
        )
        with patch("app.MEDIA_UPSTREAM_RANGE_BYTES", 4):
            request = urllib.request.Request(
                f"{self.base_url}/api/media/abcdefghijk",
                headers={"Range": "bytes=2-12"},
            )
            with urllib.request.urlopen(request, timeout=2) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.headers["Content-Range"], "bytes 2-12/16")
                self.assertEqual(response.headers["Content-Length"], "11")
                self.assertEqual(response.read(), content[2:13])
        self.assertEqual(requests, ["bytes=2-5", "bytes=6-9", "bytes=10-12"])

    def test_media_fresh_query_forces_stream_url_refresh(self) -> None:
        request = urllib.request.Request(
            f"{self.base_url}/api/media/abcdefghijk?fresh=1"
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            response.read()

        self.assertEqual(response.status, 200)
        self.assertEqual(self.service.stream_max_ages[-1], 0)

    def test_stalled_media_is_bounded_without_blocking_status(self) -> None:
        upstream = BlockingMediaResponse()
        handler = create_handler(
            self.service,
            STATIC_DIR,
            self.library,
            media_urlopen=lambda *_args, **_kwargs: upstream,
            max_concurrent_media_streams=1,
        )
        server = LimitedThreadingHTTPServer(("127.0.0.1", 0), handler)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        base_url = f"http://127.0.0.1:{server.server_address[1]}"
        media_thread = threading.Thread(
            target=lambda: urllib.request.urlopen(
                f"{base_url}/api/media/abcdefghijk", timeout=2
            ).read(),
            daemon=True,
        )

        try:
            media_thread.start()
            self.assertTrue(upstream.started.wait(timeout=1))

            with urllib.request.urlopen(f"{base_url}/api/status", timeout=1) as response:
                status = json.loads(response.read().decode("utf-8"))
            self.assertTrue(status["ytDlp"]["available"])

            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(
                    f"{base_url}/api/media/abcdefghijk", timeout=1
                )
            self.assertEqual(raised.exception.code, 503)
            self.assertEqual(
                json.loads(raised.exception.read().decode("utf-8"))["error"]["code"],
                "media_busy",
            )
            raised.exception.close()
        finally:
            upstream.release.set()
            media_thread.join(timeout=2)
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=2)

    def test_clear_history_preserves_subscriptions(self) -> None:
        self.post_json("/api/search", {"query": "音楽"})
        self.post_json("/api/history/open", {"videoId": "abcdefghijk"})
        self.post_json(
            "/api/subscriptions/set",
            {"channelId": "UCabcdefghijklmnopqrstuv", "subscribed": True},
        )

        clear_status, _cleared = self.post_json("/api/history/clear", {})
        history_status, history = self.get_json("/api/history")
        subscriptions_status, subscriptions = self.get_json("/api/subscriptions")

        self.assertEqual(clear_status, 200)
        self.assertEqual(history_status, 200)
        self.assertEqual(history["count"], 0)
        self.assertEqual(subscriptions_status, 200)
        self.assertEqual(subscriptions["channelCount"], 1)

    def test_unknown_video_and_invalid_subscription_payload_are_rejected(self) -> None:
        unknown_status, unknown = self.post_json(
            "/api/history/open", {"videoId": "zzzzzzzzzzz"}
        )
        invalid_status, invalid = self.post_json(
            "/api/subscriptions/set",
            {"channelId": "UCabcdefghijklmnopqrstuv", "subscribed": "yes"},
        )

        self.assertEqual(unknown_status, 404)
        self.assertEqual(unknown["error"]["code"], "unknown_video")
        self.assertEqual(invalid_status, 400)
        self.assertEqual(invalid["error"]["code"], "invalid_request")

    def test_search_failure_returns_safe_diagnostic(self) -> None:
        status, payload = self.post_json("/api/search", {"query": "fail"})

        self.assertEqual(status, 503)
        self.assertEqual(payload["error"]["code"], "search_failed")
        self.assertIn("requestId", payload["error"])
        self.assertNotIn("Traceback", json.dumps(payload))
        self.assertEqual(
            payload["error"]["diagnostics"]["currentVersion"],
            "2026.8.19",
        )

    def test_invalid_query_returns_400(self) -> None:
        status, payload = self.post_json("/api/search", {"query": ""})

        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_query")


if __name__ == "__main__":
    unittest.main()
