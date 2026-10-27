#!/usr/bin/env python3
"""Build the reviewed local BAR dataset. No network, dependencies or application DB."""

import argparse
import bisect
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/clinrecs/rag/01_bipolar'
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
CITATION = re.compile(r'\[(\s*\d+(?:[\s\u00ad]*[-–—,;][\s\u00ad]*\d+)*(?:\s+и др\.)?\s*)\]')
RECOMMENDATION = re.compile(r'^\s*-\s*\**\s*(?:[Нн]е\s+)?[Рр]екомендуется')
IMAGE = re.compile(r'!\[[^\]]*\]\(([^)]+)\)')
EVIDENCE = re.compile(r'^(?:\*\*)?Уровень[^\n]+', re.M)
METHODS = {
    1934: ('cssrs', 'Г1', [1934, 1952, 1965, 1982, 1993, 2000], [1934, 1952]),
    2002: ('hcl32', 'Г2', [2002, 2026, 2040], [2002, 2026]),
    2082: ('ymrs', 'Г3', [2082, 2102, 2118], [2082, 2102]),
    2254: ('hamd17', 'Г3', [2254, 2278], [2254, 2278]),
    2325: ('madrs', 'Г4', [2325, 2345], [2325, 2345]),
    2372: ('hcl33', 'Г5', [2372, 2400], [2372, 2400]),
}
NAME_PATTERNS = {
    'cssrs': r'Колумбийск|[СC]-?SSRS', 'hcl32': r'HCL[ -]32',
    'ymrs': r'Янга|YMRS', 'hamd17': r'Гамильтон|HAM[ -]D',
    'madrs': r'Монтгомери|MADRS', 'hcl33': r'HCL[ -]33',
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


def collection_for(line):
    if line >= 1934:
        return 'methods'
    if 1315 <= line < 1389:
        return 'references'
    if line < 38 or 1391 <= line < 1487:
        return 'supporting'
    if 1683 <= line < 1934:
        return 'appendices'
    return 'clinical'


REFERENCES = []
for number in range(1, 71):
    # The supplied bibliography nests its actual item 1 inside two wrapper items.
    pattern = rf'^\s{{6}}{number}\. ' if number > 1 else r'^\s{3}1\. Клинические рекомендации Российского общества психиатров - 1\. '
    matches = list(re.finditer(pattern + r'[^\n]+', TEXT, re.M))
    assert len(matches) == 1, (number, matches)
    m = matches[0]
    body_start = m.end() - len(m[0]) + re.match(pattern, m[0]).end()
    REFERENCES.append({'id': f'{DOC}.ref.{number:03}', 'number': number,
                       'text': TEXT[body_start:m.end()], 'span': span(m.start(), m.end())})
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
    result = []
    while section['parent']:
        section = BY_ID[section['parent']]
        if section['level'] == 1:
            continue  # Source passport is attached from manifest, never the whole document.
        if collection_for(section['start_line']) == 'clinical' and meaningful(section['own_span']):
            result.append(section['own_span'])
    return list(reversed(result))


def units_for(section):
    a, b = section['start_line'], section['own_end_line_exclusive']
    if a in METHODS:
        return METHODS[a][2], 'method_component'
    if a == 66:
        return PLAN['classification_unit_lines'], 'classification'
    if str(a) in PLAN['narrative_unit_lines']:
        return PLAN['narrative_unit_lines'][str(a)], 'narrative_topic'
    starts = [n for n in range(a, b) if RECOMMENDATION.match(LINES[n-1])]
    if starts:
        if a == 1195:
            starts += PLAN['shared_comment']['unit_lines']
            starts.sort()
        prefix = line_span(a, starts[0]) if starts[0] > a else None
        # Include a substantive intro (e.g. differential diagnosis) in a separate chunk.
        return ([a] if prefix and meaningful(prefix) else []) + starts, 'recommendation'
    return [a], 'semantic_block'


for section in SECTIONS:
    a, b = section['start_line'], section['own_end_line_exclusive']
    category = collection_for(a)
    if category == 'references':
        own(section['own_span'], 'references', ['references.source_section'])
        continue
    if category == 'supporting':
        rec = source_record(f'{DOC}.support.{a}', section['title'], section['own_span'], section)
        rec['index_in_clinical_search'] = False
        SUPPORTING.append(rec)
        own(section['own_span'], 'supporting', [rec['id']])
        continue
    if not meaningful(section['own_span']) and a not in METHODS:
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
    if category == 'methods':
        key, label, _, anchors = METHODS[a]
        parent['id'] = parent_id = f'{DOC}.method.{key}'
        parent['original_appendix_label'] = label
        parent['index_in_vector_search'] = False
        parent['required_context_spans'] = [line_span(anchors[0], anchors[1])]
        if key == 'cssrs':
            parent['required_context_spans'].append(line_span(2000, 2002))
        elif key == 'hcl32':
            parent['required_context_spans'].append(line_span(2026, 2040))
        elif key == 'ymrs':
            parent['required_context_spans'].append(line_span(2102, 2118))
        elif key in ('hamd17', 'madrs'):
            parent['required_context_spans'].append(line_span(anchors[1], b))
        METHOD_PARENTS.append(parent)
    elif category == 'appendices':
        parent['original_appendix_label'] = re.sub(r'\s+', '', re.search(r'Приложение ([АБВ]\s*\d*)', section['title'])[1]) if section['title'].startswith('Приложение') else None
        APPENDICES.append(parent)
    else:
        PARENTS.append(parent)
    starts, kind = units_for(section)
    assert starts == sorted(set(starts))
    if starts[0] > a:
        own(line_span(a, starts[0]), 'structure', [section['id']])
    group = []
    for i, start in enumerate(starts):
        end = starts[i+1] if i+1 < len(starts) else b
        s = line_span(start, end)
        chunk_id = f'{DOC}.chunk.{start:04}'
        rec = source_record(chunk_id, short_title(LINES[start-1]), s, section)
        rec['kind'] = kind if kind != 'recommendation' or RECOMMENDATION.match(LINES[start-1]) else 'section_introduction'
        if start in PLAN['shared_comment']['unit_lines']:
            rec['kind'] = 'shared_comment' if start == 1221 else 'table_with_comment'
            rec['title'] = 'Психообразование: общий комментарий' if start == 1221 else 'Таблица 1. Информация для психообразовательных семинаров'
        rec['collection'] = category
        rec['index_in_vector_search'] = True
        rec['parent_id'] = parent_id
        # A paragraph with its own complete purpose can stand alone with title/provenance.
        single = len(starts) == 1
        standalone = single and category == 'clinical' and a not in PLAN['contextual_first_recommendation_lines'] and not context_spans(section)
        if standalone:
            mode, reason = 'self', 'Единый смысловой блок с полными условиями; достаточно пути заголовков и паспорта документа.'
        elif len(slice_text(full_span).strip()) <= PAGE:
            mode, reason = 'parent', 'Условия и пояснения объединяют пункты; полный смысловой родитель не превышает условную страницу.'
        else:
            mode, reason = 'window', 'Полный родитель больше условной страницы; вернуть чанк и ближайших соседей того же родителя с общими условиями.'
        rec['retrieval'] = {'mode': mode, 'reason': reason,
                            'context_parent_id': parent_id if mode != 'self' else None,
                            'previous_chunk_id': None, 'next_chunk_id': None,
                            'required_chunk_ids': [], 'always_include_spans': context_spans(section),
                            'neighbor_limit_each_side': 1 if mode == 'window' else 0,
                            'atomic_oversize': len(rec['source_text'].strip()) > PAGE}
        if category == 'methods':
            rec['retrieval']['always_include_spans'] += parent['required_context_spans']
            if a == 1934 and start in (1965, 1982, 1993):
                rec['retrieval']['always_include_spans'].append(line_span(1952, 1965))
        parent['child_ids'].append(chunk_id)
        group.append(rec)
        own(s, category, [chunk_id])
    for i, chunk in enumerate(group):
        chunk['retrieval']['previous_chunk_id'] = group[i-1]['id'] if i else None
        chunk['retrieval']['next_chunk_id'] = group[i+1]['id'] if i+1 < len(group) else None
        if a in PLAN['shared_context_first_recommendation_sections'] and i:
            chunk['retrieval']['required_chunk_ids'] = [group[0]['id']]
        if chunk['retrieval']['atomic_oversize']:
            chunk['retrieval']['reason'] += ' Превышение размера сохранено намеренно: нельзя отрывать варианты рекомендации, общий комментарий, таблицу или пункты инструмента.'
    if category == 'methods':
        METHOD_CHUNKS.extend(group)
    elif category == 'appendices':
        parent['chunks'] = group
    else:
        CHUNKS.extend(group)


# Explicit nonlocal dependencies, not neighboring-text guesses.
for chunk in CHUNKS:
    line = chunk['span']['start_line']
    if line in (290,):
        # F31.8 and F31.9 are two labels without criteria; one chunk intentionally.
        chunk['title'] = 'F31.8 и F31.9: другие и неуточнённые биполярные расстройства'
    if line == 1307:
        chunk['retrieval']['required_chunk_ids'] += [c['id'] for c in CHUNKS if c['span']['start_line'] == 1115]
        chunk['retrieval']['mode'] = 'parent'
        chunk['retrieval']['context_parent_id'] = chunk['parent_id']
        chunk['retrieval']['reason'] = 'Краткий раздел прямо отсылает к противорецидивной терапии; приложить соответствующий общий блок.'
    if line in PLAN['shared_comment']['recommendation_lines']:
        chunk['retrieval']['required_chunk_ids'] += [f'{DOC}.chunk.{n:04}' for n in PLAN['shared_comment']['unit_lines']]
    for rule in PLAN['mandatory_general_context']:
        if rule['from_line'] <= line < rule['to_line_exclusive']:
            chunk['retrieval']['required_chunk_ids'] += [f'{DOC}.chunk.{n:04}' for n in rule['required_chunk_lines']]
    chunk['retrieval']['required_chunk_ids'] = list(dict.fromkeys(chunk['retrieval']['required_chunk_ids']))
    if chunk['retrieval']['required_chunk_ids'] and chunk['retrieval']['mode'] == 'self':
        chunk['retrieval'].update(mode='parent', context_parent_id=chunk['parent_id'],
                                  reason='К собственному полному блоку нужно приложить явно связанные общие условия или комментарий.')


ALL_CHUNKS = CHUNKS + METHOD_CHUNKS + [c for p in APPENDICES for c in p['chunks']]
ALL_RECORDS = ALL_CHUNKS + PARENTS + METHOD_PARENTS + APPENDICES + SUPPORTING
TARGETS = METHOD_PARENTS + APPENDICES


def appendix_links(s):
    raw = slice_text(s)
    result = []
    # Include shorthand continuation labels, e.g. «Приложение Г2, Г5, Г6».
    pattern = r'[Пп]риложени[еяиюях]+\s+([АБВГ]\s*\.?\s*\d*(?:\s*,\s*[АБВГ]\s*\d+)*)'
    for m in re.finditer(pattern, raw):
        for label_match in re.finditer(r'[АБВГ]\s*\.?\s*\d*', m[1]):
            label = re.sub(r'[\s.]', '', label_match[0])
            candidates = [t['id'] for t in TARGETS if t['original_appendix_label'] == label]
            if label == 'Б':
                candidates = [t['id'] for t in APPENDICES if (t.get('original_appendix_label') or '').startswith('Б')]
            # Names near a reference help surface source-label conflicts; never relabel it.
            nearby = raw[max(0, m.start()-170):m.end()+20]
            named = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items() if re.search(pat, nearby, re.I)]
            status = 'resolved_group' if label == 'Б' else 'resolved' if len(candidates) == 1 else 'ambiguous' if candidates else 'missing'
            if named and candidates and not set(named).intersection(candidates):
                status = 'label_name_conflict'
            elif len(candidates) > 1 and len(set(named).intersection(candidates)) == 1:
                status = 'resolved_by_name'
            if label == 'Г2' and s['start']+m.start() in range(OFFSETS[1132], OFFSETS[1133]):
                status = 'table_scope_unverified'
            if label == 'Г4' and s['start']+m.start() in range(OFFSETS[1182], OFFSETS[1183]):
                status = 'label_name_conflict'
            resolved = list(set(named).intersection(candidates)) if status == 'resolved_by_name' else candidates if status in ('resolved', 'resolved_group') else []
            result.append({'raw': m[0], 'label': label, 'status': status,
                           'declared_target_ids': candidates, 'named_method_candidate_ids': named,
                           'resolved_target_ids': sorted(resolved),
                           'review_note': 'В тексте названа карта самостоятельной регистрации колебаний настроения; под Г4 находится MADRS.' if label == 'Г4' and status == 'label_name_conflict' else 'Таблица 1 упомянута при Г2 (HCL-32); соответствие таблицы приложению не установлено.' if status == 'table_scope_unverified' else None,
                           'span': span(s['start']+m.start(), s['start']+m.end())})
    return result


