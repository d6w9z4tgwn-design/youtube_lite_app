"""Pinned resources for the optional, personal-use RVC environment."""
from pathlib import Path
import hashlib
import os
import tempfile
import urllib.request
from urllib.parse import urlsplit

ENGINE_REVISION = '7fa68ec2166ab1331c539704159fa14901e94e5a'
MODEL_REVISION = '723073a4634626a3595aaa98816c7f14262eddda'
RESOURCE_REVISION = '774d3d1f46102030638bc27d3a95cda6f68cf293'
MODEL_CARD = 'https://huggingface.co/kuwacom/RVC-Models'
MODEL_TERMS = 'https://zunko.jp/multimodal_dev/login.php'
RESOURCES = [
    ('engine/rvc/models/embedders/contentvec/config.json', f'https://huggingface.co/IAHispano/Applio/resolve/{RESOURCE_REVISION}/Resources/embedders/contentvec/config.json', '2ddde063b795d38d9051a7215a092fecf4cfe148b54251e38de51d88d356898b', 1388),
    ('engine/rvc/models/embedders/contentvec/pytorch_model.bin', f'https://huggingface.co/IAHispano/Applio/resolve/{RESOURCE_REVISION}/Resources/embedders/contentvec/pytorch_model.bin', 'd8dd400e054ddf4e6be75dab5a2549db748cc99e756a097c496c099f65a4854e', 378342945),
    ('engine/rvc/models/predictors/rmvpe.pt', f'https://huggingface.co/IAHispano/Applio/resolve/{RESOURCE_REVISION}/Resources/predictors/rmvpe.pt', '6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193', 181184272),
    ('separation/955717e8-8726e21a.th', 'https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th', '8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4', 84141911),
]
ZUNDAMON = [
    ('model.pth', 'faf5a0e7bbfcec4493458b513b03db9b1d530ababdbfc6f9e8e6314e10c9634b', 55224656),
    ('model.index', 'da2fffd5446a78ad8415d2b16bd360c94e8a89ea8d6383583c45751154f16bb2', 31588619),
]


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def allowed_download(url):
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return False
    host = parsed.hostname or ''
    return (parsed.scheme == 'https' and not parsed.username and not parsed.password
            and port in (None, 443) and (host in {'huggingface.co', 'dl.fbaipublicfiles.com'}
            or host.endswith('.huggingface.co') or host.endswith('.hf.co') or host.endswith('.xethub.hf.co')))


class ModelRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed_download(newurl):
            raise ValueError('モデル取得先の転送を拒否しました。')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, target, sha, limit):
    target = Path(target)
    if target.is_file() and digest(target).startswith(sha):
        return
    if not allowed_download(url):
        raise ValueError('モデル取得先を確認してください。')
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix='.download-', dir=target.parent)
    try:
        count = 0
        opener = urllib.request.build_opener(ModelRedirect())
        with os.fdopen(fd, 'wb') as out, opener.open(url, timeout=60) as response:
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > limit:
                    raise ValueError('モデルのサイズが上限を超えています。')
                out.write(chunk)
        if not digest(name).startswith(sha):
            raise ValueError('モデルのSHA-256が一致しません。')
        os.replace(name, target)
    finally:
        Path(name).unlink(missing_ok=True)
