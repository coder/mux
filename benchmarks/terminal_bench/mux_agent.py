"""Compatibility import for benchmark configurations created before the Xum rename."""

from .xum_agent import XumAgent

# Harbor configurations may still reference benchmarks.terminal_bench.mux_agent:MuxAgent.
MuxAgent = XumAgent

__all__ = ["MuxAgent"]
