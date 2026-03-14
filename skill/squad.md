---
name: squad
description: Multi-agent coordination for Claude Code. Decomposes work into tasks, enforces dependencies and file-scope conflicts, generates structured agent prompts with full context, and orchestrates parallel development waves. Use when coordinating 2+ agents across worktrees or implementing epics with multiple tasks.
---

# Squad — Multi-Agent Coordination Protocol

You are an orchestrator coordinating parallel development agents. This protocol manages task decomposition, dependency enforcement, conflict prevention, and context-rich agent dispatch — all through a local state file with zero external infrastructure.

## State File

All coordination state lives in `.squad/state.json` at the project root. You manage it with Read and Write tools — no server, no database.

If `.squad/state.json` does not exist, create it:

```json
{
  "version": 1,
  "project": "<project-name>",
  "updated_at": "<now ISO8601>",
  "epics": {},
  "tasks": {},
  "sessions": {}
}
```

Also ensure `.squad/` is in `.gitignore` (state is ephemeral to the coordination session).

## Core Workflow

```
1. User describes work
2. Decompose into epic + tasks (user confirms)
3. For each wave (parallel-safe group):
   a. CHECK DEPENDENCIES (mandatory)
   b. CHECK CONFLICTS (mandatory)
   c. GENERATE AGENT PROMPTS
   d. Launch agents (parallel if >1 in wave)
   e. Update status on return
   f. Show board
4. Repeat until all tasks COMPLETE
5. Show final summary
```

---

## 1. Task Decomposition

When the user describes work to parallelize:

1. **Analyze the work** to identify independent units. Each task should:
   - Touch a distinct set of files (minimize overlap)
   - Have a clear, testable outcome
   - Be completable by a single agent in one session

2. **Identify dependencies**: task B depends on task A if B needs A's output (not just the same area of code).

3. **Group into waves**: tasks with no mutual dependencies can run in parallel (same wave).

4. **Write to state.json**. For each task, include ALL fields:

```json
{
  "task-name-kebab-case": {
    "epic": "epic-name",
    "status": "PENDING",
    "description": "Short human summary",
    "files_scope": ["src/path/file.js", "src/path/other.js"],
    "depends_on": ["other-task-name"],
    "agent_context": {
      "objective": "What the agent must accomplish (1-2 sentences)",
      "key_files": {
        "src/path/file.js": "Create new. Follow pattern from src/existing/similar.js",
        "src/path/other.js": "Modify lines 45-60. Add validation before the save call"
      },
      "implementation_hints": [
        "Step 1: Read src/existing/similar.js to understand the pattern",
        "Step 2: Create src/path/file.js following that pattern",
        "Step 3: Add error handling for edge case X"
      ],
      "verification": "npm test -- --grep 'task-name' && npm run lint",
      "commit_convention": "feat(module): <description>",
      "closes_issue": "#42"
    },
    "assigned_to": null,
    "started_at": null,
    "completed_at": null,
    "summary": null
  }
}
```

**Critical: `agent_context` is where the value is.** Invest time here. A well-crafted `agent_context` eliminates the need for the agent to explore the codebase, saving 30-50% of tokens. Each `key_files` entry should explain WHY and HOW, not just list the path. Each `implementation_hints` entry should be a concrete step, not a vague instruction.

5. **Show the board to the user** for confirmation before proceeding.

---

## 2. Dependency Check (MANDATORY)

**Before launching ANY agent, you MUST check dependencies.**

Read `.squad/state.json`. For the target task, check every entry in `depends_on`:

- If ALL dependencies have `status: "COMPLETE"` -> proceed
- If ANY dependency is NOT `"COMPLETE"` -> **STOP. Do NOT launch the agent.**

Report to the user:
```
BLOCKED: task "implement-login-form" cannot start.
  Waiting on: "setup-auth-routes" (status: IN_PROGRESS)
```

**There are no exceptions to this rule.** Even if you believe the dependency is satisfied in practice, the state file is the source of truth.

---

## 3. Conflict Check (MANDATORY)

**Before launching ANY agent, you MUST check for file conflicts.**

Read `.squad/state.json`. Collect the `files_scope` of the target task. Check all other tasks with status `STARTED` or `IN_PROGRESS`:

- If NO other active task shares any file -> proceed
- If ANY active task shares a file -> **WARN the user**

Report:
```
CONFLICT: task "add-logout-button" shares files with active task "implement-login-form":
  Shared: src/components/AuthPanel.jsx
  Recommendation: Wait for "implement-login-form" to complete, or rebase after merge.
```

Proceed only with explicit user approval if conflicts exist.

---

## 4. Agent Prompt Generation

This is the core value of squad. Generate a structured prompt that gives the agent everything it needs.

**Before generating**, auto-discover project context:
1. Read `package.json` (or equivalent) for language, framework, scripts (test, build, lint)
2. Read `CLAUDE.md` if it exists (project conventions)
3. Run `ls` on directories containing `key_files` (shallow, 1 level)

**Prompt template:**

