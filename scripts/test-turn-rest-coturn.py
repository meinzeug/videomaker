#!/usr/bin/env python3
"""Integration fixture: generated TURN REST credentials against local coturn.

Run from the repository with coturn's turnserver/turnutils_uclient and Node
with --experimental-strip-types installed. Never use with real credentials.
"""
import base64
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
TURN = shutil.which('turnserver')
CLIENT = shutil.which('turnutils_uclient')
NODE = shutil.which('node')
if not TURN or not CLIENT or not NODE:
    raise SystemExit('Required: turnserver, turnutils_uclient and node.')


def listener_port():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def relay_ports(listener):
    for start in (62000, 62100, 62200, 62300, 62400, 62500):
        if start <= listener < start + 32:
            continue
        sockets = []
        try:
            for port in range(start, start + 32):
                sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                sockets.append(sock)
                sock.bind(('127.0.0.1', port))
            return start, start + 31
        except OSError:
            pass
        finally:
            for sock in sockets:
                sock.close()
    raise RuntimeError('No isolated relay port range available.')


def credential(secret, now):
    program = '''import {issueTurnRestCredential} from "./lib/turn-rest-credentials.ts";
let input="";for await(const chunk of process.stdin)input+=chunk;
const v=JSON.parse(input);process.stdout.write(JSON.stringify(issueTurnRestCredential(Buffer.from(v.secret),v.now,300)));'''
    result = subprocess.run(
        [NODE, '--experimental-strip-types', '--input-type=module', '-e', program],
        cwd=ROOT, input=json.dumps({'secret': secret, 'now': now}), text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=15,
    )
    return json.loads(result.stdout)


def main():
    secret = secrets.token_urlsafe(32)
    now = int(time.time())
    valid = credential(secret, now)
    invalid = dict(valid, credential='invalid-fixture-credential')
    expired = credential(secret, now - 600)
    port = listener_port()
    first, last = relay_ports(port)
    with tempfile.TemporaryDirectory(prefix='videomaker-turn-fixture-') as temp:
        directory = Path(temp)
        config = directory / 'turn.conf'
        config.write_text('\n'.join([
            'listening-ip=127.0.0.1', 'relay-ip=127.0.0.1',
            f'listening-port={port}', f'min-port={first}', f'max-port={last}',
            'realm=videomaker-fixture.invalid', 'use-auth-secret',
            'static-auth-secret=' + secret, 'no-tls', 'no-dtls', 'no-tcp',
            'no-cli', 'no-tcp-relay', 'no-multicast-peers',
            # Loopback peer traffic is explicitly limited to this local fixture.
            'allow-loopback-peers', 'user-quota=8', 'total-quota=8',
            'relay-threads=1', 'no-stdout-log', f'log-file={directory / "turn.log"}',
        ]) + '\n')
        config.chmod(0o600)
        server = subprocess.Popen([TURN, '-c', str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            # Binding request tests the fixture listener without printing credentials.
            request = b'\x00\x01\x00\x00\x21\x12\xa4\x42' + os.urandom(12)
            ready = False
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.settimeout(0.3)
                for _ in range(30):
                    if server.poll() is not None:
                        raise RuntimeError('coturn fixture exited before it was ready.')
                    probe.sendto(request, ('127.0.0.1', port))
                    try:
                        response, _ = probe.recvfrom(1024)
                        ready = response[:2] == b'\x01\x01' and response[8:20] == request[8:20]
                        if ready:
                            break
                    except TimeoutError:
                        pass
            if not ready:
                raise RuntimeError('coturn fixture did not respond.')
            for label, item in [('valid', valid), ('invalid', invalid), ('expired', expired)]:
                result = subprocess.run(
                    [CLIENT, '-y', '-c', '-n', '2', '-p', str(port),
                     '-u', item['username'], '-w', item['credential'], '127.0.0.1'],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=20,
                )
                if label == 'valid':
                    passed = result.returncode == 0 and 'Total lost packets 0' in result.stdout
                else:
                    passed = result.returncode != 0
                if not passed:
                    raise RuntimeError(label + ' credential test failed; fixture output withheld.')
                print(label + ': PASS', flush=True)
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
    print('fixture removed: PASS')


if __name__ == '__main__':
    main()
