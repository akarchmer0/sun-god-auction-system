#!/usr/bin/env python3
"""Local Sherpa-ONNX worker used by Gavel's browser server.

It accepts newline-delimited JSON on stdin and returns a speaker embedding for
each float32 PCM request. The process never writes recordings or embeddings to
disk; the browser keeps enrolled embeddings in IndexedDB.
"""

from __future__ import annotations

import base64
import json
import sys
import traceback
from pathlib import Path

import numpy as np
import sherpa_onnx


PROJECT_DIR = Path(__file__).resolve().parent
MODEL_PATH = PROJECT_DIR / "vendor" / "sherpa-models" / "3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx"
MIN_SECONDS = 1.2


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def make_extractor() -> sherpa_onnx.SpeakerEmbeddingExtractor:
    if not MODEL_PATH.is_file():
        raise RuntimeError(f"Speaker model is missing: {MODEL_PATH}")
    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(MODEL_PATH),
        num_threads=2,
        debug=False,
        provider="cpu",
    )
    if not config.validate():
        raise RuntimeError("The local speaker-recognition model could not be initialized.")
    return sherpa_onnx.SpeakerEmbeddingExtractor(config)


def compute_embedding(extractor: sherpa_onnx.SpeakerEmbeddingExtractor, request: dict) -> list[float]:
    sample_rate = int(request.get("sampleRate", 16000))
    if sample_rate < 8000 or sample_rate > 48000:
        raise ValueError("Unsupported microphone sample rate.")
    raw = base64.b64decode(request["pcmBase64"], validate=True)
    samples = np.frombuffer(raw, dtype=np.float32)
    if len(samples) < int(sample_rate * MIN_SECONDS):
        raise ValueError("Keep speaking for at least two seconds so Gavel can identify the bidder.")
    samples = np.ascontiguousarray(np.nan_to_num(samples, nan=0.0, posinf=0.0, neginf=0.0))
    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate=sample_rate, waveform=samples)
    stream.input_finished()
    if not extractor.is_ready(stream):
        raise ValueError("That clip was too short for speaker recognition. Please try again.")
    embedding = np.asarray(extractor.compute(stream), dtype=np.float32)
    return embedding.tolist()


def main() -> None:
    try:
        extractor = make_extractor()
        emit({"type": "ready", "dimension": extractor.dim})
    except Exception as error:  # The Node server surfaces this as a useful startup error.
        emit({"type": "startup-error", "error": str(error)})
        traceback.print_exc(file=sys.stderr)
        return

    for line in sys.stdin:
        try:
            request = json.loads(line)
            request_id = request["id"]
            embedding = compute_embedding(extractor, request)
            emit({"id": request_id, "embedding": embedding})
        except Exception as error:
            emit({"id": request.get("id") if "request" in locals() else None, "error": str(error)})


if __name__ == "__main__":
    main()
