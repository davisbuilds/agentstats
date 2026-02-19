#!/usr/bin/env bash
# post_tool_use.sh - Claude Code PostToolUse hook -> AgentStats tool_use event
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/send_event.sh"

read_hook_input

SESSION_ID="$(extract_field session_id)"
TOOL_NAME="$(extract_field tool_name)"
PROJECT="$(get_project)"

# Extract useful detail from tool_input depending on tool type
COMMAND="$(extract_nested tool_input.command)"
FILE_PATH="$(extract_nested tool_input.file_path)"
PATTERN="$(extract_nested tool_input.pattern)"
QUERY="$(extract_nested tool_input.query)"
URL="$(extract_nested tool_input.url)"

# Build metadata object
META="{\"tool_use_id\": \"$(extract_field tool_use_id)\""
[ -n "$COMMAND" ]   && META="$META, \"command\": \"$COMMAND\""
[ -n "$FILE_PATH" ] && META="$META, \"file_path\": \"$FILE_PATH\""
[ -n "$PATTERN" ]   && META="$META, \"pattern\": \"$PATTERN\""
[ -n "$QUERY" ]     && META="$META, \"query\": \"$QUERY\""
[ -n "$URL" ]       && META="$META, \"url\": \"$URL\""
META="$META}"

send_event "$(cat <<EOF
{
  "session_id": "$SESSION_ID",
  "agent_type": "claude_code",
  "event_type": "tool_use",
  "tool_name": "$TOOL_NAME",
  "project": "$PROJECT",
  "source": "hook",
  "metadata": $META
}
EOF
)"

exit 0
