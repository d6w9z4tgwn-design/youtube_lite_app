"""Local VOICEVOX synthesis and bounded YouTube subtitle acquisition."""
import html
import json
import math
from pathlib import Path
import re
import tempfile
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class DubbingService:
    def __init__(self, youtube, settings=None):
        self.youtube = youtube
        self.settings = settings
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def _voicevox(self, path, *, body=None, limit=8 * 1024 * 1024):
        # Fixed loopback only: text never goes to a cloud TTS service.
        port = self.settings.get()['voicevoxPort'] if self.settings else 50021
        request = urllib.request.Request(f'http://127.0.0.1:{port}' + path,
            data=body, headers={'Content-Type': 'application/json'}, method='POST' if body is not None else 'GET')
        try:
            with self.opener.open(request, timeout=60) as response:
                data = response.read(limit + 1)
                if len(data) > limit:
                    raise ValueError('VOICEVOXの応答が大きすぎます。字幕を短く分けてください。')
                return data
        except OSError as exc:
            raise RuntimeError(f'VOICEVOXを起動してください（127.0.0.1:{port}）。接続または音声合成に失敗しました。') from exc

    def voices(self):
        raw = json.loads(self._voicevox('/speakers', limit=2 * 1024 * 1024))
        voices = []
        for speaker in raw:
            for style in speaker.get('styles', []):
                if style.get('type', 'talk') == 'talk' and isinstance(style.get('id'), int):
                    voices.append({'id': style['id'], 'name': str(speaker.get('name', ''))[:100], 'style': str(style.get('name', ''))[:100]})
        return {'voices': voices[:1000], 'engine': 'VOICEVOX (local)'}

    def synthesize(self, payload):
        text, speaker = payload.get('text'), payload.get('speaker')
        speed = payload.get('speed', 1)
        if not isinstance(text, str) or not text.strip() or len(text) > 500:
            raise ValueError('字幕1件は1〜500文字にしてください。')
        if type(speaker) is not int or not 0 <= speaker < 2**31:
            raise ValueError('VOICEVOXの話者を選択してください。')
        if type(speed) not in (int, float) or not math.isfinite(speed) or not 0.5 <= speed <= 2:
            raise ValueError('読み上げ速度は0.5〜2にしてください。')
        params = urllib.parse.urlencode({'text': text, 'speaker': speaker})
        query = json.loads(self._voicevox('/audio_query?' + params, body=b'', limit=2 * 1024 * 1024))
        query.update(speedScale=speed, outputSamplingRate=24000, outputStereo=False)
        wav = self._voicevox('/synthesis?' + urllib.parse.urlencode({'speaker': speaker}), body=json.dumps(query).encode())
        if wav[:4] != b'RIFF' or wav[8:12] != b'WAVE':
            raise RuntimeError('VOICEVOXが有効なWAV音声を返しませんでした。')
        return wav

    def subtitles(self, video_id, language):
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id or '') or language not in ('ja', 'en'):
            raise ValueError('動画IDまたは字幕言語が不正です。')
        with tempfile.TemporaryDirectory(prefix='clipnest-subs-') as folder:
            args = ['--ignore-config', '--no-playlist', '--skip-download', '--write-subs', '--write-auto-subs',
                    '--sub-langs', language, '--sub-format', 'json3', '--socket-timeout', '10', '--retries', '1',
                    '--extractor-retries', '1', '--max-filesize', '5M',
                    '--output', str(Path(folder) / '%(id)s.%(ext)s'),
                    *self.youtube._runtime_arguments(), '--batch-file', '-']
            self.youtube._run(args, timeout=60, input_text=f'https://www.youtube.com/watch?v={video_id}\n')
            target = Path(folder) / f'{video_id}.{language}.json3'
            if not target.exists():
                raise RuntimeError('字幕を取得できませんでした。字幕なし・取得制限の可能性があります。SRT/VTT字幕ファイルを読み込むこともできます。')
            if target.stat().st_size > 5 * 1024 * 1024:
                raise ValueError('字幕が大きすぎます。')
            raw = json.loads(target.read_text(encoding='utf-8'))
        cues = []
        for entry in raw.get('events', []):
            text = html.unescape(''.join(str(seg.get('utf8', '')) for seg in entry.get('segs', []))).strip()
            start = float(entry.get('tStartMs', 0)) / 1000
            end = start + float(entry.get('dDurationMs', 0)) / 1000
            if text and math.isfinite(start) and math.isfinite(end) and 0 <= start < end:
                cues.append({'start': start, 'end': end, 'text': text})
        if not cues:
            raise RuntimeError('読み上げ可能な字幕がありません。')
        if len(cues) > 4000:
            raise ValueError('字幕は4000件まで対応しています。')
        return {'videoId': video_id, 'language': language, 'cues': cues}
