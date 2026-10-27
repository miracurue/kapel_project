#!/usr/bin/env python3
"""Build the reviewed local dataset for adult schizophrenia 2024. No network, dependencies or application DB."""

import argparse
import bisect
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/clinrecs/rag/26_schizophrenia'
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
SECTIONS = PLAN['sections']
BY_ID = {s['id']: s for s in SECTIONS}
UNITS = PLAN['units']
CITATION = re.compile(r'\[(\s*\d+(?:[\s­]*[-–—,;][\s­]*\d+)*(?:\s+и др\.)?\s*)\]')
IMAGE = re.compile(r'!\[[^\]]*\]\(([^)]+)\)')
EVIDENCE = re.compile(r'^(?:\*\*)?Уровень[^\n]+', re.M)
RECOMMENDATION_BULLET = re.compile(r'^\s*-\s.*[Рр]екомендуе?тс[яь]|^\s*-\s.*[Рр]екомендуются')
METHODS = {m['section_line']: m for m in PLAN['methods']}
NAME_PATTERNS = {
    'panss': r'PANSS|позитивных и негативных', 'bnss': r'BNSS|краткой оценки негативных',
    'cdss': r'Калгари', 'psp': r'\bPSP\b|личностного и социального функционирования',
    'sadp': r'SAD[ -]?Person|ургентной оценки суицидального', 'cssrs': r'Колумбийск|C-?SSRS',
    'sas': r'\bSAS\b|Симпсона', 'bfcrs': r'Буша|Френсис|BFCRS',
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
    return re.sub(r'\s+', ' ', re.sub(r'^[-#*\s]+', '', CITATION.sub('', s)).replace('*', '')).strip()[:160]


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
    s['kind'] = 'document' if not s['parent'] else 'section' if any(n['parent'] == s['id'] for n in SECTIONS) else 'block'


# The supplied bibliography is nested in a wrapper item: «1. 1. Cardno ...», then six-space items.
REF_SECTION = next(s for s in SECTIONS if s['collection'] == 'references')
ref_starts = []
for n in range(REF_SECTION['start_line'], REF_SECTION['own_end_line_exclusive']):
    first = re.match(r'^ {3}1\. 1\. ', LINES[n-1])
    m = first or re.match(r'^ {6}(\d+)\. ', LINES[n-1])
    if m:
        ref_starts.append((n, 1 if first else int(m[1]), m.end()))
assert [r[1] for r in ref_starts] == list(range(1, len(ref_starts) + 1)), 'Bibliography numbering is not 1..N'
REFERENCES = []
for i, (n, number, skip) in enumerate(ref_starts):
    stop = ref_starts[i+1][0] if i+1 < len(ref_starts) else REF_SECTION['own_end_line_exclusive']
    last = max(k for k in range(n, stop) if LINES[k-1].strip())
    end = OFFSETS[last-1] + len(LINES[last-1].rstrip())
    indent = len(LINES[n-1]) - len(LINES[n-1].lstrip())
    REFERENCES.append({'id': f'{DOC}.ref.{number:03}', 'number': number,
                       'text': TEXT[OFFSETS[n-1] + skip:end], 'continuation_lines': last - n,
                       'span': span(OFFSETS[n-1] + indent, end)})
REF_BY_NUMBER = {r['number']: r['id'] for r in REFERENCES}


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
    """Short generic recommendations of ancestor sections apply to every subsection."""
    result = []
    while section['parent']:
        section = BY_ID[section['parent']]
        if section['level'] == 1:
            continue  # Source passport is attached from manifest, never the whole document.
        if (section['collection'] == 'clinical' and meaningful(section['own_span'])
                and len(slice_text(section['own_span']).strip()) <= PLAN['ancestor_context_max_chars']):
            result.append(section['own_span'])
    return list(reversed(result))


def appendix_label(section):
    m = re.match(r'Приложение ([АБВ]\d*)', section['title']) or re.match(r'([AА]\d\.\d)', section['title'])
    return m[1].replace('A', 'А') if m else None  # Latin A in the source label is normalised only here.


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
    if not meaningful(section['own_span']):
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
    method = METHODS.get(a)
    if category == 'methods':
        parent['id'] = parent_id = f'{DOC}.method.{method["key"]}'
        parent['original_appendix_label'] = method['label']
        parent['required_context_spans'] = [line_span(x, y) for x, y in method['required_context_lines']]
        METHOD_PARENTS.append(parent)
    elif category == 'appendices':
        parent['original_appendix_label'] = appendix_label(section)
        APPENDICES.append(parent)
    else:
        PARENTS.append(parent)
    units = UNITS.get(str(a), [[a, 'semantic_block']])
    starts = [u[0] for u in units]
    assert starts == sorted(set(starts)) and starts[0] >= a and starts[-1] < b, (a, starts)
    if starts[0] > a:
        own(line_span(a, starts[0]), 'structure', [section['id']])
    group = []
    for i, (start, kind) in enumerate(units):
        end = starts[i+1] if i+1 < len(starts) else b
        s = line_span(start, end)
        chunk_id = f'{DOC}.chunk.{start:04}'
        title = PLAN['title_overrides'].get(str(start))
        if not title:
            if method and i:
                informative = next(LINES[k-1] for k in range(start, end) if LINES[k-1].strip()
                                   and not re.match(r'^\*{3}|\*\*(Критерии диагностики|Шкалы позитивных)', LINES[k-1]))
                title = f'{method["label"]} {method["name"]}: ' + short_title(informative)
            else:
                title = short_title(LINES[start-1])
        rec = source_record(chunk_id, title, s, section)
        rec['kind'] = kind
        rec['collection'] = category
        rec['index_in_vector_search'] = True
        rec['parent_id'] = parent_id
        standalone = len(starts) == 1 and category == 'clinical' and not context_spans(section)
        small_parent = len(slice_text(full_span).strip()) <= PAGE
        if method:
            mode = method['mode']
            reason = {'self': 'Компонент шкалы самодостаточен вместе с обязательными разделами инструкции и ключа.',
                      'window': 'Компоненты шкалы продолжают друг друга; вернуть чанк и ближайших соседей того же родителя с инструкцией.',
                      'parent': 'Шкала короткая; полный родитель не превышает условную страницу.'}[mode]
        elif kind in ('table', 'quality_criteria', 'appendix_component'):
            mode, reason = 'self', 'Таблица, список или раздел приложения с заголовком самодостаточны; соседние компоненты не добавляются.'
        elif kind == 'classification':
            mode, reason = 'self', 'Критерии конкретной формы целиком в чанке; общие критерии F20.0–F20.3 приложены явной связью, соседние формы не нужны.'
        elif standalone:
            mode, reason = 'self', 'Единый смысловой блок с полными условиями; достаточно пути заголовков и паспорта документа.'
        elif small_parent:
            mode, reason = 'parent', 'Условия и пояснения объединяют пункты; полный смысловой родитель не превышает условную страницу.'
        else:
            mode, reason = 'window', 'Полный родитель больше условной страницы; вернуть чанк и ближайших соседей того же родителя с общими условиями.'
        rec['retrieval'] = {'mode': mode, 'reason': reason,
                            'context_parent_id': parent_id if mode in ('parent', 'window') else None,
                            'previous_chunk_id': None, 'next_chunk_id': None,
                            'required_chunk_ids': [], 'always_include_spans': context_spans(section),
                            'neighbor_limit_each_side': 1 if mode == 'window' else 0,
                            'atomic_oversize': len(rec['source_text'].strip()) > PAGE}
        if method:
            rec['retrieval']['always_include_spans'] += parent['required_context_spans']
            for dep in method['component_requires'].get(str(start), []):
                rec['retrieval']['required_chunk_ids'].append(f'{DOC}.chunk.{dep:04}')
        parent['child_ids'].append(chunk_id)
        group.append(rec)
        own(s, category, [chunk_id])
    for i, chunk in enumerate(group):
        chunk['retrieval']['previous_chunk_id'] = group[i-1]['id'] if i else None
        chunk['retrieval']['next_chunk_id'] = group[i+1]['id'] if i+1 < len(group) else None
        if group[0]['kind'] == 'section_introduction' and i and chunk['retrieval']['mode'] == 'window':
            chunk['retrieval']['required_chunk_ids'].append(group[0]['id'])
        if chunk['retrieval']['atomic_oversize']:
            chunk['retrieval']['reason'] += ' Превышение размера сохранено намеренно: нельзя отрывать варианты рекомендации, таблицу или пункты инструмента.'
    if category == 'methods':
        METHOD_CHUNKS.extend(group)
    elif category == 'appendices':
        parent['chunks'] = group
    else:
        CHUNKS.extend(group)


# Explicit non-local dependencies, not neighbouring-text guesses.
GENERAL = f'{DOC}.chunk.{PLAN["required_chunks"]["general_diagnostic_criteria_line"]:04}'
for chunk in CHUNKS:
    if chunk['span']['start_line'] in PLAN['required_chunks']['dependent_criteria_lines']:
        chunk['retrieval']['required_chunk_ids'].append(GENERAL)
    chunk['retrieval']['required_chunk_ids'] = list(dict.fromkeys(chunk['retrieval']['required_chunk_ids']))


ALL_CHUNKS = CHUNKS + METHOD_CHUNKS + [c for p in APPENDICES for c in p['chunks']]
ALL_RECORDS = ALL_CHUNKS + PARENTS + METHOD_PARENTS + APPENDICES + SUPPORTING
TARGETS = METHOD_PARENTS + APPENDICES
TABLE_CHUNKS = {}
for p in APPENDICES:
    for c in p['chunks']:
        m = re.match(r'Таблица (\d+)\.', c['title'])
        if c['kind'] == 'table' and m:
            TABLE_CHUNKS[int(m[1])] = c['id']
APPENDIX_START_LINE = min(TARGETS, key=lambda t: t['span']['start'])['span']['start_line']
REVIEWS = {(r['line'], r['label']): r for r in PLAN['link_reviews']}


def appendix_links(s):
    raw = slice_text(s)
    result = []
    pattern = (r'[Пп]риложени[еяиюях]+\s+([АБВГA](?:\d+(?:\.\d+)?)?)(?![А-Яа-яA-Za-z])'
               r'((?:\s*(?:,|и)\s*[АБВГ]\d+(?:\.\d+)?)*)')
    for m in re.finditer(pattern, raw):
        for label in [m[1]] + re.findall(r'[АБВГ]\d+(?:\.\d+)?', m[2]):
            label = label.replace('A', 'А')
            if label == 'А3':
                candidates = [t['id'] for t in APPENDICES if (t.get('original_appendix_label') or '').startswith('А3.')]
            elif label in ('А', 'Б', 'В'):
                candidates = [t['id'] for t in APPENDICES if (t.get('original_appendix_label') or '').startswith(label)]
            else:
                candidates = [t['id'] for t in TARGETS if t['original_appendix_label'] == label]
            nearby = raw[max(0, m.start()-170):m.end()+20]
            named = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items() if re.search(pat, nearby, re.I)]
            group = label in ('А3', 'А', 'Б', 'В')
            status = 'resolved_group' if group and candidates else 'resolved' if len(candidates) == 1 else 'ambiguous' if candidates else 'missing'
            if label.startswith('Г') and len(named) == 1 and candidates and named[0] not in candidates:
                status = 'label_name_conflict'
            result.append({'raw': m[0], 'label': label, 'status': status,
                           'declared_target_ids': candidates, 'named_method_candidate_ids': named,
                           'resolved_target_ids': sorted(candidates) if status in ('resolved', 'resolved_group') else [],
                           'review_note': None, 'span': span(s['start']+m.start(), s['start']+m.end())})
    for m in re.finditer(r'Таблиц[аеуы]?\s*(\d)', raw):
        label = f'Таблица {m[1]}'
        line = bisect.bisect_right(OFFSETS, s['start'] + m.start())
        target = TABLE_CHUNKS.get(int(m[1]))
        if not target or line >= APPENDIX_START_LINE:
            continue  # titles inside the appendices themselves are not references
        review = REVIEWS.get((line, label))
        status = review['status'] if review else 'resolved'
        result.append({'raw': m[0], 'label': label, 'status': status,
                       'declared_target_ids': [target], 'named_method_candidate_ids': [],
                       'resolved_target_ids': [target] if status == 'resolved' else [],
                       'review_note': review['note'] if review else None,
                       'span': span(s['start']+m.start(), s['start']+m.end())})
    result.sort(key=lambda r: (r['span']['start'], r['label']))
    return result


