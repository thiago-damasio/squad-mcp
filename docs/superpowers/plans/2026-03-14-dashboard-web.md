# Dashboard Web Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only React web dashboard to squad-mcp, served by the existing Express server at `:3456`, with 4 tabs (Board, Graph, Sessions, Epic), real-time SSE updates, and dark/light theme toggle.

**Architecture:** Express serves REST API routes (`/api/*`) for dashboard data and SSE (`/api/events`) for real-time push. A React SPA (Vite + Tailwind) lives in a `dashboard/` npm workspace, built to `dashboard/dist/` and served as static files. MCP tools call `notifyClients()` after mutations to trigger SSE events.

**Tech Stack:** React 19, Vite 6, Tailwind CSS 4, dagre (graph layout), react-router-dom 7

**Spec:** `docs/superpowers/specs/2026-03-14-dashboard-web-design.md`

---

## File Map

### New files
| File | Responsibility |
|------|---------------|
| `src/sse.js` | SSE client manager — addClient, removeClient, notifyClients |
| `src/api.js` | REST API route handlers for dashboard (/api/board, /api/graph, /api/sessions, /api/epics, /api/stats, /api/events) |
| `dashboard/package.json` | Frontend workspace config |
| `dashboard/vite.config.js` | Vite build + dev proxy config |
| `dashboard/index.html` | SPA entry point |
| `dashboard/src/main.jsx` | React root mount |
| `dashboard/src/App.jsx` | Router + Layout with tabs |
| `dashboard/src/main.css` | Tailwind imports |
| `dashboard/src/hooks/useSSE.js` | SSE EventSource hook, triggers refetch callback |
| `dashboard/src/hooks/useApi.js` | Fetch wrapper with SSE-triggered refresh |
| `dashboard/src/components/Layout.jsx` | Header, tabs nav, stats bar, theme toggle, outlet |
| `dashboard/src/components/StatsBar.jsx` | 5 summary stat cards |
| `dashboard/src/components/Board.jsx` | Kanban columns by status |
| `dashboard/src/components/TaskCard.jsx` | Individual task card |
| `dashboard/src/components/Graph.jsx` | Dependency graph with dagre + SVG |
| `dashboard/src/components/Sessions.jsx` | Active sessions table |
| `dashboard/src/components/EpicProgress.jsx` | Epic list with progress bars |
| `dashboard/src/components/ThemeToggle.jsx` | Dark/light toggle button |
| `dashboard/src/lib/theme.js` | Theme persistence (localStorage) |

### Modified files
| File | Change |
|------|--------|
| `package.json` (root) | Add `"workspaces": ["dashboard"]`, add build/dev scripts |
| `src/server.js` | Import sse.js + api.js, mount API routes, serve static dashboard, pass notifyClients to tool registrations |
| `src/tools/task-tools.js` | Accept 3rd arg `notifyClients`, call after mutations |
| `src/tools/conflict-tools.js` | Accept 3rd arg (no-op, read-only tool) |
| `src/tools/dependency-tools.js` | Accept 3rd arg (no-op, read-only tool) |
| `src/tools/board-tools.js` | Accept 3rd arg (no-op, read-only tools) |
| `src/tools/epic-tools.js` | Accept 3rd arg `notifyClients`, call after mutations |

---

## Chunk 1: Backend — SSE + REST API + Integration

### Task 1: SSE Module

**Files:**
- Create: `src/sse.js`

- [ ] **Step 1: Create `src/sse.js`**

```js
// src/sse.js
const clients = new Set();

export function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function notifyClients() {
  const data = JSON.stringify({ type: 'update', timestamp: new Date().toISOString() });
  for (const client of clients) {
    client.write(`event: update\ndata: ${data}\n\n`);
  }
}
```

- [ ] **Step 2: Verify module loads**

Run: `node -e "import('./src/sse.js').then(m => console.log(Object.keys(m)))"`
Expected: `[ 'addClient', 'notifyClients' ]`

- [ ] **Step 3: Commit**

```bash
git add src/sse.js
git commit -m "feat: add SSE client manager module"
```

### Task 2: REST API Routes

**Files:**
- Create: `src/api.js`

- [ ] **Step 1: Create `src/api.js`**

