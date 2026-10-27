#!/usr/bin/env python3
"""Build the reviewed local personality-disorders (pers_2024) dataset. No network, dependencies or application DB."""

import argparse
import bisect
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/clinrecs/rag/19_personality'
PLAN = json.loads((OUT / 'annotation_plan.json').read_text())
SOURCE = ROOT / PLAN['source']
RAW = SOURCE.read_bytes()
assert hashlib.sha256(RAW).hexdigest() == PLAN['source_sha256'], 'Source changed: review spans first'
TEXT = RAW.decode('utf-8')
# Lines are separated by \n only (str.splitlines would also split on exotic separators).
LINES = [l + '\n' for l in TEXT.split('\n')]
LINES[-1] = LINES[-1][:-1]
if not LINES[-1]:
    LINES.pop()
OFFSETS = [0]
for line in LINES:
    OFFSETS.append(OFFSETS[-1] + len(line))
assert OFFSETS[-1] == len(TEXT)
PAGE = PLAN['page_proxy_chars']
DOC = PLAN['document_id']
SECTIONS = PLAN['sections']
BY_ID = {s['id']: s for s in SECTIONS}
# Bibliographic brackets only: «[[1]](url)» is a Markdown footnote link and «[1](url)» a link label.
CITATION = re.compile(r'(?<!\[)\[(\s*\d+(?:[\s­]*[-–—,;][\s­]*\d+)*(?:\s+и др\.)?\s*)\](?![\](])')
RECOMMENDATION = re.compile(r'^\s*-\s+(?!\*)(?=.*\b(?:не\s+)?рекоменду(?:ется|ются)\b)', re.I)
IMAGE = re.compile(r'!\[[^\]]*\]\(([^)]+)\)')
EVIDENCE = re.compile(r'^\*\*УДД\s*[-–—]\s*\d[^\n]*', re.M)
NAME_PATTERNS = {
    'sifs': r'\bSIFS\b|личностного и межличностного функционирования',
    'fficd': r'FFiCD|Пятифакторн',
}


def span(start, end):
    assert 0 <= start < end <= len(TEXT)
    return {'start': start, 'end': end,
            'start_line': bisect.bisect_right(OFFSETS, start),
            'end_line': bisect.bisect_right(OFFSETS, end - 1)}


def line_span(start, end):
    return span(OFFSETS[start - 1], OFFSETS[end - 1])


def slice_text(s):
    return TEXT[s['start']:s['end']]


def short_title(s):
    return re.sub(r'\s+', ' ', re.sub(r'^[-#*\s]+', '', CITATION.sub('', s)).replace('*', '').replace('\\', '')).strip()[:160]


def path_for(section):
    path = [section['title']]
    while section['parent']:
        section = BY_ID[section['parent']]
        path.insert(0, section['title'])
    return path


for i, s in enumerate(SECTIONS):
    s['end_line_exclusive'] = next((n['start_line'] for n in SECTIONS[i+1:]
                                    if n['level'] <= s['level']), len(LINES) + 1)
    s['own_end_line_exclusive'] = SECTIONS[i+1]['start_line'] if i+1 < len(SECTIONS) else len(LINES) + 1
    s['span'] = line_span(s['start_line'], s['end_line_exclusive'])
    s['own_span'] = line_span(s['start_line'], s['own_end_line_exclusive'])

REF_SECTION = next(s for s in SECTIONS if s['collection'] == 'references')
REFERENCES = []
# The supplied bibliography nests its actual item 1 inside two wrapper items; the rest sit at six spaces.
for number in range(1, 50):
    pattern = rf'^\s{{6}}{number}\. ' if number > 1 else r'^\s{3}1\. 1\. '
    matches = list(re.finditer(pattern + r'[^\n]+', TEXT, re.M))
    assert len(matches) == 1, (number, matches)
    m = matches[0]
    assert REF_SECTION['span']['start'] <= m.start() < REF_SECTION['span']['end']
    body_start = m.start() + re.match(pattern, m[0]).end()
    REFERENCES.append({'id': f'{DOC}.ref.{number:03}', 'number': number,
                       'text': TEXT[body_start:m.end()], 'span': span(m.start(), m.end())})
