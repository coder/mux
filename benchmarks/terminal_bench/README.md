# Terminal-Bench Integration

This directory contains the cmux agent adapter for [Terminal-Bench](https://github.com/benediktstroebl/terminal-bench), a benchmarking framework for evaluating agentic CLI/terminal capabilities.

## Quick Start

```bash
# Run full benchmark suite (80 tasks, ~2.5 hours)
make benchmark-terminal

# Run with sample of 5 tasks
TB_SAMPLE_SIZE=5 make benchmark-terminal

# Run specific tasks
make benchmark-terminal TB_ARGS="--task-id hello-world --task-id chess-best-move"

# Run with specific model
make benchmark-terminal TB_ARGS="--agent-kwarg model_name=anthropic:claude-opus-4"
```

## Configuration

### Environment Variables

- `TB_DATASET`: Dataset to use (default: `terminal-bench-core==0.1.1`)
- `TB_SAMPLE_SIZE`: Number of random tasks to run (default: all 80 tasks)
- `TB_CONCURRENCY`: Number of concurrent tasks (default: 4)
- `TB_LIVESTREAM`: Enable livestream mode (set to `1` to enable)
- `TB_TIMEOUT`: Global timeout in seconds (default: 1800 = 30 minutes)
- `TB_ARGS`: Additional arguments passed to terminal-bench

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

The cmux agent supports the following kwargs (passed via `--agent-kwarg`):

- `model_name`: Model to use (e.g., `anthropic:claude-sonnet-4-5`, `openai:gpt-5-codex`)
- `thinking_level`: Thinking level (`off`, `low`, `medium`, `high`)
- `mode`: Agent mode (`plan`, `exec`)

**Example:**

```bash
make benchmark-terminal TB_ARGS="--agent-kwarg model_name=openai:gpt-5-codex --agent-kwarg thinking_level=high"
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

**Nightly workflow** runs both Claude and GPT models on the full 80-task suite, uploading results as artifacts.

## Timeout Analysis (2025-10-30 Nightly Run)

Based on analysis of the Oct 30 nightly run (15-minute timeout):

- **27-35% of tasks hit timeout** (too aggressive)
- **5-6 tasks passed tests but hit timeout flag** (false negatives)
- **Mean duration**: 356s (Anthropic) / 438s (OpenAI)
- **Median duration**: 272s (Anthropic) / 299s (OpenAI)
- **Longest successful**: 1200s (20 minutes) for `blind-maze-explorer-algorithm.hard`

**Impact of 30-minute timeout**: Expected to reduce false timeout failures by ~50% and improve pass rates by 10-15 percentage points (from ~42% to ~52-57%).

## Files

- `mux_agent.py`: Main agent adapter implementing Terminal-Bench's agent interface
- `mux-run.sh`: Shell script that sets up environment and invokes mux CLI
- `mux_payload.py`: Helper to package the mux app for containerized execution
- `mux_setup.sh.j2`: Jinja2 template for agent installation script
- `sample_tasks.py`: Utility to randomly sample tasks from dataset
