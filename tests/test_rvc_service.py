import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from app_runtime import atomic_json
from rvc_assets import ENGINE_REVISION, allowed_download, digest
from rvc_service import RVCService, MAX_MODEL_BYTES


class RVCTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.service = RVCService(self.temporary.name, Path(__file__).resolve().parents[1])
        self.addCleanup(self.service.close)
        self.id = 'a' * 32

    def model(self):
        folder = self.service.root / 'models' / self.id
        folder.mkdir(parents=True)
        (folder / 'model.pth').write_bytes(b'fixture')
        atomic_json(folder / 'model.json', {'id': self.id, 'name': 'Fixture', 'sha256': digest(folder / 'model.pth'), 'version': 'v2', 'sampleRate': 40000})
        return folder

    def test_optional_service_does_not_create_files_or_spawn_process(self):
        with patch('rvc_service.subprocess.Popen') as spawn:
            status = self.service.status()
            self.assertFalse(status['available'])
            self.assertEqual(status['models'], [])
            self.assertFalse(self.service.root.exists())
            spawn.assert_not_called()

    def test_models_never_expose_paths_or_external_commands(self):
        self.model()
        models = self.service.models()
        self.assertEqual(models[0]['id'], self.id)
        self.assertNotIn(self.temporary.name, json.dumps(models))
        for value in ('../escape', '', 'a' * 33, None):
            with self.assertRaises(ValueError): self.service.model(value)

    def test_bad_requests_do_not_start_workers(self):
        self.model()
        with patch('rvc_service.subprocess.Popen') as spawn:
            for extra in ({'start': -1}, {'start': float('nan')}, {'seconds': 31}, {'seconds': True}, {'pitch': 1.2}, {'device': 'shell'}, {'indexRate': 2}, {'videoId': '../escape'}, {'modelId': '../../tmp'}, {'input': '/private/audio'}):
                with self.assertRaises(ValueError):
                    self.service.start({'videoId': 'abcdefghijk', 'modelId': self.id, **extra}, 'http://127.0.0.1:1')
            spawn.assert_not_called()

    def test_missing_environment_returns_actionable_error(self):
        self.model()
        with self.assertRaisesRegex(RuntimeError, '未準備'):
            self.service.start({'videoId': 'abcdefghijk', 'modelId': self.id}, 'http://127.0.0.1:1')

    def test_import_rejects_oversize_and_truncated_files(self):
        with patch.object(self.service, 'status', return_value={'runtime': True}):
            for size in (0, MAX_MODEL_BYTES + 1, True):
                with self.assertRaises(ValueError): self.service.import_model(io.BytesIO(b'x'), size, 'test')
            with self.assertRaises(ValueError): self.service.import_model(io.BytesIO(b'x'), 20, 'test')
        self.assertEqual(self.service.models(), [])

    def test_import_hashes_bytes_and_validates_in_separate_worker(self):
        output = subprocess.CompletedProcess([], 0, json.dumps({'version': 'v2', 'sampleRate': 40000}), '')
        with patch.object(self.service, 'status', return_value={'runtime': True}), patch.object(self.service, 'validate', return_value=output) as run:
            imported = self.service.import_model(io.BytesIO(b'weights'), 7, 'モデル')
            folder, model = self.service.model(imported['modelId'])
            self.assertEqual(model['sha256'], digest(folder / 'model.pth'))
            self.assertIn('--validate', run.call_args.args[0])
            self.service.import_model(io.BytesIO(b'index'), 5, model_id=model['id'])
            _, updated = self.service.model(model['id'])
            self.assertEqual(updated['indexSha256'], digest(folder / 'model.index'))
            with self.assertRaises(ValueError): self.service.import_model(io.BytesIO(b'other'), 5, model_id=model['id'])

    def test_rejected_model_is_not_registered(self):
        with patch.object(self.service, 'status', return_value={'runtime': True}), patch.object(self.service, 'validate', return_value=subprocess.CompletedProcess([], 1, '', 'private stack')):
            with self.assertRaisesRegex(ValueError, '安全なRVC'):
                self.service.import_model(io.BytesIO(b'bad'), 3, 'bad')
        self.assertEqual(self.service.models(), [])
        self.assertEqual(list(self.service.root.glob('models/*/.import-*')), [])

    def test_audio_routes_reject_paths_and_incomplete_jobs(self):
        for stem in ('../voice', '/tmp/a', 'model'):
            with self.assertRaises(ValueError): self.service.audio(self.id, stem)
        with self.assertRaises(ValueError): self.service.audio(self.id, 'voice')

    def test_cancel_stops_only_its_worker(self):
        import threading
        folder = tempfile.TemporaryDirectory(dir=self.temporary.name)
        process = Mock(); process.poll.return_value = None
        self.service.jobs[self.id] = {'jobId': self.id, 'state': 'done', 'folder': folder, 'cancel': threading.Event(), 'process': process}
        self.service.cancel(self.id)
        process.terminate.assert_called_once()
        self.assertTrue(self.service.jobs[self.id]['cancel'].is_set())
        self.service.jobs[self.id]['process'] = None

    def test_worker_group_is_stopped_including_index_search(self):
        import signal
        process = Mock(pid=123456, _clipnest_group=True)
        with patch('rvc_service.os.killpg') as kill:
            self.service.stop_process(process)
            kill.assert_called_once_with(123456, signal.SIGTERM)
            self.service.stop_process(process, force=True)
            self.assertEqual(kill.call_args.args, (123456, signal.SIGKILL))

    def test_download_does_not_seek_zero_and_rejects_a_truncated_result(self):
        folder = self.model()
        _, metadata = self.service.model(self.id)
        output = tempfile.TemporaryDirectory(dir=self.temporary.name)
        self.addCleanup(output.cleanup)
        job = {'folder': output, 'cancel': threading.Event(), 'finished': threading.Event()}
        commands = []
        def fake_run(_job, command, **kwargs):
            commands.append(command)
            if kwargs.get('input_text') is None:
                Path(command[-1]).write_bytes(b'fixture')
                return ''
            return json.dumps({'duration': 1, 'processingSeconds': 2})
        with patch.object(self.service, '_run', side_effect=fake_run), patch.object(self.service.worker, 'infer', return_value={'duration': 1, 'processingSeconds': 2}):
            self.service._work(job, {'videoId': 'abcdefghijk', 'start': 0, 'seconds': 6}, folder, metadata, 'http://127.0.0.1:1')
        self.assertNotIn('-ss', commands[0])
        self.assertEqual(job['state'], 'error')
        self.assertIn('最後まで取得', job['message'])
        self.assertTrue(job['finished'].is_set())

    def test_downloads_are_https_and_allowlisted(self):
        self.assertTrue(allowed_download('https://huggingface.co/kuwacom/RVC-Models'))
        self.assertTrue(allowed_download('https://cas-bridge.xethub.hf.co/file'))
        for url in ('http://huggingface.co/a', 'https://example.org/a', 'https://huggingface.co.evil.org/a', 'https://user:pass@huggingface.co/a', 'https://huggingface.co:8000/a', 'https://huggingface.co:invalid/a'):
            self.assertFalse(allowed_download(url))

    def test_auto_gpu_failure_retries_cpu_and_remembers_fallback(self):
        folder = self.model()
        _, metadata = self.service.model(self.id)
        output = tempfile.TemporaryDirectory(dir=self.temporary.name)
        self.addCleanup(output.cleanup)
        def acquire(_job, command, **kwargs):
            Path(command[-1]).write_bytes(b'fixture')
            return ''
        result = {'duration': 6, 'processingSeconds': 1, 'deviceUsed': 'cpu'}
        with patch.object(self.service, '_run', side_effect=acquire), patch.object(self.service.worker, 'infer', side_effect=[RuntimeError('GPU failure'), result.copy(), result.copy()]) as infer:
            for _ in range(2):
                job = {'folder': output, 'cancel': threading.Event(), 'finished': threading.Event()}
                self.service._work(job, {'videoId': 'abcdefghijk', 'start': 0, 'seconds': 6, 'device': 'auto'}, folder, metadata, 'http://127.0.0.1:1')
                self.assertEqual(job['state'], 'done')
                self.assertTrue(job['cpuFallback'])
            self.assertEqual([call.args[0]['device'] for call in infer.call_args_list], ['auto', 'cpu', 'cpu'])


if __name__ == '__main__':
    unittest.main()
