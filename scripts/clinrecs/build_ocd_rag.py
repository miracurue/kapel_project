#!/usr/bin/env python3
"""Build the reviewed local OCD (ocd_2025) dataset. No network, dependencies or application DB."""

import argparse
import bisect
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/clinrecs/rag/06_ocd'
PLAN = json.loads((OUT / 'annotation_plan.json').read_text())
SOURCE = ROOT / PLAN['source']
RAW = SOURCE.read_bytes()
assert hashlib.sha256(RAW).hexdigest() == PLAN['source_sha256'], 'Source changed: review spans first'
TEXT = RAW.decode('utf-8')
LINES = TEXT.splitlines(keepends=True)
OFFSETS = [0]
for line in LINES:
    OFFSETS.append(OFFSETS[-1] + len(line))
PAGE = PLAN['page_proxy_chars']
DOC = PLAN['document_id']
WS = r'[\s\xa0­]'
# Bracketed bibliography numbers; tolerant of the source's irregular separators
# («[82 86]», «[173,,227]», «[23,\xa024]», «[1 - 3]»).
CITATION = re.compile(r'\[' + WS + r'*\d+(?:' + WS + r'*(?:[-–—]|,+|;)' + WS + r'*\d+|' + WS + r'+\d+)*' + WS + r'*,?' + WS + r'*\]')
RECOMMENDATION = re.compile(r'^-\s+(?!\*)')
EVIDENCE_LINE = re.compile(r'^(?:\*\*)?Уровень')
IMAGE = re.compile(r'!\[[^\]]*\]\(([^)]+)\)')
EVIDENCE = re.compile(r'^(?:\*\*)?Уровень[^\n]+', re.M)
NAME_PATTERNS = {'flybocs': r'FLY-?BOCS|Йел[ея]|Браун', 'cssrs': r'Колумбийск|[СC]-?SSRS'}


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
    s = re.sub(r'\\([*_])', r'\1', CITATION.sub('', s))
    s = re.sub(r'\s+', ' ', re.sub(r'^[-#*\s]+', '', s).replace('*', '')).strip()
    return re.sub(r'\s+([.,;:])', r'\1', s)[:160]


# ---------------------------------------------------------------- sections
def build_sections():
    raw = []
    for n, line in enumerate(LINES, 1):
        m = re.match(r'^(#{1,6}) (.+?)\s*$', line)
        if m:
            raw.append({'line': n, 'level': len(m[1]), 'title': m[2].strip(), 'kind': 'document' if len(m[1]) == 1 else 'heading'})
    for v in PLAN['virtual_sections']:
        title = v.get('title') or re.sub(r'\s+', ' ', re.sub(r'[*\\]', '', LINES[v['line'] - 1].replace('\xa0', ' '))).strip()
        raw.append({'line': v['line'], 'level': v['level'], 'title': title, 'kind': 'virtual_heading'})
    raw.sort(key=lambda r: r['line'])
    assert len({r['line'] for r in raw}) == len(raw)
    sections, stack = [], []
    for r in raw:
        while stack and stack[-1]['level'] >= r['level']:
            stack.pop()
        s = {'id': f'{DOC}.sec.{r["line"]:04}', 'parent': stack[-1]['id'] if stack else None, 'level': r['level'],
             'title': r['title'], 'kind': r['kind'], 'start_line': r['line']}
        sections.append(s)
        stack.append(s)
    assert sections[0]['start_line'] == 1
    for i, s in enumerate(sections):
        s['end_line_exclusive'] = next((n['start_line'] for n in sections[i+1:] if n['level'] <= s['level']), len(LINES) + 1)
        s['own_end_line_exclusive'] = sections[i+1]['start_line'] if i+1 < len(sections) else len(LINES) + 1
        s['span'] = line_span(s['start_line'], s['end_line_exclusive'])
        s['own_span'] = line_span(s['start_line'], s['own_end_line_exclusive'])
    return sections


SECTIONS = build_sections()
BY_ID = {s['id']: s for s in SECTIONS}


