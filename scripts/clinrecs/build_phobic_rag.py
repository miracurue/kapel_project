#!/usr/bin/env python3
"""Build the local phobic-anxiety (phob_2024) RAG dataset. No network, dependencies or application DB."""

import argparse
import bisect
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/clinrecs/rag/22_phobic'
PLAN = json.loads((OUT / 'annotation_plan.json').read_text())
SOURCE = ROOT / PLAN['source']
RAW = SOURCE.read_bytes()
assert hashlib.sha256(RAW).hexdigest() == PLAN['source_sha256'], 'Source changed: review spans first'
TEXT = RAW.decode('utf-8')
LINES = re.findall(r'[^\n]*\n|[^\n]+$', TEXT)
assert ''.join(LINES) == TEXT and len(LINES) == 2529
OFFSETS = [0]
for line in LINES:
    OFFSETS.append(OFFSETS[-1] + len(line))
PAGE = PLAN['page_proxy_chars']
DOC = PLAN['document_id']
SECTIONS = PLAN['sections']
BY_ID = {s['id']: s for s in SECTIONS}
BY_START = {s['start_line']: s for s in SECTIONS}
CITATION = re.compile(r'\[(\s*\d+(?:[\s­]*[-–—,;][\s­]*\d+)*(?:\s+и др\.)?\s*)\]')
# Recommendation bullets in this guideline use «рекомендуется/рекомендовано/рекомендуются…» anywhere in the sentence.
RECOMMENDATION = re.compile(r'^-\s+.*рекоменд', re.I)
IMAGE = re.compile(r'!\[[^\]]*\]\(([^)]+)\)')
EVIDENCE = re.compile(r'^(?:\*\*)?Уровень (?:убедительности|достоверности)[^\n]+', re.M)
METHOD_DEFS = {m['start_line']: m for m in PLAN['methods']}
NAME_PATTERNS = {
    'hars': r'HARS|Гамильтон', 'scl90r': r'SCL-?90', 'itt': r'Интегративн\w+ тест тревожности|\(ИТТ\)',
    'stai': r'STAI|Спилбергер', 'bai': r'\bBAI\b|Бек[аи]\b|Beck', 'sheehan': r'ShARS|Шихан',
    'mmpi': r'MMPI|ММРI|СМИЛ', 'ista': r'ISTA|Аммон', 'usk': r'\(УСК\)|субъективного контроля',
    'pbt': r'Personal Beliefs', 'lsi': r'\bLSI\b|Life style index', 'wcq': r'WCQ|совладающего поведения',
    'mdmq': r'MDMQ|Мельбурн', 'kon2006': r'KON-2006', 'kop25': r'КОП-25',
    'lsas': r'LSAS|Либовиц', 'bfne': r'BFNE|страха негативной оценки',
    'geloph': r'GELOPH|гелотофоби', 'cgi': r'\bCGI\b|Clinical Global Impression',
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
    for r in PLAN['collection_ranges']:
        if r['from_line'] <= line < r['to_line_exclusive']:
            return r['collection']
    raise AssertionError(line)


REFERENCES = []
for number in range(1, 42):
    # The bibliography nests the real item 1 under a wrapper item «1. Клинические рекомендации…».
    pattern = rf'^ {{6}}{number}\. ' if number > 1 else r'^ {3}1\. 1\. '
    matches = list(re.finditer(pattern + r'[^\n]+', TEXT, re.M))
    assert len(matches) == 1, (number, matches)
    m = matches[0]
    body_start = m.start() + re.match(pattern, m[0]).end()
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


def label_of(section):
    m = re.match(r'Приложение ([АБВГ]\d*)\.', section['title'])
    return m[1] if m else None


for section in SECTIONS:
    a, b = section['start_line'], section['own_end_line_exclusive']
    category = collection_for(a)
    if category == 'references':
        own(section['own_span'], 'references', ['references.source_section'])
        continue
    if not meaningful(section['own_span']) and a not in METHOD_DEFS:
        own(section['own_span'], 'structure', [section['id']])
        continue
    if category == 'supporting':
        rec = source_record(f'{DOC}.support.{a}', section['title'], section['own_span'], section)
        rec['index_in_clinical_search'] = False
        SUPPORTING.append(rec)
        own(section['own_span'], 'supporting', [rec['id']])
        continue
    units = [dict(u) for u in PLAN['units'].get(str(a), [])]
    assert units, ('Section with text but no planned units', a, section['title'])
    # A heading-only introduction is navigation, not a chunk.
    if units[0]['kind'] == 'section_introduction' and units[0]['line'] == a and len(units) > 1 \
            and not meaningful(line_span(a, units[1]['line'])):
        units = units[1:]
    starts = [u['line'] for u in units]
    assert starts == sorted(set(starts)) and all(a <= n < b for n in starts), (a, starts)
    parent_id = f'{DOC}.parent.{a}'
    # Context parents are complete semantic blocks, not entire chapters containing
    # nested subsections. The original hierarchy remains in sections.json.
    full_span = section['own_span']
    parent = source_record(parent_id, section['title'], full_span, section)
    parent['index_in_vector_search'] = False
    parent['section_subtree_span'] = section['span']
    parent['child_ids'] = []
    parent['ancestor_context_spans'] = context_spans(section)
    method = METHOD_DEFS.get(a)
    passport = None
    if category == 'methods':
        parent['id'] = parent_id = f'{DOC}.method.{method["key"]}'
        parent['original_appendix_label'] = method['label']
        comps = method['component_lines']
        passport = line_span(comps[0], comps[1] if len(comps) > 1 else b)
        parent['required_context_spans'] = [passport] if len(comps) > 1 else []
        METHOD_PARENTS.append(parent)
    elif category == 'appendices':
        parent['original_appendix_label'] = label_of(section)
        APPENDICES.append(parent)
    else:
        PARENTS.append(parent)
    if starts[0] > a:
        own(line_span(a, starts[0]), 'structure', [section['id']])
    group = []
    for i, unit in enumerate(units):
        start = unit['line']
        end = starts[i+1] if i+1 < len(starts) else b
        s = line_span(start, end)
        chunk_id = f'{DOC}.chunk.{start:04}'
        title = unit.get('title') or short_title(LINES[start-1])
        rec = source_record(chunk_id, title, s, section)
        rec['kind'] = unit['kind']
        rec['collection'] = category
        rec['index_in_vector_search'] = True
        rec['parent_id'] = parent_id
        single = len(starts) == 1
        standalone = single and not context_spans(section)
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
        if category == 'methods' and i > 0:
            rec['retrieval']['always_include_spans'].append(passport)
        parent['child_ids'].append(chunk_id)
        group.append(rec)
        own(s, category, [chunk_id])
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
CHUNK_MAP = {c['id']: c for c in ALL_CHUNKS}
TARGETS = METHOD_PARENTS + APPENDICES

# Explicit nonlocal dependencies from the plan, not neighboring-text guesses.
for link in PLAN['required_links']:
    target = f'{DOC}.chunk.{link["to_line"]:04}'
    assert target in CHUNK_MAP, link
    for n in link['from_lines']:
        source = CHUNK_MAP[f'{DOC}.chunk.{n:04}']
        if target not in source['retrieval']['required_chunk_ids']:
            source['retrieval']['required_chunk_ids'].append(target)
for chunk in ALL_CHUNKS:
    r = chunk['retrieval']
    if r['required_chunk_ids'] and r['mode'] == 'self':
        r.update(mode='parent', context_parent_id=chunk['parent_id'],
                 reason='К собственному полному блоку нужно приложить явно связанные общие условия или комментарий.')


def appendix_links(s):
    raw = slice_text(s)
    result = []
    # Include shorthand continuation labels, e.g. «Приложения Г2, Г5».
    pattern = r'[Пп]риложени[еяиюях]+\s+([АБВГ]\s*\.?\s*\d*(?:\s*,\s*[АБВГ]\s*\d+)*)'
    for m in re.finditer(pattern, raw):
        for label_match in re.finditer(r'[АБВГ]\s*\.?\s*\d*', m[1]):
            label = re.sub(r'[\s.]', '', label_match[0])
            candidates = [t['id'] for t in TARGETS if t['original_appendix_label'] == label]
            note = None
            status = 'resolved' if len(candidates) == 1 else 'ambiguous' if candidates else 'missing'
            if not candidates:
                bare = [t['id'] for t in TARGETS if t['original_appendix_label'] == label[0]]
                if bare and len(label) > 1:
                    candidates, status = bare, 'subitem_not_labeled_in_source'
                    note = f'Источник ссылается на {label}, но приложение {label[0]} не разбито на пронумерованные части; подпункт не выбран.'
                else:
                    note = f'Приложения {label} в предоставленном наборе нет.'
            nearby = raw[max(0, m.start()-120):m.end()]
            named = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items() if re.search(pat, nearby, re.I)]
            if named and candidates and status == 'resolved' and not set(named).intersection(candidates):
                status = 'label_name_conflict'
            elif len(candidates) > 1 and len(set(named).intersection(candidates)) == 1:
                status = 'resolved_by_name'
            resolved = list(set(named).intersection(candidates)) if status == 'resolved_by_name' else candidates if status == 'resolved' else []
            result.append({'raw': m[0], 'label': label, 'status': status,
                           'declared_target_ids': candidates, 'named_method_candidate_ids': named,
                           'resolved_target_ids': sorted(resolved), 'review_note': note,
                           'span': span(s['start']+m.start(), s['start']+m.end())})
    return result


