import io
import json
import unittest
from unittest.mock import Mock
from related_service import RelatedService, related_items


def renderer(video_id, title='関連曲', music=False):
    return {'lockupViewModel': {'contentId': video_id, 'contentType': 'LOCKUP_CONTENT_TYPE_VIDEO',
        'metadata': {'lockupMetadataViewModel': {'title': {'content': title}}},
        'contentImage': {'thumbnailBadgeViewModel': {'text': '3:25'}, 'icon': {'imageName': 'MUSIC' if music else 'VIDEO'}}}}


def initial(entries):
    return {'contents': {'twoColumnWatchNextResults': {'secondaryResults': {'secondaryResults': {'results': entries}}}}}


class RelatedTests(unittest.TestCase):
    def test_only_related_section_and_no_duplicates_playlists_or_source(self):
        payload = initial([renderer('abcdefghijk'), renderer('lmnopqrstuv'), renderer('lmnopqrstuv'), renderer('RDabcdefghijk'), {'adSlotRenderer': renderer('zzzzzzzzzzz')}])
        payload['endScreen'] = renderer('yyyyyyyyyyy')
        result = related_items(payload, 'abcdefghijk')
        self.assertEqual([item['id'] for item in result], ['lmnopqrstuv'])
        self.assertEqual(result[0]['duration'], 205)

    def test_music_excludes_unmarked_talk_even_in_youtube_related(self):
        result = related_items(initial([renderer('lmnopqrstuv', music=True), renderer('zzzzzzzzzzz', title='ゲーム実況')]), 'abcdefghijk', music_only=True)
        self.assertEqual([item['id'] for item in result], ['lmnopqrstuv'])

    def test_old_compact_renderer(self):
        result = related_items(initial([{'compactVideoRenderer': {'videoId': 'lmnopqrstuv', 'title': {'simpleText': 'テスト'}, 'shortBylineText': {'runs': [{'text': '作者'}]}, 'lengthText': {'simpleText': '10:03'}}}]), 'abcdefghijk')
        self.assertEqual(result[0]['channel'], '作者')
        self.assertEqual(result[0]['duration'], 603)

    def test_fetch_is_fixed_public_watch_and_cached(self):
        service = RelatedService(); service.opener = Mock()
        player = {'microformat': {'playerMicroformatRenderer': {'category': 'Music'}}}
        body = 'var ytInitialData = ' + json.dumps(initial([renderer('lmnopqrstuv', music=True), renderer('zzzzzzzzzzz')])) + ';var ytInitialPlayerResponse = ' + json.dumps(player) + ';'
        service.opener.open.return_value = io.BytesIO(body.encode())
        result = service.fetch('abcdefghijk')
        self.assertEqual(len(result), 1)
        self.assertEqual(service.fetch('abcdefghijk'), result)
        service.opener.open.assert_called_once()
        self.assertTrue(service.opener.open.call_args.args[0].full_url.startswith('https://www.youtube.com/watch?'))
        self.assertEqual(service.opener.open.call_args.args[0].get_header('Cookie'), None)

    def test_invalid_id_no_network_and_failure_no_fallback(self):
        service = RelatedService(); service.opener = Mock()
        for value in ['../escape', [], None]:
            with self.assertRaises(ValueError): service.fetch(value)
        service.opener.open.assert_not_called()
        service.opener.open.side_effect = OSError('offline')
        with self.assertRaisesRegex(RuntimeError, '代替表示はしません'):
            service.fetch('abcdefghijk')