def path_for(section):
    path = [section['title']]
    while section['parent']:
        section = BY_ID[section['parent']]
        path.insert(0, section['title'])
    return path


def collection_for(line):
    for a, b, c in PLAN['category_ranges']:
        if a <= line < b:
            return c
    return 'clinical'


# -------------------------------------------------------------- references
REFERENCES = []
REF_SECTION = next(s for s in SECTIONS if collection_for(s['start_line']) == 'references')
for n in range(REF_SECTION['start_line'], REF_SECTION['own_end_line_exclusive']):
    line = LINES[n - 1].rstrip('\n')
    # The bibliography is a numbered list whose real item 1 is nested in a wrapper item «1. Клинические рекомендации ...».
    m = re.match(r'^\s{3}1\. (1)\. ', line) if not REFERENCES else re.match(r'^\s{6}(\d+)\.\s*', line)
    if m:
        number = int(m[1])
        assert number == len(REFERENCES) + 1, (n, number)
        REFERENCES.append({'id': f'{DOC}.ref.{number:03}', 'number': number, 'text': line[m.end():],
                           'span': span(OFFSETS[n - 1] + m.start(), OFFSETS[n - 1] + len(line))})
REF_BY_NUMBER = {r['number']: r['id'] for r in REFERENCES}
assert len(REFERENCES) == 50


# ---------------------------------------------------------------- metadata
def parse_citation(raw):
    """Return (numbers, anomalies) for one bracket such as «[1- 3,98]»."""
    body = raw[1:-1]
    tokens = re.findall(r'\d+|[^\d]+', body)
    numbers, anomalies, prev, pending = set(), [], None, None
    for t in tokens:
        if t.isdigit():
            k = int(t)
            if pending == 'range':
                assert prev is not None and prev <= k
                numbers.update(range(prev, k + 1))
            else:
                numbers.add(k)
            if pending == 'space':
                anomalies.append('missing_separator')
            prev, pending = k, None
        else:
            sep = re.sub(r'[\s\xa0­]', '', t)
            if sep == '' and prev is not None:
                pending = 'space'
            elif re.search(r'[-–—]', sep):
                pending = 'range'
            else:
                if len(sep) > 1 and set(sep) == {','}:
                    anomalies.append('double_separator')
                pending = None
    return sorted(numbers), anomalies


def metadata(s):
    raw = slice_text(s)
    citation_spans = []
    numbers = set()
    for m in CITATION.finditer(raw):
        ns, anomalies = parse_citation(m[0])
        numbers.update(ns)
        citation_spans.append({'raw': m[0], 'numbers': ns, 'unspecified_others': 'и др.' in m[0], 'anomalies': anomalies,
                               'span': span(s['start'] + m.start(), s['start'] + m.end())})
    residual = re.sub(r'[#*\s\\]', '', IMAGE.sub('', raw))
    only_image = bool(IMAGE.search(raw)) and len(residual) <= 160
    return {
        'citation_numbers': sorted(numbers),
        'reference_ids': [REF_BY_NUMBER[n] for n in sorted(numbers) if n in REF_BY_NUMBER],
        'unresolved_citation_numbers': sorted(numbers - REF_BY_NUMBER.keys()),
        'citation_spans': citation_spans,
        'evidence_statements': [{'raw': m[0], 'span': span(s['start']+m.start(), s['start']+m.end())}
                                for m in EVIDENCE.finditer(raw)],
        'image_urls': IMAGE.findall(raw),
        'text_coverage': 'text_and_external_images' if IMAGE.search(raw) else 'text',
        'answerability': 'image_content_unavailable' if only_image else 'available_text_only',
        'source_markers': {'hash_present': '#' in raw, 'escaped_double_asterisk_present': r'\*\*' in raw},
    }


def source_record(record_id, title, s, section):
    raw = slice_text(s)
    return {'id': record_id, 'document_id': DOC, 'title': title,
            'section_id': section['id'], 'heading_path': path_for(section),
            'span': s, 'source_text': raw, 'text': CITATION.sub('', raw),
            'metadata': metadata(s)}


