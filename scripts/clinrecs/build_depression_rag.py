#!/usr/bin/env python3
"""Build the reviewed local depression (depr_2024) dataset. No network, dependencies or application DB."""

import argparse
import bisect
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/clinrecs/rag/04_depression'
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
CITATION = re.compile(r'\[(\s*\d+(?:[\s­]*[-–—,;][\s­]*\d+)*(?:\s+и др\.)?\s*)\]')
IMAGE = re.compile(r'!\[[^\]]*\]\(([^)]+)\)')
EVIDENCE = re.compile(r'^[^\S\n]*(?:\*\*)?Уровень (?:убедительности|достоверности)[^\n]+', re.M)
REC_BULLET = re.compile(r'^\s*-\s.*?(?:[Рр]екомендуется|[Рр]екомендовано|[Рр]екомендован|[Рр]екомендуются)')
NAME_PATTERNS = {
    'hamd17': r'Гамильтон|HAM[ -]?D|HDRS', 'madrs': r'Монтгомери|MADRS',
    'hcl33': r'HCL[ -]?33', 'cssrs': r'Колумбийск|[СC]-?SSRS',
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
BY_LINE = {s['start_line']: s for s in SECTIONS}


def parse_references():
    """Items are 'N.' alone on a line followed by one text line; item 1 is wrapped as '1. 1.'."""
    section = next(s for s in SECTIONS if s['collection'] == 'references')
    items = []
    for n in range(section['start_line'], section['own_end_line_exclusive']):
        m = re.match(r'^\s+(\d+)\.\s*(?:1\.)?\s*$', LINES[n-1])
        if not m:
            continue
        text_line = LINES[n]
        assert text_line.strip() and not re.match(r'^\s+\d+\.\s*$', text_line), n
        assert n + 2 > len(LINES) or not LINES[n+1].strip() or re.match(r'^\s+\d+\.\s*$', LINES[n+1]), n
        items.append({'id': f'{DOC}.ref.{int(m[1]):03}', 'number': int(m[1]), 'text': text_line.strip(),
                      'span': span(OFFSETS[n-1], OFFSETS[n] + len(text_line.rstrip('\n')))})
    assert [r['number'] for r in items] == list(range(1, len(items) + 1))
    return section, items


REF_SECTION, REFERENCES = parse_references()
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
STRUCTURE_SPANS = []


def own(s, category, record_ids):
    OWNERSHIP.append({'span': s, 'collection': category, 'record_ids': record_ids})
    if category == 'structure':
        STRUCTURE_SPANS.append(s)


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
        if section['start_line'] in PLAN['context_exclude_sections']:
            continue
        override = PLAN['context_override_sections'].get(str(section['start_line']))
        if override:
            result.append(line_span(*override[0]))
        elif section['collection'] == 'clinical' and meaningful(section['own_span']):
            result.append(section['own_span'])
    return list(reversed(result))


def default_kind(section, index, raw):
    if section['collection'] == 'methods':
        return 'method_component'
    if EVIDENCE.search(raw):
        return 'recommendation'
    return 'section_introduction' if index == 0 and len(PLAN['units'][str(section['start_line'])]) > 1 else 'semantic_block'


for section in SECTIONS:
    a, b = section['start_line'], section['own_end_line_exclusive']
    category = section['collection']
    if category == 'references':
        own(section['own_span'], 'references', ['references.source_section'])
        continue
    if category == 'supporting':
        if not meaningful(section['own_span']):
            own(section['own_span'], 'structure', [section['id']])
            continue
        rec = source_record(f'{DOC}.support.{a}', section['title'], section['own_span'], section)
        rec['index_in_clinical_search'] = False
        SUPPORTING.append(rec)
        own(section['own_span'], 'supporting', [rec['id']])
        continue
    if not meaningful(section['own_span']):
        own(section['own_span'], 'structure', [section['id']])
        continue
    parent_id = f'{DOC}.parent.{a}'
    full_span = section['own_span']
    parent = source_record(parent_id, section['title'], full_span, section)
    parent['index_in_vector_search'] = False
    parent['section_subtree_span'] = section['span']
    parent['child_ids'] = []
    parent['ancestor_context_spans'] = context_spans(section)
    method = PLAN['methods'].get(str(a))
    if category == 'methods':
        parent['id'] = parent_id = f'{DOC}.method.{method["key"]}'
        parent['original_appendix_label'] = method['label']
        parent['required_context_spans'] = [line_span(*r) for r in method['context']]
        METHOD_PARENTS.append(parent)
    elif category == 'appendices':
        parent['original_appendix_label'] = section.get('label')
        APPENDICES.append(parent)
    else:
        PARENTS.append(parent)
    starts = PLAN['units'][str(a)]
    assert starts == sorted(set(starts)) and starts[0] >= a and starts[-1] < b, a
    if starts[0] > a:
        own(line_span(a, starts[0]), 'structure', [section['id']])
    group = []
    for i, start in enumerate(starts):
        end = starts[i+1] if i+1 < len(starts) else b
        s = line_span(start, end)
        chunk_id = f'{DOC}.chunk.{start:04}'
        raw = slice_text(s)
        rec = source_record(chunk_id, PLAN['unit_titles'].get(str(start)) or short_title(LINES[start-1]), s, section)
        rec['kind'] = PLAN['unit_kinds'].get(str(start)) or default_kind(section, i, raw)
        rec['collection'] = category
        rec['index_in_vector_search'] = True
        rec['parent_id'] = parent_id
        single = len(starts) == 1
        requires = [f'{DOC}.chunk.{n:04}' for n in PLAN['requires'].get(str(start), [])]
        standalone = single and category == 'clinical' and not context_spans(section) and not requires
        if standalone:
            mode, reason = 'self', 'Единый смысловой блок с полными условиями; достаточно пути заголовков и паспорта документа.'
        elif len(slice_text(full_span).strip()) <= PAGE:
            mode, reason = 'parent', 'Условия и пояснения объединяют пункты; полный смысловой родитель не превышает условную страницу.'
        else:
            mode, reason = 'window', 'Полный родитель больше условной страницы; вернуть чанк и ближайших соседей того же родителя с общими условиями.'
        always = context_spans(section)
        if category == 'methods':
            always = always + parent['required_context_spans'] + [line_span(*r) for r in method['extra'].get(str(start), [])]
        rec['retrieval'] = {'mode': mode, 'reason': reason,
                            'context_parent_id': parent_id if mode != 'self' else None,
                            'previous_chunk_id': None, 'next_chunk_id': None,
                            'required_chunk_ids': requires, 'always_include_spans': always,
                            'neighbor_limit_each_side': 1 if mode == 'window' else 0,
                            'atomic_oversize': len(rec['source_text'].strip()) > PAGE}
        parent['child_ids'].append(chunk_id)
        group.append(rec)
        own(s, category, [chunk_id])
    for i, chunk in enumerate(group):
        chunk['retrieval']['previous_chunk_id'] = group[i-1]['id'] if i else None
        chunk['retrieval']['next_chunk_id'] = group[i+1]['id'] if i+1 < len(group) else None
        if chunk['retrieval']['required_chunk_ids'] and chunk['retrieval']['mode'] == 'self':
            chunk['retrieval'].update(mode='parent', context_parent_id=chunk['parent_id'],
                                      reason='К собственному полному блоку нужно приложить явно связанные общие условия или комментарий.')
        if chunk['kind'] == 'recommendation_comment':
            chunk['retrieval']['reason'] += ' Комментарий отделён от рекомендации из-за объёма; сама рекомендация обязательна по явной связи.'
        if chunk['retrieval']['atomic_oversize']:
            chunk['retrieval']['reason'] += ' Превышение размера сохранено намеренно: нельзя отрывать варианты рекомендации, таблицу или пункты инструмента.'
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


def table_chunk_ids(number):
    return [c['id'] for c in ALL_CHUNKS if re.match(rf'Таблица {number}\.', c['title'])]


def appendix_links(s):
    raw = slice_text(s)
    result = []
    pattern = r'[Пп]риложени[еяиюях]+\s+([АБВГ]\s*\.?\s*\d*(?:\s*,\s*[АБВГ]\s*\d+)*)'
    for m in re.finditer(pattern, raw):
        for label_match in re.finditer(r'[АБВГ]\s*\.?\s*\d*', m[1]):
            label = re.sub(r'[\s.]', '', label_match[0])
            candidates = [t['id'] for t in TARGETS if t['original_appendix_label'] == label]
            if label == 'Б':
                candidates = [t['id'] for t in APPENDICES if (t.get('original_appendix_label') or '').startswith('Б')]
            # Names right before a reference help surface source-label conflicts; never relabel it.
            nearby = raw[max(0, m.start()-120):m.end()]
            named = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items() if re.search(pat, nearby, re.I)]
            status = 'resolved_group' if label == 'Б' else 'resolved' if len(candidates) == 1 else 'ambiguous' if candidates else 'missing'
            if named and candidates and not set(named).intersection(candidates):
                status = 'label_name_conflict'
            elif len(candidates) > 1 and len(set(named).intersection(candidates)) == 1:
                status = 'resolved_by_name'
            resolved = list(set(named).intersection(candidates)) if status == 'resolved_by_name' else candidates if status in ('resolved', 'resolved_group') else []
            table = re.match(r'\s*,\s*табл\.?\s*(\d+)', raw[m.end():m.end()+20])
            result.append({'raw': m[0], 'label': label, 'status': status,
                           'declared_target_ids': candidates, 'named_method_candidate_ids': named,
                           'resolved_target_ids': sorted(resolved), 'review_note': None,
                           'table_number': int(table[1]) if table else None,
                           'resolved_table_chunk_ids': table_chunk_ids(int(table[1])) if table else [],
                           'span': span(s['start']+m.start(), s['start']+m.end())})
    return result


