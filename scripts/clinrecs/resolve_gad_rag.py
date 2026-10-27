#!/usr/bin/env python3
"""Local reference context assembler for the GAD (ГТР) JSON dataset; no model or DB."""

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'docs/clinrecs/rag/02_gad'


def read(name):
    return json.loads((DATA / name).read_text())


MANIFEST = read('manifest.json')
SOURCE = (ROOT / MANIFEST['source_file']).read_bytes()
assert hashlib.sha256(SOURCE).hexdigest() == MANIFEST['source_sha256']
TEXT = SOURCE.decode('utf-8')
METHODS = read('methods.json')
APPENDICES = read('appendices.json')['appendices']
CHUNKS = {c['id']: c for c in read('chunks.json')['chunks'] + METHODS['chunks'] +
          [c for p in APPENDICES for c in p['chunks']]}
PARENTS = {p['id']: p for p in read('parents.json')['parents'] + METHODS['parents'] + APPENDICES}
REFERENCES = {r['number']: r['id'] for r in read('references.json')['items']}
ASSETS = read('assets.json')['assets']
METHOD_LINKS = {m['appendix']: {key: m[key] for key in
                ('appendix', 'code', 'codes', 'title', 'mode', 'assignable', 'href')}
                for m in json.loads((ROOT / 'src/modules/clinical/instruments/gad_methods.json').read_text())}
METHOD_PARENTS = {p['id']: p['original_appendix_label'] for p in METHODS['parents']}


def markdown_link(link):
    """Explicit navigation for a future context consumer, including both ITT forms."""
    title = link['title'].replace('[', '\\[').replace(']', '\\]')
    return '; '.join(f'[{title} ({code})](/work?tab=tools&tool={code})'
                     for code in link['codes'])


def resolve(chunk_id):
    """One-hop neighbors; explicit dependencies recursively, deduplicating source spans.

    Ancillary names/appendix links remain navigable metadata, not automatic whole
    appendix expansion. Retrieval neighbors are never recursively expanded.
    """
    selected = CHUNKS[chunk_id]
    spans = []
    selected_ids = []
    visited = set()
    method_links = {}

    def add_span(s):
        spans.append({'start': s['start'], 'end': s['end']})

    def include(c, expand_mode):
        if c['id'] in visited:
            return
        visited.add(c['id'])
        selected_ids.append(c['id'])
        appendix = METHOD_PARENTS.get(c['parent_id'])
        if appendix:
            method_links[appendix] = METHOD_LINKS[appendix]
            return
        retrieval = c['retrieval']
        if expand_mode and retrieval['mode'] == 'parent':
            add_span(PARENTS[retrieval['context_parent_id']]['span'])
        else:
            add_span(c['span'])
        for s in retrieval['always_include_spans']:
            add_span(s)
        if expand_mode and retrieval['mode'] == 'window':
            for key in ('previous_chunk_id', 'next_chunk_id'):
                if retrieval[key]:
                    include(CHUNKS[retrieval[key]], False)
        for dependency in retrieval['required_chunk_ids']:
            include(CHUNKS[dependency], False)

    include(selected, True)
    # Adjacent/overlapping source fragments merge; gaps are explicitly delimited.
    merged = []
    for s in sorted(spans, key=lambda s: (s['start'], s['end'])):
        if merged and s['start'] <= merged[-1]['end']:
            merged[-1]['end'] = max(merged[-1]['end'], s['end'])
        else:
            merged.append(dict(s))
    fragments = [dict(s, source_text=TEXT[s['start']:s['end']]) for s in merged]
    contained = lambda s: any(f['start'] <= s['start'] and s['end'] <= f['end'] for f in merged)
    citations = {}
    links = {}
    for c in list(CHUNKS.values()) + list(PARENTS.values()):
        for occurrence in c['metadata']['citation_spans']:
            if contained(occurrence['span']):
                citations[(occurrence['span']['start'], occurrence['span']['end'])] = occurrence
        for occurrence in c['metadata']['appendix_links']:
            if contained(occurrence['span']):
                enriched = dict(occurrence)
                method_link = METHOD_LINKS.get(occurrence['label'])
                if method_link:
                    enriched.update(method_link)
                    enriched['markdown'] = markdown_link(method_link)
                    method_links[method_link['appendix']] = method_link
                links[(occurrence['span']['start'], occurrence['span']['end'], occurrence['label'])] = enriched
    numbers = sorted({n for c in citations.values() for n in c['numbers']})
    application_links = list(method_links.values())
    context_text = '\n\n[Пропуск между фрагментами источника]\n\n'.join(
        f['source_text'] for f in fragments)
    if application_links:
        context_text += ('\n\n' if context_text else '') + '\n'.join(
            markdown_link(link) for link in application_links)
    return {'document_id': MANIFEST['document_id'], 'selected_chunk_id': chunk_id,
            'mode': 'application_link' if selected['parent_id'] in METHOD_PARENTS else selected['retrieval']['mode'],
            'included_chunk_ids': selected_ids,
            'heading_path': selected['heading_path'], 'source_sha256': MANIFEST['source_sha256'],
            'source_url': MANIFEST['source_url'], 'fragments': fragments,
            'fragment_separator': '\n\n[Пропуск между фрагментами источника]\n\n',
            'application_links': application_links, 'context_text': context_text,
            'context_metadata': {'citation_numbers': numbers,
                                 'reference_ids': [REFERENCES[n] for n in numbers if n in REFERENCES],
                                 'unresolved_citation_numbers': [n for n in numbers if n not in REFERENCES],
                                 'citation_spans': sorted(citations.values(), key=lambda r: r['span']['start']),
                                 'appendix_links': sorted(links.values(), key=lambda r: (r['span']['start'], r['label'])),
                                 'assets': [a for a in ASSETS if contained(a['span'])]},
            'selected_chunk_metadata': selected['metadata']}


