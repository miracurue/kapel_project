#!/usr/bin/env python3
"""Build the reviewed local panic disorder (2024) dataset. No network, dependencies or application DB."""

import argparse
import bisect
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/clinrecs/rag/07_panic'
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
RECOMMENDATION = re.compile(PLAN['recommendation_pattern'], re.I)
IMAGE = re.compile(r'!\[[^\]]*\]\(([^)]+)\)')
EVIDENCE = re.compile(r'^(?:\*\*)?Уровень\s+(?:убедительности|достоверности)[^\n]+', re.M)
EVIDENCE_WELL_FORMED = re.compile(
    r'^(?:\*\*)?Уровень\s+убедительности\s+рекомендаций\s*[-–]?\s*[A-CА-С]\s*\(уровень\s+достоверности\s+доказательств\s*[-–]?\s*[1-5]\s*\)\.?(?:\*\*)?\s*$')
METHODS = PLAN['methods']
METHOD_BY_LINE = {m['line']: m for m in METHODS}
UNIT_BY_LINE = {m['line']: m['units'] for m in METHODS}
COLL = PLAN['collections']


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
    # Bold markers can glue words together in this source («ПР**рекомендуется**»); split them first.
    s = re.sub(r'\s+([,.;:])', r'\1', re.sub(r'\s+', ' ', re.sub(r'^[-#*\s]+', '', CITATION.sub('', s)).replace('**', ' ').replace('*', '')).strip())
    return s[:160]


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
    if line >= COLL['methods_from_line']:
        return 'methods'
    if COLL['references'][0] <= line < COLL['references'][1]:
        return 'references'
    if line < COLL['supporting_before_line'] or COLL['supporting_range'][0] <= line < COLL['supporting_range'][1]:
        return 'supporting'
    if COLL['appendices'][0] <= line < COLL['appendices'][1]:
        return 'appendices'
    return 'clinical'


# The bibliography is one run-together block ("... 2. Author ... 3. Author ..."); item
# boundaries are recovered by strictly sequential numbering and then checked below.
REF_SECTION = next(s for s in SECTIONS if collection_for(s['start_line']) == 'references')
REF_TEXT = slice_text(REF_SECTION['own_span'])
REF_OFFSET = REF_SECTION['own_span']['start']
markers = []
m = re.search(r' - (1)\. (?=\S)', REF_TEXT)
markers.append((1, m.start(1), m.end()))
while True:
    n = markers[-1][0] + 1
    m = re.compile(r'(?<=\s)%d\. (?=\S)' % n).search(REF_TEXT, markers[-1][2])
    if not m:
        break
    markers.append((n, m.start(), m.end()))
REFERENCES = []
for i, (number, mstart, bstart) in enumerate(markers):
    end = markers[i+1][1] if i+1 < len(markers) else len(REF_TEXT.rstrip())
    raw = REF_TEXT[mstart:end].rstrip()
    REFERENCES.append({'id': f'{DOC}.ref.{number:03}', 'number': number,
                       'text': re.sub(r'\s+', ' ', REF_TEXT[bstart:mstart + len(raw)]).strip(),
                       'source_text': raw,
                       'span': span(REF_OFFSET + mstart, REF_OFFSET + mstart + len(raw))})
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
        if section['start_line'] in PLAN['no_ancestor_context_sections']:
            continue
        if collection_for(section['start_line']) == 'clinical' and meaningful(section['own_span']):
            result.append(section['own_span'])
    return list(reversed(result))


