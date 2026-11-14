#!/usr/bin/env python3
"""Build and verify an isolated KontraPrompter debug candidate, without deploying it."""
import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile
import tempfile

PACKAGE = 'de.kontrakurs.kontraprompter'
MAX_APK_BYTES = 512 * 1024 * 1024
TRUSTED_ORIGINS = {'https://www.github.com/meinzeug/kontraprompter',
                   'https://github.com/meinzeug/kontraprompter',
                   'https://github.com/meinzeug/kontraprompter.git',
                   'git@github.com:meinzeug/kontraprompter.git'}


def output(args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=120).stdout.strip()


def checked_head(repo):
    if output(['git', 'remote', 'get-url', 'origin'], repo) not in TRUSTED_ORIGINS:
        raise ValueError('Unbekanntes KontraPrompter-Git-Repository')
    if output(['git', 'branch', '--show-current'], repo) != 'main':
        raise ValueError('KontraPrompter muss auf main stehen')
    if output(['git', 'status', '--porcelain', '--untracked-files=no'], repo):
        raise ValueError('KontraPrompter enthält nicht commitete Änderungen')
    commit = output(['git', 'rev-parse', 'HEAD'], repo)
    remote = output(['git', 'ls-remote', '--exit-code', 'origin', 'refs/heads/main'], repo).split()
    if not re.fullmatch(r'[a-f0-9]{40}', commit) or len(remote) != 2 or remote != [commit, 'refs/heads/main']:
        raise ValueError('Lokaler Stand entspricht nicht dem aktuellen GitHub-main')
    return commit


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def copy_candidate(source, target):
    """Copy a bounded regular file without following a build-output symlink."""
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    created = False
    try:
        info = os.fstat(source_fd)
        if not stat.S_ISREG(info.st_mode) or not 4 <= info.st_size <= MAX_APK_BYTES:
            raise ValueError('Build-Ausgabe ist keine begrenzte reguläre APK-Datei')
        target_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        created = True
        try:
            os.fchmod(target_fd, 0o600)
            with os.fdopen(target_fd, 'wb') as stream:
                target_fd = None
                total = 0
                while chunk := os.read(source_fd, 1024 * 1024):
                    total += len(chunk)
                    if total > MAX_APK_BYTES:
                        raise ValueError('Build-Ausgabe überschreitet die maximale APK-Größe')
                    stream.write(chunk)
                if total != info.st_size:
                    raise ValueError('Build-Ausgabe hat sich während des Kopierens verändert')
        finally:
            if target_fd is not None:
                os.close(target_fd)
    except BaseException:
        if created:
            try:
                os.unlink(target)
            except FileNotFoundError:
                pass
        raise
    finally:
        os.close(source_fd)


def rename_noreplace(source, target):
    """Atomically publish a directory without replacing any existing path (Linux)."""
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        renameat2 = libc.renameat2
    except AttributeError as error:
        raise OSError(errno.ENOSYS, 'Sicheres Umbenennen ohne Überschreiben wird nicht unterstützt') from error
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:  # AT_FDCWD, RENAME_NOREPLACE
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(target))


