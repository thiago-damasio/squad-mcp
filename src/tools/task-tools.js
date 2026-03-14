import { z } from 'zod';

export function register(mcp, db) {
  // --- register_task ---
  mcp.tool(
    'register_task',
    'Register a new task with file scope and dependencies. Creates project/epic if they do not exist.',
    {
      project: z.string().describe('Project name'),
      epic: z.string().optional().describe('Epic name (created if not exists)'),
      task_name: z.string().describe('Unique task identifier'),
      description: z.string().describe('What this task does'),
      files_scope: z.array(z.string()).default([]).describe('Files this task will touch'),
      depends_on: z.array(z.string()).default([]).describe('Task names this depends on'),
    },
    async ({ project, epic, task_name, description, files_scope, depends_on }) => {
      const result = db.transaction(() => {
        // Upsert project
        db.prepare('INSERT OR IGNORE INTO projects (name) VALUES (?)').run(project);
        const proj = db.prepare('SELECT id FROM projects WHERE name = ?').get(project);

        // Upsert epic if provided
        let epicId = null;
        if (epic) {
          db.prepare('INSERT OR IGNORE INTO epics (project_id, name) VALUES (?, ?)').run(proj.id, epic);
          const ep = db.prepare('SELECT id FROM epics WHERE name = ?').get(epic);
          epicId = ep.id;
        }

        // Insert task
        const info = db.prepare(
          'INSERT INTO tasks (project_id, epic_id, name, description) VALUES (?, ?, ?, ?)'
        ).run(proj.id, epicId, task_name, description);

        const taskId = info.lastInsertRowid;

        // Insert file scopes
        const insertFile = db.prepare('INSERT INTO task_files (task_id, filepath) VALUES (?, ?)');
        for (const fp of files_scope) {
          insertFile.run(taskId, fp);
        }

        // Insert dependencies
        if (depends_on.length > 0) {
          const insertDep = db.prepare(
            'INSERT INTO task_dependencies (task_id, depends_on_task_id) SELECT ?, id FROM tasks WHERE name = ?'
          );
          for (const dep of depends_on) {
            insertDep.run(taskId, dep);
          }
        }

        return { success: true, task_id: Number(taskId), task_name, status: 'PENDING' };
      })();

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // --- claim_task ---
  mcp.tool(
    'claim_task',
    'Claim a PENDING task for this session. Optimistic lock — fails if already claimed.',
    {
      task_name: z.string().describe('Task to claim'),
      session_id: z.string().describe('Unique session identifier'),
      worktree: z.string().describe('Git worktree path'),
    },
    async ({ task_name, session_id, worktree }) => {
      const result = db.transaction(() => {
        const task = db.prepare('SELECT * FROM tasks WHERE name = ?').get(task_name);
        if (!task) {
          return { success: false, reason: 'task_not_found' };
        }
        if (task.status !== 'PENDING') {
          return {
            success: false,
            reason: 'already_claimed',
            current_status: task.status,
            current_owner: task.session_id,
          };
        }

        db.prepare(
          `UPDATE tasks SET status = 'STARTED', session_id = ?, worktree = ?,
           started_at = datetime('now'), updated_at = datetime('now') WHERE name = ?`
        ).run(session_id, worktree, task_name);

        // Upsert session
        const proj = db.prepare('SELECT p.name FROM projects p JOIN tasks t ON t.project_id = p.id WHERE t.name = ?').get(task_name);
        db.prepare(
          `INSERT INTO sessions (session_id, worktree, project, last_seen_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(session_id) DO UPDATE SET worktree = ?, project = ?, last_seen_at = datetime('now')`
        ).run(session_id, worktree, proj?.name, worktree, proj?.name);

        return { success: true, task_name, status: 'STARTED', session_id };
      })();

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // --- update_task_status ---
  mcp.tool(
    'update_task_status',
    'Update the status of a task. Use COMPLETE when done, BLOCKED if stuck, IN_PROGRESS during work.',
    {
      task_name: z.string().describe('Task to update'),
      status: z.enum(['PENDING', 'STARTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETE', 'CANCELLED']).describe('New status'),
      summary: z.string().optional().describe('Summary of what was done or why blocked'),
    },
    async ({ task_name, status, summary }) => {
      const task = db.prepare('SELECT * FROM tasks WHERE name = ?').get(task_name);
      if (!task) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, reason: 'task_not_found' }) }] };
      }

      const completedAt = (status === 'COMPLETE' || status === 'CANCELLED') ? "datetime('now')" : null;

      if (completedAt) {
        db.prepare(
          `UPDATE tasks SET status = ?, summary = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE name = ?`
        ).run(status, summary || null, task_name);
      } else {
        db.prepare(
          `UPDATE tasks SET status = ?, summary = ?, updated_at = datetime('now') WHERE name = ?`
        ).run(status, summary || null, task_name);
      }

      const updated = db.prepare('SELECT updated_at FROM tasks WHERE name = ?').get(task_name);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, task_name, status, updated_at: updated.updated_at }) }],
      };
    }
  );

  // --- get_task ---
  mcp.tool(
    'get_task',
    'Get full details of a task including files, dependencies, and session info.',
    {
      task_name: z.string().describe('Task name to look up'),
    },
    async ({ task_name }) => {
      const task = db.prepare(
        `SELECT t.*, p.name as project_name, e.name as epic_name
         FROM tasks t
         JOIN projects p ON t.project_id = p.id
         LEFT JOIN epics e ON t.epic_id = e.id
         WHERE t.name = ?`
      ).get(task_name);

      if (!task) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, reason: 'task_not_found' }) }] };
      }

      const files = db.prepare('SELECT filepath FROM task_files WHERE task_id = ?').all(task.id).map(r => r.filepath);

      const dependencies = db.prepare(
        `SELECT t.name, t.status FROM task_dependencies td
         JOIN tasks t ON td.depends_on_task_id = t.id
         WHERE td.task_id = ?`
      ).all(task.id);

      const result = {
        task_name: task.name,
        project: task.project_name,
        epic: task.epic_name,
        description: task.description,
        status: task.status,
        session_id: task.session_id,
        worktree: task.worktree,
        files,
        dependencies,
        started_at: task.started_at,
        completed_at: task.completed_at,
        summary: task.summary,
        created_at: task.created_at,
        updated_at: task.updated_at,
      };

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );
}
