"""send_event.py - Shared helper for POSTing events to AgentStats.

Imported by individual hook scripts. Uses only stdlib (no pip dependencies).

Usage:
    from send_event import read_hook_input, send_event, get_project
"""

import json
import os
import sys
import urllib.request
from pathlib import Path
from threading import Thread

AGENTSTATS_URL = os.environ.get("AGENTSTATS_URL", "http://127.0.0.1:3141")

_hook_input: dict = {}


def read_hook_input() -> dict:
    """Read and parse JSON from stdin. Call once per hook invocation."""
    global _hook_input
    raw = sys.stdin.read()
    try:
        _hook_input = json.loads(raw)
    except json.JSONDecodeError:
        _hook_input = {}
    return _hook_input


def get_input() -> dict:
    """Return the parsed hook input (must call read_hook_input first)."""
    return _hook_input


def extract(field: str, default: str = "") -> str:
    """Extract a top-level string field from hook input."""
    val = _hook_input.get(field, default)
    return str(val) if val is not None else default


def extract_nested(path: str, default: str = "") -> str:
    """Extract a nested field using dot notation (e.g., 'tool_input.command')."""
    parts = path.split(".")
    obj = _hook_input
    for part in parts:
        if isinstance(obj, dict):
            obj = obj.get(part)
        else:
            return default
    return str(obj) if obj is not None else default


def get_project() -> str:
    """Derive project name from cwd (basename of working directory)."""
    cwd = extract("cwd")
    return Path(cwd).name if cwd else ""


def send_event(payload: dict) -> None:
    """POST an event payload to AgentStats. Fire-and-forget (threaded)."""
    def _post():
        try:
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                f"{AGENTSTATS_URL}/api/events",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass  # fire-and-forget

    thread = Thread(target=_post, daemon=True)
    thread.start()
    # Give the request a moment to fire before the process exits
    thread.join(timeout=2)
