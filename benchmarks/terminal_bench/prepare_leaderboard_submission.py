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
        --repo-type dataset --create-pr --commit-message "mux submission"

Output structure (per leaderboard requirements):
    submissions/terminal-bench/2.0/mux__<model>/
        metadata.yaml
        <job-folder>/
            config.json
            <trial-1>/result.json
            ...
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

# HuggingFace leaderboard repo
LEADERBOARD_REPO = "alexgshaw/terminal-bench-2-leaderboard"


# Agent metadata for mux
MUX_METADATA = {
    "agent_url": "https://github.com/coder/mux",
    "agent_display_name": "mux",
    "agent_org_display_name": "Coder",
}

# Model metadata lookup
MODEL_METADATA = {
    "anthropic/claude-sonnet-4-5": {
        "model_name": "claude-sonnet-4-5",
        "model_provider": "anthropic",
        "model_display_name": "Claude Sonnet 4.5",
        "model_org_display_name": "Anthropic",
    },
    "anthropic/claude-opus-4-5": {
        "model_name": "claude-opus-4-5",
        "model_provider": "anthropic",
        "model_display_name": "Claude Opus 4.5",
        "model_org_display_name": "Anthropic",
    },
    "openai/gpt-5.2": {
        "model_name": "gpt-5.2",
        "model_provider": "openai",
        "model_display_name": "GPT-5.2",
        "model_org_display_name": "OpenAI",
    },
    "openai/gpt-5-codex": {
        "model_name": "gpt-5-codex",
        "model_provider": "openai",
        "model_display_name": "GPT-5 Codex",
        "model_org_display_name": "OpenAI",
    },
}