def units_for(section):
    """Return [(start_line, kind, title_or_None)] for the section's own span."""
    a, b = section['start_line'], section['own_end_line_exclusive']
    if a in UNIT_BY_LINE:
        return [(line, 'method_component', f'{METHOD_BY_LINE[a]["title"]}: {name}')
                for line, name in UNIT_BY_LINE[a]]
    if str(a) in PLAN['units']:
        units = [(l, k, t) for l, k, t in PLAN['units'][str(a)]]
        if units[0][0] > a:
            assert not meaningful(line_span(a, units[0][0])), ('uncovered section prefix', a)
        return [(l, k or ('recommendation' if RECOMMENDATION.match(LINES[l-1]) else 'narrative_topic'), t)
                for l, k, t in units]
    starts = [n for n in range(a, b) if RECOMMENDATION.match(LINES[n-1])]
    if starts and collection_for(a) == 'clinical':
        prefix = line_span(a, starts[0]) if starts[0] > a else None
        # A substantive introduction (e.g. a note before the first recommendation) is a separate chunk.
        units = ([(a, 'section_introduction', None)] if prefix and meaningful(prefix) else [])
        return units + [(n, 'recommendation', None) for n in starts]
    return [(a, PLAN['single_kinds'].get(str(a), 'semantic_block'), None)]


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
    if not meaningful(section['own_span']) and a not in METHOD_BY_LINE:
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
    starts_kinds = units_for(section)
    starts = [u[0] for u in starts_kinds]
    if category == 'methods':
        method = METHOD_BY_LINE[a]
        parent['id'] = parent_id = f'{DOC}.method.{method["key"]}'
        parent['original_appendix_label'] = method['label']
        parent['index_in_vector_search'] = False
        parent['required_context_spans'] = [line_span(starts[0], starts[1])] if len(starts) > 1 else []
        METHOD_PARENTS.append(parent)
    elif category == 'appendices':
        parent['original_appendix_label'] = re.sub(r'\s+', '', re.search(r'Приложение ([АБВ]\s*\d*)', section['title'])[1]) if section['title'].startswith('Приложение') else None
        APPENDICES.append(parent)
    else:
        PARENTS.append(parent)
    assert starts == sorted(set(starts)), a
    if starts[0] > a:
        own(line_span(a, starts[0]), 'structure', [section['id']])
    group = []
    for i, (start, kind, title) in enumerate(starts_kinds):
        end = starts[i+1] if i+1 < len(starts) else b
        s = line_span(start, end)
        chunk_id = f'{DOC}.chunk.{start:04}'
        rec = source_record(chunk_id, title or short_title(LINES[start-1]), s, section)
        rec['kind'] = kind
        rec['collection'] = category
        rec['index_in_vector_search'] = True
        rec['parent_id'] = parent_id
        single = len(starts) == 1
        whole = single and s == full_span
        standalone = single and ((category == 'clinical' and not context_spans(section)) or whole and category != 'clinical')
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
        parent['child_ids'].append(chunk_id)
        group.append(rec)
        own(s, category, [chunk_id])
    for i, chunk in enumerate(group):
        chunk['retrieval']['previous_chunk_id'] = group[i-1]['id'] if i else None
        chunk['retrieval']['next_chunk_id'] = group[i+1]['id'] if i+1 < len(group) else None
        if a in PLAN['shared_context_first_chunk_sections'] and i:
            chunk['retrieval']['required_chunk_ids'] = [group[0]['id']]
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
CHUNK_BY_LINE = {c['span']['start_line']: c for c in ALL_CHUNKS}
TARGETS = METHOD_PARENTS + APPENDICES

# Explicit nonlocal dependencies, not neighboring-text guesses.
for table in (PLAN['required_chunks'], PLAN['method_required_chunks']):
    for line, deps in table.items():
        chunk = CHUNK_BY_LINE[int(line)]
        chunk['retrieval']['required_chunk_ids'] += [CHUNK_BY_LINE[d]['id'] for d in deps]
for chunk in ALL_CHUNKS:
    ids = list(dict.fromkeys(chunk['retrieval']['required_chunk_ids']))
    chunk['retrieval']['required_chunk_ids'] = ids
    if ids and chunk['retrieval']['mode'] == 'self':
        chunk['retrieval'].update(mode='parent', context_parent_id=chunk['parent_id'],
                                  reason='К собственному полному блоку нужно приложить явно связанные общие условия или комментарий.')