code_targets = {}
for chunk in CHUNKS:
    if chunk['kind'] == 'classification':
        m = re.match(r'F\d+\.\d+', chunk['title'])
        if m:
            code_targets[m[0]] = chunk['id']
code_targets['F20.8'] = code_targets['F20.9'] = f'{DOC}.chunk.0310'
for rec in ALL_RECORDS:
    rec['metadata']['appendix_links'] = appendix_links(rec['span'])
    rec['metadata']['named_method_ids'] = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items()
                                          if re.search(pat, rec['source_text'], re.I)]
    if rec in ALL_CHUNKS:
        codes = set(re.sub(r'\s+', '', m[0]) for m in re.finditer(r'F\s*20\.\d', rec['source_text']))
        rec['metadata']['related_classification_chunk_ids'] = sorted({code_targets[c] for c in codes if c in code_targets} - {rec['id']})


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
            assert set(ref['declared_target_ids'] + ref['named_method_candidate_ids']) <= ids | set(chunk_map)
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
        if c['retrieval']['mode'] in ('parent', 'window'):
            assert c['retrieval']['context_parent_id'] in parent_map
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
    # A recommendation bullet is never separated from its evidence statement.
    for n, line in enumerate(LINES, 1):
        if RECOMMENDATION_BULLET.match(line):
            owners = [c for c in ALL_CHUNKS if c['span']['start'] <= OFFSETS[n-1] < c['span']['end']]
            assert len(owners) == 1, n
            if owners[0]['kind'] == 'recommendation':
                assert owners[0]['metadata']['evidence_statements'], n
    # Evidence lines never fall outside a search chunk.
    for m in EVIDENCE.finditer(TEXT):
        assert any(c['span']['start'] <= m.start() < c['span']['end'] for c in ALL_CHUNKS), m.start()
    for issue in PLAN['known_source_issues']:
        assert issue['quote'] in TEXT, issue['id']
    assert len(METHOD_PARENTS) == len(PLAN['methods']) and len(REFERENCES) == 48
    return coverage


