#!/usr/bin/env bash
# install.sh - Register AgentStats hooks in Claude Code settings.
#
# Usage:
#   ./install.sh                      # Install shell hooks (default)
#   ./install.sh --python             # Install Python hooks instead
#   ./install.sh --url http://host:port  # Custom AgentStats URL
#   ./install.sh --uninstall          # Remove AgentStats hooks
#
# This script modifies ~/.claude/settings.json. A backup is created
# before any changes are made.
set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_FILE="$HOME/.claude/settings.json"
USE_PYTHON=false
AGENTSTATS_URL="http://127.0.0.1:3141"
UNINSTALL=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --python)  USE_PYTHON=true; shift ;;
    --url)     AGENTSTATS_URL="$2"; shift 2 ;;
    --uninstall) UNINSTALL=true; shift ;;
    -h|--help)
      echo "Usage: ./install.sh [--python] [--url URL] [--uninstall]"
      echo ""
      echo "  --python     Use Python hook scripts instead of shell"
      echo "  --url URL    AgentStats server URL (default: http://127.0.0.1:3141)"
      echo "  --uninstall  Remove AgentStats hooks from settings"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Ensure jq is available
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required for install/uninstall. Install it with:"
  echo "  brew install jq      (macOS)"
  echo "  apt install jq       (Debian/Ubuntu)"
  echo "  pacman -S jq         (Arch)"
  exit 1
fi

# Ensure settings directory exists
mkdir -p "$(dirname "$SETTINGS_FILE")"

# Create settings file if it doesn't exist
if [ ! -f "$SETTINGS_FILE" ]; then
  echo '{}' > "$SETTINGS_FILE"
fi

# Backup existing settings
BACKUP="${SETTINGS_FILE}.bak.$(date +%Y%m%d%H%M%S)"
cp "$SETTINGS_FILE" "$BACKUP"
echo "Backed up settings to $BACKUP"

if [ "$UNINSTALL" = true ]; then
  # Remove all AgentStats hook entries (identified by agentstats marker in command path)
  jq '
    if .hooks then
      .hooks |= with_entries(
        .value |= map(
          .hooks |= map(select(.command | test("agentstats|hooks/claude-code") | not))
        ) | map(select(.hooks | length > 0))
      ) | if .hooks == {} then del(.hooks) else . end
    else . end
  ' "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp" && mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"

  echo ""
  echo "AgentStats hooks removed from $SETTINGS_FILE"
  exit 0
fi

# Determine script paths based on language choice
if [ "$USE_PYTHON" = true ]; then
  SESSION_START="python3 $HOOKS_DIR/python/session_start.py"
  SESSION_END="python3 $HOOKS_DIR/python/session_end.py"
  POST_TOOL="python3 $HOOKS_DIR/python/post_tool_use.py"
  PRE_TOOL="python3 $HOOKS_DIR/python/pre_tool_use.py"
  LANG_LABEL="Python"
else
  SESSION_START="$HOOKS_DIR/session_start.sh"
  SESSION_END="$HOOKS_DIR/session_end.sh"
  POST_TOOL="$HOOKS_DIR/post_tool_use.sh"
  PRE_TOOL="$HOOKS_DIR/pre_tool_use.sh"
  LANG_LABEL="Shell"
fi

# Build the hooks configuration and merge into settings
jq --arg session_start "$SESSION_START" \
   --arg session_end "$SESSION_END" \
   --arg post_tool "$POST_TOOL" \
   --arg pre_tool "$PRE_TOOL" \
   --arg url "$AGENTSTATS_URL" \
   '
  .hooks = ((.hooks // {}) * {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": ("AGENTSTATS_URL=" + $url + " " + $session_start),
            "timeout": 10,
            "async": true
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": ("AGENTSTATS_URL=" + $url + " " + $session_end),
            "timeout": 10,
            "async": true
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": ("AGENTSTATS_URL=" + $url + " " + $post_tool),
            "timeout": 10,
            "async": true
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": ("AGENTSTATS_URL=" + $url + " " + $pre_tool),
            "timeout": 10,
            "async": false,
            "statusMessage": "AgentStats: checking safety..."
          }
        ]
      }
    ]
  })
' "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp" && mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"

echo ""
echo "AgentStats hooks installed ($LANG_LABEL scripts)"
echo ""
echo "  Settings:     $SETTINGS_FILE"
echo "  Server URL:   $AGENTSTATS_URL"
echo "  Hooks dir:    $HOOKS_DIR"
echo ""
echo "  SessionStart  -> session_start event (async)"
echo "  Stop          -> session_end event (async)"
echo "  PostToolUse   -> tool_use event (async)"
echo "  PreToolUse    -> safety checks on Bash (sync, blocks destructive commands)"
echo ""
echo "Start AgentStats with 'pnpm dev' then use Claude Code as normal."
echo "Events will appear in the dashboard at $AGENTSTATS_URL"