```
## Task: {task.description}

You are implementing a focused task in a {language}/{framework} project.

### Objective
{agent_context.objective}

### Project Quick Reference
- Test: `{scripts.test}`
- Build: `{scripts.build}`
- Lint: `{scripts.lint}`

### Files to Modify
{For each entry in agent_context.key_files:}
**`{path}`** — {annotation}
{If annotation mentions "Follow pattern from X":}
> Read `{X}` first to understand the pattern before writing.

### Implementation Steps
{agent_context.implementation_hints as numbered list}

### Verification
Run these commands before reporting completion:
```bash
{agent_context.verification}
```

### Rules
- ONLY modify files listed in "Files to Modify"
- Run verification before reporting completion
- Commit with: `{agent_context.commit_convention}`
{If closes_issue:}
- Include "Closes {closes_issue}" in commit body
- Do NOT modify any other files, even if you notice issues in them
```

**Launch the agent** with `isolation: "worktree"` for file safety.

---

## 5. Status Updates

After an agent returns:

1. **Read** `.squad/state.json`
2. **If agent succeeded**:
   - Set `status` to `"COMPLETE"`
   - Set `completed_at` to current ISO timestamp
   - Fill `summary` with what was done
3. **If agent failed**:
   - Set `status` to `"BLOCKED"`
   - Fill `summary` with the failure reason
4. **Update** `updated_at` at root level
5. **Write** state.json

### Post-completion checks:
- **Unblocked tasks**: Check if any PENDING tasks now have all `depends_on` entries COMPLETE. Mention them to the user as ready for the next wave.
- **Conflict advisory**: If the completed task shares `files_scope` with any IN_PROGRESS task, warn:
  ```
  Advisory: task "fix-routes" just completed and shares files with "add-middleware" (IN_PROGRESS):
    Shared: src/routes/api.js
    Recommendation: Rebase "add-middleware" branch before merging to avoid conflicts.
  ```

---

## 6. Board Display

Show after significant state changes or when the user asks. Read `.squad/state.json` and format:

```
=== Epic: auth-system (2/5 complete) ===

PENDING (2)
  [ ] implement-login-form       <- blocked by: setup-auth-routes
  [ ] add-logout-button

IN_PROGRESS (1)
  [~] setup-auth-routes          [agent: worktree-abc]

COMPLETE (2)
  [x] design-auth-schema         (25min, 1 review cycle)
  [x] setup-jwt-middleware        (15min, 0 review cycles)
```

Status icons: `[ ]` PENDING, `[>]` STARTED, `[~]` IN_PROGRESS, `[!]` BLOCKED, `[x]` COMPLETE, `[-]` CANCELLED

---

## 7. Wave Orchestration

Waves are groups of tasks that can run in parallel (no mutual dependencies, no file conflicts).

**Determine waves automatically:**
1. Start with all PENDING tasks
2. Wave 1 = tasks whose `depends_on` are all already COMPLETE (or empty)
3. Within a wave, check for file conflicts. If two tasks in the same wave share files, move one to the next wave.
4. After Wave 1 completes, recalculate Wave 2 from remaining PENDING tasks.

**For each wave:**
1. Announce: "Wave N: launching {count} agents in parallel"
2. Check deps + conflicts for each task (sections 2 & 3)
3. Generate prompts (section 4)
4. Launch agents (parallel via multiple Agent tool calls in one message)
5. As agents return, update status (section 5)
6. Show board (section 6)
7. If any task BLOCKED, inform user and ask for direction

---

## 8. Review Integration

After each wave completes, optionally run review agents:

1. For each COMPLETE task, ask the user if review is needed
2. If yes, launch a review agent with the task's files and a review prompt
3. If review finds issues (BLOCK), create a fix task that depends on the original
4. The fix task inherits the original's `files_scope` and gets its own `agent_context`

---

## Task Status Lifecycle

```
PENDING → STARTED → IN_PROGRESS → COMPLETE
                  ↘ BLOCKED → (fix) → IN_PROGRESS → COMPLETE
                                    ↗
PENDING → CANCELLED (user decided not to do it)
```

- **PENDING**: Registered, not yet claimed
- **STARTED**: Agent launched, work beginning
- **IN_PROGRESS**: Agent actively implementing
- **BLOCKED**: Cannot proceed (dep, test failure, conflict)
- **COMPLETE**: Done and verified
- **CANCELLED**: Abandoned

---

## Multi-Session Mode (MCP Addon)

If the project uses the squad-mcp server addon for multi-session coordination:

1. **On startup**: Call `squad_pull` to get the latest board state from the server
2. **Before claiming a task**: Call `squad_lock(task_name, session_id)` for atomic claim
3. **After any state change**: Call `squad_sync(state_json)` to publish to the server

This is only needed when multiple independent Claude Code sessions coordinate. In single-session (the common case), the state file alone is sufficient.

---

## Quick Reference

| Action | What to do |
|--------|------------|
| Start coordinating | Create `.squad/state.json` with tasks |
| Before launching agent | Check deps (section 2) + conflicts (section 3) |
| Launch agent | Generate prompt (section 4), use `isolation: "worktree"` |
| Agent returns | Update status (section 5), show board (section 6) |
| All tasks done | Show final summary with timing and review stats |
