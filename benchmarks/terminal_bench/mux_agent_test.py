from __future__ import annotations

import asyncio
import io
import tarfile
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest

from .mux_agent import MuxAgent
from .mux_payload import build_app_archive


@pytest.fixture(autouse=True)
def _clear_mux_env(monkeypatch: pytest.MonkeyPatch) -> None:
    keys = (*MuxAgent._PROVIDER_ENV_KEYS, *MuxAgent._CONFIG_ENV_KEYS)
    for key in keys:
        monkeypatch.delenv(key, raising=False)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def test_env_defaults_are_normalized(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path, model_name="anthropic/claude-sonnet-4-5")

    env = agent._env

    assert env["MUX_MODEL"] == "anthropic:claude-sonnet-4-5"
    assert env["MUX_PROJECT_CANDIDATES"] == agent._DEFAULT_PROJECT_CANDIDATES


def test_goal_mode_env_is_forwarded(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    monkeypatch.setenv("MUX_RUN_AS_GOAL", "true")

    agent = MuxAgent(logs_dir=tmp_path)

    assert agent._env["MUX_RUN_AS_GOAL"] == "1"


def test_goal_mode_defaults_to_disabled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))

    agent = MuxAgent(logs_dir=tmp_path)

    assert "MUX_RUN_AS_GOAL" not in agent._env


def test_goal_mode_rejects_invalid_values(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    monkeypatch.setenv("MUX_RUN_AS_GOAL", "yes")

    agent = MuxAgent(logs_dir=tmp_path)
    with pytest.raises(ValueError, match="MUX_RUN_AS_GOAL"):
        _ = agent._env


def test_timeout_must_be_numeric(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    monkeypatch.setenv("MUX_TIMEOUT_MS", "not-a-number")

    agent = MuxAgent(logs_dir=tmp_path)
    with pytest.raises(ValueError):
        _ = agent._env


@dataclass
class _ExecResult:
    return_code: int
    stdout: str = ""
    stderr: str = ""


class _FakeEnvironment:
    def __init__(self, result: _ExecResult) -> None:
        self.result = result
        self.download_attempts: list[tuple[str, Path]] = []

    async def exec(self, **_kwargs: object) -> _ExecResult:
        return self.result

    async def download_file(self, source_path: str, target_path: Path) -> None:
        self.download_attempts.append((source_path, target_path))
        target_path.write_text('{"input": 7, "output": 11, "cost_usd": 0.42}')


def test_run_raises_after_preserving_logs_for_nonzero_exit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(
        _ExecResult(return_code=3, stdout="out", stderr="err")
    )
    context = SimpleNamespace()

    with pytest.raises(RuntimeError, match="mux agent command failed"):
        asyncio.run(agent.run("do the task", environment, context))

    command_dir = tmp_path / "command-0"
    assert (command_dir / "return-code.txt").read_text() == "3"
    assert (command_dir / "stdout.txt").read_text() == "out"
    assert (command_dir / "stderr.txt").read_text() == "err"
    assert environment.download_attempts == [
        (agent._TOKEN_FILE_PATH, tmp_path / "mux-tokens.json")
    ]
    assert getattr(context, "n_input_tokens") == 7
    assert getattr(context, "n_output_tokens") == 11
    assert getattr(context, "cost_usd") == 0.42


def test_run_populates_context_for_successful_exit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(
        _ExecResult(return_code=0, stdout="out", stderr="err")
    )
    context = SimpleNamespace()

    asyncio.run(agent.run("do the task", environment, context))

    command_dir = tmp_path / "command-0"
    assert (command_dir / "return-code.txt").read_text() == "0"
    assert (command_dir / "stdout.txt").read_text() == "out"
    assert (command_dir / "stderr.txt").read_text() == "err"
    assert getattr(context, "n_input_tokens") == 7
    assert getattr(context, "n_output_tokens") == 11
    assert getattr(context, "cost_usd") == 0.42


def test_app_archive_includes_postinstall_script() -> None:
    assert "scripts/postinstall.sh" in MuxAgent._INCLUDE_PATHS

    repo_root = _repo_root()
    postinstall = repo_root / "scripts/postinstall.sh"
    assert postinstall.is_file()

    archive_bytes = build_app_archive(repo_root, ["scripts/postinstall.sh"])
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
        assert "scripts/postinstall.sh" in archive.getnames()
