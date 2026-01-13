from __future__ import annotations

import io
import tarfile
from pathlib import Path
from typing import Iterable


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
