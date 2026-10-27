#!/usr/bin/env python3
"""Build the reviewed local RAG dataset for the 2024 cognitive disorders guideline.

No network, embeddings, dependencies or application DB. Reads the source Markdown
and docs/clinrecs/rag/05_cognitive/annotation_plan.json (the section tree and the
reviewed decisions). Use --write-plan to regenerate the plan from the heading rules
in this file; --check verifies that every generated artifact is up to date.
"""

import argparse
import bisect
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/clinrecs/rag/05_cognitive'
DOC = 'cogn_2024'
SOURCE_REL = 'docs/clinrecs/05_Когнитивные_расстройства_у_лиц_пожилого_и_старческого_возраста_2024.md'
SOURCE_SHA256 = '4db32aacdc8d58f17a603c6458a01ba5ae674865b901a98359b655df6c7625e4'
PAGE = 3500
TINY = 150

RAW = (ROOT / SOURCE_REL).read_bytes()
assert hashlib.sha256(RAW).hexdigest() == SOURCE_SHA256, 'Source changed: review spans first'
TEXT = RAW.decode('utf-8')
LINES = TEXT.splitlines(keepends=True)
OFFSETS = [0]
for _line in LINES:
    OFFSETS.append(OFFSETS[-1] + len(_line))
NLINES = len(LINES)

# Bibliographic brackets only: [32], [32, 33], [32–37], [1,50,56,57], [1, 2 и др.].
# `[[1]](url)` footnote links and `[123I]` are not citations.
CITATION = re.compile(r'(?<!\[)\[(\s*\d+(?:[\s­]*[-–—,;][\s­]*\d+)*(?:\s+и др\.)?\s*)\](?!\()')
IMAGE = re.compile(r'!\[[^\]]*\]\(([^)]+)\)')
EVIDENCE_LINE = re.compile(r'^\*{0,2}\(?[Уу]ровень[^\n]+', re.M)
EVIDENCE_BLOCK = re.compile(r'^\*{0,2}\(?[Уу]ровень убедительност')
TABLE_CAPTION = re.compile(r'^\*\*Таблица\s+(\d+)\.')
LIST_ITEM = re.compile(r'^\s*(?:[-•]\s|\d+[.)]\s|\d+\s*[–-]\s)')
BOLD_ONLY = re.compile(r'^\*\*[^*].*\*\*\s*$')
RECOMMEND_WORD = re.compile(r'рекомендует|рекомендуют|рекомендован|рекомендуем', re.I)

# --- plan -----------------------------------------------------------------

EXPLICIT_LEVELS = {
    18: 4, 44: 4, 48: 4,
    67: 3, 166: 3, 265: 3, 285: 4, 436: 3, 1085: 3, 1634: 3, 1706: 3, 1712: 3, 1781: 3,
    1091: 4, 1159: 4, 1178: 4, 1271: 4, 1323: 4, 1341: 4, 1351: 4, 1355: 5, 1365: 5, 1373: 5,
    1381: 4, 1508: 4, 1528: 4, 1548: 4, 1570: 4, 1604: 4,
    1893: 4, 2067: 4, 2109: 4,
    2209: 5, 2211: 5, 2257: 5, 2291: 5, 2305: 5, 2351: 5, 2381: 5, 2385: 5, 2390: 5,
}
# Ancestors whose own introduction is a precondition for every descendant recommendation.
SHARED_CONTEXT_SECTIONS = [1087, 1351, 1504]
REGIONS = [
    {'from_line': 1, 'to_line_exclusive': 44, 'collection': 'supporting'},
    {'from_line': 44, 'to_line_exclusive': 1857, 'collection': 'clinical'},
    {'from_line': 1857, 'to_line_exclusive': 1891, 'collection': 'references'},
    {'from_line': 1891, 'to_line_exclusive': 2109, 'collection': 'supporting'},
    {'from_line': 2109, 'to_line_exclusive': 2125, 'collection': 'clinical'},
    {'from_line': 2125, 'to_line_exclusive': 2400, 'collection': 'appendices'},
    {'from_line': 2400, 'to_line_exclusive': NLINES + 2, 'collection': 'methods'},
]
# Embedded source footnotes (`---` + `[[1]](url) text`) at the end of a section body.
FOOTNOTE_TAILS = [{'section_start': 596, 'start_line': 612}, {'section_start': 1712, 'start_line': 1775}]
EXTRA_UNIT_MARKERS = [4001]  # RASS scale inside Г27 carries no «Приложение» label


def heading_title(line):
    return re.sub(r'\s+', ' ', re.sub(r'^[#\s]+', '', line).replace('**', '')).strip()


def derive_plan():
    found = []
    for n, line in enumerate(LINES, 1):
        s = line.rstrip('\n')
        level = None
        if n == 1:
            level = 1
        elif s.startswith('### '):
            level = 3
        elif s.startswith('## '):
            level = 2
        elif n in EXPLICIT_LEVELS:
            level = EXPLICIT_LEVELS[n]
        elif re.match(r'^\*\*Приложение Г1-ГN', s):
            level = 4
        elif re.match(r'^\*{0,2}Приложение Г\d+\.', s):
            level = 5
        elif re.match(r'^\*\*Приложение [АБВ]\d?\.', s):
            level = 4
        elif n < 2125 and re.match(r'^\*\*\d+\.\d+ ', s):
            level = 4
        elif n < 1855 and re.match(r'^\*\*\d+\. ', s):
            level = 4 if 281 <= n <= 433 else 3
        if level:
            found.append((n, level, heading_title(s)))
    counters, stack, sections = {}, [], []
    for n, level, title in found:
        while stack and stack[-1]['level'] >= level:
            stack.pop()
        parent = stack[-1] if stack else None
        key = parent['id'] if parent else None
        counters[key] = counters.get(key, 0) + 1
        sid = 'cr05' if parent is None else f"{parent['id']}.{counters[key]:02}"
        sec = {'id': sid, 'parent': key, 'level': level, 'title': title, 'kind': 'block', 'start_line': n}
        if n in SHARED_CONTEXT_SECTIONS:
            sec['context_for_descendants'] = True
        if parent:
            parent['kind'] = 'section'
        sections.append(sec)
        stack.append(sec)
    sections[0]['kind'] = 'document'
    return {'document_id': DOC, 'source': SOURCE_REL, 'source_sha256': SOURCE_SHA256, 'page_proxy_chars': PAGE,
            'regions': REGIONS, 'footnote_tails': FOOTNOTE_TAILS, 'extra_unit_markers': EXTRA_UNIT_MARKERS,
            'sections': sections}


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check', action='store_true', help='Validate source, relationships and generated artifacts without writing')
parser.add_argument('--write-plan', action='store_true', help='Regenerate annotation_plan.json from the heading rules')
ARGS = parser.parse_args()
OUT.mkdir(parents=True, exist_ok=True)
if ARGS.write_plan:
    (OUT / 'annotation_plan.json').write_text(json.dumps(derive_plan(), ensure_ascii=False, indent=2) + '\n')
