# squad-mcp

Multi-agent coordination for Claude Code. Decomposes work into parallel tasks, enforces dependencies and file conflicts, and generates context-rich agent prompts — saving 30-50% of tokens per agent.

```
Layer 0 (zero install):
  skill/squad.md  -->  Claude reads/writes .squad/state.json
                       Generates rich agent prompts
                       Enforces deps + conflict checks

Layer 1 (npm install):
  + CLI (squad board/graph)  -->  Human views state in terminal
  + Hook (optional)          -->  Auto-logging

Layer 2 (squad serve):
  + MCP addon (3 tools)      -->  Multi-session sync/lock
```

---

## Table of Contents

- [Setup A: Skill Only (single user, most common)](#setup-a-skill-only)
- [Setup B: Skill + MCP Server (multi-session teams)](#setup-b-skill--mcp-server)
- [Usage Examples](#usage-examples)
- [CLI Reference](#cli-reference)
- [How It Works](#how-it-works)
- [State File Reference](#state-file-reference)
- [FAQ](#faq)

---

## Setup A: Skill Only

**For:** Single user with one Claude Code session orchestrating parallel agents in worktrees. This is the most common setup and requires zero infrastructure.

### Step 1: Install the CLI

```bash
# Option 1: Install globally (recommended)
npm install -g squad-mcp

# Option 2: Use npx without installing
npx squad-mcp init
```

### Step 2: Initialize in your project

```bash
cd ~/my-project
squad init
```

This creates three things:
- `.squad/state.json` — coordination state file
- `.squad/` added to `.gitignore`
- `.claude/commands/squad.md` — the skill that Claude Code uses

### Step 3: Use in Claude Code

Open Claude Code in your project and type:

```
/squad
```

Then describe the work you want parallelized:

```
I need to implement user authentication:
- Backend: JWT routes in src/routes/auth.js
- Frontend: Login form in src/components/LoginForm.jsx
- Frontend: Protected route wrapper in src/components/ProtectedRoute.jsx
The login form depends on the auth routes being ready.
```

Claude will decompose this into tasks, check dependencies, generate agent prompts, and launch parallel agents in isolated worktrees.

### Alternative: Zero install (copy the skill file)

If you don't want to install anything, just copy the skill:

```bash
# From the squad-mcp repo
mkdir -p ~/my-project/.claude/commands
cp skill/squad.md ~/my-project/.claude/commands/squad.md
```

Then create the state file manually or let Claude create it when you use `/squad`.

---

## Setup B: Skill + MCP Server

**For:** Multiple humans or multiple independent Claude Code sessions working on the same project simultaneously. The MCP server provides shared state visibility and atomic task claiming.

### Step 1: Install the CLI

```bash
npm install -g squad-mcp
```

### Step 2: Initialize with server support

```bash
cd ~/my-project
squad init --with-server
```

This does everything from Setup A, plus:
- Creates `.mcp.json` pointing Claude Code to the squad-mcp server

### Step 3: Start the server

```bash
# Foreground (see logs in real-time)
squad serve

# Or as a background daemon
squad serve --daemon

# Custom port
squad serve --port 4000
```

### Step 4: Each team member opens Claude Code

Each person opens their own Claude Code session in the same project. The MCP server coordinates between them:

**Session 1 (tech lead):**
```
/squad
Create an epic for the payment integration:
- Task 1: Stripe webhook handler (backend)
- Task 2: Checkout form (frontend)
- Task 3: Order confirmation page (frontend, depends on task 1)
```

**Session 2 (developer):**
```
/squad
What tasks are available? I want to pick one up.
```

The server prevents two sessions from claiming the same task.

### Step 5: Stop the server when done

```bash
squad stop
```

---

## Usage Examples

### Example 1: Security sprint (3 parallel fixes)

You have 3 security issues to close. Two can be done in parallel, one depends on another.

```
/squad

I need to close 3 security issues:

1. #116 — Sanitize WebSocket error messages in backend/server.js and backend/ws/handler.js
2. #117 — Fix IDOR in backend/routes/tasks.js and backend/routes/projects.js (ownership check)
3. #115 — Add rate limiting to backend/middleware/rateLimit.js (depends on #116 being done first,
   because #116 changes the error response format that rate limiting needs to match)

Issues #116 and #117 can run in parallel. #115 must wait for #116.
```

**What happens:**
1. Claude creates an epic with 3 tasks and dependency graph
2. **Wave 1:** Launches 2 agents in parallel (one for #116, one for #117) in isolated worktrees
3. Waits for both to complete, shows the board
4. **Wave 2:** Launches agent for #115 (dependency on #116 now satisfied)
5. Shows final summary

### Example 2: Feature with frontend + backend

```
/squad

Build a dashboard page:
- Backend: REST endpoint GET /api/dashboard/stats in src/routes/dashboard.js
  (follow pattern from src/routes/users.js)
- Frontend: Dashboard component in src/pages/Dashboard.jsx
  (use the existing DataCard component from src/components/DataCard.jsx)
- Frontend: Add route in src/App.jsx

The frontend depends on the backend endpoint existing.
```

### Example 3: Refactoring across multiple modules

```
/squad

Migrate all API calls from axios to fetch:
- src/services/auth.js (3 calls)
- src/services/users.js (5 calls)
- src/services/projects.js (4 calls)
- src/services/billing.js (2 calls)

All modules are independent — they can all be done in parallel.
Remove axios from package.json after all are done.
```

**What happens:**
1. Claude creates 4 parallel tasks (Wave 1) + 1 cleanup task (Wave 2, depends on all 4)
2. Launches 4 agents simultaneously
3. After all complete, launches the cleanup agent to remove axios

### Example 4: Checking the board mid-sprint

From your terminal (outside Claude Code):

```bash
squad board
```

Output:
```
=== Epic: auth-system (2/4 complete) ===

PENDING (1)
  [ ] add-logout-button (auth-system)  <- blocked by: implement-login-form

IN_PROGRESS (1)
  [~] implement-login-form (auth-system) [agent-1]

COMPLETE (2)
  [x] setup-auth-routes (auth-system)
  [x] setup-jwt-middleware (auth-system)
```

```bash
squad graph
```

Output:
```
[x] setup-auth-routes
[x] setup-jwt-middleware
[~] implement-login-form <-- setup-auth-routes
[ ] add-logout-button <-- implement-login-form
```

```bash
squad status
```

Output:
```
auth-system: 2/4 complete (50%), 1 in progress
```

### Example 5: Multi-session team workflow

**Terminal 1** (tech lead starts the server and creates work):
```bash
squad serve --daemon
```

Then in Claude Code:
```
/squad
Create the epic for Sprint 14. Here are the tickets:
- PROJ-201: Migrate user avatars to S3 (backend)
- PROJ-202: Add dark mode toggle (frontend)
- PROJ-203: Fix CSV export encoding (backend)
All independent, no dependencies.
```

**Terminal 2** (developer picks up work):
Opens Claude Code in the same project:
```
/squad
Show me available tasks and claim one.
```

The MCP server ensures no two sessions claim the same task.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `squad init` | Set up squad in current project (state file + skill + gitignore) |
| `squad init --with-hooks` | Also configure post-agent logging hook |
| `squad init --with-server` | Also configure .mcp.json for multi-session MCP server |
| `squad board [epic]` | Kanban board in the terminal |
| `squad graph [epic]` | ASCII dependency graph |
| `squad status` | Epic progress summary (one-liner per epic) |
| `squad serve` | Start MCP addon server (foreground) |
| `squad serve --daemon` | Start MCP addon server (background) |
| `squad serve --port 4000` | Custom port (default: 3456) |
| `squad stop` | Stop the MCP addon server |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SQUAD_PORT` | `3456` | MCP addon server port |

---

## How It Works

### The Skill (core value)

The skill (`skill/squad.md`) is a protocol document that instructs Claude Code to:

1. **Decompose work** into tasks with structured `agent_context` — each task carries everything an agent needs to start immediately
2. **Check dependencies** before every agent launch — hard gate, no exceptions
3. **Check file conflicts** between parallel tasks — warns if two agents would touch the same files
4. **Generate rich agent prompts** with objective, annotated file list, implementation steps, verification commands, and commit conventions
5. **Track status** in `.squad/state.json` — update after each agent returns
6. **Orchestrate waves** — groups of independent tasks run in parallel, dependent tasks wait

### The key differentiator: `agent_context`

Without squad, each agent must explore the codebase to understand what to do. This costs ~30-50% of tokens per agent.

With squad, the orchestrator crafts an `agent_context` for each task:

```json
{
  "objective": "Create Express routes for login, register, refresh-token",
  "key_files": {
    "src/routes/auth.js": "New file. Follow pattern from src/routes/users.js",
    "src/middleware/jwt.js": "New file. Use jsonwebtoken package already in deps"
  },
  "implementation_hints": [
    "Follow existing route pattern: router.post('/path', validate(schema), handler)",
    "JWT secret is in process.env.JWT_SECRET (see .env.example)"
  ],
  "verification": "npm test -- --grep auth && npm run lint",
  "commit_convention": "feat(auth): <description>",
  "closes_issue": "#42"
}
```

The agent receives a focused prompt with exactly what it needs — no exploration, no guessing.

### MCP Addon (multi-session only)

For teams with multiple independent Claude Code sessions, the addon server provides:

| Tool | Purpose | When to use |
|------|---------|-------------|
| `squad_pull` | Get latest shared state | On session startup |
| `squad_lock` | Atomic task claim | Before starting a task (prevents double-claim) |
| `squad_sync` | Publish state to server | After any state change |

REST equivalents for non-MCP clients:

```bash
# Get state
curl http://localhost:3456/state

# Push state
curl -X PUT http://localhost:3456/state -H 'Content-Type: application/json' -d @.squad/state.json

# Claim a task
curl -X POST http://localhost:3456/lock/task-name -H 'Content-Type: application/json' -d '{"session_id":"my-session"}'

# Health check
curl http://localhost:3456/health
```

---

## State File Reference

`.squad/state.json` is the single source of truth. Full schema at `schema/state.schema.json`.

```json
{
  "version": 1,
  "project": "my-app",
  "updated_at": "2026-03-14T18:00:00Z",
  "epics": {
    "auth-system": {
      "description": "Complete authentication system",
      "created_at": "2026-03-14T17:00:00Z"
    }
  },
  "tasks": {
    "setup-auth-routes": {
      "epic": "auth-system",
      "status": "COMPLETE",
      "description": "Express auth routes with JWT",
      "files_scope": ["src/routes/auth.js", "src/middleware/jwt.js"],
      "depends_on": [],
      "agent_context": {
        "objective": "Create Express routes for login, register, refresh-token",
        "key_files": {
          "src/routes/auth.js": "New file. Follow pattern from src/routes/users.js",
          "src/middleware/jwt.js": "New file. Use jsonwebtoken package already in deps"
        },
        "implementation_hints": [
          "Follow existing route pattern: router.post('/path', validate(schema), handler)",
          "JWT secret is in process.env.JWT_SECRET (see .env.example)"
        ],
        "verification": "npm test -- --grep auth && npm run lint",
        "commit_convention": "feat(auth): <description>",
        "closes_issue": "#42"
      },
      "assigned_to": null,
      "started_at": "2026-03-14T18:05:00Z",
      "completed_at": "2026-03-14T18:25:00Z",
      "summary": "Auth routes with JWT validation, refresh flow, and rate limiting"
    },
    "implement-login-form": {
      "epic": "auth-system",
      "status": "PENDING",
      "description": "Login form component",
      "files_scope": ["src/components/LoginForm.jsx", "src/styles/auth.css"],
      "depends_on": ["setup-auth-routes"],
      "agent_context": {
        "objective": "Create login form that calls POST /api/auth/login",
        "key_files": {
          "src/components/LoginForm.jsx": "New file. Follow pattern from src/components/RegisterForm.jsx",
          "src/styles/auth.css": "Append styles. Use design tokens from src/styles/tokens.css"
        },
        "implementation_hints": [
          "Use useForm hook from src/hooks/useForm.js for validation",
          "Store JWT in httpOnly cookie via the existing cookie utility",
          "Show loading spinner during API call (use existing Spinner component)"
        ],
        "verification": "npm run build && npm test -- --grep LoginForm",
        "commit_convention": "feat(auth): <description>",
        "closes_issue": null
      },
      "assigned_to": null,
      "started_at": null,
      "completed_at": null,
      "summary": null
    }
  },
  "sessions": {}
}
```

### Task status lifecycle

```
PENDING --> STARTED --> IN_PROGRESS --> COMPLETE
                    \-> BLOCKED --> (fix) --> COMPLETE
PENDING --> CANCELLED
```

| Status | Meaning |
|--------|---------|
| `PENDING` | Registered, waiting for dependencies or available agent |
| `STARTED` | Agent launched, work beginning |
| `IN_PROGRESS` | Agent actively implementing |
| `BLOCKED` | Cannot proceed (failed dependency, test failure, conflict) |
| `COMPLETE` | Done and verified |
| `CANCELLED` | Abandoned by user decision |

---

## Project Structure

```
squad-mcp/
  bin/squad.js              # CLI (init, board, graph, status, serve, stop)
  skill/squad.md            # Core skill — the orchestration protocol
  hooks/post-agent.sh       # Optional post-agent logging hook
  schema/state.schema.json  # JSON Schema for .squad/state.json
  src/addon/server.js       # Optional MCP server for multi-session teams
  docs/                     # Field report and analysis from real usage
```

---

## FAQ

**Q: Do I need the MCP server?**
No. Most users only need the skill (Setup A). The MCP server is for teams with multiple independent Claude Code sessions that need shared state. If you're one person with one Claude Code window orchestrating agents, the skill alone is enough.

**Q: How is this different from just using Claude Code's Agent tool directly?**
Three things: (1) Structured `agent_context` means agents start with full context instead of exploring the codebase from scratch. (2) Dependency enforcement prevents agents from starting tasks whose prerequisites aren't done. (3) File conflict detection warns when parallel agents would touch the same files.

**Q: Does this work with other AI coding tools?**
The skill is written for Claude Code's tool system (Agent, Read, Write). The state file (`.squad/state.json`) is plain JSON and could be read/written by any tool. The MCP addon follows the standard MCP protocol.

**Q: What happens if an agent fails?**
The orchestrator marks the task as BLOCKED with the failure reason in the summary. You can then create a fix task, adjust the approach, or retry. The board always shows current state.

**Q: Can I use this for non-code work?**
The coordination model (tasks, dependencies, waves) is generic. The skill is written for code tasks (agents, worktrees, commits), but the state file could be adapted for any parallelizable work.

---

## Background

A [field report from real usage](docs/field-report-pm-os-2026-03-14.md) of squad-mcp v1 showed that the MCP server architecture added ceremony without proportional value for the most common case (single user, single session). v2 pivots to a skill-first approach where the protocol, enforcement, and context generation live in a Claude Code skill — with the MCP server as an optional addon for the less common multi-session scenario.

## License

MIT
