"""Frozen entry point. Workers must run before importing/starting the server."""
import multiprocessing
import os
from pathlib import Path
import sys


def main():
    multiprocessing.freeze_support()
    if sys.argv[1:2] == ['--worker']:
        for stream in (sys.stdin, sys.stdout, sys.stderr):
            if stream is not None and hasattr(stream, 'reconfigure'):
                stream.reconfigure(encoding='utf-8', errors='replace')
    if sys.argv[1:3] == ["--worker", "yt-dlp"]:
        import yt_dlp
        yt_dlp.main(sys.argv[3:])
        return
    if sys.argv[1:3] == ["--worker", "asr"]:
        from asr_worker import main as transcribe
        transcribe()
        return
    if getattr(sys, "frozen", False) and os.name == "nt" and "--no-browser" not in sys.argv:
        import ctypes
        # Keep a console bootloader for piped workers, but hide its GUI window.
        ctypes.windll.user32.ShowWindow(ctypes.windll.kernel32.GetConsoleWindow(), 0)
    try:
        from app import main as serve
        serve()
    except (OSError, RuntimeError) as exc:
        from app_runtime import StartupError
        message = str(exc) if isinstance(exc, StartupError) else "ClipNestを起動できませんでした。保存先のアクセス権・空き容量・settings.jsonを確認してください。データを削除せず、別名で保管してから再起動してください。"
        if sys.stderr:
            print(message, file=sys.stderr)
        if getattr(sys, "frozen", False):
            if os.name == "nt":
                import ctypes
                ctypes.windll.user32.MessageBoxW(None, message, "ClipNest", 0x10)
            elif sys.platform == "darwin":
                import subprocess
                subprocess.run(["/usr/bin/osascript", "-e", f'display alert "ClipNest" message "{message}"'], check=False)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
