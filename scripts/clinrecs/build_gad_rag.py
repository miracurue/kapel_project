#!/usr/bin/env python3
"""Build the reviewed local GAD (ГТР) dataset. No network, dependencies or application DB."""

import argparse
import bisect
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/clinrecs/rag/02_gad'
PLAN = json.loads((OUT / 'annotation_plan.json').read_text())
SOURCE = ROOT / PLAN['source']
RAW = SOURCE.read_bytes()
assert hashlib.sha256(RAW).hexdigest() == PLAN['source_sha256'], 'Source changed: review spans first'
TEXT = RAW.decode('utf-8')
_PARTS = TEXT.split('\n')
LINES = [p + '\n' for p in _PARTS[:-1]] + ([_PARTS[-1]] if _PARTS[-1] else [])
OFFSETS = [0]
for line in LINES:
    OFFSETS.append(OFFSETS[-1] + len(line))
assert OFFSETS[-1] == len(TEXT)
PAGE = PLAN['page_proxy_chars']
DOC = PLAN['document_id']
SECTIONS = PLAN['sections']
BY_ID = {s['id']: s for s in SECTIONS}
CITATION = re.compile(r'\[(\s*\d+(?:[\s­]*[-–—,;][\s­]*\d+)*(?:\s+и др\.)?\s*)\]')
# Recommendations here are bullet lines with the verb inside the sentence, not at its start.
RECOMMENDATION = re.compile(r'^\s*-\s+.*[Рр]екоменд')
IMAGE = re.compile(r'!\[[^\]]*\]\(([^)]+)\)')
EVIDENCE = re.compile(r'^(?:\*\*)?Уровень (?:убедительности|достоверности)[^\n]+', re.M)
MARKER = re.compile(r'<!-- clinrec (\{.*\}) -->$')
METHOD_CFG = PLAN['methods']
UNITS = PLAN['units']
SHARED_INTRO = PLAN['shared_intro_units']


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
    return re.sub(r'\s+', ' ', re.sub(r'^[-#*|\s]+', '', CITATION.sub('', s)).replace('*', '')).strip()[:160]


def path_for(section):
    path = [section['title']]
    while section['parent']:
        section = BY_ID[section['parent']]
        path.insert(0, section['title'])
    return path


for i, s in enumerate(SECTIONS):
    a = s['start_line']
    marker = MARKER.match(LINES[a - 1].rstrip('\n'))
    assert marker, a
    meta = json.loads(marker[1])
    assert meta['id'] == s['id'] and meta['title'] == s['title'], a
    # marker, one blank line, then the first content line
    assert LINES[a].strip() == '' and LINES[a + 1].strip() != '', a
    s['content_start_line'] = a + 2
    s['end_line_exclusive'] = next((n['start_line'] for n in SECTIONS[i+1:]
                                    if n['level'] <= s['level']), len(LINES) + 1)
    s['own_end_line_exclusive'] = SECTIONS[i+1]['start_line'] if i+1 < len(SECTIONS) else len(LINES) + 1
    assert s['content_start_line'] < s['own_end_line_exclusive'], a
    s['span'] = line_span(a, s['end_line_exclusive'])
    s['own_span'] = line_span(a, s['own_end_line_exclusive'])
    s['marker_span'] = line_span(a, s['content_start_line'])
    s['content_span'] = line_span(s['content_start_line'], s['own_end_line_exclusive'])
assert not [n for n, l in enumerate(LINES, 1) if MARKER.match(l.rstrip('\n'))
            and n not in {s['start_line'] for s in SECTIONS}]


def collection_for(section):
    return PLAN['collections'].get(section['id'], 'clinical')


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
        if collection_for(section) == 'clinical' and meaningful(section['content_span']):
            result.append(section['content_span'])
    return list(reversed(result))