def verify(apk, sdk, expected_signer):
    if not re.fullmatch(r'[a-f0-9]{64}', expected_signer):
        raise ValueError('Signatur-Fingerabdruck muss aus 64 Hex-Zeichen bestehen')
    if not apk.is_file() or apk.is_symlink() or not 4 <= apk.stat().st_size <= MAX_APK_BYTES:
        raise ValueError('APK ist keine gültige Datei')
    # Bind the verifier results to the same bytes that will be published.
    before = sha256(apk)
    tools = sdk / 'build-tools' / '35.0.0'
    sign = output([str(tools / 'apksigner'), 'verify', '--verbose', '--print-certs', str(apk)])
    fingerprints = re.findall(r'^Signer #(\d+) certificate SHA-256 digest: ([0-9a-fA-F]{64})$', sign, re.MULTILINE)
    if len(fingerprints) != 1 or fingerprints[0][0] != '1' or fingerprints[0][1].lower() != expected_signer:
        raise ValueError('APK-Signatur stimmt nicht mit der freigegebenen Signatur überein')
    badging = output([str(tools / 'aapt'), 'dump', 'badging', str(apk)])
    line = badging.splitlines()[0] if badging else ''
    match = re.match(r"package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']*)'", line)
    if not match or match.group(1) != PACKAGE or int(match.group(2)) < 1:
        raise ValueError('APK-Paketname oder Version ist ungültig')
    after = sha256(apk)
    if before != after:
        raise ValueError('APK wurde während der Signaturprüfung verändert')
    return {'package': PACKAGE, 'versionCode': int(match.group(2)), 'versionName': match.group(3),
            'signerSha256': expected_signer, 'sha256': after, 'size': apk.stat().st_size}


def prepare(repo, sdk, out, signer):
    repo, sdk, out = repo.resolve(strict=True), sdk.resolve(strict=True), out.resolve(strict=True)
    if out == repo or repo in out.parents or out.stat().st_uid != os.geteuid() or out.stat().st_mode & 0o077:
        raise ValueError('Ausgabeverzeichnis muss privat sein und außerhalb des App-Repositories liegen')
    commit = checked_head(repo)
    final = out / commit
    if final.exists() or final.is_symlink():
        raise ValueError('Für diesen Commit existiert bereits ein Kandidat')
    with tempfile.TemporaryDirectory(prefix='.kontraprompter-build-', dir=out) as temp:
        temporary = Path(temp)
        source = temporary / 'source'
        source.mkdir(mode=0o700)
        archive = temporary / 'source.tar'
        with archive.open('wb') as stream:
            subprocess.run(['git', 'archive', '--format=tar', commit], cwd=repo, stdout=stream, check=True, timeout=120)
        with tarfile.open(archive) as tar:
            tar.extractall(source, filter='data')
        env = dict(os.environ, ANDROID_HOME=str(sdk), ANDROID_SDK_ROOT=str(sdk))
        subprocess.run(['./gradlew', '--no-daemon', '--max-workers=1', '-Dorg.gradle.jvmargs=-Xmx768m',
                        '-Pkotlin.compiler.execution.strategy=in-process', '-Pkotlin.incremental=false',
                        'assembleDebug', 'testDebugUnitTest'], cwd=source, env=env, check=True, timeout=1800)
        apk = source / 'app/build/outputs/apk/debug/app-debug.apk'
        candidate = temporary / 'candidate'
        candidate.mkdir(mode=0o700)
        copy_candidate(apk, candidate / 'kontraprompter.apk')
        info = verify(candidate / 'kontraprompter.apk', sdk, signer)
        if checked_head(repo) != commit:
            raise ValueError('GitHub-main hat sich während des Builds geändert')
        if sha256(candidate / 'kontraprompter.apk') != info['sha256']:
            raise ValueError('APK wurde nach der Signaturprüfung verändert')
        manifest = {'commit': commit, 'buildType': 'debug', **info}
        (candidate / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        os.chmod(candidate / 'manifest.json', 0o600)
        # No existing candidate is replaced. The build directory is private to this user.
        rename_noreplace(candidate, final)
    return final


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--sdk', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--signer-sha256', required=True)
    args = parser.parse_args()
    try:
        result = prepare(args.repo, args.sdk, args.output_dir, args.signer_sha256.lower())
    except (OSError, ValueError, subprocess.SubprocessError, tarfile.TarError) as error:
        parser.exit(1, f'APK-Kandidat konnte nicht erstellt werden: {error}\n')
    print(f'Geprüfter Debug-Kandidat: {result}')
    print('Noch nicht bereitgestellt. Eine neue Version erfordert einen eigenen Lauf.')


if __name__ == '__main__':
    main()