PARENTS, CHUNKS, SUPPORTING, APPENDICES = [], [], [], []
METHOD_PARENTS, METHOD_CHUNKS, OWNERSHIP = [], [], []


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
        if section['level'] < PLAN['ancestor_context_min_level']:
            continue  # Source passport is attached from manifest, never whole chapters.
        if collection_for(section['start_line']) == 'clinical' and meaningful(section['own_span']):
            result.append(section['own_span'])
    return list(reversed(result))


def units_for(section):
    a, b = section['start_line'], section['own_end_line_exclusive']
    if str(a) in PLAN['methods']:
        return PLAN['methods'][str(a)]['units']
    if str(a) in PLAN['units']:
        return PLAN['units'][str(a)]
    # A recommendation is the single list item that directly precedes its УДД/УУР line.
    starts = []
    for n in range(a, b):
        if EVIDENCE_LINE.match(LINES[n-1]):
            j = n - 2
            while not LINES[j].strip():
                j -= 1
            assert RECOMMENDATION.match(LINES[j]), (n, LINES[j][:60])
            starts.append(j + 1)
    if starts:
        prefix = line_span(a, starts[0]) if starts[0] > a else None
        units = [{'start': a, 'kind': 'section_introduction'}] if prefix and meaningful(prefix) else []
        return units + [{'start': n, 'kind': 'recommendation'} for n in starts]
    return [{'start': a, 'kind': 'semantic_block'}]


