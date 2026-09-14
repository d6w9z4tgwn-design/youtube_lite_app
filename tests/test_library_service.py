from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from library_service import LibraryService, UnknownLibraryItemError


CHANNEL_ONE = "UCabcdefghijklmnopqrstuv"
CHANNEL_TWO = "UCzyxwvutsrqponmlkjihgfe"


def video(
    video_id: str,
    title: str,
    *,
    channel_id: str = CHANNEL_ONE,
    channel: str = "チャンネルA",
    views: int = 100,
) -> dict:
    return {
        "id": video_id,
        "title": title,
        "channelId": channel_id,
        "channel": channel,
        "duration": 120,
        "viewCount": views,
        "isLive": False,
        "isUpcoming": False,
        "publishedAt": 1_725_000_000,
    }


class LibraryServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_directory.name) / "library.sqlite3"
        self.library = LibraryService(self.database_path)

    def tearDown(self) -> None:
        self.temp_directory.cleanup()

    def test_recommendations_offer_48_candidates(self) -> None:
        self.library.record_search("音楽", [video(f"{index:011d}", f"動画{index}") for index in range(60)])
        result = self.library.recommendations()
        self.assertEqual(result["count"], 48)
        self.assertEqual(len({item["id"] for item in result["items"]}), 48)

    def test_recent_search_interest_affects_ranking(self) -> None:
        self.library.record_search("古い関心", [video("aaaaaaaaaaa", "A")])
        self.library.record_search("新しい関心", [video("bbbbbbbbbbb", "B")])
        with self.library._connect() as connection:
            connection.execute("UPDATE search_events SET searched_at = searched_at - 20 * 86400 WHERE query = ?", ("古い関心",))
        self.assertEqual(self.library.recommendations()["items"][0]["id"], "bbbbbbbbbbb")

    def test_subscription_is_weaker_than_recent_interest(self) -> None:
        self.library.record_search("古い登録", [video("aaaaaaaaaaa", "登録")])
        self.library.set_subscription(CHANNEL_ONE, True)
        self.library.record_search("最近の関心", [video("bbbbbbbbbbb", "関心", channel_id=CHANNEL_TWO)])
        with self.library._connect() as connection:
            connection.execute("UPDATE search_events SET searched_at = searched_at - 20 * 86400 WHERE query = ?", ("古い登録",))
        self.assertEqual(self.library.recommendations()["items"][0]["id"], "bbbbbbbbbbb")

    def test_home_pagination_has_no_overlap_and_stops(self) -> None:
        self.library.record_search("候補", [video(f"{i:011d}", f"候補{i}", channel_id=CHANNEL_ONE if i % 2 else CHANNEL_TWO) for i in range(105)])
        pages = [self.library.home_payload(offset=offset) for offset in (0, 48, 96, 105)]
        self.assertEqual([page["count"] for page in pages], [48, 48, 9, 0])
        self.assertEqual([page["hasMore"] for page in pages], [True, True, False, False])
        self.assertEqual([page["nextOffset"] for page in pages], [48, 96, 105, 105])
        self.assertEqual(len({item["id"] for page in pages for item in page["items"]}), 105)

    def test_recommendation_preferences_persist_and_validate(self) -> None:
        self.assertEqual(self.library.recommendation_preferences()["region"], "")
        self.library.set_recommendation_preferences("JP", "ja")
        self.assertEqual(LibraryService(self.database_path).recommendation_preferences()["region"], "JP")
        for region, language in [("XX", "ja"), ("JP", "xxx"), ([], "ja"), (None, None)]:
            with self.assertRaises(ValueError):
                self.library.set_recommendation_preferences(region, language)

    def test_regional_candidates_rank_without_polluting_search_history(self) -> None:
        self.library.record_search("料理", [video("abcdefghijk", "地域候補"), video("lmnopqrstuv", "通常候補")])
        preferences = self.library.set_recommendation_preferences("JP", "ja")
        self.assertEqual(self.library.regional_search()[0], "料理 日本 日本語")
        before = self.library.home_payload()["signals"]
        self.library.record_regional_candidates([video("abcdefghijk", "地域候補")], preferences)
        home = self.library.home_payload()
        self.assertEqual(home["signals"], before)
        self.assertEqual(home["items"][0]["id"], "abcdefghijk")
        self.assertTrue(home["items"][0]["regionalCandidate"])
        self.library.set_recommendation_preferences("US", "en")
        self.assertFalse(any(item["regionalCandidate"] for item in self.library.home_payload()["items"]))
        self.library.set_recommendation_preferences("", "")
        with self.assertRaises(ValueError):
            self.library.regional_search()

    def test_expired_region_boost_and_watched_penalty(self) -> None:
        self.library.record_search("音楽", [video("abcdefghijk", "A"), video("lmnopqrstuv", "B")])
        prefs = self.library.set_recommendation_preferences("JP", "ja")
        self.library.record_regional_candidates([video("abcdefghijk", "A")], prefs)
        self.library.record_open("abcdefghijk")
        self.assertEqual(self.library.home_payload()["items"][0]["id"], "lmnopqrstuv")
        with self.library._connect() as connection:
            connection.execute("UPDATE regional_candidates SET fetched_at = 1")
        self.assertFalse(any(item["regionalCandidate"] for item in self.library.home_payload()["items"]))

    def test_regional_search_skips_video_urls(self) -> None:
        self.library.set_recommendation_preferences("JP", "ja")
        self.library.record_search("https://www.youtube.com/watch?v=abcdefghijk", [])
        self.assertEqual(self.library.regional_search()[0], "日本 日本語")

    def test_search_is_persisted_and_service_can_reopen_database(self) -> None:
        self.library.record_search(
            "Python",
            [video("abcdefghijk", "入門"), video("lmnopqrstuv", "応用")],
        )

        reopened = LibraryService(self.database_path)
        home = reopened.home_payload()

        self.assertEqual(home["count"], 2)
        self.assertEqual({item["id"] for item in home["items"]}, {"abcdefghijk", "lmnopqrstuv"})

    def test_watch_history_updates_count_and_improves_related_candidate(self) -> None:
        self.library.record_search(
            "Python",
            [video("abcdefghijk", "入門"), video("lmnopqrstuv", "応用")],
        )

        first = self.library.record_open("abcdefghijk")
        second = self.library.record_open("abcdefghijk")
        home = self.library.home_payload()

        self.assertEqual(first["openCount"], 1)
        self.assertEqual(second["openCount"], 2)
        self.assertEqual(home["items"][0]["id"], "lmnopqrstuv")
        self.assertEqual(home["items"][0]["reason"], "最近見た動画に関連")

    def test_subscription_is_idempotent_and_uses_channel_id(self) -> None:
        self.library.record_search(
            "音楽",
            [
                video("abcdefghijk", "A", channel_id=CHANNEL_ONE, channel="同じ名前"),
                video("lmnopqrstuv", "B", channel_id=CHANNEL_TWO, channel="同じ名前"),
            ],
        )

        self.library.set_subscription(CHANNEL_ONE, True)
        self.library.set_subscription(CHANNEL_ONE, True)

        self.assertEqual(self.library.subscription_count(), 1)
        self.assertEqual(self.library.list_subscriptions()[0]["channelId"], CHANNEL_ONE)

    def test_channel_refresh_populates_feed_and_clear_preserves_subscription(self) -> None:
        self.library.record_search("音楽", [video("abcdefghijk", "最初")])
        self.library.set_subscription(CHANNEL_ONE, True)
        self.library.record_open("abcdefghijk")
        self.library.record_channel_videos(
            CHANNEL_ONE,
            "チャンネルA",
            [video("lmnopqrstuv", "新着")],
        )

        feed = self.library.subscriptions_payload()
        cleared = self.library.clear_history()

        self.assertEqual(feed["channelCount"], 1)
        self.assertIn("lmnopqrstuv", {item["id"] for item in feed["items"]})
        self.assertEqual(cleared["watchEvents"], 1)
        self.assertEqual(self.library.history_payload()["count"], 0)
        self.assertEqual(self.library.subscription_count(), 1)

    def test_channel_overview_and_next_candidates_use_local_library(self) -> None:
        self.library.record_search(
            "音楽",
            [
                video("abcdefghijk", "再生中"),
                video("lmnopqrstuv", "同じ検索・同じチャンネル"),
                video("zzzzzzzzzzz", "同じ検索・別チャンネル", channel_id=CHANNEL_TWO),
            ],
        )
        self.library.record_search(
            "別の検索",
            [video("yyyyyyyyyyy", "別候補", channel_id=CHANNEL_TWO)],
        )
        self.library.record_open("abcdefghijk")

        channel = self.library.channel_payload(CHANNEL_ONE)
        self.assertEqual(self.library.next_candidates('abcdefghijk'), [])
        self.library.record_related_candidates('abcdefghijk', [video('zzzzzzzzzzz', '同じ検索・別チャンネル', channel_id=CHANNEL_TWO), video('lmnopqrstuv', '同じ検索・同じチャンネル')])
        candidates = self.library.next_candidates("abcdefghijk")

        self.assertEqual(channel["channel"], "チャンネルA")
        self.assertEqual(channel["videoCount"], 2)
        self.assertEqual(channel["watchedCount"], 1)
        self.assertEqual(candidates[0]["id"], "zzzzzzzzzzz")
        self.assertEqual(candidates[0]["reason"], "再生中の動画の関連候補")
        self.assertEqual(candidates[1]["id"], "lmnopqrstuv")
        self.assertNotIn('yyyyyyyyyyy', {item['id'] for item in candidates})
        self.library.set_subscription(CHANNEL_ONE, True)
        self.assertEqual(self.library.next_candidates('abcdefghijk')[0]['id'], 'zzzzzzzzzzz')
        self.library.record_related_candidates('abcdefghijk', [])
        self.assertEqual(self.library.next_candidates('abcdefghijk'), [])

    def test_unknown_and_invalid_ids_are_rejected(self) -> None:
        with self.assertRaises(UnknownLibraryItemError):
            self.library.record_open("zzzzzzzzzzz")
        with self.assertRaisesRegex(ValueError, "チャンネルID"):
            self.library.set_subscription("../invalid", True)

    def test_recommendations_limit_same_channel_before_filling(self) -> None:
        self.library.record_search(
            "mix",
            [
                video("aaaaaaaaaaa", "A1", channel_id=CHANNEL_ONE),
                video("bbbbbbbbbbb", "A2", channel_id=CHANNEL_ONE),
                video("ccccccccccc", "A3", channel_id=CHANNEL_ONE),
                video("ddddddddddd", "B1", channel_id=CHANNEL_TWO, channel="B"),
            ],
        )

        items = self.library.recommendations(limit=3)["items"]

        self.assertEqual(len(items), 3)
        self.assertEqual(sum(item["channelId"] == CHANNEL_ONE for item in items), 2)
        self.assertEqual(sum(item["channelId"] == CHANNEL_TWO for item in items), 1)


if __name__ == "__main__":
    unittest.main()
