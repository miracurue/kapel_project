"""Offline checks: real PDF splitting and Docling serializers, no model downloads/GPU."""
import json
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from PIL import Image
from docling_core.types.doc import (
    BoundingBox, ContentLayer, DocItemLabel, DoclingDocument, ImageRef,
    ProvenanceItem, Size, TableCell, TableData,
)

import clinrecs_pipeline as pipeline


def synthetic_document(count):
    doc = DoclingDocument(name="Synthetic guideline")
    for page in range(1, count + 1):
        doc.add_page(page_no=page, size=Size(width=600, height=800))
        prov = ProvenanceItem(page_no=page, bbox=BoundingBox(l=10, t=100, r=590, b=20), charspan=(0, 10))
        doc.add_heading(text=f"Раздел {page}", prov=prov)
        doc.add_text(label=DocItemLabel.TEXT, text="Синтетический текст с [12], ≥ и ≤. " * 5, prov=prov)
        doc.add_text(label=DocItemLabel.PAGE_FOOTER, text="Примечание к таблице **, #",
                     prov=prov, content_layer=ContentLayer.FURNITURE)
        doc.add_table(data=TableData(num_rows=1, num_cols=2, table_cells=[
            TableCell(text="Доза", start_row_offset_idx=0, end_row_offset_idx=1,
                      start_col_offset_idx=0, end_col_offset_idx=1),
            TableCell(text="≥ 5 мг", start_row_offset_idx=0, end_row_offset_idx=1,
                      start_col_offset_idx=1, end_col_offset_idx=2),
        ]), prov=prov)
        doc.add_picture(image=ImageRef.from_pil(Image.new("RGB", (20, 20), "red"), dpi=72), prov=prov)
    return doc