REF_BY_NUMBER = {r['number']: r['id'] for r in REFERENCES}
assert len(re.findall(r'^\s+\d+\. ', slice_text(REF_SECTION['span']), re.M)) == 50  # 49 items + wrapper's own "1."


def metadata(s):
    raw = slice_text(s)
    citation_spans = []
    numbers = set()
    for m in CITATION.finditer(raw):
        ns = set()
        for item in re.split(r'[,;]', m[1]):
            bounds = [int(n) for n in re.findall(r'\d+', item)]
            assert 1 <= len(bounds) <= 2
            ns.update(range(bounds[0], bounds[-1] + 1))
        numbers.update(ns)
        citation_spans.append({'raw': m[0], 'numbers': sorted(ns), 'unspecified_others': 'и др.' in m[0],
                               'span': span(s['start'] + m.start(), s['start'] + m.end())})
    return {
        'citation_numbers': sorted(numbers),
        'reference_ids': [REF_BY_NUMBER[n] for n in sorted(numbers) if n in REF_BY_NUMBER],
        'unresolved_citation_numbers': sorted(numbers - REF_BY_NUMBER.keys()),
        'citation_spans': citation_spans,
        'evidence_statements': [{'raw': m[0], 'span': span(s['start']+m.start(), s['start']+m.end())}
                                for m in EVIDENCE.finditer(raw)],
        'image_urls': IMAGE.findall(raw),
        'text_coverage': 'text_and_external_images' if IMAGE.search(raw) else 'text',
        'answerability': 'image_content_unavailable' if IMAGE.search(raw) and not re.sub(r'[#*\s]', '', IMAGE.sub('', re.sub(r'^\*\*[^\n]+\*\*\s*$', '', raw, flags=re.M))) else 'available_text_only',
        'source_markers': {'hash_present': '#' in raw, 'escaped_double_asterisk_present': r'\*\*' in raw},
    }


def source_record(record_id, title, s, section):
    raw = slice_text(s)
    return {'id': record_id, 'document_id': DOC, 'title': title,
            'section_id': section['id'], 'heading_path': path_for(section),
            'span': s, 'source_text': raw, 'text': CITATION.sub('', raw),
            'metadata': metadata(s)}


PARENTS = []
CHUNKS = []
SUPPORTING = []
APPENDICES = []
METHOD_PARENTS = []
METHOD_CHUNKS = []
OWNERSHIP = []


def own(s, category, record_ids):
    OWNERSHIP.append({'span': s, 'collection': category, 'record_ids': record_ids})


def meaningful(s):
    # A section consisting solely of headings belongs in the navigation layer.
    paras = re.split(r'\n\s*\n', slice_text(s).strip())
    return any(not (p.startswith('#') or (p.startswith('**') and p.endswith('**'))) for p in paras)


def context_spans(section):
    result = []
    while section['parent']:
        section = BY_ID[section['parent']]
        if section['level'] == 1:
            continue  # Source passport is attached from manifest, never the whole document.
        if section['collection'] == 'clinical' and meaningful(section['own_span']):
            result.append(section['own_span'])
    return list(reversed(result))


def units_for(section):
    a = section['start_line']
    units = section.get('units') or [{'line': a}]
    return [dict(u, kind=u.get('kind', section.get('unit_kind', 'semantic_block'))) for u in units]


def chunk_id_for(line):
    return f'{DOC}.chunk.{line:04}'


