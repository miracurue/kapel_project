# Сервис ml-worker (W-29, веха В4 «ИИ»): речь в текст (M-03), OCR (M-04),
# выделение имён для псевдонимизации (M-06). Отдельный Python-контейнер во
# внутренней сети Docker без выхода в интернет; наружу открыт только Caddy.
#
# Безопасность:
# - каждый запрос, кроме GET /health, требует общий токен ML_WORKER_TOKEN
#   (заголовок Authorization: Bearer ... или X-ML-Worker-Token) — тот же
#   контракт, что у подделки tests/lib/fakes/ml_worker.js;
# - журналы не содержат текстов и файлов запросов (PD-17): только факт
#   вызова, размер, длительность и статус;
# - файлы моделей лежат на томе «только для чтения» и перед включением
#   проверяются по sha256 из models.lock.json; GigaAM закреплён на коммите
#   7655ad717f8122257385bb4b2f373db3697e8680 и загружается с
#   local_files_only=True и HF_HUB_OFFLINE=1 (trust_remote_code — только
#   после просмотра modeling_gigaam.py, см. README).
#
# Деградация: если моделей нет или проверка sha256 не прошла, сервис
# стартует, /health сообщает о недостающих частях, а /stt и /ner отвечают
# 503 — приложение тогда работает по правилам (E-STT-UNAVAILABLE,
# E-PSEUDO-NER-DOWN). STAND-IN: реальные модели в автотестах не запускаются
# (build-rules, раздел 6); контракты /stt, /ocr, /ner, /health сверены с
# tests/lib/fakes/ml_worker.js.

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import wave
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MODELS_DIR = Path(os.environ.get("ML_WORKER_MODELS_DIR", "/models"))
LOCK_FILE = Path(__file__).with_name("models.lock.json")
MAX_STT_BYTES = int(os.environ.get("ML_WORKER_STT_MAX_BYTES", 60 * 1024 * 1024))
MAX_OCR_BYTES = int(os.environ.get("ML_WORKER_OCR_MAX_BYTES", 25 * 1024 * 1024))
MAX_NER_BYTES = 256 * 1024
MAX_STT_SECONDS = int(os.environ.get("ML_WORKER_STT_MAX_SECONDS", 15 * 60))

CHUNK_SECONDS = 22.0     # куски ≤ 22 с (запас до предела 25 с у transcribe)
OVERLAP_SECONDS = 1.0    # перекрытие при жёстком разрезе без паузы
VAD_THRESHOLD = 0.5
VAD_MIN_SILENCE_MS = 300
VAD_SPEECH_PAD_MS = 200
NOT_RECOGNIZED = "[не распознано]"

logging.basicConfig(level=os.environ.get("ML_WORKER_LOG_LEVEL", "INFO"))
_log = logging.getLogger("ml-worker")


def log_event(event: str, **detail) -> None:
    """Журнал без ПДн (PD-17): событие и числа, никаких текстов запросов."""
    _log.info(json.dumps({"event": event, **detail}, ensure_ascii=False, default=str))


TOKEN = os.environ.get("ML_WORKER_TOKEN", "")


def require_token(request: Request) -> None:
    """Без токена — 401; /health намеренно открыт (как у подделки в тестах)."""
    if not TOKEN:
        raise HTTPException(status_code=401, detail={"error": "token_not_configured"})
    auth = request.headers.get("authorization", "")
    if auth == f"Bearer {TOKEN}" or request.headers.get("x-ml-worker-token") == TOKEN:
        return
    raise HTTPException(status_code=401, detail={"error": "unauthorized"})


async def read_upload(file: UploadFile, limit: int) -> bytes:
    """Чтение загруженного файла с лимитом размера (записи на диск до проверки)."""
    size = 0
    parts = []
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > limit:
            raise HTTPException(status_code=413, detail={"error": "too_large"})
        parts.append(chunk)
    return b"".join(parts)


# ---------------------------------------------------------------------------
# Проверка файлов моделей по models.lock.json

