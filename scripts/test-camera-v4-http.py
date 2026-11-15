#!/usr/bin/env python3
"""Synthetic-only local HTTP fixture. Never point this at an existing server."""
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import time

WORK = Path(__file__).resolve().parents[1]
HOME_DIR = Path.home().resolve()
CONFIG = WORK / 'next.config.ts'
NEXT_ENV = WORK / 'next-env.d.ts'
PORT = 3393
MARKER = 'isolated-camera-v4-http\n'
NEEDLE = b"const config: NextConfig = { serverExternalPackages: ['better-sqlite3'], poweredByHeader: false };"
REPLACEMENT = b"const config: NextConfig = { serverExternalPackages: ['better-sqlite3'], poweredByHeader: false, turbopack: { root: '/home/dennis' } };"


def interrupted(signum, _frame):
    raise InterruptedError(f'interrupted by signal {signum}')


def listener_pids():
    result = subprocess.run(['ss', '-ltnp', f'sport = :{PORT}'], text=True, capture_output=True, check=True)
    return len(result.stdout.splitlines()) > 1, {int(value) for value in re.findall(r'pid=(\d+)', result.stdout)}


def main():
    if HOME_DIR != Path('/home/dennis') or WORK != HOME_DIR / '.videomaker-camera-admission-v4':
        raise RuntimeError('Only the dedicated fixture worktree is allowed')
    subprocess.run(['git', '-C', str(WORK), 'diff', '--quiet', '--', 'next.config.ts', 'next-env.d.ts'], check=True)
    original = CONFIG.read_bytes()
    original_env = NEXT_ENV.read_bytes()
    if original.count(NEEDLE) != 1:
        raise RuntimeError('Unexpected Next config; nothing was changed')
    if listener_pids()[0]:
        raise RuntimeError('Fixture port already in use')
    injected = original.replace(NEEDLE, REPLACEMENT)
    fixture = Path(tempfile.mkdtemp(prefix='.videomaker-camera-v4-http.', dir=HOME_DIR))
    (fixture / '.fixture').write_text(MARKER)
    proc = None
    preserve = False
    old_handlers = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        CONFIG.write_bytes(injected)
        env = os.environ.copy()
        env.update(DATA_DIR=str(fixture), ADMIN_PASSWORD='camera-v2-local-test',
                   SESSION_SECRET='camera-v2-test-only-session-secret-1234567890',
                   VIDEOMAKER_PUBLIC_ORIGIN=f'http://127.0.0.1:{PORT}',
                   CAMERA_REMOTE_TEST_ENABLE='1', NODE_ENV='development', NODE_OPTIONS='--max-old-space-size=768')
        with (fixture / 'dev.log').open('w+') as log:
            proc = subprocess.Popen(['./node_modules/.bin/next', 'dev', '--hostname', '127.0.0.1', '--port', str(PORT)],
                                    cwd=WORK, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            for _ in range(150):
                if proc.poll() is not None:
                    raise RuntimeError('Fixture server exited before ready')
                listening, pids = listener_pids()
                if listening:
                    if not pids or any(os.getpgid(pid) != proc.pid for pid in pids):
                        raise RuntimeError('Fixture port was claimed by another process')
                    try:
                        with socket.create_connection(('127.0.0.1', PORT), timeout=.25):
                            break
                    except OSError:
                        pass
                time.sleep(.2)
            else:
                raise TimeoutError('Fixture server did not become ready')
            testenv = env.copy()
            testenv.update(CAMERA_V2_HTTP_SERVER=f'http://127.0.0.1:{PORT}', CAMERA_V2_HTTP_ALLOW_WRITES='1',
                           CAMERA_V2_HTTP_FIXTURE=str(fixture), NODE_OPTIONS='--max-old-space-size=384')
            result = subprocess.run(['node', '--experimental-strip-types', '--test', 'tests/camera-remote-v4-http.test.mjs'],
                                    cwd=WORK, env=testenv, text=True, capture_output=True, timeout=150)
            print(result.stdout, end='', flush=True)
            if result.returncode:
                print(result.stderr, end='', flush=True)
                log.flush(); log.seek(0)
                print('Fixture server log:', log.read()[-6000:], flush=True)
                raise RuntimeError('Isolated HTTP test failed')
    finally:
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
        if proc is not None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL); proc.wait()
        if CONFIG.exists() and CONFIG.read_bytes() == injected:
            CONFIG.write_bytes(original)
        else:
            preserve = True
            (fixture / 'original-next.config.ts').write_bytes(original)
            print(f'Config changed concurrently; original retained at {fixture}', flush=True)
        current_env = NEXT_ENV.read_bytes() if NEXT_ENV.exists() else None
        generated_env = original_env.replace(b"./.next/types/", b"./.next/dev/types/")
        if current_env in (original_env, generated_env):
            NEXT_ENV.write_bytes(original_env)
        else:
            preserve = True
            (fixture / 'original-next-env.d.ts').write_bytes(original_env)
            print(f'next-env changed unexpectedly; original retained at {fixture}', flush=True)
        if not preserve and (fixture / '.fixture').read_text() == MARKER:
            shutil.rmtree(fixture)
            print('Fixture stopped; temporary data and unchanged configuration cleaned up.', flush=True)
        else:
            raise RuntimeError('Fixture retained for manual recovery; inspect the reported path')


if __name__ == '__main__':
    main()