# F-code cross references between classification chunks.
classification = [c for c in CHUNKS if c['kind'] in ('classification', 'classification_table')]
BASE_CLASSIFICATION = classification[0]['id']
code_targets = {}
for chunk in classification:
    for line in chunk['source_text'].splitlines():
        m = re.match(r'\**(F\s*\d+(?:\.\d+)?)', line)
        if m:
            code_targets.setdefault(re.sub(r'\s+', '', m[1]), chunk['id'])
for rec in ALL_RECORDS:
    rec['metadata']['appendix_links'] = appendix_links(rec['span'])
    rec['metadata']['named_method_ids'] = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items()
                                          if re.search(pat, rec['source_text'], re.I)]
    if rec in ALL_CHUNKS:
        codes = set(re.sub(r'\s+', '', m[0]) for m in re.finditer(r'F\s*\d{2}(?:\.\d+)?', rec['source_text']))
        rec['metadata']['related_classification_chunk_ids'] = sorted({code_targets[c] for c in codes if c in code_targets} - {rec['id']})
        if rec in classification and rec['id'] != BASE_CLASSIFICATION:
            rec['retrieval']['required_chunk_ids'] += rec['metadata']['related_classification_chunk_ids'] + [BASE_CLASSIFICATION]
            rec['retrieval']['required_chunk_ids'] = [x for x in dict.fromkeys(rec['retrieval']['required_chunk_ids']) if x != rec['id']]


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
        for s in c['retrieval']['always_include_spans']:
            assert slice_text(s).strip()
    # Every character is assigned once outside deliberately duplicated parent context.
    coverage = sorted(OWNERSHIP, key=lambda r: r['span']['start'])
    assert coverage[0]['span']['start'] == 0
    assert coverage[-1]['span']['end'] == len(TEXT)
    for a, b in zip(coverage, coverage[1:]):
        assert a['span']['end'] == b['span']['start'], (a, b)
    # Navigation-only spans hold headings and blank lines, never content.
    for s in STRUCTURE_SPANS:
        assert not meaningful(s), s
    # No chunk boundary inside a physical Markdown table, including malformed tables.
    for c in ALL_CHUNKS:
        line = c['span']['start_line']
        previous = LINES[line-2] if line > 1 else ''
        assert not (previous.startswith('|') and LINES[line-1].startswith('|'))
    # A recommendation is never lost or split from its evidence statement.
    for n, line in enumerate(LINES, 1):
        if REC_BULLET.match(line) and any(c['span']['start_line'] <= n <= c['span']['end_line'] for c in CHUNKS):
            owners = [c for c in ALL_CHUNKS if c['span']['start'] <= OFFSETS[n-1] < c['span']['end']]
            assert len(owners) == 1, n
            assert owners[0]['metadata']['evidence_statements'], n
    # Every evidence statement of the source is carried by exactly one chunk.
    assert sum(len(c['metadata']['evidence_statements']) for c in ALL_CHUNKS) == len(EVIDENCE.findall(TEXT))
    assert len(METHOD_PARENTS) == len(PLAN['methods']) and len(REFERENCES) == 45
    return coverage


