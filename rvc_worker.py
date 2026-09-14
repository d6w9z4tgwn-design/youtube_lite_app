"""Optional isolated inference worker. The application server never imports Torch."""
import argparse
import gc
from contextlib import redirect_stdout
from fractions import Fraction
import json
import io
import os
from pathlib import Path
import sys
import subprocess
import time
import zipfile

os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ.setdefault('HF_HUB_DISABLE_IMPLICIT_TOKEN', '1')
os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')
os.environ.setdefault('OMP_NUM_THREADS', '4')
os.environ.setdefault('NUMBA_NUM_THREADS', '4')


def validate_model(path, index=None):
    import torch
    path = Path(path)
    if path.stat().st_size > 128 * 1024**2:
        raise ValueError('モデルは128MBまでです。')
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            if sum(item.file_size for item in archive.infolist()) > 512 * 1024**2:
                raise ValueError('モデルの展開サイズが上限を超えています。')
    # No pickle fallback, arbitrary classes, scripts, or trust_remote_code.
    model = torch.load(path, map_location='cpu', weights_only=True)
    if not isinstance(model, dict) or not isinstance(model.get('weight'), dict):
        raise ValueError('RVCの推論用モデルではありません。')
    config, weight = model.get('config'), model['weight']
    version = model.get('version', 'v1')
    if version not in ('v1', 'v2') or not isinstance(config, list) or len(config) != 18:
        raise ValueError('対応形式は標準RVC v1/v2（HiFi-GAN）です。')
    if model.get('vocoder', 'HiFi-GAN') != 'HiFi-GAN' or config[-1] not in (32000, 40000, 48000):
        raise ValueError('このモデルのボコーダー・サンプルレートは未対応です。')
    if any(not isinstance(value, torch.Tensor) for value in weight.values()):
        raise ValueError('モデルの重みを確認できません。')
    if any(not torch.isfinite(value).all() for value in weight.values()):
        raise ValueError('モデルに不正な重みが含まれています。')
    embedding = weight.get('emb_g.weight')
    if embedding is None or embedding.ndim != 2 or not 1 <= embedding.shape[0] <= 1024:
        raise ValueError('話者情報が不正です。')
    # Reject unrealistic architecture sizes before the constructor can allocate them.
    if any(type(config[i]) is not int or not 1 <= config[i] <= 4096 for i in (0, 1, 2, 3, 4, 5, 6, 7, 13, 15, 16)):
        raise ValueError('モデルの構成が未対応です。')
    if index:
        if Path(index).stat().st_size > 256 * 1024**2:
            raise ValueError('indexは256MBまでです。')
        subprocess.run([sys.executable, str(Path(__file__).resolve()), '--validate-index', str(index),
                        '--dimension', str(768 if version == 'v2' else 256)], check=True, capture_output=True, timeout=30)
    return {'version': version, 'sampleRate': config[-1], 'speakers': int(embedding.shape[0])}


def check(root):
    root = Path(root)
    sys.path.insert(0, str(root / 'engine'))
    from rvc.lib.algorithm.synthesizers import Synthesizer
    from rvc.lib.utils import HubertModelWithFinalProj
    from rvc.lib.predictors.RMVPE import RMVPE0Predictor
    from demucs.apply import apply_model
    from rvc_assets import RESOURCES, digest
    for relative, _, sha, _ in RESOURCES:
        if not digest(root / relative).startswith(sha):
            raise ValueError('解析・人声分離用モデルの検証に失敗しました。')
    return {'available': True}


