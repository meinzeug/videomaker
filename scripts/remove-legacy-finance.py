#!/usr/bin/env python3
"""Explicit offline cleanup of empty legacy tables; never run at app startup."""
import argparse
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys


TABLES = (
    "ug_ledger_finance_unlink_requests", "ug_ledger_finance_link_requests",
    "ug_ledger_finance_unlinks", "ug_ledger_finance_links",
    "ug_ledger_document_unlinks", "ug_ledger_document_links",
    "ug_ledger_journals", "ug_ledger_accounts", "finance_documents",
    "finance_settings_events", "finance_entries",
)
SQL_PATH = Path(__file__).with_suffix(".sql")


def check_ancestor_chain(directory: Path, trusted_owner: int) -> None:
    child = directory
    trusted = {0, os.geteuid(), trusted_owner}
    for ancestor in directory.parents:
        info = ancestor.stat()
        child_info = child.stat(follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in trusted:
            raise ValueError("Ein übergeordnetes Verzeichnis gehört keinem vertrauenswürdigen Benutzer.")
        if info.st_mode & 0o022:
            if not (info.st_mode & stat.S_ISVTX and child_info.st_uid in trusted):
                raise ValueError("Ein übergeordnetes Verzeichnis erlaubt fremden Dateiaustausch.")
        child = ancestor


def connect_existing(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(path.resolve(strict=True).as_uri() + "?mode=rw", uri=True, timeout=5)


def checked_source(path: Path) -> tuple[Path, os.stat_result]:
    if path.is_symlink():
        raise ValueError("Der Datenbankpfad darf kein symbolischer Link sein.")
    source = path.resolve(strict=True)
    info = source.stat()
    parent = source.parent.stat()
    if not stat.S_ISREG(info.st_mode) or not stat.S_ISDIR(parent.st_mode):
        raise ValueError("Die Quelldatenbank muss eine reguläre Datei sein.")
    if parent.st_mode & 0o077 or parent.st_uid != info.st_uid or (os.geteuid() != 0 and parent.st_uid != os.geteuid()):
        raise ValueError("Das Datenbankverzeichnis muss dem Datenbankeigentümer gehören und für andere gesperrt sein.")
    check_ancestor_chain(source.parent, parent.st_uid)
    return source, info


def same_source(path: Path, expected: os.stat_result) -> None:
    current = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) != (expected.st_dev, expected.st_ino):
        raise ValueError("Die Quelldatenbank wurde während der Bereinigung ausgetauscht.")


def checked_backup_target(source: Path, target: Path) -> Path:
    parent = target.parent.resolve(strict=True)
    info = parent.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("Das Sicherungsverzeichnis muss dem ausführenden Benutzer gehören und für andere gesperrt sein.")
    check_ancestor_chain(parent, info.st_uid)
    candidate = parent / target.name
    lower = candidate.name.lower()
    if lower.endswith(("-journal", "-wal", "-shm")) or re.search(r"-mj[0-9a-f]+$", lower):
        raise ValueError("SQLite-Nebendateien dürfen nicht als Sicherungsziel verwendet werden.")
    if candidate.parent == source.parent and (candidate.name == source.name or
            candidate.name.startswith(source.name + "-") or source.name.startswith(candidate.name + "-")):
        raise ValueError("Datenbank und Sicherung dürfen keine überlappenden Dateinamen haben.")
    return candidate


def checked_statements() -> list[str]:
    statements = [line.strip() for line in SQL_PATH.read_text(encoding="utf-8").splitlines()
                  if line.strip() and not line.lstrip().startswith("--")]
    expected = [f"DROP TABLE IF EXISTS {table};" for table in TABLES]
    if statements != expected:
        raise ValueError("Migrationsdatei stimmt nicht mit dem geprüften Tabellenumfang überein.")
    return statements


def inspect(connection: sqlite3.Connection) -> dict[str, int]:
    rows = connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL").fetchall()
    actual = {name for kind, name, _, _ in rows if kind == "table" and
              (name.lower().startswith("finance_") or name.lower().startswith("ug_ledger_"))}
    unexpected = actual.difference(TABLES)
    if unexpected:
        raise ValueError("Unbekannte alte Tabellen gefunden: " + ", ".join(sorted(unexpected)))
    pattern = re.compile(r"\b(?:finance_|ug_ledger_)", re.IGNORECASE)
    for kind, name, owner, sql in rows:
        if (kind == "table" and name in actual) or (kind in ("index", "trigger") and owner in actual):
            continue
        if pattern.search(sql):
            raise ValueError(f"Ein weiteres Datenbankobjekt verweist auf die alten Tabellen: {kind} {name}")
    counts = {name: connection.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
              for name in TABLES if name in actual}
    nonempty = {name: count for name, count in counts.items() if count}
    if nonempty:
        raise ValueError("Alte Tabellen enthalten Daten; keine Bereinigung: " +
                         ", ".join(f"{name}={count}" for name, count in nonempty.items()))
    return counts


def backup_database(source_path: Path, target_path: Path) -> None:
    # O_EXCL avoids overwriting an existing backup or following a symlink.
    fd = os.open(target_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    source = connect_existing(source_path)
    dest = sqlite3.connect(target_path)
    try:
        source.backup(dest)
        if dest.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Datenbanksicherung hat die Integritätsprüfung nicht bestanden.")
    finally:
        dest.close()
        source.close()
    fd = os.open(target_path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    fd = os.open(target_path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="Pfad zur bestehenden Videomaker-SQLite-Datenbank")
    parser.add_argument("--apply", action="store_true", help="Bereinigung ausdrücklich ausführen; sonst nur prüfen")
    parser.add_argument("--backup", type=Path, help="Neuer, noch nicht existierender Pfad für SQLite-Backup")
    args = parser.parse_args()
    if args.apply and args.backup is None:
        parser.error("--apply benötigt --backup")
    statements = checked_statements()
    source_path, source_identity = checked_source(args.database)
    backup_path = checked_backup_target(source_path, args.backup) if args.apply else None
    connection = connect_existing(source_path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("BEGIN IMMEDIATE")
        same_source(source_path, source_identity)
        counts = inspect(connection)
        if args.apply:
            backup_database(source_path, backup_path)
            same_source(source_path, source_identity)
            for statement in statements:
                connection.execute(statement)
            same_source(source_path, source_identity)
            connection.commit()
            print(f"{len(counts)} leere Tabellen entfernt; geprüfte Sicherung: {backup_path}")
        else:
            connection.rollback()
            print(f"Prüfung bestanden: {len(counts)} vorhandene Legacy-Tabellen sind leer; nichts verändert.")
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, sqlite3.Error, ValueError) as error:
        print(f"Bereinigung nicht ausgeführt: {error}", file=sys.stderr)
        raise SystemExit(1)
