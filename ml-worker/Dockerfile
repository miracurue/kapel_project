# Сервис ml-worker: только точная версия образа (build-rules, раздел 2).
FROM python:3.12.14-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    TOKENIZERS_PARALLELISM=false \
    ML_WORKER_MODELS_DIR=/models \
    HF_HOME=/tmp/hf

# Tesseract, poppler (pdftoppm) и ffmpeg — отдельные программы из Debian
# bookworm (GPL — только как отдельные процессы, 16-license-policy.md).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng \
        poppler-utils ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.lock ./
# Зависимости закреплены с хешами (--require-hashes); torch CPU — с
# закреплённого индекса download.pytorch.org, без CUDA-пакетов.
RUN pip install --require-hashes \
    --index-url https://download.pytorch.org/whl/cpu \
    --extra-index-url https://pypi.org/simple \
    -r requirements.lock

# modeling_gigaam.py импортирует pyannote внутри transcribe_longform (нужен токен HF, мы его
# не используем), но transformers проверяет такие импорты при загрузке модели и без пакета
# отказывается её грузить. Пустая заглушка снимает проверку; при вызове longform упадёт
# ImportError — наш код его не вызывает (нарезка своя, см. 04-technologies).
RUN mkdir -p /usr/local/lib/python3.12/site-packages/pyannote \
    && echo "# заглушка: см. ml-worker/Dockerfile" > /usr/local/lib/python3.12/site-packages/pyannote/__init__.py

COPY app.py fetch_models.py models.lock.json ./

# Не root: сервис только читает том моделей и пишет во временный каталог.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin ml \
    && mkdir -p /models \
    && chown -R ml:ml /app /models

USER ml
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python3", "-c", "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"]
# Один процесс: одна расшифровка одновременно (12-architecture, ml-worker).
CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