def retrieve_index(path, dimension=None):
    # Never load FAISS's OpenMP runtime into the Torch process (macOS deadlock).
    import faiss
    import numpy as np
    faiss.omp_set_num_threads(1)
    index = faiss.read_index(path)
    if index.d not in (256, 768) or not 8 <= index.ntotal <= 500_000 or index.d * index.ntotal > 100_000_000:
        raise ValueError('indexの形式・サイズが未対応です。')
    if dimension:
        if index.d != dimension:
            raise ValueError('indexとモデルの次元が一致しません。')
        return
    features = np.load(io.BytesIO(sys.stdin.buffer.read(32 * 1024**2)), allow_pickle=False)
    if features.ndim != 2 or features.shape[1] != index.d or features.shape[0] > 4000:
        raise ValueError('検索する特徴量のサイズが不正です。')
    if hasattr(index, 'nprobe'):
        index.nprobe = min(8, index.nlist)
    distance, indices = index.search(np.ascontiguousarray(features, dtype=np.float32), 8)
    vectors = index.reconstruct_n(0, index.ntotal)
    weights = np.where(indices >= 0, 1 / np.maximum(distance, 1e-6)**2, 0)
    totals = weights.sum(1, keepdims=True)
    weights /= np.maximum(totals, 1e-12)
    retrieved = (vectors[np.maximum(indices, 0)] * weights[..., None]).sum(1)
    retrieved[totals[:, 0] == 0] = features[totals[:, 0] == 0]
    result = io.BytesIO(); np.save(result, retrieved.astype(np.float32), allow_pickle=False)
    sys.stdout.buffer.write(result.getvalue())


