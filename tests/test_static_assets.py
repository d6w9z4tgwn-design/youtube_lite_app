from __future__ import annotations

import re
import unittest
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path


STATIC_DIR = Path(__file__).resolve().parents[1] / "static"


class IdCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: list[str] = []

    def handle_starttag(self, _tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if attributes.get("id"):
            self.ids.append(attributes["id"] or "")


class StaticAssetsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        cls.javascript = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
        parser = IdCollector()
        parser.feed(cls.html)
        cls.ids = parser.ids

    def test_html_ids_are_unique(self) -> None:
        duplicates = [name for name, count in Counter(self.ids).items() if count > 1]
        self.assertEqual(duplicates, [])

    def test_javascript_id_selectors_exist_in_html(self) -> None:
        selectors = set(re.findall(r"\$\('#([A-Za-z0-9_-]+)'\)", self.javascript))
        self.assertEqual(selectors - set(self.ids), set())

    def test_ui_has_no_comment_or_rating_features(self) -> None:
        self.assertNotIn("コメント", self.html)
        self.assertNotIn("高評価", self.html)

    def test_ui_exposes_local_home_subscriptions_and_history(self) -> None:
        self.assertIn("あなたへのおすすめ", self.html)
        self.assertIn("登録チャンネル", self.html)
        self.assertIn("再生履歴", self.html)
        self.assertIn("視聴・検索の傾向を優先", self.html)
        self.assertIn("api('/api/home')", self.javascript)
        self.assertIn("api('/api/subscriptions/set'", self.javascript)
        self.assertIn("api('/api/history/open'", self.javascript)

    def test_dynamic_content_is_not_inserted_as_html(self) -> None:
        self.assertNotIn(".innerHTML", self.javascript)

    def test_player_uses_local_audio_proxy(self) -> None:
        self.assertIn('<audio id="audio"', self.html)
        self.assertIn(
            "`/api/media/${encodeURIComponent(video.id)}${query}`",
            self.javascript,
        )

    def test_channel_overview_and_next_candidates_are_exposed(self) -> None:
        self.assertIn('id="channelProfile"', self.html)
        self.assertIn('id="upNextDialog"', self.html)
        self.assertIn("api(`/api/channel?channelId=", self.javascript)
        self.assertIn("api(`/api/next?videoId=", self.javascript)
        self.assertIn("の概要を開く", self.javascript)

    def test_extended_player_modules_and_live_reconnect_are_present(self) -> None:
        module_names = {path.name for path in (STATIC_DIR / "modules").glob("*.js")}
        self.assertTrue(
            {"equalizer.js", "loudness-normalizer.js", "sleep-timer.js"}.issubset(
                module_names
            )
        )
        module_host = (STATIC_DIR / "core" / "module_host.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("effect.outputNode.disconnect()", module_host)
        self.assertIn("cursor.connect(effect.inputNode)", module_host)
        self.assertIn("this.lastVideoId", module_host)
        self.assertEqual(len(module_names), 11)
        self.assertTrue({"ab-loop.js", "audio-boost.js", "playback-queue.js", "voice-enhancer.js", "stereo-width.js", "smart-speed.js", "loudness-meter.js", "crossfeed.js"}.isdisjoint(module_names))
        self.assertIn('id="standardPlayerTools"', self.html)

    def test_long_media_recovery_controls_are_exposed(self) -> None:
        self.assertIn('id="playerStatus"', self.html)
        self.assertIn('id="reloadMedia"', self.html)
        self.assertIn("parameters.set('fresh', '1')", self.javascript)
        self.assertIn("parameters.set('attempt', String(state.mediaRetryCount))", self.javascript)
        self.assertIn("retryCurrentMedia", self.javascript)
        self.assertIn("長時間動画を準備中", self.javascript)


if __name__ == "__main__":
    unittest.main()
