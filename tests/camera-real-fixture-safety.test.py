"""Host-only preflight tests. No ADB, camera, real server, or product data."""
import hashlib, importlib.util, os, sys, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/camera-device-loopback-e2e.py'
spec = importlib.util.spec_from_file_location('camera_real_runner', SCRIPT)
runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)

class PreflightSafetyTest(unittest.TestCase):
 def test_default_runner_is_inert_before_any_adb_or_server(self):
  self.assertFalse(runner.REAL_DEVICE_FIXTURE_ENABLED)
  with mock.patch.object(runner,'run') as external,mock.patch.object(runner.subprocess,'Popen') as spawn:
   with self.assertRaisesRegex(RuntimeError,'disabled pending independent review'):runner.main()
  external.assert_not_called();spawn.assert_not_called()
 def test_existing_camera_owner_fails_before_any_install_or_server(self):
  with tempfile.TemporaryDirectory(prefix='kp-real-preflight-') as directory:
   root=Path(directory); app=root/'fixture.apk'; test=root/'fixture-test.apk'
   app.write_bytes(b'synthetic-app');test.write_bytes(b'synthetic-test')
   expected={str(app):runner.APP,str(test):runner.TEST}; calls=[]
   def fake_run(*args,**kwargs):
    calls.append(args)
    if 'ro.serialno' in args:return 'R5CR60Q07YN\n'
    if 'badging' in args:return "package: name='"+expected[args[-1]]+"'\n"
    if 'xmltree' in args:return 'android:targetPackage "'+runner.APP+'" android.test.InstrumentationTestRunner'
    if 'packages' in args:return ''
    if 'uiautomator' in args:return 'Aufnahme starten'
    if 'media.camera' in args:return 'active package de.kontrakurs.kontraprompter'
    raise AssertionError('unexpected external command: '+repr(args))
   class Port:
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def bind(self,*args):pass
    def getsockname(self):return ('127.0.0.1',12345)
   sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
   env={'CAMERA_FIXTURE_APP_SHA256':sha(app),'CAMERA_FIXTURE_TEST_SHA256':sha(test)}
   with mock.patch.object(runner,'REAL_DEVICE_FIXTURE_ENABLED',True),mock.patch.object(runner,'ROOT',root),mock.patch.object(runner,'WORK',root), \
        mock.patch.object(runner,'FIXTURE_HOME',root),mock.patch.object(runner,'run',side_effect=fake_run), \
        mock.patch.object(runner,'reverse_list',return_value=[]),mock.patch.object(runner,'ensure_free'), \
        mock.patch.object(runner.socket,'socket',return_value=Port()), \
        mock.patch.object(runner.shutil,'disk_usage',return_value=SimpleNamespace(free=2_000_000_000)), \
        mock.patch.object(runner.subprocess,'Popen') as spawn,mock.patch.dict(os.environ,env), \
        mock.patch.object(sys,'argv',[str(SCRIPT),'R5CR60Q07YN',str(app),str(test)]):
    with self.assertRaisesRegex(RuntimeError,'Camera ownership is not demonstrably free'):runner.main()
   spawn.assert_not_called();self.assertFalse(any('install' in args for args in calls))
 def test_runner_has_no_automatic_uninstall_or_force_stop(self):
  source=SCRIPT.read_text()
  self.assertNotIn("'uninstall',package",source)
  self.assertNotIn("'force-stop'",source)
  self.assertIn('Fixture retained: verify recorder and camera release',source)

if __name__=='__main__':unittest.main(verbosity=2)
