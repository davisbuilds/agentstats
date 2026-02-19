#!/usr/bin/env bash
# send_event.sh - Shared helper for POSTing events to AgentStats.
# Sourced by individual hook scripts. Not executed directly.
#
# Usage: source send_event.sh; send_event "$json_payload"

AGENTSTATS_URL="${AGENTSTATS_URL:-http://127.0.0.1:3141}"

# Read all of stdin into HOOK_INPUT (call once per hook invocation)
read_hook_input() {
  HOOK_INPUT="$(cat)"
}

# Extract a string field from HOOK_INPUT using lightweight parsing.
# Falls back to empty string if jq is unavailable or field is missing.
extract_field() {
  local field="$1"
  if command -v jq &>/dev/null; then
    echo "$HOOK_INPUT" | jq -r ".$field // empty" 2>/dev/null
  else
    # Fallback: naive grep for simple top-level string fields
    echo "$HOOK_INPUT" | grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*: *"//;s/"$//'
  fi
}

# Extract a nested field (e.g., tool_input.command)
extract_nested() {
  local path="$1"
  if command -v jq &>/dev/null; then
    echo "$HOOK_INPUT" | jq -r ".$path // empty" 2>/dev/null
  else
    echo ""
  fi
}

# Derive project name from cwd (basename of working directory)
get_project() {
  local cwd
  cwd="$(extract_field cwd)"
  if [ -n "$cwd" ]; then
    basename "$cwd"
  fi
}

# POST an event payload to AgentStats. Fire-and-forget (backgrounded).
send_event() {
  local payload="$1"
  curl -s -X POST "${AGENTSTATS_URL}/api/events" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    --connect-timeout 2 \
    --max-time 5 \
    >/dev/null 2>&1 &
}
