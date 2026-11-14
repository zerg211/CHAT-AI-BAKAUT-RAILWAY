import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('catalog_launch', Path(__file__).resolve().parents[1] / 'catalog-service/launch.py')
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)


class CatalogLaunchTests(unittest.TestCase):
    def test_validates_both_data_files_before_selecting_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            files = {}
            for name in ('BAKAUT_DB_PATH', 'BAKAUT_EMBEDDING_DB_PATH'):
                path = Path(directory) / name
                path.write_bytes(name.encode())
                files[name] = {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            manifest = {'revision': 'rev', 'count': 4324, 'files': files}
            environment = launch.snapshot_environment(manifest)
            self.assertEqual(environment['BAKAUT_EXPECTED_COUNT'], '4324')
            self.assertEqual(environment['BAKAUT_EXPECTED_REVISION'], 'rev')
            Path(files['BAKAUT_EMBEDDING_DB_PATH']['path']).write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                launch.snapshot_environment(manifest)


if __name__ == '__main__':
    unittest.main()
