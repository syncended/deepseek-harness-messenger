"""Local-only audio decoder and faster-whisper JSONL worker.

No content is logged. stdout is a private parent/child protocol; stderr is muted
by the parent. Only model artifacts may be downloaded; decode/transcribe never
send audio to a service. The parent owns timeouts, cancellation and temp files.
"""
import gc
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path

logging.disable(logging.CRITICAL)

# Pin model revisions, not mutable repository branches. Repositories/revisions
# verified against https://huggingface.co/api/models/<repository>.
MODELS = {
    "tiny": ("Systran/faster-whisper-tiny", "d90ca5fe260221311c53c58e660288d3deb8d356"),
    "base": ("Systran/faster-whisper-base", "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"),
    "small": ("Systran/faster-whisper-small", "536b0662742c02347bc0e980a01041f333bce120"),
    "medium": ("Systran/faster-whisper-medium", "08e178d48790749d25932bbc082711ddcfdfbc4f"),
    "large-v3": ("Systran/faster-whisper-large-v3", "edaa852ec7e145841d8ffdb056a99866b5f0a478"),
    "turbo": ("dropbox-dash/faster-whisper-large-v3-turbo", "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"),
}
MAX_SECONDS = 300
RATE = 16000
MAX_TEXT = 32000
CURRENT_INPUT = None


def remove_current_input():
    global CURRENT_INPUT
    path = CURRENT_INPUT
    CURRENT_INPUT = None
    if path is not None:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass  # The parent also removes its private temporary directory.


class VoiceError(Exception):
    pass


def send(request_id, kind, **values):
    # Never print exceptions, file paths, audio, or transcripts outside this IPC.
    print(json.dumps({"id": request_id, "type": kind, **values}, ensure_ascii=False), flush=True)


def decode_bounded(path):
    """Count actual decoded samples, before VAD, without decoding an unbounded file."""
    import av
    import numpy as np

    samples = []
    count = 0
    resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=RATE)

    def append(frame):
        nonlocal count
        count += frame.samples
        if count > MAX_SECONDS * RATE:
            raise VoiceError("duration")
        samples.append(frame.to_ndarray().reshape(-1))

    try:
        # File-like IO plus a demuxer/protocol allowlist excludes network inputs
        # (e.g. a disguised HLS playlist). FFmpeg is bundled in the PyAV wheel.
        with open(path, "rb") as source:
            with av.open(source, mode="r", metadata_errors="ignore", options={
                "protocol_whitelist": "file,pipe",
                "format_whitelist": "ogg,mp3,wav,flac,matroska,webm,mov,aac,amr,aiff",
            }) as container:
                if not container.streams.audio:
                    raise VoiceError("audio")
                for frame in container.decode(audio=0):
                    frame.pts = None
                    for output in resampler.resample(frame):
                        append(output)
                for output in resampler.resample(None):
                    append(output)
        if not count:
            raise VoiceError("audio")
        return np.concatenate(samples).astype(np.float32) / 32768.0
    except VoiceError:
        raise
    except Exception:
        raise VoiceError("audio") from None
    finally:
        del resampler
        gc.collect()


def model_directory(name, cache, request_id):
    from faster_whisper.utils import download_model

    repository, revision = MODELS[name]
    directory = Path(cache) / (name + "-" + revision)
    complete = directory / ".complete"
    filenames = ["config.json", "model.bin", "tokenizer.json"]
    if name in ("large-v3", "turbo"):
        filenames += ["vocabulary.json", "preprocessor_config.json"]
    else:
        filenames += ["vocabulary.txt"]
    required = [directory / filename for filename in filenames]

    def artifacts_present():
        return all(path.is_file() and path.stat().st_size > 0 for path in required)

    if complete.is_file() and artifacts_present():
        return str(directory)
    send(request_id, "progress", code="model")
    try:
        download_model(repository, output_dir=str(directory), revision=revision, use_auth_token=False)
        if not artifacts_present():
            complete.unlink(missing_ok=True)
            raise VoiceError("model")
        staged = directory / (".complete-" + str(os.getpid()))
        try:
            staged.write_text(revision, encoding="utf-8")
            os.replace(staged, complete)
        finally:
            staged.unlink(missing_ok=True)
        return str(directory)
    except Exception:
        raise VoiceError("model") from None


def create_model(directory, device):
    from faster_whisper import WhisperModel
    import ctranslate2

    try:
        compute = "float16" if device == "cuda" else "int8"
        if compute not in ctranslate2.get_supported_compute_types(device):
            compute = "float32"
        return WhisperModel(directory, device=device, compute_type=compute,
                            cpu_threads=min(4, os.cpu_count() or 1), num_workers=1,
                            local_files_only=True)
    except Exception:
        if device == "cpu":
            (Path(directory) / ".complete").unlink(missing_ok=True)
        raise


def infer(model, audio):
    segments, _ = model.transcribe(audio, vad_filter=True, beam_size=5,
                                   condition_on_previous_text=False)
    parts = []
    count = 0
    for segment in segments:
        count += len(segment.text)
        if count > MAX_TEXT:
            raise VoiceError("inference")
        parts.append(segment.text)
    return "".join(parts).strip()


def parent_watchdog(parent_pid):
    # Also release native RAM/VRAM after an ungraceful host death while inference
    # is busy (stdin EOF alone is insufficient while the main thread is working).
    while True:
        time.sleep(1)
        if os.getppid() != parent_pid:
            remove_current_input()
            os._exit(0)


def main():
    global CURRENT_INPUT
    name, requested_device, cache = sys.argv[1:]
    if name not in MODELS or requested_device not in ("auto", "cpu", "cuda"):
        return 2
    threading.Thread(target=parent_watchdog, args=(os.getppid(),), daemon=True).start()
    model = None
    device = requested_device
    directory = None
    for line in sys.stdin:
        request_id = None
        audio = None
        try:
            if len(line) > 16384:
                return 2
            request = json.loads(line)
            request_id = request["id"]
            CURRENT_INPUT = request["path"]
            try:
                audio = decode_bounded(CURRENT_INPUT)
            finally:
                remove_current_input()
            if directory is None:
                directory = model_directory(name, cache, request_id)
            if model is None:
                send(request_id, "progress", code="loading")
                if requested_device == "auto":
                    try:
                        import ctranslate2
                        device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
                    except Exception:
                        device = "cpu"
                try:
                    model = create_model(directory, device)
                except Exception:
                    if requested_device == "auto" and device == "cuda":
                        device = "cpu"
                        send(request_id, "progress", code="cpu")
                        model = create_model(directory, device)
                    else:
                        raise VoiceError("cuda" if requested_device == "cuda" else "model") from None
            send(request_id, "progress", code="transcribing")
            try:
                text = infer(model, audio)
            except Exception:
                # CUDA libraries can fail on the first inference, not just load.
                if requested_device == "auto" and device == "cuda":
                    model = None
                    gc.collect()
                    device = "cpu"
                    send(request_id, "progress", code="cpu")
                    model = create_model(directory, device)
                    text = infer(model, audio)
                else:
                    raise VoiceError("cuda" if requested_device == "cuda" else "inference") from None
            send(request_id, "result", text=text)
            del text
        except VoiceError as error:
            send(request_id, "error", code=str(error))
        except Exception:
            send(request_id, "error", code="inference")
        finally:
            audio = None
            gc.collect()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # No traceback (which can include paths or attacker-controlled content).
        sys.exit(1)