def table_issues():
    """Rows whose cell count differs from the header row of their physical table."""
    issues = []
    n = 0
    while n < len(LINES):
        if LINES[n].startswith('|'):
            start = n
            while n < len(LINES) and LINES[n].startswith('|'):
                n += 1
            cells = [len(re.split(r'(?<!\\)\|', l.strip())) - 2 for l in LINES[start:n]]
            for k, c in enumerate(cells):
                if c != cells[0] and k != 1:
                    issues.append({'line': start + k + 1, 'cells': c, 'header_cells': cells[0]})
        else:
            n += 1
    return issues


def evidence_issues():
    latin, cyrillic, plain, no_udd = [], [], [], []
    for m in EVIDENCE.finditer(TEXT):
        line = bisect.bisect_right(OFFSETS, m.start())
        letter = re.search(r'рекомендаций\s*[–-]\s*\**\s*([A-Za-zА-Яа-я])', m[0])
        if letter:
            (latin if letter[1] in 'ABCabc' else cyrillic if letter[1] in 'АВСавс' else []).append(line)
        if not m[0].lstrip().startswith('**'):
            plain.append(line)
        if 'достоверности доказательств' not in m[0]:
            no_udd.append(line)
    return {'uur_letter_latin_lines': len(latin), 'uur_letter_cyrillic_lines': len(cyrillic),
            'cyrillic_letter_line_numbers': cyrillic, 'not_bold_or_indented_lines': plain,
            'without_udd_part_lines': no_udd}


