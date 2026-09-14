"""Bounded local RVC jobs and model imports. No ML imports in the HTTP server."""
import atexit
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import uuid

from app_runtime import atomic_json, subprocess_options
from rvc_assets import ENGINE_REVISION, digest
from rvc_runtime import WarmRVCWorker

MAX_MODEL_BYTES = 128 * 1024**2
MAX_INDEX_BYTES = 256 * 1024**2
MAX_AUDIO_BYTES = 12 * 1024**2


class RVCService:
    def __init__(self, directory, app_directory):
        self.root = Path(directory) / 'rvc'
        self.app_directory = Path(app_directory)
        self.lock = threading.RLock()
        self.import_slot = threading.BoundedSemaphore(1)
        self.jobs = {}
        self.temporary = None
        self.closed = False
        self.auto_cpu_only = False
        self.worker = WarmRVCWorker(self.spawn, self.stop_process,
            [str(self.python), str(self.app_directory / 'rvc_worker.py'), '--serve'])
        atexit.register(self.close)

    @property
    def python(self):
        return self.root / 'runtime' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')

    @staticmethod
    def identifier(value):
        if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{32}', value):
            raise ValueError('モデル・処理IDが不正です。')
        return value

    def model(self, model_id):
        path = self.root / 'models' / self.identifier(model_id)
        try:
            data = json.loads((path / 'model.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            raise ValueError('モデルが見つかりません。インポートし直してください。') from None
        if not (path / 'model.pth').is_file():
            raise ValueError('モデルファイルが見つかりません。')
        return path, data

    def models(self):
        result = []
        for path in sorted((self.root / 'models').glob('*/model.json')):
            try:
                _, data = self.model(path.parent.name)
                result.append({key: data.get(key) for key in ('id', 'name', 'version', 'sampleRate', 'personalOnly')}
                              | {'hasIndex': bool(data.get('indexSha256'))})
            except (ValueError, TypeError):
                continue
        return sorted(result, key=lambda model: (not model.get('personalOnly'), model.get('name') or ''))[:20]

    def status(self):
        try:
            ready = json.loads((self.root / 'ready.json').read_text())['engineRevision'] == ENGINE_REVISION
        except (OSError, ValueError, KeyError):
            ready = False
        ready = ready and self.python.is_file() and (self.root / 'engine/rvc/infer/pipeline.py').is_file()
        ffmpeg = shutil.which('ffmpeg') is not None
        return {'available': bool(ready and ffmpeg), 'runtime': bool(ready), 'ffmpeg': ffmpeg,
                'models': self.models(), 'chunkSeconds': 20, 'startupChunkSeconds': 4,
                'message': ('利用できます。音声は端末内で人声分離・変換します。' if ready and ffmpeg else
                            'FFmpegを導入して再起動してください。' if ready else
                            'RVC処理環境が未準備です。ソース版のPython 3.11で scripts/setup_rvc.py を実行してください。通常配布版には未搭載です。')}

    @staticmethod
    def stop_process(process, force=False):
        """Stop only our worker and its index-search descendants."""
        try:
            if getattr(process, '_clipnest_group', False) is True:
                os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
            elif process.poll() is None:
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                                   capture_output=True, timeout=5, **subprocess_options())
                elif force:
                    process.kill()
                else:
                    process.terminate()
        except (OSError, subprocess.SubprocessError):
            pass

    def spawn(self, command):
        process = subprocess.Popen(command, cwd=self.root / 'engine', stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace',
            env={**os.environ, 'HF_HUB_OFFLINE': '1', 'HF_HUB_DISABLE_IMPLICIT_TOKEN': '1', 'PYTHONIOENCODING': 'utf-8'},
            start_new_session=os.name != 'nt', **subprocess_options())
        process._clipnest_group = os.name != 'nt'
        return process

    def validate(self, command):
        process = self.spawn(command)
        try:
            stdout, _ = process.communicate(timeout=90)
            return subprocess.CompletedProcess(command, process.returncode, stdout)
        finally:
            self.stop_process(process, force=True)
            process.communicate()

    def import_model(self, stream, size, name='', model_id=None):
        limit = MAX_INDEX_BYTES if model_id else MAX_MODEL_BYTES
        if type(size) is not int or not 0 < size <= limit:
            raise ValueError('モデルは128MB、indexは256MBまでです。')
        if not self.status()['runtime']:
            raise RuntimeError('先にRVC処理環境を準備してください。')
        if not self.import_slot.acquire(blocking=False):
            raise RuntimeError('別のモデルをインポート中です。')
        temporary = None
        created = None
        try:
            if model_id:
                folder, previous = self.model(model_id)
                if previous.get('indexSha256'):
                    raise ValueError('既存のindexは上書きしません。モデルを新しくインポートしてください。')
            else:
                if len(self.models()) >= 20:
                    raise ValueError('モデルは20個までです。')
                if not isinstance(name, str) or not name.strip() or len(name) > 80 or any(ord(c) < 32 for c in name):
                    raise ValueError('モデル名は1〜80文字で指定してください。')
                model_id = uuid.uuid4().hex
                folder = self.root / 'models' / model_id
                previous = None
                folder.mkdir(parents=True, mode=0o700)
                created = folder
            if shutil.disk_usage(folder).free < size + 512 * 1024**2:
                raise RuntimeError('モデルを保存する空き容量が足りません。')
            fd, temporary = tempfile.mkstemp(prefix='.import-', dir=folder)
            with os.fdopen(fd, 'wb') as output:
                remaining = size
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError('モデルの転送が途中で終了しました。')
                    remaining -= len(chunk)
                    output.write(chunk)
            command = [str(self.python), str(self.app_directory / 'rvc_worker.py'), '--validate', str(folder / 'model.pth' if previous else temporary)]
            if previous:
                command.extend(['--index', temporary])
            result = self.validate(command)
            if result.returncode:
                raise ValueError('対応する安全なRVC v1/v2推論モデル、または同じモデルのindexを選んでください。')
            info = json.loads(result.stdout)
            sha = digest(temporary)
            destination = folder / ('model.index' if previous else 'model.pth')
            os.replace(temporary, destination)
            data = {**previous, 'indexSha256': sha} if previous else {**info, 'id': model_id, 'name': name.strip(), 'sha256': sha, 'personalOnly': False}
            atomic_json(folder / 'model.json', data)
            created = None
            return {'modelId': model_id, 'models': self.models()}
        except (OSError, subprocess.SubprocessError) as exc:
            raise RuntimeError('モデルを追加できませんでした。ファイル・空き容量・処理環境を確認し、再試行してください。') from exc
        finally:
            if temporary:
                Path(temporary).unlink(missing_ok=True)
            if created:
                # Only the UUID directory made by this failed import, never an existing model.
                shutil.rmtree(created)
            self.import_slot.release()

    def start(self, payload, origin):
        if set(payload) - {'modelId', 'videoId', 'start', 'seconds', 'pitch', 'indexRate', 'device'}:
            raise ValueError('未対応の変換設定が含まれています。')
        video = payload.get('videoId', '')
        if not isinstance(video, str) or not re.fullmatch('[A-Za-z0-9_-]{11}', video):
            raise ValueError('動画IDが不正です。')
        for key, lower, upper, default in [('start', 0, 86400, 0), ('seconds', 0.2, 30, 20), ('pitch', -12, 12, 0), ('indexRate', 0, 1, 0.65)]:
            value = payload.get(key, default)
            if type(value) not in (float, int) or not math.isfinite(value) or not lower <= value <= upper:
                raise ValueError('変換位置・長さ・音程・index率を確認してください。')
            payload = {**payload, key: value}
        if payload['pitch'] != int(payload['pitch']) or payload.get('device', 'auto') not in ('auto', 'cpu', 'mps', 'cuda'):
            raise ValueError('音程・処理デバイスが不正です。')
        folder, model = self.model(payload.get('modelId', ''))
        available = self.status()
        if not available['available']:
            raise RuntimeError(available['message'])
        with self.lock:
            if self.closed:
                raise RuntimeError('アプリの終了処理中です。再起動してください。')
            if any(job['state'] == 'running' for job in self.jobs.values()):
                raise RuntimeError('変換処理を実行中です。完了・中止を待ってください。')
            while len(self.jobs) >= 6:
                first = next(iter(self.jobs))
                old = self.jobs.pop(first)
                old['folder'].cleanup()
            if not self.temporary:
                (self.root / 'cache').mkdir(parents=True, exist_ok=True, mode=0o700)
                self.temporary = tempfile.TemporaryDirectory(prefix='session-', dir=self.root / 'cache')
            job_id = uuid.uuid4().hex
            temporary = tempfile.TemporaryDirectory(prefix='chunk-', dir=self.temporary.name)
            job = {'jobId': job_id, 'videoId': video, 'state': 'running', 'stage': '音声を取得中',
                   'start': payload['start'], 'duration': payload['seconds'], 'folder': temporary,
                   'cancel': threading.Event(), 'finished': threading.Event(), 'process': None}
            self.jobs[job_id] = job
            threading.Thread(target=self._work, args=(job, payload, folder, model, origin), daemon=True).start()
            return self.get(job_id)

    def get(self, job_id):
        with self.lock:
            job = self.jobs.get(self.identifier(job_id))
            if not job:
                raise ValueError('変換処理が見つかりません。再試行してください。')
            result = {key: value for key, value in job.items() if key not in ('folder', 'cancel', 'process', 'finished')}
            if result['state'] == 'running':
                try:
                    stage = json.loads((Path(job['folder'].name) / 'progress.json').read_text()).get('stage')
                    if stage in ('モデルを準備中', '人声とBGMを分離中', 'RVCで声を変換中', '再生用の音声を準備中'):
                        result['stage'] = stage
                except (OSError, ValueError):
                    pass
            return result

    def cancel(self, job_id):
        with self.lock:
            self.get(job_id)
            job = self.jobs[job_id]
            job['cancel'].set()
            if job['process'] is not None:
                self.stop_process(job['process'])
        return {'cancelled': True}

    def audio(self, job_id, stem):
        if stem not in ('voice', 'background'):
            raise ValueError('音声の種類が不正です。')
        with self.lock:
            if self.get(job_id)['state'] != 'done':
                raise ValueError('変換はまだ完了していません。')
            path = Path(self.jobs[job_id]['folder'].name) / f'{stem}.wav'
            if not path.is_file() or path.stat().st_size > MAX_AUDIO_BYTES:
                raise ValueError('変換音声が見つからないか、サイズが大きすぎます。')
            return path.read_bytes()

    def _run(self, job, command, *, timeout, input_text=None):
        with self.lock:
            if job['cancel'].is_set():
                raise RuntimeError('中止しました。')
            process = self.spawn(command)
            job['process'] = process
        try:
            stdout, stderr = process.communicate(input_text, timeout=timeout)
            if process.returncode:
                logging.getLogger('clipnest').error('rvc_worker_failed')
                # Keep bounded details locally for development; never include these in HTTP errors.
                (Path(job['folder'].name) / 'worker-error.txt').write_text(stderr[-12000:], encoding='utf-8')
                raise RuntimeError('変換に失敗しました。CPU設定・モデルの対応形式・yt-dlp・空き容量を確認してください。')
            return stdout
        finally:
            self.stop_process(process, force=True)
            process.communicate()
            with self.lock:
                job['process'] = None

    def _work(self, job, payload, model_folder, model, origin):
        output = Path(job['folder'].name)
        self.worker.last_error = ''
        try:
            if digest(model_folder / 'model.pth') != model['sha256']:
                raise RuntimeError('モデルがインポート後に変更されています。インポートし直してください。')
            index = model_folder / 'model.index'
            if model.get('indexSha256') and digest(index) != model['indexSha256']:
                raise RuntimeError('indexがインポート後に変更されています。')
            begin = max(0, payload['start'] - 1)
            seconds = payload['seconds'] + payload['start'] - begin + 1
            source = f"{origin}/api/media/{payload['videoId']}?format=m4a"
            audio = output / 'input.wav'
            seek = ['-ss', str(begin)] if begin > 0 else []
            # -ss 0 can discard the probe buffer on a non-seekable HTTP source.
            self._run(job, [shutil.which('ffmpeg'), '-nostdin', '-v', 'error', '-rw_timeout', '30000000',
                *seek, '-i', source, '-t', str(seconds), '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', str(audio)], timeout=180)
            if not audio.is_file() or audio.stat().st_size > 7 * 1024**2:
                raise RuntimeError('変換用の音声を取得できませんでした。')
            def bind(process):
                with self.lock:
                    job['process'] = process
            request = {**payload, 'root': str(self.root), 'input': str(audio), 'output': str(output),
                       'model': str(model_folder / 'model.pth'), 'index': str(index) if model.get('indexSha256') else '',
                       'trimStart': payload['start'] - begin}
            auto = payload.get('device', 'auto') == 'auto'
            if auto and self.auto_cpu_only:
                request['device'] = 'cpu'
            try:
                try:
                    data = self.worker.infer(request, job['cancel'], bind)
                except RuntimeError:
                    if payload.get('device', 'auto') != 'auto' or job['cancel'].is_set():
                        raise
                    # Auto may encounter an unsupported GPU operation or insufficient GPU memory.
                    data = self.worker.infer({**request, 'device': 'cpu'}, job['cancel'], bind)
                    self.auto_cpu_only = True
                data['cpuFallback'] = auto and self.auto_cpu_only
            finally:
                with self.lock:
                    job['process'] = None
            if (type(data.get('duration')) not in (int, float) or not math.isfinite(data['duration'])
                    or not 0 < data['duration'] <= payload['seconds'] + 0.03
                    or data['duration'] < payload['seconds'] - 0.5):
                raise RuntimeError('必要な区間の音声を最後まで取得できませんでした。原音の読み込みを確認して再試行してください。')
            with self.lock:
                job.update(state='done', stage='完了', duration=data['duration'], processingSeconds=data['processingSeconds'],
                           deviceUsed=data.get('deviceUsed', payload.get('device', 'auto')), modelsReused=data.get('modelsReused', False),
                           cpuFallback=data.get('cpuFallback', False))
        except Exception as exc:
            if not job['cancel'].is_set() and self.worker.last_error:
                logging.getLogger('clipnest').error('rvc_worker_failed')
                try:
                    (output / 'worker-error.txt').write_text(self.worker.last_error, encoding='utf-8')
                except OSError:
                    pass
            with self.lock:
                job.update(state='error', message=str(exc) if isinstance(exc, RuntimeError) else '変換が失敗・タイムアウトしました。モデルと処理環境を確認してください。')
        finally:
            if job['cancel'].is_set():
                with self.lock:
                    job.update(state='cancelled', message='変換を中止しました。')
            job['finished'].set()

    def close(self):
        with self.lock:
            self.closed = True
            for job_id in list(self.jobs):
                self.cancel(job_id)
            pending = [job['finished'] for job in self.jobs.values() if 'finished' in job and job['state'] == 'running']
        self.worker.close()
        for finished in pending:
            finished.wait(timeout=3)
        with self.lock:
            # Running workers own their temporary files until they have stopped.
            if all(job['process'] is None and job['state'] != 'running' for job in self.jobs.values()):
                for job in self.jobs.values():
                    job['folder'].cleanup()
                self.jobs.clear()
                if self.temporary:
                    self.temporary.cleanup()
                    self.temporary = None