# Bibliography. The supplied list nests item 1 inside a wrapper, glues many items into one line and
# stops at item 60; numbers are found sequentially so that no item is invented or renumbered.
def parse_references():
    sec = BY_ID['cr02.11.01']
    base = OFFSETS[sec['content_start_line'] - 1]
    seg = TEXT[base:OFFSETS[sec['own_end_line_exclusive'] - 1]]
    m1 = re.search(PLAN['reference_item1_regex'], seg)
    assert m1
    starts = [(1, seg.rfind('\n', 0, m1.start()) + 1, m1.end())]
    cur = m1.end()
    n = 2
    while True:
        m = re.compile(r'(?<=\s)%d\. (?=[A-ZА-ЯЁ«"])' % n).search(seg, cur)
        if not m:
            break
        starts.append((n, m.start(), m.end()))
        cur = m.end()
        n += 1
    assert len(starts) == PLAN['reference_count'], len(starts)
    items = []
    for k, (number, item_start, body_start) in enumerate(starts):
        limit = starts[k + 1][1] if k + 1 < len(starts) else len(seg)
        body = seg[body_start:limit].rstrip()
        assert len(body) > 40, (number, body)
        end = body_start + len(body)
        items.append({'id': f'{DOC}.ref.{number:03}', 'number': number, 'text': body,
                      'span': span(base + item_start, base + end)})
    return items


REFERENCES = parse_references()
REF_BY_NUMBER = {r['number']: r['id'] for r in REFERENCES}


