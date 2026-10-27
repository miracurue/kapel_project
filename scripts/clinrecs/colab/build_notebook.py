"""Build a standalone Colab notebook from the reviewed Python pipeline."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def cell(kind, text):
    result = {"cell_type": kind, "metadata": {}, "source": text.splitlines(keepends=True)}
    if kind == "code":
        result.update(execution_count=None, outputs=[])
    return result


cells = [
    cell("markdown", """# Клинреки → Markdown + таблицы + изображения (Colab GPU)

Самодостаточный ноутбук: загружать отдельный `.py` или клонировать проект не нужно.
В меню **Среда выполнения → Сменить тип среды выполнения → T4 GPU** включите GPU,
затем выполняйте ячейки сверху вниз. Первый запуск скачивает модели.

Предоставленные документы: `0540e25c52977eca81007182ae8146fd.pdf` — 125 страниц,
`1e242790a59b9e5c571386bea45fe13a.pdf` — 121 страница. По умолчанию: части максимум
по 10 страниц, OCR ru/en, таблицы ACCURATE, изображения, без Grobid/LLM.
В первом документе 19 верхних закладок; во втором встроенного оглавления нет.

Каждая успешная часть сохраняется сразу. По умолчанию результаты и PDF остаются
в Google Drive. После обрыва повторите ячейки с теми же параметрами: готовые части
с проверенными файлами будут пропущены. При OOM часть делится пополам вплоть до
одной страницы. При жёстком завершении Colab прогресс сохранён до последней части;
если одна часть снова убивает среду, уменьшите CHUNK_PAGES (это начнёт отдельный запуск).

Результат требует сверки с PDF: особенно дозировки, знаки, таблицы, схемы, шкалы и
границы частей. `complete` подтверждает покрытие страниц, а не клиническую точность.
"""),
    cell("code", """# 1. Установка. Штатные CUDA-сборки torch/torchvision Colab не переустанавливаем вручную.
import subprocess
import sys
subprocess.run([sys.executable, "-m", "pip", "install", "-q",
                "docling==2.103.0", "docling-core==2.82.0",
                "easyocr==1.7.2", "pypdf==6.13.3"], check=True)
import torch
import torchvision
import easyocr
print("torch:", torch.__version__, "torchvision:", torchvision.__version__)
if not torch.cuda.is_available():
    raise RuntimeError("Включите T4 GPU в настройках среды выполнения Colab.")
print("GPU:", torch.cuda.get_device_name(0))
"""),
    cell("code", """# 2. Настройки. Для первой пробы можно задать END_PAGE = 10, затем вернуть None.
USE_DRIVE = True  # Рекомендуется: checkpoints переживут перезапуск/обрыв Colab.
INPUT_MODE = "upload"  # "upload": выбрать PDF с компьютера; "drive": брать PDF из INPUT_DIR.
CHUNK_PAGES = 10
START_PAGE = 1
END_PAGE = None  # None = весь документ; 10 = проба первых 10 страниц.
FORCE_FULL_PAGE_OCR = False  # True — отдельная попытка для PDF с плохим текстовым слоем.
FORMULAS = False  # True — отдельная модель формул, больше GPU-памяти и времени.
IMAGES_SCALE = 1.5

from pathlib import Path
if USE_DRIVE:
    from google.colab import drive
    drive.mount("/content/drive")
    WORK_DIR = Path("/content/drive/MyDrive/clinical_compass_clinrecs")
else:
    WORK_DIR = Path("/content/clinical_compass_clinrecs")
    print("ВНИМАНИЕ: без Drive обрыв среды удалит результаты и checkpoints.")
INPUT_DIR = WORK_DIR / "input"
OUTPUT_DIR = WORK_DIR / "parsed"
INPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
print("PDF:", INPUT_DIR)
print("Результаты:", OUTPUT_DIR)
"""),
    cell("code", """# 3. Встроенный скрипт. Ячейка только записывает Python-файл в /content.
%%PIPELINE_PLACEHOLDER%%
"""),
    cell("code", """# 4. Загрузка/выбор PDF. INPUT_MODE='drive' позволяет продолжать без повторной загрузки.
import os
from google.colab import files
if INPUT_MODE == "upload":
    previous_dir = Path.cwd()
    try:
        os.chdir(INPUT_DIR)
        uploaded = files.upload()
        pdf_paths = [INPUT_DIR / Path(name).name for name in uploaded if name.lower().endswith(".pdf")]
        del uploaded
    finally:
        os.chdir(previous_dir)
elif INPUT_MODE == "drive":
    pdf_paths = sorted(INPUT_DIR.glob("*.pdf"))
else:
    raise ValueError("INPUT_MODE должен быть upload или drive")
if not pdf_paths:
    raise RuntimeError("PDF не выбраны. Загрузите файлы или поместите их в INPUT_DIR.")
for path in pdf_paths:
    print(path.name)
"""),
    cell("code", """# 5. Предварительная проверка PDF без загрузки моделей.