class FakeConverter:
    def __init__(self, max_pages=100, fail_page=None, partial=False, interrupt_page=None):
        self.calls = []
        self.max_pages = max_pages
        self.fail_page = fail_page
        self.partial = partial
        self.interrupt_page = interrupt_page

    def convert(self, path, raises_on_error=False):
        start, end = map(int, Path(path).stem[1:].split("_"))
        count = len(PdfReader(path).pages)
        self.calls.append((start, end))
        if self.interrupt_page and start <= self.interrupt_page <= end:
            raise KeyboardInterrupt()
        if count > self.max_pages:
            raise RuntimeError("CUDA out of memory")
        if self.fail_page and start <= self.fail_page <= end:
            raise ValueError("synthetic conversion failure")
        return SimpleNamespace(document=synthetic_document(count),
                               status=SimpleNamespace(value="partial_success" if self.partial else "success"),
                               errors=["synthetic partial failure"] if self.partial else [])


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.pdf = self.base / "fixture.pdf"
        self.settings = pipeline.Settings(device="cpu")
        # Avoid coupling test identity to the host's installed packages.
        self.env = patch.object(pipeline, "environment", return_value={"offline_test": "1"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def make_pdf(self, count):
        writer = PdfWriter()
        for _ in range(count):
            writer.add_blank_page(width=600, height=800)
        with self.pdf.open("wb") as stream:
            writer.write(stream)
        writer.close()

    def run_pdf(self, converter, settings=None):
        return pipeline.run_document(self.pdf, self.base / "out", settings or self.settings, converter)

    def test_provided_sizes_have_complete_bounded_ranges(self):
        for count in (125, 121):
            chunks = pipeline.ranges(1, count, 10)
            self.assertEqual(len(chunks), 13)
            self.assertTrue(all(stop - start + 1 <= 10 for start, stop in chunks))
            self.assertEqual([p for a, b in chunks for p in range(a, b + 1)], list(range(1, count + 1)))

    def test_merge_real_serializers_assets_and_absolute_pages(self):
        self.make_pdf(13)
        converter = FakeConverter()
        root, report = self.run_pdf(converter)
        self.assertEqual(report["status"], "complete")
        self.assertEqual(converter.calls, [(1, 10), (11, 13)])
        markdown = (root / "document.md").read_text()
        self.assertEqual(list(map(int, re.findall(r"<!-- page: (\d+) -->", markdown))), list(range(1, 14)))
        self.assertIn("Примечание к таблице", markdown)
        self.assertIn("≥ 5 мг", markdown)
        self.assertIn("[12]", markdown)
        self.assertEqual(len(list((root / "images").glob("*.png"))), 13)
        image_paths = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", markdown)
        self.assertEqual(len(image_paths), 13)
        self.assertTrue(all((root / path).is_file() for path in image_paths))
        native = json.loads((root / "chunks/p0011_0013/docling.json").read_text())
        self.assertEqual(set(native["pages"]), {"1", "2", "3"})
        tables = json.loads((root / "tables.json").read_text())
        self.assertEqual([table["pdf_pages"] for table in tables], [[n] for n in range(1, 14)])
        self.assertIn("<table", (root / tables[0]["html"]).read_text())
        pages = [json.loads(line) for line in (root / "pages.jsonl").read_text().splitlines()]
        self.assertEqual(pages[10]["local_page"], 1)
        self.assertEqual(pages[10]["pdf_page"], 11)
        again = FakeConverter()
        self.run_pdf(again)
        self.assertEqual(again.calls, [])
        (root / "images/p0011_0013_0001.png").write_bytes(b"corrupt")
        repair = FakeConverter()
        self.run_pdf(repair)
        self.assertEqual(repair.calls, [(11, 13)])

    def test_recursive_oom_and_persisted_split_plan(self):
        self.make_pdf(10)
        converter = FakeConverter(max_pages=3)
        root, report = self.run_pdf(converter)
        self.assertEqual(report["status"], "complete")
        self.assertTrue((root / "chunks/p0001_0010/split.json").exists())
        self.assertEqual(report["converted_pages"], 10)
        again = FakeConverter(max_pages=3)
        self.run_pdf(again)
        self.assertEqual(again.calls, [])

    def test_single_failed_page_is_retried_without_repeating_success(self):
        self.make_pdf(5)
        root, report = self.run_pdf(FakeConverter(max_pages=2, fail_page=3))
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["missing_pages"], [3])
        self.assertIn("FAILED: PAGE NOT CONVERTED", (root / "document.md").read_text())
        repair = FakeConverter(max_pages=2)
        _, report = self.run_pdf(repair)
        self.assertEqual(repair.calls, [(3, 3)])
        self.assertEqual(report["status"], "complete")

    def test_non_memory_failure_does_not_hide_missing_pages(self):
        self.make_pdf(23)
        _, report = self.run_pdf(FakeConverter(fail_page=13))
        self.assertEqual(report["missing_pages"], list(range(11, 21)))
        self.assertEqual(report["converted_pages"], 13)
        self.assertEqual(len(report["failures"]), 1)

    def test_partial_success_is_never_a_complete_checkpoint(self):
        self.make_pdf(2)
        root, report = self.run_pdf(FakeConverter(partial=True))
        self.assertEqual(report["missing_pages"], [1, 2])
        self.assertEqual(report["status"], "incomplete")
        self.assertFalse((root / "chunks/p0001_0002/checkpoint.json").exists())

    def test_interrupt_keeps_checkpoints_and_invalidates_summary(self):
        self.make_pdf(13)
        with self.assertRaises(KeyboardInterrupt):
            self.run_pdf(FakeConverter(interrupt_page=11))
        root = next((self.base / "out").iterdir())
        report = json.loads((root / "quality_report.json").read_text())
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["converted_pages"], 10)
        resume = FakeConverter()
        _, report = self.run_pdf(resume)
        self.assertEqual(resume.calls, [(11, 13)])
        self.assertEqual(report["status"], "complete")

    def test_changed_source_or_settings_get_new_folder_and_preview_label(self):
        self.make_pdf(3)
        first, report = self.run_pdf(FakeConverter(), pipeline.Settings(device="cpu", end_page=2))
        self.assertEqual(report["status"], "preview_complete")
        self.assertFalse(report["complete_document"])
        full, _ = self.run_pdf(FakeConverter())
        self.assertNotEqual(first, full)
        self.make_pdf(4)
        changed, _ = self.run_pdf(FakeConverter())
        self.assertNotEqual(full, changed)

    def test_memory_detection_and_validation(self):
        for message in ("CUDA out of memory", "std::bad_alloc", "CUBLAS_STATUS_ALLOC_FAILED"):
            self.assertTrue(pipeline.is_memory_error(RuntimeError(message)))
        self.assertFalse(pipeline.is_memory_error(ValueError("corrupt PDF")))
        with self.assertRaises(ValueError):
            pipeline.Settings(chunk_pages=0)
        with self.assertRaises(ValueError):
            pipeline.Settings(start_page=10, end_page=2)


if __name__ == "__main__":
    unittest.main()
