import express from 'express';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { initDb } from './db.js';
import { register as registerTaskTools } from './tools/task-tools.js';
import { register as registerConflictTools } from './tools/conflict-tools.js';
import { register as registerDependencyTools } from './tools/dependency-tools.js';
import { register as registerBoardTools } from './tools/board-tools.js';
import { register as registerEpicTools } from './tools/epic-tools.js';

const PORT = parseInt(process.env.SQUAD_PORT || '3456', 10);

function createMcpServer(db) {
  const mcp = new McpServer({
    name: 'squad-mcp',
    version: '1.0.0',
  });

  registerTaskTools(mcp, db);
  registerConflictTools(mcp, db);
  registerDependencyTools(mcp, db);
  registerBoardTools(mcp, db);
  registerEpicTools(mcp, db);

  return mcp;
}

export function startServer(opts = {}) {
  const port = opts.port || PORT;
  const db = initDb();
  const app = express();
  app.use(express.json());

  // Session transport map
  const transports = new Map();

  // Health check
  app.get('/health', (_req, res) => {
    const projects = db.prepare('SELECT name FROM projects').all().map(r => r.name);
    const activeTasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status IN ('STARTED','IN_PROGRESS')").get();
    res.json({
      status: 'ok',
      version: '1.0.0',
      projects,
      active_tasks: activeTasks.count,
    });
  });

  // MCP POST — client requests (JSON-RPC)
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    let transport = sessionId ? transports.get(sessionId) : null;

    if (transport) {
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session
    const mcp = createMcpServer(db);
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) transports.delete(sid);
    };

    await mcp.connect(transport);

    // Store transport after connection (sessionId is set after handleRequest for initialize)
    await transport.handleRequest(req, res, req.body);

    if (transport.sessionId) {
      transports.set(transport.sessionId, transport);
    }
  });

  // MCP GET — SSE stream for server-initiated notifications
  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const transport = sessionId ? transports.get(sessionId) : null;
    if (!transport) {
      res.status(400).json({ error: 'No active session. Send an initialize request first.' });
      return;
    }
    await transport.handleRequest(req, res);
  });

  // MCP DELETE — client closing session
  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const transport = sessionId ? transports.get(sessionId) : null;
    if (transport) {
      await transport.close();
      transports.delete(sessionId);
    }
    res.status(200).end();
  });

  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`squad-mcp server running on http://127.0.0.1:${port}`);
    console.log(`MCP endpoint: http://127.0.0.1:${port}/mcp`);
    console.log(`Health check: http://127.0.0.1:${port}/health`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down squad-mcp...');
    for (const transport of transports.values()) {
      transport.close().catch(() => {});
    }
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

// Direct execution
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  startServer();
}
