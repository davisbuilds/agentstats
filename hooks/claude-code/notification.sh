#!/usr/bin/env bash
# notification.sh - Claude Code Notification hook -> AgentStats response event
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/send_event.sh"

read_hook_input

SESSION_ID="$(extract_field session_id)"
PROJECT="$(get_project)"
MESSAGE="$(extract_field message)"
NOTIF_TYPE="$(extract_field notification_type)"

send_event "$(cat <<EOF
{
  "session_id": "$SESSION_ID",
  "agent_type": "claude_code",
  "event_type": "response",
  "project": "$PROJECT",
  "source": "hook",
  "metadata": {"notification_type": "$NOTIF_TYPE", "message": "$MESSAGE"}
}
EOF
)"

exit 0
