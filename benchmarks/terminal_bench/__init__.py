from __future__ import annotations

__all__ = ["XumAgent", "MuxAgent"]


def __getattr__(name: str):
    if name in {"XumAgent", "MuxAgent"}:
        from .xum_agent import XumAgent

        # MuxAgent remains a lazy alias for existing Harbor configurations.
        return XumAgent
    raise AttributeError(name)
