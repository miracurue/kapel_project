#!/usr/bin/env python3
"""Build the reviewed local dataset for clinical recommendation 09 (alcohol-induced amnestic
syndrome, F10.6). No network, dependencies or application DB. Same schema as the BAR dataset."""

import argparse
import bisect
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/clinrecs/rag/09_substance'
PLAN = json.loads((OUT / 'annotation_plan.json').read_text())
SOURCE = ROOT / PLAN['source']
RAW = SOURCE.read_bytes()
assert hashlib.sha256(RAW).hexdigest() == PLAN['source_sha256'], 'Source changed: review spans first'
TEXT = RAW.decode('utf-8')
# Only "\n" ends a line (str.splitlines would also split on U+0085 and similar).
LINES = re.findall(r'[^\n]*\n|[^\n]+', TEXT)
OFFSETS = [0]
for line in LINES:
    OFFSETS.append(OFFSETS[-1] + len(line))
PAGE = PLAN['page_proxy_chars']
DOC = PLAN['document_id']
SECTIONS = PLAN['sections']
BY_ID = {s['id']: s for s in SECTIONS}
CITATION = re.compile(r'\[(\s*\d+(?:[\s­]*[-–—,;][\s­]*\d+)*(?:\s+и др\.)?\s*)\]')
RECOMMENDATION = re.compile(r'^\s*-\s*\**\s*(?:[Нн]е\s+)?[Рр]екомендуется')
IMAGE = re.compile(r'!\[[^\]]*\]\(([^)]+)\)')
EVIDENCE = re.compile(r'^(?:\*\*)?Уровень[^\n]+', re.M)
METHODS = {int(k): v for k, v in PLAN['methods'].items()}
NAME_PATTERNS = PLAN['name_patterns']


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
    for r in PLAN['collection_ranges']:
        if r['from_line'] <= line < r['to_line_exclusive']:
            return r['collection']
    raise AssertionError(line)


# Bibliography: the source nests the list in a wrapper item; item 1 is written "1. 1.".
REF_SECTION = next(s for s in SECTIONS if collection_for(s['start_line']) == 'references')
REFERENCES = []
for n in range(REF_SECTION['start_line'], REF_SECTION['own_end_line_exclusive']):
    m = re.match(r'^(\s+)(\d+)\. ', LINES[n-1])
    if not m:
        continue
    number = int(m[2])
    assert number == len(REFERENCES) + 1, (n, number)
    body_start = OFFSETS[n-1] + m.end()
    if number == 1:
        extra = re.match(r'1\. ', TEXT[body_start:])
        assert extra and len(m[1]) == 3
        body_start += extra.end()
    end = OFFSETS[n-1] + len(LINES[n-1].rstrip('\n'))
    REFERENCES.append({'id': f'{DOC}.ref.{number:03}', 'number': number,
                       'text': TEXT[body_start:end], 'span': span(OFFSETS[n-1], end)})
REF_BY_NUMBER = {r['number']: r['id'] for r in REFERENCES}


def answerability(raw):
    if not IMAGE.search(raw):
        return 'available_text_only'
    rest = IMAGE.sub('', raw)
    rest = re.sub(r'^\s*\*{2,3}[^\n]*\*{2,3}\s*$', '', rest, flags=re.M)
    return ('image_content_unavailable'
            if len(re.sub(r'\s+', '', rest)) <= PLAN['image_text_threshold_chars'] else 'available_text_only')


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
        'answerability': answerability(raw),
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


def split_entry(line):
    """Split «TERM – definition» at the first dash outside parentheses."""
    depth = 0
    for m in re.finditer(r'[()]|\s+[–—]+\s+', line):
        if m[0] == '(':
            depth += 1
        elif m[0] == ')':
            depth -= 1
        elif depth == 0:
            return line[:m.start()].strip(), line[m.end():].strip()
    raise AssertionError(line)


def glossary_entries(s):
    entries = []
    first = True
    for n in range(s['start_line'], s['own_end_line_exclusive']):
        text = LINES[n-1].rstrip('\n')
        if not text.strip():
            continue
        if first:  # bold section title
            first = False
            continue
        term, definition = split_entry(text)
        entries.append({'term': term, 'definition': definition, 'span': line_span(n, n + 1)})
    return entries