_lock_cache = None
_lock_guard = threading.Lock()


def load_lock() -> dict:
    global _lock_cache
    with _lock_guard:
        if _lock_cache is None:
            _lock_cache = json.loads(LOCK_FILE.read_text(encoding="utf-8"))
        return _lock_cache


def sha256_of(path: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def verify_group(group: str) -> dict:
    """Проверенные файлы группы моделей; при любой проблеме — {} и запись в журнал."""
    try:
        entries = load_lock()[group]["files"]
    except Exception:
        log_event("models_lock_error", group=group)
        return {}
    files = {}
    for entry in entries:
        path = MODELS_DIR / entry["path"]
        sha = entry.get("sha256", "")
        if not sha:
            log_event("model_hash_missing", group=group, path=entry["path"])
            return {}
        if not path.is_file():
            return {}
        if sha256_of(path) != sha or path.stat().st_size != entry.get("size"):
            log_event("model_hash_mismatch", group=group, path=entry["path"])
            return {}
        files[path] = entry
    return files


state = {"stt_ready": False, "ner_ready": False, "stt": None, "ner": None}
stt_lock = asyncio.Lock()  # одна расшифровка одновременно, остальные ждут в очереди


def try_load_models() -> None:
    """Загрузка моделей только с тома, без сети. Сбой не останавливает сервис."""
    if verify_group("gigaam_v3_e2e_rnnt"):
        try:
            from transformers import AutoModel

            model = AutoModel.from_pretrained(
                str(MODELS_DIR / "gigaam_v3_e2e_rnnt"),
                trust_remote_code=True,
                local_files_only=True,
            )
            model.eval()
            state["stt"] = model
            state["stt_ready"] = True
            log_event("stt_loaded")
        except Exception:
            log_event("stt_load_failed")
    else:
        log_event("stt_absent")

    ner_files = verify_group("natasha_ner")
    if ner_files:
        try:
            from navec import Navec
            from slovnet import NER

            emb = next(p for p in ner_files if "navec" in p.name)
            pack = next(p for p in ner_files if "slovnet" in p.name)
            ner = NER.load(str(pack))
            ner.navec(Navec.load(str(emb)))
            state["ner"] = ner
            state["ner_ready"] = True
            log_event("ner_loaded")
        except Exception:
            log_event("ner_load_failed")
    else:
        log_event("ner_absent")


# ---------------------------------------------------------------------------
# Звук: ffmpeg, VAD, нарезка по паузам (M-03)

def ffmpeg_to_wav(src: Path, dst: Path) -> float:
    """Перекодирование в wav 16 кГц моно; возвращает длительность в секундах."""
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-ar", "16000", "-ac", "1", str(dst)],
        capture_output=True,
        timeout=600,
    )
    if proc.returncode != 0:
        raise HTTPException(status_code=415, detail={"error": "audio_unreadable"})
    with wave.open(str(dst), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def read_wav(path: Path):
    import torch

    with wave.open(str(path), "rb") as w:
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())
    audio = torch.frombuffer(bytearray(frames), dtype=torch.int16).float() / 32768.0
    return audio, rate


def vad_segments(audio, rate: int) -> list:
    """silero-vad: порог 0,5; минимальная пауза 300 мс; поля по 200 мс с краёв
    отрезков речи (04-technologies, M-03, пункт 2)."""
    from silero_vad import get_speech_timestamps, load_silero_vad

    model = load_silero_vad()
    found = get_speech_timestamps(
        audio,
        model,
        sampling_rate=rate,
        threshold=VAD_THRESHOLD,
        min_silence_duration_ms=VAD_MIN_SILENCE_MS,
        speech_pad_ms=VAD_SPEECH_PAD_MS,
    )
    return [(c["start"] / rate, c["end"] / rate) for c in found]