```js
// src/api.js
import { Router } from 'express';
import { addClient } from './sse.js';

export function createApiRouter(db) {
  const router = Router();

  // GET /api/stats?project=X
  router.get('/api/stats', (req, res) => {
    const { project } = req.query;
    let where = "WHERE t.status != 'CANCELLED'";
    const params = [];
    if (project) {
      where += ' AND p.name = ?';
      params.push(project);
    }

    const counts = db.prepare(`
      SELECT t.status, COUNT(*) as count
      FROM tasks t JOIN projects p ON t.project_id = p.id
      ${where}
      GROUP BY t.status
    `).all(...params);

    const stats = { pending: 0, started: 0, in_progress: 0, blocked: 0, complete: 0 };
    for (const row of counts) {
      const key = row.status.toLowerCase();
      if (key in stats) stats[key] = row.count;
    }

    let sessionWhere = '';
    const sessionParams = [];
    if (project) {
      sessionWhere = 'WHERE project = ?';
      sessionParams.push(project);
    }
    const sessionCount = db.prepare(
      `SELECT COUNT(*) as count FROM sessions ${sessionWhere}`
    ).get(...sessionParams);

    res.json({ ...stats, sessions: sessionCount.count });
  });

  // GET /api/board?project=X
  router.get('/api/board', (req, res) => {
    const { project } = req.query;
    let query = `
      SELECT t.name, t.description, t.status, t.session_id, t.worktree,
             p.name as project_name, e.name as epic_name
      FROM tasks t
      JOIN projects p ON t.project_id = p.id
      LEFT JOIN epics e ON t.epic_id = e.id
      WHERE t.status != 'CANCELLED'
    `;
    const params = [];
    if (project) {
      query += ' AND p.name = ?';
      params.push(project);
    }
    query += ' ORDER BY t.created_at';
    const tasks = db.prepare(query).all(...params);

    // Check blocking dependencies per task
    const depStmt = db.prepare(`
      SELECT t.name, t.status FROM task_dependencies td
      JOIN tasks t ON td.depends_on_task_id = t.id
      WHERE td.task_id = ? AND t.status != 'COMPLETE'
    `);

    const taskIdStmt = db.prepare('SELECT id FROM tasks WHERE name = ?');

    const columns = {
      PENDING: [], STARTED: [], IN_PROGRESS: [], BLOCKED: [], COMPLETE: [],
    };

    for (const t of tasks) {
      const taskRow = taskIdStmt.get(t.name);
      const blockingDeps = taskRow ? depStmt.all(taskRow.id) : [];
      columns[t.status].push({
        task_name: t.name,
        description: t.description,
        project: t.project_name,
        epic: t.epic_name,
        session_id: t.session_id,
        worktree: t.worktree,
        has_blocking_deps: blockingDeps.length > 0,
        blocking_deps: blockingDeps.map(d => d.name),
      });
    }

    res.json({ columns });
  });

  // GET /api/graph?project=X
  router.get('/api/graph', (req, res) => {
    const { project } = req.query;
    let taskQuery = `
      SELECT t.name, t.status, e.name as epic
      FROM tasks t
      JOIN projects p ON t.project_id = p.id
      LEFT JOIN epics e ON t.epic_id = e.id
      WHERE t.status != 'CANCELLED'
    `;
    const params = [];
    if (project) {
      taskQuery += ' AND p.name = ?';
      params.push(project);
    }
    const nodes = db.prepare(taskQuery).all(...params);

    const taskNames = new Set(nodes.map(n => n.name));
    let edgeQuery = `
      SELECT t.name as "from", dep.name as "to"
      FROM task_dependencies td
      JOIN tasks t ON td.task_id = t.id
      JOIN tasks dep ON td.depends_on_task_id = dep.id
    `;
    const edges = db.prepare(edgeQuery).all()
      .filter(e => taskNames.has(e.from) && taskNames.has(e.to));

    res.json({ nodes, edges });
  });

  // GET /api/sessions?project=X
  router.get('/api/sessions', (req, res) => {
    const { project } = req.query;
    let query = `
      SELECT s.session_id, s.worktree, s.project, s.last_seen_at,
             t.name as current_task, t.status as task_status
      FROM sessions s
      LEFT JOIN tasks t ON t.session_id = s.session_id
        AND t.status IN ('STARTED', 'IN_PROGRESS')
    `;
    const params = [];
    if (project) {
      query += ' WHERE s.project = ?';
      params.push(project);
    }
    query += ' ORDER BY s.last_seen_at DESC';
    const sessions = db.prepare(query).all(...params);
    res.json({ sessions });
  });

  // GET /api/epics?project=X
  router.get('/api/epics', (req, res) => {
    const { project } = req.query;
    let query = `
      SELECT e.id, e.name, e.description, p.name as project_name
      FROM epics e
      JOIN projects p ON e.project_id = p.id
    `;
    const params = [];
    if (project) {
      query += ' WHERE p.name = ?';
      params.push(project);
    }
    const epics = db.prepare(query).all(...params);

    const taskStmt = db.prepare(
      "SELECT name, status FROM tasks WHERE epic_id = ? AND status != 'CANCELLED' ORDER BY created_at"
    );

    const result = epics.map(e => {
      const tasks = taskStmt.all(e.id);
      const total = tasks.length;
      const completed = tasks.filter(t => t.status === 'COMPLETE').length;
      return {
        epic_name: e.name,
        project: e.project_name,
        description: e.description,
        total,
        completed,
        progress_pct: total > 0 ? Math.round((completed / total) * 100) : 0,
        tasks,
      };
    });

    res.json({ epics: result });
  });

  // GET /api/epics/:name
  router.get('/api/epics/:name', (req, res) => {
    const epic = db.prepare(`
      SELECT e.*, p.name as project_name FROM epics e
      JOIN projects p ON e.project_id = p.id
      WHERE e.name = ?
    `).get(req.params.name);

    if (!epic) {
      res.status(404).json({ error: 'epic_not_found' });
      return;
    }

    const tasks = db.prepare(
      "SELECT name, status, session_id, summary FROM tasks WHERE epic_id = ? AND status != 'CANCELLED' ORDER BY created_at"
    ).all(epic.id);

    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'COMPLETE').length;

    res.json({
      epic_name: epic.name,
      project: epic.project_name,
      description: epic.description,
      total,
      completed,
      progress_pct: total > 0 ? Math.round((completed / total) * 100) : 0,
      tasks,
    });
  });

  // GET /api/events (SSE)
  router.get('/api/events', (req, res) => {
    addClient(res);
  });

  return router;
}
```

