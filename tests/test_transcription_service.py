import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from transcription_service import TranscriptionService


class TranscriptionTests(unittest.TestCase):
    def setUp(self):
        self.service = TranscriptionService(Path(__file__).resolve().parents[1])
        self.addCleanup(self.service.close)

    def test_validation_before_any_job(self):
        for change in [{'videoId': '../escape'}, {'start': True}, {'start': float('nan')}, {'start': -1}, {'language': 'xx'}, {'downloadModel': 'yes'}]:
            with self.assertRaises(ValueError):
                self.service.start({'videoId': 'abcdefghijk', **change}, 'http://127.0.0.1:8000')
        self.assertFalse(self.service.jobs)
        for job_id in [None, [], {}, 'unknown']:
            with self.assertRaises(ValueError): self.service.get(job_id)
            with self.assertRaises(ValueError): self.service.cancel(job_id)

    def test_missing_dependency_is_actionable(self):
        with patch.object(self.service, 'status', return_value={'available': False, 'installation': 'install requirements-voice.txt'}):
            with self.assertRaisesRegex(RuntimeError, 'requirements-voice'):
                self.service.start({'videoId': 'abcdefghijk'}, 'http://127.0.0.1:8000')

    def test_standard_bundle_does_not_recommend_unpublished_voice_build(self):
        import sys
        with patch.object(sys, 'frozen', True, create=True), patch('transcription_service.importlib.util.find_spec', return_value=None):
            status = self.service.status()
        self.assertFalse(status['available'])
        self.assertIn('字幕からの吹替は利用できます', status['installation'])
        self.assertIn('未配布', status['installation'])
        self.assertNotIn('使用してください', status['installation'])

    def test_single_job_and_cancellation(self):
        with patch.object(self.service, 'status', return_value={'available': True}), patch('transcription_service.threading.Thread'):
            public = self.service.start({'videoId': 'abcdefghijk', 'start': 120}, 'http://127.0.0.1:8000')
            self.assertEqual(public['end'], 420)
            self.assertNotIn('process', public)
            with self.assertRaises(RuntimeError): self.service.start({'videoId': 'abcdefghijk'}, 'http://127.0.0.1:8000')
            job = self.service.jobs[public['jobId']]
            job['process'] = Mock()
            self.service.cancel(public['jobId'])
            self.assertTrue(job['cancelled'].is_set())
            job['process'].terminate.assert_called_once()

    def test_worker_receives_bounded_segment_and_no_download_by_default(self):
        job = {'jobId': 'a' * 32, 'videoId': 'abcdefghijk', 'start': 60, 'status': 'running', 'cancelled': threading.Event()}
        calls = []
        def run(_job, command, **options):
            calls.append((command, options))
            if len(calls) == 1:
                Path(command[-1]).write_bytes(b'wave fixture')
                return ''
            return json.dumps({'cues': [{'start': 61, 'end': 62, 'text': 'こんにちは'}]})
        with patch.object(self.service, '_run', side_effect=run), patch('transcription_service.shutil.which', return_value='/usr/bin/ffmpeg'):
            self.service._work(job, 'ja', False, 'http://127.0.0.1:8000')
        self.assertEqual(job['status'], 'done')
        command = calls[0][0]
        self.assertEqual(command[command.index('-t') + 1], '300')
        self.assertEqual(command[command.index('-ss') + 1], '60')
        self.assertIn('http://127.0.0.1:8000/api/media/abcdefghijk?format=m4a', command)
        request = json.loads(calls[1][1]['input_text'])
        self.assertFalse(request['downloadModel'])
        self.assertEqual(request['start'], 60)