COVERAGE = validate()
MISSING = sorted({n for c in ALL_CHUNKS for n in c['metadata']['unresolved_citation_numbers']})
ISSUES = [dict(chunk_id=c['id'], **r) for c in ALL_CHUNKS for r in c['metadata']['appendix_links']
          if r['status'] in ('ambiguous', 'missing', 'label_name_conflict', 'table_scope_unverified')]
NO_OWN_EVIDENCE = [c['id'] for c in CHUNKS if c['kind'] == 'recommendation' and
                   sum(1 for l in c['source_text'].splitlines() if REC_BULLET.match(l)) > len(c['metadata']['evidence_statements'])]
titles = Counter(s['title'] for s in SECTIONS)
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
downloaded = re.search(r'\*\*Дата скачивания:\*\* (\d+)\.(\d+)\.(\d+)', TEXT)
MANIFEST = {
    'schema_version': '1.0', 'document_id': DOC,
    'title': 'Депрессивный эпизод. Рекуррентное депрессивное расстройство', 'clinical_year': 2024,
    'guideline_id': re.search(r'^ID:(\d+)', TEXT, re.M)[1], 'population': 'Взрослые', 'language': 'ru',
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
        'reference_list': {'provided_items': len(REFERENCES),
                           'note': 'Пункт 1 вложен в обёртки «1. Клинические рекомендации…» и «1. 1.»; номера 46 и выше в предоставленном файле отсутствуют.'},
        'appendix_link_issues': ISSUES,
        'duplicate_section_titles': sorted(t for t, n in titles.items() if n > 1),
        'evidence_formatting': evidence_issues(),
        'recommendations_without_own_evidence_line': NO_OWN_EVIDENCE,
        'malformed_table_rows': table_issues(),
        'inconsistent_labels': {
            'dr_instead_of_de_in_titles': [n for n, l in enumerate(LINES, 1) if re.search(r'\bДР или РДР', l) and l.startswith('**')],
            'appendix_b_headings_without_word_appendix': [s['start_line'] for s in SECTIONS if s.get('label', '').startswith('Б') and len(s.get('label')) > 1 and not s['title'].startswith('Приложение')]},
        'file_without_final_newline': not TEXT.endswith('\n'),
        'external_images_not_ocr_processed': True},
    'validation': {'source_hash': 'passed', 'exact_character_coverage': 'passed',
                   'span_round_trip': 'passed', 'relationships': 'passed',
                   'recommendation_ownership': 'passed', 'tables_intact': 'passed'},
}
FILES['manifest.json'] = MANIFEST