- [ ] **Step 2: Verify module loads**

Run: `node -e "import('./src/api.js').then(m => console.log(Object.keys(m)))"`
Expected: `[ 'createApiRouter' ]`

- [ ] **Step 3: Commit**

```bash
git add src/api.js
git commit -m "feat: add REST API routes for dashboard"
```

### Task 3: Wire SSE into MCP Tools

**Files:**
- Modify: `src/server.js`
- Modify: `src/tools/task-tools.js`
- Modify: `src/tools/epic-tools.js`
- Modify: `src/tools/conflict-tools.js`
- Modify: `src/tools/dependency-tools.js`
- Modify: `src/tools/board-tools.js`

- [ ] **Step 1: Update tool registration signatures**

In each tool file, change `export function register(mcp, db)` to `export function register(mcp, db, notify)`.

**Read-only tools** (conflict-tools.js, dependency-tools.js, board-tools.js) — just accept the 3rd parameter, no calls needed.

**task-tools.js** — add `notify()` after each mutation:

In `register_task` handler, change the return block:
```js
      // was: return { content: [...] };
      const result = db.transaction(() => { ... })();
      notify();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
```

In `claim_task` handler, add notify after successful claim:
```js
      const result = db.transaction(() => { ... })();
      if (result.success) notify();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
```

In `update_task_status` handler, add notify after the UPDATE (before the `const updated =` line):
```js
      // After the if/else block that runs db.prepare('UPDATE tasks...').run(...)
      notify();
      const updated = db.prepare('SELECT updated_at FROM tasks WHERE name = ?').get(task_name);
```

**epic-tools.js** — add `notify()` after mutation:

In `create_epic` handler:
```js
      const result = db.transaction(() => { ... })();
      notify();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
```

- [ ] **Step 2: Update `src/server.js`**

Add imports and wire everything together:

```js
// Add at top of server.js:
import { notifyClients } from './sse.js';
import { createApiRouter } from './api.js';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// In createMcpServer(db), pass notifyClients as 3rd arg:
registerTaskTools(mcp, db, notifyClients);
registerConflictTools(mcp, db, notifyClients);
registerDependencyTools(mcp, db, notifyClients);
registerBoardTools(mcp, db, notifyClients);
registerEpicTools(mcp, db, notifyClients);

// In startServer(), after app.use(express.json()):
// Mount API routes
app.use(createApiRouter(db));

// Serve dashboard static files (after all other routes, before MCP)
const __dirname_server = dirname(fileURLToPath(import.meta.url));
const dashboardDist = join(__dirname_server, '..', 'dashboard', 'dist');
if (existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  // SPA fallback — must come after /api, /mcp, /health routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/mcp') || req.path.startsWith('/api') || req.path === '/health') {
      return next();
    }
    res.sendFile(join(dashboardDist, 'index.html'));
  });
}
```

- [ ] **Step 3: Test server starts and API responds**

Run:
```bash
node src/server.js &
sleep 2
curl -s http://127.0.0.1:3456/api/stats | head -c 200
curl -s http://127.0.0.1:3456/api/board | head -c 200
kill %1
```
Expected: JSON responses with stats and board data.

- [ ] **Step 4: Commit**

```bash
git add src/server.js src/tools/ src/sse.js src/api.js
git commit -m "feat: integrate SSE notifications and REST API into server"
```

---

## Chunk 2: Frontend — Workspace Setup + Shell + Theme

### Task 4: Monorepo Workspace Setup

**Files:**
- Modify: `package.json` (root)
- Create: `dashboard/package.json`
- Create: `dashboard/vite.config.js`
- Create: `dashboard/index.html`

- [ ] **Step 1: Update root `package.json`**

Add `"workspaces": ["dashboard"]` at the top level and merge new scripts into the existing `"scripts"` object. The final result should be:
```json
{
  "workspaces": ["dashboard"],
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js",
    "dev:dashboard": "npm run dev -w dashboard",
    "build": "npm run build -w dashboard",
    "install-global": "npm link"
  }
}
```
Note: `"start"`, `"dev"`, and `"install-global"` already exist — keep them unchanged. Only add `"workspaces"`, `"dev:dashboard"`, and `"build"`.

- [ ] **Step 2: Create `dashboard/package.json`**

```json
{
  "name": "squad-mcp-dashboard",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0",
    "dagre": "^0.8.5"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 3: Create `dashboard/vite.config.js`**

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
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

- [ ] **Step 4: Create `dashboard/index.html`**

```html
<!DOCTYPE html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>squad-mcp</title>
  </head>
  <body class="bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200 min-h-screen">
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: installs both root and dashboard workspace dependencies

- [ ] **Step 6: Commit**

```bash
git add package.json dashboard/package.json dashboard/vite.config.js dashboard/index.html package-lock.json
git commit -m "feat: add dashboard workspace with Vite + React + Tailwind"
```

### Task 5: Theme + Hooks + App Shell

**Files:**
- Create: `dashboard/src/main.jsx`
- Create: `dashboard/src/main.css`
- Create: `dashboard/src/App.jsx`
- Create: `dashboard/src/lib/theme.js`
- Create: `dashboard/src/hooks/useSSE.js`
- Create: `dashboard/src/hooks/useApi.js`
- Create: `dashboard/src/components/ThemeToggle.jsx`
- Create: `dashboard/src/components/StatsBar.jsx`
- Create: `dashboard/src/components/Layout.jsx`

- [ ] **Step 1: Create `dashboard/src/lib/theme.js`**

```js
export function getInitialTheme() {
  const stored = localStorage.getItem('squad-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return 'dark';
}

export function applyTheme(theme) {
  localStorage.setItem('squad-theme', theme);
  if (theme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}
```

- [ ] **Step 2: Create `dashboard/src/hooks/useSSE.js`**

```jsx
import { useEffect, useRef } from 'react';

export function useSSE(onUpdate) {
  const callbackRef = useRef(onUpdate);
  callbackRef.current = onUpdate;

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('update', () => {
      callbackRef.current();
    });
    return () => source.close();
  }, []);
}
```

- [ ] **Step 3: Create `dashboard/src/hooks/useApi.js`**

```jsx
import { useState, useEffect, useCallback } from 'react';

export function useApi(url) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(() => {
    fetch(url)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [url]);

  useEffect(() => { refetch(); }, [refetch]);

  return { data, loading, refetch };
}
```

- [ ] **Step 4: Create `dashboard/src/components/ThemeToggle.jsx`**

