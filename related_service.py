"""Read anonymous watch-page related results, never a local subscription feed."""
import json
import re
import threading
import time
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def label(value):
    if not isinstance(value, dict):
        return ''
    return str(value.get('content') or value.get('simpleText') or ''.join(str(run.get('text', '')) for run in value.get('runs', []) if isinstance(run, dict)))[:500]


def related_items(initial, source_id, *, music_only=False):
    # Do not scan the entire response: end screens, ads and playlists are not
    # the watch-page related list.
    section = initial.get('contents', {}).get('twoColumnWatchNextResults', {}).get('secondaryResults', {})
    result, seen = [], {source_id}
    def renderers(value):
        if isinstance(value, dict):
            if any(key in value for key in ('adSlotRenderer', 'promotedSparklesWebRenderer', 'reelShelfRenderer', 'shelfRenderer')):
                return
            for key in ('lockupViewModel', 'compactVideoRenderer'):
                if key in value:
                    yield key, value[key]
                    return
            for child in value.values():
                yield from renderers(child)
        elif isinstance(value, list):
            for child in value:
                yield from renderers(child)
    for kind, item in renderers(section):
        if not isinstance(item, dict):
            continue
        video_id = item.get('contentId') if kind == 'lockupViewModel' else item.get('videoId')
        if not isinstance(video_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id) or video_id in seen:
            continue
        if kind == 'lockupViewModel':
            if item.get('contentType') not in (None, 'LOCKUP_CONTENT_TYPE_VIDEO'):
                continue
            metadata = item.get('metadata', {}).get('lockupMetadataViewModel', {})
            title = label(metadata.get('title'))
            rows = metadata.get('metadata', {}).get('contentMetadataViewModel', {}).get('metadataRows', [])
            parts = rows[0].get('metadataParts', []) if rows else []
            channel = label(parts[0].get('text')) if parts else ''
            badges = [str(node['thumbnailBadgeViewModel'].get('text', '')) for node in walk(item.get('contentImage', {})) if 'thumbnailBadgeViewModel' in node]
        else:
            metadata = item.get('shortBylineText', {})
            title, channel = label(item.get('title')), label(metadata)
            badges = [label(item.get('lengthText'))]
        if not title:
            continue
        if music_only and not any(node.get('imageName') == 'MUSIC' or node.get('iconType') == 'MUSIC' for node in walk(item.get('contentImage', item))):
            continue
        channel_id = next((node['browseId'] for node in walk(metadata) if isinstance(node.get('browseId'), str) and re.fullmatch(r'UC[A-Za-z0-9_-]{22}', node['browseId'])), None)
        duration = None
        for badge in badges:
            if re.fullmatch(r'\d{1,3}:\d{2}(?::\d{2})?', badge):
                duration = 0
                for part in badge.split(':'):
                    duration = duration * 60 + int(part)
                break
        seen.add(video_id)
        result.append({'id': video_id, 'title': title, 'channel': channel or 'チャンネル', 'channelId': channel_id,
            'duration': duration, 'viewCount': None, 'isLive': False, 'isUpcoming': False,
            'thumbnail': f'https://i.ytimg.com/vi/{video_id}/hqdefault.jpg',
            'url': f'https://www.youtube.com/watch?v={video_id}', 'reason': '再生中の動画の関連候補'})
        if len(result) >= 24:
            break
    return result


class RelatedService:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.cache, self.lock = {}, threading.Lock()

    def fetch(self, video_id, *, region='JP', language='ja', limit=12, fresh=False):
        if not isinstance(video_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
            raise ValueError('動画IDが不正です。')
        region = region if isinstance(region, str) and re.fullmatch(r'[A-Z]{2}', region) else 'JP'
        language = language if isinstance(language, str) and re.fullmatch(r'[a-z]{2}', language) else 'ja'
        key = (video_id, region, language)
        with self.lock:
            cached = self.cache.get(key)
            if not fresh and cached and cached[0] > time.monotonic():
                return [dict(item) for item in cached[1][:limit]]
        query = urllib.parse.urlencode({'v': video_id, 'hl': language, 'gl': region})
        request = urllib.request.Request('https://www.youtube.com/watch?' + query,
            headers={'User-Agent': 'Mozilla/5.0', 'Accept-Language': language})
        try:
            with self.opener.open(request, timeout=12) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError('response too large')
            html = raw.decode('utf-8')
            match = re.search(r'(?:var\s+ytInitialData\s*=|window\["ytInitialData"\]\s*=|ytInitialData\s*=)\s*', html)
            if not match:
                raise ValueError('watch data missing')
            initial = json.JSONDecoder().raw_decode(html[match.end():])[0]
            player_match = re.search(r'ytInitialPlayerResponse\s*=\s*', html)
            player = json.JSONDecoder().raw_decode(html[player_match.end():])[0] if player_match else {}
            category = player.get('microformat', {}).get('playerMicroformatRenderer', {}).get('category')
            items = related_items(initial, video_id, music_only=category in ('Music', '音楽'))
        except Exception as exc:
            raise RuntimeError('YouTubeの関連候補を取得できませんでした。時間を置いて再試行してください。登録チャンネル等での代替表示はしません。') from exc
        with self.lock:
            if len(self.cache) >= 64:
                self.cache.pop(next(iter(self.cache)))
            self.cache[key] = (time.monotonic() + (600 if items else 30), items)
        return [dict(item) for item in items[:limit]]
