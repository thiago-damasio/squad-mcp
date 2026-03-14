/**
 * squad-mcp addon server — ultra-slim MCP for multi-session coordination.
 *
 * Only needed when multiple independent Claude Code sessions coordinate.
 * For single-session use, the skill + state.json file is sufficient.
 *
 * 3 tools: squad_sync, squad_pull, squad_lock
 * REST equivalents: PUT /state, GET /state, POST /lock/:task
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = parseInt(process.env.SQUAD_PORT || '3456', 10);

// In-memory state (no SQLite needed)
let sharedState = {
  version: 1,
  project: 'unknown',
  updated_at: new Date().toISOString(),
  epics: {},
  tasks: {},
  sessions: {},
};

const locks = new Map(); // task_name -> session_id

// --- MCP Server ---

const mcp = new McpServer({
  name: 'squad-mcp-addon',
  version: '2.0.0',
});

mcp.tool(
  'squad_sync',
  'Publish local state to the shared server. Call after any state change.',
  { state: z.string().describe('JSON string of .squad/state.json content') },
  async ({ state }) => {
    try {
      const parsed = JSON.parse(state);
      sharedState = { ...parsed, updated_at: new Date().toISOString() };
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, updated_at: sharedState.updated_at }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

mcp.tool(
  'squad_pull',
  'Get the latest shared state from the server. Call on session startup.',
  {},
  async () => {
    return { content: [{ type: 'text', text: JSON.stringify(sharedState) }] };
  }
);

mcp.tool(
  'squad_lock',
  'Atomically claim a task. Returns success or conflict if already claimed by another session.',
  {
    task_name: z.string().describe('Task to claim'),
    session_id: z.string().describe('Your session identifier'),
  },
  async ({ task_name, session_id }) => {
    const existing = locks.get(task_name);
    if (existing && existing !== session_id) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Task "${task_name}" already locked by session "${existing}"`,
          }),
        }],
      };
    }

    locks.set(task_name, session_id);

    // Update shared state if task exists
    if (sharedState.tasks[task_name]) {
      sharedState.tasks[task_name].assigned_to = session_id;
      sharedState.tasks[task_name].status = 'STARTED';
      sharedState.tasks[task_name].started_at = new Date().toISOString();
      sharedState.updated_at = new Date().toISOString();
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: true, task_name, session_id }),
      }],
    };
  }
);

// --- Express + MCP Transport ---

const app = express();
app.use(express.json());

const transports = new Map();

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  let transport = sessionId ? transports.get(sessionId) : null;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    await mcp.connect(transport);
    transports.set(transport.sessionId, transport);
    res.setHeader('mcp-session-id', transport.sessionId);
  }

  await transport.handleRequest(req, res);
});

app.get('/mcp', (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = sessionId ? transports.get(sessionId) : null;
  if (transport) {
    transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: 'No session' });
  }
});

app.delete('/mcp', (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId) {
    const transport = transports.get(sessionId);
    if (transport) {
      transport.close();
      transports.delete(sessionId);
    }
  }
  res.status(200).json({ success: true });
});

// REST equivalents for non-MCP clients
app.get('/state', (req, res) => res.json(sharedState));
app.put('/state', (req, res) => {
  sharedState = { ...req.body, updated_at: new Date().toISOString() };
  res.json({ success: true });
});
app.post('/lock/:task', (req, res) => {
  const { task } = req.params;
  const { session_id } = req.body;
  const existing = locks.get(task);
  if (existing && existing !== session_id) {
    res.status(409).json({ success: false, error: `Locked by ${existing}` });
  } else {
    locks.set(task, session_id);
    res.json({ success: true });
  }
});

app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: '2.0.0',
  tasks: Object.keys(sharedState.tasks).length,
  sessions: transports.size,
  locks: locks.size,
}));

app.listen(PORT, () => {
  console.log(`squad-mcp addon server running on port ${PORT}`);
  console.log(`MCP: http://127.0.0.1:${PORT}/mcp`);
  console.log(`REST: http://127.0.0.1:${PORT}/state`);
  console.log(`Health: http://127.0.0.1:${PORT}/health`);
});
