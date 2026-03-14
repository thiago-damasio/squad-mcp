import { z } from 'zod';

export function register(mcp, db) {
  // --- create_epic ---
  mcp.tool(
    'create_epic',
    'Create an epic that groups multiple tasks. Creates project if it does not exist.',
    {
      project: z.string().describe('Project name'),
      epic_name: z.string().describe('Unique epic identifier'),
      description: z.string().describe('What this epic achieves'),
      tasks: z.array(z.object({
        name: z.string(),
        description: z.string(),
        files_scope: z.array(z.string()).default([]),
        depends_on: z.array(z.string()).default([]),
      })).describe('Tasks to create within this epic'),
    },
    async ({ project, epic_name, description, tasks }) => {
      const result = db.transaction(() => {
        // Upsert project
        db.prepare('INSERT OR IGNORE INTO projects (name) VALUES (?)').run(project);
        const proj = db.prepare('SELECT id FROM projects WHERE name = ?').get(project);

        // Create epic
        db.prepare('INSERT INTO epics (project_id, name, description) VALUES (?, ?, ?)').run(proj.id, epic_name, description);
        const epic = db.prepare('SELECT id FROM epics WHERE name = ?').get(epic_name);

        // Create tasks
        const insertTask = db.prepare(
          'INSERT INTO tasks (project_id, epic_id, name, description) VALUES (?, ?, ?, ?)'
        );
        const insertFile = db.prepare('INSERT INTO task_files (task_id, filepath) VALUES (?, ?)');

        let tasksCreated = 0;
        const taskIds = new Map();

        // First pass: create all tasks
        for (const t of tasks) {
          const info = insertTask.run(proj.id, epic.id, t.name, t.description);
          taskIds.set(t.name, Number(info.lastInsertRowid));
          for (const fp of t.files_scope) {
            insertFile.run(info.lastInsertRowid, fp);
          }
          tasksCreated++;
        }

        // Second pass: wire up dependencies
        const insertDep = db.prepare(
          'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)'
        );
        for (const t of tasks) {
          for (const dep of t.depends_on) {
            const depId = taskIds.get(dep) ||
              db.prepare('SELECT id FROM tasks WHERE name = ?').get(dep)?.id;
            if (depId) {
              insertDep.run(taskIds.get(t.name), depId);
            }
          }
        }

        return { success: true, epic_id: Number(epic.id), epic_name, tasks_created: tasksCreated };
      })();

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // --- get_epic_status ---
  mcp.tool(
    'get_epic_status',
    'Get progress of an epic — how many tasks are complete vs total.',
    {
      epic_name: z.string().describe('Epic name to check'),
    },
    async ({ epic_name }) => {
      const epic = db.prepare(
        `SELECT e.*, p.name as project_name FROM epics e
         JOIN projects p ON e.project_id = p.id
         WHERE e.name = ?`
      ).get(epic_name);

      if (!epic) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, reason: 'epic_not_found' }) }],
        };
      }

      const tasks = db.prepare(
        'SELECT name, status, session_id, summary FROM tasks WHERE epic_id = ? ORDER BY created_at'
      ).all(epic.id);

      const total = tasks.length;
      const completed = tasks.filter(t => t.status === 'COMPLETE').length;
      const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            epic_name,
            project: epic.project_name,
            description: epic.description,
            total,
            completed,
            progress_pct: progressPct,
            tasks,
          }),
        }],
      };
    }
  );
}
