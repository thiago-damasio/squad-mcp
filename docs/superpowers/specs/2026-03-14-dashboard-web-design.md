# squad-mcp Dashboard Web — Design Spec

## Context

squad-mcp is a running MCP orchestrator that coordinates multiple Claude Code sessions working in parallel via git worktrees. The CLI provides basic text output (`squad board`, `squad graph`, `squad ps`) but lacks visual richness for real-time monitoring. This spec covers a read-only web dashboard served by the existing Express server, providing live visibility into tasks, dependencies, sessions, and epic progress.

## Architecture

```
Browser (React SPA)              Express (:3456)              SQLite
       |                               |                        |
       |--- GET / ------------------>  | serves dashboard/dist  |
       |--- GET /api/board ----------> | queries db ----------> |
       |--- GET /api/sessions -------> | queries db ----------> |
       |--- GET /api/graph ----------> | queries db ----------> |
       |--- GET /api/epic/:name -----> | queries db ----------> |
       |--- GET /api/stats ----------> | queries db ----------> |
       |                               |                        |
       |--- GET /api/events ---------> | SSE push on db change  |
       |                               |                        |
       |--- POST /mcp (Claude) ------> | MCP tools (unchanged)  |
```

The frontend consumes REST APIs for initial data and SSE for real-time updates. MCP tools remain unchanged — zero impact on existing functionality.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Frontend stack | React 19 + Vite + Tailwind CSS 4 | Rich components, fast build, modern styling |
| Repo structure | npm workspaces (`dashboard/` workspace) | Clean separation, single `npm install` |
| Real-time updates | SSE (Server-Sent Events) | Unidirecional server->client, sufficient for read-only dashboard |
| Theme | Dark default + light toggle | Dev-friendly dark default, localStorage persistence |
| Dashboard scope | Read-only | No actions from UI in v1, observation only |
| Layout | Multi-tab with stats bar | Scales well, organized by concern |

## Frontend Structure

```
dashboard/
  package.json
  vite.config.js
  index.html
  src/
    main.jsx
    App.jsx
    hooks/
      useSSE.js             — consumes /api/events, triggers refetch
      useApi.js             — fetch wrapper with auto-refresh on SSE
    components/
      Layout.jsx            — header, tabs, theme toggle, stats bar
      StatsBar.jsx          — summary cards (pending, in_progress, blocked, complete, sessions)
      Board.jsx             — kanban columns by status
      TaskCard.jsx          — individual task card
      Graph.jsx             — dependency graph (SVG)
      Sessions.jsx          — active sessions list
      EpicProgress.jsx      — epic view with progress bars
      ThemeToggle.jsx       — dark/light toggle button
    lib/
      theme.js              — dark/light theme config, localStorage
```

## UI Tabs

### Stats Bar (always visible)

5 summary cards above tabs:
- **Pending** — count of PENDING tasks (amber)
- **In Progress** — count of STARTED + IN_PROGRESS tasks (blue)
- **Blocked** — count of BLOCKED tasks (red)
- **Complete** — count of COMPLETE tasks (green)
- **Sessions** — count of active sessions (green)

CANCELLED tasks are excluded from stats — they are intentionally hidden from the dashboard since they represent abandoned work. The board tab also omits the CANCELLED column.

### Tab 1: Board (Kanban)

Route: `/`

Columns: PENDING | STARTED | IN_PROGRESS | BLOCKED | COMPLETE

Each TaskCard shows:
- Task name (bold)
- Epic name (if any, as tag)
- Session owner (truncated session_id)
- Worktree path
- Dependency indicator (lock icon if blocked by incomplete dependency)

Color coding: left border by status (amber=pending, blue=started/in_progress, red=blocked, green=complete).

### Tab 2: Graph (Dependencies)

Route: `/graph`

Visual SVG dependency graph:
- Nodes colored by task status
- Directed edges showing depends_on relationships
- Rendered using `dagre` (graph layout algorithm, ~15KB) for node positioning + custom SVG rendering (no d3 dependency). Dagre computes x/y coordinates via topological layering; we draw nodes and edges with plain SVG elements.

The `/api/graph` endpoint returns structured data (not ASCII). It runs its own SQL query joining `tasks` and `task_dependencies` and returns:
```json
{
  "nodes": [{ "name": "task-a", "status": "STARTED", "epic": "auth" }],
  "edges": [{ "from": "task-a", "to": "task-b" }]
}
```
This is separate from the MCP `get_dependency_graph` tool which returns ASCII for agent consumption. No logic is shared between them.

### Tab 3: Sessions