code_targets = {}
for chunk in CHUNKS:
    if chunk['kind'] == 'diagnostic_criteria':
        for line in chunk['source_text'].splitlines():
            m = re.match(r'(F\d{2}(?:\.\d+)?)\b', line)
            if m:
                code_targets[m[1]] = chunk['id']
for rec in ALL_RECORDS:
    rec['metadata']['appendix_links'] = appendix_links(rec['span'])
    rec['metadata']['named_method_ids'] = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items()
                                          if re.search(pat, rec['source_text'], re.I)]
    if rec in ALL_CHUNKS:
        codes = set(m[0] for m in re.finditer(r'F\d{2}(?:\.\d+)?', rec['source_text']))
        rec['metadata']['related_classification_chunk_ids'] = sorted({code_targets[c] for c in codes if c in code_targets} - {rec['id']})


def validate():
    assert not re.search(r'<!-- clinrec ', TEXT)
    ids = {r['id'] for r in ALL_RECORDS}
    assert len(ids) == len(ALL_RECORDS)
    parent_map = {p['id']: p for p in PARENTS + METHOD_PARENTS + APPENDICES}
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
                assert CHUNK_MAP[target]['parent_id'] == c['parent_id']
                opposite = 'next_chunk_id' if key == 'previous_chunk_id' else 'previous_chunk_id'
                assert CHUNK_MAP[target]['retrieval'][opposite] == c['id']
        assert set(c['retrieval']['required_chunk_ids']) <= CHUNK_MAP.keys()
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
    rec_lines = [n for n, line in enumerate(LINES, 1) if collection_for(n) == 'clinical' and RECOMMENDATION.match(line)]
    assert len(rec_lines) == 56, len(rec_lines)
    for n in rec_lines:
        owners = [c for c in ALL_CHUNKS if c['span']['start'] <= OFFSETS[n-1] < c['span']['end']]
        assert len(owners) == 1, n
        assert owners[0]['kind'] == 'recommendation' and owners[0]['span']['start_line'] == n, n
        assert owners[0]['metadata']['evidence_statements'], n
    assert sum(len(c['metadata']['evidence_statements']) for c in ALL_CHUNKS) == \
        sum('Уровень убедительности' in line for line in LINES)
    # Quoted source observations still point at the intended lines.
    for note in PLAN['source_issue_notes']:
        assert note['quote'] in LINES[note['line']-1], note
    assert len(METHOD_PARENTS) == 19 and len(REFERENCES) == 41
    return coverage