PLAN = json.loads((OUT / 'annotation_plan.json').read_text())
assert PLAN['source_sha256'] == SOURCE_SHA256 and PLAN['page_proxy_chars'] == PAGE
SECTIONS = PLAN['sections']
BY_ID = {s['id']: s for s in SECTIONS}
BY_START = {s['start_line']: s for s in SECTIONS}
for _s in SECTIONS:
    assert heading_title(LINES[_s['start_line'] - 1]) == _s['title'], _s

# --- spans ------------------------------------------------------------------


def span(start, end):
    assert 0 <= start < end <= len(TEXT)
    return {'start': start, 'end': end,
            'start_line': bisect.bisect_right(OFFSETS, start),
            'end_line': bisect.bisect_right(OFFSETS, end - 1)}


def line_span(start, end):
    """Lines start..end-1 (one-based, end exclusive)."""
    return span(OFFSETS[start - 1], OFFSETS[end - 1] if end <= NLINES else len(TEXT))


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
    s['end_line_exclusive'] = next((n['start_line'] for n in SECTIONS[i + 1:] if n['level'] <= s['level']), NLINES + 1)
    s['own_end_line_exclusive'] = SECTIONS[i + 1]['start_line'] if i + 1 < len(SECTIONS) else NLINES + 1
    s['span'] = line_span(s['start_line'], s['end_line_exclusive'])
    s['own_span'] = line_span(s['start_line'], s['own_end_line_exclusive'])
    s['body_end_line_exclusive'] = s['own_end_line_exclusive']
    for t in PLAN['footnote_tails']:
        if t['section_start'] == s['start_line']:
            s['body_end_line_exclusive'] = t['start_line']
assert SECTIONS[0]['start_line'] == 1


def collection_for(line):
    for r in PLAN['regions']:
        if r['from_line'] <= line < r['to_line_exclusive']:
            return r['collection']
    raise AssertionError(line)


# --- blocks -------------------------------------------------------------------


def parse_blocks(a, b):
    """Blank-line separated blocks of lines a..b-1; a table caption is merged with its table."""
    blocks = []
    cur = None
    for n in range(a, b):
        if not LINES[n - 1].strip():
            cur = None
        elif cur is None:
            cur = {'start': n, 'end': n}
            blocks.append(cur)
        else:
            cur['end'] = n
    for bl in blocks:
        bl['first'] = LINES[bl['start'] - 1].strip()
        bl['text'] = ''.join(LINES[bl['start'] - 1:bl['end']])
    merged = []
    for bl in blocks:
        prev = merged[-1] if merged else None
        if prev and prev['start'] == prev['end'] and TABLE_CAPTION.match(prev['first']) and bl['first'].startswith('|'):
            prev['end'] = bl['end']
            prev['text'] = ''.join(LINES[prev['start'] - 1:prev['end']])
            continue
        merged.append(bl)
    for bl in merged:
        first = bl['first']
        single = bl['start'] == bl['end']
        bl['table'] = first.startswith('|') or bool(TABLE_CAPTION.match(first) and not single)
        bl['marker'] = single and bool(BOLD_ONLY.match(first)) and not TABLE_CAPTION.match(first)
        bl['heading'] = first.startswith('#') or (bl['marker'] and not first.rstrip('*').endswith(':'))
        bl['lead_in'] = single and not bl['heading'] and (
            first.rstrip('*').endswith(':') and len(first) < 260
            or (first.startswith('*') and first.endswith('*') and len(first) < 120 and not first.startswith('**')))
        bl['list'] = bool(LIST_ITEM.match(bl['text'])) and not bl['table']
        bl['bullet'] = bool(re.match(r'^-\s', first))
        bl['evidence'] = bool(EVIDENCE_BLOCK.match(first)) and single
        bl['nonterminal'] = bl['evidence'] and first.rstrip().endswith((';**', ');**', ';'))
        bl['comment'] = (first.startswith('**Коммент') or first.startswith('***')
                         or (first.startswith('*') and not first.startswith('**'))) and not bl['table']
        bl['size'] = len(bl['text'].strip())
    return merged


def meaningful(s):
    """A span consisting solely of headings belongs to the navigation layer."""
    return any(not bl['heading'] for bl in parse_blocks(s['start_line'], s['end_line'] + 1))


def rec_groups(blocks):
    """Index ranges (inclusive) of recommendation statements: bullets, evidence, comments."""
    groups = []
    for e, bl in enumerate(blocks):
        if not bl['evidence'] or bl['nonterminal']:
            continue
        s, j = e, e - 1
        floor = groups[-1][1] if groups else -1
        while j > floor and (blocks[j]['bullet'] or blocks[j]['evidence']):
            if blocks[j]['evidence'] and not blocks[j]['nonterminal']:
                break
            s, j = j, j - 1
        t = e + 1
        while t < len(blocks) and blocks[t]['comment']:
            t += 1
        groups.append((s, t - 1))
    return groups


def atomic_groups(blocks):
    """Glue headings/lead-ins to what follows and keep list items together."""
    groups = []
    pending = []
    for bl in blocks:
        if bl['heading'] or bl['lead_in']:
            pending.append(bl)
            continue
        if bl['list'] and not pending and groups and groups[-1][-1]['list']:
            groups[-1].append(bl)
        else:
            groups.append(pending + [bl])
        pending = []
    if pending:
        if groups:
            groups[-1].extend(pending)
        else:
            groups.append(pending)
    return groups


