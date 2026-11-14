"""Per-product, reviewed label aliases. No historical values, normalization or inference."""
import hashlib,json
from pathlib import Path
_MAP=json.loads(Path(__file__).with_suffix('.json').read_text(encoding='utf-8'))
def resolve_reviewed_field(product_id,raw_sha,raw,requested):
    entry=_MAP.get(product_id,{}).get(requested)
    if not entry or entry['raw_sha256']!=raw_sha:return None
    attrs=raw.get('характеристики') or {}
    value=attrs.get(entry['target'])
    if not isinstance(value,str) or hashlib.sha256(value.encode()).hexdigest()!=entry['value_sha256']:return None
    return value
