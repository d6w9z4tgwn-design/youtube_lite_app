"""Single cancellable local ASR job; no audio is sent to cloud ASR."""
import atexit
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
from app_runtime import data_directory, worker_command, subprocess_options


class TranscriptionService:
    def __init__(self, app_directory, settings=None):
        self.app_directory = Path(app_directory)
        self.settings = settings
        self.data_directory = settings.directory if settings else data_directory()
        self.lock = threading.RLock()
        self.jobs = {}
        atexit.register(self.close)

    def status(self):
        whisper = importlib.util.find_spec('faster_whisper') is not None
        ffmpeg = shutil.which('ffmpeg') is not None
        if not whisper:
            message = ('この配布版には字幕なしの文字起こし機能が含まれていません。字幕からの吹替は利用できます。Whisper同梱版は現在未配布です。' if getattr(sys, 'frozen', False) else '字幕なしの文字起こしには、起動に使っているPython環境で python -m pip install -r requirements-voice.txt を実行してください。FFmpegも必要です。')
        elif not ffmpeg:
            message = '文字起こし用の音声取得にはFFmpegが必要です。導入後にアプリを再起動してください。'
        else:
            message = '文字起こしに必要なソフトを検出しました。モデルをまだ取得していない場合は、取得を許可してから開始してください。'
        return {'available': whisper and ffmpeg, 'whisper': whisper, 'ffmpeg': ffmpeg,
                'model': self.settings.get()['whisperModel'] if self.settings else 'base', 'maxSeconds': 300,
                'installation': message}

    def start(self, payload, source_origin):
        video = payload.get('videoId', '')
        start = payload.get('start', 0)
        language = payload.get('language', 'ja')
        download = payload.get('downloadModel', False)
        if not isinstance(video, str) or not re.fullmatch(r'[A-Za-z0-9_-]{11}', video):
            raise ValueError('動画IDが不正です。')
        if type(start) not in (int, float) or not math.isfinite(start) or not 0 <= start <= 86400:
            raise ValueError('文字起こしの開始位置が不正です。')
        if language not in ('ja', 'en') or type(download) is not bool:
            raise ValueError('言語またはモデル取得の指定が不正です。')
        status = self.status()
        if not status['available']:
            raise RuntimeError(status['installation'])
        with self.lock:
            if any(job['status'] == 'running' for job in self.jobs.values()):
                raise RuntimeError('文字起こしを実行中です。完了を待つか、中止してください。')
            while len(self.jobs) >= 4:
                self.jobs.pop(next(iter(self.jobs)))
            job_id = uuid.uuid4().hex
            job = {'jobId': job_id, 'videoId': video, 'start': start, 'end': start + 300,
                   'status': 'running', 'stage': '音声を取得中', 'cancelled': threading.Event(), 'process': None}
            self.jobs[job_id] = job
            threading.Thread(target=self._work, args=(job, language, download, source_origin), daemon=True).start()
            return self.get(job_id)

    def get(self, job_id):
        self._validate_id(job_id)
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError('文字起こしジョブが見つかりません。')
            return {key: value for key, value in job.items() if key not in ('process', 'cancelled')}

    def cancel(self, job_id):
        self._validate_id(job_id)
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError('文字起こしジョブが見つかりません。')
            if job['status'] == 'running':
                job['cancelled'].set()
                if job['process'] is not None:
                    try: job['process'].terminate()
                    except OSError: pass
            return {'cancelled': True}

    @staticmethod
    def _validate_id(job_id):
        if not isinstance(job_id, str) or not re.fullmatch(r'[a-f0-9]{32}', job_id):
            raise ValueError('文字起こしジョブIDが不正です。')

    def close(self):
        for job_id in list(self.jobs):
            self.cancel(job_id)

    def _run(self, job, command, *, timeout, input_text=None):
        with self.lock:
            if job['cancelled'].is_set():
                raise RuntimeError('中止しました。')
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                       encoding='utf-8', errors='replace', **subprocess_options(),
                                       env={**os.environ, 'HF_HUB_DISABLE_IMPLICIT_TOKEN': '1', 'PYTHONIOENCODING': 'utf-8'})
            job['process'] = process
        try:
            output, error = process.communicate(input_text, timeout=timeout)
            if process.returncode:
                raise RuntimeError('文字起こし処理に失敗しました。モデル未取得ならダウンロードを許可してください。通信・空き容量も確認してください。')
            return output
        finally:
            if process.poll() is None:
                process.kill(); process.communicate()
            with self.lock: job['process'] = None

    def _work(self, job, language, download, origin):
        try:
            with tempfile.TemporaryDirectory(prefix='clipnest-asr-') as folder:
                audio = Path(folder) / 'segment.wav'
                source = f"{origin}/api/media/{job['videoId']}?format=m4a"
                self._run(job, [shutil.which('ffmpeg'), '-nostdin', '-v', 'error', '-rw_timeout', '30000000',
                    '-ss', str(job['start']), '-i', source, '-t', '300', '-vn', '-ac', '1', '-ar', '16000', str(audio)], timeout=180)
                if not audio.exists() or audio.stat().st_size > 12 * 1024 * 1024:
                    raise RuntimeError('文字起こし用音声の取得に失敗しました。')
                with self.lock: job['stage'] = '音声認識中（初回は許可されたモデルを取得）'
                output = self._run(job, worker_command('asr', self.app_directory / 'asr_worker.py'), timeout=1200,
                    input_text=json.dumps({'audio': str(audio), 'start': job['start'], 'language': language,
                        'modelDirectory': str(self.data_directory / 'asr_models'), 'downloadModel': download,
                        'model': self.settings.get()['whisperModel'] if self.settings else 'base'}))
                result = json.loads(output)
                if not result.get('cues'):
                    raise RuntimeError('この区間で発話を検出できませんでした。音楽・歌・小声は認識が難しい場合があります。')
                if len(result['cues']) > 4000:
                    raise RuntimeError('認識結果が大きすぎます。')
                with self.lock:
                    job.update(status='done', stage='完了', cues=result['cues'])
        except Exception as exc:
            with self.lock:
                job.update(status='error', message=str(exc) if isinstance(exc, RuntimeError) else '文字起こしが失敗・タイムアウトしました。依存パッケージとモデルを確認してください。')
        finally:
            if job['cancelled'].is_set():
                with self.lock: job.update(status='cancelled', message='中止しました。')
