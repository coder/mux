#!/usr/bin/env python3
"""
Download and inspect Terminal-Bench run logs for failure analysis.

This script downloads artifacts from GitHub Actions nightly runs and provides
utilities to inspect agent logs, verifier output, and failure details.

Usage:
    # Download latest nightly run
    python download_run_logs.py

    # Download specific run
    python download_run_logs.py --run-id 21230456195

    # Download and filter to specific task
    python download_run_logs.py --task feal-differential-cryptanalysis

    # Download and filter to specific model
    python download_run_logs.py --model claude-opus-4-5

    # List available runs without downloading
    python download_run_logs.py --list-runs

    # Show failures only
    python download_run_logs.py --failures-only

Prerequisites:
    - GitHub CLI (gh) installed and authenticated
    - Access to coder/mux repository

Output structure:
    .run_logs/<run-id>/
        <artifact-name>/
            jobs/<timestamp>/
                trials/
                    <task-name>__<hash>/
                        result.json      # Trial result with pass/fail
                        agent/           # Agent execution logs
                            command-0/
                                command.txt
                                stdout.txt
                                stderr.txt
                        verifier/        # Verifier output
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

GITHUB_REPO = "coder/mux"
CACHE_DIR = Path(__file__).parent / ".run_logs"


def run_command(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    """Run a command and return the result."""
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


def list_nightly_runs(limit: int = 10) -> list[dict]:
    """List recent nightly Terminal-Bench runs."""
    result = run_command(
        [
            "gh",
            "run",
            "list",
            f"--repo={GITHUB_REPO}",
            "--workflow=nightly-terminal-bench.yml",
            f"--limit={limit}",
            "--json=databaseId,status,conclusion,createdAt,displayTitle",
        ],
        check=False,
    )
    if result.returncode != 0:
        print(f"Error listing runs: {result.stderr}", file=sys.stderr)
        return []
    return json.loads(result.stdout)


def list_artifacts_for_run(run_id: int) -> list[dict]:
    """List all terminal-bench artifacts for a given run."""
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
    )
    if result.returncode != 0:
        print(f"Error listing artifacts: {result.stderr}", file=sys.stderr)
        return []

    artifacts = []
    for line in result.stdout.strip().split("\n"):
        if line:
            artifacts.append(json.loads(line))
    return artifacts


def download_artifacts(run_id: int, output_dir: Path) -> bool:
    """Download all terminal-bench artifacts for a run."""
    artifacts = list_artifacts_for_run(run_id)
    if not artifacts:
        print(f"No artifacts found for run {run_id}", file=sys.stderr)
        return False

    print(f"Downloading {len(artifacts)} artifact(s) to {output_dir}...")
    output_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        "gh",
        "run",
        "download",
        str(run_id),
        f"--repo={GITHUB_REPO}",
        f"--dir={output_dir}",
    ]
    for artifact in artifacts:
        cmd.extend(["--name", artifact["name"]])

    result = run_command(cmd, check=False)
    if result.returncode != 0:
        print(f"Error downloading: {result.stderr}", file=sys.stderr)
        return False

    return True


def find_trial_results(run_dir: Path) -> list[dict]:
    """Find all trial results in a downloaded run directory.

    Derives task/trial identifiers from folder structure (like analyze_failure_rates.py)
    rather than requiring them in the JSON, since some results omit these fields.
    """
    results = []
    for result_file in run_dir.rglob("result.json"):
        # Skip job-level result.json files (in jobs/<timestamp>/ directly)
        if result_file.parent.name.startswith("20"):  # Timestamp pattern
            continue
        # Skip if parent is 'logs' or 'output'
        if result_file.parent.name in ("logs", "output", "verifier", "agent"):
            continue

        try:
            data = json.loads(result_file.read_text())

            # Derive task_name from folder structure (format: task-name__HASH)
            # Fall back to JSON field if present
            trial_folder = result_file.parent.name
            task_name = data.get("task_name") or trial_folder.rsplit("__", 1)[0]
            trial_name = data.get("trial_name") or trial_folder

            results.append(
                {
                    "path": result_file,
                    "task_name": task_name,
                    "trial_name": trial_name,
                    "passed": _get_passed(data),
                    "data": data,
                }
            )
        except (json.JSONDecodeError, OSError):
            continue

    return sorted(results, key=lambda x: x["task_name"])


def _get_passed(data: dict) -> bool | None:
    """Extract pass/fail status from result data.

    Mirrors the logic in analyze_failure_rates.py to handle all result formats:
    - data["passed"] (explicit boolean)
    - data["score"] > 0
    - data["verifier_result"]["passed"]
    - data["verifier_result"]["rewards"]["reward"] > 0
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


