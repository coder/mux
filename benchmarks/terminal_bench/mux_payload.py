from __future__ import annotations

import io
import tarfile
import tempfile
from pathlib import Path
from typing import Iterable

from terminal_bench.terminal.tmux_session import TmuxSession


def build_app_archive(repo_root: Path, include_paths: Iterable[str]) -> bytes:
    """Pack the mux workspace into a gzipped tarball."""
    if not repo_root.exists():
        raise FileNotFoundError(f"mux repo root {repo_root} not found")

    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for relative_path in include_paths:
            source = repo_root / relative_path
            if not source.exists():
                raise FileNotFoundError(f"Required file {source} missing")
            archive.add(source, arcname=relative_path, recursive=True)
    return buffer.getvalue()


def stage_payload(
    session: TmuxSession,
    archive_bytes: bytes,
    archive_name: str,
    runner_path: Path,
) -> None:
    """Copy the mux bundle and runner into the task container."""
    with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as temp_file:
        temp_file.write(archive_bytes)
        temp_path = Path(temp_file.name)

    try:
        session.copy_to_container(temp_path, "/installed-agent", archive_name)
    finally:
        temp_path.unlink(missing_ok=True)

    session.copy_to_container(runner_path, "/installed-agent", runner_path.name)
