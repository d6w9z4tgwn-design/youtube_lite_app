"""Explicit local setup only. Does not change public builds or bundle voice models."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app_runtime import atomic_json, data_directory
from rvc_assets import ENGINE_REVISION, MODEL_CARD, MODEL_REVISION, MODEL_TERMS, RESOURCES, ZUNDAMON, digest, download


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--zundamon-personal', action='store_true', help='Install the requested zundamon-1 model for private use, not redistribution')
    parser.add_argument('--skip-install', action='store_true', help='Dependencies were already installed in the dedicated environment')
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 11):
        raise SystemExit('セットアップはPython 3.11で実行してください。')
    root = data_directory() / 'rvc'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    environment = root / 'runtime'
    python = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not python.is_file():
        subprocess.run([sys.executable, '-m', 'venv', str(environment)], check=True)
    if not args.skip_install:
        if shutil.which('uv'):
            command = ['uv', 'pip', 'install', '--python', str(python)]
        else:
            command = [str(python), '-m', 'pip', 'install']
        subprocess.run([*command, '-r', str(ROOT / 'requirements-rvc.txt')], check=True)
    engine = root / 'engine'
    if not (engine / '.git').exists():
        subprocess.run(['git', 'init', str(engine)], check=True)
        subprocess.run(['git', '-C', str(engine), 'fetch', '--depth=1', 'https://github.com/IAHispano/Applio.git', ENGINE_REVISION], check=True)
        subprocess.run(['git', '-C', str(engine), 'checkout', '--detach', 'FETCH_HEAD'], check=True)
    revision = subprocess.check_output(['git', '-C', str(engine), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != ENGINE_REVISION:
        raise SystemExit('既存RVCエンジンの版が異なります。上書きせず停止しました。')
    for relative, url, sha, size in RESOURCES:
        print(f'Checking {relative}', flush=True)
        download(url, root / relative, sha, size)
    if args.zundamon_personal:
        print(f'Personal use only; not a public distribution: {MODEL_CARD}\n{MODEL_TERMS}', flush=True)
        model_id = ZUNDAMON[0][1][:32]
        folder = root / 'models' / model_id
        for filename, sha, size in ZUNDAMON:
            remote = 'zundamon-1.' + filename.rsplit('.', 1)[1]
            url = f'https://huggingface.co/kuwacom/RVC-Models/resolve/{MODEL_REVISION}/zundamon-1/{remote}'
            print(f'Checking {remote}', flush=True)
            download(url, folder / filename, sha, size)
        result = subprocess.run([str(python), str(ROOT / 'rvc_worker.py'), '--validate', str(folder / 'model.pth'), '--index', str(folder / 'model.index')], cwd=engine, capture_output=True, text=True, check=True)
        info = json.loads(result.stdout)
        atomic_json(folder / 'model.json', {**info, 'id': model_id, 'name': 'ずんだもん（zundamon-1・個人用）', 'sha256': ZUNDAMON[0][1], 'indexSha256': ZUNDAMON[1][1], 'source': MODEL_CARD, 'terms': MODEL_TERMS, 'personalOnly': True})
    subprocess.run([str(python), str(ROOT / 'rvc_worker.py'), '--check', str(root)], cwd=engine, check=True)
    atomic_json(root / 'ready.json', {'engineRevision': revision, 'schema': 1})
    print('RVC ready. Enable 「RVC 声変換」 in ClipNest. Public distribution files were not changed.')


if __name__ == '__main__':
    main()
