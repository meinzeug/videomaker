#!/usr/bin/env python3
"""Install one already verified APK atomically; never extract or execute it."""
import argparse
import fcntl
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets
import stat

MAX_BYTES = 512 * 1024 * 1024
TARGET = 'kontraprompter.apk'


class InstallationUncertain(OSError):
    """Replacement completed but durability could not be confirmed."""


def install(source: Path, data_dir: Path, expected_sha256: str) -> None:
    if not re.fullmatch(r'[0-9a-f]{64}', expected_sha256):
        raise ValueError('Ungültige SHA-256-Prüfsumme')
    directory = os.open(data_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    temp_name = None
    try:
        folder = os.fstat(directory)
        if folder.st_mode & 0o022:
            raise ValueError('Datenverzeichnis ist für andere Benutzer beschreibbar')
        if os.geteuid() not in (0, folder.st_uid):
            raise ValueError('Datenverzeichnis gehört einem anderen Benutzer')
        lock = os.open('.kontraprompter-apk.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
        lock_stat = os.fstat(lock)
        if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_uid not in (0, folder.st_uid) or lock_stat.st_nlink != 1:
            raise ValueError('Ungültige Installationssperre')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if os.geteuid() == 0 and lock_stat.st_uid == 0:
            os.fchown(lock, folder.st_uid, folder.st_gid)
        os.fchmod(lock, 0o600)
        try:
            previous = os.stat(TARGET, dir_fd=directory, follow_symlinks=False)
            if not stat.S_ISREG(previous.st_mode):
                raise ValueError('Vorhandene APK ist keine reguläre Datei')
        except FileNotFoundError:
            pass
        source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(source_fd)
            if not stat.S_ISREG(info.st_mode) or not 4 <= info.st_size <= MAX_BYTES:
                raise ValueError('Ungültige Quelldatei')
            temp_name = '.kontraprompter-apk-' + secrets.token_hex(16)
            temp_fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            try:
                if os.geteuid() == 0:
                    os.fchown(temp_fd, folder.st_uid, folder.st_gid)
                os.fchmod(temp_fd, 0o600)
                digest = hashlib.sha256()
                total = 0
                prefix = b''
                with os.fdopen(temp_fd, 'wb') as out:
                    temp_fd = None
                    while chunk := os.read(source_fd, 1024 * 1024):
                        total += len(chunk)
                        if total > MAX_BYTES:
                            raise ValueError('APK ist zu groß')
                        if len(prefix) < 4:
                            prefix = (prefix + chunk)[:4]
                        digest.update(chunk)
                        out.write(chunk)
                    out.flush()
                    os.fsync(out.fileno())
                if total != info.st_size or prefix != b'PK\x03\x04' or not hmac.compare_digest(digest.hexdigest(), expected_sha256):
                    raise ValueError('APK stimmt nicht mit der geprüften Datei überein')
                os.replace(temp_name, TARGET, src_dir_fd=directory, dst_dir_fd=directory)
                temp_name = None
                try:
                    os.fsync(directory)
                except OSError as error:
                    raise InstallationUncertain('APK ausgetauscht, dauerhafte Speicherung konnte nicht bestätigt werden') from error
            finally:
                if temp_fd is not None:
                    os.close(temp_fd)
        finally:
            os.close(source_fd)
    finally:
        if temp_name is not None:
            try:
                os.unlink(temp_name, dir_fd=directory)
            except FileNotFoundError:
                pass
        if lock is not None:
            os.close(lock)
        os.close(directory)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('data_dir', type=Path)
    parser.add_argument('sha256')
    args = parser.parse_args()
    try:
        install(args.source, args.data_dir, args.sha256)
    except InstallationUncertain as error:
        parser.exit(1, f'Ergebnis prüfen: {error}\n')
    except (OSError, ValueError) as error:
        parser.exit(1, f'APK wurde nicht bereitgestellt: {error}\n')
    print('Geprüfte APK atomar bereitgestellt.')


if __name__ == '__main__':
    main()
