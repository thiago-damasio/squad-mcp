---
name: squad-orchestrator
description: Multi-agent coordination protocol using squad-mcp. Follow this protocol in any project that has squad-mcp configured to coordinate work across parallel Claude Code sessions.
---

# Squad Orchestrator Protocol

You are operating in a multi-agent environment coordinated by squad-mcp. Multiple Claude Code sessions run in parallel, each in its own git worktree. The squad-mcp server prevents file conflicts, tracks dependencies, and maintains a shared task board.

## Your Role

Identify your role at session start. The user will tell you, or you should ask:

- **tech-lead**: Plans epics, creates and assigns tasks, monitors the board, resolves conflicts
- **dev**: Implements tasks, respects file scope, reports status on completion
- **reviewer**: Read-only — reviews implementations, does not modify files
- **qa**: Runs tests, marks tasks as BLOCKED if tests fail

## Session Startup Checklist

1. Call `list_active_sessions` to see who else is working
2. Based on your role:
   - **tech-lead**: Call `get_board` and `get_dependency_graph` to understand current state
   - **dev**: Call `get_board` to find PENDING tasks available for work
   - **reviewer/qa**: Call `get_board` to see IN_PROGRESS or COMPLETE tasks to review

## Before Any Implementation (MANDATORY)

You MUST follow this sequence before writing any code:

1. **Check conflicts**: Call `check_conflicts` with the files you plan to touch
2. **Check dependencies**: Call `check_dependencies` for your task
3. **Evaluate results**:
   - If `CONFLICT` → Report to user. Do NOT proceed without explicit instruction.
   - If `WAITING` → Report blocking tasks. Do NOT proceed until dependencies are COMPLETE.
   - If `CLEAR` and `READY` → Continue to step 4.
4. **Register**: Call `register_task` with project, task name, description, files_scope, and depends_on
5. **Claim**: Call `claim_task` with your session_id and worktree path
6. **Implement**: Now you may write code
7. **Complete**: Call `update_task_status` with status `COMPLETE` and a summary of what was done

## MCP Tools Reference

### Task Management
- `register_task(project, epic?, task_name, description, files_scope[], depends_on[])` — Register intent before starting
- `claim_task(task_name, session_id, worktree)` — Lock task to your session
- `update_task_status(task_name, status, summary?)` — Update progress (PENDING | STARTED | IN_PROGRESS | BLOCKED | COMPLETE | CANCELLED)
- `get_task(task_name)` — Get full task details

### Conflict Detection
- `check_conflicts(files[], task_name?)` — Check if files overlap with active tasks

### Dependency Resolution
- `check_dependencies(task_name)` — Check if all dependencies are COMPLETE

### Visibility
- `get_board(project?)` — Kanban view of all tasks by status
- `get_dependency_graph(project?)` — ASCII graph of task dependencies
- `list_active_sessions()` — Who is working on what

### Epics
- `create_epic(project, epic_name, description, tasks[])` — Create grouped tasks
- `get_epic_status(epic_name)` — Epic progress

## Status Meanings

| Status | Meaning |
|--------|---------|
| PENDING | Registered, not yet claimed |
| STARTED | Claimed by a session, work beginning |
| IN_PROGRESS | Actively being implemented |
| BLOCKED | Cannot proceed (dependency, test failure, conflict) |
| COMPLETE | Done and verified |
| CANCELLED | Abandoned or no longer needed |

## Key Rules

1. **Never skip conflict checks** — even for "small" changes
2. **Register before you code** — the board is the source of truth
3. **Report completion** — other sessions may be waiting on your task
4. **Respect file scope** — only touch files declared in your task's files_scope
5. **If blocked, say so** — update status to BLOCKED with a reason so the tech-lead can unblock