method_by_key = {}
for section in SECTIONS:
    a, b = section['start_line'], section['own_end_line_exclusive']
    category = collection_for(a)
    if category == 'references':
        own(section['own_span'], 'references', ['references.source_section'])
        continue
    units = units_for(section)
    is_method = str(a) in PLAN['methods']
    if category == 'supporting' and str(a) not in PLAN['units']:
        if not meaningful(section['own_span']):
            own(section['own_span'], 'structure', [section['id']])
            continue
        rec = source_record(f'{DOC}.support.{a}', section['title'], section['own_span'], section)
        rec['index_in_clinical_search'] = False
        SUPPORTING.append(rec)
        own(section['own_span'], 'supporting', [rec['id']])
        continue
    if not meaningful(section['own_span']) and not is_method and str(a) not in PLAN['units']:
        own(section['own_span'], 'structure', [section['id']])
        continue
    starts = [u['start'] for u in units]
    assert starts == sorted(set(starts)) and starts[0] >= a, section['title']
    # Leading supporting units (e.g. the document passport) are not part of the clinical parent.
    support_units = [u for u in units if u.get('collection') == 'supporting']
    body_units = [u for u in units if u.get('collection') != 'supporting']
    for u in support_units:
        end = next((x['start'] for x in units if x['start'] > u['start']), b)
        s = line_span(u['start'], end)
        rec = source_record(f'{DOC}.support.{u["start"]}', u['title'], s, section)
        rec['index_in_clinical_search'] = False
        SUPPORTING.append(rec)
        own(s, 'supporting', [rec['id']])
    if starts[0] > a:
        own(line_span(a, starts[0]), 'structure', [section['id']])
    if not body_units:
        continue
    pstart = body_units[0]['start'] if support_units else a
    parent_id = f'{DOC}.parent.{a}'
    parent = source_record(parent_id, section['title'], line_span(pstart, b), section)
    parent['index_in_vector_search'] = False
    parent['section_subtree_span'] = section['span']
    parent['child_ids'] = []
    parent['ancestor_context_spans'] = context_spans(section)
    method_cfg = PLAN['methods'].get(str(a))
    if method_cfg:
        parent['id'] = parent_id = f'{DOC}.method.{method_cfg["key"]}'
        parent['original_appendix_label'] = method_cfg['label']
        parent['required_context_spans'] = [line_span(x, y) for x, y in method_cfg['required_context_lines']]
        METHOD_PARENTS.append(parent)
    elif category == 'appendices':
        m = re.match(r'Приложение ([АБВГ]\s*\d*)', section['title'])
        parent['original_appendix_label'] = re.sub(r'\s+', '', m[1]) if m else None
        APPENDICES.append(parent)
    else:
        PARENTS.append(parent)
    group = []
    for i, u in enumerate(units):
        if u.get('collection') == 'supporting':
            continue
        start = u['start']
        end = units[i+1]['start'] if i+1 < len(units) else b
        s = line_span(start, end)
        chunk_id = f'{DOC}.chunk.{start:04}'
        rec = source_record(chunk_id, u.get('title') or short_title(LINES[start-1]), s, section)
        rec['kind'] = u['kind']
        rec['collection'] = category
        rec['index_in_vector_search'] = True
        rec['parent_id'] = parent_id
        rec['_required_lines'] = u.get('required_lines', [])
        group.append((rec, s))
    single = len(group) == 1
    for rec, s in group:
        full_span = parent['span']
        standalone = single and category == 'clinical' and not context_spans(section)
        if standalone:
            mode, reason = 'self', 'Единый смысловой блок с полными условиями; достаточно пути заголовков и паспорта документа.'
        elif len(slice_text(full_span).strip()) <= PAGE:
            mode, reason = 'parent', 'Условия и пояснения объединяют пункты; полный смысловой родитель не превышает условную страницу.'
        else:
            mode, reason = 'window', 'Полный родитель больше условной страницы; вернуть чанк и ближайших соседей того же родителя с общими условиями.'
        always = context_spans(section)
        if method_cfg:
            always = always + parent['required_context_spans']
        rec['retrieval'] = {'mode': mode, 'reason': reason,
                            'context_parent_id': parent_id if mode != 'self' else None,
                            'previous_chunk_id': None, 'next_chunk_id': None,
                            'required_chunk_ids': [], 'always_include_spans': always,
                            'neighbor_limit_each_side': 1 if mode == 'window' else 0,
                            'atomic_oversize': len(rec['source_text'].strip()) > PAGE}
        parent['child_ids'].append(rec['id'])
        own(s, category, [rec['id']])
    chunks = [r for r, _ in group]
    for i, chunk in enumerate(chunks):
        chunk['retrieval']['previous_chunk_id'] = chunks[i-1]['id'] if i else None
        chunk['retrieval']['next_chunk_id'] = chunks[i+1]['id'] if i+1 < len(chunks) else None
        # A substantive section introduction states conditions for every recommendation below it.
        if chunk['kind'] != 'section_introduction' and chunks[0]['kind'] == 'section_introduction':
            chunk['retrieval']['required_chunk_ids'].append(chunks[0]['id'])
        for line in chunk.pop('_required_lines'):
            chunk['retrieval']['required_chunk_ids'].append(f'{DOC}.chunk.{line:04}')
        if chunk['retrieval']['atomic_oversize']:
            chunk['retrieval']['reason'] += ' Превышение размера сохранено намеренно: нельзя отрывать варианты рекомендации, комментарий с дозами, таблицу или пункты инструмента.'
    if method_cfg:
        METHOD_CHUNKS.extend(chunks)
    elif category == 'appendices':
        parent['chunks'] = chunks
    else:
        CHUNKS.extend(chunks)

ALL_CHUNKS = CHUNKS + METHOD_CHUNKS + [c for p in APPENDICES for c in p['chunks']]
ALL_RECORDS = ALL_CHUNKS + PARENTS + METHOD_PARENTS + APPENDICES + SUPPORTING
TARGETS = METHOD_PARENTS + APPENDICES
TARGET_IDS = {t['id'] for t in TARGETS}
CHUNK_BY_ID = {c['id']: c for c in ALL_CHUNKS}


