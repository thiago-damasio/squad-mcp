import { z } from 'zod';

export function register(mcp, db) {
  // --- get_board ---
  mcp.tool(
    'get_board',
    'Get kanban board view of all tasks grouped by status columns.',
    {
      project: z.string().optional().describe('Filter by project name'),
    },
    async ({ project }) => {
      let query = `
        SELECT t.name, t.description, t.status, t.session_id, t.worktree,
               p.name as project_name, e.name as epic_name
        FROM tasks t
        JOIN projects p ON t.project_id = p.id
        LEFT JOIN epics e ON t.epic_id = e.id
      `;
      const params = [];

      if (project) {
        query += ' WHERE p.name = ?';
        params.push(project);
      }

      query += ' ORDER BY t.created_at';

      const tasks = db.prepare(query).all(...params);

      const columns = {
        PENDING: [],
        STARTED: [],
        IN_PROGRESS: [],
        BLOCKED: [],
        COMPLETE: [],
        CANCELLED: [],
      };

      for (const t of tasks) {
        columns[t.status].push({
          task_name: t.name,
          description: t.description,
          project: t.project_name,
          epic: t.epic_name,
          session_id: t.session_id,
          worktree: t.worktree,
        });
      }

      return { content: [{ type: 'text', text: JSON.stringify({ columns }) }] };
    }
  );

  // --- get_dependency_graph ---
  mcp.tool(
    'get_dependency_graph',
    'Get ASCII dependency graph showing task relationships.',
    {
      project: z.string().optional().describe('Filter by project name'),
    },
    async ({ project }) => {
      let query = `
        SELECT t.name, t.status, dep.name as depends_on
        FROM tasks t
        LEFT JOIN task_dependencies td ON td.task_id = t.id
        LEFT JOIN tasks dep ON td.depends_on_task_id = dep.id
        JOIN projects p ON t.project_id = p.id
      `;
      const params = [];

      if (project) {
        query += ' WHERE p.name = ?';
        params.push(project);
      }

      query += ' ORDER BY t.name';

      const rows = db.prepare(query).all(...params);

      // Build adjacency list
      const tasks = new Map();
      for (const row of rows) {
        if (!tasks.has(row.name)) {
          tasks.set(row.name, { status: row.status, deps: [] });
        }
        if (row.depends_on) {
          tasks.get(row.name).deps.push(row.depends_on);
        }
      }

      // Build ASCII graph
      const lines = [];
      const statusIcon = {
        PENDING: '[ ]',
        STARTED: '[>]',
        IN_PROGRESS: '[~]',
        BLOCKED: '[!]',
        COMPLETE: '[x]',
        CANCELLED: '[-]',
      };

      for (const [name, info] of tasks) {
        const icon = statusIcon[info.status] || '[?]';
        if (info.deps.length === 0) {
          lines.push(`${icon} ${name}`);
        } else {
          const depStr = info.deps.join(', ');
          lines.push(`${icon} ${name} <-- ${depStr}`);
        }
      }

      if (lines.length === 0) {
        lines.push('(no tasks)');
      }

      return { content: [{ type: 'text', text: JSON.stringify({ graph: lines.join('\n') }) }] };
    }
  );

  // --- list_active_sessions ---
  mcp.tool(
    'list_active_sessions',
    'List all active worktree sessions and what each one is working on.',
    {},
    async () => {
      const sessions = db.prepare(`
        SELECT s.session_id, s.worktree, s.project, s.last_seen_at,
               t.name as current_task, t.status as task_status
        FROM sessions s
        LEFT JOIN tasks t ON t.session_id = s.session_id
          AND t.status IN ('STARTED', 'IN_PROGRESS')
        ORDER BY s.last_seen_at DESC
      `).all();

      return { content: [{ type: 'text', text: JSON.stringify({ sessions }) }] };
    }
  );
}
