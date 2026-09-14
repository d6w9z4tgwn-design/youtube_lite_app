"""Isolated optional ASR worker. Input/output are JSON on stdin/stdout."""
import json
import sys


def main():
    from faster_whisper import WhisperModel
    if '--check' in sys.argv:
        print('Whisper worker ready')
        return
    request = json.load(sys.stdin)
    selected = request.get('model', 'base')
    if selected not in ('tiny', 'base', 'small'):
        raise ValueError('Invalid model')
    model = WhisperModel(selected, device='cpu', compute_type='int8', cpu_threads=4,
                         download_root=request['modelDirectory'], local_files_only=not request['downloadModel'])
    segments, info = model.transcribe(request['audio'], language=request['language'],
                                     vad_filter=True, beam_size=3, condition_on_previous_text=False)
    cues = []
    for segment in segments:
        text = segment.text.strip()
        if text and not (segment.no_speech_prob > 0.8 and segment.avg_logprob < -1):
            cues.append({'start': request['start'] + segment.start,
                         'end': request['start'] + segment.end, 'text': text})
    json.dump({'cues': cues, 'language': info.language}, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
