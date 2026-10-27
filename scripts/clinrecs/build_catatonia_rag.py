#!/usr/bin/env python3
"""Build the reviewed local febrile catatonia (2021) dataset. No network, dependencies or application DB."""

import argparse
import bisect
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/clinrecs/rag/25_catatonia'
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
# The source has one citation with a space instead of a comma: «[1,3 4,5, 13,14,15]».
CITATION = re.compile(r'\[(\s*\d+(?:(?:[\s­]*[-–—,;][\s­]*|\s+)\d+)*(?:\s+и др\.)?\s*)\]')
# Recommendations here are top-level bullets «Пациентам … рекомендуется / не рекомендуется …».
RECOMMENDATION = re.compile(r'^-\s.*\bрекомендуется\b', re.I)
IMAGE = re.compile(r'!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)')
EVIDENCE = re.compile(r'^(?:\*\*)?Уровень[^\n]+', re.M)
APPENDIX_LINK = re.compile(r'[Пп]риложени[еяиюях]+\s+((?:[АБВГ]З|[АБВГ]\s*\.?\s*\d*)(?:\s*,\s*[АБВГ]\s*\d+)*)')
METHODS = {365: ('bfcrs', 'Г', [365], [365, 373])}
NAME_PATTERNS = {'bfcrs': r'Буша|Френсис|Bush|BFCRS'}


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


def collection_for(section):
    return section.get('collection', 'clinical')


def build_references():
    section = BY_ID['cr25.11.01']['own_span']
    base = section['start']
    body = slice_text(section)
    # The bibliography nests the real list inside a wrapper item and packs several
    # items on one physical line; items are located by their sequential numbers.
    first = body.index('1. 1. Тиганов') + 3
    markers = [(1, first, first + 3)]
    pos = first + 3
    for number in range(2, 41):
        m = re.compile(r'(?:(?<=\s)|^)%d\s?\.\s?(?=\S)' % number).search(body, pos)
        assert m, number
        markers.append((number, m.start(), m.end()))
        pos = m.end()
    items = []
    for i, (number, start, body_start) in enumerate(markers):
        end = markers[i+1][1] if i+1 < len(markers) else len(body)
        text = body[body_start:end].rstrip()
        items.append({'id': f'{DOC}.ref.{number:03}', 'number': number, 'text': text,
                      'span': span(base + start, base + body_start + len(text))})
    return items


REFERENCES = build_references()
assert [r['number'] for r in REFERENCES] == list(range(1, 41))
REF_BY_NUMBER = {r['number']: r['id'] for r in REFERENCES}


def metadata(s):
    raw = slice_text(s)
    citation_spans = []
    numbers = set()
    for m in CITATION.finditer(raw):
        ns = set()
        irregular = False
        for item in re.split(r'[,;]', m[1]):
            bounds = [int(n) for n in re.findall(r'\d+', item)]
            if re.search(r'[-–—]', item):
                assert len(bounds) == 2
                ns.update(range(bounds[0], bounds[-1] + 1))
            else:
                # Whitespace-only separation is read as a list, never as a range.
                irregular = irregular or len(bounds) > 1
                ns.update(bounds)
        numbers.update(ns)
        citation_spans.append({'raw': m[0], 'numbers': sorted(ns), 'unspecified_others': 'и др.' in m[0],
                               'irregular_separator': irregular,
                               'span': span(s['start'] + m.start(), s['start'] + m.end())})
    only_image = IMAGE.search(raw) and not re.sub(
        r'[#*\s]', '', IMAGE.sub('', re.sub(r'^\*\*[^\n]+\*\*\s*$', '', raw, flags=re.M)))
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
    if section.get('ancestor_context') is False:
        return result
    while section['parent']:
        section = BY_ID[section['parent']]
        if section['level'] == 1:
            continue  # Source passport is attached from manifest, never the whole document.
        if collection_for(section) == 'clinical' and meaningful(section['own_span']):
            result.append(section['own_span'])
    return list(reversed(result))


SHARED = {c['comment_line']: c for c in PLAN['shared_comments']}


