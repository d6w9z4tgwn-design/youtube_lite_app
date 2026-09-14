"""Local-only benchmark; never sends the supplied audio to an external service."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
from app_runtime import data_directory
from rvc_service import RVCService


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True, help='Local test audio; looped only in temporary benchmark files')
    parser.add_argument('--seconds', type=int, default=20, choices=range(1, 31))
    parser.add_argument('--devices', default='cpu,mps')
    parser.add_argument('--repeat', type=int, default=2, choices=range(1, 5))
    args = parser.parse_args()
    devices = args.devices.split(',')
    if any(device not in ('cpu', 'mps', 'cuda', 'auto') for device in devices):
        parser.error('Unknown device')
    for device in devices:
        service = RVCService(data_directory(), APP)
        try:
            selected = service.models()[0]
            model, metadata = service.model(selected['id'])
            with tempfile.TemporaryDirectory(prefix='clipnest-rvc-benchmark-') as temporary:
                folder = Path(temporary)
                subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-stream_loop', '-1', '-i', str(args.input.resolve()),
                    '-t', str(args.seconds + 2), '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', str(folder / 'input.wav')], check=True)
                request = {'root': str(service.root), 'model': str(model / 'model.pth'),
                    'index': str(model / 'model.index') if metadata.get('indexSha256') else '',
                    'input': str(folder / 'input.wav'), 'output': str(folder), 'device': device,
                    'trimStart': 1, 'seconds': args.seconds, 'indexRate': .65, 'pitch': 0}
                for iteration in range(args.repeat):
                    began = time.monotonic()
                    result = service.worker.infer(request, threading.Event(), lambda process: None, timeout=180)
                    assert abs(result['duration'] - args.seconds) < .001
                    print(json.dumps({'iteration': iteration + 1, 'wallSeconds': round(time.monotonic() - began, 3), **result}), flush=True)
        finally:
            service.close()


if __name__ == '__main__':
    main()
