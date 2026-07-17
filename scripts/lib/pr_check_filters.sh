#!/usr/bin/env bash
# Shared PR check filters for scripts that gate merge readiness.

visual_check_jq_defs() {
  cat <<'JQ'
def check_text($field): (.[$field] // "" | tostring | ascii_downcase);
def is_visual_review_check:
  (check_text("workflow") == "pixel")
  or (check_text("name") == "visual regression testing")
  or (check_text("name") | startswith("pixel /"))
  or (check_text("link") | contains("pixel.coder.com"));
def is_unready_check:
  (.bucket == "fail")
  or (.bucket == "cancel")
  or (.bucket == "pending")
  or (.state == "FAILURE")
  or (.state == "ERROR")
  or (.state == "CANCELLED")
  or (.state == "TIMED_OUT")
  or (.state == "PENDING")
  or (.state == "EXPECTED")
  or (.state == "ACTION_REQUIRED")
  or (.state == "QUEUED")
  or (.state == "IN_PROGRESS")
  or (.state == "REQUESTED")
  or (.state == "WAITING");
def is_failed_check:
  (.bucket == "fail")
  or (.bucket == "cancel")
  or (.state == "FAILURE")
  or (.state == "ERROR")
  or (.state == "CANCELLED")
  or (.state == "TIMED_OUT")
  or (.state == "ACTION_REQUIRED");
def is_pending_check:
  (.bucket == "pending")
  or (.state == "PENDING")
  or (.state == "EXPECTED")
  or (.state == "QUEUED")
  or (.state == "IN_PROGRESS")
  or (.state == "REQUESTED")
  or (.state == "WAITING");
def is_passing_check:
  (.bucket == "pass") or (.state == "SUCCESS");
def check_line:
  [
    (.name // "<unnamed>"),
    (.bucket // "<unknown>"),
    (.state // "<unknown>"),
    (.link // ""),
    (.description // "")
  ] | @tsv;
JQ
}