def units_for(section):
    a, b = section['start_line'], section['own_end_line_exclusive']
    if a in METHODS:
        return METHODS[a]['unit_lines'], 'method_component'
    override = PLAN['unit_overrides'].get(str(a))
    if override:
        return override['lines'], override['kind']
    starts = [n for n in range(a, b) if RECOMMENDATION.match(LINES[n-1])]
    if starts:
        starts = sorted(set(starts + PLAN['extra_unit_lines'].get(str(a), [])))
        prefix = line_span(a, starts[0]) if starts[0] > a else None
        # A substantive introduction is kept as a separate chunk.
        return ([a] if prefix and meaningful(prefix) else []) + starts, 'recommendation'
    return [a], 'semantic_block'


for section in SECTIONS:
    a, b = section['start_line'], section['own_end_line_exclusive']
    category = collection_for(a)
    if category == 'references':
        own(section['own_span'], 'references', ['references.source_section'])
        continue
    if not meaningful(section['own_span']) and a not in METHODS:
        own(section['own_span'], 'structure', [section['id']])
        continue
    if category == 'supporting':
        rec = source_record(f'{DOC}.support.{a}', section['title'], section['own_span'], section)
        rec['index_in_clinical_search'] = False
        if a in (455, 513):
            rec['entries'] = glossary_entries(section)
        SUPPORTING.append(rec)
        own(section['own_span'], 'supporting', [rec['id']])
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
        method = METHODS[a]
        parent['id'] = parent_id = f'{DOC}.method.{method["key"]}'
        parent['original_appendix_label'] = method['label']
        parent['required_context_spans'] = [line_span(*method['passport'])]
        if method.get('key_summary'):
            parent['required_context_spans'].append(line_span(*method['key_summary']))
        if method.get('table'):
            parent['required_context_spans'].append(line_span(*method['table']))
        METHOD_PARENTS.append(parent)
    elif category == 'appendices':
        label = re.match(r'Приложение\s+([АБВГ]\s*\d*(?:\.\d+)?)', section['title'])
        parent['original_appendix_label'] = re.sub(r'\s+', '', label[1]) if label else None
        APPENDICES.append(parent)
    else:
        PARENTS.append(parent)
    starts, kind = units_for(section)
    assert starts == sorted(set(starts)) and starts[0] >= a
    if starts[0] > a:
        own(line_span(a, starts[0]), 'structure', [section['id']])
    group = []
    for i, start in enumerate(starts):
        end = starts[i+1] if i+1 < len(starts) else b
        s = line_span(start, end)
        chunk_id = f'{DOC}.chunk.{start:04}'
        title = PLAN['chunk_titles'].get(str(start)) or short_title(LINES[start-1])
        rec = source_record(chunk_id, title, s, section)
        rec['kind'] = kind if kind != 'recommendation' or RECOMMENDATION.match(LINES[start-1]) else 'section_introduction'
        rec['kind'] = PLAN['kind_overrides'].get(str(start), rec['kind'])
        rec['collection'] = category
        rec['index_in_vector_search'] = True
        rec['parent_id'] = parent_id
        # A block with its own complete purpose can stand alone with title/provenance.
        single = len(starts) == 1 and s['start'] == full_span['start'] and s['end'] == full_span['end']
        standalone = single and category in ('clinical', 'appendices') and not context_spans(section)
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
            if start == METHODS[a]['unit_lines'][0]:
                rec['retrieval']['always_include_spans'] = []
        parent['child_ids'].append(chunk_id)
        group.append(rec)
        own(s, category, [chunk_id])
    for i, chunk in enumerate(group):
        chunk['retrieval']['previous_chunk_id'] = group[i-1]['id'] if i else None
        chunk['retrieval']['next_chunk_id'] = group[i+1]['id'] if i+1 < len(group) else None
        if chunk['retrieval']['atomic_oversize']:
            chunk['retrieval']['reason'] += ' Превышение размера сохранено намеренно: нельзя отрывать варианты рекомендации, её комментарий, список или таблицу.'
    if category == 'methods':
        METHOD_CHUNKS.extend(group)
    elif category == 'appendices':
        parent['chunks'] = group
    else:
        CHUNKS.extend(group)


