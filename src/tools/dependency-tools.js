import { z } from 'zod';

export function register(mcp, db) {
  mcp.tool(
    'check_dependencies',
    'Check if all dependencies of a task are COMPLETE. Returns READY or WAITING with blocking tasks.',
    {
      task_name: z.string().describe('Task to check dependencies for'),
    },
    async ({ task_name }) => {
      const task = db.prepare('SELECT id FROM tasks WHERE name = ?').get(task_name);
      if (!task) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, reason: 'task_not_found' }) }],
        };
      }

      const deps = db.prepare(
        `SELECT t.name as task_name, t.status
         FROM task_dependencies td
         JOIN tasks t ON td.depends_on_task_id = t.id
         WHERE td.task_id = ?`
      ).all(task.id);

      if (deps.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'READY', blocking: [] }) }],
        };
      }

      const blocking = deps.filter(d => d.status !== 'COMPLETE');

      if (blocking.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'READY', blocking: [] }) }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'WAITING', blocking }),
        }],
      };
    }
  );
}
