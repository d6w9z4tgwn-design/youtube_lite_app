"""Launch the bundle with isolated data; verify bundled yt-dlp and local HTTP."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from version import APP_VERSION


def main():
    binary = ROOT / 'dist' / ('ClipNest.app/Contents/MacOS/ClipNest' if sys.platform == 'darwin' else 'ClipNest/ClipNest.exe' if sys.platform == 'win32' else 'ClipNest/ClipNest')
    with tempfile.TemporaryDirectory(prefix='clipnest-smoke-') as directory:
        env = {**os.environ, 'CLIPNEST_DATA_DIR': directory}
        env.pop('YTDLP_PATH', None)
        result = subprocess.run([str(binary), '--worker', 'yt-dlp', '--version'], env=env, capture_output=True, text=True, timeout=45, check=True)
        assert result.stdout.strip(), 'Bundled yt-dlp worker did not report a version'
        if '--voice' in sys.argv:
            check = subprocess.run([str(binary), '--worker', 'asr', '--check'], env=env, capture_output=True, text=True, timeout=90, check=True)
            assert 'Whisper worker ready' in check.stdout
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        process = subprocess.Popen([str(binary), '--no-browser', '--port', str(port)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        url = f'http://127.0.0.1:{port}'
        try:
            for attempt in range(100):
                if process.poll() is not None:
                    raise AssertionError('Bundle exited before startup')
                try:
                    with urllib.request.urlopen(url + '/api/status', timeout=10) as response:
                        status = json.load(response)
                    break
                except OSError:
                    time.sleep(0.2)
            else: raise AssertionError('Bundle startup timed out')
            assert status['appVersion'] == APP_VERSION
            assert status['ytDlp']['available'], status
            for route in ('/', '/core/settings_ui.js', '/core/dubbing_settings.js', '/core/module_ui.js', '/api/modules'):
                with urllib.request.urlopen(url + route, timeout=10) as response:
                    assert response.status == 200
            for route, fields in (
                ('/api/settings', {'defaultRate'}),
                ('/api/dubbing/settings', {'voicevoxPort', 'whisperModel'}),
            ):
                with urllib.request.urlopen(url + route, timeout=10) as response:
                    assert set(json.load(response)['settings']) == fields
            with urllib.request.urlopen(url + '/api/diagnostics', timeout=10) as response:
                diagnostics = json.load(response)
                assert 'whisper' not in diagnostics and 'voicevoxReachable' not in diagnostics
            assert (Path(directory) / 'settings.json').is_file()
            assert (Path(directory) / 'clipnest.sqlite3').is_file()
            request = urllib.request.Request(url + '/api/quit', data=b'{}', headers={'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(request, timeout=5) as response:
                assert response.status == 200
            assert process.wait(timeout=10) == 0
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
    print('PASS: standalone worker, HTTP/assets, isolated setup and graceful quit')


if __name__ == '__main__':
    main()
