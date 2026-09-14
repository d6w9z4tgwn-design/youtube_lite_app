"""Build with the target platform's Python 3.11 in a fresh venv."""
import argparse
from importlib import metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from version import APP_VERSION
from release import audit


def notices(voice):
    destination = ROOT / 'build' / ('dependency-notices-voice' if voice else 'dependency-notices-standard')
    destination.mkdir(parents=True, exist_ok=True)
    packages = []
    for distribution in metadata.distributions():
        name = distribution.metadata['Name']
        packages.append({'name': name, 'version': distribution.version,
                         'license': distribution.metadata.get('License-Expression') or distribution.metadata.get('License', ''),
                         'projectURLs': distribution.metadata.get_all('Project-URL', [])})
        for file in distribution.files or []:
            if any(part.lower().startswith(('license', 'copying', 'notice', 'authors')) for part in file.parts):
                source = Path(distribution.locate_file(file))
                if source.is_file():
                    target = destination / name / Path(*file.parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, target)
    (destination / 'packages.json').write_text(json.dumps(packages, ensure_ascii=False, indent=2), encoding='utf-8')
    # CPython's own license includes notices for bundled standard library code.
    import sysconfig
    candidates = [Path(sysconfig.get_path('stdlib')) / 'LICENSE.txt', Path(sys.base_prefix) / 'LICENSE.txt']
    python_license = next((path for path in candidates if path.is_file()), None)
    if python_license:
        shutil.copyfile(python_license, destination / 'Python-LICENSE.txt')
    else:
        # Some distro installations omit it: fetch the exact CPython version.
        import urllib.request
        url = f'https://raw.githubusercontent.com/python/cpython/v{platform.python_version()}/LICENSE'
        with urllib.request.urlopen(url, timeout=20) as response:
            (destination / 'Python-LICENSE.txt').write_bytes(response.read(256 * 1024))
    return destination


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--voice', action='store_true')
    parser.add_argument('--development', action='store_true', help='Allow an unsigned private build before LICENSE selection')
    args = parser.parse_args()
    if args.voice and not args.development:
        raise SystemExit('Voice版はPyAV/FFmpeg等のバイナリ配布条件・対応ソースの確認が未完了です。現在は--developmentでの非公開確認のみ可能です。')
    audit(require_license=not args.development)
    notice_directory = notices(args.voice)
    env = {**os.environ, 'CLIPNEST_BUILD_VOICE': '1' if args.voice else '0', 'CLIPNEST_NOTICES_DIR': str(notice_directory)}
    subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', 'ClipNest.spec'], cwd=ROOT, env=env, check=True)
    release = ROOT / 'release'
    release.mkdir(exist_ok=True)
    label = f'ClipNest-{APP_VERSION}-{sys.platform}-{platform.machine()}' + ('-Voice' if args.voice else '') + ('-private' if args.development else '')
    if sys.platform == 'darwin':
        subprocess.run(['/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(ROOT / 'dist' / 'ClipNest.app'), str(release / (label + '.zip'))], check=True)
    else:
        shutil.make_archive(str(release / label), 'zip', ROOT / 'dist', 'ClipNest')
    print('Built:', label + '.zip')


if __name__ == '__main__':
    main()