def appendix_links(s):
    raw = slice_text(s)
    result = []
    # Include shorthand continuation labels, e.g. «Приложение Г2, Г5».
    pattern = r'[Пп]риложени[еяиюях]+\s+([АБВГ]\s*\.?\s*\d*(?:\s*,\s*[АБВГ]\s*\d+)*)'
    for m in re.finditer(pattern, raw):
        for label_match in re.finditer(r'[АБВГ]\s*\.?\s*\d*', m[1]):
            label = re.sub(r'[\s.]', '', label_match[0])
            candidates = [t['id'] for t in TARGETS if t['original_appendix_label'] == label]
            if label == 'Б':
                candidates = [t['id'] for t in APPENDICES if (t.get('original_appendix_label') or '').startswith('Б')]
            # Names near a reference help surface source-label conflicts; never relabel it.
            nearby = raw[max(0, m.start()-170):m.end()+20]
            named = [f'{DOC}.method.{x["key"]}' for x in METHODS if re.search(x['name_pattern'], nearby, re.I)]
            status = 'resolved_group' if label == 'Б' else 'resolved' if len(candidates) == 1 else 'ambiguous' if candidates else 'missing'
            if label.startswith('Г') and named and candidates and not set(named).intersection(candidates):
                status = 'label_name_conflict'
            elif len(candidates) > 1 and len(set(named).intersection(candidates)) == 1:
                status = 'resolved_by_name'
            resolved = list(set(named).intersection(candidates)) if status == 'resolved_by_name' else candidates if status in ('resolved', 'resolved_group') else []
            result.append({'raw': m[0], 'label': label, 'status': status,
                           'declared_target_ids': candidates, 'named_method_candidate_ids': named,
                           'resolved_target_ids': sorted(resolved), 'review_note': None,
                           'span': span(s['start']+m.start(), s['start']+m.end())})
    return result


CLASSIFICATION = [c for c in CHUNKS if c['kind'] in ('classification', 'diagnostic_criteria')]
for rec in ALL_RECORDS:
    rec['metadata']['appendix_links'] = appendix_links(rec['span'])
    rec['metadata']['named_method_ids'] = [f'{DOC}.method.{x["key"]}' for x in METHODS
                                          if re.search(x['name_pattern'], rec['source_text'], re.I)]
    if rec in ALL_CHUNKS:
        mentions = re.search(r'F41\.0', rec['source_text'])
        rec['metadata']['related_classification_chunk_ids'] = sorted(
            c['id'] for c in CLASSIFICATION if mentions and c['id'] != rec['id'] and re.search(r'F41\.0', c['source_text']))


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
        if collection_for(n) == 'clinical' and RECOMMENDATION.match(line):
            owners = [c for c in ALL_CHUNKS if c['span']['start'] <= OFFSETS[n-1] < c['span']['end']]
            assert len(owners) == 1, n
            if owners[0]['kind'] == 'recommendation':
                assert owners[0]['metadata']['evidence_statements'], n
    # Every evidence statement of the clinical text sits in the same chunk as its recommendation.
    for c in CHUNKS:
        if c['kind'] == 'recommendation':
            recs = [n for n in range(c['span']['start_line'], c['span']['end_line'] + 1) if RECOMMENDATION.match(LINES[n-1])]
            assert len(recs) == 1, (c['id'], recs)
    assert len(METHOD_PARENTS) == len(METHODS) == 21 and len(REFERENCES) == 60
    return coverage


COVERAGE = validate()
MISSING = sorted({n for c in ALL_CHUNKS for n in c['metadata']['unresolved_citation_numbers']})
ISSUES = [dict(chunk_id=c['id'], **r) for c in ALL_CHUNKS for r in c['metadata']['appendix_links']
          if r['status'] in ('ambiguous', 'missing', 'label_name_conflict', 'table_scope_unverified')]