def metadata(s):
    raw = slice_text(s)
    citation_spans = []
    numbers = set()
    for m in CITATION.finditer(raw):
        ns = set()
        listed = []
        for item in re.split(r'[,;]', m[1]):
            bounds = [int(n) for n in re.findall(r'\d+', item)]
            assert 1 <= len(bounds) <= 2
            ns.update(range(bounds[0], bounds[-1] + 1))
            listed.extend(range(bounds[0], bounds[-1] + 1))
        numbers.update(ns)
        citation_spans.append({'raw': m[0], 'numbers': sorted(ns), 'unspecified_others': 'и др.' in m[0],
                               'repeated_numbers': sorted(n for n, c in Counter(listed).items() if c > 1),
                               'span': span(s['start'] + m.start(), s['start'] + m.end())})
    only_images = not re.sub(r'[#*\s]', '', IMAGE.sub('', re.sub(r'^\*\*[^\n]+\*\*\s*$', '', raw, flags=re.M)))
    return {
        'citation_numbers': sorted(numbers),
        'reference_ids': [REF_BY_NUMBER[n] for n in sorted(numbers) if n in REF_BY_NUMBER],
        'unresolved_citation_numbers': sorted(numbers - REF_BY_NUMBER.keys()),
        'citation_spans': citation_spans,
        'evidence_statements': [{'raw': m[0], 'span': span(s['start']+m.start(), s['start']+m.end())}
                                for m in EVIDENCE.finditer(raw)],
        'image_urls': IMAGE.findall(raw),
        'text_coverage': 'text_and_external_images' if IMAGE.search(raw) else 'text',
        'answerability': 'image_content_unavailable' if IMAGE.search(raw) and only_images else 'available_text_only',
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
CHUNK_BY_START = {}
INTRO_REQUIRED = {}


def own(s, category, record_ids):
    OWNERSHIP.append({'span': s, 'collection': category, 'record_ids': record_ids})


def chunk_title(start, end):
    rec = next((n for n in range(start, end) if RECOMMENDATION.match(LINES[n-1])), None)
    if rec:
        return short_title(LINES[rec-1])
    for n in range(start, end):
        title = short_title(LINES[n-1])
        if title:
            return title
    raise AssertionError(start)


for section in SECTIONS:
    own(section['marker_span'], 'structure', [section['id']])
    a, b = section['content_start_line'], section['own_end_line_exclusive']
    category = collection_for(section)
    content = section['content_span']
    if category == 'references':
        own(content, 'references', ['references.source_section'])
        continue
    if category == 'supporting':
        rec = source_record(f'{DOC}.support.{a}', section['title'], content, section)
        rec['index_in_clinical_search'] = False
        SUPPORTING.append(rec)
        own(content, 'supporting', [rec['id']])
        continue
    if not meaningful(content):
        own(content, 'structure', [section['id']])
        continue
    parent_id = f'{DOC}.parent.{a}'
    parent = source_record(parent_id, section['title'], content, section)
    parent['index_in_vector_search'] = False
    parent['section_subtree_span'] = line_span(a, section['end_line_exclusive'])
    parent['child_ids'] = []
    parent['ancestor_context_spans'] = context_spans(section)
    starts = UNITS.get(section['id'], [a])
    assert starts == sorted(set(starts)) and a <= starts[0] < b and starts[-1] < b, section['id']
    if category == 'methods':
        cfg = METHOD_CFG[section['id']]
        parent['id'] = parent_id = f'{DOC}.method.{cfg["key"]}'
        parent['original_appendix_label'] = cfg['label']
        parent['required_context_spans'] = [line_span(starts[0], starts[1])] if len(starts) > 1 else []
        METHOD_PARENTS.append(parent)
    elif category == 'appendices':
        parent['original_appendix_label'] = (
            re.sub(r'\s+', '', re.search(r'Приложение ([АБВ]\s*\d*)', section['title'])[1])
            if section['title'].startswith('Приложение') else None)
        APPENDICES.append(parent)
    else:
        PARENTS.append(parent)
    if starts[0] > a:
        prefix = line_span(a, starts[0])
        assert not meaningful(prefix), (section['id'], 'meaningful text left outside any chunk')
        own(prefix, 'structure', [section['id']])
    group = []
    parent_len = len(slice_text(content).strip())
    for i, start in enumerate(starts):
        end = starts[i+1] if i+1 < len(starts) else b
        s = line_span(start, end)
        chunk_id = f'{DOC}.chunk.{start:04}'
        title = PLAN['titles'].get(str(start)) or chunk_title(start, end)
        if category == 'methods' and i:
            title = f'{METHOD_CFG[section["id"]]["short_name"]}: {title}'
        rec = source_record(chunk_id, title, s, section)
        has_rec = any(RECOMMENDATION.match(LINES[n-1]) for n in range(start, end))
        assert sum(bool(RECOMMENDATION.match(LINES[n-1])) for n in range(start, end)) <= 1, start
        if str(start) in PLAN['kinds']:
            kind = PLAN['kinds'][str(start)]
        elif category == 'methods':
            kind = 'method_component'
        elif has_rec:
            kind = 'recommendation'
        elif SHARED_INTRO.get(section['id']) == start:
            kind = 'section_introduction'
        else:
            kind = 'semantic_block' if len(starts) == 1 else 'narrative_topic'
        rec['kind'] = kind
        rec['collection'] = category
        rec['index_in_vector_search'] = True
        rec['parent_id'] = parent_id
        single = len(starts) == 1
        standalone = single and category == 'clinical' and not context_spans(section)
        if standalone:
            mode, reason = 'self', 'Единый смысловой блок с полными условиями; достаточно пути заголовков и паспорта документа.'
        elif parent_len <= PAGE:
            mode, reason = 'parent', 'Условия и пояснения объединяют пункты; полный смысловой родитель не превышает условную страницу.'
        else:
            mode, reason = 'window', 'Полный родитель больше условной страницы; вернуть чанк и ближайших соседей того же родителя с общими условиями.'
        override = PLAN['retrieval_overrides'].get(str(start))
        if override:
            mode, reason = override['mode'], override['reason']
        always = context_spans(section)
        if category == 'methods' and i:
            always = always + parent['required_context_spans']
        rec['retrieval'] = {'mode': mode, 'reason': reason,
                            'context_parent_id': parent_id if mode != 'self' else None,
                            'previous_chunk_id': None, 'next_chunk_id': None,
                            'required_chunk_ids': [], 'always_include_spans': always,
                            'neighbor_limit_each_side': 1 if mode == 'window' else 0,
                            'atomic_oversize': len(rec['source_text'].strip()) > PAGE}
        parent['child_ids'].append(chunk_id)
        group.append(rec)
        CHUNK_BY_START[start] = rec
        own(s, category, [chunk_id])
    for i, chunk in enumerate(group):
        chunk['retrieval']['previous_chunk_id'] = group[i-1]['id'] if i else None
        chunk['retrieval']['next_chunk_id'] = group[i+1]['id'] if i+1 < len(group) else None
        intro = SHARED_INTRO.get(section['id'])
        if intro and chunk['span']['start_line'] != intro:
            chunk['retrieval']['required_chunk_ids'].append(f'{DOC}.chunk.{intro:04}')
        if chunk['retrieval']['atomic_oversize']:
            chunk['retrieval']['reason'] += ' Превышение размера сохранено намеренно: нельзя отрывать варианты рекомендации, общий комментарий, таблицу, абзац-перечень или пункты инструмента.'
    if category == 'methods':
        cfg = METHOD_CFG[section['id']]
        if cfg['item_text_absent']:
            for r in [parent] + group:
                r['metadata']['text_coverage'] = 'text_passport_only'
                r['metadata']['answerability'] = 'passport_only_item_text_not_provided'
        METHOD_CHUNKS.extend(group)
    elif category == 'appendices':
        parent['chunks'] = group
    else:
        CHUNKS.extend(group)


# Explicit nonlocal dependencies, not neighboring-text guesses.
ALL_CHUNKS = CHUNKS + METHOD_CHUNKS + [c for p in APPENDICES for c in p['chunks']]
for start, deps in PLAN['required_units'].items():
    chunk = CHUNK_BY_START[int(start)]
    chunk['retrieval']['required_chunk_ids'] += [f'{DOC}.chunk.{n:04}' for n in deps]
for chunk in ALL_CHUNKS:
    chunk['retrieval']['required_chunk_ids'] = list(dict.fromkeys(chunk['retrieval']['required_chunk_ids']))
    if chunk['retrieval']['required_chunk_ids'] and chunk['retrieval']['mode'] == 'self':
        chunk['retrieval'].update(mode='parent', context_parent_id=chunk['parent_id'],
                                  reason='К собственному полному блоку нужно приложить явно связанные общие условия или комментарий.')
for key in list(PLAN['titles']) + list(PLAN['kinds']) + list(PLAN['retrieval_overrides']):
    assert int(key) in CHUNK_BY_START, f'plan refers to unknown chunk line {key}'

ALL_RECORDS = ALL_CHUNKS + PARENTS + METHOD_PARENTS + APPENDICES + SUPPORTING
TARGETS = METHOD_PARENTS + APPENDICES
NAME_BY_LABEL = {cfg['label']: cfg['name_pattern'] for cfg in METHOD_CFG.values()}
NAME_BY_LABEL.update(PLAN['appendix_name_patterns'])
ID_BY_LABEL = {t['original_appendix_label']: t['id'] for t in TARGETS if t.get('original_appendix_label')}
assert len(ID_BY_LABEL) == len([t for t in TARGETS if t.get('original_appendix_label')]), 'duplicate appendix label'


def appendix_links(s):
    raw = slice_text(s)
    result = []
    # Include shorthand continuation labels, e.g. «Приложение Г2, Г5».
    pattern = r'[Пп]риложени[еяиюях]+\s+([АБВГ]\s*\.?\s*\d*(?:\s*,\s*[АБВГ]\s*\d+)*)'
    for m in re.finditer(pattern, raw):
        for label_match in re.finditer(r'[АБВГ]\s*\.?\s*\d*', m[1]):
            label = re.sub(r'[\s.]', '', label_match[0])
            candidates = [t['id'] for t in TARGETS if t.get('original_appendix_label') == label]
            if label == 'Б':
                candidates = [t['id'] for t in APPENDICES if (t.get('original_appendix_label') or '').startswith('Б')]
            # Names near a reference help surface source-label conflicts; never relabel it.
            nearby = raw[max(0, m.start()-170):m.end()+20]
            named = [ID_BY_LABEL[lb] for lb, pat in NAME_BY_LABEL.items() if re.search(pat, nearby, re.I)]
            status = 'resolved_group' if label == 'Б' else 'resolved' if len(candidates) == 1 else 'ambiguous' if candidates else 'missing'
            if named and candidates and not set(named).intersection(candidates):
                status = 'label_name_conflict'
            elif len(candidates) > 1 and len(set(named).intersection(candidates)) == 1:
                status = 'resolved_by_name'
            note = None
            table = re.search(r'табл\.?\s*(\d+)[\s,]*$', raw[max(0, m.start()-25):m.start()])
            if table and label in PLAN['appendix_table_numbers'] and int(table[1]) not in PLAN['appendix_table_numbers'][label]:
                status = 'table_scope_unverified'
                note = (f'Упомянута таблица {table[1]} при Приложении {label}; в нём есть только '
                        f'«Таблица {PLAN["appendix_table_numbers"][label][0]}».')
            resolved = list(set(named).intersection(candidates)) if status == 'resolved_by_name' else candidates if status in ('resolved', 'resolved_group') else []
            result.append({'raw': m[0], 'label': label, 'status': status,
                           'declared_target_ids': candidates, 'named_method_candidate_ids': named,
                           'resolved_target_ids': sorted(resolved), 'review_note': note,
                           'span': span(s['start']+m.start(), s['start']+m.end())})
    return result


code_targets = {}
for chunk in CHUNKS:
    if chunk['section_id'] == 'cr02.01.01.03':
        for line in chunk['source_text'].splitlines():
            m = re.match(r'(F\s*\d+(?:\.\d+)?)\s*[–-]', line)
            if m:
                code_targets[re.sub(r'\s+', '', m[1])] = chunk['id']
for rec in ALL_RECORDS:
    rec['metadata']['appendix_links'] = appendix_links(rec['span'])
    rec['metadata']['named_method_ids'] = [ID_BY_LABEL[lb] for lb, pat in NAME_BY_LABEL.items()
                                          if lb.startswith('Г') and re.search(pat, rec['source_text'], re.I)]
    if rec in ALL_CHUNKS:
        codes = set(re.sub(r'\s+', '', m[0]) for m in re.finditer(r'F\s*\d{2}(?:\.\d+)?', rec['source_text']))
        rec['metadata']['related_classification_chunk_ids'] = sorted({code_targets[c] for c in codes if c in code_targets} - {rec['id']})


def validate():
    ids = {r['id'] for r in ALL_RECORDS}
    assert len(ids) == len(ALL_RECORDS)
    parent_map = {p['id']: p for p in PARENTS + METHOD_PARENTS + APPENDICES}
    chunk_map = {c['id']: c for c in ALL_CHUNKS}
    for rec in ALL_RECORDS:
        assert rec['source_text'] == slice_text(rec['span'])
        assert rec['text'] == CITATION.sub('', rec['source_text'])
        assert '<!-- clinrec' not in rec['source_text']
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
        assert not (previous.startswith('|') and LINES[line-1].startswith('|'))
    # An explicit recommendation is never lost or split from its evidence/comment.
    without_evidence = []
    for n, line in enumerate(LINES, 1):
        if RECOMMENDATION.match(line):
            owners = [c for c in ALL_CHUNKS if c['span']['start'] <= OFFSETS[n-1] < c['span']['end']]
            assert len(owners) == 1, n
            assert owners[0]['kind'] == 'recommendation', n
            if not owners[0]['metadata']['evidence_statements']:
                without_evidence.append(n)
    assert without_evidence == PLAN['recommendations_without_evidence_lines'], without_evidence
    # Evidence statements stay inside recommendation chunks.
    for c in ALL_CHUNKS:
        if c['metadata']['evidence_statements']:
            assert c['kind'] == 'recommendation', c['id']
    assert len(METHOD_PARENTS) == 16 and len(REFERENCES) == PLAN['reference_count']
    return coverage, without_evidence


COVERAGE, WITHOUT_EVIDENCE = validate()
MISSING = sorted({n for c in ALL_CHUNKS for n in c['metadata']['unresolved_citation_numbers']})
ISSUES = [dict(chunk_id=c['id'], **r) for c in ALL_CHUNKS for r in c['metadata']['appendix_links']
          if r['status'] in ('ambiguous', 'missing', 'label_name_conflict', 'table_scope_unverified')]
REPEATED = [{'chunk_id': c['id'], 'raw': cs['raw'], 'numbers': cs['repeated_numbers'], 'span': cs['span']}
            for c in ALL_CHUNKS for cs in c['metadata']['citation_spans'] if cs['repeated_numbers']]
FILES = {
    'chunks.json': {'schema_version': '1.0', 'document_id': DOC, 'chunks': CHUNKS},
    'parents.json': {'schema_version': '1.0', 'document_id': DOC, 'parents': PARENTS},
    'methods.json': {'schema_version': '1.0', 'document_id': DOC, 'parents': METHOD_PARENTS, 'chunks': METHOD_CHUNKS},
    'appendices.json': {'schema_version': '1.0', 'document_id': DOC, 'appendices': APPENDICES},
    'supporting.json': {'schema_version': '1.0', 'document_id': DOC, 'records': SUPPORTING},
    'references.json': {'schema_version': '1.0', 'document_id': DOC,
                        'source_span': BY_ID['cr02.11.01']['content_span'],
                        'source_text': slice_text(BY_ID['cr02.11.01']['content_span']),
                        'items': REFERENCES, 'unresolved_citation_numbers': MISSING,
                        'completeness': 'provided_bibliography_only_numbers_1_to_60'},
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
    'title': 'Генерализованное тревожное расстройство', 'clinical_year': 2024,
    'guideline_id': re.search(r'\*\*ID:\*\* (\d+)', TEXT)[1], 'population': 'Взрослые', 'language': 'ru',
    'source_file': PLAN['source'], 'source_sha256': PLAN['source_sha256'],
    'source_url': re.search(r'\*\*Источник:\*\* \[[^\]]+\]\(([^)]+)\)', TEXT)[1],
    'downloaded_date_as_stated': '-'.join(reversed(re.search(r'\*\*Дата скачивания:\*\* (\d\d\.\d\d\.\d{4})', TEXT)[1].split('.'))),
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
        'duplicate_appendix_label': None,
        'duplicate_table_labels': PLAN['duplicate_table_labels'],
        'repeated_numbers_inside_citation': REPEATED,
        'recommendations_without_evidence': [
            {'line': n, 'chunk_id': f'{DOC}.chunk.{n:04}' if n in CHUNK_BY_START else None} for n in WITHOUT_EVIDENCE],
        'text_inconsistencies': PLAN['text_inconsistencies'],
        'instruments_without_item_text': [m['id'] for m in METHOD_PARENTS
                                          if m['metadata']['text_coverage'] == 'text_passport_only'],
        'reference_list_layout': 'Item 1 is nested in a wrapper item; most items share one physical line; '
                                 'page numbers are mixed into some items. Items were located by sequential numbers 1-60 '
                                 'without renumbering or completion.',
        'legacy_clinrec_markers_present_in_source': True,
        'external_images_not_ocr_processed': True},
    'validation': {'source_hash': 'passed', 'exact_character_coverage': 'passed',
                   'span_round_trip': 'passed', 'relationships': 'passed',
                   'recommendation_ownership': 'passed', 'tables_intact': 'passed'},
}
FILES['manifest.json'] = MANIFEST