COVERAGE = validate()
MISSING = sorted({n for c in ALL_CHUNKS for n in c['metadata']['unresolved_citation_numbers']})
ISSUES = [dict(chunk_id=c['id'], **r) for c in ALL_CHUNKS for r in c['metadata']['appendix_links']
          if r['status'] in ('ambiguous', 'missing', 'label_name_conflict', 'table_scope_unverified')]
FILES = {
    'chunks.json': {'schema_version': '1.0', 'document_id': DOC, 'chunks': CHUNKS},
    'parents.json': {'schema_version': '1.0', 'document_id': DOC, 'parents': PARENTS},
    'methods.json': {'schema_version': '1.0', 'document_id': DOC, 'parents': METHOD_PARENTS, 'chunks': METHOD_CHUNKS},
    'appendices.json': {'schema_version': '1.0', 'document_id': DOC, 'appendices': APPENDICES},
    'supporting.json': {'schema_version': '1.0', 'document_id': DOC, 'records': SUPPORTING},
    'references.json': {'schema_version': '1.0', 'document_id': DOC,
                        'source_span': REF_SECTION['own_span'],
                        'source_text': slice_text(REF_SECTION['own_span']),
                        'items': REFERENCES, 'unresolved_citation_numbers': MISSING,
                        'completeness': f'provided_bibliography_only_numbers_1_to_{len(REFERENCES)}'},
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
    'title': PLAN['title'], 'clinical_year': PLAN['clinical_year'],
    'guideline_id': PLAN['guideline_id'], 'population': PLAN['population'], 'language': 'ru',
    'source_file': PLAN['source'], 'source_sha256': PLAN['source_sha256'],
    'source_url': re.search(r'\*\*Источник:\*\* \[[^\]]+\]\(([^)]+)\)', TEXT)[1],
    'downloaded_date_as_stated': PLAN['downloaded_date_as_stated'],
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
    'source_issues': {'missing_reference_numbers': MISSING, 'appendix_link_issues': ISSUES,
                      'known_source_issues': PLAN['known_source_issues'],
                      'external_images_not_ocr_processed': True},
    'validation': {'source_hash': 'passed', 'exact_character_coverage': 'passed',
                   'span_round_trip': 'passed', 'relationships': 'passed',
                   'recommendation_ownership': 'passed', 'tables_intact': 'passed'},
}
FILES['manifest.json'] = MANIFEST


