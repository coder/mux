from __future__ import annotations

from pathlib import Path

import pytest

from .mux_agent import MuxAgent


@pytest.fixture(autouse=True)
def _clear_mux_env(monkeypatch: pytest.MonkeyPatch) -> None:
    keys = (*MuxAgent._PROVIDER_ENV_KEYS, *MuxAgent._CONFIG_ENV_KEYS)
    for key in keys:
        monkeypatch.delenv(key, raising=False)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def test_env_defaults_are_normalized(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(model_name="anthropic/claude-sonnet-4-5")

    env = agent._env

    assert env["MUX_MODEL"] == "anthropic:claude-sonnet-4-5"
    assert env["MUX_THINKING_LEVEL"] == "high"
    assert env["MUX_MODE"] == "exec"
    assert env["MUX_PROJECT_CANDIDATES"] == agent._DEFAULT_PROJECT_CANDIDATES


def test_timeout_must_be_numeric(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    monkeypatch.setenv("MUX_TIMEOUT_MS", "not-a-number")

    agent = MuxAgent()
    with pytest.raises(ValueError):
        _ = agent._env