def review():
    lines = ['# Решения по чанкам ГТР, 2024', '',
             'Каждая строка — поисковый чанк; полный контекст хранится по `parent_id`. '
             'Решение и его причина также записаны в JSON. Номера строк относятся к исходному Markdown; '
             'строки старых меток `<!-- clinrec -->` в чанки не входят.', '',
             '| Чанк / строки | Тип выдачи | Символов | Содержание |', '| --- | --- | ---: | --- |']
    for c in sorted(ALL_CHUNKS, key=lambda c: c['span']['start']):
        s = c['span']
        lines.append(f'| {c["id"]} / {s["start_line"]}–{s["end_line"]} | {c["retrieval"]["mode"]} | '
                     f'{len(c["source_text"].strip())}{" *" if c["retrieval"]["atomic_oversize"] else ""} | '
                     f'{c["title"].replace("|", "/")} |')
    lines += ['', '`*` — атомарный блок больше 3500 символов: таблица, список, единый абзац-перечень '
              'или опросник сохранены целиком.', '',
              '## Неразрешённые ссылки на литературу', '',
              f'В предоставленном списке литературы только номера 1–{len(REFERENCES)}; отсутствуют {len(MISSING)} '
              'цитируемых номеров. Полный список — `references.json:unresolved_citation_numbers`.', '']
    if REPEATED:
        lines += ['Повторы номера внутри одной скобки (сохранены как в источнике):', '']
        for r in REPEATED:
            lines.append(f'- {r["chunk_id"]}, строка {r["span"]["start_line"]}: `{r["raw"]}`, повтор {r["numbers"]}.')
        lines.append('')
    lines += ['## Ссылки на приложения', '']
    for issue in ISSUES:
        names = ', '.join(issue['named_method_candidate_ids']) or 'нет'
        lines.append(f'- {issue["chunk_id"]}, строка {issue["span"]["start_line"]}: '
                     f'`{issue["raw"]}` → {issue["label"]}, **{issue["status"]}**; '
                     f'кандидаты по названию: {names}.' + (f' {issue["review_note"]}' if issue['review_note'] else ''))
    lines += ['', '## Рекомендации без УДД/УУР', '']
    for n in WITHOUT_EVIDENCE:
        lines.append(f'- строка {n}: {LINES[n-1].strip()[:140]}')
    lines += ['', '## Противоречия и неточности источника (не исправлены)', '']
    for issue in PLAN['text_inconsistencies']:
        lines.append(f'- строки {", ".join(map(str, issue["lines"]))}: {issue["note"]}')
    for dup in PLAN['duplicate_table_labels']:
        lines.append(f'- подпись «{dup["label"]}» повторяется в строках {", ".join(map(str, dup["lines"]))}.')
    lines += ['', '## Инструменты без текста пунктов', '']
    for m in METHOD_PARENTS:
        if m['metadata']['text_coverage'] == 'text_passport_only':
            lines.append(f'- {m["id"]} ({m["original_appendix_label"]}): только паспорт методики.')
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
