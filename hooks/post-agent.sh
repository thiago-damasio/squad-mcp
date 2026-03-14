#!/usr/bin/env bash
# squad-mcp post-agent hook
# Runs after Agent tool calls to log events to .squad/log.jsonl
# This hook is OPTIONAL — the skill works without it.
# Install: squad init --with-hooks

set -euo pipefail

STATE_FILE=".squad/state.json"
LOG_FILE=".squad/log.jsonl"

# Find state file by walking up
find_state() {
  local dir="$PWD"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/$STATE_FILE" ]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

PROJECT_ROOT=$(find_state) || exit 0
STATE_PATH="$PROJECT_ROOT/$STATE_FILE"
LOG_PATH="$PROJECT_ROOT/$LOG_FILE"

# Read tool input from stdin (Claude Code passes JSON)
INPUT=$(cat)

# Extract tool name from input
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0

# Only process Agent tool calls
[ "$TOOL_NAME" = "Agent" ] || exit 0

# Log the event
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PROMPT_PREVIEW=$(echo "$INPUT" | jq -r '.tool_input.prompt // "" | .[0:100]' 2>/dev/null || echo "")

# Find task name by looking for "## Task:" in the prompt
TASK_HINT=$(echo "$INPUT" | jq -r '.tool_input.prompt // ""' 2>/dev/null | grep -oP '(?<=## Task: ).*' | head -1 || echo "unknown")

LOG_ENTRY=$(jq -n \
  --arg ts "$TIMESTAMP" \
  --arg event "agent_completed" \
  --arg task "$TASK_HINT" \
  --arg preview "$PROMPT_PREVIEW" \
  '{timestamp: $ts, event: $event, task: $task, prompt_preview: $preview}')

echo "$LOG_ENTRY" >> "$LOG_PATH"

# Always exit 0 — never block execution
exit 0