ALL_CHUNKS = CHUNKS + METHOD_CHUNKS + [c for p in APPENDICES for c in p['chunks']]
CHUNK_BY_LINE = {c['span']['start_line']: c for c in ALL_CHUNKS}
ALL_RECORDS = ALL_CHUNKS + PARENTS + METHOD_PARENTS + APPENDICES + SUPPORTING
TARGETS = METHOD_PARENTS + APPENDICES

# Explicit nonlocal dependencies, not neighboring-text guesses.
for chunk in CHUNKS:
    line = chunk['span']['start_line']
    required = chunk['retrieval']['required_chunk_ids']
    for rule in PLAN['mandatory_general_context']:
        if rule['from_line'] <= line < rule['to_line_exclusive']:
            required += [f'{DOC}.chunk.{n:04}' for n in rule['required_chunk_lines']]
    link = PLAN['required_links'].get(str(line))
    if link:
        required += [f'{DOC}.chunk.{n:04}' for n in link['chunks']]
    chunk['retrieval']['required_chunk_ids'] = [x for x in dict.fromkeys(required) if x != chunk['id']]
    if chunk['retrieval']['required_chunk_ids'] and chunk['retrieval']['mode'] == 'self':
        chunk['retrieval'].update(mode='parent', context_parent_id=chunk['parent_id'],
                                  reason='К собственному полному блоку нужно приложить явно связанные общие условия или комментарий.')


def appendix_links(rec):
    s = rec['span']
    raw = slice_text(s)
    result = []
    # Shorthand continuation labels are included, e.g. «Приложение Г2, Г5».
    pattern = r'[Пп]риложени[еяиюях]+\s+([АБВГ]\s*\.?\s*\d*(?:\.\d+)?(?:\s*,\s*[АБВГ]\s*\d+)*)'
    for m in re.finditer(pattern, raw):
        line_start = raw.rfind('\n', 0, m.start()) + 1
        if raw.startswith('**Приложение', line_start):
            continue  # the appendix's own heading is not a cross-reference
        for label_match in re.finditer(r'[АБВГ]\s*\.?\s*\d*(?:\.\d+)?', m[1]):
            label = re.sub(r'[\s.]', '', label_match[0]) if '.' not in label_match[0].strip('. ') else re.sub(r'\s', '', label_match[0])
            candidates = [t['id'] for t in TARGETS if t['original_appendix_label'] == label]
            # Names near a reference help surface source-label conflicts; never relabel it.
            nearby = raw[max(0, m.start()-170):m.end()+20]
            named = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items() if re.search(pat, nearby, re.I)]
            status = 'resolved' if len(candidates) == 1 else 'ambiguous' if candidates else 'missing'
            if label.startswith('Г') and named and candidates and not set(named).intersection(candidates):
                status = 'label_name_conflict'
            elif len(candidates) > 1 and len(set(named).intersection(candidates)) == 1:
                status = 'resolved_by_name'
            resolved = list(set(named).intersection(candidates)) if status == 'resolved_by_name' else candidates if status == 'resolved' else []
            result.append({'raw': m[0], 'label': label, 'status': status,
                           'declared_target_ids': candidates, 'named_method_candidate_ids': named,
                           'resolved_target_ids': sorted(resolved), 'review_note': None,
                           'span': span(s['start']+m.start(), s['start']+m.end())})
    return result


for rec in ALL_RECORDS:
    rec['metadata']['appendix_links'] = appendix_links(rec)
    rec['metadata']['named_method_ids'] = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items()
                                          if re.search(pat, rec['source_text'], re.I)]
for rec in ALL_CHUNKS:
    rec['metadata']['related_classification_chunk_ids'] = sorted(
        f'{DOC}.chunk.{k}' for k, pat in PLAN['classification_links'].items()
        if re.search(pat, rec['source_text']) and f'{DOC}.chunk.{k}' != rec['id'])


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
    # No chunk boundary inside a physical Markdown table.
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
    # Every recommendation chunk has its recommendation start on the first line.
    for c in CHUNKS:
        if c['kind'] == 'recommendation':
            assert RECOMMENDATION.match(LINES[c['span']['start_line']-1])
    assert len(METHOD_PARENTS) == len(METHODS) and REFERENCES
    for k, v in PLAN['required_links'].items():
        assert f'{DOC}.chunk.{int(k):04}' in chunk_map and all(f'{DOC}.chunk.{n:04}' in chunk_map for n in v['chunks'])
    for o in PLAN['source_observations']:
        for snippet in o['snippets']:
            assert any(snippet in LINES[n-1] for n in o['lines']), (o['id'], snippet)
    return coverage


