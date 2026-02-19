#!/usr/bin/env bash
# session_end.sh - Claude Code Stop hook -> AgentStats session_end event
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/send_event.sh"

read_hook_input

SESSION_ID="$(extract_field session_id)"
PROJECT="$(get_project)"

send_event "$(cat <<EOF
{
  "session_id": "$SESSION_ID",
  "agent_type": "claude_code",
  "event_type": "session_end",
  "project": "$PROJECT",
  "source": "hook"
}
EOF
)"

exit 0