def units_for(section):
    a = section['start_line']
    if a in METHODS:
        return METHODS[a][2], 'method_component'
    if str(a) in PLAN['unit_lines']:
        starts = PLAN['unit_lines'][str(a)]
        return starts, ('narrative_topic' if collection_for(section) == 'appendices' else 'recommendation')
    return [a], 'semantic_block'


for section in SECTIONS:
    a, b = section['start_line'], section['own_end_line_exclusive']
    category = collection_for(section)
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
        parent['required_context_spans'] = [line_span(anchors[0], anchors[1])]
        METHOD_PARENTS.append(parent)
    elif category == 'appendices':
        parent['original_appendix_label'] = section['appendix_label']
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
        if start in SHARED:
            rec['kind'] = 'shared_comment'
            rec['title'] = SHARED[start]['title']
        elif str(start) in PLAN['kinds']:
            rec['kind'] = PLAN['kinds'][str(start)]
        elif kind == 'recommendation':
            rec['kind'] = 'recommendation' if RECOMMENDATION.match(LINES[start-1]) else 'section_introduction'
        else:
            rec['kind'] = kind
        rec['collection'] = category
        rec['index_in_vector_search'] = True
        rec['parent_id'] = parent_id
        # A paragraph with its own complete purpose can stand alone with title/provenance.
        single = len(starts) == 1
        standalone = single and category == 'clinical' and not context_spans(section)
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
    for comment in PLAN['shared_comments']:
        if line in comment['recommendation_lines']:
            chunk['retrieval']['required_chunk_ids'].append(f'{DOC}.chunk.{comment["comment_line"]:04}')
    if chunk['retrieval']['required_chunk_ids'] and chunk['retrieval']['mode'] == 'self':
        chunk['retrieval'].update(mode='parent', context_parent_id=chunk['parent_id'],
                                  reason='К собственному полному блоку нужно приложить явно связанные общие условия или комментарий.')


ALL_CHUNKS = CHUNKS + METHOD_CHUNKS + [c for p in APPENDICES for c in p['chunks']]
ALL_RECORDS = ALL_CHUNKS + PARENTS + METHOD_PARENTS + APPENDICES + SUPPORTING
TARGETS = METHOD_PARENTS + APPENDICES


def appendix_links(s):
    raw = slice_text(s)
    result = []
    for m in APPENDIX_LINK.finditer(raw):
        for label_match in re.finditer(r'[АБВГ]З|[АБВГ]\s*\.?\s*\d*', m[1]):
            label = re.sub(r'[\s.]', '', label_match[0])
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


for rec in ALL_RECORDS:
    rec['metadata']['appendix_links'] = appendix_links(rec['span'])
    rec['metadata']['named_method_ids'] = [f'{DOC}.method.{key}' for key, pat in NAME_PATTERNS.items()
                                          if re.search(pat, rec['source_text'], re.I)]
    if rec in ALL_CHUNKS:
        rec['metadata']['related_classification_chunk_ids'] = []


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
            assert owners[0]['kind'] == 'recommendation', n
            assert owners[0]['metadata']['evidence_statements'], n
    for comment in PLAN['shared_comments']:
        shared_id = f'{DOC}.chunk.{comment["comment_line"]:04}'
        for n in comment['recommendation_lines']:
            assert shared_id in chunk_map[f'{DOC}.chunk.{n:04}']['retrieval']['required_chunk_ids']
    assert len(METHOD_PARENTS) == 1 and len(REFERENCES) == 40
    return coverage


COVERAGE = validate()
MISSING = sorted({n for c in ALL_CHUNKS + SUPPORTING + PARENTS for n in c['metadata']['unresolved_citation_numbers']})
ISSUES = [dict(chunk_id=c['id'], **r) for c in ALL_CHUNKS for r in c['metadata']['appendix_links']
          if r['status'] in ('ambiguous', 'missing', 'label_name_conflict')]


def line_of(fragment):
    hits = [n for n, line in enumerate(LINES, 1) if fragment in line]
    assert len(hits) == 1, (fragment, hits)
    return hits[0]