def review():
    lines = ['# Решения по чанкам: шизофрения у взрослых, 2024', '',
             'Каждая строка — поисковый чанк; полный контекст хранится по `parent_id`. '
             'Решение и его причина также записаны в JSON. Номера строк относятся к исходному Markdown.', '',
             '| Чанк / строки | Тип выдачи | Символов | Содержание |', '| --- | --- | ---: | --- |']
    for c in sorted(ALL_CHUNKS, key=lambda c: c['span']['start']):
        s = c['span']
        lines.append(f'| {c["id"]} / {s["start_line"]}–{s["end_line"]} | {c["retrieval"]["mode"]} | '
                     f'{len(c["source_text"].strip())}{" *" if c["retrieval"]["atomic_oversize"] else ""} | '
                     f'{c["title"].replace("|", "/")} |')
    lines += ['', '`*` — атомарный блок больше 3500 символов: список вариантов, таблица, '
              'опросник или общий комментарий сохранены целиком.', '',
              '## Неразрешённые ссылки', '',
              f'В предоставленном списке литературы {len(REFERENCES)} позиций (1–{len(REFERENCES)}); '
              f'отсутствуют {len(MISSING)} используемых в тексте номеров. '
              'Полный список — `references.json:unresolved_citation_numbers`.', '']
    for issue in ISSUES:
        lines.append(f'- {issue["chunk_id"]}, строка {issue["span"]["start_line"]}: '
                     f'`{issue["raw"]}` → {issue["label"]}, **{issue["status"]}**'
                     + (f'. {issue["review_note"]}' if issue.get('review_note') else '.'))
    lines += ['', '## Особенности и противоречия источника', '']
    for issue in PLAN['known_source_issues']:
        lines.append(f'- `{issue["id"]}`: {issue["note"]}')
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
