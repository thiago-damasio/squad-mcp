# Field Report: squad-mcp usage in PM OS Security Sprint

**Date**: 2026-03-14
**Project**: PM OS (Node.js/React monorepo)
**Context**: Security sprint closing 3 issues (#115, #116, #117) using squad-mcp for multi-agent coordination
**Setup**: Single user, single Claude Code session, Opus model, agents in git worktrees

## Sprint Structure

- **Epic**: `security-p1p2-closure` (3 tasks)
- **Wave 1** (parallel): `sec-116` + `sec-117` — 2 dev agents in isolated worktrees
- **Wave 2** (sequential): `sec-115` — depended on `sec-116`
- **Review cycle**: Devil's Advocate review before each commit, fix agents for BLOCKs

## What Worked

### Epic creation with dependencies
`create_epic` with `depends_on` arrays modeled the task graph well. The payload was clean and atomic.

### Board visibility
`get_epic_status` returning `3/3 100%` at the end gave a clear snapshot. Useful for session journals.

### Status tracking
The PENDING → STARTED → IN_PROGRESS → COMPLETE lifecycle was natural and matched the actual workflow.

## What Did NOT Work

### Triple tracking overhead
The session maintained THREE tracking systems in parallel:
- GitHub Issues (#115, #116, #117)
- Backlog.md (BACK-12, BACK-13, BACK-14)
- Squad-MCP (sec-116, sec-117, sec-115)

Every status change required 2-3 tool calls across systems. This is pure overhead with no additional safety or insight.

### `check_conflicts` was never called
The file scope tracking — arguably the most valuable feature — was never used. In a single-user/single-Claude session, the orchestrator already knows which files each agent will touch because they wrote the agent prompts. File scopes were registered but never queried.

### `claim_task` was ceremonial
No competing sessions existed. The optimistic lock protected nothing. The session_id and worktree had to be invented before the actual worktree existed (worktree paths are only known after the Agent tool creates them).

### Dependencies were passive, not enforced
Squad-mcp did NOT prevent claiming `sec-115` before `sec-116` was COMPLETE. The orchestrator had to manually respect the dependency. If they forgot to call `check_dependencies`, nothing would stop them.

### No context for agents
The dev agent prompts were crafted manually with ~500 words each, including file paths, patterns, and code snippets. The `description` field in squad-mcp tasks was too short and lacked the structure needed to launch an agent directly.

## Token Consumption Analysis

Squad-mcp tool calls added <1% of total tokens (~5-10k out of ~1M+). The real cost came from:

| Category | Estimated tokens | % |
|----------|-----------------|---|
| Dev agents (3) | ~330k | 31% |
| Fix agents (4) | ~465k | 44% |
| Review agents (3) | ~177k | 17% |
| Exploration + Planning | ~185k | 17% |
| Squad-MCP tool calls | ~5-10k | <1% |

The multi-agent workflow itself (dev → review → fix → amend) is the main cost driver, not squad-mcp. Each agent in an isolated worktree must rediscover the project context from scratch.

## Improvement Opportunities

### P0: Active dependency enforcement

**Problem**: `claim_task` accepts any PENDING task regardless of unmet dependencies.
**Proposal**: `claim_task` should automatically call `check_dependencies` and REJECT the claim if any dependency is not COMPLETE.
```
Current:  claim_task("sec-115") → success (even if sec-116 is STARTED)
Proposed: claim_task("sec-115") → error: "Blocked by sec-116 (status: STARTED)"
```
**Impact**: Prevents ordering violations without relying on orchestrator discipline.

### P1: Agent-ready task descriptions

**Problem**: The `description` field is a flat string. Orchestrators manually craft 500+ word prompts for dev agents.
**Proposal**: Add structured fields to `register_task` / `create_epic`:
```json
{
  "name": "sec-116-ws-token-error-sanitize",
  "description": "Short summary for humans",
  "agent_context": {
    "objective": "Migrate WS auth from query to first-message handshake",
    "implementation_steps": [
      "In backend/server.js, replace query string parsing with...",
      "In frontend/src/hooks/useWebSocket.js, send auth as first message..."
    ],
    "verification": "grep -rn 'res.status(500)' backend/routes/ | grep err.message",
    "commit_message": "fix(backend): migrate WS auth...",
    "branch": "fix/116-ws-token-error-sanitize",
    "closes_issue": "#116"
  },
  "files_scope": [...],
  "depends_on": [...]
}
```
Then `get_task` returns a prompt that can be directly passed to a dev agent — or a new tool `get_agent_prompt(task_name)` generates it.

**Impact**: Eliminates the biggest manual effort in the orchestration loop.

### P1: Worktree integration

**Problem**: `claim_task` requires `session_id` and `worktree` upfront, but Claude Code's `Agent` tool with `isolation: "worktree"` creates the worktree path dynamically. The orchestrator has to invent placeholder values.
**Proposal**:
- Option A: Make `worktree` optional in `claim_task`, allow updating it later via `update_task_status`
- Option B: Add a `start_task` tool that claims AND returns a suggested worktree path/branch name
- Option C: Accept just `branch_name` instead of full worktree path

**Impact**: Cleaner integration with Claude Code's worktree model.

### P2: Replace Backlog.md, don't coexist

**Problem**: Projects using both squad-mcp AND Backlog.md maintain duplicate state.
**Proposal**: Add fields that Backlog.md has but squad-mcp lacks:
- `priority` (high/medium/low)
- `labels` (array)
- `acceptance_criteria` (array of checkable items)
- `references` (URLs)
- `implementation_notes` (append-only log)

Then projects can choose ONE system. Squad-mcp becomes the single source of truth for multi-agent work.

**Impact**: Eliminates 50%+ of tracking overhead.

### P2: Post-completion conflict advisory

**Problem**: When two parallel tasks touch the same files (e.g., sec-116 and sec-117 both modified `routes/tasks.js`), the second merge may conflict. No warning is given.
**Proposal**: When a task is marked COMPLETE, automatically check if any other IN_PROGRESS tasks share files. If so, return an advisory:
```json
{
  "status": "COMPLETE",
  "conflict_advisory": {
    "task": "sec-117-ownership-idor",
    "shared_files": ["backend/routes/tasks.js", "backend/routes/projects.js"],
    "recommendation": "Rebase sec-117 branch before merging"
  }
}
```

**Impact**: Prevents merge conflicts that waste dev/fix agent tokens.

### P3: Cycle metrics

**Problem**: No data on how the squad performed — how long each task took, how many review iterations, rework rate.
**Proposal**: Track timestamps and add a `get_epic_metrics` tool:
```json
{
  "epic": "security-p1p2-closure",
  "total_duration_min": 85,
  "tasks": [
    { "name": "sec-116", "duration_min": 25, "review_iterations": 1, "blocks_found": 1 },
    { "name": "sec-117", "duration_min": 30, "review_iterations": 1, "blocks_found": 4 },
    { "name": "sec-115", "duration_min": 30, "review_iterations": 2, "blocks_found": 1 }
  ],
  "parallelism_efficiency": 0.7
}
```

**Impact**: Informs future sprint decomposition and identifies patterns (e.g., "large tasks always need 2+ review cycles").

## When squad-mcp WOULD shine

1. **Multiple humans with their own Claude Code sessions** — `check_conflicts` becomes essential
2. **Long sprints with session handoff** — board is source of truth across context windows
3. **Real role separation** — tech-lead session plans, dev sessions implement, QA session validates
4. **Async workflows** — tasks queued, claimed by available agents over hours/days

## Verdict

For single-user, single-session, small-scope work: **overhead > benefit**. The plan file + worktrees + review agents were sufficient.

For concurrent, multi-session, multi-day work: **high potential**, contingent on P0 (active enforcement) and P1 (agent-ready context, worktree integration) improvements.

The tool's value is proportional to the **concurrency and coordination complexity** of the work. Below a threshold (~3 tasks, 1 session), the ceremony cost exceeds the safety benefit.
