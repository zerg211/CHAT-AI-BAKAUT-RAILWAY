"""Copy a fixed local source sample; this is not a live catalog revision."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[3] / 'товары_база_знаний'
articles = ['5100009651', '5100015773', '5100016940', '5100016941', '5100015774', '5100016944',
            '5100016945', '5100015775', '5100009636', '5100009639', '5100016943', '5100009638']
items = []
for article in articles:
    matches = list(root.glob(article + ' (*.json'))
    if len(matches) != 1:
        raise ValueError(f'Expected one local source for {article}; found {len(matches)}')
    source = matches[0]
    original_bytes = source.read_bytes()
    original = json.loads(original_bytes.decode('utf-8-sig'))
    if original.get('артикул') != article:
        raise ValueError(f'Unexpected article in {source.name}')
    items.append({'product_id': hashlib.sha256(('fixture:' + article).encode()).hexdigest()[:24],
                  'source_file': source.name, 'source_sha256': hashlib.sha256(original_bytes).hexdigest(),
                  'original': original})
digest = hashlib.sha256(''.join(item['source_sha256'] for item in items).encode()).hexdigest()
fixture = {'revision': 'local-fixture-sha256:' + digest, 'revision_kind': 'fixture_not_live_catalog',
           'source': 'товары_база_знаний local snapshot', 'items': items}
Path(__file__).with_name('dpu6555-local-originals.json').write_text(
    json.dumps(fixture, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
