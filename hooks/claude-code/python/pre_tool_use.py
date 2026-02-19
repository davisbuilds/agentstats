#!/usr/bin/env python3
"""pre_tool_use.py - Claude Code PreToolUse hook with optional safety checks.

Safety behavior:
  - Blocks destructive commands (rm -rf /, rm -rf ~, etc.)
  - Logs security events for sensitive file access (.env, .pem, credentials)
  - Exit 0 = allow, Exit 2 = block

Set AGENTSTATS_SAFETY=0 to disable safety checks (telemetry-only mode).
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from send_event import read_hook_input, extract, extract_nested, get_project, send_event

read_hook_input()

SESSION_ID = extract("session_id")
TOOL_NAME = extract("tool_name")
PROJECT = get_project()
COMMAND = extract_nested("tool_input.command")
FILE_PATH = extract_nested("tool_input.file_path")

SAFETY_ENABLED = os.environ.get("AGENTSTATS_SAFETY", "1") == "1"

# --- Safety checks (only for Bash commands) ---
if SAFETY_ENABLED and TOOL_NAME == "Bash" and COMMAND:
    destructive = re.search(
        r'rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)*(/|~|\$HOME)(\s|$)',
        COMMAND,
    )
    if destructive:
        send_event({
            "session_id": SESSION_ID,
            "agent_type": "claude_code",
            "event_type": "error",
            "tool_name": TOOL_NAME,
            "status": "error",
            "project": PROJECT,
            "source": "hook",
            "metadata": {
                "blocked": True,
                "reason": "destructive_command",
                "command": COMMAND,
            },
        })
        print(f"AgentStats: Blocked destructive command: {COMMAND}", file=sys.stderr)
        sys.exit(2)

# --- Security warnings (log but don't block) ---
if SAFETY_ENABLED and FILE_PATH:
    sensitive = re.search(r'\.(env|pem|key|credentials|secret)$', FILE_PATH)
    if sensitive:
        send_event({
            "session_id": SESSION_ID,
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "tool_name": TOOL_NAME,
            "project": PROJECT,
            "source": "hook",
            "metadata": {
                "security_warning": True,
                "file_path": FILE_PATH,
                "reason": "sensitive_file_access",
            },
        })

sys.exit(0)