def review():
    lines = ['# Решения по чанкам: депрессия, 2024', '',
             'Каждая строка — поисковый чанк; полный контекст хранится по `parent_id`. '
             'Решение и его причина также записаны в JSON. Номера строк относятся к исходному Markdown.', '',
             '| Чанк / строки | Тип выдачи | Символов | Содержание |', '| --- | --- | ---: | --- |']
    for c in sorted(ALL_CHUNKS, key=lambda c: c['span']['start']):
        s = c['span']
        lines.append(f'| {c["id"]} / {s["start_line"]}–{s["end_line"]} | {c["retrieval"]["mode"]} | '
                     f'{len(c["source_text"].strip())}{" *" if c["retrieval"]["atomic_oversize"] else ""} | '
                     f'{c["title"].replace("|", "/")} |')
    lines += ['', '`*` — атомарный блок больше 3500 символов: таблица или опросник сохранены целиком.', '',
              '## Неразрешённые ссылки на литературу', '',
              f'В предоставленном списке литературы {len(REFERENCES)} позиций; используемых, но отсутствующих номеров — {len(MISSING)}. '
              'Полный список — `references.json:unresolved_citation_numbers`.', '',
              '## Проблемы источника (не исправлены)', '']
    si = MANIFEST['source_issues']
    ev = si['evidence_formatting']
    lines.append(f'- Ссылки на приложения с конфликтом или пропуском: {len(ISSUES)}.')
    lines.append(f'- УУР с латинской буквой: {ev["uur_letter_latin_lines"]}, с кириллической: {ev["uur_letter_cyrillic_lines"]} '
                 f'(строки: {", ".join(map(str, ev["cyrillic_letter_line_numbers"]))}). Написание сохранено как в источнике.')
    lines.append(f'- Строки УДД/УУР без выделения жирным или с отступом: {", ".join(map(str, ev["not_bold_or_indented_lines"])) or "нет"}.')
    lines.append(f'- Строки УДД/УУР без части «уровень достоверности»: {", ".join(map(str, ev["without_udd_part_lines"])) or "нет"}.')
    lines.append(f'- Чанки, где пунктов с «рекомендуется/рекомендовано» больше, чем строк УУР: {", ".join(NO_OWN_EVIDENCE) or "нет"}.')
    lines.append(f'- Строки таблиц с числом ячеек, отличным от заголовка: {json.dumps(si["malformed_table_rows"], ensure_ascii=False)}.')
    lines.append(f'- Повторяющиеся заголовки: {", ".join(si["duplicate_section_titles"]) or "нет"}.')
    lines.append(f'- «ДР» вместо «ДЭ» в заголовках, строки: {", ".join(map(str, si["inconsistent_labels"]["dr_instead_of_de_in_titles"])) or "нет"}.')
    lines.append(f'- Заголовки Б1–Б4 без слова «Приложение» (Б5 с ним), строки: {", ".join(map(str, si["inconsistent_labels"]["appendix_b_headings_without_word_appendix"])) or "нет"}.')
    lines.append(f'- Файл без завершающего перевода строки: {"да" if si["file_without_final_newline"] else "нет"}.')
    for issue in ISSUES:
        lines.append(f'- {issue["chunk_id"]}, строка {issue["span"]["start_line"]}: '
                     f'`{issue["raw"]}` → {issue["label"]}, **{issue["status"]}**.')
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
