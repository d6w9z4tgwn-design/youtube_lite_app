# Build on the target OS; never include a workspace/data directory wholesale.
import os
from pathlib import Path
import sys
from PyInstaller.utils.hooks import collect_all, collect_data_files, copy_metadata

root = Path(SPECPATH)
sys.path.insert(0, str(root))
from version import APP_VERSION
sys.path.insert(0, str(root / 'scripts'))
from release import source_files

voice = os.environ.get('CLIPNEST_BUILD_VOICE') == '1'
data = [(str(path), str(path.relative_to(root).parent)) for path in source_files() if path.relative_to(root).parts[0] == 'static']
data += [(str(root / 'THIRD_PARTY_NOTICES.md'), '.'),
        (str(root / 'licenses'), 'licenses'), (os.environ['CLIPNEST_NOTICES_DIR'], 'dependency-notices')]
if (root / 'LICENSE').is_file():
    data.append((str(root / 'LICENSE'), '.'))
binaries, hidden = [], []
for package in ['yt_dlp', 'yt_dlp_ejs', 'certifi'] + (['faster_whisper', 'ctranslate2', 'tokenizers', 'av'] if voice else []):
    package_data, package_binaries, package_hidden = collect_all(package)
    data.extend(package_data)
    binaries.extend(package_binaries)
    hidden.extend(package_hidden)
for distribution in ['yt-dlp', 'yt-dlp-ejs', 'certifi'] + (['faster-whisper'] if voice else []):
    data.extend(copy_metadata(distribution, recursive=True))

a = Analysis([str(root / 'launcher.py')], pathex=[str(root)], binaries=binaries, datas=data,
             hiddenimports=hidden, excludes=['tkinter', 'mutagen', 'pytest', 'IPython', 'matplotlib'] + ([] if voice else ['faster_whisper']),
             noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='ClipNest', console=True,
          debug=False, strip=False, upx=False, argv_emulation=False)
collection = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='ClipNest')
if sys.platform == 'darwin':
    app = BUNDLE(collection, name='ClipNest.app', bundle_identifier='local.clipnest.desktop',
                 version=APP_VERSION, info_plist={'CFBundleShortVersionString': APP_VERSION,
                 'NSHighResolutionCapable': True})
