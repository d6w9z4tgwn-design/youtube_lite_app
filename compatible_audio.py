"""Bounded, temporary AAC remux cache for Safari's progressive MP4 path."""
from contextlib import contextmanager
from pathlib import Path
import re
import shutil
import subprocess
from app_runtime import subprocess_options
import tempfile
import threading
import time
import urllib.request
import atexit


class CompatibleAudio:
    MAX_BYTES = 256 * 1024 * 1024

    def __init__(self):
        self.directory = None
        self.lock = threading.Lock()
        self.cached = []

    @contextmanager
    def open(self, video_id, source_url):
        if not re.fullmatch(r"[\w-]{11}", video_id, flags=re.ASCII):
            raise ValueError("動画IDが不正です。")
        if not self.lock.acquire(timeout=180):
            raise RuntimeError("互換音声を準備中です。しばらくして再試行してください。")
        try:
            if self.directory is None:
                self.directory = tempfile.TemporaryDirectory(prefix="clipnest-aac-")
                atexit.register(self.directory.cleanup)
            output = Path(self.directory.name) / f"{video_id}.m4a"
            if not output.exists():
                ffmpeg = shutil.which("ffmpeg")
                if not ffmpeg:
                    raise RuntimeError("Safariの音声加工用にffmpegが必要です。ffmpegを導入してアプリを再起動してください。")
                with tempfile.TemporaryDirectory(dir=self.directory.name, prefix="build-") as work:
                    original = Path(work) / "source.m4a"
                    result = Path(work) / "result.m4a"
                    deadline = time.monotonic() + 180
                    with urllib.request.urlopen(source_url, timeout=30) as response, original.open("wb") as target:
                        expected = int(response.headers.get("Content-Length", 0))
                        if expected > self.MAX_BYTES:
                            raise RuntimeError("互換音声の上限256MBを超えています。長時間動画の音声加工にはChromeをご利用ください。")
                        total = 0
                        while chunk := response.read(64 * 1024):
                            total += len(chunk)
                            if total > self.MAX_BYTES or time.monotonic() > deadline:
                                raise RuntimeError("互換音声の準備が容量・時間の上限を超えました。")
                            target.write(chunk)
                        if expected and total != expected:
                            raise RuntimeError("音声の取得が途中で終了しました。再試行してください。")
                    subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-i", str(original),
                                    "-map", "0:a:0", "-c:a", "copy", "-movflags", "+faststart", str(result)],
                                   check=True, timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, **subprocess_options())
                    if not result.stat().st_size or result.stat().st_size > self.MAX_BYTES:
                        raise RuntimeError("互換音声を生成できませんでした。")
                    result.replace(output)
                self.cached.append(output)
                while len(self.cached) > 2:
                    self.cached.pop(0).unlink(missing_ok=True)
            with output.open("rb") as stream:
                yield stream, output.stat().st_size
        finally:
            self.lock.release()
