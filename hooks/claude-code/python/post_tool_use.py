#!/usr/bin/env python3
"""post_tool_use.py - Claude Code PostToolUse hook -> AgentStats tool_use event."""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from send_event import read_hook_input, extract, extract_nested, get_project, send_event

read_hook_input()

# Build metadata from tool_input fields
meta = {"tool_use_id": extract("tool_use_id")}
for key in ("command", "file_path", "pattern", "query", "url"):
    val = extract_nested(f"tool_input.{key}")
    if val:
        meta[key] = val

send_event({
    "session_id": extract("session_id"),
    "agent_type": "claude_code",
    "event_type": "tool_use",
    "tool_name": extract("tool_name"),
    "project": get_project(),
    "source": "hook",
    "metadata": meta,
})
