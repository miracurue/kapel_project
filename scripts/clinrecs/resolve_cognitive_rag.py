#!/usr/bin/env python3
"""Local reference context assembler for the cognitive disorders (cogn_2024) JSON dataset; no model or DB."""

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'docs/clinrecs/rag/05_cognitive'


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
    anamnesis = resolve('cogn_2024.chunk.0448')
    assert anamnesis['mode'] == 'window'
    assert {'cogn_2024.chunk.0444', 'cogn_2024.chunk.0448', 'cogn_2024.chunk.0454'} <= set(anamnesis['included_chunk_ids'])
    assert 73 in anamnesis['context_metadata']['citation_numbers']
    assert any('Уровень убедительности' in e['raw'] for e in CHUNKS['cogn_2024.chunk.0448']['metadata']['evidence_statements'])
    # recommendation whose second variant carries its own evidence stays in one chunk
    serology = CHUNKS['cogn_2024.chunk.0644']
    assert len(serology['metadata']['evidence_statements']) == 2 and 'NMDA' in serology['source_text']
    prevention = CHUNKS['cogn_2024.chunk.1793']
    assert len(prevention['metadata']['evidence_statements']) == 5 and 'ожирения' in prevention['source_text']
    # the dose table is a required dependency of treatment recommendations that cite it
    treatment = resolve('cogn_2024.chunk.1309')
    assert 'cogn_2024.chunk.1163' in treatment['included_chunk_ids']
    ancestor = resolve('cogn_2024.chunk.1103')
    assert any(f['start'] <= PARENTS['cogn_2024.parent.1087']['span']['start'] and
               f['end'] >= PARENTS['cogn_2024.parent.1087']['span']['end'] for f in ancestor['fragments'])
    scale = resolve('cogn_2024.chunk.2412')
    assert any(f['start'] <= PARENTS['cogn_2024.method.g01']['span']['start'] for f in scale['fragments'])
    assert any(r['status'] == 'label_without_letter' and 'cogn_2024.method.g11' in r['named_method_candidate_ids']
               for r in CHUNKS['cogn_2024.chunk.0986']['metadata']['appendix_links'])
    assert any(r['status'] == 'resolved_group' for c in CHUNKS.values() for r in c['metadata']['appendix_links'])
    for c in CHUNKS.values():
        result = resolve(c['id'])
        assert result['fragments']
        assert len(result['included_chunk_ids']) == len(set(result['included_chunk_ids']))
        assert result['selected_chunk_metadata'] == c['metadata']
        for f in result['fragments']:
            assert f['source_text'] == TEXT[f['start']:f['end']]
        assert any(f['start'] <= c['span']['start'] and f['end'] >= c['span']['end'] for f in result['fragments'])
        if c['retrieval']['mode'] == 'parent':
            parent = PARENTS[c['retrieval']['context_parent_id']]
            assert any(f['start'] <= parent['span']['start'] and f['end'] >= parent['span']['end'] for f in result['fragments'])
        if c['retrieval']['mode'] == 'window':
            assert {c['retrieval']['previous_chunk_id'], c['retrieval']['next_chunk_id']} - {None} <= set(result['included_chunk_ids'])
        for dependency in c['retrieval']['required_chunk_ids']:
            assert dependency in result['included_chunk_ids']
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