for section in SECTIONS:
    a, b = section['start_line'], section['own_end_line_exclusive']
    category = section['collection']
    if category == 'references':
        own(section['own_span'], 'references', ['references.source_section'])
        continue
    if category == 'supporting':
        rec = source_record(f'{DOC}.support.{a}', section['title'], section['own_span'], section)
        rec['index_in_clinical_search'] = False
        SUPPORTING.append(rec)
        own(section['own_span'], 'supporting', [rec['id']])
        continue
    if category == 'structure' or (not meaningful(section['own_span']) and category != 'methods'):
        own(section['own_span'], 'structure', [section['id']])
        continue
    parent_id = f'{DOC}.parent.{a}'
    # Context parents are complete semantic blocks, not entire chapters containing
    # nested subsections. The original chapter hierarchy remains in sections.json.
    full_span = section['own_span']
    parent = source_record(parent_id, section['title'], full_span, section)
    parent['index_in_vector_search'] = False
    parent['section_subtree_span'] = section['span']
    parent['child_ids'] = []
    parent['ancestor_context_spans'] = context_spans(section)
    units = units_for(section)
    starts = [u['line'] for u in units]
    assert starts == sorted(set(starts)) and starts[0] >= a and starts[-1] < b, section['id']
    if category == 'methods':
        parent['id'] = parent_id = f'{DOC}.method.{section["key"]}'
        parent['original_appendix_label'] = section['label']
        parent['required_context_spans'] = [line_span(starts[0], starts[1])]
        METHOD_PARENTS.append(parent)
    elif category == 'appendices':
        parent['original_appendix_label'] = section['label']
        APPENDICES.append(parent)
    else:
        PARENTS.append(parent)
    if starts[0] > a:
        own(line_span(a, starts[0]), 'structure', [section['id']])
    group = []
    ancestors = context_spans(section)
    for i, unit in enumerate(units):
        start = unit['line']
        end = starts[i+1] if i+1 < len(starts) else b
        s = line_span(start, end)
        rec = source_record(chunk_id_for(start), unit.get('title') or short_title(LINES[start-1]), s, section)
        rec['kind'] = unit['kind']
        rec['collection'] = category
        rec['index_in_vector_search'] = True
        rec['parent_id'] = parent_id
        required = [chunk_id_for(n) for n in unit.get('required', [])]
        single = len(starts) == 1
        override = section.get('unit_override')
        if override:
            mode, reason = override['mode'], override['reason']
            assert not required
        elif single and category == 'clinical' and not ancestors and not required:
            mode, reason = 'self', 'Единый смысловой блок с полными условиями; достаточно пути заголовков и паспорта документа.'
        elif len(slice_text(full_span).strip()) <= PAGE:
            mode, reason = 'parent', 'Условия и пояснения объединяют пункты; полный смысловой родитель не превышает условную страницу.'
        else:
            mode, reason = 'window', 'Полный родитель больше условной страницы; вернуть чанк и ближайших соседей того же родителя с общими условиями.'
        if mode == 'self' and (required or ancestors):
            mode, reason = 'parent', 'К собственному полному блоку нужно приложить явно связанные общие условия или комментарий.'
        rec['retrieval'] = {'mode': mode, 'reason': reason,
                            'context_parent_id': parent_id if mode != 'self' else None,
                            'previous_chunk_id': None, 'next_chunk_id': None,
                            'required_chunk_ids': required, 'always_include_spans': list(ancestors),
                            'neighbor_limit_each_side': 1 if mode == 'window' else 0,
                            'atomic_oversize': len(rec['source_text'].strip()) > PAGE}
        parent['child_ids'].append(rec['id'])
        group.append(rec)
        own(s, category, [rec['id']])
    for i, chunk in enumerate(group):
        chunk['retrieval']['previous_chunk_id'] = group[i-1]['id'] if i else None
        chunk['retrieval']['next_chunk_id'] = group[i+1]['id'] if i+1 < len(group) else None
        if chunk['retrieval']['atomic_oversize']:
            chunk['retrieval']['reason'] += ' Превышение размера сохранено намеренно: нельзя отрывать варианты рекомендации, общий комментарий, таблицу или пункты инструмента.'
    if category == 'methods':
        METHOD_CHUNKS.extend(group)
    elif category == 'appendices':
        parent['chunks'] = group
    else:
        CHUNKS.extend(group)