def print_trial_summary(trial: dict, verbose: bool = False) -> None:
    """Print a summary of a trial result."""
    status = (
        "✓ PASS"
        if trial["passed"]
        else "✗ FAIL"
        if trial["passed"] is False
        else "? UNKNOWN"
    )
    print(f"  {status}  {trial['task_name']}")

    if verbose or not trial["passed"]:
        result_path = trial["path"]
        trial_dir = result_path.parent

        # Check for agent logs
        agent_dir = trial_dir / "agent"
        if agent_dir.exists():
            for cmd_dir in sorted(agent_dir.iterdir()):
                if cmd_dir.is_dir() and cmd_dir.name.startswith("command-"):
                    stdout_file = cmd_dir / "stdout.txt"
                    stderr_file = cmd_dir / "stderr.txt"
                    if stderr_file.exists():
                        stderr = stderr_file.read_text().strip()
                        if stderr:
                            # Show last 10 lines of stderr
                            lines = stderr.split("\n")[-10:]
                            print(f"         stderr (last {len(lines)} lines):")
                            for line in lines:
                                print(f"           {line[:100]}")

        # Check for exception info
        data = trial["data"]
        if data.get("exception_info"):
            print(f"         exception: {data['exception_info']}")

        # Show verifier result
        vr = data.get("verifier_result", {})
        if vr and not trial["passed"]:
            print(f"         verifier: {json.dumps(vr.get('rewards', {}))}")


def main():
    parser = argparse.ArgumentParser(
        description="Download and inspect Terminal-Bench run logs"
    )
    parser.add_argument(
        "--run-id", type=int, help="Specific run ID to download (default: latest)"
    )
    parser.add_argument(
        "--list-runs", action="store_true", help="List recent runs without downloading"
    )
    parser.add_argument(
        "--task", type=str, help="Filter to specific task name (substring match)"
    )
    parser.add_argument(
        "--model",
        type=str,
        help="Filter to specific model (substring match on artifact name)",
    )
    parser.add_argument(
        "--failures-only", action="store_true", help="Show only failed trials"
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Show detailed output for all trials",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=CACHE_DIR,
        help=f"Output directory (default: {CACHE_DIR})",
    )
    args = parser.parse_args()

    # List runs mode
    if args.list_runs:
        runs = list_nightly_runs()
        if not runs:
            print("No runs found")
            return 1
        print("Recent nightly runs:")
        for run in runs:
            status = "✓" if run["conclusion"] == "success" else "✗"
            print(
                f"  {status} {run['databaseId']}  {run['createdAt'][:10]}  {run['displayTitle']}"
            )
        return 0

    # Determine run ID
    if args.run_id:
        run_id = args.run_id
    else:
        runs = list_nightly_runs(limit=1)
        if not runs:
            print("No runs found", file=sys.stderr)
            return 1
        run_id = runs[0]["databaseId"]
        print(f"Using latest run: {run_id}")

    # Download if needed
    run_dir = args.output_dir / str(run_id)
    if not run_dir.exists():
        if not download_artifacts(run_id, run_dir):
            return 1
    else:
        print(f"Using cached run data from {run_dir}")

    # Find and filter results
    results = find_trial_results(run_dir)

    if args.task:
        results = [r for r in results if args.task.lower() in r["task_name"].lower()]

    if args.model:
        # Filter by checking the artifact path
        def matches_model(r):
            path_str = str(r["path"]).lower()
            return args.model.lower().replace("/", "-") in path_str

        results = [r for r in results if matches_model(r)]

    if args.failures_only:
        results = [r for r in results if r["passed"] is False]

    if not results:
        print("No matching results found")
        return 0

    # Group by model (artifact name)
    by_model: dict[str, list[dict]] = {}
    for r in results:
        # Extract model from path
        parts = r["path"].parts
        model = "unknown"
        for p in parts:
            if p.startswith("terminal-bench-results-"):
                model = p.replace("terminal-bench-results-", "")
                break
        by_model.setdefault(model, []).append(r)

    # Print results
    for model, trials in sorted(by_model.items()):
        passed = sum(1 for t in trials if t["passed"])
        total = len(trials)
        print(f"\n{model}: {passed}/{total} passed")
        for trial in trials:
            if not args.failures_only or not trial["passed"]:
                print_trial_summary(trial, verbose=args.verbose)

    return 0


if __name__ == "__main__":
    sys.exit(main())