def pack(groups):
    """Page packing that never splits an atomic group; sizes are balanced across pages."""
    total = sum(sum(b['size'] for b in g) for g in groups)
    pages = max(1, -(-total // PAGE))
    target = total / pages
    out, cur, cur_size = [], [], 0
    for g in groups:
        size = sum(b['size'] for b in g)
        if cur and (cur_size + size > PAGE or (cur_size >= target and len(out) + 1 < pages)):
            out.append(cur)
            cur, cur_size = [], 0
        cur.extend(g)
        cur_size += size
    if cur:
        out.append(cur)
    return out


# --- records ------------------------------------------------------------------


def metadata(s):
    raw = slice_text(s)
    citation_spans, numbers = [], set()
    for m in CITATION.finditer(raw):
        ns = set()
        for item in re.split(r'[,;]', m[1]):
            bounds = [int(n) for n in re.findall(r'\d+', item)]
            assert 1 <= len(bounds) <= 2, m[0]
            ns.update(range(bounds[0], bounds[-1] + 1))
        numbers.update(ns)
        citation_spans.append({'raw': m[0], 'numbers': sorted(ns), 'unspecified_others': 'и др.' in m[0],
                               'span': span(s['start'] + m.start(), s['start'] + m.end())})
    only_image = IMAGE.search(raw) and not re.sub(
        r'[#*\s|\-]', '', IMAGE.sub('', re.sub(r'^\*\*[^\n]+\*\*\s*$', '', raw, flags=re.M)))
    return {
        'citation_numbers': sorted(numbers),
        'reference_ids': [REF_BY_NUMBER[n] for n in sorted(numbers) if n in REF_BY_NUMBER],
        'unresolved_citation_numbers': sorted(numbers - REF_BY_NUMBER.keys()),
        'citation_spans': citation_spans,
        'evidence_statements': [{'raw': m[0], 'span': span(s['start'] + m.start(), s['start'] + m.end())}
                                for m in EVIDENCE_LINE.finditer(raw)],
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


# bibliography: item 1 is nested inside a wrapper list item (`1. Клинические рекомендации ...`)
REFERENCES = []
for number in range(1, 31):
    pattern = rf'^\s{{6}}{number}\. ' if number > 1 else r'^\s{3}1\. 1\. '
    matches = list(re.finditer(pattern + r'[^\n]+', TEXT, re.M))
    assert len(matches) == 1, (number, matches)
    m = matches[0]
    body_start = m.end() - len(m[0]) + re.match(pattern, m[0]).end()
    REFERENCES.append({'id': f'{DOC}.ref.{number:03}', 'number': number,
                       'text': TEXT[body_start:m.end()], 'span': span(m.start(), m.end())})
REF_BY_NUMBER = {r['number']: r['id'] for r in REFERENCES}

PARENTS, CHUNKS, SUPPORTING, APPENDICES = [], [], [], []
METHOD_PARENTS, METHOD_CHUNKS, OWNERSHIP = [], [], []
PROBLEMS = {'bullets_without_evidence': [], 'evidence_without_bullet': [], 'tiny_chunks': []}


def own(s, category, record_ids):
    OWNERSHIP.append({'span': s, 'collection': category, 'record_ids': record_ids})


def context_spans(section):
    """Own text of ancestors that declare themselves a precondition for all descendants."""
    result = []
    while section['parent']:
        section = BY_ID[section['parent']]
        if section.get('context_for_descendants') and meaningful(section['own_span']):
            result.append(section['own_span'])
    return list(reversed(result))


def section_units(section):
    """[(kind, [blocks])] and the first line of the first chunk for a clinical/appendix section body."""
    a, b = section['start_line'], section['body_end_line_exclusive']
    blocks = parse_blocks(a, b)
    lead = 0
    while lead < len(blocks) and blocks[lead]['heading']:
        lead += 1
    body = blocks[lead:]
    if not body:
        return [], None
    groups = rec_groups(body)
    in_group = {}
    for gi, (s, e) in enumerate(groups):
        for k in range(s, e + 1):
            in_group[k] = gi
    for s, e in groups:
        if not body[s]['bullet']:
            PROBLEMS['evidence_without_bullet'].append(body[s]['start'])
    for k, bl in enumerate(body):
        if bl['bullet'] and k not in in_group and RECOMMEND_WORD.search(bl['text']) and collection_for(a) == 'clinical':
            PROBLEMS['bullets_without_evidence'].append(bl['start'])
    units, k = [], 0
    while k < len(body):
        if k in in_group:
            s, e = groups[in_group[k]]
            units.append(('recommendation', [body[x] for x in range(s, e + 1)]))
            k = e + 1
        elif body[k]['table']:
            units.append(('table', [body[k]]))
            k += 1
        else:
            run = []
            while k < len(body) and k not in in_group and not body[k]['table']:
                run.append(body[k])
                k += 1
            for page in pack(atomic_groups(run)):
                units.append(('narrative', page))
    # tiny narrative/table neighbours are merged into the previous non-recommendation unit (or the next one)
    merged = []
    for kind, bls in units:
        size = sum(x['size'] for x in bls)
        if merged and kind != 'recommendation' and size < TINY and merged[-1][0] != 'recommendation':
            merged[-1] = (merged[-1][0], merged[-1][1] + bls)
        else:
            merged.append((kind, bls))
    if len(merged) > 1 and merged[0][0] != 'recommendation' and sum(x['size'] for x in merged[0][1]) < TINY \
            and merged[1][0] != 'recommendation':
        merged[1] = (merged[1][0], merged[0][1] + merged[1][1])
        merged = merged[1:]
    first_line = a if merged[0][0] != 'recommendation' else merged[0][1][0]['start']
    return merged, first_line


METHOD_RE = re.compile(r'^Приложение Г(\d+)\.')


def method_units(section):
    a, b = section['start_line'], section['body_end_line_exclusive']
    blocks = parse_blocks(a, b)
    markers = [bl['start'] for bl in blocks[1:] if bl['marker']] + [n for n in PLAN['extra_unit_markers'] if a < n < b]
    starts = sorted(set([a] + markers))
    units = []
    for i, st in enumerate(starts):
        en = starts[i + 1] if i + 1 < len(starts) else b
        bls = [bl for bl in blocks if st <= bl['start'] < en]
        size = sum(x['size'] for x in bls)
        pages = [bls] if size <= PAGE else pack(atomic_groups(bls))
        for page in pages:
            units.append(('method_component', page, st))
    return units


def method_part_kind(line):
    text = LINES[line - 1]
    return 'interpretation' if re.search(r'Интерпретац', text) else 'template' if re.search(r'Шаблон|Вариант|ACE-R', text) else 'other'


def process_sections():
    for section in SECTIONS:
        a, b = section['start_line'], section['own_end_line_exclusive']
        category = collection_for(a)
        if section['body_end_line_exclusive'] < b:  # embedded footnote at the end of the body
            fn = line_span(section['body_end_line_exclusive'], b)
            rec = source_record(f"{DOC}.support.{section['body_end_line_exclusive']}", 'Сноска источника', fn, section)
            rec['index_in_clinical_search'] = False
            rec['kind'] = 'source_footnote'
            SUPPORTING.append(rec)
            own(fn, 'supporting', [rec['id']])
        body = line_span(a, section['body_end_line_exclusive'])
        if category == 'references':
            own(body, 'references', ['references.source_section'])
            continue
        if category == 'supporting':
            rec = source_record(f'{DOC}.support.{a}', section['title'], body, section)
            rec['index_in_clinical_search'] = False
            SUPPORTING.append(rec)
            own(body, 'supporting', [rec['id']])
            continue
        is_method = category == 'methods' and bool(METHOD_RE.match(section['title']))
        if is_method:
            units = method_units(section)
            first_line = a
        elif category == 'methods':  # «Приложение Г1-ГN» heading only
            own(body, 'structure', [section['id']])
            continue
        else:
            units3, first_line = section_units(section)
            units = [(k, bls, None) for k, bls in units3]
            if not units:
                own(body, 'structure', [section['id']])
                continue
        parent_id = f'{DOC}.parent.{a}'
        parent = source_record(parent_id, section['title'], body, section)
        parent['index_in_vector_search'] = False
        parent['section_subtree_span'] = section['span']
        parent['child_ids'] = []
        parent['ancestor_context_spans'] = context_spans(section)
        label = None
        if category == 'appendices' or is_method:
            sec = section
            while sec and not re.match(r'^Приложение [АБВГ]\d*\.', sec['title']):
                sec = BY_ID[sec['parent']] if sec['parent'] else None
            label = re.sub(r'\s+', '', re.match(r'^Приложение ([АБВГ]\s*\d*)', sec['title'])[1]) if sec else None
        if is_method:
            n = int(METHOD_RE.match(section['title'])[1])
            parent['id'] = parent_id = f'{DOC}.method.g{n:02}'
            parent['original_appendix_label'] = label
            parent['method_key'] = f'g{n:02}'
            METHOD_PARENTS.append(parent)
        elif category == 'appendices':
            parent['original_appendix_label'] = label
            APPENDICES.append(parent)
        else:
            PARENTS.append(parent)
        bounds = [first_line if idx == 0 else bls[0]['start'] for idx, (_, bls, _) in enumerate(units)]
        if bounds[0] > a:
            own(line_span(a, bounds[0]), 'structure', [section['id']])
        group = []
        for idx, (kind, bls, _) in enumerate(units):
            st = bounds[idx]
            en = bounds[idx + 1] if idx + 1 < len(bounds) else section['body_end_line_exclusive']
            s = line_span(st, en)
            chunk_id = f'{DOC}.chunk.{st:04}'
            title_src = next(x for x in LINES[st - 1:en - 1] if x.strip())
            if kind == 'table' and not TABLE_CAPTION.match(title_src.strip()):
                title_src = LINES[bls[0]['start'] - 1]
            rec = source_record(chunk_id, short_title(title_src), s, section)
            rec['kind'] = kind
            rec['collection'] = category
            rec['index_in_vector_search'] = True
            rec['parent_id'] = parent_id
            if len(rec['source_text'].strip()) < TINY:
                PROBLEMS['tiny_chunks'].append(chunk_id)
            parent['child_ids'].append(chunk_id)
            group.append(rec)
            own(s, category, [chunk_id])
        has_rec = any(g['kind'] == 'recommendation' for g in group)
        for idx, rec in enumerate(group):
            if is_method:
                rec['kind'] = 'method_component'
            elif rec['kind'] == 'narrative':
                rec['kind'] = 'section_introduction' if idx == 0 and has_rec else \
                    'semantic_block' if len(group) == 1 else 'narrative_topic'
            if category == 'appendices' and rec['kind'] in ('semantic_block', 'narrative_topic', 'section_introduction'):
                rec['kind'] = 'appendix_block'
            if section['title'].startswith('Критерии оценки качества') and rec['kind'] == 'table':
                rec['kind'] = 'quality_criteria'
        ctx = context_spans(section)
        if is_method:
            parent['required_context_spans'] = [group[0]['span']]
            part_kinds = [method_part_kind(bounds[i]) for i in range(len(group))]
        full = len(slice_text(body).strip())
        for i, rec in enumerate(group):
            if len(group) == 1 and category == 'clinical' and not ctx:
                mode, reason = 'self', 'Единый смысловой блок с полными условиями; достаточно пути заголовков и паспорта документа.'
            elif full <= PAGE:
                mode, reason = 'parent', 'Условия и пояснения объединяют пункты; полный смысловой родитель не превышает условную страницу.'
            else:
                mode, reason = 'window', 'Полный родитель больше условной страницы; вернуть чанк и ближайших соседей того же родителя с общими условиями.'
            always = list(ctx)
            if is_method and i > 0:
                always += parent['required_context_spans']
            rec['retrieval'] = {
                'mode': mode, 'reason': reason,
                'context_parent_id': parent_id if mode != 'self' else None,
                'previous_chunk_id': group[i - 1]['id'] if i else None,
                'next_chunk_id': group[i + 1]['id'] if i + 1 < len(group) else None,
                'required_chunk_ids': [], 'always_include_spans': always,
                'neighbor_limit_each_side': 1 if mode == 'window' else 0,
                'atomic_oversize': len(rec['source_text'].strip()) > PAGE}
            if rec['kind'] in ('recommendation', 'table') and group[0]['kind'] == 'section_introduction' and i > 0:
                rec['retrieval']['required_chunk_ids'].append(group[0]['id'])
            if rec['kind'] == 'table' and i > 0 and group[i - 1]['kind'] == 'recommendation':
                rec['retrieval']['required_chunk_ids'].append(group[i - 1]['id'])
            if is_method and part_kinds[i] == 'template':
                rec['retrieval']['required_chunk_ids'] += [
                    group[j]['id'] for j in range(len(group)) if part_kinds[j] == 'interpretation'
                    and len(group[j]['source_text'].strip()) <= 1500]
            if rec['retrieval']['atomic_oversize']:
                rec['retrieval']['reason'] += ' Превышение размера сохранено намеренно: нельзя отрывать варианты рекомендации, комментарий с дозами, таблицу или пункты инструмента.'
        if is_method:
            METHOD_CHUNKS.extend(group)
        elif category == 'appendices':
            parent['chunks'] = group
        else:
            CHUNKS.extend(group)


process_sections()
ALL_CHUNKS = CHUNKS + METHOD_CHUNKS + [c for p in APPENDICES for c in p['chunks']]
CHUNK_MAP = {c['id']: c for c in ALL_CHUNKS}

# --- cross references -----------------------------------------------------------

METHOD_NAMES = {
    'g01': r'MMSE|Краткая шкала оценки психического статуса|КШОПС', 'g02': r'МоСА|MoCA|Монреальск',
    'g03': r'ACE-R|Адденбрук', 'g04': r'Мини-Ког|Mini-Cog', 'g05': r'лобной дисфункции|БТЛД|\bFAB\b',
    'g06': r'рисования часов', 'g07': r'FCSRT|свободного и ассоциированного', 'g08': r'[Тт]ест (?:5|пяти) \(?(?:12\) )?слов',
    'g09': r'вербальных ассоциаций', 'g10': r'символьно-цифров', 'g11': r'Бостонск', 'g12': r'Шульте',
    'g13': r'[Тт]ест слежения', 'g14': r'[Пп]овторение цифр', 'g15': r'3-КТ', 'g16': r'[Рр]ейтинговая шкала деменции|\bCDR\b',
    'g17': r'общего ухудшения', 'g18': r'Лоутон', 'g19': r'Бартел', 'g20': r'IQCODE', 'g21': r'функциональн\w+ (?:активност|статус)\w*|каждодневной активности|FAQ',
    'g22': r'\bAD8\b', 'g23': r'Нейропсихиатрический опросник', 'g24': r'Гериатрическ\w+ шкал\w+ депресс',
    'g25': r'Гамильтон', 'g26': r'HADS|Госпитальная шкала', 'g27': r'спутанности сознания|\bCAM\b', 'g28': r'Шелтенс',
    'g29': r'распознавания эмоций', 'g30': r'антихолинергической нагрузки', 'g31': r'Аризонск', 'g32': r'Макнера',
    'g33': r'Фазекас',
}
TARGETS = METHOD_PARENTS + APPENDICES
GROUP_LABELS = {label for label, n in Counter(t['original_appendix_label'] for t in APPENDICES).items() if n > 1}


def named_methods(nearby):
    return [f'{DOC}.method.{k}' for k, pat in METHOD_NAMES.items() if re.search(pat, nearby)]


def appendix_links(s):
    raw = slice_text(s)
    result = []
    pattern = r'[Пп]риложени[еяиюях]+\s+([АБВГ]\s*\.?\s*\d*(?:\s*,\s*[АБВГ]\s*\d+)*)'
    prev_end = 0
    for m in re.finditer(pattern, raw):
        # the method is named right before its «Приложение Г…» reference, not in the neighbouring one
        window = raw[max(prev_end, m.start() - 90):m.end()]
        prev_end = m.end()
        for label_match in re.finditer(r'[АБВГ]\s*\.?\s*\d*', m[1]):
            label = re.sub(r'[\s.]', '', label_match[0])
            candidates = [t['id'] for t in TARGETS if t['original_appendix_label'] == label]
            named = named_methods(window)
            status = 'resolved_group' if len(candidates) > 1 and label in GROUP_LABELS else \
                'resolved' if len(candidates) == 1 else 'ambiguous' if candidates else 'missing'
            if named and candidates and label.startswith('Г') and not set(named).intersection(candidates):
                status = 'label_name_conflict'
            resolved = candidates if status in ('resolved', 'resolved_group') else []
            result.append({'raw': m[0], 'label': label, 'status': status,
                           'declared_target_ids': candidates, 'named_method_candidate_ids': named,
                           'resolved_target_ids': sorted(resolved),
                           'review_note': 'Подпись приложения и названная рядом методика не совпадают; ссылка не исправлена.' if status == 'label_name_conflict' else None,
                           'span': span(s['start'] + m.start(), s['start'] + m.end())})
    # «Приложение 11»: the Cyrillic letter is missing in the source; never repaired.
    for m in re.finditer(r'[Пп]риложени[еяиюях]+\s+(\d+)\b', raw):
        result.append({'raw': m[0], 'label': m[1], 'status': 'label_without_letter',
                       'declared_target_ids': [],
                       'named_method_candidate_ids': named_methods(raw[max(0, m.start() - 120):m.end() + 20]),
                       'resolved_target_ids': [],
                       'review_note': 'В источнике у номера приложения нет буквы; кандидат определён только по названию и не подставлен.',
                       'span': span(s['start'] + m.start(), s['start'] + m.end())})
    return sorted(result, key=lambda r: r['span']['start'])


# Table numbering restarts in appendices А2/А3, so references are resolved by region.
TABLES = []
for c in ALL_CHUNKS:
    for m in re.finditer(r'^\*\*Таблица\s+(\d+)\.', c['source_text'], re.M):
        TABLES.append({'number': int(m[1]), 'region': 'main' if c['span']['start_line'] < 1855 else 'appendix',
                       'chunk_id': c['id']})
TABLE_REF = re.compile(r'(?:табл\.|[Тт]аблиц[аеуы]|таблицах)\s*(\d+)')
TABLE_ISSUES = []


def table_links(rec):
    region = 'main' if rec['span']['start_line'] < 1855 else 'appendix'
    raw = rec['source_text']
    links = []
    for m in TABLE_REF.finditer(raw):
        if raw[max(0, m.start() - 2):m.start()] == '**':
            continue  # the caption of the table itself
        number = int(m[1])
        targets = [t['chunk_id'] for t in TABLES if t['number'] == number and t['region'] == region]
        links.append({'raw': m[0], 'number': number, 'region': region, 'target_chunk_ids': targets,
                      'span': span(rec['span']['start'] + m.start(), rec['span']['start'] + m.end())})
    return links


code_targets = {}
for c in CHUNKS:
    if 'Кодирование когнитивных расстройств по МКБ-10' in c['source_text'][:300]:
        for code in re.findall(r'\b[FGI]\d{2}(?:\.\d+)?', c['source_text']):
            code_targets[code] = c['id']
ALL_RECORDS = ALL_CHUNKS + PARENTS + METHOD_PARENTS + APPENDICES + SUPPORTING
for rec in ALL_RECORDS:
    rec['metadata']['appendix_links'] = appendix_links(rec['span'])
    rec['metadata']['named_method_ids'] = [f'{DOC}.method.{k}' for k, pat in METHOD_NAMES.items() if re.search(pat, rec['source_text'])]
    rec['metadata']['table_links'] = table_links(rec)
    if rec in ALL_CHUNKS:
        codes = set(re.findall(r'\b[FGI]\d{2}(?:\.\d+)?', rec['source_text']))
        rec['metadata']['related_classification_chunk_ids'] = sorted({code_targets[x] for x in codes if x in code_targets} - {rec['id']})
        if rec['span']['start_line'] < 1855:
            for link in rec['metadata']['table_links']:
                for t in link['target_chunk_ids']:
                    if t != rec['id'] and t not in rec['retrieval']['required_chunk_ids']:
                        rec['retrieval']['required_chunk_ids'].append(t)
        if rec['retrieval']['required_chunk_ids'] and rec['retrieval']['mode'] == 'self':
            rec['retrieval'].update(mode='parent', context_parent_id=rec['parent_id'],
                                    reason='К собственному полному блоку нужно приложить явно связанные таблицы или общие условия.')
        for link in rec['metadata']['table_links']:
            if not link['target_chunk_ids']:
                TABLE_ISSUES.append({'chunk_id': rec['id'], **{k: link[k] for k in ('raw', 'number', 'region', 'span')}})

# --- validation -------------------------------------------------------------------


def validate():
    assert not re.search(r'<!-- clinrec ', TEXT)
    ids = {r['id'] for r in ALL_RECORDS}
    dup = [k for k, v in Counter(r["id"] for r in ALL_RECORDS).items() if v > 1]
    assert not dup, dup
    parent_map = {p['id']: p for p in PARENTS + METHOD_PARENTS + APPENDICES}
    for rec in ALL_RECORDS:
        assert rec['source_text'] == slice_text(rec['span'])
        assert rec['text'] == CITATION.sub('', rec['source_text'])
        assert not CITATION.search(rec['text']), rec['id']
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
        assert c['id'] not in c['retrieval']['required_chunk_ids']
        for s in c['retrieval']['always_include_spans']:
            assert slice_text(s).strip()
    coverage = sorted(OWNERSHIP, key=lambda r: r['span']['start'])
    assert coverage[0]['span']['start'] == 0
    assert coverage[-1]['span']['end'] == len(TEXT)
    for a, b in zip(coverage, coverage[1:]):
        assert a['span']['end'] == b['span']['start'], (a, b)
    # No chunk boundary inside a physical Markdown table.
    for c in ALL_CHUNKS:
        line = c['span']['start_line']
        previous = LINES[line - 2] if line > 1 else ''
        assert not (previous.startswith('|') and LINES[line - 1].startswith('|')), c['id']
    # Every evidence line of the main text belongs to exactly one recommendation chunk.
    for n, line in enumerate(LINES, 1):
        if EVIDENCE_BLOCK.match(line.strip()) and n < 1855:
            owners = [c for c in CHUNKS if c['span']['start'] <= OFFSETS[n - 1] < c['span']['end']]
            assert len(owners) == 1 and owners[0]['kind'] == 'recommendation', n
    for c in CHUNKS:
        if c['kind'] == 'recommendation':
            assert c['metadata']['evidence_statements'], c['id']
    assert len(METHOD_PARENTS) == 33 and len(REFERENCES) == 30
    return coverage


COVERAGE = validate()
CITED = sorted({n for r in ALL_RECORDS for n in r['metadata']['citation_numbers']})
MISSING = sorted({n for r in ALL_RECORDS for n in r['metadata']['unresolved_citation_numbers']})
LINK_ISSUES = [dict(chunk_id=c['id'], **r) for c in ALL_CHUNKS for r in c['metadata']['appendix_links']
               if r['status'] in ('ambiguous', 'missing', 'label_name_conflict', 'label_without_letter')]
CANON_EVIDENCE = re.compile(r'^\*\*Уровень убедительности рекомендаций\s*–\s*[ABCАВС]\s*\(уровень достоверности доказательств\s*–\s*[1-5]\)\.?\*\*$')
NONCANON_EVIDENCE = [{'line': n, 'raw': line.strip()} for n, line in enumerate(LINES, 1)
                     if EVIDENCE_BLOCK.match(line.strip()) and n < 1855 and not CANON_EVIDENCE.match(line.strip())]
CAPTIONS = []
for n, line in enumerate(LINES, 1):
    m = TABLE_CAPTION.match(line)
    if m:
        CAPTIONS.append({'line': n, 'number': int(m[1]),
                         'section': 'А2' if 2166 <= n < 2207 else 'А3' if 2207 <= n < 2379 else 'основной текст'})
DUPS = {k: sorted(c['line'] for c in CAPTIONS if c['number'] == k) for k in {c['number'] for c in CAPTIONS}
        if sum(1 for c in CAPTIONS if c['number'] == k) > 1}
MAIN_TABLES = sorted(c['number'] for c in CAPTIONS if c['section'] == 'основной текст')
MAIN_TABLES_MISSING = sorted(set(range(1, max(MAIN_TABLES) + 1)) - set(MAIN_TABLES))
NONNUMERIC_BRACKETS = [{'line': n, 'raw': m[0]} for n, line in enumerate(LINES, 1)
                       for m in re.finditer(r'\[(?:Derby \d+|указать на \(1\)|точка \(Д\))\]', line)]
FOOTNOTES = [r for r in SUPPORTING if r.get('kind') == 'source_footnote']
UNRECOGNISED = sorted(set(PROBLEMS['bullets_without_evidence']))

FILES = {
    'chunks.json': {'schema_version': '1.0', 'document_id': DOC, 'chunks': CHUNKS},
    'parents.json': {'schema_version': '1.0', 'document_id': DOC, 'parents': PARENTS},
    'methods.json': {'schema_version': '1.0', 'document_id': DOC, 'parents': METHOD_PARENTS, 'chunks': METHOD_CHUNKS},
    'appendices.json': {'schema_version': '1.0', 'document_id': DOC, 'appendices': APPENDICES},
    'supporting.json': {'schema_version': '1.0', 'document_id': DOC, 'records': SUPPORTING},
    'references.json': {'schema_version': '1.0', 'document_id': DOC,
                        'source_span': BY_START[1857]['span'], 'source_text': slice_text(BY_START[1857]['span']),
                        'items': REFERENCES, 'unresolved_citation_numbers': MISSING,
                        'completeness': 'provided_bibliography_only_numbers_1_to_30'},
    'sections.json': {'schema_version': '1.0', 'document_id': DOC, 'sections': SECTIONS},
    'coverage.json': {'schema_version': '1.0', 'document_id': DOC, 'partition': COVERAGE},
}
ASSETS = []
for m in IMAGE.finditer(TEXT):
    ASSETS.append({'id': f'{DOC}.image.{len(ASSETS) + 1:03}', 'url': m[1],
                   'span': span(m.start(), m.end()), 'content_status': 'external_not_downloaded_or_ocr_processed',
                   'referring_chunk_ids': [c['id'] for c in ALL_CHUNKS if c['span']['start'] <= m.start() < c['span']['end']]})
FILES['assets.json'] = {'schema_version': '1.0', 'document_id': DOC, 'assets': ASSETS}

COUNTS = {'clinical_chunks': len(CHUNKS), 'clinical_parents': len(PARENTS),
          'methods': len(METHOD_PARENTS), 'method_chunks': len(METHOD_CHUNKS),
          'appendices': len(APPENDICES), 'appendix_chunks': sum(len(a['chunks']) for a in APPENDICES),
          'all_search_chunks': len(ALL_CHUNKS),
          'retrieval_modes': dict(sorted(Counter(c['retrieval']['mode'] for c in ALL_CHUNKS).items())),
          'oversized_atomic_chunks': sum(c['retrieval']['atomic_oversize'] for c in ALL_CHUNKS),
          'recommendation_chunks': sum(c['kind'] == 'recommendation' for c in CHUNKS),
          'supporting_records': len(SUPPORTING), 'images': len(ASSETS)}
MANIFEST = {
    'schema_version': '1.0', 'document_id': DOC,
    'title': 'Когнитивные расстройства у лиц пожилого и старческого возраста', 'clinical_year': 2024,
    'guideline_id': '617', 'population': 'Взрослые', 'language': 'ru',
    'source_file': SOURCE_REL, 'source_sha256': SOURCE_SHA256,
    'source_url': re.search(r'\*\*Источник:\*\* \[[^\]]+\]\(([^)]+)\)', TEXT)[1],
    'downloaded_date_as_stated': '2026-10-17',
    'span_convention': 'Unicode code points, zero-based start inclusive/end exclusive; lines one-based inclusive',
    'page_proxy_chars': PAGE, 'page_proxy_is_pdf_page': False,
    'embedding_input': 'manifest.title + heading_path + chunk.text; index chunks only, never duplicate parents',
    'vector_collections': ['chunks.json:chunks', 'methods.json:chunks', 'appendices.json:appendices[].chunks'],
    'context_resolution': ['mode-specific payload', 'always_include_spans', 'required_chunk_ids',
                           'heading_path and manifest provenance', 'explicit links on demand'],
    'counts': COUNTS,
    'source_issues': {
        'missing_reference_numbers': MISSING,
        'bibliography': f'Источник содержит только 30 пронумерованных работ (номера 1-30), а в тексте использованы {len(CITED)} '
                        f'различных номеров до {max(CITED)}; пункт 1 вложен в обёртку '
                        '«1. Клинические рекомендации Российской ассоциации геронтологов и гериатров».',
        'appendix_link_issues': LINK_ISSUES,
        'table_reference_issues': TABLE_ISSUES,
        'duplicate_table_numbers': {str(k): v for k, v in sorted(DUPS.items())},
        'main_text_table_numbers': MAIN_TABLES,
        'main_text_table_numbers_absent': MAIN_TABLES_MISSING,
        'non_canonical_evidence_lines': NONCANON_EVIDENCE,
        'non_numeric_bracket_markers': NONNUMERIC_BRACKETS,
        'embedded_footnotes': [{'id': r['id'], 'span': r['span'], 'source_text': r['source_text'].strip()} for r in FOOTNOTES],
        'malformed_appendix_headings': [
            {'line': 3982, 'note': 'Приложение Г27: закрывающие ** стоят после скобки в «(делирия**)»'},
            {'line': 4093, 'note': 'Приложение Г31 записано без выделения жирным'},
            {'line': 4001, 'note': 'Ричмондская шкала RASS внутри Г27 не имеет метки «Приложение»'}],
        'unrecognised_recommendation_bullets': UNRECOGNISED,
        'external_images_not_ocr_processed': True},
    'validation': {'source_hash': 'passed', 'exact_character_coverage': 'passed',
                   'span_round_trip': 'passed', 'relationships': 'passed',
                   'recommendation_ownership': 'passed', 'tables_intact': 'passed'},
}
FILES['manifest.json'] = MANIFEST


def review():
    lines = ['# Решения по чанкам: когнитивные расстройства у пожилых, 2024', '',
             'Каждая строка — поисковый чанк; полный контекст хранится по `parent_id`. '
             'Решение и его причина также записаны в JSON. Номера строк относятся к исходному Markdown.', '',
             '| Чанк / строки | Тип | Выдача | Символов | Содержание |', '| --- | --- | --- | ---: | --- |']
    for c in sorted(ALL_CHUNKS, key=lambda c: c['span']['start']):
        s = c['span']
        lines.append(f'| {c["id"]} / {s["start_line"]}–{s["end_line"]} | {c["kind"]} | {c["retrieval"]["mode"]} | '
                     f'{len(c["source_text"].strip())}{" *" if c["retrieval"]["atomic_oversize"] else ""} | '
                     f'{c["title"].replace("|", "/")} |')
    lines += ['', '`*` — атомарный блок больше 3500 символов: рекомендация с комментарием и дозами, таблица, '
              'опросник или список критериев сохранены целиком.', '',
              '## Проблемы источника', '',
              f'- В списке литературы 30 работ; в тексте использованы {len(CITED)} различных номеров до {max(CITED)}, '
              f'в списке отсутствуют {len(MISSING)} (`references.json:unresolved_citation_numbers`). '
              'Список не дополнялся и не перенумеровывался.',
              '- Нумерация таблиц повторяется: ' + ', '.join(f'№{k} (строки {v})' for k, v in sorted(DUPS.items())) + '. '
              f'В основном тексте есть таблицы №{", ".join(map(str, MAIN_TABLES))}; нет №{", ".join(map(str, MAIN_TABLES_MISSING))}.']
    for issue in TABLE_ISSUES:
        lines.append(f'- {issue["chunk_id"]}, строка {issue["span"]["start_line"]}: ссылка `{issue["raw"]}` '
                     f'({issue["region"]}) не имеет таблицы с таким номером в том же разделе.')
    for issue in LINK_ISSUES:
        lines.append(f'- {issue["chunk_id"]}, строка {issue["span"]["start_line"]}: '
                     f'`{issue["raw"]}` → {issue["label"]}, **{issue["status"]}**.')
    lines.append('- Встроенные сноски источника вынесены в `supporting.json`: ' +
                 '; '.join(f'строки {r["span"]["start_line"]}–{r["span"]["end_line"]}' for r in FOOTNOTES) + '.')
    lines.append(f'- Строк УУР/УДД в нетипичной записи: {len(NONCANON_EVIDENCE)}; сохранены как в источнике:')
    for e in NONCANON_EVIDENCE:
        lines.append(f'  - строка {e["line"]}: `{e["raw"]}`')
    lines.append(f'- Пунктов со словом «рекомендуется», у которых нет строки УУР/УДД: {len(UNRECOGNISED)} (строки {UNRECOGNISED}).')
    return '\n'.join(lines) + '\n'


def readme():
    m = COUNTS
    return f'''# Когнитивные расстройства у лиц пожилого и старческого возраста, 2024: данные для parent–child RAG

Источник: `{SOURCE_REL}` (SHA-256 `{SOURCE_SHA256[:12]}…`). Документ не изменялся; разделы, чанки
и решения по выдаче контекста хранятся в JSON рядом с этим описанием. Идентификаторы начинаются с
`{DOC}.`, формат файлов и ключей совпадает с набором БАР (`rag/01_bipolar`), поэтому документы
можно загружать одним кодом.

В основном тексте {m['clinical_chunks']} поисковых чанков ({m['recommendation_chunks']} из них — рекомендации с УУР/УДД) и
{m['clinical_parents']} родителей. Отдельно: {m['methods']} методик (приложения Г1–Г33, {m['method_chunks']} чанков),
{m['appendices']} записей приложений А–В ({m['appendix_chunks']} чанков). Всего в трёх поисковых коллекциях
{m['all_search_chunks']} чанков; режимы выдачи: {', '.join(f'{k} — {v}' for k, v in m['retrieval_modes'].items())}.

## Файлы

| Файл | Назначение | Векторный индекс |
| --- | --- | --- |
| [chunks.json](chunks.json) | Клинический текст: определение, классификация, патогенез, клиника, диагностика, лечение, реабилитация, организация помощи, профилактика, критерии качества | `chunks[]` |
| [parents.json](parents.json) | Полный текст смысловых родителей (раздел до вложенных подразделов) | Нет |
| [methods.json](methods.json) | Шкалы и опросники Г1–Г33: родитель целиком и компоненты | Только `chunks[]` |
| [appendices.json](appendices.json) | А1, А2, А3 (критерии диагноза по нозологиям), алгоритмы Б, памятка В | `appendices[].chunks[]` |
| [references.json](references.json) | Литература с оригинальными номерами 1–30 и список отсутствующих номеров | Нет |
| [supporting.json](supporting.json) | Паспорт, сокращения, термины, встроенные сноски | Нет |
| [assets.json](assets.json) | {m['images']} внешних изображений с координатами; содержимое не распознавалось | Нет |
| [sections.json](sections.json) | Навигационное дерево разделов | Нет |
| [manifest.json](manifest.json) | Версия, SHA-256, правила координат, счётчики, проблемы источника | Нет |
| [coverage.json](coverage.json) | Непересекающееся покрытие каждого символа источника | Нет |
| [annotation_plan.json](annotation_plan.json) | Дерево разделов и зафиксированные решения для воспроизводимой сборки | Нет |

## Как устроена разметка

Документ структурирован иначе, чем БАР: рекомендации записаны пунктом «- Рекомендуется …» (или «- У всех пациентов …
рекомендуется …»), затем строка УУР/УДД, затем «Комментарий» с обоснованием и дозами. Поэтому единица рекомендации
определяется по строке уровня доказательности:

- чанк рекомендации = пункт (или несколько пунктов-вариантов), его УУР/УДД и все следующие абзацы комментария
  (включая курсивные продолжения с дозами и режимами). Блок «пункт — вложенные пункты с УУР в скобках»
  (профилактика факторов риска, серологический скрининг) остаётся одним чанком;
- таблица вместе с подписью — отдельный чанк; нумерованные и маркированные списки с вводной фразой не разрываются;
- вводные абзацы раздела перед первой рекомендацией — чанк `section_introduction`, он указан в `required_chunk_ids`
  рекомендаций раздела; таблица, следующая сразу за рекомендацией, требует эту рекомендацию;
- ссылки «табл. N» в основном тексте превращены в `metadata.table_links` и `required_chunk_ids`
  (например, таблица 11 с дозами базисных препаратов для рекомендаций по лечению);
- повествовательные разделы без рекомендаций делятся по абзацам на страницы не более 3500 символов, списки и таблицы не режутся;
- родитель — раздел до вложенных подразделов (`sections.json` хранит полное дерево). Общий текст предка включается в
  `always_include_spans`, только если раздел помечен `context_for_descendants` в плане (общие положения по лечению,
  введение в адъювантную терапию, введение в лечение ДТЛ);
- методики Г1–Г33 делятся по смысловым меткам (`Шаблон`, `Содержание`, `Инструкция`, `Интерпретация`, `Пояснения`), заголовок
  с паспортом шкалы включается в `always_include_spans` каждого компонента, большие бланки делятся только по границам блоков.

`retrieval.mode`: `self` — сам чанк; `parent` — вместо одного пункта полный родитель, если он не превышает 3500 символов;
`window` — чанк и соседи того же родителя. Дополнительно всегда включаются `always_include_spans` и `required_chunk_ids`.
Порог страницы — оценка объёма Markdown, не доказанный лимит модели. Чанки больше порога ({m['oversized_atomic_chunks']}) помечены
`atomic_oversize`: рекомендации с длинными комментариями и дозами, таблицы, бланки.

## Правила координат и текста

`span` — Unicode code point, отсчёт с нуля, `start` включается, `end` нет; `start_line`/`end_line` — включительные номера
строк с единицы. `source_text` — точный фрагмент, `text` — тот же фрагмент без квадратных библиографических ссылок
(`[73]`, `[151-153]`, `[615, 619–621]`; ссылки вида `[[1]](url)` и `[123I]` не удаляются). `metadata.citation_numbers`,
`citation_spans`, `reference_ids`, `unresolved_citation_numbers`, `evidence_statements` определены как в БАР; УУР/УДД
сохраняются строкой как написано, в том числе с опечатками источника.

## Неоднозначности и ошибки источника

См. `manifest.json:source_issues` и [REVIEW.md](REVIEW.md). Главное:

- литература: только 30 работ, тогда как использовано {len(CITED)} номеров (до {max(CITED)}); недостающие номера не придуманы;
- нумерация таблиц повторяется в основном тексте, А2 и А3; в основном тексте нет таблиц №{", ".join(map(str, MAIN_TABLES_MISSING))};
- встроенные сноски `---` + `[[1]](url)` вынесены в `supporting.json` и не входят в клинические чанки;
- у приложений Г27, Г31 повреждена разметка заголовка; шкала RASS в Г27 не имеет отдельной метки; ссылки «Приложение 11» и
  «Приложение 13» даны без буквы (кандидаты Г11 и Г13 определены только по названию и не подставлены);
- строки УУР/УДД записаны в нескольких вариантах ({len(NONCANON_EVIDENCE)} нетипичных); они не нормализовались;
- изображений {m['images']}: шаблоны ряда шкал и алгоритмы Б доступны только картинками (`answerability: image_content_unavailable`).

## Воспроизводимость

Из корня репозитория:

```bash
python3 -I scripts/clinrecs/build_cognitive_rag.py
python3 -I scripts/clinrecs/build_cognitive_rag.py --check
python3 -I scripts/clinrecs/resolve_cognitive_rag.py --verify
python3 -I scripts/clinrecs/resolve_cognitive_rag.py cogn_2024.chunk.0448
```

`--write-plan` пересоздаёт `annotation_plan.json` по правилам заголовков из скрипта. Сборка проверяет SHA-256 источника, соответствие
`span` тексту, полное покрытие каждого символа, связи родителей и соседей, принадлежность каждой строки УУР ровно одной рекомендации,
целостность таблиц. Эмбеддинги и интеграция с приложением не выполнялись.
'''


serialized = {name: json.dumps(data, ensure_ascii=False, indent=2) + '\n' for name, data in FILES.items()}
serialized['REVIEW.md'] = review()
serialized['README.md'] = readme()
if ARGS.check:
    for name, expected in serialized.items():
        assert (OUT / name).read_text() == expected, f'Stale artifact: {name}'
else:
    for name, data in serialized.items():
        (OUT / name).write_text(data)
print(json.dumps(COUNTS, ensure_ascii=False))
print('Validation passed; unresolved citation numbers:', len(MISSING), '; appendix link issues:', len(LINK_ISSUES),
      '; table ref issues:', len(TABLE_ISSUES), '; tiny chunks:', len(PROBLEMS['tiny_chunks']))
