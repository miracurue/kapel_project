"""Resumable Docling conversion for public clinical guideline PDFs; no app imports."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import gc
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import sys
import tempfile
import threading
import time

PIPELINE_VERSION = "1.0.0"


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def write_json(path, value):
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def environment():
    result = {"python": platform.python_version()}
    for package in ("docling", "docling-core", "pypdf", "easyocr", "torch", "torchvision"):
        try:
            result[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            result[package] = "not-installed"
    return result


@dataclass(frozen=True)
class Settings:
    chunk_pages: int = 10
    device: str = "cuda"
    force_full_page_ocr: bool = False
    formulas: bool = False
    images_scale: float = 1.5
    start_page: int = 1
    end_page: int | None = None

    def __post_init__(self):
        if self.chunk_pages < 1 or self.start_page < 1:
            raise ValueError("chunk_pages и start_page должны быть >= 1")
        if self.end_page is not None and self.end_page < self.start_page:
            raise ValueError("end_page < start_page")
        if self.device not in ("cuda", "cpu"):
            raise ValueError("device должен быть cuda или cpu")
        if self.images_scale <= 0:
            raise ValueError("images_scale должен быть > 0")


def ranges(start, end, size):
    """Inclusive, 1-based PDF page ranges with no overlap or gaps."""
    return [(page, min(page + size - 1, end)) for page in range(start, end + 1, size)]


def is_memory_error(exc):
    message = str(exc).lower()
    return isinstance(exc, MemoryError) or any(term in message for term in (
        "out of memory", "outofmemory", "bad_alloc", "bad allocation",
        "cannot allocate memory", "can't allocate memory", "cublas_status_alloc_failed",
    ))


def release_memory():
    gc.collect()
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_available():
        torch.cuda.empty_cache()


@contextmanager
def heartbeat(label):
    stop = threading.Event()
    started = time.monotonic()

    def tick():
        while not stop.wait(20):
            print(f"  {label}: {int(time.monotonic() - started)} с…", flush=True)

    thread = threading.Thread(target=tick, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=1)


def build_converter(settings):
    import torch
    from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import EasyOcrOptions, PdfPipelineOptions, TableFormerMode
    from docling.document_converter import DocumentConverter, PdfFormatOption

    if settings.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("GPU недоступен. Colab: Среда выполнения → Сменить тип → T4 GPU. "
                           "Для осознанного CPU-прогона задайте device='cpu'.")
    options = PdfPipelineOptions()
    options.accelerator_options = AcceleratorOptions(
        num_threads=2, device=AcceleratorDevice(settings.device))
    options.do_ocr = True
    options.ocr_options = EasyOcrOptions(
        lang=["ru", "en"], use_gpu=settings.device == "cuda",
        force_full_page_ocr=settings.force_full_page_ocr)
    options.do_table_structure = True
    options.table_structure_options.mode = TableFormerMode.ACCURATE
    options.table_structure_options.do_cell_matching = True
    options.do_formula_enrichment = settings.formulas
    options.generate_picture_images = True
    options.generate_page_images = False
    options.images_scale = settings.images_scale
    # Bound both GPU batches and the number of in-flight pages.
    for field in ("ocr_batch_size", "layout_batch_size", "table_batch_size"):
        if field in type(options).model_fields:
            setattr(options, field, 1)
    if "queue_max_size" in type(options).model_fields:
        options.queue_max_size = 2
    return DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})


def inspect_pdf(path):
    from pypdf import PdfReader
    reader = PdfReader(str(path))
    if reader.is_encrypted and not reader.decrypt(""):
        raise ValueError("PDF защищён паролем")
    counts = []
    for page in reader.pages:
        try:
            counts.append(len((page.extract_text() or "").strip()))
        except Exception:
            # битый поток содержимого: pypdf не разбирает страницу, Docling может;
            # считаем текст отсутствующим, страница уйдёт в список «мало текста»
            counts.append(0)
    outline = []

    def walk(nodes, depth=1):
        for node in nodes:
            if isinstance(node, list):
                walk(node, depth + 1)
            else:
                try:
                    page = reader.get_destination_page_number(node)
                    if page is not None and page >= 0:
                        outline.append({"title": str(node.title), "pdf_page": page + 1, "depth": depth})
                except (ValueError, KeyError, AttributeError):
                    continue
    walk(reader.outline)
    return reader, {"filename": Path(path).name, "sha256": sha256(path),
                    "pages": len(counts), "native_text_chars": counts,
                    "low_text_pages": [i + 1 for i, n in enumerate(counts) if n < 80],
                    "outline": outline}


def convert_chunk(converter, chunk_pdf, root, chunk_id, start, end, native_chars):
    """Keep native Docling JSON; export Markdown through the standard serializer."""
    from docling_core.types.doc import ContentLayer, ImageRefMode
    with heartbeat(f"Docling, стр. {start}–{end}"):
        result = converter.convert(str(chunk_pdf), raises_on_error=False)
    status = getattr(result.status, "value", str(result.status))
    if status != "success":
        details = "; ".join(str(error) for error in result.errors)
        raise RuntimeError(f"Docling status={status}: {details}")
    doc = result.document
    expected = set(range(1, end - start + 2))
    if set(doc.pages) != expected:
        raise RuntimeError(f"Неполный набор страниц Docling: {sorted(doc.pages)}, ожидается {sorted(expected)}")
    chunk_dir = root / "chunks" / chunk_id
    chunk_dir.mkdir(parents=True, exist_ok=True)
    # Native IDs and local page numbers are never concatenated across chunks.
    native_json = chunk_dir / "docling.json"
    doc.save_as_json(native_json, image_mode=ImageRefMode.EMBEDDED)
    artifacts = [native_json]
    warnings = []
    pictures_by_page = {}
    for index, picture in enumerate(doc.pictures, 1):
        pages = [start + prov.page_no - 1 for prov in picture.prov]
        for page in set(pages):
            pictures_by_page[page] = pictures_by_page.get(page, 0) + 1
        image = picture.get_image(doc)
        if image is None:
            warnings.append(f"picture_without_pixels:{index}:pages={pages}")
            continue
        relative = Path("images") / f"{chunk_id}_{index:04d}.png"
        (root / relative).parent.mkdir(parents=True, exist_ok=True)
        image.save(root / relative, format="PNG")
        artifacts.append(root / relative)
        # Only this in-memory copy receives root-relative image paths.
        picture.image = picture.image.model_copy(update={"uri": relative})
    tables = []
    for index, table in enumerate(doc.tables, 1):
        pages = sorted({start + prov.page_no - 1 for prov in table.prov})
        html_path = chunk_dir / f"table_{index:04d}.html"
        atomic_text(html_path, table.export_to_html(doc=doc))
        artifacts.append(html_path)
        tables.append({"local_ref": table.self_ref, "pdf_pages": pages,
                       "html": html_path.relative_to(root).as_posix()})
        if len(pages) > 1:
            warnings.append(f"multi_page_table:{index}:pages={pages}")
    page_records = []
    for local_page in sorted(expected):
        page = start + local_page - 1
        markdown = doc.export_to_markdown(
            page_no=local_page, image_mode=ImageRefMode.REFERENCED,
            included_content_layers={ContentLayer.BODY, ContentLayer.FURNITURE, ContentLayer.NOTES})
        flags = []
        if len(markdown.strip()) < 80:
            flags.append("low_markdown_content")
        if native_chars[page - 1] > 500 and len(markdown.strip()) < native_chars[page - 1] * 0.35:
            flags.append("possible_text_loss")
        if "<!-- image -->" in markdown:
            flags.append("image_placeholder_remaining")
        page_records.append({"pdf_page": page, "chunk_id": chunk_id,
                             "local_page": local_page, "markdown": markdown,
                             "native_text_chars": native_chars[page - 1],
                             "pictures": pictures_by_page.get(page, 0), "warnings": flags})
    return {"pages": page_records, "tables": tables, "warnings": warnings}, artifacts


def load_checkpoint(root, chunk_id):
    try:
        record = read_json(root / "chunks" / chunk_id / "checkpoint.json")
        for artifact, digest in record["artifacts"].items():
            if sha256(root / artifact) != digest:
                return None
        return record
    except (OSError, ValueError, KeyError):
        return None


def merge(root, source, settings, records, failures):
    pages = sorted([page for record in records for page in record["pages"]], key=lambda p: p["pdf_page"])
    end = min(settings.end_page or source["pages"], source["pages"])
    expected = list(range(settings.start_page, end + 1))
    actual = [page["pdf_page"] for page in pages]
    if len(actual) != len(set(actual)):
        raise RuntimeError("Дубли страниц: сборка остановлена")
    missing = sorted(set(expected) - set(actual))
    by_page = {page["pdf_page"]: page for page in pages}
    full_scope = settings.start_page == 1 and end == source["pages"]
    complete = not missing and not failures
    status = ("complete" if full_scope else "preview_complete") if complete else "incomplete"
    # Always write the same filename so a previous complete file cannot survive a failed rerun.
    lines = [f"<!-- conversion_status: {status}; source_sha256: {source['sha256']} -->"]
    for number in expected:
        lines.append(f"<!-- page: {number} -->")
        lines.append(by_page[number]["markdown"] if number in by_page else "<!-- FAILED: PAGE NOT CONVERTED -->")
    atomic_text(root / "document.md", "\n\n".join(lines) + "\n")
    atomic_text(root / "pages.jsonl", "".join(json.dumps(p, ensure_ascii=False) + "\n" for p in pages))
    tables = [dict(table, chunk_id=record["chunk_id"]) for record in records for table in record["tables"]]
    write_json(root / "tables.json", tables)
    quality_pages = [{k: v for k, v in p.items() if k != "markdown"} for p in pages if p["warnings"]]
    report = {"status": status, "complete_document": complete and full_scope,
              "source_pages": source["pages"], "selected_range": [settings.start_page, end],
              "converted_pages": len(pages), "missing_pages": missing, "failures": failures,
              "pages_to_review": quality_pages, "table_count": len(tables),
              "chunk_warnings": {r["chunk_id"]: r["warnings"] for r in records if r["warnings"]},
              "chunk_boundaries_to_review": [r["end"] for r in sorted(records, key=lambda r: r["start"]) if r["end"] < end],
              "review_required": True}
    write_json(root / "quality_report.json", report)
    atomic_text(root / "REPORT.md", "\n".join([
        "# Отчёт конвертации", "", f"Статус: **{status}**.",
        f"Обработано {len(pages)} из {len(expected)} выбранных страниц (в PDF {source['pages']}).",
        f"Пропущенные страницы: {missing}.", f"Части с ошибками: {len(failures)}.",
        f"Страниц с предупреждениями: {len(quality_pages)}. Таблиц: {len(tables)}.", "",
        "Подробности: quality_report.json. Номера страниц относятся к PDF, начиная с 1.",
        "Проверьте титул, дозировки, знаки ≥/≤, таблицы, схемы, шкалы и границы частей по PDF.",
        "Таблицы и абзацы через границу страниц/частей автоматически не объединяются.",
        "complete означает покрытие страниц, а не подтверждённую точность распознавания.", ""]))
    return report


def run_document(pdf_path, output_dir, settings=None, converter=None):
    from pypdf import PdfWriter
    settings = settings or Settings()
    pdf_path = Path(pdf_path)
    reader, source = inspect_pdf(pdf_path)
    end = min(settings.end_page or source["pages"], source["pages"])
    if settings.start_page > end:
        raise ValueError("Выбранный диапазон за пределами PDF")
    identity = {"pipeline_version": PIPELINE_VERSION, "pipeline_sha256": sha256(__file__),
                "source_sha256": source["sha256"],
                "settings": asdict(settings), "environment": environment()}
    fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:12]
    root = Path(output_dir) / f"{pdf_path.stem}_{fingerprint}"
    root.mkdir(parents=True, exist_ok=True)
    write_json(root / "manifest.json", {**identity, "source": source,
                                      "created_or_resumed_at": datetime.now(timezone.utc).isoformat()})
    write_json(root / "outline.json", source["outline"])
    print(f"{pdf_path.name}: {source['pages']} стр.; выбран диапазон {settings.start_page}–{end}.", flush=True)
    print(f"Результаты и checkpoints: {root}", flush=True)
    records, failures = [], []

    def process(start, stop):
        nonlocal converter
        chunk_id = f"p{start:04d}_{stop:04d}"
        checkpoint = load_checkpoint(root, chunk_id)
        if checkpoint is not None:
            print(f"  {start}–{stop}: checkpoint OK", flush=True)
            records.append(checkpoint)
            return
        split_path = root / "chunks" / chunk_id / "split.json"
        if split_path.exists() and start < stop:
            mid = (start + stop) // 2
            process(start, mid)
            process(mid + 1, stop)
            return
        print(f"  {start}–{stop}: конвертация", flush=True)
        error = None
        oom = False
        try:
            if converter is None:
                converter = build_converter(settings)
            with tempfile.TemporaryDirectory(prefix="clinrec_") as tmp:
                subset = Path(tmp) / f"{chunk_id}.pdf"
                writer = PdfWriter()
                for page in range(start - 1, stop):
                    writer.add_page(reader.pages[page])
                with subset.open("wb") as stream:
                    writer.write(stream)
                writer.close()
                data, artifacts = convert_chunk(converter, subset, root, chunk_id, start, stop, source["native_text_chars"])
            record = {**data, "chunk_id": chunk_id, "start": start, "end": stop,
                      "artifacts": {p.relative_to(root).as_posix(): sha256(p) for p in artifacts}}
            # A checkpoint is the last write, after all referenced outputs are durable.
            write_json(root / "chunks" / chunk_id / "checkpoint.json", record)
            records.append(record)
        except Exception as exc:
            oom = is_memory_error(exc)
            error = f"{type(exc).__name__}: {exc}"
        finally:
            release_memory()
        # Recursion happens outside except: the exception traceback must release the failed document first.
        if error:
            if oom and start < stop:
                print(f"  {start}–{stop}: нехватка памяти → деление пополам", flush=True)
                write_json(split_path, {"reason": error})
                mid = (start + stop) // 2
                process(start, mid)
                process(mid + 1, stop)
            else:
                failures.append({"start": start, "end": stop, "error": error})
                print(f"  ОШИБКА {start}–{stop}: {error}", flush=True)

    # Invalidate derived outputs immediately, even when a later interrupt kills the session.
    merge(root, source, settings, records, failures)
    try:
        for start, stop in ranges(settings.start_page, end, settings.chunk_pages):
            process(start, stop)
            report = merge(root, source, settings, records, failures)
            print(f"  Сохранено: {report['converted_pages']} стр.", flush=True)
    finally:
        report = merge(root, source, settings, records, failures)
    return root, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, default=Path("parsed_clinrecs"))
    parser.add_argument("--chunk-pages", type=int, default=10)
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    parser.add_argument("--start-page", type=int, default=1)
    parser.add_argument("--end-page", type=int)
    parser.add_argument("--force-ocr", action="store_true")
    parser.add_argument("--formulas", action="store_true")
    args = parser.parse_args()
    settings = Settings(chunk_pages=args.chunk_pages, device=args.device,
                        start_page=args.start_page, end_page=args.end_page,
                        force_full_page_ocr=args.force_ocr, formulas=args.formulas)
    failed = False
    for pdf in args.pdf:
        try:
            _, report = run_document(pdf, args.output, settings)
            failed |= report["status"] == "incomplete"
        except Exception as exc:
            print(f"ОШИБКА {pdf}: {exc}", file=sys.stderr)
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