def silence_segments_ffmpeg(wav: Path, total: float) -> list:
    """Запасной путь без VAD: паузы ищет ffmpeg silencedetect (M-03, пункт 7)."""
    proc = subprocess.run(
        [
            "ffmpeg", "-v", "info", "-i", str(wav),
            "-af", "silencedetect=noise=-35dB:d=0.3", "-f", "null", "-",
        ],
        capture_output=True,
        text=True,
        timeout=600,
    )
    starts = [float(m) for m in re.findall(r"silence_start: ([0-9.]+)", proc.stderr)]
    ends = [float(m) for m in re.findall(r"silence_end: ([0-9.]+)", proc.stderr)]
    speech = []
    cursor = 0.0
    for s, e in zip(starts, ends):
        if s > cursor:
            speech.append((cursor, s))
        cursor = e
    if len(ends) > len(starts) and cursor < total:
        speech.append((cursor, total))
    if not speech and proc.returncode == 0:
        speech = [(0.0, min(total, CHUNK_SECONDS))]
    return speech


def longest_pause(lo: float, hi: float, segments: list) -> float | None:
    """Центр самой длинной паузы внутри [lo, hi] (по отрезкам речи)."""
    gaps = []
    prev = lo
    for s, e in segments:
        if e <= lo:
            continue
        if s >= hi:
            break
        gap_end = min(hi, s)
        if gap_end > prev:
            gaps.append((gap_end - prev, (prev + gap_end) / 2))
        prev = max(prev, e)
    if not gaps:
        return None
    return max(gaps)[1]


def build_chunks(segments: list, total: float) -> list:
    """Сборка кусков ≤ 22 с (04-technologies, M-03, пункты 3–4).

    Соседние отрезки речи объединяются, пока кусок ≤ 22 с; разрез ставится в
    самой длинной паузе внутри последних 5 с перед границей; речи без пауз
    дольше 22 с режутся жёстко с перекрытием 1 с.
    """
    segs = [(max(0.0, s), min(total, e)) for s, e in segments if e > s]
    segs.sort()
    chunks: list = []
    cur_start = None
    cur_end = None

    def hard_split(a: float, b: float) -> None:
        pos = a
        while pos < b:
            stop = min(pos + CHUNK_SECONDS, b)
            chunks.append((pos, stop))
            if stop >= b:
                break
            pos = stop - OVERLAP_SECONDS

    for s, e in segs:
        if cur_start is None:
            if e - s > CHUNK_SECONDS:
                hard_split(s, e)
            else:
                cur_start, cur_end = s, e
            continue
        if e - cur_start <= CHUNK_SECONDS:
            cur_end = e
            continue
        # (s, e) не влезает: закрываем текущий кусок в ближайшей паузе
        cut = longest_pause(max(cur_start, cur_end - 5.0), cur_end, segs)
        if cut is None or cut <= cur_start + 1.0:
            cut = cur_start + CHUNK_SECONDS
        chunks.append((cur_start, cut))
        cur_start, cur_end = cut, cur_end
        if e - cur_start <= CHUNK_SECONDS:
            cur_end = e
        else:
            chunks.append((cur_start, cur_end))
            cur_start = None
            if e - s > CHUNK_SECONDS:
                hard_split(s, e)
            else:
                cur_start, cur_end = s, e
    if cur_start is not None:
        if cur_end - cur_start > CHUNK_SECONDS:
            hard_split(cur_start, cur_end)
        else:
            chunks.append((cur_start, cur_end))
    return [(a, b) for a, b in chunks if b - a > 0.05]


_SENTENCE_END = ".!?…"


def join_texts(texts: list) -> str:
    """Склейка кусков пробелом; совпадающие слова на стыке удаляются, первая
    буква следующего куска становится строчной, если предложение не закрыто
    (04-technologies, M-03, пункты 4 и 6)."""
    out = ""
    for text in texts:
        text = (text or "").strip()
        if not text:
            continue
        if not out:
            out = text
            continue
        tail = out.split()[-3:]
        head = text.split()
        overlap = 0
        for n in (3, 2, 1):
            if len(tail) >= n and len(head) >= n and [w.lower() for w in tail[-n:]] == [
                w.lower() for w in head[:n]
            ]:
                overlap = n
                break
        if overlap:
            text = " ".join(head[overlap:])
            if not text:
                continue
        if out[-1] not in _SENTENCE_END and text[:1].isupper():
            text = text[:1].lower() + text[1:]
        out = f"{out} {text}"
    return out


