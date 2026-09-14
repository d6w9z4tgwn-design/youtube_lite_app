import hashlib
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from app_runtime import Settings, data_directory, dependency_report, setup_user_data, worker_command
from ytdlp_update import YtDlpUpdater, asset_name, managed_executable, safe_url


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_setup_and_settings_are_repeatable(self):
        setup_user_data(self.root)
        Settings(self.root).save({'voicevoxPort': 50025, 'whisperModel': 'small', 'defaultRate': 0.75})
        setup_user_data(self.root)
        self.assertEqual(Settings(self.root).get()['defaultRate'], 0.75)
        self.assertTrue((self.root / 'logs').is_dir())
        self.assertTrue((self.root / 'asr_models').is_dir())

    def test_invalid_values_do_not_replace_good_config(self):
        settings = Settings(self.root)
        settings.save({})
        for values in ({'voicevoxPort': True}, {'voicevoxPort': 80}, {'whisperModel': '../model'},
                       {'defaultRate': float('nan')}, {'voicevoxUrl': 'https://evil.invalid'}, {'defaultRate': True}):
            with self.assertRaises(ValueError): settings.save(values)
        self.assertEqual(Settings(self.root).get()['voicevoxPort'], 50021)

    def test_corrupt_settings_are_preserved(self):
        path = self.root / 'settings.json'
        path.write_text('{broken', encoding='utf-8')
        with self.assertRaises(RuntimeError): Settings(self.root)
        self.assertEqual(path.read_text(), '{broken')

    def test_sqlite_migration_captures_wal_without_modifying_original(self):
        source = self.root / 'old.sqlite3'
        connection = sqlite3.connect(source)
        self.addCleanup(connection.close)
        connection.execute('pragma journal_mode=WAL')
        connection.execute('create table private_history (title text)')
        connection.execute("insert into private_history values ('private fixture')")
        connection.commit()
        target = self.root / 'new'
        self.assertTrue(setup_user_data(target, source))
        with closing(sqlite3.connect(target / 'clipnest.sqlite3')) as database:
            self.assertEqual(database.execute('select title from private_history').fetchone()[0], 'private fixture')
        connection.execute("insert into private_history values ('new original entry')")
        connection.commit()
        self.assertFalse(setup_user_data(target, source))
        self.assertEqual(connection.execute('select count(*) from private_history').fetchone()[0], 2)
        with closing(sqlite3.connect(target / 'clipnest.sqlite3')) as database:
            self.assertEqual(database.execute('select count(*) from private_history').fetchone()[0], 1)

    def test_path_override_and_frozen_worker(self):
        with patch.dict('os.environ', {'CLIPNEST_DATA_DIR': str(self.root)}):
            self.assertEqual(data_directory(), self.root.resolve())
        with patch.object(sys, 'frozen', True, create=True):
            self.assertEqual(worker_command('yt-dlp'), [sys.executable, '--worker', 'yt-dlp'])

    def test_diagnostics_do_not_expose_paths_or_service_private_fields(self):
        service = Mock()
        service.local_status.return_value = {'currentVersion': '2026.08.19', 'source': '/private/person',
                                             'updateCommand': '/private/person/python', 'history': 'private title'}
        with patch('socket.create_connection') as connect:
            report = json.dumps(dependency_report(Settings(self.root), service))
            connect.assert_not_called()
        self.assertNotIn('/private/person', report)
        self.assertNotIn('private title', report)
        self.assertNotIn(str(self.root), report)
        self.assertNotIn('Whisper', report)
        self.assertNotIn('voicevox', report)

    def test_setting_scopes_preserve_old_file_and_each_other(self):
        original = {'defaultRate': 0.75, 'whisperModel': 'small', 'voicevoxPort': 50025}
        (self.root / 'settings.json').write_text(json.dumps(original), encoding='utf-8')
        settings = Settings(self.root)
        self.assertEqual(settings.scoped('dubbing'), {'whisperModel': 'small', 'voicevoxPort': 50025})
        settings.save_scoped('app', {'defaultRate': 2})
        self.assertEqual(settings.scoped('dubbing'), {'whisperModel': 'small', 'voicevoxPort': 50025})
        settings.save_scoped('dubbing', {'voicevoxPort': 50026})
        self.assertEqual(Settings(self.root).get(), {**original, 'defaultRate': 2, 'voicevoxPort': 50026})
        with self.assertRaises(ValueError): settings.save_scoped('app', {'whisperModel': 'tiny'})
        with self.assertRaises(ValueError): settings.save_scoped('dubbing', {'defaultRate': 1})


class UpdateTests(RuntimeTests):
    def fixture(self, checksum=True):
        name, content = asset_name(), b'fake executable'
        digest = hashlib.sha256(content).hexdigest() if checksum else '0' * 64
        def fetch(url, limit):
            if url.endswith('/latest'):
                return json.dumps({'tag_name': '2026.08.19', 'assets': [{'name': name}, {'name': 'SHA2-256SUMS'}]}).encode()
            if url.endswith('SHA2-256SUMS'): return f'{digest}  {name}\n'.encode()
            return content
        return YtDlpUpdater(self.root, fetch=fetch, run=Mock(return_value=subprocess.CompletedProcess([], 0, '2026.08.19\n', '')))

    def test_verified_update_and_revert(self):
        updater = self.fixture()
        self.assertEqual(updater.install(), '2026.08.19')
        self.assertIsNotNone(managed_executable(self.root))
        updater.reset()
        self.assertIsNone(managed_executable(self.root))
        self.assertTrue(list((self.root / 'tools').glob('2026.*')))

    def test_bad_checksum_never_executes_or_activates(self):
        updater = self.fixture(False)
        with self.assertRaises(ValueError): updater.install()
        updater.run.assert_not_called()
        self.assertIsNone(managed_executable(self.root))

    def test_tampering_disables_managed_binary(self):
        updater = self.fixture()
        updater.install()
        path = managed_executable(self.root)
        path.write_bytes(b'corrupted')
        self.assertIsNone(managed_executable(self.root))

    def test_failed_version_check_preserves_pointer(self):
        updater = self.fixture()
        updater.install()
        before = (self.root / 'tools' / 'active.json').read_bytes()
        updater.run.return_value = subprocess.CompletedProcess([], 1, '', '')
        with self.assertRaises(ValueError): updater.install()
        self.assertEqual((self.root / 'tools' / 'active.json').read_bytes(), before)

    def test_download_url_allowlist(self):
        self.assertTrue(safe_url('https://github.com/yt-dlp/yt-dlp/releases/latest'))
        for url in ('http://github.com/a', 'https://evil.invalid/a', 'https://github.com.evil.invalid/a', 'https://user@github.com/a', 'https://github.com:444/a'):
            self.assertFalse(safe_url(url))