ALL_CHUNKS = CHUNKS + METHOD_CHUNKS + [c for p in APPENDICES for c in p['chunks']]
ALL_RECORDS = ALL_CHUNKS + PARENTS + METHOD_PARENTS + APPENDICES + SUPPORTING
TARGETS = METHOD_PARENTS + APPENDICES
CHUNK_BY_ID = {c['id']: c for c in ALL_CHUNKS}


def appendix_links(s):
    raw = slice_text(s)
    result = []
    pattern = r'[Пп]риложени[еяиюях]+\s+([АБВГ]\s*\.?\s*\d*)'
    for m in re.finditer(pattern, raw):
        label = re.sub(r'[\s.]', '', m[1])
        candidates = [t['id'] for t in TARGETS if t['original_appendix_label'] == label]
        nearby = raw[max(0, m.start()-170):m.end()+20]
        named = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items() if re.search(pat, nearby, re.I)]
        status = 'resolved' if len(candidates) == 1 else 'ambiguous' if candidates else 'missing'
        if named and candidates and not set(named).intersection(candidates):
            status = 'label_name_conflict'
        resolved = candidates if status == 'resolved' else []
        result.append({'raw': m[0], 'label': label, 'status': status,
                       'declared_target_ids': candidates, 'named_method_candidate_ids': named,
                       'resolved_target_ids': sorted(resolved), 'review_note': None,
                       'span': span(s['start']+m.start(), s['start']+m.end())})
    return result


# Diagnostic-criteria chunks answer for the ICD code in their title (subtype codes also for their parent code).
code_targets = {}
for chunk in CHUNKS:
    if chunk['kind'] != 'diagnostic_criteria':
        continue
    codes = set(re.findall(r'F\d{2}(?:\.\d+)?', chunk['title']))
    if chunk['span']['start_line'] == 225:
        codes.add('F60')
    codes |= {c[:-1] for c in codes if re.fullmatch(r'F\d{2}\.\d\d', c)}
    for code in codes:
        code_targets.setdefault(code, set()).add(chunk['id'])
for rec in ALL_RECORDS:
    rec['metadata']['appendix_links'] = appendix_links(rec['span'])
    rec['metadata']['named_method_ids'] = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items()
                                          if re.search(pat, rec['source_text'], re.I)]
    if rec in ALL_CHUNKS:
        codes = set(re.findall(r'F\d{2}(?:\.\d+)?', rec['source_text']))
        rec['metadata']['related_classification_chunk_ids'] = sorted(
            {i for c in codes for i in code_targets.get(c, ())} - {rec['id']})