```jsx
import { useState } from 'react';
import { getInitialTheme, applyTheme } from '../lib/theme.js';

export function ThemeToggle() {
  const [theme, setTheme] = useState(getInitialTheme);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
  };

  return (
    <button
      onClick={toggle}
      className="p-2 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors"
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      {theme === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19'}
    </button>
  );
}
```

- [ ] **Step 5: Create `dashboard/src/components/StatsBar.jsx`**

```jsx
export function StatsBar({ stats }) {
  if (!stats) return null;

  const cards = [
    { label: 'Pending', value: stats.pending, color: 'bg-amber-500' },
    { label: 'In Progress', value: stats.started + stats.in_progress, color: 'bg-blue-500' },
    { label: 'Blocked', value: stats.blocked, color: 'bg-red-500' },
    { label: 'Complete', value: stats.complete, color: 'bg-emerald-500' },
    { label: 'Sessions', value: stats.sessions, color: 'bg-violet-500' },
  ];

  return (
    <div className="grid grid-cols-5 gap-3 mb-4">
      {cards.map(c => (
        <div key={c.label} className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2 mb-1">
            <div className={`w-2 h-2 rounded-full ${c.color}`} />
            <span className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">{c.label}</span>
          </div>
          <div className="text-2xl font-bold">{c.value}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Create `dashboard/src/components/Layout.jsx`**

```jsx
import { NavLink, Outlet } from 'react-router-dom';
import { ThemeToggle } from './ThemeToggle.jsx';
import { StatsBar } from './StatsBar.jsx';
import { useApi } from '../hooks/useApi.js';
import { useSSE } from '../hooks/useSSE.js';

export function Layout() {
  const { data: stats, refetch } = useApi('/api/stats');
  useSSE(refetch);

  const tabs = [
    { to: '/', label: 'Board' },
    { to: '/graph', label: 'Graph' },
    { to: '/sessions', label: 'Sessions' },
    { to: '/epic', label: 'Epic' },
  ];

  const tabClass = ({ isActive }) =>
    `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
      isActive
        ? 'bg-violet-600 text-white'
        : 'text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
    }`;

  return (
    <div className="max-w-7xl mx-auto px-4 py-4">
      <header className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-violet-500">squad-mcp</h1>
        <div className="flex items-center gap-3">
          <nav className="flex gap-1">
            {tabs.map(t => (
              <NavLink key={t.to} to={t.to} end={t.to === '/'} className={tabClass}>
                {t.label}
              </NavLink>
            ))}
          </nav>
          <ThemeToggle />
        </div>
      </header>
      <StatsBar stats={stats} />
      <Outlet context={{ stats }} />
    </div>
  );
}
```

- [ ] **Step 7: Create `dashboard/src/main.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 8: Create `dashboard/src/main.jsx`**

```jsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme, getInitialTheme } from './lib/theme.js';
import App from './App.jsx';
import './main.css';

applyTheme(getInitialTheme());
createRoot(document.getElementById('root')).render(
  <StrictMode><App /></StrictMode>
);
```

- [ ] **Step 9: Create `dashboard/src/App.jsx`** (placeholder pages for now)

```jsx
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout.jsx';

function Placeholder({ name }) {
  return (
    <div className="flex items-center justify-center h-64 text-slate-400">
      {name} — coming next
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Placeholder name="Board" />} />
          <Route path="graph" element={<Placeholder name="Graph" />} />
          <Route path="sessions" element={<Placeholder name="Sessions" />} />
          <Route path="epic" element={<Placeholder name="Epic" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 10: Build and verify shell renders**

Run:
```bash
npm run build
node src/server.js &
sleep 2
curl -s http://127.0.0.1:3456/ | head -c 500
kill %1
```
Expected: HTML content with `<div id="root">` returned.

- [ ] **Step 11: Commit**

```bash
git add dashboard/src/
git commit -m "feat: add dashboard app shell with layout, theme toggle, stats bar"
```

---

## Chunk 3: Frontend — Tab Components (Board, Graph, Sessions, Epic)

### Task 6: Board Tab (Kanban)

**Files:**
- Create: `dashboard/src/components/TaskCard.jsx`
- Create: `dashboard/src/components/Board.jsx`
- Modify: `dashboard/src/App.jsx` — replace Board placeholder with real component

- [ ] **Step 1: Create `dashboard/src/components/TaskCard.jsx`**

```jsx
const STATUS_COLORS = {
  PENDING: 'border-l-amber-500',
  STARTED: 'border-l-blue-500',
  IN_PROGRESS: 'border-l-blue-500',
  BLOCKED: 'border-l-red-500',
  COMPLETE: 'border-l-emerald-500',
};