COVERAGE = validate()
MISSING = sorted({n for c in ALL_CHUNKS for n in c['metadata']['unresolved_citation_numbers']})
ISSUES = [dict(chunk_id=c['id'], **r) for c in ALL_CHUNKS for r in c['metadata']['appendix_links']
          if r['status'] in ('ambiguous', 'missing', 'label_name_conflict')]
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
    'title': BY_ID['subst09']['title'], 'clinical_year': int(re.search(r'\*\*Год утверждения[^:]*:\*\* (\d{4})', TEXT)[1]),
    'guideline_id': re.search(r'^ID:(\S+)', TEXT, re.M)[1].replace('\\_', '_'),
    'population': re.search(r'\*\*Возрастная категория\*\*: (\S+)', TEXT)[1], 'language': 'ru',
    'subject': PLAN['subject'],
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
               'oversized_atomic_chunks': sum(c['retrieval']['atomic_oversize'] for c in ALL_CHUNKS),
               'references': len(REFERENCES), 'images': len(ASSETS),
               'supporting_records': len(SUPPORTING)},
    'source_issues': {'missing_reference_numbers': MISSING, 'appendix_link_issues': ISSUES,
                      'duplicate_appendix_label': None,
                      'external_images_not_ocr_processed': True,
                      'bibliography_structure': PLAN['reference_format'],
                      'observations': PLAN['source_observations']},
    'validation': {'source_hash': 'passed', 'exact_character_coverage': 'passed',
                   'span_round_trip': 'passed', 'relationships': 'passed',
                   'recommendation_ownership': 'passed', 'tables_intact': 'passed',
                   'source_observations_anchored': 'passed'},
}
FILES['manifest.json'] = MANIFEST


def review():
    lines = ['# Решения по чанкам: алкогольный амнестический синдром (F10.6), 2025', '',
             'Каждая строка — поисковый чанк; полный контекст хранится по `parent_id`. '
             'Решение и его причина также записаны в JSON. Номера строк относятся к исходному Markdown.', '',
             '| Чанк / строки | Тип выдачи | Символов | Содержание |', '| --- | --- | ---: | --- |']
    for c in sorted(ALL_CHUNKS, key=lambda c: c['span']['start']):
        s = c['span']
        lines.append(f'| {c["id"]} / {s["start_line"]}–{s["end_line"]} | {c["retrieval"]["mode"]} | '
                     f'{len(c["source_text"].strip())}{" *" if c["retrieval"]["atomic_oversize"] else ""} | '
                     f'{c["title"].replace("|", "/")} |')
    lines += ['', '`*` — атомарный блок больше 3500 символов: рекомендация с вариантами, списком и '
              'комментарием либо таблица сохранены целиком.', '',
              '## Неразрешённые ссылки на литературу', '',
              f'В предоставленном списке литературы только номера 1–{len(REFERENCES)}; '
              f'в тексте использованы ещё {len(MISSING)} номеров, которых в списке нет: '
              f'{MISSING[0]}–{MISSING[-1]} (полный перечень — `references.json:unresolved_citation_numbers`).', '',
              '## Ссылки на приложения', '']
    links = [(c['id'], r) for c in ALL_CHUNKS for r in c['metadata']['appendix_links']]
    for cid, r in links:
        lines.append(f'- {cid}, строка {r["span"]["start_line"]}: `{r["raw"]}` → {r["label"]}, **{r["status"]}**.')
    lines += ['', '## Наблюдения по источнику (не исправлены)', '']
    for o in PLAN['source_observations']:
        lines.append(f'- **{o["id"]}** ({o["kind"]}), строки {", ".join(map(str, o["lines"]))}: {o["note"]}')
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