def appendix_links(rec):
    s = rec['span']
    raw = slice_text(s)
    result = []
    pattern = r'[Пп]риложени[еяиюях]+\s+((?:[АAБВГ]\s*\d*)|\d+)(?!\d)'
    for m in re.finditer(pattern, raw):
        label = re.sub(r'\s', '', m[1]).replace('A', 'А')
        owner = rec['id'] if rec['id'] in TARGET_IDS else rec.get('parent_id')
        at_heading = s['start'] + m.start() < OFFSETS[s['start_line']]
        if label.isdigit():
            candidates = []
        elif len(label) == 1:
            candidates = [t['id'] for t in TARGETS if (t.get('original_appendix_label') or '').startswith(label)]
        else:
            candidates = [t['id'] for t in TARGETS if t.get('original_appendix_label') == label]
        nearby = raw[max(0, m.start()-170):m.end()+20]
        named = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items() if re.search(pat, nearby, re.I)]
        status = 'resolved' if len(candidates) == 1 else 'ambiguous' if candidates else 'missing'
        note = None
        if label.isdigit():
            note = 'В тексте указано «Приложение ' + label + '» без буквенного обозначения; соответствие не установлено.'
        elif status == 'ambiguous':
            note = 'Указана только буква группы приложений без номера.'
        if named and candidates and not set(named).intersection(candidates):
            status = 'label_name_conflict'
        elif len(candidates) > 1 and len(set(named).intersection(candidates)) == 1:
            status = 'resolved_by_name'
        if status == 'ambiguous':
            pass
        resolved = list(set(named).intersection(candidates)) if status == 'resolved_by_name' else candidates if status == 'resolved' else []
        if at_heading and owner in TARGET_IDS and owner in (resolved or candidates):
            continue  # the appendix's own heading line is not a reference to it
        result.append({'raw': m[0], 'label': label, 'status': status,
                       'declared_target_ids': candidates, 'named_method_candidate_ids': named,
                       'resolved_target_ids': sorted(resolved), 'review_note': note,
                       'span': span(s['start']+m.start(), s['start']+m.end())})
    return result


# F-codes defined by the classification chunks, for cross-references.
code_targets = {}
for chunk in CHUNKS:
    if chunk['kind'] == 'classification':
        for line in chunk['source_text'].splitlines():
            m = re.match(r'^\*?(F\d{2}(?:\.\d+)?)\b', line)
            if m:
                code_targets[m[1]] = chunk['id']
GENERAL = f'{DOC}.chunk.{PLAN["classification_general_line"]:04}'
for rec in ALL_RECORDS:
    rec['metadata']['appendix_links'] = appendix_links(rec)
    rec['metadata']['named_method_ids'] = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items()
                                          if re.search(pat, rec['source_text'], re.I)]
    if rec in ALL_CHUNKS:
        codes = set(re.findall(r'F\d{2}(?:\.\d+)?', rec['source_text']))
        rec['metadata']['related_classification_chunk_ids'] = sorted({code_targets[c] for c in codes if c in code_targets} - {rec['id']})
        if rec['kind'] in ('classification', 'coding'):
            r = rec['retrieval']['required_chunk_ids']
            r += rec['metadata']['related_classification_chunk_ids']
            if rec['kind'] == 'classification' and rec['id'] != GENERAL and rec['span']['start_line'] > PLAN['classification_general_line']:
                r.append(GENERAL)
            rec['retrieval']['required_chunk_ids'] = [x for x in dict.fromkeys(r) if x != rec['id']]
        if rec['retrieval']['required_chunk_ids'] and rec['retrieval']['mode'] == 'self':
            rec['retrieval'].update(mode='parent', context_parent_id=rec['parent_id'],
                                    reason='К собственному полному блоку нужно приложить явно связанные общие условия или комментарий.')