def source_issues():
    issues = {'missing_reference_numbers': MISSING, 'appendix_link_issues': ISSUES}
    labels = [t['original_appendix_label'] for t in TARGETS]
    issues['duplicate_appendix_label'] = sorted({x for x in labels if labels.count(x) > 1}) or None
    issues['external_images_not_ocr_processed'] = True
    # Evidence lines: absent or malformed УДД/УУР values are recorded, never repaired.
    malformed = []
    for c in CHUNKS:
        for e in c['metadata']['evidence_statements']:
            if not EVIDENCE_WELL_FORMED.match(e['raw']):
                malformed.append({'chunk_id': c['id'], 'raw': e['raw'], 'span': e['span']})
    issues['evidence_statement_format_issues'] = malformed
    mixed = []
    for c in CHUNKS:
        for e in c['metadata']['evidence_statements']:
            m = re.search(r'рекомендаций\s*[-–]?\s*([A-Za-zА-Яа-я])\b', e['raw'])
            if m and re.fullmatch(r'[A-Za-z]', m[1]):
                mixed.append({'chunk_id': c['id'], 'letter': m[1], 'line': e['span']['start_line']})
    issues['latin_letters_in_evidence_level'] = mixed
    # Appendix numbering.
    g = sorted(int(t['original_appendix_label'][1:]) for t in METHOD_PARENTS)
    b = sorted(t['original_appendix_label'] for t in APPENDICES if t['original_appendix_label'].startswith('Б'))
    issues['appendix_numbering'] = {'methods_labels_consecutive': g == list(range(1, len(g) + 1)),
                                    'algorithm_labels_present': b,
                                    'note': 'Алгоритмы: есть Б, Б1 и Б4; Б2 и Б3 в источнике отсутствуют. '
                                            'Две картинки сразу после заголовка «Приложение Б» не подписаны.'}
    # Dose ranges quoted in recommendation comments against the table of appendix А3.
    table = {}
    for m in re.finditer(r'^\|\s*#?\*?#?\s*([А-Яа-я]+)[\s\\*]*\|\s*([\d,]+-[\d,]+)\s*\[', TEXT, re.M):
        table[m[1].lower()] = (m[2], m.start())
    drugs = '|'.join(re.escape(d) for d in table)
    inconsistent = []
    for m in re.finditer(r'(%s)(?:\\?\*)*\s+([\d,]+-[\d,]+)\s*мг/сут' % drugs, TEXT, re.I):
        name = m[1].lower()
        if name in table and table[name][0] != m[2]:
            inconsistent.append({'drug': name, 'quoted': m[2], 'table_a3': table[name][0],
                                 'quoted_span': span(m.start(), m.end())})
    issues['dose_range_mismatch_with_table_a3'] = inconsistent
    # Footnote anchors that point to a site we do not mirror.
    issues['footnote_links_to_external_site'] = len(re.findall(r'\]\(https://cr\.minzdrav\.gov\.ru/#_ftn\d+\)', TEXT))
    issues['bibliography_format'] = ('Список литературы — сплошной абзац без разделения строк по пунктам; границы 1–%d восстановлены '
                                     'последовательной нумерацией. Между пунктами встречаются лишние цифры (номера страниц PDF).' % len(REFERENCES))
    issues['duplicate_table_numbers'] = sorted({m[1] for m in re.finditer(r'\*\*(Таблица \d+)[.*]', TEXT)
                                                if len(re.findall(re.escape(m[1]) + r'[.*]', TEXT)) > 1})
    return issues


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
                        'completeness': 'provided_bibliography_only_numbers_1_to_%d' % len(REFERENCES)},
    'sections.json': {'schema_version': '1.0', 'document_id': DOC, 'sections': SECTIONS},
    'coverage.json': {'schema_version': '1.0', 'document_id': DOC, 'partition': COVERAGE},
}
ASSETS = []
for m in IMAGE.finditer(TEXT):
    local = not re.match(r'https?://', m[1])
    ASSETS.append({'id': f'{DOC}.image.{len(ASSETS)+1:03}', 'url': m[1],
                   'span': span(m.start(), m.end()),
                   'content_status': ('local_relative_path_file_absent_not_ocr_processed'
                                      if local and not (SOURCE.parent / m[1]).exists()
                                      else 'external_not_downloaded_or_ocr_processed'),
                   'referring_chunk_ids': [c['id'] for c in ALL_CHUNKS if c['span']['start'] <= m.start() < c['span']['end']]})