def validate():
    assert not re.search(r'<!-- clinrec ', TEXT)
    ids = {r['id'] for r in ALL_RECORDS}
    assert len(ids) == len(ALL_RECORDS)
    parent_map = {p['id']: p for p in PARENTS + METHOD_PARENTS + APPENDICES}
    chunk_map = {c['id']: c for c in ALL_CHUNKS}
    for rec in ALL_RECORDS:
        assert rec['source_text'] == slice_text(rec['span'])
        assert rec['text'] == CITATION.sub('', rec['source_text'])
        for ref in rec['metadata']['appendix_links']:
            assert set(ref['declared_target_ids'] + ref['named_method_candidate_ids']) <= ids
    for c in ALL_CHUNKS:
        p = parent_map[c['parent_id']]
        assert p['span']['start'] <= c['span']['start'] < c['span']['end'] <= p['span']['end']
        assert c['id'] in p['child_ids']
        for key in ('previous_chunk_id', 'next_chunk_id'):
            target = c['retrieval'][key]
            if target:
                assert chunk_map[target]['parent_id'] == c['parent_id']
                opposite = 'next_chunk_id' if key == 'previous_chunk_id' else 'previous_chunk_id'
                assert chunk_map[target]['retrieval'][opposite] == c['id']
        assert set(c['retrieval']['required_chunk_ids']) <= chunk_map.keys()
        assert c['id'] not in c['retrieval']['required_chunk_ids']
        assert (c['retrieval']['mode'] == 'self') == (c['retrieval']['context_parent_id'] is None)
        if c['retrieval']['mode'] == 'self':
            assert not c['retrieval']['required_chunk_ids'] and not c['retrieval']['always_include_spans']
        for s in c['retrieval']['always_include_spans']:
            assert slice_text(s).strip()
    # Every character is assigned once outside deliberately duplicated parent context.
    coverage = sorted(OWNERSHIP, key=lambda r: r['span']['start'])
    assert coverage[0]['span']['start'] == 0
    assert coverage[-1]['span']['end'] == len(TEXT)
    for a, b in zip(coverage, coverage[1:]):
        assert a['span']['end'] == b['span']['start'], (a, b)
    # No chunk boundary inside a physical Markdown table, including malformed tables.
    for c in ALL_CHUNKS:
        line = c['span']['start_line']
        previous = LINES[line-2] if line > 1 else ''
        assert not (previous.startswith('|') and LINES[line-1].startswith('|'))
    # An explicit recommendation is never lost or split from its evidence statement.
    clinical_ids = {c['id'] for c in CHUNKS}
    for n, line in enumerate(LINES, 1):
        if RECOMMENDATION.match(line):
            owners = [c for c in ALL_CHUNKS if c['span']['start'] <= OFFSETS[n-1] < c['span']['end']]
            assert len(owners) == 1 and owners[0]['kind'] == 'recommendation', n
    for c in CHUNKS:
        if c['kind'] == 'recommendation':
            recs = [l for l in c['source_text'].split('\n') if RECOMMENDATION.match(l)]
            assert len(recs) == 1 and len(c['metadata']['evidence_statements']) == 1, c['id']
        else:
            assert not c['metadata']['evidence_statements'] or c['kind'] == 'shared_comment', c['id']
    for m in EVIDENCE.finditer(TEXT):
        assert any(c['span']['start'] <= m.start() < c['span']['end'] and c['kind'] == 'recommendation'
                   for c in CHUNKS), m.start()
    assert len(METHOD_PARENTS) == 2 and len(REFERENCES) == 49
    return coverage


COVERAGE = validate()
MISSING = sorted({n for c in ALL_RECORDS for n in c['metadata']['unresolved_citation_numbers']})
ISSUES = [dict(chunk_id=c['id'], **r) for c in ALL_CHUNKS for r in c['metadata']['appendix_links']
          if r['status'] in ('ambiguous', 'missing', 'label_name_conflict', 'table_scope_unverified')]
normalized = {}
for r in REFERENCES:
    normalized.setdefault(re.sub(r'\W+', '', r['text']).lower().rstrip('0123456789'), []).append(r['number'])
DUPLICATE_REFERENCES = sorted(v for v in normalized.values() if len(v) > 1)
EVIDENCE_LETTERS = Counter()
for m in EVIDENCE.finditer(TEXT):
    letter = re.search(r'УУР\s*[-–—]\s*(\S)', m[0])[1]
    EVIDENCE_LETTERS['latin ' + letter if letter.isascii() else 'cyrillic ' + letter] += 1
