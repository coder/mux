#!/usr/bin/env python3
"""
Upload Terminal-Bench results to BigQuery.

Reads Harbor output from jobs/<timestamp>/ and uploads one row per trial
to the benchmarks.tbench_results table.

Usage:
    # Upload results from CI (uses GOOGLE_APPLICATION_CREDENTIALS)
    python scripts/upload-tbench-results.py

    # Dry run (print rows without uploading)
    python scripts/upload-tbench-results.py --dry-run

Environment variables (from GitHub Actions):
    GITHUB_RUN_ID, GITHUB_WORKFLOW, GITHUB_SHA, GITHUB_REF,
    GITHUB_ACTOR, GITHUB_EVENT_NAME
    GCP_PROJECT_ID (default: mux-benchmarks)
    BQ_DATASET (default: benchmarks)
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def find_job_folders() -> list[Path]:
    """Find all job folders in jobs/."""
    jobs_dir = Path("jobs")
    if not jobs_dir.exists():
        return []
    return sorted(d for d in jobs_dir.iterdir() if d.is_dir())


def load_json(path: Path) -> dict | None:
    """Load JSON file, return None on error."""
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def parse_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def build_rows(job_folder: Path) -> list[dict]:
    """Build BigQuery rows for all trials in a job folder."""
    # Load job-level files
    job_config = load_json(job_folder / "config.json") or {}
    job_result = load_json(job_folder / "result.json") or {}

    run_id = job_folder.name

    # Extract top-level stats from Harbor result.json
    stats = job_result.get("stats", {})
    evals = stats.get("evals", {})
    mean_scores = [
        metrics[0]["mean"]
        for eval_entry in evals.values()
        if (metrics := eval_entry.get("metrics")) and "mean" in metrics[0]
    ]
    accuracy = sum(mean_scores) / len(mean_scores) if mean_scores else None

    # GitHub context from environment
    github_context = {
        "github_run_id": parse_int(os.environ.get("GITHUB_RUN_ID")),
        "github_workflow": os.environ.get("GITHUB_WORKFLOW"),
        "github_sha": os.environ.get("GITHUB_SHA"),
        "github_ref": os.environ.get("GITHUB_REF"),
        "github_actor": os.environ.get("GITHUB_ACTOR"),
        "github_event_name": os.environ.get("GITHUB_EVENT_NAME"),
    }

    # Run configuration (job-level fallbacks)
    job_agent = (job_config.get("agents") or [{}])[0]
    job_kwargs = job_agent.get("kwargs") or {}
    job_model_name = job_agent.get("model_name")
    job_thinking_level = job_kwargs.get("thinking_level")
    job_mode = job_kwargs.get("mode")

    # Dataset from job config
    dataset_info = (job_config.get("datasets") or [{}])[0]
    dataset_name = dataset_info.get("name")
    dataset_version = dataset_info.get("version")
    dataset = f"{dataset_name}@{dataset_version}" if dataset_name and dataset_version else None

    experiments = os.environ.get("MUX_EXPERIMENTS")
    ingested_at = datetime.now(timezone.utc).isoformat()

    base_row = {
        "run_id": run_id,
        **github_context,
        "dataset": dataset,
        "experiments": experiments,
        "run_started_at": None,  # Not available in Harbor format
        "run_completed_at": None,
        "accuracy": accuracy,
        "run_result_json": json.dumps(job_result) if job_result else None,
        "run_metadata_json": None,  # Harbor doesn't have separate run_metadata.json
        "ingested_at": ingested_at,
    }

    rows = []
    for trial_folder in sorted(job_folder.iterdir()):
        if not trial_folder.is_dir():
            continue

        trial_result = load_json(trial_folder / "result.json")
        if not trial_result:
            continue

        trial_agent = (load_json(trial_folder / "config.json") or {}).get("agent") or {}
        trial_kwargs = trial_agent.get("kwargs") or {}

        row = base_row | {
            "task_id": trial_folder.name,
            "model_name": trial_agent.get("model_name") or job_model_name,
            "thinking_level": trial_kwargs.get("thinking_level") or job_thinking_level,
            "mode": trial_kwargs.get("mode") or job_mode,
            "n_resolved": None,  # Will be set after counting all trials
            "n_unresolved": None,
            "passed": trial_result.get("passed"),
            "score": trial_result.get("score"),
            "n_input_tokens": trial_result.get("n_input_tokens"),
            "n_output_tokens": trial_result.get("n_output_tokens"),
            "task_result_json": json.dumps(trial_result),
        }
        rows.append(row)

    n_resolved = sum(1 for row in rows if row["passed"] is True)
    n_unresolved = sum(1 for row in rows if row["passed"] is False)
    for row in rows:
        row["n_resolved"] = n_resolved
        row["n_unresolved"] = n_unresolved

    return rows


def upload_to_bigquery(rows: list[dict], project_id: str, dataset: str) -> None:
    """Upload rows to BigQuery using the Python client."""
    from google.cloud import bigquery

    client = bigquery.Client(project=project_id)
    table_id = f"{project_id}.{dataset}.tbench_results"

    errors = client.insert_rows_json(table_id, rows)
    if errors:
        print(f"BigQuery insert errors: {errors}", file=sys.stderr)
        sys.exit(1)

    print(f"Uploaded {len(rows)} row(s) to {table_id}")


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Upload tbench results to BigQuery")
    parser.add_argument(
        "--dry-run", action="store_true", help="Print rows without uploading"
    )
    parser.add_argument(
        "--project-id",
        default=os.environ.get("GCP_PROJECT_ID", "mux-benchmarks"),
        help="GCP project ID",
    )
    parser.add_argument(
        "--dataset",
        default=os.environ.get("BQ_DATASET", "benchmarks"),
        help="BigQuery dataset",
    )
    args = parser.parse_args()

    job_folders = find_job_folders()
    if not job_folders:
        print("No job folders found in jobs/", file=sys.stderr)
        sys.exit(1)

    all_rows = []
    for job_folder in job_folders:
        rows = build_rows(job_folder)
        all_rows.extend(rows)
        print(f"Found {len(rows)} trial(s) in {job_folder.name}")

    if not all_rows:
        print("No trial results found", file=sys.stderr)
        sys.exit(1)

    if args.dry_run:
        print(f"\n=== Dry run: {len(all_rows)} row(s) ===")
        for row in all_rows[:3]:  # Print first 3 rows
            print(json.dumps(row, indent=2, default=str))
        if len(all_rows) > 3:
            print(f"... and {len(all_rows) - 3} more row(s)")
        return

    upload_to_bigquery(all_rows, args.project_id, args.dataset)


if __name__ == "__main__":
    main()
