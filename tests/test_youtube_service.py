from __future__ import annotations

import json
import subprocess
import threading
import time
import unittest
from unittest.mock import patch

from youtube_service import (
    SearchError,
    YtDlpRunner,
    YtDlpService,
    is_newer_version,
    version_key,
)


TEST_RUNNER = YtDlpRunner(
    command=("yt-dlp",),
    source="テスト環境",
    update_command="update yt-dlp",
)


class FakeResponse:
    def __init__(self, payload: dict) -> None:
        self.body = json.dumps(payload).encode("utf-8")

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, *_args: object) -> bytes:
        return self.body


def successful_urlopen(*_args: object, **_kwargs: object) -> FakeResponse:
    return FakeResponse({"info": {"version": "2026.9.1"}})


def equal_version_urlopen(*_args: object, **_kwargs: object) -> FakeResponse:
    return FakeResponse({"info": {"version": "2026.8.19"}})


class VersionHelpersTests(unittest.TestCase):
    def test_version_key_accepts_stable_and_nightly_versions(self) -> None:
        self.assertEqual(version_key("2026.08.19"), (2026, 8, 19))
        self.assertEqual(version_key("nightly@2026.08.19.123456"), (2026, 8, 19, 123456))
        self.assertIsNone(version_key("unknown"))

    def test_newer_version_comparison(self) -> None:
        self.assertTrue(is_newer_version("2026.9.1", "2026.8.19"))
        self.assertFalse(is_newer_version("2026.8.19", "2026.8.19"))
        self.assertFalse(is_newer_version("2026.8.19", "2026.9.1"))
        self.assertIsNone(is_newer_version("unknown", "2026.8.19"))