Route: `/sessions`

Table/list of active agents:
- session_id (truncated)
- Worktree path
- Project name
- Current task (if any)
- Last seen timestamp
- Status indicator: green dot (active, seen < 5min), yellow dot (stale, > 5min)

### Tab 4: Epic

Route: `/epic`

Uses two endpoints:
- `GET /api/epics?project=X` — lists all epics with summary (name, description, total, completed, progress_pct)
- `GET /api/epics/:name` — full detail for one epic including task list

The view shows a list of all epics, each with:
- Epic name and description
- Progress bar (completed / total tasks)
- Percentage
- Expandable section: clicking an epic reveals its task list with each task's status

CANCELLED tasks within an epic are excluded from the progress calculation (completed / non-cancelled total).

## Backend Changes

### New files

- `src/sse.js` — SSE client manager (addClient, removeClient, notifyClients)
- `src/api.js` — REST API route handlers (extracted to keep server.js focused on MCP)

### New REST API routes (added via `src/api.js`, mounted in `src/server.js`)

| Route | Method | Response |
|-------|--------|----------|
| `GET /api/board?project=X` | GET | `{ columns: { PENDING: [...], ... } }` |
| `GET /api/graph?project=X` | GET | `{ nodes: [...], edges: [...] }` (structured, not ASCII) |
| `GET /api/sessions?project=X` | GET | `{ sessions: [...] }` (project filter optional) |
| `GET /api/epics/:name` | GET | `{ epic_name, total, completed, progress_pct, tasks }` |
| `GET /api/epics?project=X` | GET | `{ epics: [...] }` (list all epics) |
| `GET /api/stats?project=X` | GET | `{ pending, in_progress, complete, blocked, sessions }` |
| `GET /api/events` | GET | SSE stream |

### SSE Implementation

The server maintains a Set of SSE response objects. A new module `src/sse.js` exports:
- `addClient(res)` — adds an SSE response to the set
- `removeClient(res)` — removes on disconnect
- `notifyClients()` — sends update event to all connected clients

The `notifyClients` function is passed as the third argument to each tool registration function: `register(mcp, db, notifyClients)`. Each MCP tool that mutates the database calls `notifyClients()` after the mutation. This keeps the integration explicit — tool modules receive the notifier via dependency injection, no global state.

When a mutation occurs, it sends:

```json
event: update
data: {"type":"update","timestamp":"2026-03-14T12:00:00Z"}
```

The frontend `useSSE` hook listens to `/api/events` and triggers a refetch of the currently visible tab's data when an update event arrives. This avoids polling and keeps the dashboard responsive.

### Static file serving

Express serves `dashboard/dist/` as static files. SPA fallback: any non-API, non-MCP route returns `index.html`.

## Monorepo Setup

Root `package.json` adds:
```json
{
  "workspaces": ["dashboard"],
  "scripts": {
    "build": "npm run build -w dashboard",
    "dev:dashboard": "npm run dev -w dashboard"
  }
}
```

Dashboard `package.json`:
```json
{
  "name": "squad-mcp-dashboard",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0",
    "dagre": "^0.8.5"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "vite": "^6.0.0"
  }
}
```

Vite dev server proxies API and MCP routes to the backend:

```js
// dashboard/vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3456',
      '/mcp': 'http://127.0.0.1:3456',
    },
  },
  build: {
    outDir: 'dist',
  },
});
```

## Theme

- **Dark (default):** Background #0f172a (slate-900), cards #1e293b (slate-800), text #e2e8f0 (slate-200)
- **Light:** Background #f8fafc (slate-50), cards #ffffff, text #1e293b (slate-800)
- Toggle button in header, preference saved to localStorage
- Uses Tailwind dark mode class strategy (`class` on `<html>`)

## Verification Plan

1. `npm install` (root) — installs both workspaces
2. `npm run build` — builds dashboard to `dashboard/dist/`
3. `squad start` — server serves dashboard at `http://localhost:3456/`
4. Open browser — verify stats bar shows correct counts
5. Register a task via MCP from another session — verify board updates in real-time via SSE
6. Check all 4 tabs render correctly with data
7. Toggle theme — verify dark/light switch persists on reload
8. Test with empty state (no tasks) — verify each tab shows a centered "No tasks yet" / "No sessions" / "No epics" message instead of blank content

## Out of Scope (v1)

- Dashboard actions (no write operations from UI)
- Authentication/authorization
- Terminal polish (colored `squad board`, TUI) — planned for v2
- Mobile-optimized layout
- Task filtering/search in dashboard
