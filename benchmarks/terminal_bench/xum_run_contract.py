from __future__ import annotations

TIMEOUT_RETURN_CODE = 124
OOM_LIKE_RETURN_CODE = 137
RUN_COMPLETE_MARKER = "run-complete"
XUM_RUN_FAILURE_MARKER = "[xum-run] ERROR: xum agent session failed"


def xum_run_failure_marker(return_code: int) -> str:
    return f"{XUM_RUN_FAILURE_MARKER} (exit {return_code})"


XUM_RUN_TIMEOUT_FAILURE_MARKER = xum_run_failure_marker(TIMEOUT_RETURN_CODE)