export function TaskCard({ task }) {
  const borderColor = STATUS_COLORS[task.status] || 'border-l-slate-500';

  return (
    <div className={`bg-white dark:bg-slate-800 rounded-lg p-3 border-l-4 ${borderColor} border border-slate-200 dark:border-slate-700 mb-2`}>
      <div className="font-medium text-sm">{task.task_name}</div>
      {task.epic && (
        <span className="inline-block text-xs bg-violet-100 dark:bg-violet-900 text-violet-700 dark:text-violet-300 rounded px-1.5 py-0.5 mt-1">
          {task.epic}
        </span>
      )}
      {task.description && (
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">{task.description}</p>
      )}
      {task.session_id && (
        <div className="text-xs text-slate-400 mt-1">
          {task.session_id.slice(0, 8)}
        </div>
      )}
      {task.worktree && (
        <div className="text-xs text-slate-400 truncate">{task.worktree}</div>
      )}
      {task.has_blocking_deps && (
        <div className="text-xs text-red-400 mt-1">
          Blocked by: {task.blocking_deps.join(', ')}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `dashboard/src/components/Board.jsx`**

```jsx
import { useApi } from '../hooks/useApi.js';
import { useSSE } from '../hooks/useSSE.js';
import { TaskCard } from './TaskCard.jsx';

const COLUMNS = ['PENDING', 'STARTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETE'];

const COLUMN_LABELS = {
  PENDING: 'Pending',
  STARTED: 'Started',
  IN_PROGRESS: 'In Progress',
  BLOCKED: 'Blocked',
  COMPLETE: 'Complete',
};

export function Board() {
  const { data, loading, refetch } = useApi('/api/board');
  useSSE(refetch);

  if (loading) return <div className="text-slate-400 text-center py-8">Loading...</div>;

  const columns = data?.columns || {};
  const isEmpty = COLUMNS.every(col => (columns[col] || []).length === 0);

  if (isEmpty) {
    return <div className="text-slate-400 text-center py-16">No tasks yet</div>;
  }

  return (
    <div className="grid grid-cols-5 gap-3 items-start">
      {COLUMNS.map(status => (
        <div key={status}>
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
            {COLUMN_LABELS[status]} ({(columns[status] || []).length})
          </div>
          {(columns[status] || []).map(task => (
            <TaskCard key={task.task_name} task={{ ...task, status }} />
          ))}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Update `dashboard/src/App.jsx`** — import Board, replace placeholder

Replace `<Placeholder name="Board" />` with `<Board />`:
```jsx
import { Board } from './components/Board.jsx';
// In routes:
<Route index element={<Board />} />
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: builds without errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/TaskCard.jsx dashboard/src/components/Board.jsx dashboard/src/App.jsx
git commit -m "feat: add Board tab with kanban columns and task cards"
```

### Task 7: Graph Tab (Dependencies)

**Files:**
- Create: `dashboard/src/components/Graph.jsx`
- Modify: `dashboard/src/App.jsx` — replace Graph placeholder

- [ ] **Step 1: Create `dashboard/src/components/Graph.jsx`**

```jsx
import { useApi } from '../hooks/useApi.js';
import { useSSE } from '../hooks/useSSE.js';
import { useMemo } from 'react';
import dagre from 'dagre';

const STATUS_COLORS = {
  PENDING: '#f59e0b',
  STARTED: '#3b82f6',
  IN_PROGRESS: '#3b82f6',
  BLOCKED: '#ef4444',
  COMPLETE: '#22c55e',
};

const NODE_WIDTH = 180;
const NODE_HEIGHT = 50;

export function Graph() {
  const { data, loading, refetch } = useApi('/api/graph');
  useSSE(refetch);

  const layout = useMemo(() => {
    if (!data || data.nodes.length === 0) return null;

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 80 });
    g.setDefaultEdgeLabel(() => ({}));

    for (const node of data.nodes) {
      g.setNode(node.name, { width: NODE_WIDTH, height: NODE_HEIGHT });
    }
    for (const edge of data.edges) {
      g.setEdge(edge.from, edge.to);
    }

    dagre.layout(g);

    const nodes = data.nodes.map(n => {
      const pos = g.node(n.name);
      return { ...n, x: pos.x, y: pos.y };
    });

    const edges = data.edges.map(e => {
      const points = g.edge(e.from, e.to).points;
      return { ...e, points };
    });

    const graphData = g.graph();
    return { nodes, edges, width: graphData.width + 40, height: graphData.height + 40 };
  }, [data]);

  if (loading) return <div className="text-slate-400 text-center py-8">Loading...</div>;
  if (!layout) return <div className="text-slate-400 text-center py-16">No tasks yet</div>;

  return (
    <div className="overflow-auto bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
      <svg width={layout.width} height={layout.height}>
        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="#94a3b8" />
          </marker>
        </defs>
        {layout.edges.map((e, i) => {
          const points = e.points.map(p => `${p.x + 20},${p.y + 20}`).join(' ');
          return (
            <polyline key={i} points={points} fill="none" stroke="#94a3b8" strokeWidth="1.5" markerEnd="url(#arrowhead)" />
          );
        })}
        {layout.nodes.map(n => (
          <g key={n.name} transform={`translate(${n.x - NODE_WIDTH / 2 + 20}, ${n.y - NODE_HEIGHT / 2 + 20})`}>
            <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx="8"
              fill={STATUS_COLORS[n.status] || '#94a3b8'} opacity="0.15"
              stroke={STATUS_COLORS[n.status] || '#94a3b8'} strokeWidth="2" />
            <text x={NODE_WIDTH / 2} y="20" textAnchor="middle"
              className="fill-slate-800 dark:fill-slate-200 text-xs font-medium">
              {n.name.length > 22 ? n.name.slice(0, 20) + '...' : n.name}
            </text>
            <text x={NODE_WIDTH / 2} y="36" textAnchor="middle"
              className="text-[10px]" fill={STATUS_COLORS[n.status]}>
              {n.status}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
```

- [ ] **Step 2: Update `dashboard/src/App.jsx`** — import Graph, replace placeholder

```jsx
import { Graph } from './components/Graph.jsx';
// In routes:
<Route path="graph" element={<Graph />} />
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: builds without errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/Graph.jsx dashboard/src/App.jsx
git commit -m "feat: add Graph tab with dagre layout and SVG rendering"
```

### Task 8: Sessions Tab

**Files:**
- Create: `dashboard/src/components/Sessions.jsx`
- Modify: `dashboard/src/App.jsx` — replace Sessions placeholder

- [ ] **Step 1: Create `dashboard/src/components/Sessions.jsx`**

```jsx
import { useApi } from '../hooks/useApi.js';
import { useSSE } from '../hooks/useSSE.js';

function isActive(lastSeen) {
  if (!lastSeen) return false;
  const diff = Date.now() - new Date(lastSeen + 'Z').getTime();
  return diff < 5 * 60 * 1000; // 5 minutes
}

export function Sessions() {
  const { data, loading, refetch } = useApi('/api/sessions');
  useSSE(refetch);

  if (loading) return <div className="text-slate-400 text-center py-8">Loading...</div>;

  const sessions = data?.sessions || [];

  if (sessions.length === 0) {
    return <div className="text-slate-400 text-center py-16">No sessions</div>;
  }

  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-700 text-left text-xs text-slate-500 dark:text-slate-400 uppercase">
            <th className="p-3">Status</th>
            <th className="p-3">Session</th>
            <th className="p-3">Project</th>
            <th className="p-3">Worktree</th>
            <th className="p-3">Current Task</th>
            <th className="p-3">Last Seen</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s, i) => (
            <tr key={i} className="border-b border-slate-100 dark:border-slate-700/50">
              <td className="p-3">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${isActive(s.last_seen_at) ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              </td>
              <td className="p-3 font-mono text-xs">{s.session_id?.slice(0, 12)}</td>
              <td className="p-3">{s.project || '—'}</td>
              <td className="p-3 font-mono text-xs truncate max-w-48">{s.worktree || '—'}</td>
              <td className="p-3">{s.current_task || '—'}</td>
              <td className="p-3 text-xs text-slate-400">{s.last_seen_at || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Update `dashboard/src/App.jsx`** — import Sessions, replace placeholder

```jsx
import { Sessions } from './components/Sessions.jsx';
// In routes:
<Route path="sessions" element={<Sessions />} />
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: builds without errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/Sessions.jsx dashboard/src/App.jsx
git commit -m "feat: add Sessions tab with active agent list"
```

### Task 9: Epic Tab

**Files:**
- Create: `dashboard/src/components/EpicProgress.jsx`
- Modify: `dashboard/src/App.jsx` — replace Epic placeholder

- [ ] **Step 1: Create `dashboard/src/components/EpicProgress.jsx`**

```jsx
import { useState } from 'react';
import { useApi } from '../hooks/useApi.js';
import { useSSE } from '../hooks/useSSE.js';

const STATUS_DOTS = {
  PENDING: 'bg-amber-500',
  STARTED: 'bg-blue-500',
  IN_PROGRESS: 'bg-blue-500',
  BLOCKED: 'bg-red-500',
  COMPLETE: 'bg-emerald-500',
};

export function EpicProgress() {
  const { data, loading, refetch } = useApi('/api/epics');
  useSSE(refetch);
  const [expanded, setExpanded] = useState({});

  if (loading) return <div className="text-slate-400 text-center py-8">Loading...</div>;

  const epics = data?.epics || [];

  if (epics.length === 0) {
    return <div className="text-slate-400 text-center py-16">No epics</div>;
  }

  const toggle = (name) => setExpanded(prev => ({ ...prev, [name]: !prev[name] }));

  return (
    <div className="space-y-3">
      {epics.map(epic => (
        <div key={epic.epic_name} className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
          <button
            onClick={() => toggle(epic.epic_name)}
            className="w-full p-4 text-left hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
          >
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="font-medium">{epic.epic_name}</span>
                <span className="text-xs text-slate-400 ml-2">{epic.project}</span>
              </div>
              <span className="text-sm font-bold text-violet-500">{epic.progress_pct}%</span>
            </div>
            {epic.description && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{epic.description}</p>
            )}
            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
              <div
                className="bg-violet-500 h-2 rounded-full transition-all"
                style={{ width: `${epic.progress_pct}%` }}
              />
            </div>
            <div className="text-xs text-slate-400 mt-1">{epic.completed} / {epic.total} tasks</div>
          </button>
          {expanded[epic.epic_name] && (
            <div className="border-t border-slate-200 dark:border-slate-700 px-4 py-2">
              {epic.tasks.map(t => (
                <div key={t.name} className="flex items-center gap-2 py-1.5">
                  <span className={`w-2 h-2 rounded-full ${STATUS_DOTS[t.status] || 'bg-slate-400'}`} />
                  <span className="text-sm">{t.name}</span>
                  <span className="text-xs text-slate-400 ml-auto">{t.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Update `dashboard/src/App.jsx`** — import EpicProgress, replace placeholder

```jsx
import { EpicProgress } from './components/EpicProgress.jsx';
// In routes:
<Route path="epic" element={<EpicProgress />} />
```

- [ ] **Step 3: Build and verify all tabs**

Run: `npm run build`
Expected: builds without errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/EpicProgress.jsx dashboard/src/App.jsx
git commit -m "feat: add Epic tab with progress bars and expandable task lists"
```

---

## Chunk 4: Integration, Build, Verification

### Task 10: Add dashboard/dist to .gitignore and Final Build

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Update `.gitignore`**

Add `dashboard/dist/` to `.gitignore`.

- [ ] **Step 2: Full build and manual verification**

Run:
```bash
npm run build
squad stop 2>/dev/null
squad start
```

Open `http://localhost:3456/` in browser and verify:
1. Header with "squad-mcp" title, tabs (Board, Graph, Sessions, Epic), theme toggle
2. Stats bar shows correct counts for current data
3. Board tab: kanban columns with tasks from PM-OS epic
4. Graph tab: SVG dependency graph with nodes and edges
5. Sessions tab: table with active sessions
6. Epic tab: progress bars with expandable task lists
7. Theme toggle: switches dark/light, persists on reload
8. SSE: register a task from another session, verify dashboard updates without refresh

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "feat: complete dashboard v1 — build, integration, verification"
```

- [ ] **Step 4: Push to GitHub**

```bash
git push origin main
```
