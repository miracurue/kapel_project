#!/usr/bin/env python3
"""Local reference context assembler for the panic disorder (2024) JSON dataset; no model or DB."""

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'docs/clinrecs/rag/07_panic'


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
    anamnesis = resolve('panic_2024.chunk.0290')
    assert anamnesis['mode'] == 'window'
    assert {'panic_2024.chunk.0290', 'panic_2024.chunk.0294'} <= set(anamnesis['included_chunk_ids'])
    assert 254 in anamnesis['context_metadata']['citation_numbers']
    exam = resolve('panic_2024.chunk.0328')
    assert exam['mode'] == 'parent'
    parent = PARENTS[CHUNKS['panic_2024.chunk.0328']['parent_id']]
    assert any(f['start'] <= parent['span']['start'] and f['end'] >= parent['span']['end'] for f in exam['fragments'])
    # Escalation steps carry the initial therapy; psychotherapy carries its contraindications.
    assert {'panic_2024.chunk.0458', 'panic_2024.chunk.0512'} <= set(resolve('panic_2024.chunk.0516')['included_chunk_ids'])
    assert {'panic_2024.chunk.0550', 'panic_2024.chunk.0572'} <= set(resolve('panic_2024.chunk.0578')['included_chunk_ids'])
    # General treatment recommendation is attached to every treatment chunk as ancestor context.
    general = CHUNKS['panic_2024.chunk.0450']['span']
    assert any(f['start'] <= general['start'] and f['end'] >= general['end'] for f in resolve('panic_2024.chunk.0458')['fragments'])
    # Questionnaire parts carry the instrument passport; keys carry what they score.
    key = resolve('panic_2024.chunk.1483')
    assert any(f['start'] <= PARENTS['panic_2024.method.hars']['span']['start'] and f['end'] >= CHUNKS['panic_2024.chunk.1283']['span']['end'] for f in key['fragments'])
    assert {'panic_2024.chunk.1653', 'panic_2024.chunk.1668'} <= set(resolve('panic_2024.chunk.1700')['included_chunk_ids'])
    assert 'panic_2024.chunk.1979' in resolve('panic_2024.chunk.2003')['included_chunk_ids']
    # Cross-references: the scale list resolves one-to-one, the dose table is reachable by link.
    links = {l['label']: l for l in CHUNKS['panic_2024.chunk.0402']['metadata']['appendix_links']}
    assert links['Г2']['resolved_target_ids'] == ['panic_2024.method.pdss']
    assert all(l['status'] == 'resolved' for l in links.values())
    assert any(l['resolved_target_ids'] == ['panic_2024.parent.927'] for l in CHUNKS['panic_2024.chunk.0538']['metadata']['appendix_links'])
    # Evidence statements and citations are preserved verbatim.
    assert CHUNKS['panic_2024.chunk.0178']['metadata']['evidence_statements']
    assert CHUNKS['panic_2024.chunk.0178']['metadata']['citation_numbers'][:3] == [2, 3, 34]
    assert [e['raw'] for e in CHUNKS['panic_2024.chunk.0476']['metadata']['evidence_statements']][0].endswith('доказательств).**')
    assert len(REFERENCES) == 60 and 254 in anamnesis['context_metadata']['unresolved_citation_numbers']
    assert 1 in anamnesis['context_metadata']['citation_numbers'] and 'panic_2024.ref.001' in anamnesis['context_metadata']['reference_ids']
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
