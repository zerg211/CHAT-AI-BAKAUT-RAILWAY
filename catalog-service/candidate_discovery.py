"""Return a complete category universe without making a suitability decision."""


def discover_candidates(knowledge, category):
    if not isinstance(category, str) or not category.strip():
        raise ValueError('A product category is required')
    first = knowledge.search_products(category=category)
    if first.get('status') != 'ok':
        return first
    snapshot = knowledge.snapshots[first['snapshot']]
    if not snapshot['complete'] or snapshot['criteria']['query'] or snapshot['excluded']:
        raise ValueError('Category universe is incomplete')
    items = [item for group in ('matches', 'needs_check', 'unknown') for item in snapshot['groups'][group]]
    ids = [item['product_id'] for item in items]
    if len(ids) != snapshot['universe'] or len(set(ids)) != len(ids) or any(
        not isinstance(ident, str) or len(ident) != 24 or any(char not in '0123456789abcdef' for char in ident)
        for ident in ids):
        raise ValueError('Category identities are incomplete or duplicated')
    return {'status': 'ok', 'selection_mode': 'candidate_discovery', 'source_revision': knowledge.revision,
            'snapshot': snapshot['snapshot'], 'candidate_ids': ids, 'candidate_count': len(ids),
            'category': snapshot['criteria']['category'], 'complete': True,
            'suitability_decided': False}
