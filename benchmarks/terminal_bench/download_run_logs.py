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
import sys
from pathlib import Path

try:
    from .tbench_utils import (
        download_run_artifacts,
        extract_task_id,
        get_passed,
        list_nightly_runs,
    )
except ImportError:
    from tbench_utils import (  # type: ignore[import-not-found,no-redef]
        download_run_artifacts,
        extract_task_id,
        get_passed,
        list_nightly_runs,
    )

CACHE_DIR = Path(__file__).parent / ".run_logs"


def find_trial_results(run_dir: Path) -> list[dict]:
    """Find all trial results in a downloaded run directory.

    Derives task/trial identifiers from folder structure (like analyze_failure_rates.py)
    rather than requiring them in the JSON, since some results omit these fields.
    """
    import re

    # Job-level folders use timestamp format: YYYY-MM-DD__HH-MM-SS
    timestamp_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}__\d{2}-\d{2}-\d{2}$")

    results = []
    for result_file in run_dir.rglob("result.json"):
        # Skip job-level result.json files (in jobs/<timestamp>/ directly)
        if timestamp_pattern.match(result_file.parent.name):
            continue
        # Skip if parent is 'logs' or 'output'
        if result_file.parent.name in ("logs", "output", "verifier", "agent"):
            continue

        try:
            data = json.loads(result_file.read_text())

            # Derive task_name from folder structure (format: task-name__HASH)
            # Fall back to JSON field if present
            trial_folder = result_file.parent.name
            task_name = data.get("task_name") or extract_task_id(trial_folder)
            trial_name = data.get("trial_name") or trial_folder

            results.append(
                {
                    "path": result_file,
                    "task_name": task_name,
                    "trial_name": trial_name,
                    "passed": get_passed(data),
                    "data": data,
                }
            )
        except (json.JSONDecodeError, OSError):
            continue

    return sorted(results, key=lambda x: x["task_name"])


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
        # Get latest completed run (not in-progress)
        runs = list_nightly_runs(limit=5)
        completed_runs = [
            r for r in runs if r.get("conclusion") in ("success", "failure")
        ]
        if not completed_runs:
            print("No completed runs found", file=sys.stderr)
            return 1
        run_id = completed_runs[0]["databaseId"]
        print(f"Using latest completed run: {run_id}")

    # Download if needed - include smoke test artifacts for log inspection
    run_dir = args.output_dir / str(run_id)
    if not run_dir.exists():
        if not download_run_artifacts(
            run_id, run_dir, include_smoke_test=True, verbose=True
        ):
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