classification = [c for c in CHUNKS if c['kind'] == 'classification']
code_targets = {}
for chunk in classification:
    for line in chunk['source_text'].splitlines():
        if line.startswith('**F'):
            m = re.match(r'\*\*(F\s*\d+(?:\.\d+)?)', line)
            if m:
                code_targets[re.sub(r'\s+', '', m[1])] = chunk['id']
for rec in ALL_RECORDS:
    rec['metadata']['appendix_links'] = appendix_links(rec['span'])
    rec['metadata']['named_method_ids'] = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items()
                                          if re.search(pat, rec['source_text'], re.I)]
    if rec in ALL_CHUNKS:
        codes = set(re.sub(r'\s+', '', m[0]) for m in re.finditer(r'F\s*\d{2}(?:\.\d+)?', rec['source_text']))
        rec['metadata']['related_classification_chunk_ids'] = sorted({code_targets[c] for c in codes if c in code_targets} - {rec['id']})
        if rec['kind'] == 'classification':
            rec['retrieval']['required_chunk_ids'] += rec['metadata']['related_classification_chunk_ids']
            if rec['span']['start_line'] != 66:
                rec['retrieval']['required_chunk_ids'].append(f'{DOC}.chunk.0066')
            rec['retrieval']['required_chunk_ids'] = list(dict.fromkeys(rec['retrieval']['required_chunk_ids']))


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
    # An explicit recommendation is never lost or split before its evidence/comment.
    for n, line in enumerate(LINES, 1):
        if RECOMMENDATION.match(line):
            owners = [c for c in ALL_CHUNKS if c['span']['start'] <= OFFSETS[n-1] < c['span']['end']]
            assert len(owners) == 1, n
            if owners[0]['kind'] == 'recommendation':
                assert owners[0]['metadata']['evidence_statements'], n
    # User's example applied to BAR: each anamnesis recommendation -> whole subsection.
    anamnesis = [c for c in CHUNKS if c['section_id'] == 'cr01.06.02']
    assert len(anamnesis) > 1 and all(c['retrieval']['mode'] == 'parent' for c in anamnesis)
    assert len(METHOD_PARENTS) == 6 and len(REFERENCES) == 70
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
                        'source_span': BY_ID['cr01.11.01']['span'],
                        'source_text': slice_text(BY_ID['cr01.11.01']['span']),
                        'items': REFERENCES, 'unresolved_citation_numbers': MISSING,
                        'completeness': 'provided_bibliography_only_numbers_1_to_70'},
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
    'title': 'Биполярное аффективное расстройство', 'clinical_year': 2025,
    'guideline_id': '675_2', 'population': 'Взрослые', 'language': 'ru',
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
    'source_issues': {'missing_reference_numbers': MISSING, 'appendix_link_issues': ISSUES,
                      'duplicate_appendix_label': 'Г3: YMRS and HAM-D-17',
                      'external_images_not_ocr_processed': True},
    'validation': {'source_hash': 'passed', 'exact_character_coverage': 'passed',
                   'span_round_trip': 'passed', 'relationships': 'passed',
                   'recommendation_ownership': 'passed', 'tables_intact': 'passed'},
}
FILES['manifest.json'] = MANIFEST


def review():
    lines = ['# Решения по чанкам БАР, 2025', '',
             'Каждая строка — поисковый чанк; полный контекст хранится по `parent_id`. '
             'Решение и его причина также записаны в JSON. Номера строк относятся к исходному Markdown без старых меток.', '',
             '| Чанк / строки | Тип выдачи | Символов | Содержание |', '| --- | --- | ---: | --- |']
    for c in sorted(ALL_CHUNKS, key=lambda c: c['span']['start']):
        s = c['span']
        lines.append(f'| {c["id"]} / {s["start_line"]}–{s["end_line"]} | {c["retrieval"]["mode"]} | '
                     f'{len(c["source_text"].strip())}{" *" if c["retrieval"]["atomic_oversize"] else ""} | '
                     f'{c["title"].replace("|", "/")} |')
    lines += ['', '`*` — атомарный блок больше 3500 символов: список вариантов, таблица, '
              'опросник или общий комментарий сохранены целиком.', '',
              '## Неразрешённые ссылки', '',
              f'В предоставленном списке литературы отсутствуют {len(MISSING)} используемых номеров. '
              'Полный список — `references.json:unresolved_citation_numbers`.', '']
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