def run_command(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    """Run a command and return the result."""
    print(f"  Running: {' '.join(cmd)}")
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


def get_latest_successful_nightly_run() -> dict | None:
    """Get the latest successful nightly Terminal-Bench run."""
    print("Fetching latest successful nightly run...")
    result = run_command(
        [
            "gh",
            "run",
            "list",
            "--workflow=nightly-terminal-bench.yml",
            "--status=success",
            "--limit=1",
            "--json=databaseId,createdAt,displayTitle",
        ],
        check=False,
    )

    if result.returncode != 0:
        print(f"Error fetching runs: {result.stderr}")
        return None

    runs = json.loads(result.stdout)
    if not runs:
        print("No successful nightly runs found")
        return None

    return runs[0]


def list_artifacts_for_run(run_id: int) -> list[dict]:
    """List all terminal-bench artifacts for a given run."""
    print(f"Listing artifacts for run {run_id}...")
    result = run_command(
        [
            "gh",
            "api",
            f"repos/coder/mux/actions/runs/{run_id}/artifacts",
            "--jq",
            '.artifacts[] | select(.name | startswith("terminal-bench-results")) | {name, id, size_in_bytes}',
        ],
        check=False,
    )

    if result.returncode != 0:
        print(f"Error listing artifacts: {result.stderr}")
        return []

    artifacts = []
    for line in result.stdout.strip().split("\n"):
        if line:
            artifacts.append(json.loads(line))

    return artifacts


def download_artifact(artifact_id: int, output_dir: Path) -> Path | None:
    """Download an artifact and extract it."""
    print(f"Downloading artifact {artifact_id}...")
    output_dir.mkdir(parents=True, exist_ok=True)

    # Download using gh cli
    result = run_command(
        [
            "gh",
            "api",
            f"repos/coder/mux/actions/artifacts/{artifact_id}/zip",
            "--output",
            str(output_dir / "artifact.zip"),
        ],
        check=False,
    )

    if result.returncode != 0:
        print(f"Error downloading artifact: {result.stderr}")
        return None

    # Extract the zip
    zip_path = output_dir / "artifact.zip"
    result = run_command(
        ["unzip", "-o", "-q", str(zip_path), "-d", str(output_dir)], check=False
    )

    if result.returncode != 0:
        print(f"Error extracting artifact: {result.stderr}")
        return None

    zip_path.unlink()  # Clean up zip file
    return output_dir


def parse_model_from_artifact_name(name: str) -> str | None:
    """Extract model name from artifact name like 'terminal-bench-results-anthropic-claude-opus-4-5-12345'."""
    # Pattern: terminal-bench-results-<model>-<run_id>
    # Model can be: anthropic-claude-opus-4-5, openai-gpt-5.2, etc.

    prefix = "terminal-bench-results-"
    if not name.startswith(prefix):
        return None

    remainder = name[len(prefix) :]

    # Try to match known model patterns
    model_patterns = {
        "anthropic-claude-sonnet-4-5": "anthropic/claude-sonnet-4-5",
        "anthropic-claude-opus-4-5": "anthropic/claude-opus-4-5",
        "openai-gpt-5.2": "openai/gpt-5.2",
        "openai-gpt-5-codex": "openai/gpt-5-codex",
    }

    for pattern, model in model_patterns.items():
        if remainder.startswith(pattern):
            return model

    return None


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


def prepare_submission(
    artifacts_dir: Path, output_dir: Path, run_date: str | None = None
) -> dict[str, Path]:
    """
    Prepare submission folders from downloaded artifacts.

    Returns a dict mapping model names to their submission directories.
    """
    submissions = {}

    # Find all jobs directories in the artifacts
    for item in artifacts_dir.iterdir():
        if not item.is_dir():
            continue

        # Look for jobs/ subdirectory (Harbor output structure)
        jobs_dir = item / "jobs" if (item / "jobs").exists() else item

        # Find job folders (timestamp-named directories)
        for job_folder in jobs_dir.iterdir():
            if not job_folder.is_dir():
                continue

            # Check for config.json or result.json to identify valid job
            config_path = job_folder / "config.json"
            result_path = job_folder / "result.json"

            if not (config_path.exists() or result_path.exists()):
                continue

            # Try to determine model from config or artifact name
            model = None
            if config_path.exists():
                try:
                    config = json.loads(config_path.read_text())
                    model = config.get("model_name") or config.get(
                        "agent_kwargs", {}
                    ).get("model_name")
                except (json.JSONDecodeError, KeyError):
                    pass

            if not model:
                model = parse_model_from_artifact_name(item.name)

            if not model:
                print(f"Warning: Could not determine model for {job_folder}, skipping")
                continue

            # Create submission directory name: mux__<model>
            model_slug = model.replace("/", "-")
            submission_name = f"mux__{model_slug}"

            submission_dir = (
                output_dir / "submissions" / "terminal-bench" / "2.0" / submission_name
            )
            submission_dir.mkdir(parents=True, exist_ok=True)

            # Create metadata.yaml
            metadata_path = submission_dir / "metadata.yaml"
            if not metadata_path.exists():
                metadata_path.write_text(create_metadata_yaml(model))

            # Copy the job folder
            job_name = run_date or job_folder.name if run_date else job_folder.name
            dest_job_dir = submission_dir / job_name

            if dest_job_dir.exists():
                shutil.rmtree(dest_job_dir)

            shutil.copytree(job_folder, dest_job_dir)
            print(f"  Copied {job_folder.name} -> {dest_job_dir}")

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
        artifacts = list_artifacts_for_run(run_id)
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
        print(f"Downloading to {artifacts_dir}")

        for artifact in artifacts:
            artifact_dir = artifacts_dir / artifact["name"]
            download_artifact(artifact["id"], artifact_dir)

    # Prepare submission
    print(f"\nPreparing submission in {args.output_dir}...")
    submissions = prepare_submission(artifacts_dir, args.output_dir, run_date)

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
    print(f'    --commit-message "mux submission ({run_date})"')

    # Clean up temp directory if we created one
    if not args.artifacts_dir and artifacts_dir.exists():
        print(f"\nNote: Downloaded artifacts are in {artifacts_dir}")
        print("      Delete with: rm -rf " + str(artifacts_dir))


if __name__ == "__main__":
    main()