def cut_wav(src: Path, dst: Path, start: float, end: float) -> None:
    with wave.open(str(src), "rb") as r:
        rate = r.getframerate()
        width = r.getsampwidth()
        channels = r.getnchannels()
        r.setpos(int(start * rate))
        frames = r.readframes(max(0, int((end - start) * rate)))
    with wave.open(str(dst), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(frames)


def transcribe_chunk(model, wav_path: Path):
    """STAND-IN: вызов GigaAM.transcribe по README модели (модель принимает
    путь к wav 16 кГц моно). Реальное поведение проверяется на машине
    владельца после загрузки моделей; сбой куска даёт пометку «[не распознано]»,
    а не потерю расшифровки (M-03, пункт 7)."""
    try:
        return model.transcribe(str(wav_path)) or ""
    except Exception:
        log_event("stt_chunk_failed")
        return None


# ---------------------------------------------------------------------------
# OCR (M-04): Tesseract rus+eng; скан-PDF — сначала pdftoppm


def ocr_file(data: bytes, workdir: Path):
    if data[:5] == b"%PDF-":
        pdf = workdir / "doc.pdf"
        pdf.write_bytes(data)
        subprocess.run(
            ["pdftoppm", "-r", "200", "-png", str(pdf), str(workdir / "page")],
            check=True,
            capture_output=True,
            timeout=300,
        )
        pages = sorted(workdir.glob("page-*.png"))
        texts = []
        for page in pages:
            proc = subprocess.run(
                ["tesseract", str(page), "stdout", "-l", "rus+eng"],
                capture_output=True,
                text=True,
                timeout=300,
            )
            texts.append(proc.stdout.strip())
        return "\n".join(t for t in texts if t), len(pages)
    if data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n":
        img = workdir / "img"
        img.write_bytes(data)
        proc = subprocess.run(
            ["tesseract", str(img), "stdout", "-l", "rus+eng"],
            capture_output=True,
            text=True,
            timeout=300,
        )
        return proc.stdout.strip(), 1
    raise HTTPException(status_code=415, detail={"error": "unsupported_file"})


# ---------------------------------------------------------------------------
# NER (M-06): Natasha (slovnet NER + navec) и правило для телефонов

PHONE_RE = re.compile(r"(?:\+7|8)[\s\-()]?\d{3}[\s\-()]?\d{3}[\s\-()]?\d{2}[\s\-()]?\d{2}")
TYPE_MAP = {"PER": "PERSON", "PERSON": "PERSON", "LOC": "LOC", "ORG": "ORG"}


def ner_entities(text: str) -> list:
    ner = state.get("ner")
    if ner is None:
        raise HTTPException(status_code=503, detail={"error": "ner_unavailable"})
    markup = ner(text)
    entities = []
    for span in markup.spans:
        etype = TYPE_MAP.get(span.type)
        if etype:
            entities.append(
                {
                    "type": etype,
                    "start": span.start,
                    "end": span.stop,
                    "text": text[span.start : span.stop],
                }
            )
    for m in PHONE_RE.finditer(text):
        entities.append({"type": "PHONE", "start": m.start(), "end": m.end(), "text": m.group()})
    entities.sort(key=lambda e: e["start"])
    return entities


# ---------------------------------------------------------------------------
# Приложение и маршруты


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Модели тяжёлые: грузим в отдельном потоке, /health отвечает сразу.
    threading.Thread(target=try_load_models, name="model-loader", daemon=True).start()
    yield


app = FastAPI(title="clinical-compass ml-worker", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.get("/health")
async def health():
    ocr_ok = bool(shutil.which("tesseract")) and bool(shutil.which("pdftoppm"))
    models = {
        "stt": "gigaam_e2e_rnnt" if state["stt_ready"] else "absent",
        "ocr": "tesseract" if ocr_ok else "absent",
        "ner": "natasha" if state["ner_ready"] else "absent",
    }
    ok = all(v != "absent" for v in models.values())
    return {"status": "ok" if ok else "degraded", "models": models}


@app.post("/stt")
async def stt(request: Request, file: UploadFile):
    started = time.monotonic()
    require_token(request)
    if not state["stt_ready"]:
        log_event("stt", status=503, duration_ms=round((time.monotonic() - started) * 1000))
        raise HTTPException(status_code=503, detail={"error": "stt_unavailable"})
    data = await read_upload(file, MAX_STT_BYTES)
    async with stt_lock:  # очередь: одна расшифровка за раз
        result = {"text": "", "segments": [], "status": "empty"}
        total = 0.0
        chunk_count = 0
        with tempfile.TemporaryDirectory(prefix="stt-", dir="/tmp") as tmp:
            workdir = Path(tmp)
            src = workdir / "input"
            src.write_bytes(data)
            wav = workdir / "audio.wav"
            total = ffmpeg_to_wav(src, wav)
            if total > MAX_STT_SECONDS:
                raise HTTPException(status_code=413, detail={"error": "too_long"})
            try:
                speech = vad_segments(*read_wav(wav))
            except Exception:
                log_event("vad_failed")  # запасной путь: паузы по ffmpeg
                speech = silence_segments_ffmpeg(wav, total)
            chunks = build_chunks(speech, total)
            chunk_count = len(chunks)
            texts = []
            segments_out = []
            for start, end in chunks:
                piece = workdir / "piece.wav"
                cut_wav(wav, piece, start, end)
                text = transcribe_chunk(state["stt"], piece)
                if text is None:
                    text = NOT_RECOGNIZED
                    result["status"] = "partial"
                texts.append(text)
                segments_out.append(
                    {"start": round(start, 2), "end": round(end, 2), "text": text}
                )
            full = join_texts(texts)
            if full.strip():
                result = {"text": full, "segments": segments_out, "status": result["status"]}
    log_event(
        "stt",
        bytes=len(data),
        seconds=round(total, 1),
        chunks=chunk_count,
        status=200,
        duration_ms=round((time.monotonic() - started) * 1000),
    )
    return result


@app.post("/ocr")
async def ocr(request: Request, file: UploadFile):
    started = time.monotonic()
    require_token(request)
    if not (shutil.which("tesseract") and shutil.which("pdftoppm")):
        log_event("ocr", status=503)
        raise HTTPException(status_code=503, detail={"error": "ocr_unavailable"})
    data = await read_upload(file, MAX_OCR_BYTES)
    with tempfile.TemporaryDirectory(prefix="ocr-", dir="/tmp") as tmp:
        text, pages = ocr_file(data, Path(tmp))
    log_event(
        "ocr",
        bytes=len(data),
        pages=pages,
        status=200,
        duration_ms=round((time.monotonic() - started) * 1000),
    )
    return {"text": text, "pages": pages, "status": "printed" if text else "empty"}


@app.post("/ner")
async def ner(request: Request):
    started = time.monotonic()
    require_token(request)
    body = await request.body()
    if len(body) > MAX_NER_BYTES:
        raise HTTPException(status_code=413, detail={"error": "too_large"})
    try:
        text = str(json.loads(body).get("text") or "")
    except Exception:
        raise HTTPException(status_code=400, detail={"error": "bad_request"})
    entities = ner_entities(text)
    log_event(
        "ner",
        chars=len(text),
        entities=len(entities),
        status=200,
        duration_ms=round((time.monotonic() - started) * 1000),
    )
    return {"entities": entities}


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    log_event(request.url.path.lstrip("/") or "request", status=exc.status_code)
    detail = exc.detail if isinstance(exc.detail, dict) else {"error": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content=detail)




