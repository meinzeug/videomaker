"""Preserve original fixture-worktree files before replacing them; same filesystem only."""
import os
from pathlib import Path


def sync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def durable_copy(path: Path, data: bytes) -> None:
    with path.open('xb') as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    sync_directory(path.parent)


def replace_from_prepared(prepared: Path, destination: Path) -> None:
    if prepared.stat().st_dev != destination.parent.stat().st_dev:
        raise RuntimeError('fixture backup must share the destination filesystem')
    os.replace(prepared, destination)
    sync_directory(destination.parent)
    if prepared.parent != destination.parent:
        sync_directory(prepared.parent)
