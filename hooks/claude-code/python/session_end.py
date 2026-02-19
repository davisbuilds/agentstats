#!/usr/bin/env python3
"""session_end.py - Claude Code Stop hook -> AgentStats session_end event."""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from send_event import read_hook_input, extract, get_project, send_event

read_hook_input()

send_event({
    "session_id": extract("session_id"),
    "agent_type": "claude_code",
    "event_type": "session_end",
    "project": get_project(),
    "source": "hook",
})
