import io
import json
import unittest
from unittest.mock import Mock, patch
from dubbing_service import DubbingService, NoRedirect


class DubbingTests(unittest.TestCase):
    def setUp(self):
        self.service = DubbingService(Mock())

    def test_voice_list_excludes_singing_styles(self):
        payload = [{'name': '話者', 'styles': [{'id': 1, 'name': '通常'}, {'id': 2, 'name': '歌', 'type': 'sing'}]}]
        with patch.object(self.service, '_voicevox', return_value=json.dumps(payload).encode()):
            self.assertEqual(self.service.voices()['voices'], [{'id': 1, 'name': '話者', 'style': '通常'}])

    def test_synthesis_is_query_then_wave(self):
        wav = b'RIFF1234WAVEdata'
        with patch.object(self.service, '_voicevox', side_effect=[b'{"accent_phrases":[]}', wav]) as request:
            self.assertEqual(self.service.synthesize({'text': 'こんにちは', 'speaker': 1, 'speed': 1.2}), wav)
            self.assertTrue(request.call_args_list[0].args[0].startswith('/audio_query?'))
            body = json.loads(request.call_args_list[1].kwargs['body'])
            self.assertEqual(body['speedScale'], 1.2)
            self.assertEqual(body['outputSamplingRate'], 24000)

    def test_invalid_synthesis_never_contacts_engine(self):
        with patch.object(self.service, '_voicevox') as request:
            for payload in [{'text': '', 'speaker': 1}, {'text': 'a'*501, 'speaker': 1}, {'text': 'a', 'speaker': True}, {'text': 'a', 'speaker': -1}, {'text': 'a', 'speaker': 1, 'speed': float('nan')}]:
                with self.assertRaises(ValueError): self.service.synthesize(payload)
            request.assert_not_called()

    def test_bad_wave_is_rejected(self):
        with patch.object(self.service, '_voicevox', side_effect=[b'{}', b'not a wave']):
            with self.assertRaises(RuntimeError): self.service.synthesize({'text': 'a', 'speaker': 1})

    def test_no_redirect_and_fixed_loopback(self):
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'https://example.com'))
        response = io.BytesIO(b'[]')
        self.service.opener = Mock()
        self.service.opener.open.return_value = response
        self.assertEqual(self.service._voicevox('/speakers'), b'[]')
        self.assertEqual(self.service.opener.open.call_args.args[0].full_url, 'http://127.0.0.1:50021/speakers')

    def test_missing_engine_has_actionable_error(self):
        self.service.opener = Mock()
        self.service.opener.open.side_effect = ConnectionRefusedError()
        with self.assertRaisesRegex(RuntimeError, 'VOICEVOXを起動'): self.service.voices()

    def test_saved_port_is_used_without_recreating_service(self):
        self.service.settings = Mock()
        self.service.opener = Mock()
        for port in (50025, 50026):
            self.service.settings.get.return_value = {'voicevoxPort': port}
            self.service.opener.open.return_value = io.BytesIO(b'[]')
            self.assertEqual(self.service._voicevox('/speakers'), b'[]')
            self.assertEqual(self.service.opener.open.call_args.args[0].full_url, f'http://127.0.0.1:{port}/speakers')

    def test_invalid_subtitle_request_does_not_run_ytdlp(self):
        for video, language in [('../escape', 'ja'), ('abcdefghijk', 'anything')]:
            with self.assertRaises(ValueError): self.service.subtitles(video, language)
        self.service.youtube._run.assert_not_called()
