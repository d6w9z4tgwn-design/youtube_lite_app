#!/usr/bin/env python3

"""ClipNest内だけで使う履歴・登録チャンネル・おすすめの保存処理。"""

from __future__ import annotations

import math
import os
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator


VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
CHANNEL_ID_PATTERN = re.compile(r"^UC[A-Za-z0-9_-]{22}$")
MAX_TITLE_LENGTH = 500
MAX_CHANNEL_TITLE_LENGTH = 200
MAX_QUERY_LENGTH = 200
REGIONS = {"": "指定なし", "JP": "日本", "US": "United States", "GB": "United Kingdom", "KR": "한국", "TW": "台灣", "DE": "Deutschland", "FR": "France", "IN": "India", "BR": "Brasil"}
LANGUAGES = {"": "指定なし", "ja": "日本語", "en": "English", "ko": "한국어", "zh": "中文", "de": "Deutsch", "fr": "Français", "hi": "हिन्दी", "pt": "Português"}


class UnknownLibraryItemError(LookupError):
    """まだClipNestへ保存されていない動画またはチャンネル。"""


def _clean_text(value: Any, *, fallback: str, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return (text or fallback)[:limit]


def _optional_non_negative_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if number >= 0 else None


class LibraryService:
    """SQLiteへ端末内ライブラリを保存し、独自のおすすめを組み立てる。"""

    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._write_lock = threading.RLock()
        self._initialize()
        if os.name != "nt":
            try:
                self.database_path.chmod(0o600)
            except OSError:
                pass

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database_path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._write_lock, self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS channels (
                    channel_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    feed_refreshed_at INTEGER
                );

                CREATE TABLE IF NOT EXISTS videos (
                    video_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    channel_id TEXT REFERENCES channels(channel_id),
                    channel_title TEXT NOT NULL,
                    duration INTEGER,
                    view_count INTEGER,
                    is_live INTEGER NOT NULL DEFAULT 0,
                    is_upcoming INTEGER NOT NULL DEFAULT 0,
                    published_at INTEGER,
                    first_seen_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS search_events (
                    event_id INTEGER PRIMARY KEY,
                    query TEXT NOT NULL,
                    searched_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS video_queries (
                    video_id TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
                    query TEXT NOT NULL,
                    last_seen_at INTEGER NOT NULL,
                    PRIMARY KEY (video_id, query)
                );

                CREATE TABLE IF NOT EXISTS watch_history (
                    video_id TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
                    first_opened_at INTEGER NOT NULL,
                    last_opened_at INTEGER NOT NULL,
                    open_count INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS related_links (
                    source_id TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
                    target_id TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
                    position INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (source_id, target_id)
                );

                CREATE TABLE IF NOT EXISTS subscriptions (
                    channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS recommendation_preferences (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    region TEXT NOT NULL, language TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS regional_candidates (
                    video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
                    region TEXT NOT NULL, language TEXT NOT NULL,
                    fetched_at INTEGER NOT NULL,
                    PRIMARY KEY(video_id, region, language)
                );

                CREATE INDEX IF NOT EXISTS idx_videos_channel_id
                    ON videos(channel_id);
                CREATE INDEX IF NOT EXISTS idx_videos_last_seen_at
                    ON videos(last_seen_at DESC);
                CREATE INDEX IF NOT EXISTS idx_watch_history_last_opened_at
                    ON watch_history(last_opened_at DESC);
                CREATE INDEX IF NOT EXISTS idx_video_queries_query
                    ON video_queries(query);
                """
            )
            connection.execute("PRAGMA user_version = 1")
            connection.execute("PRAGMA optimize")

    def _normalise_video(self, item: dict[str, Any]) -> dict[str, Any] | None:
        video_id = str(item.get("id") or "")
        if VIDEO_ID_PATTERN.fullmatch(video_id) is None:
            return None

        raw_channel_id = str(item.get("channelId") or "")
        channel_id = (
            raw_channel_id
            if CHANNEL_ID_PATTERN.fullmatch(raw_channel_id) is not None
            else None
        )
        return {
            "id": video_id,
            "title": _clean_text(
                item.get("title"), fallback="タイトル不明", limit=MAX_TITLE_LENGTH
            ),
            "channelId": channel_id,
            "channel": _clean_text(
                item.get("channel"),
                fallback="チャンネル不明",
                limit=MAX_CHANNEL_TITLE_LENGTH,
            ),
            "duration": _optional_non_negative_int(item.get("duration")),
            "viewCount": _optional_non_negative_int(item.get("viewCount")),
            "isLive": bool(item.get("isLive")),
            "isUpcoming": bool(item.get("isUpcoming")),
            "publishedAt": _optional_non_negative_int(item.get("publishedAt")),
        }

    def _upsert_videos(
        self,
        connection: sqlite3.Connection,
        items: Iterable[dict[str, Any]],
        *,
        seen_at: int,
        query: str | None = None,
        fallback_channel_id: str | None = None,
        fallback_channel_title: str | None = None,
    ) -> int:
        saved = 0
        for raw_item in items:
            if not isinstance(raw_item, dict):
                continue
            item = self._normalise_video(raw_item)
            if item is None:
                continue

            channel_id = item["channelId"] or fallback_channel_id
            channel_title = (
                item["channel"]
                if item["channel"] != "チャンネル不明"
                else fallback_channel_title or item["channel"]
            )
            if channel_id and CHANNEL_ID_PATTERN.fullmatch(channel_id):
                connection.execute(
                    """
                    INSERT INTO channels(channel_id, title, created_at, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(channel_id) DO UPDATE SET
                        title = excluded.title,
                        updated_at = excluded.updated_at
                    """,
                    (channel_id, channel_title, seen_at, seen_at),
                )
            else:
                channel_id = None

            connection.execute(
                """
                INSERT INTO videos(
                    video_id, title, channel_id, channel_title, duration,
                    view_count, is_live, is_upcoming, published_at,
                    first_seen_at, last_seen_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(video_id) DO UPDATE SET
                    title = excluded.title,
                    channel_id = COALESCE(excluded.channel_id, videos.channel_id),
                    channel_title = CASE
                        WHEN excluded.channel_title = 'チャンネル不明'
                            THEN videos.channel_title
                        ELSE excluded.channel_title
                    END,
                    duration = COALESCE(excluded.duration, videos.duration),
                    view_count = COALESCE(excluded.view_count, videos.view_count),
                    is_live = excluded.is_live,
                    is_upcoming = excluded.is_upcoming,
                    published_at = COALESCE(excluded.published_at, videos.published_at),
                    last_seen_at = excluded.last_seen_at
                """,
                (
                    item["id"],
                    item["title"],
                    channel_id,
                    channel_title,
                    item["duration"],
                    item["viewCount"],
                    int(item["isLive"]),
                    int(item["isUpcoming"]),
                    item["publishedAt"],
                    seen_at,
                    seen_at,
                ),
            )
            if query:
                connection.execute(
                    """
                    INSERT INTO video_queries(video_id, query, last_seen_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(video_id, query) DO UPDATE SET
                        last_seen_at = excluded.last_seen_at
                    """,
                    (item["id"], query, seen_at),
                )
            saved += 1
        return saved

    def search_suggestions(self, prefix: str, *, limit: int = 8) -> list[str]:
        """入力中の文字列に一致するローカル検索候補を返す。

        検索履歴と、過去の検索で動画に紐づいた検索語を候補元として使う。
        同じ候補はまとめ、検索回数・最近使った時刻を優先して並べる。
        """

        prefix = " ".join(str(prefix or "").split())[:MAX_QUERY_LENGTH]
        if not prefix:
            return []

        try:
            limit = int(limit)
        except (TypeError, ValueError, OverflowError):
            limit = 8
        limit = max(1, min(limit, 20))

        escaped = (
            prefix.replace("\\", "\\\\")
            .replace("%", "\\%")
            .replace("_", "\\_")
        )
        pattern = escaped + "%"

        with self._connect() as connection:
            rows = connection.execute(
                """
                WITH candidates AS (
                    SELECT
                        query,
                        COUNT(*) AS search_count,
                        MAX(searched_at) AS last_used_at
                    FROM search_events
                    WHERE query LIKE ? ESCAPE '\\' COLLATE NOCASE
                    GROUP BY query

                    UNION ALL

                    SELECT
                        query,
                        0 AS search_count,
                        MAX(last_seen_at) AS last_used_at
                    FROM video_queries
                    WHERE query LIKE ? ESCAPE '\\' COLLATE NOCASE
                    GROUP BY query
                ),
                merged AS (
                    SELECT
                        query,
                        SUM(search_count) AS search_count,
                        MAX(last_used_at) AS last_used_at
                    FROM candidates
                    GROUP BY query COLLATE NOCASE
                )
                SELECT query
                FROM merged
                ORDER BY
                    search_count DESC,
                    last_used_at DESC,
                    LENGTH(query) ASC,
                    query COLLATE NOCASE ASC
                LIMIT ?
                """,
                (pattern, pattern, limit),
            ).fetchall()

        return [str(row["query"]) for row in rows]

    def record_search(self, query: str, items: Iterable[dict[str, Any]]) -> int:
        query = " ".join(query.split())[:MAX_QUERY_LENGTH]
        if not query:
            return 0
        now = int(time.time())
        with self._write_lock, self._connect() as connection:
            saved = self._upsert_videos(connection, items, seen_at=now, query=query)
            connection.execute(
                "INSERT INTO search_events(query, searched_at) VALUES (?, ?)",
                (query, now),
            )
            connection.execute(
                """
                DELETE FROM search_events
                WHERE event_id NOT IN (
                    SELECT event_id FROM search_events
                    ORDER BY searched_at DESC, event_id DESC LIMIT 500
                )
                """
            )
        return saved

    def record_channel_videos(
        self,
        channel_id: str,
        channel_title: str,
        items: Iterable[dict[str, Any]],
    ) -> int:
        if CHANNEL_ID_PATTERN.fullmatch(channel_id) is None:
            raise ValueError("チャンネルIDの形式が正しくありません。")
        channel_title = _clean_text(
            channel_title,
            fallback="チャンネル不明",
            limit=MAX_CHANNEL_TITLE_LENGTH,
        )
        now = int(time.time())
        with self._write_lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO channels(channel_id, title, created_at, updated_at, feed_refreshed_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(channel_id) DO UPDATE SET
                    title = excluded.title,
                    updated_at = excluded.updated_at,
                    feed_refreshed_at = excluded.feed_refreshed_at
                """,
                (channel_id, channel_title, now, now, now),
            )
            return self._upsert_videos(
                connection,
                items,
                seen_at=now,
                fallback_channel_id=channel_id,
                fallback_channel_title=channel_title,
            )

    @staticmethod
    def _row_to_video(row: sqlite3.Row) -> dict[str, Any]:
        video_id = row["video_id"]
        item: dict[str, Any] = {
            "id": video_id,
            "title": row["title"],
            "channelId": row["channel_id"],
            "channel": row["channel_title"],
            "duration": row["duration"],
            "viewCount": row["view_count"],
            "isLive": bool(row["is_live"]),
            "isUpcoming": bool(row["is_upcoming"]),
            "publishedAt": row["published_at"],
            "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "isSubscribed": bool(row["is_subscribed"]),
        }
        if "last_opened_at" in row.keys():
            item["lastOpenedAt"] = row["last_opened_at"]
            item["openCount"] = row["open_count"]
        return item

    def annotate_items(self, items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
        copied = [dict(item) for item in items if isinstance(item, dict)]
        channel_ids = {
            str(item.get("channelId"))
            for item in copied
            if CHANNEL_ID_PATTERN.fullmatch(str(item.get("channelId") or ""))
        }
        subscribed: set[str] = set()
        if channel_ids:
            placeholders = ",".join("?" for _ in channel_ids)
            with self._connect() as connection:
                rows = connection.execute(
                    f"SELECT channel_id FROM subscriptions WHERE channel_id IN ({placeholders})",
                    tuple(channel_ids),
                ).fetchall()
            subscribed = {row["channel_id"] for row in rows}
        for item in copied:
            item["isSubscribed"] = item.get("channelId") in subscribed
        return copied

    def record_open(self, video_id: str) -> dict[str, Any]:
        if VIDEO_ID_PATTERN.fullmatch(video_id) is None:
            raise ValueError("動画IDの形式が正しくありません。")
        now = int(time.time())
        with self._write_lock, self._connect() as connection:
            known = connection.execute(
                "SELECT 1 FROM videos WHERE video_id = ?", (video_id,)
            ).fetchone()
            if known is None:
                raise UnknownLibraryItemError("動画がライブラリにありません。")
            connection.execute(
                """
                INSERT INTO watch_history(
                    video_id, first_opened_at, last_opened_at, open_count
                ) VALUES (?, ?, ?, 1)
                ON CONFLICT(video_id) DO UPDATE SET
                    last_opened_at = excluded.last_opened_at,
                    open_count = watch_history.open_count + 1
                """,
                (video_id, now, now),
            )
            connection.execute(
                """
                DELETE FROM watch_history
                WHERE video_id NOT IN (
                    SELECT video_id FROM watch_history
                    ORDER BY last_opened_at DESC LIMIT 500
                )
                """
            )
            row = connection.execute(
                "SELECT last_opened_at, open_count FROM watch_history WHERE video_id = ?",
                (video_id,),
            ).fetchone()
        return {"videoId": video_id, "lastOpenedAt": row[0], "openCount": row[1]}

    def set_subscription(self, channel_id: str, subscribed: bool) -> dict[str, Any]:
        if CHANNEL_ID_PATTERN.fullmatch(channel_id) is None:
            raise ValueError("チャンネルIDの形式が正しくありません。")
        now = int(time.time())
        with self._write_lock, self._connect() as connection:
            channel = connection.execute(
                "SELECT title FROM channels WHERE channel_id = ?", (channel_id,)
            ).fetchone()
            if channel is None:
                raise UnknownLibraryItemError("チャンネルがライブラリにありません。")
            if subscribed:
                connection.execute(
                    "INSERT OR IGNORE INTO subscriptions(channel_id, created_at) VALUES (?, ?)",
                    (channel_id, now),
                )
            else:
                connection.execute(
                    "DELETE FROM subscriptions WHERE channel_id = ?", (channel_id,)
                )
        return {
            "channelId": channel_id,
            "channel": channel["title"],
            "subscribed": subscribed,
            "subscriptionCount": self.subscription_count(),
        }

    def subscription_count(self) -> int:
        with self._connect() as connection:
            return int(connection.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0])

    def list_subscriptions(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT c.channel_id, c.title, s.created_at, c.feed_refreshed_at,
                       COUNT(v.video_id) AS video_count
                FROM subscriptions AS s
                JOIN channels AS c ON c.channel_id = s.channel_id
                LEFT JOIN videos AS v ON v.channel_id = c.channel_id
                GROUP BY c.channel_id, c.title, s.created_at, c.feed_refreshed_at
                ORDER BY c.title COLLATE NOCASE
                """
            ).fetchall()
        return [
            {
                "channelId": row["channel_id"],
                "channel": row["title"],
                "createdAt": row["created_at"],
                "feedRefreshedAt": row["feed_refreshed_at"],
                "videoCount": row["video_count"],
            }
            for row in rows
        ]

    def channels_to_refresh(self, *, limit: int = 4) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 8))
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT c.channel_id, c.title
                FROM subscriptions AS s
                JOIN channels AS c ON c.channel_id = s.channel_id
                ORDER BY c.feed_refreshed_at IS NOT NULL,
                         c.feed_refreshed_at ASC,
                         s.created_at ASC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [
            {"channelId": row["channel_id"], "channel": row["title"]}
            for row in rows
        ]

    def _base_video_query(self) -> str:
        return """
            SELECT v.*,
                   EXISTS(
                       SELECT 1 FROM subscriptions AS s
                       WHERE s.channel_id = v.channel_id
                   ) AS is_subscribed,
                   h.last_opened_at,
                   h.open_count
            FROM videos AS v
            LEFT JOIN watch_history AS h ON h.video_id = v.video_id
        """

    def channel_payload(
        self,
        channel_id: str,
        *,
        limit: int = 24,
    ) -> dict[str, Any]:
        """保存済みのチャンネル概要と動画を返す。"""

        if CHANNEL_ID_PATTERN.fullmatch(channel_id) is None:
            raise ValueError("チャンネルIDの形式が正しくありません。")
        limit = max(1, min(limit, 48))
        with self._connect() as connection:
            channel = connection.execute(
                """
                SELECT c.channel_id, c.title, c.created_at, c.updated_at,
                       c.feed_refreshed_at,
                       EXISTS(
                           SELECT 1 FROM subscriptions AS s
                           WHERE s.channel_id = c.channel_id
                       ) AS is_subscribed,
                       COUNT(DISTINCT v.video_id) AS video_count,
                       COUNT(DISTINCT h.video_id) AS watched_count
                FROM channels AS c
                LEFT JOIN videos AS v ON v.channel_id = c.channel_id
                LEFT JOIN watch_history AS h ON h.video_id = v.video_id
                WHERE c.channel_id = ?
                GROUP BY c.channel_id, c.title, c.created_at, c.updated_at,
                         c.feed_refreshed_at
                """,
                (channel_id,),
            ).fetchone()
            if channel is None:
                raise UnknownLibraryItemError("チャンネルがライブラリにありません。")

            rows = connection.execute(
                self._base_video_query()
                + """
                  WHERE v.channel_id = ?
                  ORDER BY COALESCE(v.published_at, v.last_seen_at) DESC,
                           v.last_seen_at DESC
                  LIMIT ?
                  """,
                (channel_id, limit),
            ).fetchall()

        items = [self._row_to_video(row) for row in rows]
        return {
            "channelId": channel["channel_id"],
            "channel": channel["title"],
            "isSubscribed": bool(channel["is_subscribed"]),
            "videoCount": int(channel["video_count"]),
            "watchedCount": int(channel["watched_count"]),
            "createdAt": channel["created_at"],
            "updatedAt": channel["updated_at"],
            "feedRefreshedAt": channel["feed_refreshed_at"],
            "url": f"https://www.youtube.com/channel/{channel_id}",
            "count": len(items),
            "items": items,
        }

    def record_related_candidates(self, video_id, items):
        if not isinstance(video_id, str) or not VIDEO_ID_PATTERN.fullmatch(video_id):
            raise ValueError("動画IDが不正です。")
        unique = {}
        for raw in items:
            item = self._normalise_video(raw) if isinstance(raw, dict) else None
            if item and item["id"] != video_id:
                unique.setdefault(item["id"], item)
        with self._write_lock, self._connect() as connection:
            if not connection.execute("SELECT 1 FROM videos WHERE video_id = ?", (video_id,)).fetchone():
                raise UnknownLibraryItemError("動画がライブラリにありません。")
            now = int(time.time())
            self._upsert_videos(connection, unique.values(), seen_at=now)
            connection.execute("DELETE FROM related_links WHERE source_id = ?", (video_id,))
            for position, target in enumerate(unique):
                connection.execute("INSERT INTO related_links VALUES (?, ?, ?, ?)", (video_id, target, position, now))
            connection.execute("DELETE FROM related_links WHERE updated_at < ?", (now - 7 * 86400,))

    def next_candidates(self, video_id: str, *, limit: int = 12) -> list[dict[str, Any]]:
        """Only explicitly fetched watch-page relations; no channel/search fallback."""
        if not isinstance(video_id, str) or not VIDEO_ID_PATTERN.fullmatch(video_id):
            raise ValueError("動画IDの形式が正しくありません。")
        with self._connect() as connection:
            if not connection.execute("SELECT 1 FROM videos WHERE video_id = ?", (video_id,)).fetchone():
                raise UnknownLibraryItemError("動画がライブラリにありません。")
            rows = connection.execute(self._base_video_query() + """
                JOIN related_links r ON r.target_id = v.video_id
                WHERE r.source_id = ? AND r.updated_at >= ?
                ORDER BY r.position LIMIT ?
            """, (video_id, int(time.time()) - 7 * 86400, max(1, min(limit, 24)))).fetchall()
        return [{**self._row_to_video(row), "reason": "再生中の動画の関連候補"} for row in rows]

    def next_payload(self, video_id: str, *, limit: int = 12) -> dict[str, Any]:
        items = self.next_candidates(video_id, limit=limit)
        return {"videoId": video_id, "items": items, "count": len(items), "source": "youtube-watch-related"}

    def subscription_feed(self, *, limit: int = 48) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 100))
        with self._connect() as connection:
            rows = connection.execute(
                self._base_video_query()
                + """
                  WHERE v.channel_id IN (SELECT channel_id FROM subscriptions)
                  ORDER BY COALESCE(v.published_at, v.last_seen_at) DESC,
                           v.last_seen_at DESC
                  LIMIT ?
                  """,
                (limit,),
            ).fetchall()
        items = [self._row_to_video(row) for row in rows]
        for item in items:
            item["reason"] = "登録チャンネルの動画"
        return items

    def history(self, *, limit: int = 60) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 100))
        with self._connect() as connection:
            rows = connection.execute(
                self._base_video_query()
                + """
                  WHERE h.video_id IS NOT NULL
                  ORDER BY h.last_opened_at DESC
                  LIMIT ?
                  """,
                (limit,),
            ).fetchall()
        return [self._row_to_video(row) for row in rows]

    def clear_history(self) -> dict[str, int]:
        """視聴履歴と検索由来の嗜好シグナルを消去する。"""

        with self._write_lock, self._connect() as connection:
            watch_count = int(connection.execute("SELECT COUNT(*) FROM watch_history").fetchone()[0])
            search_count = int(connection.execute("SELECT COUNT(*) FROM search_events").fetchone()[0])
            connection.execute("DELETE FROM watch_history")
            connection.execute("DELETE FROM video_queries")
            connection.execute("DELETE FROM search_events")
        return {"watchEvents": watch_count, "searchEvents": search_count}

    def recommendation_preferences(self) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT region, language FROM recommendation_preferences WHERE id = 1").fetchone()
        return {"region": row["region"] if row else "", "language": row["language"] if row else "",
                "regions": REGIONS, "languages": LANGUAGES}

    def set_recommendation_preferences(self, region: str, language: str) -> dict[str, Any]:
        if not isinstance(region, str) or region not in REGIONS or not isinstance(language, str) or language not in LANGUAGES:
            raise ValueError("対応する地域・言語を選択してください。")
        with self._write_lock, self._connect() as connection:
            connection.execute("INSERT INTO recommendation_preferences VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET region=excluded.region, language=excluded.language", (region, language))
        return self.recommendation_preferences()

    def regional_search(self) -> tuple[str, dict[str, Any]]:
        preferences = self.recommendation_preferences()
        if not preferences["region"] and not preferences["language"]:
            raise ValueError("候補の補充には地域または言語を選択してください。")
        with self._connect() as connection:
            queries = connection.execute("SELECT query FROM search_events ORDER BY searched_at DESC, event_id DESC LIMIT 30").fetchall()
        topic = next((row["query"] for row in queries if not re.match(r"(?i)https?://", row["query"])), "")
        # Search hints, not geolocation or a claim about a video's country/language.
        hints = [REGIONS[preferences["region"]] if preferences["region"] else "",
                 LANGUAGES[preferences["language"]] if preferences["language"] else ""]
        return " ".join(part for part in [topic[:140], *hints] if part), preferences

    def record_regional_candidates(self, items: Iterable[dict[str, Any]], preferences: dict[str, Any]) -> int:
        items = list(items)
        now = int(time.time())
        with self._write_lock, self._connect() as connection:
            saved = self._upsert_videos(connection, items, seen_at=now)
            for raw in items:
                item = self._normalise_video(raw) if isinstance(raw, dict) else None
                if item:
                    connection.execute("INSERT INTO regional_candidates VALUES (?, ?, ?, ?) ON CONFLICT(video_id, region, language) DO UPDATE SET fetched_at=excluded.fetched_at", (item["id"], preferences["region"], preferences["language"], now))
            connection.execute("DELETE FROM regional_candidates WHERE fetched_at < ?", (now - 30 * 86400,))
        return saved

    def recommendations(self, *, limit: int = 48, offset: int = 0) -> dict[str, Any]:
        limit = max(1, min(limit, 48))
        offset = max(0, min(offset, 1200))
        now = int(time.time())
        preferences = self.recommendation_preferences()
        with self._connect() as connection:
            regional_ids = {row["video_id"] for row in connection.execute(
                "SELECT video_id FROM regional_candidates WHERE region = ? AND language = ? AND fetched_at >= ?",
                (preferences["region"], preferences["language"], now - 7 * 86400),
            )} if preferences["region"] or preferences["language"] else set()
            rows = connection.execute(
                self._base_video_query()
                + " ORDER BY v.last_seen_at DESC LIMIT 1200"
            ).fetchall()
            affinity_rows = connection.execute(
                """
                SELECT v.channel_id, SUM(MIN(h.open_count, 10) *
                    CASE WHEN h.last_opened_at >= strftime('%s','now') - 2592000 THEN 1.0 ELSE 0.25 END) AS weight
                FROM watch_history AS h
                JOIN videos AS v ON v.video_id = h.video_id
                WHERE v.channel_id IS NOT NULL
                GROUP BY v.channel_id
                """
            ).fetchall()
            recent_queries = connection.execute("""
                SELECT vq.video_id, MAX(se.searched_at) AS latest
                FROM video_queries vq JOIN search_events se ON se.query = vq.query
                WHERE se.searched_at >= ? GROUP BY vq.video_id
            """, (now - 14 * 86400,)).fetchall()
            query_rows = connection.execute(
                """
                SELECT candidate.video_id, COUNT(*) AS weight
                FROM video_queries AS watched_query
                JOIN watch_history AS h ON h.video_id = watched_query.video_id
                JOIN video_queries AS candidate
                    ON candidate.query = watched_query.query
                   AND candidate.video_id != watched_query.video_id
                GROUP BY candidate.video_id
                """
            ).fetchall()
            signal_counts = connection.execute(
                """
                SELECT
                    (SELECT COUNT(*) FROM watch_history) AS watches,
                    (SELECT COUNT(*) FROM subscriptions) AS subscriptions,
                    (SELECT COUNT(*) FROM search_events) AS searches
                """
            ).fetchone()

        channel_affinity = {
            row["channel_id"]: float(row["weight"] or 0) for row in affinity_rows
        }
        query_affinity = {
            row["video_id"]: int(row["weight"] or 0) for row in query_rows
        }
        ranked: list[tuple[float, dict[str, Any]]] = []
        recent_interest = {row["video_id"]: max(0.0, 18.0 * (1 - (now - row["latest"]) / (14 * 86400))) for row in recent_queries}
        for row in rows:
            item = self._row_to_video(row)
            watched = row["last_opened_at"] is not None
            subscribed = bool(row["is_subscribed"])
            channel_weight = channel_affinity.get(row["channel_id"], 0)
            query_weight = query_affinity.get(row["video_id"], 0)
            regional = row["video_id"] in regional_ids

            age_days = max(0.0, (now - int(row["last_seen_at"])) / 86400)
            seen_recency = max(0.0, 14.0 - age_days)
            published_recency = 0.0
            if row["published_at"]:
                published_age_days = max(0.0, (now - int(row["published_at"])) / 86400)
                published_recency = max(0.0, 20.0 - published_age_days * 0.65)
            popularity = min(
                9.0,
                math.log10(max(0, int(row["view_count"] or 0)) + 1) * 1.4,
            )
            score = (
                (5.0 if subscribed else 0.0)
                + min(30.0, channel_weight * 6.0)
                + min(28.0, query_weight * 7.0)
                + seen_recency
                + published_recency
                + popularity
                + (18.0 if regional else 0.0)
                + recent_interest.get(row["video_id"], 0)
                - (85.0 if watched else 0.0)
                - int(row["open_count"] or 0) * 3.0
            )

            if query_weight:
                reason = "最近見た動画に関連"
            elif channel_weight:
                reason = "よく見るチャンネルから"
            elif watched:
                reason = "もう一度見る"
            elif regional:
                reason = "地域・言語の検索候補から"
            elif subscribed:
                reason = "登録チャンネルから"
            else:
                reason = "最近の検索から"
            item["reason"] = reason
            item["regionalCandidate"] = regional
            ranked.append((score, item))

        ranked.sort(
            key=lambda pair: (
                pair[0],
                pair[1].get("publishedAt") or 0,
                pair[1]["id"],
            ),
            reverse=True,
        )

        selected: list[dict[str, Any]] = []
        deferred: list[dict[str, Any]] = []
        channel_counts: dict[str, int] = {}
        for _score, item in ranked:
            channel_key = item.get("channelId") or item["channel"]
            if channel_counts.get(channel_key, 0) >= 2:
                deferred.append(item)
                continue
            selected.append(item)
            channel_counts[channel_key] = channel_counts.get(channel_key, 0) + 1
        selected.extend(deferred)
        total = len(selected)
        selected = selected[offset:offset + limit]

        personalized = bool(signal_counts["watches"] or signal_counts["subscriptions"])
        return {
            "items": selected,
            "count": len(selected),
            "hasMore": offset + len(selected) < total,
            "nextOffset": offset + len(selected),
            "personalized": personalized,
            "preferences": preferences,
            "signals": {
                "watches": int(signal_counts["watches"]),
                "subscriptions": int(signal_counts["subscriptions"]),
                "searches": int(signal_counts["searches"]),
            },
        }

    def home_payload(self, *, offset: int = 0) -> dict[str, Any]:
        recommendations = self.recommendations(offset=offset)
        recommendations["subscriptionCount"] = self.subscription_count()
        return recommendations

    def history_payload(self) -> dict[str, Any]:
        items = self.history()
        return {
            "items": items,
            "count": len(items),
            "subscriptionCount": self.subscription_count(),
        }

    def subscriptions_payload(self) -> dict[str, Any]:
        channels = self.list_subscriptions()
        items = self.subscription_feed()
        return {
            "channels": channels,
            "channelCount": len(channels),
            "items": items,
            "count": len(items),
            "subscriptionCount": len(channels),
        }
