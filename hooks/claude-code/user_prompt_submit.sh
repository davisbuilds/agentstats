#!/usr/bin/env bash
# user_prompt_submit.sh - Claude Code UserPromptSubmit hook -> AgentStats user_prompt event
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/send_event.sh"

read_hook_input

SESSION_ID="$(extract_field session_id)"
PROJECT="$(get_project)"
PROMPT="$(extract_field prompt)"

# Skip empty prompts
[ -z "$PROMPT" ] && exit 0

send_event "$(cat <<EOF
{
  "session_id": "$(json_escape "$SESSION_ID")",
  "agent_type": "claude_code",
  "event_type": "user_prompt",
  "project": "$(json_escape "$PROJECT")",
  "source": "hook",
  "metadata": {"message": "$(json_escape "$PROMPT")"}
}
EOF
)"

exit 0