COVERAGE = validate()
MISSING = sorted({n for c in ALL_CHUNKS for n in c['metadata']['unresolved_citation_numbers']})
ISSUES = [dict(chunk_id=c['id'], **r) for c in ALL_CHUNKS for r in c['metadata']['appendix_links']
          if r['status'] in ('ambiguous', 'missing', 'label_name_conflict', 'subitem_not_labeled_in_source')]
REF_SECTION = BY_START[853]
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
                        'completeness': 'provided_bibliography_only_numbers_1_to_41'},
    'sections.json': {'schema_version': '1.0', 'document_id': DOC, 'sections': SECTIONS},
    'coverage.json': {'schema_version': '1.0', 'document_id': DOC, 'partition': COVERAGE},
}
ASSETS = []
for m in IMAGE.finditer(TEXT):
    ASSETS.append({'id': f'{DOC}.image.{len(ASSETS)+1:03}', 'url': m[1],
                   'span': span(m.start(), m.end()), 'content_status': 'external_not_downloaded_or_ocr_processed',
                   'referring_chunk_ids': [c['id'] for c in ALL_CHUNKS if c['span']['start'] <= m.start() < c['span']['end']]})
FILES['assets.json'] = {'schema_version': '1.0', 'document_id': DOC, 'assets': ASSETS}
date = re.search(r'\*\*Дата скачивания:\*\* (\d\d)\.(\d\d)\.(\d{4})', TEXT)
MANIFEST = {
    'schema_version': '1.0', 'document_id': DOC,
    'title': 'Тревожно-фобические расстройства',
    'clinical_year': int(re.search(r'\*\*Год утверждения:\*\* (\d{4})', TEXT)[1]),
    'guideline_id': re.search(r'^ID: (\d+)', TEXT, re.M)[1],
    'population': re.search(r'\*\*Возрастная категория:\*\* (\S+)', TEXT)[1], 'language': 'ru',
    'source_file': PLAN['source'], 'source_sha256': PLAN['source_sha256'],
    'source_url': re.search(r'\*\*Источник:\*\* \[[^\]]+\]\(([^)]+)\)', TEXT)[1],
    'downloaded_date_as_stated': f'{date[3]}-{date[2]}-{date[1]}',
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
                      'duplicate_appendix_label': None,
                      'external_images_not_ocr_processed': True,
                      'observations': PLAN['source_issue_notes']},
    'validation': {'source_hash': 'passed', 'exact_character_coverage': 'passed',
                   'span_round_trip': 'passed', 'relationships': 'passed',
                   'recommendation_ownership': 'passed', 'tables_intact': 'passed'},
}
FILES['manifest.json'] = MANIFEST


def review():
    lines = ['# Решения по чанкам ТФР, 2024', '',
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
              '## Неразрешённые ссылки на литературу', '',
              f'В предоставленном списке литературы только номера 1–41; отсутствуют {len(MISSING)} используемых номеров. '
              'Полный список — `references.json:unresolved_citation_numbers`.', '',
              '## Ссылки на приложения, требующие внимания', '']
    for issue in ISSUES:
        lines.append(f'- {issue["chunk_id"]}, строка {issue["span"]["start_line"]}: '
                     f'`{issue["raw"]}` → {issue["label"]}, **{issue["status"]}**.')
    lines += ['', '## Наблюдения по источнику (не исправлялись)', '']
    for n in PLAN['source_issue_notes']:
        lines.append(f'- строка {n["line"]} (`{n["id"]}`): {n["note"]}')
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
