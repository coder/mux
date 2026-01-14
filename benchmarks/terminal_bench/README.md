# Terminal-Bench Integration

This directory contains the mux agent adapter for [Terminal-Bench 2.0](https://tbench.ai/), using [Harbor](https://harborframework.com/) as the evaluation harness.

## Quick Start

```bash
# Run full benchmark suite
make benchmark-terminal

# Run specific tasks
make benchmark-terminal TB_TASK_NAMES="hello-world chess-best-move"

# Run with specific model
make benchmark-terminal TB_ARGS="--agent-kwarg model_name=anthropic/claude-opus-4-5"

# Run on Daytona cloud (high parallelism)
TB_ENV=daytona TB_CONCURRENCY=48 make benchmark-terminal
```

## Daytona Cloud Sandboxes

For faster benchmarks, use [Daytona](https://www.daytona.io/) cloud sandboxes instead of local Docker:

```bash
# Set API key (get from https://app.daytona.io)
export DAYTONA_API_KEY="your-api-key"

# Run with 48 concurrent cloud sandboxes (~6x faster than local)
make benchmark-terminal TB_ENV=daytona TB_CONCURRENCY=48

# Run specific tasks on Daytona
make benchmark-terminal TB_ENV=daytona TB_CONCURRENCY=48 TB_TASK_NAMES="chess-best-move stockfish-elo"
```

**Account limits (Tier 3):** Pool of 250 vCPU / 500GB RAM. Most tasks require 1 vCPU / 2GB RAM, with a few needing up to 4 vCPU / 8GB RAM. Harbor automatically requests the correct per-task resources.

**Speed comparison:**
| Environment | Concurrency | Full suite time |
|-------------|-------------|-----------------|
| Local Docker | 4 | ~90 min |
| Daytona Cloud | 48 | ~10-15 min |

## Configuration

### Environment Variables

- `TB_DATASET`: Dataset to use (default: `terminal-bench@2.0`)
- `TB_CONCURRENCY`: Number of concurrent tasks (default: 4)
- `TB_TIMEOUT`: Global timeout in seconds (default: 1800 = 30 minutes)
- `TB_ENV`: Environment to run in (`local` or `daytona`)
- `TB_TASK_NAMES`: Space-separated task names to run (default: all tasks)
- `TB_ARGS`: Additional arguments passed to harbor

### Timeout Handling

The benchmark uses a **global timeout** applied to all tasks. The default is **30 minutes (1800 seconds)**, which provides sufficient time for most tasks while catching genuinely stuck agents.

**Design Rationale:**

Based on analysis of Oct 30, 2025 nightly runs:

- Longest successful task: `blind-maze-explorer-algorithm.hard` at 20 minutes
- 95th percentile: ~15 minutes
- Mean duration: ~6 minutes

The 30-minute default provides comfortable headroom for complex tasks without excessive wait times for failed attempts.

**Override timeout:**

```bash
# Run with 60 minute timeout for very complex tasks
TB_TIMEOUT=3600 make benchmark-terminal

# Run with shorter 10 minute timeout for quick iteration
TB_TIMEOUT=600 make benchmark-terminal TB_SAMPLE_SIZE=5
```

**Note:** We prefer global timeout defaults over per-task configuration to avoid complexity and maintenance burden. If you find tasks consistently timing out, increase `TB_TIMEOUT` rather than adding per-task configuration.

## Agent Configuration

The mux agent supports the following kwargs (passed via `--agent-kwarg`):

- `model_name`: Model to use (e.g., `anthropic/claude-sonnet-4-5`, `openai/gpt-5-codex`)
- `thinking_level`: Thinking level (`off`, `low`, `medium`, `high`)
- `mode`: Agent mode (`plan`, `exec`)
- `experiments`: Experiments to enable, comma-separated (e.g., `programmatic-tool-calling`)

**Example:**

```bash
# Run with specific model and thinking level
make benchmark-terminal TB_ARGS="--agent-kwarg model_name=openai/gpt-5-codex --agent-kwarg thinking_level=high"

# Run with multiple experiments
make benchmark-terminal TB_ARGS="--agent-kwarg experiments=programmatic-tool-calling-exclusive,post-compaction-context"
```

## Results

Results are saved to `runs/YYYY-MM-DD__HH-MM-SS/`:

- `results.json`: Aggregate results with pass/fail rates
- `run_metadata.json`: Run configuration and metadata
- `<task-id>/`: Per-task directories containing:
  - `sessions/agent.log`: Full agent execution log
  - `sessions/agent.cast`: Asciinema recording of agent session
  - `sessions/tests.log`: Test execution output
  - `results.json`: Per-trial results

## CI/CD Integration

See `.github/workflows/terminal-bench.yml` and `.github/workflows/nightly-terminal-bench.yml` for GitHub Actions integration.

**Nightly workflow** runs both Claude and GPT models on the full task suite, uploading results as artifacts.

## Files

- `mux_agent.py`: Main agent adapter implementing Harbor's `BaseInstalledAgent` interface
- `mux-run.sh`: Shell script that sets up environment and invokes mux CLI
- `mux_payload.py`: Helper to package mux app for containerized execution
- `mux_setup.sh.j2`: Jinja2 template for agent installation script