# Source defects are recorded, never repaired. Each entry is anchored to a text fragment
# so that a changed source fails the build instead of silently keeping a stale note.
SOURCE_DEFECTS = [
    ('citation_missing_comma', '[1,3 4,5, 13,14,15]', 'Ссылка «[1,3 4,5, 13,14,15]» записана с пробелом вместо запятой между 3 и 4; прочитана как список 1, 3, 4, 5, 13, 14, 15 и помечена irregular_separator.'),
    ('appendix_label_cyrillic_Z', 'Приложение АЗ.', 'Заголовок «Приложение АЗ» написан кириллической «З» вместо цифры 3; метка сохранена как в источнике (АЗ).'),
    ('appendix_g_unnumbered', 'Приложение Г. Шкала выявления', 'Единственное приложение Г без номера; в других КР методики нумеруются Г1, Г2…'),
    ('bfcrs_items_absent', 'С полной версией шкалы', 'В приложении Г нет пунктов шкалы BFCRS: есть паспорт, источник, назначение и отсылка на внешний сайт. Содержание шкалы недоступно для RAG.'),
    ('benzodiazepine_doses_absent', 'анксиолитиков производных бензодиазепина - в высоких дозах', 'Рекомендация называет «высокие дозы» лоразепама и диазепама, но числовых доз в документе нет; дозы не додуманы.'),
    ('evidence_scale_images_only', 'Шкала оценки уровней достоверности доказательств (УДД) для методов диагностики', 'Шкалы УДД/УУР, алгоритм действия врача (Приложение Б) и критерии оценки качества даны только внешними изображениями; не скачивались и не распознавались.'),
    ('evidence_line_merged_with_comment', 'Комментарий:** *Лечение проводится по принципам интенсивной терапии', 'В трёх рекомендациях (строки 149–150, 164–165, 171–172) строка «Уровень убедительности…» и «Комментарий» находятся в одном жирном фрагменте без закрывающих «**» после УДД; текст сохранён как есть.'),
    ('evidence_wording_variants', 'Уровень убедительности рекомендаций С (уровень достоверности доказательств -5)', 'Запись УДД/УУР непоследовательна: «-5», «– 5», «–5», «– 5)**». Уровни сохранены как написано; УДД 4 у лоразепама и 5 у остальных вариантов не сверялись с изображениями шкал.'),
    ('criteria_missing_spaces', '4.Соматовегетативныенарушения', 'В критериях В пункт 4 написан без пробелов («4.Соматовегетативныенарушения»); не исправлено.'),
    ('terms_heading_merged', '**Термины и определения\n', None),
    ('abbreviations_single_paragraph', 'ЗНС – злокачественный нейролептический синдром\n', 'Список сокращений записан строками без пустых строк между ними: в Markdown они сливаются в один абзац.'),
    ('bibliography_nested_wrapper', '1. Клинические рекомендации Российского общества психиатров', 'Литература вложена в «пункт-обёртку» «1. Клинические рекомендации Российского общества психиатров»; настоящий источник №1 стоит внутри, а многие пункты 2–14 записаны в одну физическую строку.'),
    ('bibliography_item_29_spacing', '29 .Еникеев', 'Пункт 29 литературы записан как «29 .Еникеев» (пробел перед точкой).'),
    ('bibliography_truncated_fields', '№ С.90 98.', 'В нескольких пунктах литературы утеряны номера томов/журналов («Vol. P.», «№ С.»), тире в страницах заменены пробелами; текст не исправлялся.'),
    ('bibliography_year_ambiguous', 'American Psychiatric Association. Diagnostic and Statistical manual of mental disorders. 5th ed.', 'В пункте 12 указано «2012 2013», один из годов в источнике лишний; не исправлено.'),
    ('duplicate_information_heading', '### Информация\n', None),
    ('empty_attachment_link', '-  (Фебрильная_кататония_2021.pdf)', 'Ссылка на прикреплённый PDF пуста (нет URL).'),
    ('reference_a3_duplicates_bibliography', '6. Психиатрическая помощь больным шизофрении.', 'Это же руководство есть и в литературе (№39), и в приложении А3 (№6); связь не устанавливалась.'),
]
SOURCE_DEFECTS_EXTRA = {
    'terms_heading_merged': 'Заголовок «Термины и определения» и первый термин склеены в один жирный фрагмент («**Термины и определения\\nАнтипсихотические препараты/средства** …»).',
    'duplicate_information_heading': 'Заголовок «Информация» встречается дважды (раздел второго уровня и вложенный раздел третьего уровня); в sections.json они различимы по id и уровню.',
}
DEFECTS = []
for code, fragment, description in SOURCE_DEFECTS:
    if fragment == '### Информация\n':
        hits = [n for n, line in enumerate(LINES, 1) if line.strip() == '### Информация']
        assert len(hits) == 1
        line = hits[0]
    elif '\n' in fragment:
        pos = TEXT.index(fragment)
        assert TEXT.count(fragment) == 1, code
        line = bisect.bisect_right(OFFSETS, pos)
    else:
        line = line_of(fragment)
    DEFECTS.append({'code': code, 'line': line, 'description': description or SOURCE_DEFECTS_EXTRA[code]})

