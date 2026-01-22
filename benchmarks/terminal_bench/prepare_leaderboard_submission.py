#!/usr/bin/env python3
"""
Prepare Terminal-Bench results for leaderboard submission.

This script:
1. Downloads the latest nightly benchmark results from GitHub Actions
2. Constructs the submission folder structure required by the leaderboard
3. Prints instructions to submit via `hf` CLI

Usage:
    # Download latest successful nightly run and prepare submission
    python prepare_leaderboard_submission.py

    # Use specific run ID
    python prepare_leaderboard_submission.py --run-id 20939412042

    # Use existing downloaded artifacts
    python prepare_leaderboard_submission.py --artifacts-dir ./downloads

    # Then submit with hf CLI:
    hf upload alexgshaw/terminal-bench-2-leaderboard \\
        ./leaderboard_submission/submissions submissions \\
        --repo-type dataset --create-pr --commit-message "Mux submission"

Output structure (per leaderboard requirements):
    submissions/terminal-bench/2.0/Mux__<Model>/
        metadata.yaml
        <job-folder>/               # Timestamp-named (e.g., 2026-01-16__00-15-05)
            config.json
            result.json
            <trial-1>/              # e.g., chess-best-move__ABC123
                config.json
                result.json
                agent/
                verifier/
            <trial-2>/
                ...
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

try:
    from .tbench_utils import (
        download_run_artifacts,
        list_artifacts_for_run,
        list_nightly_runs,
        run_command,
        SMOKE_TEST_MODEL,
    )
except ImportError:
    from tbench_utils import (  # type: ignore[import-not-found,no-redef]
        download_run_artifacts,
        list_artifacts_for_run,
        list_nightly_runs,
        run_command,
        SMOKE_TEST_MODEL,
    )

# HuggingFace leaderboard repo
LEADERBOARD_REPO = "alexgshaw/terminal-bench-2-leaderboard"


# Agent metadata for Mux
MUX_METADATA = {
    "agent_url": "https://github.com/coder/mux",
    "agent_display_name": "Mux",
    "agent_org_display_name": "Coder",
}

# Model metadata lookup
# folder_name: Used in submission folder path (e.g., Mux__Claude-Opus-4.5)
MODEL_METADATA = {
    "anthropic/claude-sonnet-4-5": {
        "model_name": "claude-sonnet-4-5",
        "model_provider": "anthropic",
        "model_display_name": "Claude Sonnet 4.5",
        "model_org_display_name": "Anthropic",
        "folder_name": "Claude-Sonnet-4.5",
    },
    "anthropic/claude-opus-4-5": {
        "model_name": "claude-opus-4-5",
        "model_provider": "anthropic",
        "model_display_name": "Claude Opus 4.5",
        "model_org_display_name": "Anthropic",
        "folder_name": "Claude-Opus-4.5",
    },
    "openai/gpt-5.2": {
        "model_name": "gpt-5.2",
        "model_provider": "openai",
        "model_display_name": "GPT-5.2",
        "model_org_display_name": "OpenAI",
        "folder_name": "GPT-5.2",
    },
    "openai/gpt-5-codex": {
        "model_name": "gpt-5-codex",
        "model_provider": "openai",
        "model_display_name": "GPT-5 Codex",
        "model_org_display_name": "OpenAI",
        "folder_name": "GPT-5-Codex",
    },
}


def get_latest_successful_nightly_run() -> dict | None:
    """Get the latest successful nightly Terminal-Bench run."""
    print("Fetching latest successful nightly run...")
    runs = list_nightly_runs(limit=1, status="success", verbose=True)
    if not runs:
        print("No successful nightly runs found")
        return None
    return runs[0]


def create_metadata_yaml(model: str) -> str:
    """Create the metadata.yaml content for a submission."""
    model_info = MODEL_METADATA.get(model)
    if not model_info:
        print(f"Warning: Unknown model {model}, using defaults")
        model_info = {
            "model_name": model.split("/")[-1],
            "model_provider": model.split("/")[0],
            "model_display_name": model.split("/")[-1],
            "model_org_display_name": model.split("/")[0].title(),
        }

    lines = [
        f'agent_url: "{MUX_METADATA["agent_url"]}"',
        f'agent_display_name: "{MUX_METADATA["agent_display_name"]}"',
        f'agent_org_display_name: "{MUX_METADATA["agent_org_display_name"]}"',
        "",
        "models:",
        f'  - model_name: "{model_info["model_name"]}"',
        f'    model_provider: "{model_info["model_provider"]}"',
        f'    model_display_name: "{model_info["model_display_name"]}"',
        f'    model_org_display_name: "{model_info["model_org_display_name"]}"',
    ]

    return "\n".join(lines) + "\n"


def get_model_from_config(config_path: Path) -> str | None:
    """Extract model name from config.json."""
    try:
        config = json.loads(config_path.read_text())
        return config.get("agent", {}).get("model_name")
    except (json.JSONDecodeError, OSError):
        return None


def find_job_folders(artifacts_dir: Path) -> list[Path]:
    """
    Find all job folders (containing trial directories) in the artifacts.

    Handles two structures:
    1. Direct: artifacts_dir/jobs/YYYY-MM-DD__HH-MM-SS/trials/
    2. Per-artifact: artifacts_dir/<artifact-name>/jobs/YYYY-MM-DD__HH-MM-SS/trials/
    """
    job_folders = []

    # Check for direct jobs/ folder
    direct_jobs = artifacts_dir / "jobs"
    if direct_jobs.exists():
        for item in direct_jobs.iterdir():
            if item.is_dir():
                job_folders.append(item)
        return job_folders

    # Check for per-artifact structure
    for artifact_dir in artifacts_dir.iterdir():
        if not artifact_dir.is_dir():
            continue
        jobs_dir = artifact_dir / "jobs"
        if jobs_dir.exists():
            for item in jobs_dir.iterdir():
                if item.is_dir():
                    job_folders.append(item)

    return job_folders


def prepare_submission(
    artifacts_dir: Path,
    output_dir: Path,
    models_filter: list[str] | None = None,
) -> dict[str, Path]:
    """
    Prepare submission folders from downloaded artifacts.

    Leaderboard structure:
        submissions/terminal-bench/2.0/<agent>__<model>/
            metadata.yaml
            <job-folder>/           # Timestamp-named (e.g., 2026-01-16__00-15-05)
                config.json
                result.json
                <trial-folder>/     # e.g., chess-best-move__ABC123
                    config.json
                    result.json
                    agent/
                    verifier/

    Returns a dict mapping model names to their submission directories.
    """
    submissions: dict[str, Path] = {}

    # Find all job folders in the artifacts
    job_folders = find_job_folders(artifacts_dir)
    if not job_folders:
        print("No job folders found in artifacts")
        return submissions

    print(f"Found {len(job_folders)} job folder(s)")

    # Group trials by model
    model_trials: dict[
        str, list[tuple[Path, Path]]
    ] = {}  # model -> [(trial_src, job_folder)]
    model_jobs: dict[str, dict[str, Path]] = {}  # model -> {job_name: job_folder}

    for job_folder in job_folders:
        for trial_folder in job_folder.iterdir():
            if not trial_folder.is_dir():
                continue

            config_path = trial_folder / "config.json"
            result_path = trial_folder / "result.json"

            if not result_path.exists():
                continue

            # Get model from config
            model = get_model_from_config(config_path) if config_path.exists() else None
            if not model:
                print(f"  Warning: Could not determine model for {trial_folder.name}")
                continue

            if model not in model_trials:
                model_trials[model] = []
                model_jobs[model] = {}
            model_trials[model].append((trial_folder, job_folder))
            model_jobs[model][job_folder.name] = job_folder

    # Filter models if specified
    if models_filter:
        model_trials = {m: t for m, t in model_trials.items() if m in models_filter}

    # Create submissions for each model
    for model, trials in model_trials.items():
        # Create submission directory: Mux__<Model>
        model_info = MODEL_METADATA.get(model, {})
        model_folder_name = model_info.get("folder_name", model.split("/")[-1].title())
        submission_name = f"Mux__{model_folder_name}"

        submission_dir = (
            output_dir / "submissions" / "terminal-bench" / "2.0" / submission_name
        )
        submission_dir.mkdir(parents=True, exist_ok=True)

        # Create metadata.yaml
        metadata_path = submission_dir / "metadata.yaml"
        if not metadata_path.exists():
            metadata_path.write_text(create_metadata_yaml(model))

        # Group trials by source job folder (preserve original job structure)
        trials_by_job: dict[str, list[Path]] = {}
        for trial_src, job_folder in trials:
            job_name = job_folder.name
            if job_name not in trials_by_job:
                trials_by_job[job_name] = []
            trials_by_job[job_name].append(trial_src)

        # Copy trials into job folders
        total_trials = 0
        for job_name, trial_paths in trials_by_job.items():
            dest_job_folder = submission_dir / job_name
            dest_job_folder.mkdir(parents=True, exist_ok=True)

            # Copy job-level config/result if present
            job_root = model_jobs[model].get(job_name)
            if job_root:
                for filename in ("config.json", "result.json"):
                    source_file = job_root / filename
                    if source_file.exists():
                        shutil.copy2(source_file, dest_job_folder / filename)

            for trial_src in trial_paths:
                dest_trial_dir = dest_job_folder / trial_src.name
                if dest_trial_dir.exists():
                    shutil.rmtree(dest_trial_dir)
                shutil.copytree(
                    trial_src,
                    dest_trial_dir,
                    ignore=shutil.ignore_patterns(
                        "mux-app.tar.gz",  # Large agent binary (~5MB each)
                        "mux-tokens.json",  # Token usage (not needed for leaderboard)
                    ),
                )
                total_trials += 1

        print(f"  {model}: copied {total_trials} trial(s)")
        submissions[model] = submission_dir

    return submissions


def main():
    parser = argparse.ArgumentParser(
        description="Prepare Terminal-Bench results for leaderboard submission"
    )
    parser.add_argument(
        "--run-id",
        type=int,
        help="Specific GitHub Actions run ID to download (default: latest successful nightly)",
    )
    parser.add_argument(
        "--artifacts-dir",
        type=Path,
        help="Use existing downloaded artifacts instead of downloading",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("leaderboard_submission"),
        help="Output directory for submission (default: leaderboard_submission)",
    )
    parser.add_argument(
        "--models",
        nargs="+",
        help="Only process specific models (e.g., anthropic/claude-opus-4-5)",
    )
    args = parser.parse_args()

    # Determine what artifacts to use
    if args.artifacts_dir:
        if not args.artifacts_dir.exists():
            print(f"Error: Artifacts directory {args.artifacts_dir} does not exist")
            sys.exit(1)
        artifacts_dir = args.artifacts_dir
        run_date = datetime.now().strftime("%Y-%m-%d")
    else:
        # Download from GitHub Actions
        if args.run_id:
            run_id = args.run_id
            run_info = {"databaseId": run_id, "createdAt": datetime.now().isoformat()}
        else:
            run_info = get_latest_successful_nightly_run()
            if not run_info:
                print("Could not find a successful nightly run")
                sys.exit(1)
            run_id = run_info["databaseId"]

        run_date = run_info["createdAt"][:10]  # YYYY-MM-DD
        print(f"Using run {run_id} from {run_date}")

        # List artifacts for this run
        artifacts = list_artifacts_for_run(run_id, verbose=True)
        if not artifacts:
            print("No terminal-bench artifacts found for this run")
            sys.exit(1)

        print(f"Found {len(artifacts)} artifact(s)")

        # Filter by model if specified
        if args.models:
            artifacts = [
                a
                for a in artifacts
                if any(m.replace("/", "-") in a["name"] for m in args.models)
            ]
            print(f"Filtered to {len(artifacts)} artifact(s) for specified models")

        # Download artifacts
        artifacts_dir = Path(tempfile.mkdtemp(prefix="tbench-"))
        artifact_names = [a["name"] for a in artifacts]
        if not download_run_artifacts(
            run_id, artifacts_dir, artifact_names, verbose=True
        ):
            print("Failed to download artifacts")
            sys.exit(1)

    # Prepare submission
    print(f"\nPreparing submission in {args.output_dir}...")
    submissions = prepare_submission(artifacts_dir, args.output_dir, args.models)

    if not submissions:
        print("No valid submissions created")
        sys.exit(1)

    print(f"\n✅ Created {len(submissions)} submission(s):")
    for model, path in submissions.items():
        print(f"  - {model}: {path}")

    # Print next steps
    print(f"\nNext steps - submit with hf CLI:")
    print(f"  hf upload {LEADERBOARD_REPO} \\")
    print(f"    {args.output_dir}/submissions submissions \\")
    print(f"    --repo-type dataset --create-pr \\")
    print(f'    --commit-message "Mux submission ({run_date})"')

    # Clean up temp directory if we created one
    if not args.artifacts_dir and artifacts_dir.exists():
        print(f"\nNote: Downloaded artifacts are in {artifacts_dir}")
        print("      Delete with: rm -rf " + str(artifacts_dir))


if __name__ == "__main__":
    main()