FILES['assets.json'] = {'schema_version': '1.0', 'document_id': DOC, 'assets': ASSETS}
ISSUES_ALL = source_issues()
ISSUES_ALL['images_without_url'] = sum(1 for a in ASSETS if not re.match(r'https?://', a['url']))
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
    'source_issues': ISSUES_ALL,
    'validation': {'source_hash': 'passed', 'exact_character_coverage': 'passed',
                   'span_round_trip': 'passed', 'relationships': 'passed',
                   'recommendation_ownership': 'passed', 'tables_intact': 'passed'},
}
FILES['manifest.json'] = MANIFEST


def review():
    lines = ['# Решения по чанкам: паническое расстройство, 2024', '',
             'Каждая строка — поисковый чанк; полный контекст хранится по `parent_id`. '
             'Решение и его причина также записаны в JSON. Номера строк относятся к исходному Markdown.', '',
             '| Чанк / строки | Тип выдачи | Символов | Содержание |', '| --- | --- | ---: | --- |']
    for c in sorted(ALL_CHUNKS, key=lambda c: c['span']['start']):
        s = c['span']
        lines.append(f'| {c["id"]} / {s["start_line"]}–{s["end_line"]} | {c["retrieval"]["mode"]} | '
                     f'{len(c["source_text"].strip())}{" *" if c["retrieval"]["atomic_oversize"] else ""} | '
                     f'{c["title"].replace("|", "/")} |')
    lines += ['', '`*` — атомарный блок больше 3500 символов: рекомендация с комментарием, таблица, '
              'опросник или бланк сохранены целиком.', '',
              '## Проблемы источника (не исправлены)', '',
              f'- Литература: в предоставленном списке пункты 1–{len(REFERENCES)}; используемых в тексте номеров, которых в нём нет: {len(MISSING)} '
              '(полный список — `references.json:unresolved_citation_numbers`). Список дополнен не был.',
              f'- {ISSUES_ALL["bibliography_format"]}']
    for issue in ISSUES:
        lines.append(f'- {issue["chunk_id"]}, строка {issue["span"]["start_line"]}: '
                     f'`{issue["raw"]}` → {issue["label"]}, **{issue["status"]}**.')
    for e in ISSUES_ALL['evidence_statement_format_issues']:
        lines.append(f'- {e["chunk_id"]}, строка {e["span"]["start_line"]}: УДД/УУР записан неполно или нестандартно: `{e["raw"]}`.')
    for e in ISSUES_ALL['latin_letters_in_evidence_level']:
        lines.append(f'- {e["chunk_id"]}, строка {e["line"]}: уровень убедительности записан латинской буквой `{e["letter"]}` (остальные — кириллицей).')
    for d in ISSUES_ALL['dose_range_mismatch_with_table_a3']:
        lines.append(f'- строка {d["quoted_span"]["start_line"]}: «{d["drug"]} {d["quoted"]} мг/сут» в комментарии, '
                     f'в таблице А3 для этого препарата `{d["table_a3"]}`.')
    lines += [f'- Приложение Б: {ISSUES_ALL["appendix_numbering"]["note"]}',
              f'- Сноски-ссылки на cr.minzdrav.gov.ru внутри текста: {ISSUES_ALL["footnote_links_to_external_site"]}; сохранены как есть.',
              f'- Одинаковые номера таблиц в разных разделах: {", ".join(ISSUES_ALL["duplicate_table_numbers"]) or "нет"}.',
              f'- Картинки без URL (локальный путь, файла нет): {ISSUES_ALL["images_without_url"]}; содержимое картинок не распознавалось.', '']
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
