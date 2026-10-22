#!/usr/bin/env python3
"""Загрузчик файлов моделей для ml-worker (W-29).

Запускается на машине с доступом в интернет (сам сервис ml-worker в интернет
не выходит). Скачивает файлы ровно по адресам из ml-worker/models.lock.json,
сверяет размер и sha256 и складывает их в каталог моделей (том «только для
чтения» для контейнера). Файл без sha256 в lock-файле не скачивается: сначала
хеш записывается в models.lock.json после просмотра кода (modeling_gigaam.py).

Примеры:
    python3 fetch_models.py                      # скачать недостающее в /models
    ML_WORKER_MODELS_DIR=./models python3 fetch_models.py --check
"""

import argparse
import hashlib
import json
import os
import ssl
import sys
import urllib.request
from pathlib import Path

LOCK_FILE = Path(__file__).with_name("models.lock.json")
CHUNK = 1024 * 1024


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def safe_target(models_dir: Path, rel: str) -> Path:
    """Файлы моделей — только внутри каталога моделей, без выхода за него."""
    target = (models_dir / rel).resolve()
    if not str(target).startswith(str(models_dir.resolve()) + "/"):
        raise SystemExit(f"опасный путь в lock-файле: {rel}")
    return target


def download(url: str, target: Path, size: int, sha: str) -> bool:
    """Скачивание во временный файл, проверка размера и sha256, потом переименование."""
    tmp = target.with_suffix(target.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "cc-ml-worker-fetch/1"})
    with urllib.request.urlopen(request, timeout=120, context=ssl.create_default_context()) as resp:
        h = hashlib.sha256()
        total = 0
        with tmp.open("wb") as out:
            for block in iter(lambda: resp.read(CHUNK), b""):
                h.update(block)
                total += len(block)
                out.write(block)
    if size and total != size:
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"{target.name}: размер не совпал ({total} != {size})")
    if sha and h.hexdigest() != sha:
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"{target.name}: sha256 не совпал, файл удалён")
    tmp.replace(target)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="только проверить имеющиеся файлы, ничего не скачивать",
    )
    args = parser.parse_args()

    models_dir = Path(os.environ.get("ML_WORKER_MODELS_DIR", "/models"))
    lock = json.loads(LOCK_FILE.read_text(encoding="utf-8"))
    problems = 0
    for group, spec in lock.items():
        if group.startswith("_"):
            continue
        for entry in spec["files"]:
            sha = entry.get("sha256", "")
            if not sha:
                print(f"ОШИБКА: у {entry['path']} нет sha256 — сначала просмотрите файл и запишите хеш")
                problems += 1
                continue
            target = safe_target(models_dir, entry["path"])
            if target.is_file() and sha256_of(target) == sha:
                print(f"ok   {entry['path']}")
                continue
            if args.check:
                print(f"нет  {entry['path']}")
                problems += 1
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            print(f"качаю {entry['path']} ...")
            try:
                download(entry["url"], target, entry.get("size", 0), sha)
            except Exception as exc:  # noqa: BLE001 — ошибка сети не должна оставлять мусор
                print(f"ОШИБКА: {entry['path']}: {exc}")
                problems += 1
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
