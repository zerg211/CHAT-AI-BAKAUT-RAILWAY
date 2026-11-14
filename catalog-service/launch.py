import hashlib
import json
import os
from pathlib import Path
import sys


def snapshot_environment(manifest):
    environment = {}
    for name in ('BAKAUT_DB_PATH', 'BAKAUT_EMBEDDING_DB_PATH'):
        artifact = manifest['files'][name]
        path = Path(artifact['path'])
        with path.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        if digest != artifact['sha256']:
            raise RuntimeError(f'Catalog snapshot checksum mismatch: {name}')
        environment[name] = str(path)
    environment['BAKAUT_EXPECTED_REVISION'] = manifest['revision']
    environment['BAKAUT_EXPECTED_COUNT'] = str(manifest['count'])
    return environment


if __name__ == '__main__':
    root = Path(__file__).resolve().parent
    manifest = json.loads((root / 'snapshot.json').read_text(encoding='utf-8'))
    os.environ.update(snapshot_environment(manifest))
    os.chdir(root)
    os.execv(sys.executable, [sys.executable, str(root / 'server.py')])
