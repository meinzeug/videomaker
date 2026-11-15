#!/usr/bin/env python3
"""Synthetic loopback-only server; never targets an existing service or real data."""
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import time
import urllib.request
import json
from fixture_atomic_files import durable_copy, replace_from_prepared

WORK = Path(__file__).resolve().parents[1]
HOME = Path.home().resolve()
PORT = 3391
MARKER = 'isolated-live-http\n'
NEEDLE = b"const config: NextConfig = { serverExternalPackages: ['better-sqlite3'], poweredByHeader: false };"
REPLACEMENT = b"const config: NextConfig = { serverExternalPackages: ['better-sqlite3'], poweredByHeader: false, distDir: '.next-live-owner-fixture', turbopack: { root: '/home/dennis' } };"

def interrupted(signum, _):
    raise InterruptedError(f'interrupted: {signum}')

def listeners():
    output = subprocess.run(['ss', '-ltnp', f'sport = :{PORT}'], text=True, capture_output=True, check=True).stdout
    return len(output.splitlines()) > 1, {int(v) for v in re.findall(r'pid=(\d+)', output)}

def main():
    if HOME != Path('/home/dennis') or WORK != HOME / '.videomaker-live-fencing-review':
        raise RuntimeError('wrong isolated worktree')
    config, next_env, tsconfig = WORK / 'next.config.ts', WORK / 'next-env.d.ts', WORK / 'tsconfig.json'
    subprocess.run(['git','-C',str(WORK),'diff','--quiet','--','next.config.ts','next-env.d.ts','tsconfig.json'],check=True)
    original, original_env, original_ts = config.read_bytes(), next_env.read_bytes(), tsconfig.read_bytes()
    cache = WORK / '.next-live-owner-fixture'
    if original.count(NEEDLE)!=1 or cache.exists() or listeners()[0]:
        raise RuntimeError('unexpected configuration, cache, or listener')
    fixture=HOME / ('.videomaker-live-http.'+secrets.token_hex(12))
    fixture.mkdir(mode=0o700)
    (fixture/'.fixture').write_text(MARKER)
    proof=secrets.token_hex(32);proc=None;preserve=False
    handlers={sig:signal.signal(sig,interrupted) for sig in (signal.SIGINT,signal.SIGTERM)}
    injected=original.replace(NEEDLE,REPLACEMENT)
    backups={config:fixture/'original-next.config.ts',next_env:fixture/'original-next-env.d.ts',tsconfig:fixture/'original-tsconfig.json'}
    prepared=False
    try:
        # All originals must be on disk before changing any worktree file.
        for file, data in ((config,original),(next_env,original_env),(tsconfig,original_ts)):
            durable_copy(backups[file],data)
        staged=fixture/'prepared-next.config.ts'
        durable_copy(staged,injected)
        prepared=True
        subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','color=c=black:s=64x64:r=10:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',str(fixture/'sample.mp4')],check=True,timeout=30)
        replace_from_prepared(staged,config)
        env=os.environ.copy();env.update(DATA_DIR=str(fixture),ADMIN_PASSWORD='isolated-live-test',SESSION_SECRET='synthetic-live-test-secret-only-0123456789',VIDEOMAKER_PUBLIC_ORIGIN=f'http://127.0.0.1:{PORT}',LIVE_RECORDING_UPLOAD_TEST_ENABLE='1',LIVE_RECORDING_FIXTURE_PROOF=proof,NODE_ENV='development',NODE_OPTIONS='--max-old-space-size=768')
        with (fixture/'server.log').open('w+') as log:
            proc=subprocess.Popen(['./node_modules/.bin/next','dev','--hostname','127.0.0.1','--port',str(PORT)],cwd=WORK,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            for _ in range(150):
                if proc.poll() is not None:raise RuntimeError('fixture server exited')
                listening,pids=listeners()
                if listening:
                    if not pids or any(os.getpgid(pid)!=proc.pid for pid in pids):raise RuntimeError('port claimed by a different process')
                    try:
                        with socket.create_connection(('127.0.0.1',PORT),timeout=.2):break
                    except OSError:pass
                time.sleep(.2)
            else:raise TimeoutError('fixture server not ready')
            with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/api/internal/live-fixture-attest',timeout=60) as reply:
                if json.load(reply).get('proof')!=proof:raise RuntimeError('fixture server attestation failed')
            testenv=env.copy();testenv.update(LIVE_RECEIPT_TEST_SERVER=f'http://127.0.0.1:{PORT}',LIVE_RECEIPT_TEST_ALLOW_WRITES='1',LIVE_RECEIPT_TEST_FIXTURE=str(fixture),NODE_OPTIONS='--max-old-space-size=384')
            for name in ['tests/live-recording-http-integration.test.mjs','tests/live-owner-http.test.mjs']:
                result=subprocess.run(['node','--experimental-strip-types','--test',name],cwd=WORK,env=testenv,text=True,capture_output=True,timeout=150)
                print(result.stdout,end='',flush=True)
                if result.returncode:
                    print(result.stderr,end='',flush=True);log.flush();log.seek(0);print(log.read()[-6000:],flush=True);raise RuntimeError('HTTP fixture failed')
    finally:
        for sig,handler in handlers.items():signal.signal(sig,handler)
        if proc is not None:
            try:os.killpg(proc.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:proc.wait(timeout=10)
            except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait()
        current_config=config.read_bytes() if config.exists() else None
        if prepared and current_config==injected:replace_from_prepared(backups[config],config)
        elif current_config==original:pass
        else:preserve=True
        current=next_env.read_bytes() if next_env.exists() else None
        generated=original_env.replace(b'./.next/types/',b'./.next-live-owner-fixture/dev/types/')
        if prepared and current==generated and current!=original_env:replace_from_prepared(backups[next_env],next_env)
        elif current==original_env:pass
        else:preserve=True
        ts_generated=original_ts.replace(b'".next/dev/types/**/*.ts"\n',b'".next/dev/types/**/*.ts",\n    ".next-live-owner-fixture/types/**/*.ts",\n    ".next-live-owner-fixture/dev/types/**/*.ts"\n')
        current_ts=tsconfig.read_bytes() if tsconfig.exists() else None
        if prepared and current_ts==ts_generated and current_ts!=original_ts:replace_from_prepared(backups[tsconfig],tsconfig)
        elif current_ts==original_ts:pass
        else:preserve=True
        if (fixture/'.fixture').read_text()!=MARKER:raise RuntimeError('fixture marker changed; preserve everything')
        if preserve:raise RuntimeError(f'configuration changed; fixture retained at {fixture}')
        if cache.exists():shutil.rmtree(cache)
        shutil.rmtree(fixture)
        print('Owned fixture process and synthetic files cleaned up.',flush=True)

if __name__=='__main__':main()