def verify():
    # Real examples verify the retrieval contract beyond span/relationship syntax.
    physical = resolve('gtr_2024.chunk.0340')
    assert physical['mode'] == 'parent'
    parent = PARENTS[CHUNKS['gtr_2024.chunk.0340']['parent_id']]
    assert any(f['start'] <= parent['span']['start'] and f['end'] >= parent['span']['end'] for f in physical['fragments'])
    assert CHUNKS['gtr_2024.chunk.0340']['metadata']['citation_numbers'] == [2, 18, 30, 31]
    assert {2, 14, 18, 22, 30, 31} <= set(physical['context_metadata']['citation_numbers'])
    anamnesis = resolve('gtr_2024.chunk.0324')
    assert anamnesis['mode'] == 'window'
    assert {'gtr_2024.chunk.0318', 'gtr_2024.chunk.0324', 'gtr_2024.chunk.0328'} <= set(anamnesis['included_chunk_ids'])
    third_line = resolve('gtr_2024.chunk.0519')
    assert third_line['mode'] == 'window'
    assert {'gtr_2024.chunk.0513', 'gtr_2024.chunk.0515', 'gtr_2024.chunk.0519', 'gtr_2024.chunk.0525'} <= set(third_line['included_chunk_ids'])
    cbt = resolve('gtr_2024.chunk.0679')
    assert {'gtr_2024.chunk.0647', 'gtr_2024.chunk.0671'} <= set(cbt['included_chunk_ids'])
    dispensary = resolve('gtr_2024.chunk.0814')
    assert 'gtr_2024.chunk.0802' in dispensary['included_chunk_ids']
    psychodiagnostics = resolve('gtr_2024.chunk.0425')
    assert 'gtr_2024.chunk.0412' in psychodiagnostics['included_chunk_ids']
    assert any(r['status'] == 'missing' and r['label'] == 'Г21' for r in psychodiagnostics['context_metadata']['appendix_links'])
    algorithm_note = CHUNKS['gtr_2024.chunk.0467']['metadata']['appendix_links'][0]
    assert algorithm_note['status'] == 'missing' and algorithm_note['named_method_candidate_ids'] == ['gtr_2024.parent.1126']
    assert any(r['status'] == 'table_scope_unverified' for r in CHUNKS['gtr_2024.chunk.0475']['metadata']['appendix_links'])
    assert CHUNKS['gtr_2024.chunk.0786']['metadata']['citation_spans'][0]['repeated_numbers'] == [36]
    standalone = resolve('gtr_2024.chunk.0178')
    assert standalone['mode'] == 'self' and standalone['included_chunk_ids'] == ['gtr_2024.chunk.0178']
    scale = resolve('gtr_2024.chunk.1388')
    assert scale['mode'] == 'application_link' and not scale['fragments']
    assert scale['application_links'][0]['code'] == 'hars'
    assert scale['application_links'][0]['assignable'] is False
    assert all(m['original_appendix_label'] == f'Г{i}' for i, m in enumerate(
        sorted(METHODS['parents'], key=lambda m: int(m['original_appendix_label'][1:])), 1))
    for c in CHUNKS.values():
        result = resolve(c['id'])
        if c['parent_id'] in METHOD_PARENTS:
            assert not result['fragments']
            assert result['application_links'] == [METHOD_LINKS[METHOD_PARENTS[c['parent_id']]]]
            assert result['context_text'] == markdown_link(result['application_links'][0])
        else:
            assert result['fragments']
            assert any(f['start'] <= c['span']['start'] and f['end'] >= c['span']['end'] for f in result['fragments'])
        assert len(result['included_chunk_ids']) == len(set(result['included_chunk_ids']))
        assert result['selected_chunk_metadata'] == c['metadata']
        for f in result['fragments']:
            assert f['source_text'] == TEXT[f['start']:f['end']]
    print(f'Context assembly verified for all {len(CHUNKS)} chunks and specific dependency examples.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('chunk_id', nargs='?')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    if args.verify:
        verify()
    elif args.chunk_id:
        if args.chunk_id not in CHUNKS:
            parser.error('Unknown chunk_id')
        print(json.dumps(resolve(args.chunk_id), ensure_ascii=False, indent=2))
    else:
        parser.error('Supply a chunk_id or --verify')