def infer_voice(samples, root, synthesizer, hubert, version, use_f0, target_rate, request, device, predictor):
    """Standard RVC feature/pitch inference, with isolated optional retrieval."""
    import numpy as np
    import torch
    import torch.nn.functional as functional
    from scipy import signal
    b, a = signal.butter(5, 48, btype='high', fs=16000)
    padded = np.pad(signal.filtfilt(b, a, samples).astype(np.float32), (16000, 16000), mode='reflect')
    encoded = hubert(torch.from_numpy(padded).to(device)[None], output_hidden_states=True)
    features = encoded.hidden_states[9 if version == 'v1' else 12]
    if version == 'v1':
        features = hubert.final_proj(features)
    original = features.clone()
    index_rate = request.get('indexRate', 0.65)
    if request.get('index') and index_rate > 0:
        data = io.BytesIO(); np.save(data, features[0].cpu().numpy(), allow_pickle=False)
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--retrieve-index', request['index']],
                                input=data.getvalue(), capture_output=True, check=True, timeout=45)
        retrieved = np.load(io.BytesIO(result.stdout), allow_pickle=False)
        features = index_rate * torch.from_numpy(retrieved).to(device)[None] + (1 - index_rate) * original
    features = functional.interpolate(features.transpose(1, 2), scale_factor=2).transpose(1, 2)
    length = min(len(padded) // 160, features.shape[1])
    coarse = fine = None
    if use_f0:
        f0 = predictor.infer_from_audio(padded, thred=0.03)[:length].astype(np.float32)
        f0 *= 2 ** (request.get('pitch', 0) / 12)
        length = min(length, len(f0))
        mel = 1127 * np.log1p(f0 / 700)
        lower, upper = 1127 * np.log1p(50 / 700), 1127 * np.log1p(1100 / 700)
        coarse = torch.from_numpy(np.rint(np.clip((mel - lower) * 254 / (upper - lower) + 1, 1, 255)).astype(np.int64)).to(device)[None]
        fine = torch.from_numpy(f0).to(device)[None]
        original = functional.interpolate(original.transpose(1, 2), scale_factor=2).transpose(1, 2)
        protection = torch.where(fine > 0, 1.0, 0.33)[..., None]
        features = features[:, :length] * protection + original[:, :length] * (1 - protection)
    output = synthesizer.infer(features[:, :length].float(), torch.tensor([length], device=device),
                               coarse, fine, torch.tensor([0], device=device))[0][0, 0].cpu().float().numpy()
    output = output[target_rate:-target_rate]
    # Preserve the source loudness envelope, with a bounded gain in quiet intervals.
    import librosa
    source_rms = librosa.feature.rms(y=samples, frame_length=16000, hop_length=8000)[0]
    target_rms = librosa.feature.rms(y=output, frame_length=target_rate, hop_length=target_rate // 2)[0]
    positions = np.linspace(0, 1, len(output))
    source_envelope = np.interp(positions, np.linspace(0, 1, len(source_rms)), source_rms)
    target_envelope = np.interp(positions, np.linspace(0, 1, len(target_rms)), target_rms)
    output *= np.clip((source_envelope / np.maximum(target_envelope, 1e-6)) ** 0.75, 0, 8)
    return output


class InferenceModels:
    """One model/device set at a time, reused by sequential chunks only."""
    def __init__(self):
        self.key = None
        self.values = None

    def clear(self):
        self.key = self.values = None
        gc.collect()
        import torch
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def get(self, root, request, device):
        import numpy as np
        import torch
        from demucs.htdemucs import HTDemucs
        from demucs.states import load_model
        from rvc.lib.algorithm.synthesizers import Synthesizer
        from rvc.lib.utils import HubertModelWithFinalProj
        from rvc.lib.predictors.RMVPE import RMVPE0Predictor
        path = Path(request['model'])
        stat = path.stat()
        key = (str(root), str(path), stat.st_mtime_ns, stat.st_size, device)
        if key == self.key:
            return self.values, True
        if self.values:
            self.clear()
        with torch.serialization.safe_globals([HTDemucs, Fraction, np.core.multiarray.scalar, np.dtype,
                                               type(np.dtype('float64')), type(np.dtype('float32')), type(np.dtype('int64'))]):
            package = torch.load(root / 'separation/955717e8-8726e21a.th', map_location='cpu', weights_only=True)
        if package.get('klass') is not HTDemucs:
            raise ValueError('人声分離モデルの形式が異なります。')
        separator = load_model(package).to(device).eval()
        checkpoint = torch.load(path, map_location='cpu', weights_only=True)
        config = list(checkpoint['config'])
        config[-3] = checkpoint['weight']['emb_g.weight'].shape[0]
        version, use_f0 = checkpoint.get('version', 'v1'), checkpoint.get('f0', 1)
        synthesizer = Synthesizer(*config, use_f0=use_f0, text_enc_hidden_dim=768 if version == 'v2' else 256)
        del synthesizer.enc_q
        incompatible = synthesizer.load_state_dict(checkpoint['weight'], strict=False)
        if incompatible.missing_keys or any(not key.startswith('enc_q.') for key in incompatible.unexpected_keys):
            raise ValueError('RVCモデルの重みと変換エンジンが一致しません。')
        synthesizer = synthesizer.to(device).float().eval()
        hubert = HubertModelWithFinalProj.from_pretrained(str(root / 'engine/rvc/models/embedders/contentvec'), local_files_only=True).to(device).float().eval()
        predictor = RMVPE0Predictor(str(root / 'engine/rvc/models/predictors/rmvpe.pt'), device=device) if use_f0 else None
        self.values = (separator, synthesizer, hubert, predictor, version, use_f0, config[-1])
        self.key = key
        return self.values, False


def convert(request, models=None):
    import numpy as np
    import soundfile as sf
    import soxr
    import torch
    from demucs.apply import apply_model
    root, output = Path(request['root']), Path(request['output'])
    sys.path.insert(0, str(root / 'engine'))
    from app_runtime import atomic_json

    def stage(name):
        atomic_json(output / 'progress.json', {'stage': name})

    torch.set_num_threads(4)
    started = time.monotonic()
    device = request.get('device', 'auto')
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'
    if device == 'mps' and not torch.backends.mps.is_available():
        raise ValueError('この環境ではApple GPUを利用できません。CPUを選択してください。')
    if device == 'cuda' and not torch.cuda.is_available():
        raise ValueError('この環境ではCUDAを利用できません。CPUを選択してください。')
    audio, sr = sf.read(request['input'], dtype='float32', always_2d=True)
    if sr != 44100 or audio.shape[1] != 2 or len(audio) > 34 * sr or len(audio) < sr // 5:
        raise ValueError('変換区間の音声形式・長さが不正です。')
    stage('モデルを準備中')
    models = models or InferenceModels()
    values, reused = models.get(root, request, device)
    separator, synthesizer, hubert, predictor, version, use_f0, target_rate = values
    prepared = time.monotonic()
    stage('人声とBGMを分離中')
    wav = torch.from_numpy(audio.T.copy())
    reference = wav.mean(0)
    mean, std = reference.mean(), reference.std().clamp_min(1e-6)
    with torch.inference_mode():
        stems = apply_model(separator, ((wav - mean) / std)[None], device=device,
                            shifts=0, split=True, overlap=0.25, segment=7.8, progress=False)[0].cpu()
        stems = stems * std + mean
    vocal = stems[separator.sources.index('vocals')].numpy().T
    # Subtraction preserves the original stereo residual instead of separately normalizing BGM.
    background = audio - vocal
    del stems, wav
    separated = time.monotonic()
    stage('RVCで声を変換中')
    mono = soxr.resample(vocal.mean(axis=1), sr, 16000, quality='VHQ').astype(np.float32)
    if np.max(np.abs(mono)) < 1e-5:
        converted = np.zeros(len(audio), dtype=np.float32)
    else:
        with torch.inference_mode():
            converted = infer_voice(mono, root, synthesizer, hubert, version, use_f0, target_rate, request, device, predictor)
        # Applio returns float PCM; only resample by the declared sample rate, never by file duration.
        converted = soxr.resample(converted.astype(np.float32), target_rate, sr, quality='VHQ')
        if abs(len(converted) - len(audio)) > sr // 4:
            raise ValueError('変換音声の長さが一致しません。再試行してください。')
        converted = np.pad(converted[:len(audio)], (0, max(0, len(audio) - len(converted))))
    stage('再生用の音声を準備中')
    left = round(request['trimStart'] * sr)
    count = min(round(request['seconds'] * sr), len(audio) - left)
    if count <= 0:
        raise ValueError('再生する区間がありません。')
    converted, background = converted[left:left + count], background[left:left + count]
    if not np.isfinite(converted).all() or not np.isfinite(background).all():
        raise ValueError('変換結果に不正な値があります。')
    # Float WAV preserves headroom; the existing player remains the single volume control.
    sf.write(output / 'voice.wav', converted, sr, subtype='FLOAT')
    sf.write(output / 'background.wav', background, sr, subtype='FLOAT')
    return {'duration': count / sr, 'processingSeconds': round(time.monotonic() - started, 2),
            'deviceUsed': device, 'modelsReused': reused,
            'timings': {'prepare': round(prepared - started, 3), 'separation': round(separated - prepared, 3),
                        'conversion': round(time.monotonic() - separated, 3)}}


def serve():
    """Private stdin/stdout protocol. No listener, external commands or downloads."""
    import traceback
    models = InferenceModels()
    # Preserve the line protocol across third-party libraries that print to stdout.
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with redirect_stdout(sys.stderr):
                result = convert(request, models)
            response = {'result': result}
        except Exception:
            traceback.print_exc(file=sys.stderr)
            models.clear()
            response = {'error': '変換に失敗しました。CPU設定・モデル・空き容量を確認してください。'}
        print(json.dumps(response, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--validate')
    parser.add_argument('--index')
    parser.add_argument('--check')
    parser.add_argument('--validate-index')
    parser.add_argument('--retrieve-index')
    parser.add_argument('--dimension', type=int)
    parser.add_argument('--serve', action='store_true')
    args = parser.parse_args()
    if args.serve:
        serve()
        return
    if args.validate_index or args.retrieve_index:
        retrieve_index(args.validate_index or args.retrieve_index, args.dimension if args.validate_index else None)
        return
    with redirect_stdout(sys.stderr):
        if args.validate:
            result = validate_model(args.validate, args.index)
        elif args.check:
            result = check(args.check)
        else:
            result = convert(json.load(sys.stdin))
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