FILES = {
    'chunks.json': {'schema_version': '1.0', 'document_id': DOC, 'chunks': CHUNKS},
    'parents.json': {'schema_version': '1.0', 'document_id': DOC, 'parents': PARENTS},
    'methods.json': {'schema_version': '1.0', 'document_id': DOC, 'parents': METHOD_PARENTS, 'chunks': METHOD_CHUNKS},
    'appendices.json': {'schema_version': '1.0', 'document_id': DOC, 'appendices': APPENDICES},
    'supporting.json': {'schema_version': '1.0', 'document_id': DOC, 'records': SUPPORTING},
    'references.json': {'schema_version': '1.0', 'document_id': DOC,
                        'source_span': REF_SECTION['span'],
                        'source_text': slice_text(REF_SECTION['span']),
                        'items': REFERENCES, 'unresolved_citation_numbers': MISSING,
                        'completeness': 'provided_bibliography_only_numbers_1_to_49'},
    'sections.json': {'schema_version': '1.0', 'document_id': DOC,
                      'sections': [{k: s[k] for k in ('id', 'parent', 'level', 'title', 'kind', 'start_line',
                                                      'end_line_exclusive', 'own_end_line_exclusive', 'span',
                                                      'own_span', 'collection')} for s in SECTIONS]},
    'coverage.json': {'schema_version': '1.0', 'document_id': DOC, 'partition': COVERAGE},
}
ASSETS = []
for m in IMAGE.finditer(TEXT):
    ASSETS.append({'id': f'{DOC}.image.{len(ASSETS)+1:03}', 'url': m[1],
                   'span': span(m.start(), m.end()), 'content_status': 'external_not_downloaded_or_ocr_processed',
                   'referring_chunk_ids': [c['id'] for c in ALL_CHUNKS if c['span']['start'] <= m.start() < c['span']['end']]})
FILES['assets.json'] = {'schema_version': '1.0', 'document_id': DOC, 'assets': ASSETS}
downloaded = re.search(r'\*\*Дата скачивания:\*\* (\d\d)\.(\d\d)\.(\d{4})', TEXT)
MANIFEST = {
    'schema_version': '1.0', 'document_id': DOC,
    'title': 'Специфические расстройства личности', 'clinical_year': 2024,
    'guideline_id': '397', 'population': 'Взрослые', 'language': 'ru',
    'source_file': PLAN['source'], 'source_sha256': PLAN['source_sha256'],
    'source_url': re.search(r'\*\*Источник:\*\* \[[^\]]+\]\(([^)]+)\)', TEXT)[1],
    'downloaded_date_as_stated': f'{downloaded[3]}-{downloaded[2]}-{downloaded[1]}',
    'span_convention': 'Unicode code points, zero-based start inclusive/end exclusive; lines one-based inclusive',
    'page_proxy_chars': PAGE, 'page_proxy_is_pdf_page': False,
    'embedding_input': 'manifest.title + heading_path + chunk.text; index chunks only, never duplicate parents',
    'vector_collections': ['chunks.json:chunks', 'methods.json:chunks', 'appendices.json:appendices[].chunks'],
    'context_resolution': ['mode-specific payload', 'always_include_spans', 'required_chunk_ids',
                           'heading_path and manifest provenance', 'explicit links on demand'],
    'counts': {'clinical_chunks': len(CHUNKS), 'clinical_parents': len(PARENTS),
               'methods': len(METHOD_PARENTS), 'method_chunks': len(METHOD_CHUNKS),
               'appendices': len(APPENDICES), 'all_search_chunks': len(ALL_CHUNKS),
               'retrieval_modes': dict(Counter(c['retrieval']['mode'] for c in ALL_CHUNKS)),
               'oversized_atomic_chunks': sum(c['retrieval']['atomic_oversize'] for c in ALL_CHUNKS)},
    'source_issues': {
        'missing_reference_numbers': MISSING,
        'appendix_link_issues': ISSUES,
        'duplicate_reference_texts': DUPLICATE_REFERENCES,
        'reference_list_wrapper': 'Строки 584–585: настоящий пункт 1 вложен в два обёрточных элемента списка; '
                                  'пункты 2–49 имеют иной отступ. Номера сохранены как в источнике.',
        'external_images_not_ocr_processed': True,
        'unnumbered_appendix_labels': 'Приложения Б и В не имеют номера; «Приложение Г1-ГN» — заголовок группы, а не методика.',
        'appendix_a2_two_evidence_schemes': 'А2 (строки 714–737) описывает рейтинговую схему А–Д и шесть уровней доказательств, '
                                            'а рекомендации размечены по УДД 1–5 и УУР A–C (таблицы II.1–II.3). Не сведено.',
        'appendix_a3_content': 'Заголовок А3 обещает соответствие показаний и доз препаратов, но в разделе четыре нормативных акта (строки 791–796).',
        'footnote_markers': 'Строки 554 и 568: Markdown-сноска «[[1]](url)» не является библиографической ссылкой и сохранена в text. '
                            'В строке 564 после «условий» стоит цифра 2 без текста сноски 2.',
        'evidence_letter_script': dict(EVIDENCE_LETTERS),
        'sifs_table_anomalies': 'Строки 839–842: таблица шкалы ответов с пустой шапкой. Строка 846: шапкой таблицы служит пункт 1. '
                                'Строки 852 (пункт 6) и 870 (пункт 24) не содержат ячейки «0 - 1 - 2 - 3 - 4».',
        'sifs_broken_url': 'Строка 819: ссылка figshare разорвана пробелом и экранированием «Scale\\_SIFS\\_».',
        'fficd_item_73_absent': 'В списке утверждений 1–121 отсутствует пункт 73 (120 пунктов), хотя он входит в ключ «Расторможенность» (строка 1027) '
                                'и нюанс «Расторможенность → Дезорганизация» (строка 1145).',
        'fficd_glued_text': 'Строка 898: инструкция «Инструкция: Ниже приведены…» слита с интерпретацией без разделителя; '
                            'строка 1045: «Г невливость».',
        'icd_codes_duplicated': 'Список кодов F60/F61 повторён в строках 47–87 и 95–123; пятизначные коды F60.x1 и т.п. описаны только в первом.',
    },
    'validation': {'source_hash': 'passed', 'exact_character_coverage': 'passed',
                   'span_round_trip': 'passed', 'relationships': 'passed',
                   'recommendation_ownership': 'passed', 'tables_intact': 'passed'},
}
FILES['manifest.json'] = MANIFEST


