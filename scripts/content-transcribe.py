"""Local-only content dictation. Install faster-whisper in a dedicated venv."""
import json, os, sys
from faster_whisper import WhisperModel
model = WhisperModel(os.environ.get('CONTENT_WHISPER_MODEL', 'base.en'), device='cpu', compute_type='int8', cpu_threads=4)
if sys.argv[1] == '--prepare':
    print('Local dictation model ready')
else:
    segments, info = model.transcribe(sys.argv[1], beam_size=1, vad_filter=True)
    if info.duration > 125:
        raise ValueError('Recording exceeds two minutes')
    print(json.dumps({'text': ' '.join(s.text.strip() for s in segments).strip()}))