class YtDlpServiceTests(unittest.TestCase):
    def make_command_runner(
        self,
        *,
        search_returncode: int = 0,
        search_stderr: str = "",
        search_payload: dict | None = None,
    ):
        payload = search_payload or {
            "_type": "playlist",
            "entries": [
                {
                    "id": "abcdefghijk",
                    "title": "テスト動画",
                    "channel": "テストチャンネル",
                    "channel_id": "UCabcdefghijklmnopqrstuv",
                    "duration": 125.7,
                    "view_count": 12345,
                    "timestamp": 1_725_000_000,
                },
                None,
                {"id": "invalid", "title": "除外対象"},
            ],
        }

        def command_runner(args: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            if "--version" in args:
                return subprocess.CompletedProcess(args, 0, stdout="2026.8.19\n", stderr="")
            return subprocess.CompletedProcess(
                args,
                search_returncode,
                stdout=json.dumps(payload),
                stderr=search_stderr,
            )

        return command_runner

    def make_service(self, **kwargs: object) -> YtDlpService:
        return YtDlpService(
            runner=TEST_RUNNER,
            auto_discover=False,
            command_runner=kwargs.pop("command_runner", self.make_command_runner()),
            urlopen=kwargs.pop("urlopen", successful_urlopen),
            **kwargs,
        )

    def test_search_expands_candidates_and_preserves_relevance_order(self) -> None:
        service = self.make_service()
        with patch.object(service, '_listing', return_value=[{'id': 'bbbbbbbbbbb'}, {'id': 'aaaaaaaaaaa'}, {'id': 'bbbbbbbbbbb'}]) as listing:
            result = service.search("音楽")
        self.assertEqual(listing.call_args.args[0], "ytsearch36:音楽")
        self.assertEqual(listing.call_args.kwargs["limit"], 36)
        self.assertEqual([item["id"] for item in result["items"]], ['bbbbbbbbbbb', 'aaaaaaaaaaa'])
        self.assertEqual(result["count"], 2)
        with self.assertRaises(ValueError): service.search("音楽", limit=61)

    def test_details_do_not_expose_stream_urls_or_headers(self) -> None:
        service = self.make_service()
        with patch.object(service, 'resolve_audio_stream', return_value={
            'url': 'https://secret.invalid/', 'headers': {'Cookie': 'secret'},
            'description': '概要', 'chapters': [{'start_time': 12, 'title': '章'}, {'start_time': float('nan')}, {'start_time': -1}],
        }):
            result = service.video_details('abcdefghijk')
            self.assertEqual(result, {'videoId': 'abcdefghijk', 'description': '概要', 'chapters': [{'start': 12, 'title': '章'}]})
        with self.assertRaises(ValueError): service.video_details('../bad')

    def test_channel_pagination_uses_bounded_playlist_start(self) -> None:
        service = self.make_service()
        with patch.object(service, '_run', wraps=service._run) as run:
            service.channel_videos('UCabcdefghijklmnopqrstuv', limit=24, offset=24)
        args = run.call_args.args[0]
        self.assertEqual(args[args.index('--playlist-start') + 1], '25')
        self.assertEqual(args[args.index('--playlist-end') + 1], '48')
        with self.assertRaises(ValueError): service.channel_videos('UCabcdefghijklmnopqrstuv', offset=481)

    def test_search_returns_allowlisted_display_fields(self) -> None:
        service = self.make_service()

        result = service.search("Python 入門")

        self.assertEqual(result["query"], "Python 入門")
        self.assertEqual(result["count"], 1)
        self.assertEqual(
            result["items"][0],
            {
                "id": "abcdefghijk",
                "title": "テスト動画",
                "channel": "テストチャンネル",
                "channelId": "UCabcdefghijklmnopqrstuv",
                "duration": 125,
                "viewCount": 12345,
                "isLive": False,
                "isUpcoming": False,
                "publishedAt": 1_725_000_000,
                "thumbnail": "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
                "url": "https://www.youtube.com/watch?v=abcdefghijk",
            },
        )

    def test_search_supports_youtube_url(self) -> None:
        captured: list[tuple[list[str], dict[str, object]]] = []

        def command_runner(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            captured.append((args, kwargs))
            if "--version" in args:
                return subprocess.CompletedProcess(args, 0, "2026.8.19\n", "")
            payload = {"id": "abcdefghijk", "title": "URL動画", "uploader": "作者"}
            return subprocess.CompletedProcess(args, 0, json.dumps(payload), "")

        service = self.make_service(command_runner=command_runner)
        result = service.search("https://www.youtube.com/watch?v=abcdefghijk")

        self.assertEqual(result["count"], 1)
        search_args, search_kwargs = next(
            call for call in captured if "--batch-file" in call[0]
        )
        self.assertNotIn("https://www.youtube.com/watch?v=abcdefghijk", search_args)
        self.assertEqual(
            search_kwargs["input"],
            "https://www.youtube.com/watch?v=abcdefghijk\n",
        )

    def test_channel_videos_uses_validated_channel_url_and_fallback_id(self) -> None:
        captured: list[tuple[list[str], dict[str, object]]] = []

        def command_runner(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            captured.append((args, kwargs))
            if "--version" in args:
                return subprocess.CompletedProcess(args, 0, "2026.8.19\n", "")
            payload = {
                "channel": "登録チャンネル",
                "description": "チャンネルの説明",
                "channel_follower_count": 4321,
                "uploader_id": "@registered-channel",
                "thumbnails": [
                    {
                        "url": "https://yt3.googleusercontent.com/avatar=s900",
                        "width": 900,
                    },
                    {"url": "https://attacker.example/avatar", "width": 1200},
                ],
                "entries": [{"id": "abcdefghijk", "title": "新着動画"}],
            }
            return subprocess.CompletedProcess(args, 0, json.dumps(payload), "")

        service = self.make_service(command_runner=command_runner)
        result = service.channel_videos("UCabcdefghijklmnopqrstuv")

        self.assertEqual(result["items"][0]["channelId"], "UCabcdefghijklmnopqrstuv")
        self.assertEqual(result["description"], "チャンネルの説明")
        self.assertEqual(result["subscriberCount"], 4321)
        self.assertEqual(result["handle"], "@registered-channel")
        self.assertEqual(
            result["avatar"], "https://yt3.googleusercontent.com/avatar=s900"
        )
        listing_args, listing_kwargs = next(call for call in captured if "--batch-file" in call[0])
        self.assertNotIn("UCabcdefghijklmnopqrstuv", listing_args)
        self.assertEqual(
            listing_kwargs["input"],
            "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/videos\n",
        )

    def test_channel_videos_rejects_invalid_channel_id_without_running(self) -> None:
        service = self.make_service()

        with self.assertRaisesRegex(ValueError, "チャンネルID"):
            service.channel_videos("../invalid")

    def test_audio_stream_uses_long_timeout_and_deduplicates_resolution(self) -> None:
        calls = 0
        call_lock = threading.Lock()
        captured: list[tuple[list[str], dict[str, object]]] = []

        def command_runner(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            nonlocal calls
            captured.append((args, kwargs))
            if "--version" in args:
                return subprocess.CompletedProcess(args, 0, "2026.8.19\n", "")
            with call_lock:
                calls += 1
            time.sleep(0.05)
            payload = {
                "url": "https://media.example/audio.m4a",
                "http_headers": {"User-Agent": "test"},
                "ext": "m4a",
                "acodec": "mp4a.40.2",
            }
            return subprocess.CompletedProcess(args, 0, json.dumps(payload), "")

        service = self.make_service(command_runner=command_runner, stream_timeout=60)
        results: list[dict] = []
        threads = [
            threading.Thread(
                target=lambda: results.append(service.resolve_audio_stream("abcdefghijk"))
            )
            for _index in range(4)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=2)

        stream_args, stream_kwargs = next(
            call for call in captured if "--dump-single-json" in call[0]
        )
        format_index = stream_args.index("--format")
        self.assertIn("ext=m4a", stream_args[format_index + 1])
        self.assertEqual(stream_kwargs["timeout"], 60)
        self.assertEqual(calls, 1)
        self.assertEqual(len(results), 4)

    def test_audio_formats_have_separate_cached_streams(self) -> None:
        formats = []

        def command_runner(args, **kwargs):
            if "--version" in args:
                return subprocess.CompletedProcess(args, 0, "2026.8.19\n", "")
            selector = args[args.index("--format") + 1]
            selected = "webm" if "ext=webm" in selector else "m4a"
            formats.append(selected)
            return subprocess.CompletedProcess(args, 0, json.dumps({
                "url": f"https://media.example/audio.{selected}",
                "ext": selected,
            }), "")

        service = self.make_service(command_runner=command_runner)
        for selected in ["m4a", "webm", "m4a", "webm"]:
            result = service.resolve_audio_stream("abcdefghijk", audio_format=selected)
            self.assertEqual(result["ext"], selected)
        self.assertEqual(formats, ["m4a", "webm"])
        with self.assertRaises(ValueError):
            service.resolve_audio_stream("abcdefghijk", audio_format="unknown")
        self.assertEqual(formats, ["m4a", "webm"])

    def test_search_rejects_non_youtube_url_without_version_check(self) -> None:
        service = self.make_service()

        with self.assertRaisesRegex(ValueError, "YouTubeのURL"):
            service.search("https://example.com/video")

        self.assertIsNone(service._latest_cache)

    def test_empty_search_results_are_successful(self) -> None:
        service = self.make_service(
            command_runner=self.make_command_runner(search_payload={"entries": []}),
        )

        result = service.search("存在しない検索語")

        self.assertEqual(result["items"], [])
        self.assertIsNone(service._latest_cache)

    def test_search_failure_runs_version_diagnostic(self) -> None:
        service = self.make_service(
            command_runner=self.make_command_runner(
                search_returncode=1,
                search_stderr="ERROR: extractor failed",
            ),
        )

        with self.assertRaises(SearchError) as raised:
            service.search("テスト")

        self.assertEqual(raised.exception.code, "search_failed")
        self.assertEqual(raised.exception.diagnostics["currentVersion"], "2026.8.19")
        self.assertEqual(raised.exception.diagnostics["latestVersion"], "2026.9.1")
        self.assertTrue(raised.exception.diagnostics["updateAvailable"])
        self.assertIn("更新すると", raised.exception.hint)

    def test_version_check_handles_network_failure_without_guessing(self) -> None:
        def failed_urlopen(*_args: object, **_kwargs: object) -> FakeResponse:
            raise OSError("offline")

        service = self.make_service(urlopen=failed_urlopen)

        status = service.check_version()

        self.assertFalse(status["checkedLatest"])
        self.assertIsNone(status["latestVersion"])
        self.assertIsNone(status["updateAvailable"])

    def test_only_remote_version_is_cached(self) -> None:
        current_version = ["2026.8.19"]
        pypi_calls = [0]

        def command_runner(args: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(args, 0, f"{current_version[0]}\n", "")

        def counting_urlopen(*_args: object, **_kwargs: object) -> FakeResponse:
            pypi_calls[0] += 1
            return FakeResponse({"info": {"version": "2026.9.1"}})

        service = self.make_service(
            command_runner=command_runner,
            urlopen=counting_urlopen,
        )
        first = service.check_version()
        current_version[0] = "2026.9.1"
        second = service.check_version()

        self.assertEqual(pypi_calls[0], 1)
        self.assertEqual(first["currentVersion"], "2026.8.19")
        self.assertEqual(second["currentVersion"], "2026.9.1")
        self.assertFalse(second["updateAvailable"])

    def test_failure_hint_does_not_recommend_update_when_current(self) -> None:
        service = self.make_service(
            command_runner=self.make_command_runner(
                search_returncode=1,
                search_stderr="ERROR: video unavailable",
            ),
            urlopen=equal_version_urlopen,
        )

        with self.assertRaises(SearchError) as raised:
            service.search("テスト")

        self.assertFalse(raised.exception.diagnostics["updateAvailable"])
        self.assertIn("最新安定版より古くありません", raised.exception.hint)
        self.assertNotIn("更新すると", raised.exception.hint)

    def test_missing_yt_dlp_is_reported_without_crashing(self) -> None:
        service = YtDlpService(auto_discover=False, urlopen=successful_urlopen)

        status = service.local_status()

        self.assertFalse(status["available"])
        self.assertIn("見つかりません", status["message"])


if __name__ == "__main__":
    unittest.main()