def validate():
    assert not re.search(r'<!-- clinrec ', TEXT)
    ids = {r['id'] for r in ALL_RECORDS}
    assert len(ids) == len(ALL_RECORDS)
    parent_map = {p['id']: p for p in PARENTS + METHOD_PARENTS + APPENDICES}
    chunk_map = {c['id']: c for c in ALL_CHUNKS}
    for rec in ALL_RECORDS:
        assert rec['source_text'] == slice_text(rec['span'])
        assert rec['text'] == CITATION.sub('', rec['source_text'])
        assert not CITATION.search(rec['text'])
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
        assert not (previous.startswith('|') and LINES[line-1].startswith('|')), c['id']
    # An explicit recommendation is never lost or split from its evidence line.
    recs = 0
    for n, line in enumerate(LINES, 1):
        if EVIDENCE_LINE.match(line) and n < 700:
            j = n - 2
            while not LINES[j].strip():
                j -= 1
            owners = [c for c in ALL_CHUNKS if c['span']['start'] <= OFFSETS[j] < c['span']['end']]
            assert len(owners) == 1 and owners[0]['kind'] == 'recommendation', n
            assert owners[0]['span']['end'] > OFFSETS[n-1]
            assert owners[0]['metadata']['evidence_statements']
            recs += 1
    assert recs == 46, recs
    assert len(METHOD_PARENTS) == 2 and len(REFERENCES) == 50
    return coverage


COVERAGE = validate()
MISSING = sorted({n for c in ALL_CHUNKS for n in c['metadata']['unresolved_citation_numbers']})
ISSUES = [dict(chunk_id=c['id'], **r) for c in ALL_CHUNKS for r in c['metadata']['appendix_links']
          if r['status'] in ('ambiguous', 'missing', 'label_name_conflict', 'table_scope_unverified')]
CITATION_ANOMALIES = [dict(chunk_id=c['id'], raw=cs['raw'], anomalies=cs['anomalies'], span=cs['span'])
                      for c in ALL_CHUNKS for cs in c['metadata']['citation_spans'] if cs['anomalies']]
REF_SECTION_SPAN = REF_SECTION['own_span']
FILES = {
    'chunks.json': {'schema_version': '1.0', 'document_id': DOC, 'chunks': CHUNKS},
    'parents.json': {'schema_version': '1.0', 'document_id': DOC, 'parents': PARENTS},
    'methods.json': {'schema_version': '1.0', 'document_id': DOC, 'parents': METHOD_PARENTS, 'chunks': METHOD_CHUNKS},
    'appendices.json': {'schema_version': '1.0', 'document_id': DOC, 'appendices': APPENDICES},
    'supporting.json': {'schema_version': '1.0', 'document_id': DOC, 'records': SUPPORTING},
    'references.json': {'schema_version': '1.0', 'document_id': DOC,
                        'source_span': REF_SECTION_SPAN, 'source_text': slice_text(REF_SECTION_SPAN),
                        'items': REFERENCES, 'unresolved_citation_numbers': MISSING,
                        'completeness': 'provided_bibliography_only_numbers_1_to_50'},
    'sections.json': {'schema_version': '1.0', 'document_id': DOC, 'sections': SECTIONS},
    'coverage.json': {'schema_version': '1.0', 'document_id': DOC, 'partition': COVERAGE},
}
ASSETS = []
for m in IMAGE.finditer(TEXT):
    ASSETS.append({'id': f'{DOC}.image.{len(ASSETS)+1:03}', 'url': m[1],
                   'span': span(m.start(), m.end()), 'content_status': 'external_not_downloaded_or_ocr_processed',
                   'referring_chunk_ids': [c['id'] for c in ALL_CHUNKS if c['span']['start'] <= m.start() < c['span']['end']]})
