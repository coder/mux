"""
Shared utilities for Terminal-Bench scripts.

This module consolidates common functionality used by:
- analyze_failure_rates.py
- download_run_logs.py
- prepare_leaderboard_submission.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

# GitHub repository for fetching artifacts
GITHUB_REPO = "coder/mux"

# Smoke test model - excluded from submissions by default
SMOKE_TEST_MODEL = "anthropic/claude-sonnet-4-5"


def run_command(
    cmd: list[str], check: bool = True, verbose: bool = False
) -> subprocess.CompletedProcess:
    """Run a shell command and return the result.

    Args:
        cmd: Command and arguments to run
        check: If True, raise CalledProcessError on non-zero exit
        verbose: If True, print the command being run
    """
    if verbose:
        print(f"  Running: {' '.join(cmd)}")
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


def get_passed(data: dict) -> bool | None:
    """Extract pass/fail status from Terminal-Bench result data.

    Handles all result formats:
    - data["passed"] (explicit boolean)
    - data["score"] > 0
    - data["verifier_result"]["passed"]
    - data["verifier_result"]["rewards"]["reward"] > 0

    Returns:
        True if passed, False if failed, None if status cannot be determined
    """
    if "passed" in data and data["passed"] is not None:
        return data["passed"]
    if "score" in data:
        return float(data.get("score", 0)) > 0
    vr = data.get("verifier_result")
    if vr is not None:
        if "passed" in vr:
            return bool(vr["passed"])
        if "rewards" in vr:
            return float(vr["rewards"].get("reward", 0)) > 0
    return None


def extract_task_id(folder_name: str) -> str:
    """Extract task ID from a trial folder name.

    Folder format: task-name__HASH (e.g., chess-best-move__ABC123)
    Returns the task name without the hash suffix.
    """
    return folder_name.rsplit("__", 1)[0] if "__" in folder_name else folder_name


def list_nightly_runs(
    limit: int = 10, status: str | None = None, verbose: bool = False
) -> list[dict]:
    """List recent nightly Terminal-Bench runs.

    Args:
        limit: Maximum number of runs to return
        status: Filter by status (e.g., "success", "failure")
        verbose: If True, print commands being run
    """
    cmd = [
        "gh",
        "run",
        "list",
        f"--repo={GITHUB_REPO}",
        "--workflow=nightly-terminal-bench.yml",
        f"--limit={limit}",
        "--json=databaseId,status,conclusion,createdAt,displayTitle",
    ]
    if status:
        cmd.append(f"--status={status}")

    result = run_command(cmd, check=False, verbose=verbose)
    if result.returncode != 0:
        print(f"Error listing runs: {result.stderr}", file=sys.stderr)
        return []
    return json.loads(result.stdout)


def list_artifacts_for_run(
    run_id: int, include_smoke_test: bool = False, verbose: bool = False
) -> list[dict]:
    """List all terminal-bench artifacts for a given run.

    Args:
        run_id: GitHub Actions run ID
        include_smoke_test: If False, exclude smoke test artifact (claude-sonnet-4-5)
        verbose: If True, print commands being run
    """
    result = run_command(
        [
            "gh",
            "api",
            f"repos/{GITHUB_REPO}/actions/runs/{run_id}/artifacts",
            "--jq",
            '.artifacts[] | select(.name | startswith("terminal-bench-results")) '
            "| {name, id, size_in_bytes}",
        ],
        check=False,
        verbose=verbose,
    )
    if result.returncode != 0:
        print(f"Error listing artifacts: {result.stderr}", file=sys.stderr)
        return []

    artifacts = []
    for line in result.stdout.strip().split("\n"):
        if line:
            artifact = json.loads(line)
            # Filter out smoke test artifact unless explicitly included
            if not include_smoke_test:
                smoke_test_pattern = SMOKE_TEST_MODEL.replace("/", "-")
                if smoke_test_pattern in artifact["name"]:
                    continue
            artifacts.append(artifact)
    return artifacts


def download_run_artifacts(
    run_id: int,
    output_dir: Path,
    artifact_names: list[str] | None = None,
    include_smoke_test: bool = False,
    verbose: bool = False,
) -> bool:
    """Download terminal-bench artifacts for a run.

    Args:
        run_id: GitHub Actions run ID
        output_dir: Directory to download artifacts to
        artifact_names: Specific artifact names to download, or None for all
        include_smoke_test: If True, include smoke test artifact (for log inspection)
        verbose: If True, print commands being run

    Returns:
        True if download succeeded, False otherwise
    """
    if artifact_names is None:
        artifacts = list_artifacts_for_run(
            run_id, include_smoke_test=include_smoke_test, verbose=verbose
        )
        if not artifacts:
            print(f"No artifacts found for run {run_id}", file=sys.stderr)
            return False
        artifact_names = [a["name"] for a in artifacts]

    if verbose:
        print(f"Downloading {len(artifact_names)} artifact(s) to {output_dir}...")
    output_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        "gh",
        "run",
        "download",
        str(run_id),
        f"--repo={GITHUB_REPO}",
        f"--dir={output_dir}",
    ]
    for name in artifact_names:
        cmd.extend(["--name", name])

    result = run_command(cmd, check=False, verbose=verbose)
    if result.returncode != 0:
        print(f"Error downloading: {result.stderr}", file=sys.stderr)
        return False

    return True
