from __future__ import annotations

import json
import os
import shlex
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, ExecInput
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from .mux_payload import build_app_archive


class MuxAgent(BaseInstalledAgent):
    """
    Minimal Terminal-Bench adapter that installs mux into the task container and
    forwards the benchmark instruction to the mux headless runner.
    """

    _ARCHIVE_NAME = "mux-app.tar.gz"
    _RUNNER_NAME = "mux-run.sh"
    _DEFAULT_MODEL = "anthropic:claude-sonnet-4-5"
    _DEFAULT_PROJECT_CANDIDATES = "/workspace:/app:/workspaces:/root/project"
    _INCLUDE_PATHS: Sequence[str] = (
        "package.json",
        "bun.lock",
        "bunfig.toml",
        "tsconfig.json",
        "tsconfig.main.json",
        "src",
        "dist",
    )

    _PROVIDER_ENV_KEYS: Sequence[str] = (
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_API_BASE",
        "OPENAI_ORG_ID",
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_DEPLOYMENT",
        "AZURE_OPENAI_API_VERSION",
    )

    _CONFIG_ENV_KEYS: Sequence[str] = (
        "MUX_AGENT_GIT_URL",
        "MUX_BUN_INSTALL_URL",
        "MUX_PROJECT_PATH",
        "MUX_PROJECT_CANDIDATES",
        "MUX_MODEL",
        "MUX_TIMEOUT_MS",
        "MUX_THINKING_LEVEL",
        "MUX_CONFIG_ROOT",
        "MUX_APP_ROOT",
        "MUX_WORKSPACE_ID",
        "MUX_MODE",
        "MUX_RUNTIME",
        "MUX_EXPERIMENTS",
    )

    def __init__(
        self,
        logs_dir: Path,
        model_name: str = "anthropic:claude-sonnet-4-5",
        mode: str | None = None,
        thinking_level: str | None = None,
        experiments: str | None = None,
        timeout: int | str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir=logs_dir, **kwargs)
        # Set MUX_TIMEOUT_MS if timeout is provided via agent kwargs
        if timeout is not None:
            os.environ["MUX_TIMEOUT_MS"] = str(int(timeout) * 1000)
        repo_root_env = os.environ.get("MUX_AGENT_REPO_ROOT")
        repo_root = (
            Path(repo_root_env).resolve()
            if repo_root_env
            else Path(__file__).resolve().parents[2]
        )
        if not repo_root.exists():
            raise RuntimeError(f"mux repo root {repo_root} does not exist")

        runner_path = Path(__file__).with_name(self._RUNNER_NAME)
        if not runner_path.is_file():
            raise RuntimeError(f"mux runner script missing at {runner_path}")

        self._runner_path = runner_path
        self._repo_root = repo_root
        self._archive_bytes: bytes | None = None
        self._mode = mode.lower() if mode else None
        self._thinking_level = thinking_level.lower() if thinking_level else None
        self._model_name = (model_name or "").strip()
        self._experiments = (experiments or "").strip() if experiments else None
        self._last_environment: BaseEnvironment | None = None

    @staticmethod
    def name() -> str:
        return "mux"

    @property
    def _env(self) -> dict[str, str]:
        env: dict[str, str] = {}

        for key in (*self._PROVIDER_ENV_KEYS, *self._CONFIG_ENV_KEYS):
            value = os.environ.get(key)
            if value:
                env[key] = value

        env.setdefault("MUX_MODEL", self._DEFAULT_MODEL)
        env.setdefault("MUX_CONFIG_ROOT", "/root/.mux")
        env.setdefault("MUX_APP_ROOT", "/opt/mux-app")
        env.setdefault("MUX_WORKSPACE_ID", "mux-bench")
        env.setdefault("MUX_THINKING_LEVEL", "high")
        env.setdefault("MUX_MODE", "exec")
        env.setdefault("MUX_PROJECT_CANDIDATES", self._DEFAULT_PROJECT_CANDIDATES)

        model_value = self._model_name or env["MUX_MODEL"]
        model_value = model_value.strip()
        if not model_value:
            raise ValueError("MUX_MODEL must be a non-empty string")
        if "/" in model_value and ":" not in model_value:
            provider, model_name = model_value.split("/", 1)
            model_value = f"{provider}:{model_name}"
        env["MUX_MODEL"] = model_value

        thinking_value = self._thinking_level or env["MUX_THINKING_LEVEL"]
        normalized_thinking = thinking_value.strip().lower()
        if normalized_thinking not in {"off", "low", "medium", "high", "xhigh"}:
            raise ValueError(
                "MUX_THINKING_LEVEL must be one of off, low, medium, high, xhigh"
            )
        env["MUX_THINKING_LEVEL"] = normalized_thinking

        mode_value = self._mode or env["MUX_MODE"]
        normalized_mode = mode_value.strip().lower()
        if normalized_mode in {"exec", "execute"}:
            env["MUX_MODE"] = "exec"
        elif normalized_mode == "plan":
            env["MUX_MODE"] = "plan"
        else:
            raise ValueError("MUX_MODE must be one of plan, exec, or execute")

        # These env vars are all set with defaults above, no need to validate
        for key in (
            "MUX_CONFIG_ROOT",
            "MUX_APP_ROOT",
            "MUX_WORKSPACE_ID",
            "MUX_PROJECT_CANDIDATES",
        ):
            env[key] = env[key].strip()

        if timeout_value := env.get("MUX_TIMEOUT_MS"):
            if not timeout_value.strip().isdigit():
                raise ValueError("MUX_TIMEOUT_MS must be an integer")

        if project_path := env.get("MUX_PROJECT_PATH"):
            if not project_path.strip():
                raise ValueError("MUX_PROJECT_PATH must be non-empty when provided")

        # Set experiments from kwarg (takes precedence over env var)
        if self._experiments:
            env["MUX_EXPERIMENTS"] = self._experiments

        return env

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).with_name("mux_setup.sh.j2")

    _TOKEN_FILE_PATH = "/tmp/mux-tokens.json"

    async def setup(self, environment: BaseEnvironment) -> None:
        """Override setup to stage payload first, then run install template."""
        # Create /installed-agent directory (normally done by super().setup(),
        # but we need it to exist before uploading files)
        await environment.exec(command="mkdir -p /installed-agent")

        # Build and stage the mux app archive BEFORE super().setup() runs the
        # install template, which extracts the archive and runs chmod on runner
        if not self._archive_bytes:
            self._archive_bytes = build_app_archive(
                self._repo_root, self._INCLUDE_PATHS
            )

        # Write archive to logs_dir and upload
        archive_path = self.logs_dir / self._ARCHIVE_NAME
        archive_path.write_bytes(self._archive_bytes)
        await environment.upload_file(
            source_path=archive_path,
            target_path=f"/installed-agent/{self._ARCHIVE_NAME}",
        )

        # Upload runner script
        await environment.upload_file(
            source_path=self._runner_path,
            target_path=f"/installed-agent/{self._RUNNER_NAME}",
        )

        # Now run parent setup which executes mux_setup.sh.j2 template
        # (extracts archive, installs bun/deps, chmod +x runner)
        await super().setup(environment)

        # Store environment reference for token extraction later
        self._last_environment = environment

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        escaped = shlex.quote(instruction)
        command = f"bash /installed-agent/{self._RUNNER_NAME} {escaped}"
        return [
            ExecInput(
                command=command,
                env=self._env,
            )
        ]

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run agent commands, download token file, then populate context."""
        # Execute commands (from base class logic, but without calling populate_context)
        for i, exec_input in enumerate(self.create_run_agent_commands(instruction)):
            command_dir = self.logs_dir / f"command-{i}"
            command_dir.mkdir(parents=True, exist_ok=True)
            (command_dir / "command.txt").write_text(exec_input.command)

            result = await environment.exec(
                command=exec_input.command,
                cwd=exec_input.cwd,
                env=exec_input.env,
                timeout_sec=exec_input.timeout_sec,
            )

            (command_dir / "return-code.txt").write_text(str(result.return_code))
            if result.stdout:
                (command_dir / "stdout.txt").write_text(result.stdout)
            if result.stderr:
                (command_dir / "stderr.txt").write_text(result.stderr)

        # Download token file from container BEFORE populating context
        # Clear any stale token file first to avoid reading outdated data if download fails
        token_file = self.logs_dir / "mux-tokens.json"
        token_file.unlink(missing_ok=True)
        try:
            await environment.download_file(self._TOKEN_FILE_PATH, token_file)
        except Exception:
            pass  # Token file may not exist if agent crashed early

        self.populate_context_post_run(context)

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Extract token usage from the token file written by mux-run.sh."""
        token_file = self.logs_dir / "mux-tokens.json"
        if token_file.exists():
            try:
                data = json.loads(token_file.read_text())
                context.n_input_tokens = data.get("input", 0)
                context.n_output_tokens = data.get("output", 0)
            except Exception:
                pass  # Token extraction is best-effort