def review():
    lines = ['# Решения по чанкам: расстройства личности, 2024', '',
             'Каждая строка — поисковый чанк; полный контекст хранится по `parent_id`. '
             'Решение и его причина также записаны в JSON. Номера строк относятся к исходному Markdown.', '',
             '| Чанк / строки | Тип выдачи | Символов | Содержание |', '| --- | --- | ---: | --- |']
    for c in sorted(ALL_CHUNKS, key=lambda c: c['span']['start']):
        s = c['span']
        lines.append(f'| {c["id"]} / {s["start_line"]}–{s["end_line"]} | {c["retrieval"]["mode"]} | '
                     f'{len(c["source_text"].strip())}{" *" if c["retrieval"]["atomic_oversize"] else ""} | '
                     f'{c["title"].replace("|", "/")} |')
    lines += ['', '`*` — атомарный блок больше 3500 символов: список утверждений опросника сохранён целиком.', '',
              '## Неразрешённые ссылки', '',
              f'В предоставленном списке литературы только номера 1–49, не найдено {len(MISSING)} используемых номеров. '
              'Полный список — `references.json:unresolved_citation_numbers`.', '']
    for issue in ISSUES:
        lines.append(f'- {issue["chunk_id"]}, строка {issue["span"]["start_line"]}: '
                     f'`{issue["raw"]}` → {issue["label"]}, **{issue["status"]}**.')
    lines += ['', '## Проблемы источника (не исправлены)', '']
    for key, value in MANIFEST['source_issues'].items():
        if key in ('missing_reference_numbers', 'appendix_link_issues'):
            continue
        lines.append(f'- `{key}`: {json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value}')
    return '\n'.join(lines) + '\n'


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check', action='store_true', help='Validate source, relationships and generated artifacts without writing')
args = parser.parse_args()
serialized = {name: json.dumps(data, ensure_ascii=False, indent=2) + '\n' for name, data in FILES.items()}
serialized['REVIEW.md'] = review()
if args.check:
    for name, expected in serialized.items():
        assert (OUT / name).read_text() == expected, f'Stale artifact: {name}'
else:
    for name, data in serialized.items():
        (OUT / name).write_text(data)
print(json.dumps(MANIFEST['counts'], ensure_ascii=False))
print('Validation passed; unresolved citation numbers:', len(MISSING), '; appendix issues:', len(ISSUES))
