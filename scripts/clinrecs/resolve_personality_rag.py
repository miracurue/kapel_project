#!/usr/bin/env python3
"""Local reference context assembler for the personality-disorders (pers_2024) JSON dataset; no model or DB."""

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'docs/clinrecs/rag/19_personality'


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


def resolve(chunk_id):
    """One-hop neighbors; explicit dependencies recursively, deduplicating source spans.

    Ancillary names/appendix links remain navigable metadata, not automatic whole
    appendix expansion. Retrieval neighbors are never recursively expanded.
    """
    selected = CHUNKS[chunk_id]
    spans = []
    selected_ids = []
    visited = set()

    def add_span(s):
        spans.append({'start': s['start'], 'end': s['end']})

    def include(c, expand_mode):
        if c['id'] in visited:
            return
        visited.add(c['id'])
        selected_ids.append(c['id'])
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
                links[(occurrence['span']['start'], occurrence['span']['end'], occurrence['label'])] = occurrence
    numbers = sorted({n for c in citations.values() for n in c['numbers']})
    return {'document_id': MANIFEST['document_id'], 'selected_chunk_id': chunk_id,
            'mode': selected['retrieval']['mode'], 'included_chunk_ids': selected_ids,
            'heading_path': selected['heading_path'], 'source_sha256': MANIFEST['source_sha256'],
            'source_url': MANIFEST['source_url'], 'fragments': fragments,
            'fragment_separator': '\n\n[Пропуск между фрагментами источника]\n\n',
            'context_metadata': {'citation_numbers': numbers,
                                 'reference_ids': [REFERENCES[n] for n in numbers if n in REFERENCES],
                                 'unresolved_citation_numbers': [n for n in numbers if n not in REFERENCES],
                                 'citation_spans': sorted(citations.values(), key=lambda r: r['span']['start']),
                                 'appendix_links': sorted(links.values(), key=lambda r: (r['span']['start'], r['label'])),
                                 'assets': [a for a in ASSETS if contained(a['span'])]},
            'selected_chunk_metadata': selected['metadata']}


def verify():
    # Real examples verify the retrieval contract beyond span/relationship syntax.
    def ids(chunk_id):
        return set(resolve(chunk_id)['included_chunk_ids'])

    anamnesis = resolve('pers_2024.chunk.0219')
    assert anamnesis['mode'] == 'window' and 'pers_2024.chunk.0191' in anamnesis['included_chunk_ids']
    assert 2 in anamnesis['context_metadata']['citation_numbers']
    borderline = ids('pers_2024.chunk.0319')
    assert {'pers_2024.chunk.0225', 'pers_2024.chunk.0303'} <= borderline
    paranoid = resolve('pers_2024.chunk.0239')
    assert paranoid['mode'] == 'parent' and 'pers_2024.chunk.0225' in paranoid['included_chunk_ids']
    antidepressant = resolve('pers_2024.chunk.0512')
    assert 'pers_2024.chunk.0520' in antidepressant['included_chunk_ids']
    general = PARENTS['pers_2024.parent.470']['span']
    assert any(f['start'] <= general['start'] and f['end'] >= general['end'] for f in antidepressant['fragments'])
    assert REFERENCES[46] in antidepressant['context_metadata']['reference_ids']
    psychotherapy = CHUNKS['pers_2024.chunk.0454']['metadata']
    assert psychotherapy['citation_numbers'][:3] == [4, 5, 6] and 77 in psychotherapy['unresolved_citation_numbers']
    assert 4 in psychotherapy['citation_numbers'] and REFERENCES[4] in psychotherapy['reference_ids']
    hospital = resolve('pers_2024.chunk.0550')
    assert 'pers_2024.chunk.0566' in hospital['included_chunk_ids']
    assert '[[1]](https://cr.minzdrav.gov.ru/#_ftn1)' in CHUNKS['pers_2024.chunk.0550']['text']
    assert CHUNKS['pers_2024.chunk.0550']['metadata']['citation_numbers'] == []
    assert {'pers_2024.chunk.0811', 'pers_2024.chunk.0837', 'pers_2024.chunk.0872'} <= ids('pers_2024.chunk.0846')
    assert {'pers_2024.chunk.0886', 'pers_2024.chunk.1021'} <= ids('pers_2024.chunk.0900')
    assert any(a['url'].endswith('.png') for a in ASSETS) and len(ASSETS) == 2
    for c in CHUNKS.values():
        if c['kind'] == 'recommendation':
            assert len(c['metadata']['evidence_statements']) == 1
    for c in CHUNKS.values():
        result = resolve(c['id'])
        assert result['fragments']
        assert len(result['included_chunk_ids']) == len(set(result['included_chunk_ids']))
        assert result['selected_chunk_metadata'] == c['metadata']
        for f in result['fragments']:
            assert f['source_text'] == TEXT[f['start']:f['end']]
        assert any(f['start'] <= c['span']['start'] and f['end'] >= c['span']['end'] for f in result['fragments'])
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