FILES = {
    'chunks.json': {'schema_version': '1.0', 'document_id': DOC, 'chunks': CHUNKS},
    'parents.json': {'schema_version': '1.0', 'document_id': DOC, 'parents': PARENTS},
    'methods.json': {'schema_version': '1.0', 'document_id': DOC, 'parents': METHOD_PARENTS, 'chunks': METHOD_CHUNKS},
    'appendices.json': {'schema_version': '1.0', 'document_id': DOC, 'appendices': APPENDICES},
    'supporting.json': {'schema_version': '1.0', 'document_id': DOC, 'records': SUPPORTING},
    'references.json': {'schema_version': '1.0', 'document_id': DOC,
                        'source_span': BY_ID['cr25.11.01']['span'],
                        'source_text': slice_text(BY_ID['cr25.11.01']['span']),
                        'items': REFERENCES, 'unresolved_citation_numbers': MISSING,
                        'completeness': 'provided_bibliography_only_numbers_1_to_40'},
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
    'title': 'Фебрильная кататония', 'clinical_year': 2021,
    'guideline_id': None, 'population': 'Взрослые', 'language': 'ru',
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
                      'defects': DEFECTS,
                      'numeric_doses_in_source': len(re.findall(r'\d+\s*(?:мг|мкг|г)\b', TEXT)),
                      'external_images_not_ocr_processed': True},
    'validation': {'source_hash': 'passed', 'exact_character_coverage': 'passed',
                   'span_round_trip': 'passed', 'relationships': 'passed',
                   'recommendation_ownership': 'passed', 'tables_intact': 'passed'},
}
MANIFEST['medelement_id'] = MANIFEST['source_url'].rstrip('/').rsplit('/', 1)[1]
FILES['manifest.json'] = MANIFEST


def review():
    lines = ['# Решения по чанкам: фебрильная кататония, 2021', '',
             'Каждая строка — поисковый чанк; полный контекст хранится по `parent_id`. '
             'Решение и его причина также записаны в JSON. Номера строк относятся к исходному Markdown.', '',
             '| Чанк / строки | Тип выдачи | Символов | Содержание |', '| --- | --- | ---: | --- |']
    for c in sorted(ALL_CHUNKS, key=lambda c: c['span']['start']):
        s = c['span']
        lines.append(f'| {c["id"]} / {s["start_line"]}–{s["end_line"]} | {c["retrieval"]["mode"]} | '
                     f'{len(c["source_text"].strip())}{" *" if c["retrieval"]["atomic_oversize"] else ""} | '
                     f'{c["title"].replace("|", "/")} |')
    lines += ['', '`*` — атомарный блок больше 3500 символов; в этом документе таких нет, если звёздочек нет.', '',
              '## Неразрешённые ссылки на литературу', '']
    if MISSING:
        lines.append(f'Отсутствуют в списке литературы {len(MISSING)} номеров: {", ".join(map(str, MISSING))}.')
    else:
        lines.append('Все цитируемые номера (1–40) имеются в списке литературы.')
    lines += ['', '## Проблемы источника (не исправлены)', '']
    for d in DEFECTS:
        lines.append(f'- строка {d["line"]}, `{d["code"]}`: {d["description"]}')
    if ISSUES:
        lines += ['', '## Конфликты ссылок на приложения', '']
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
print('Validation passed; unresolved citation numbers:', len(MISSING), '; appendix issues:', len(ISSUES),
      '; source defects:', len(DEFECTS))