import importlib.util
spec = importlib.util.spec_from_file_location("clinrecs_pipeline", "/content/clinrecs_pipeline.py")
pipeline = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = pipeline
spec.loader.exec_module(pipeline)
settings = pipeline.Settings(chunk_pages=CHUNK_PAGES, start_page=START_PAGE, end_page=END_PAGE,
                             force_full_page_ocr=FORCE_FULL_PAGE_OCR, formulas=FORMULAS,
                             images_scale=IMAGES_SCALE)
for path in pdf_paths:
    reader, info = pipeline.inspect_pdf(path)
    print(path.name, "| страниц:", info["pages"], "| закладок:", len(info["outline"]),
          "| мало текста на страницах:", info["low_text_pages"])
    del reader
print("Параметры:", settings)
print("Распознавание моделей запускается в следующей ячейке.")
"""),
    cell("code", """# 6. Парсинг. Повторный запуск продолжает с проверенных checkpoints.
# Выполняйте одну копию ноутбука для одной папки результатов.
run_dirs = []
run_errors = []
converter = None
for path in pdf_paths:
    try:
        if converter is None:
            with pipeline.heartbeat("Инициализация моделей"):
                converter = pipeline.build_converter(settings)
        root, report = pipeline.run_document(path, OUTPUT_DIR, settings, converter=converter)
        run_dirs.append(root)
        print(path.name, "→", report["status"], "| страниц:", report["converted_pages"],
              "| пропуски:", report["missing_pages"], "| для сверки:", len(report["pages_to_review"]))
    except Exception as exc:
        run_errors.append({"pdf": path.name, "error": str(exc)})
        print("ОШИБКА:", path.name, str(exc))
if run_errors:
    print("Ошибки документов:", run_errors)
print("Файлы сохранялись по ходу обработки в", OUTPUT_DIR)
"""),
    cell("code", """# 7. Архив результатов текущего запуска и скачивание.
import json
import zipfile
from datetime import datetime, timezone
stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
zip_path = Path("/content") / f"clinrecs_docling_{stamp}.zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("run_errors.json", json.dumps(run_errors, ensure_ascii=False, indent=2))
    for root in run_dirs:
        for path in sorted(root.rglob("*")):
            if path.is_file() and not path.name.endswith(".tmp"):
                archive.write(path, (Path(root.name) / path.relative_to(root)).as_posix())
print("Архив:", zip_path, "| МБ:", round(zip_path.stat().st_size / 1024**2, 2))
files.download(str(zip_path))
"""),
    cell("markdown", """## Что смотреть в результате

- `document.md` — полный текст выбранного диапазона, маркеры `<!-- page: N -->`,
  ссылки на PNG; пропущенные страницы явно отмечены. Номера относятся к страницам PDF с 1.
- `pages.jsonl` — страницы с абсолютными/локальными номерами, Markdown и предупреждениями.
- `images/` — изображения с уникальными именами по диапазонам страниц.
- `chunks/p0001_0010/docling.json` — исходная структура Docling с локальными номерами,
  координатами и встроенными изображениями; JSON разных частей не склеивается по ID.
- `chunks/.../table_*.html`, `tables.json` — таблицы HTML и привязки к PDF.
- `manifest.json`, `outline.json` — SHA-256 исходника, настройки, версии, закладки.
- `quality_report.json`, `REPORT.md` — полнота, пропуски, предупреждения, границы частей.
- `chunks/.../checkpoint.json`, `split.json` — состояние для продолжения.

`preview_complete` — обработан только выбранный диапазон, `incomplete` — есть пропуски.
Даже при `complete` нужна проверка распознавания по PDF. Колонтитулы и примечания
сохраняются; автоматической правки кириллицы, удаления литературы/ссылок, интерпретации
шкал или объединения таблиц через границы нет. Формулы по умолчанию без отдельной модели;
при необходимости включите FORMULAS и сравните качество.

Смена PDF, настроек, версии скрипта или основных пакетов создаёт отдельную папку.
После обрыва используйте те же параметры и `INPUT_MODE='drive'`. После пробы первых
10 страниц задайте `END_PAGE=None`: полный прогон будет в отдельной папке.

При ошибке импортов после установки перезапустите сеанс Colab и повторите ячейки.
Если скачивание ZIP не началось, архив лежит в `/content`, исходные результаты — в Drive.
"""),
]
source = (HERE / "clinrecs_pipeline.py").read_text(encoding="utf-8")
cells[3] = cell("code", "%%writefile /content/clinrecs_pipeline.py\n" + source)
notebook = {"nbformat": 4, "nbformat_minor": 5,
            "metadata": {"accelerator": "GPU", "colab": {"name": "colab_clinrecs_docling_pipeline.ipynb"},
                         "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}},
            "cells": cells}
for i, c in enumerate(cells):
    c["id"] = f"clinrecs-{i:02d}"
(HERE / "colab_clinrecs_docling_pipeline.ipynb").write_text(
    json.dumps(notebook, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
