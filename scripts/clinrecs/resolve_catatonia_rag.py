#!/usr/bin/env python3
"""Local reference context assembler for the febrile catatonia (2021) JSON dataset; no model or DB."""

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'docs/clinrecs/rag/25_catatonia'


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
    d = 'febcat_2021'
    exam = resolve(f'{d}.chunk.0099')
    assert exam['mode'] == 'parent'
    assert {f'{d}.chunk.0107', f'{d}.chunk.0099'} <= set(exam['included_chunk_ids'])
    exam2 = resolve(f'{d}.chunk.0103')
    assert f'{d}.chunk.0107' in exam2['included_chunk_ids']
    labs = resolve(f'{d}.chunk.0119')
    assert f'{d}.chunk.0123' in labs['included_chunk_ids'] and {20, 21, 22} <= set(labs['context_metadata']['citation_numbers'])
    # Treatment recommendations carry the section-level statement about transfer to the ICU.
    drugs = resolve(f'{d}.chunk.0152')
    icu = TEXT[CHUNKS[f'{d}.chunk.0139']['span']['start']:CHUNKS[f'{d}.chunk.0139']['span']['end']]
    assert any(f['source_text'] in icu or icu.strip() in f['source_text'] for f in drugs['fragments'])
    assert len(CHUNKS[f'{d}.chunk.0152']['metadata']['evidence_statements']) == 3
    assert CHUNKS[f'{d}.chunk.0162']['metadata']['citation_numbers'] == [1, 3, 5, 9, 13, 15, 16, 18, 29, 30, 31, 32]
    clinical = resolve(f'{d}.chunk.0067')
    assert clinical['mode'] == 'window' and f'{d}.chunk.0061' in clinical['included_chunk_ids']
    scale = resolve(f'{d}.chunk.0365')
    assert scale['included_chunk_ids'] == [f'{d}.chunk.0365']
    quality = CHUNKS[f'{d}.chunk.0284']['metadata']
    assert quality['answerability'] == 'image_content_unavailable' and quality['image_urls']
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
