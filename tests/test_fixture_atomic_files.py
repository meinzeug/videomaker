import errno
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from fixture_atomic_files import durable_copy, replace_from_prepared


class FixtureAtomicFilesTest(unittest.TestCase):
    def test_disk_full_during_preparation_never_touches_original(self):
        with tempfile.TemporaryDirectory(prefix='synthetic-fixture-enospc-') as tmp:
            root = Path(tmp)
            original = root / 'source'
            original.write_bytes(b'original data')
            with patch('fixture_atomic_files.os.fsync', side_effect=OSError(errno.ENOSPC, 'simulated full disk')):
                with self.assertRaises(OSError):
                    durable_copy(root / 'staged', b'replacement')
            self.assertEqual(original.read_bytes(), b'original data')

    def test_restore_uses_prepared_backup_without_rewriting_original(self):
        with tempfile.TemporaryDirectory(prefix='synthetic-fixture-restore-') as tmp:
            root = Path(tmp)
            original = root / 'source'
            original.write_bytes(b'original data')
            backup, staged = root / 'backup', root / 'staged'
            durable_copy(backup, original.read_bytes())
            durable_copy(staged, b'temporary test config')
            replace_from_prepared(staged, original)
            with patch.object(Path, 'write_bytes', side_effect=OSError(errno.ENOSPC, 'simulated full disk')):
                replace_from_prepared(backup, original)
            self.assertEqual(original.read_bytes(), b'original data')


if __name__ == '__main__':
    unittest.main()
