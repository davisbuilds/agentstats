#!/usr/bin/env python3
"""session_start.py - Claude Code SessionStart hook -> AgentStats session_start event."""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from send_event import read_hook_input, extract, get_project, send_event

read_hook_input()

send_event({
    "session_id": extract("session_id"),
    "agent_type": "claude_code",
    "event_type": "session_start",
    "project": get_project(),
    "model": extract("model"),
    "source": "hook",
    "metadata": {"hook_source": extract("source")},
})
