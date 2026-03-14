# squad-mcp

MCP Orchestrator Server for multi-agent coordination with Claude Code + git worktrees.

```
                          +------------------+
                          |    squad-mcp     |
                          |  (HTTP :3456)    |
                          |  SQLite + MCP    |
                          +--------+---------+
                                   |
              +--------------------+--------------------+
              |                    |                    |
     +--------v-------+  +--------v-------+  +--------v-------+
     | Claude Session |  | Claude Session |  | Claude Session |
     | (tech-lead)    |  | (dev)          |  | (dev)          |
     | main worktree  |  | worktree/feat-a|  | worktree/feat-b|
     +----------------+  +----------------+  +----------------+
```

Multiple Claude Code sessions run in parallel, each in its own git worktree.
squad-mcp is the central coordinator — each session checks in before acting,
preventing file conflicts, duplicate work, and dependency violations.

## Installation

```bash
git clone <repo-url> squad-mcp
cd squad-mcp
npm install
npm link
```

## Quick Start

```bash
# 1. Start the server
squad start

# 2. In your project directory
cd ~/my-project
squad init

# 3. Start Claude Code sessions
# Session 1 (tech-lead): plans epics and creates tasks
# Session 2+ (dev): claim and implement tasks
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `squad start` | Start the server in background (port 3456) |
| `squad stop` | Stop the server |
| `squad status` | Show server status and task summary |
| `squad board [project]` | Kanban board in the terminal |
| `squad ps` | List active sessions/worktrees |
| `squad graph [project]` | ASCII dependency graph |
| `squad init` | Set up squad-mcp in current project (.mcp.json + CLAUDE.md) |

### Options

- `squad start --port 4000` — Use custom port
- `squad init --port 4000` — Point .mcp.json to custom port
- Environment variable: `SQUAD_PORT=4000`

## MCP Tools Reference

### Task Management

**`register_task`** — Register a new task before starting work
```json
{
  "project": "my-app",
  "epic": "auth-system",
  "task_name": "implement-login-form",
  "description": "Create login form component with email/password",
  "files_scope": ["src/components/LoginForm.jsx", "src/styles/auth.css"],
  "depends_on": ["setup-auth-routes"]
}
```

**`claim_task`** — Lock a task to your session (optimistic lock)
```json
{
  "task_name": "implement-login-form",
  "session_id": "session-abc123",
  "worktree": "/home/user/my-app-worktrees/feat-login"
}
```

**`update_task_status`** — Update task progress
```json
{
  "task_name": "implement-login-form",
  "status": "COMPLETE",
  "summary": "Login form with validation, error handling, and tests"
}
```

**`get_task`** — Get full task details including files and dependencies

### Conflict Detection

**`check_conflicts`** — Check if files overlap with active tasks
```json
{
  "files": ["src/components/LoginForm.jsx"],
  "task_name": "implement-login-form"
}
// Returns: { "status": "CLEAR", "conflicts": [] }
// or:     { "status": "CONFLICT", "conflicts": [{ "task_name": "...", "files": [...] }] }
```

### Dependency Resolution

**`check_dependencies`** — Verify all dependencies are complete
```json
{ "task_name": "implement-login-form" }
// Returns: { "status": "READY", "blocking": [] }
// or:     { "status": "WAITING", "blocking": [{ "task_name": "setup-auth-routes", "status": "IN_PROGRESS" }] }
```

### Visibility

**`get_board`** — Kanban view grouped by status columns
**`get_dependency_graph`** — ASCII graph of task relationships
**`list_active_sessions`** — Active sessions and their current tasks

### Epics

**`create_epic`** — Create an epic with multiple tasks at once
```json
{
  "project": "my-app",
  "epic_name": "auth-system",
  "description": "Complete authentication system",
  "tasks": [
    { "name": "setup-auth-routes", "description": "Express auth routes", "files_scope": ["src/routes/auth.js"] },
    { "name": "implement-login-form", "description": "Login UI", "files_scope": ["src/components/LoginForm.jsx"], "depends_on": ["setup-auth-routes"] }
  ]
}
```

**`get_epic_status`** — Epic progress (completed / total tasks)

## How It Works

### Session Roles

| Role | Can Do | Purpose |
|------|--------|---------|
| tech-lead | Create epics, assign tasks, monitor board | Orchestrate the squad |
| dev | Claim tasks, implement, report completion | Build features |
| reviewer | Read board, review implementations | Quality gate |
| qa | Run tests, mark tasks BLOCKED | Verify correctness |

### Protocol Flow

1. **Check** — `check_conflicts` + `check_dependencies`
2. **Register** — `register_task` with file scope
3. **Claim** — `claim_task` to lock ownership
4. **Implement** — Write code within declared file scope
5. **Complete** — `update_task_status` with summary

### Data Storage

- Database: `~/.squad-mcp/squad.db` (SQLite)
- Logs: `~/.squad-mcp/squad.log`
- Server PID: `~/.squad-mcp/squad.pid`

## Configuration

The `squad init` command creates two files in your project:

**`.mcp.json`** — Points Claude Code to the squad-mcp server:
```json
{
  "mcpServers": {
    "squad-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:3456/mcp"
    }
  }
}
```

**`CLAUDE.md`** — Adds the Squad Orchestration Protocol block with rules that each Claude Code session must follow.

## Health Check

```bash
curl http://localhost:3456/health
# { "status": "ok", "version": "1.0.0", "projects": [...], "active_tasks": 0 }
```
