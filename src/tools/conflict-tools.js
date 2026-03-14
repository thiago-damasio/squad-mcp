import { z } from 'zod';

export function register(mcp, db) {
  mcp.tool(
    'check_conflicts',
    'Check if any active tasks are touching the same files. Returns CLEAR or CONFLICT with details.',
    {
      files: z.array(z.string()).describe('File paths to check for conflicts'),
      task_name: z.string().optional().describe('Exclude this task from conflict check (self)'),
    },
    async ({ files, task_name }) => {
      if (files.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'CLEAR', conflicts: [] }) }],
        };
      }

      const placeholders = files.map(() => '?').join(',');
      const activeStatuses = ['STARTED', 'IN_PROGRESS'];
      const statusPlaceholders = activeStatuses.map(() => '?').join(',');

      let query = `
        SELECT DISTINCT t.name as task_name, t.session_id, tf.filepath
        FROM task_files tf
        JOIN tasks t ON t.id = tf.task_id
        WHERE tf.filepath IN (${placeholders})
          AND t.status IN (${statusPlaceholders})
      `;
      const params = [...files, ...activeStatuses];

      if (task_name) {
        query += ' AND t.name != ?';
        params.push(task_name);
      }

      const rows = db.prepare(query).all(...params);

      if (rows.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'CLEAR', conflicts: [] }) }],
        };
      }

      // Group by task
      const byTask = {};
      for (const row of rows) {
        if (!byTask[row.task_name]) {
          byTask[row.task_name] = { task_name: row.task_name, session_id: row.session_id, files: [] };
        }
        byTask[row.task_name].files.push(row.filepath);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'CONFLICT', conflicts: Object.values(byTask) }),
        }],
      };
    }
  );
}