FILES['assets.json'] = {'schema_version': '1.0', 'document_id': DOC, 'assets': ASSETS}
MANIFEST = {
    'schema_version': '1.0', 'document_id': DOC,
    'title': 'Обсессивно-компульсивное расстройство', 'clinical_year': 2025,
    'guideline_id': re.search(r'КР(\d+_\d+)', TEXT)[1], 'population': 'Взрослые', 'language': 'ru',
    'source_file': PLAN['source'], 'source_sha256': PLAN['source_sha256'],
    'source_url': re.search(r'\*\*Источник:\*\* \[[^\]]+\]\(([^)]+)\)', TEXT)[1],
    'downloaded_date_as_stated': '2026-10-17',
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
        'bibliography_only_numbers': '1-50',
        'appendix_link_issues': ISSUES,
        'citation_format_anomalies': CITATION_ANOMALIES,
        'external_images_not_ocr_processed': True,
        'other': [
            'Категории МКБ в паспорте включают «Постшизофреническая депрессия (F20.4)», хотя раздел кодирования перечисляет только F42.0–F42.9.',
            'Заголовок строки 131 «Cимптомы, течение» начинается с латинской C; заголовок не изменён.',
            'Список литературы вложен в обёртку «1. Клинические рекомендации Российского общества психиатров» (строка 611); настоящий пункт 1 — «1. 1. Мосолов …» (строка 612), нумерация 1–50 сохранена как есть.',
            'Заголовок «Приложение Г1-ГN» (строка 943) — шаблонная формулировка, не относящаяся к конкретному приложению.',
            'Заголовок «Приложение Г 2.» (строка 1356) написан с пробелом; обозначение приведено только в metadata как Г2, исходный текст не менялся.',
            'Подраздел «A3.1» (строка 826) записан латинской A, «А3.2» (строка 844) — кириллической.',
            'Таблица Приложения А3.2 имеет пустую первую строку шапки; реальные заголовки столбцов расположены в третьей строке таблицы.',
            'Нерегулярные скобки: «[82 86]» в таблице А3.2 (строка 861, без разделителя) и «[173,,227, 231]» (строка 381, двойная запятая); номера прочитаны буквально, без исправления.',
            'В Приложении Г1 таблицы списка симптомов (строки 1015–1107) расположены до заголовка «1.2 Список симптомов FLY-BOCS» (строка 1109).',
            'В бланке Г1 (строки 1350–1351) строки 7 и 8, относящиеся к компульсиям, названы «навязчивостей»; сопоставление с пунктами интервью не меняется.',
            'В тексте строки 361 упомянуто «Приложение 4» без буквы; в строке 536 — «Приложение Г» без номера.',
            'Маркер «**» после названий препаратов сохранён как есть (в источнике экранирован как \\*\\*).',
        ]},
    'validation': {'source_hash': 'passed', 'exact_character_coverage': 'passed',
                   'span_round_trip': 'passed', 'relationships': 'passed',
                   'recommendation_ownership': 'passed', 'tables_intact': 'passed'},
}
FILES['manifest.json'] = MANIFEST


def review():
    lines = ['# Решения по чанкам ОКР, 2025', '',
             'Каждая строка — поисковый чанк; полный контекст хранится по `parent_id`. '
             'Решение и его причина также записаны в JSON. Номера строк относятся к исходному Markdown.', '',
             '| Чанк / строки | Тип выдачи | Символов | Содержание |', '| --- | --- | ---: | --- |']
    for c in sorted(ALL_CHUNKS, key=lambda c: c['span']['start']):
        s = c['span']
        lines.append(f'| {c["id"]} / {s["start_line"]}–{s["end_line"]} | {c["retrieval"]["mode"]} | '
                     f'{len(c["source_text"].strip())}{" *" if c["retrieval"]["atomic_oversize"] else ""} | '
                     f'{c["title"].replace("|", "/")} |')
    lines += ['', '`*` — атомарный блок больше 3500 символов: рекомендация с вариантами и дозировками, '
              'таблица или опросник сохранены целиком.', '',
              '## Неразрешённые ссылки', '',
              f'В предоставленном списке литературы только номера 1–50; используются также {len(MISSING)} номеров, которых в нём нет. '
              'Полный список — `references.json:unresolved_citation_numbers`.', '',
              '## Ссылки на приложения с проблемами', '']
    for issue in ISSUES:
        lines.append(f'- {issue["chunk_id"]}, строка {issue["span"]["start_line"]}: '
                     f'`{issue["raw"]}` → {issue["label"]}, **{issue["status"]}**. {issue["review_note"] or ""}'.rstrip())
    lines += ['', '## Нерегулярные библиографические скобки', '']
    for a in CITATION_ANOMALIES:
        lines.append(f'- {a["chunk_id"]}, строка {a["span"]["start_line"]}: `{a["raw"]}` ({", ".join(a["anomalies"])}).')
    lines += ['', '## Прочие особенности источника', ''] + [f'- {x}' for x in MANIFEST['source_issues']['other']]
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
