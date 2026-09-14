"""Allowlisted source packaging and pre-publication privacy checks."""
import argparse
import hashlib
from pathlib import Path
import re
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from version import APP_VERSION

ROOT_FILES = {'app.py', 'app_runtime.py', 'launcher.py', 'version.py', 'ytdlp_update.py',
              'youtube_service.py', 'library_service.py', 'related_service.py', 'compatible_audio.py',
              'dubbing_service.py', 'transcription_service.py', 'asr_worker.py', 'ClipNest.spec',
              'requirements.txt', 'requirements-voice.txt', 'requirements-build.txt', '.gitignore',
              'README.md', 'README_MODULES.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE',
              'CHANGELOG.md', 'RELEASING.md', 'SECURITY.md', 'CONTRIBUTING.md'}
DIRECTORIES = {'static': {'.js', '.css', '.html', '.svg', '.txt'}, 'tests': {'.py', '.cjs', '.mjs'},
               'scripts': {'.py'}, '.github': {'.yml', '.yaml'}, 'licenses': {'.txt'}}
PRIVATE = re.compile(r'(^|/)(data|node_modules|\.venv[^/]*|__pycache__|archive)/|\.(sqlite[^/]*|db|log|wav|mp3|m4a|mp4|webm|pem|key|p12|pfx)$|(^|/)(settings\.json|cookies[^/]*|\.env[^/]*)$', re.I)
SECRET = re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}')


def source_files():
    files = [ROOT / name for name in sorted(ROOT_FILES) if (ROOT / name).is_file()]
    for directory, suffixes in DIRECTORIES.items():
        for path in sorted((ROOT / directory).rglob('*')):
            if path.is_file() and path.suffix in suffixes and not PRIVATE.search(path.relative_to(ROOT).as_posix()):
                files.append(path)
    return files


def audit(require_license=False):
    if require_license and not (ROOT / 'LICENSE').is_file():
        raise SystemExit('LICENSEが未確定です。公開ライセンスを選んでからリリースしてください。')
    failures = []
    for path in source_files():
        name = path.relative_to(ROOT).as_posix()
        if path.is_symlink() or PRIVATE.search(name) or SECRET.search(path.read_bytes()):
            failures.append(name)
    git = subprocess.run(['git', '-C', str(ROOT), 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
    if git.returncode == 0:
        if Path(git.stdout.strip()).resolve() != ROOT.resolve():
            raise SystemExit('親ディレクトリ全体ではなくClipNest専用のGitリポジトリを作ってください。')
        tracked = subprocess.check_output(['git', '-C', str(ROOT), 'ls-files', '-z']).decode().split('\0')
        for name in filter(None, tracked):
            path = ROOT / name
            if PRIVATE.search(name) or (path.is_file() and SECRET.search(path.read_bytes())):
                failures.append(name)
    if failures:
        raise SystemExit('公開対象を確認してください（自動削除はしません）: ' + ', '.join(sorted(set(failures))))
    print(f'Privacy audit passed: {len(source_files())} allowlisted source files. Manually review content/history before publishing.')


def source_archive(require_license=True):
    audit(require_license)
    output = ROOT / 'release'
    output.mkdir(exist_ok=True)
    target = output / f'ClipNest-{APP_VERSION}-source.zip'
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in source_files():
            archive.write(path, f'ClipNest-{APP_VERSION}/' + path.relative_to(ROOT).as_posix())
    print(target.name)


def checksums():
    for path in sorted((ROOT / 'release').glob('*.zip')):
        print(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['audit', 'source', 'checksums'])
    parser.add_argument('--require-license', action='store_true')
    args = parser.parse_args()
    if args.command == 'audit': audit(args.require_license)
    elif args.command == 'source': source_archive()
    else: checksums()
