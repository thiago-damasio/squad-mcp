#!/usr/bin/env node

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, openSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { initDb, SQUAD_DIR, LOG_PATH } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'src', 'server.js');
const PID_FILE = join(SQUAD_DIR, 'squad.pid');
const DEFAULT_PORT = parseInt(process.env.SQUAD_PORT || '3456', 10);

const program = new Command();

program
  .name('squad')
  .description('Squad MCP — Multi-agent coordination server')
  .version('1.0.0');

// --- start ---
program
  .command('start')
  .description('Start the squad-mcp server in background')
  .option('-p, --port <port>', 'Server port', String(DEFAULT_PORT))
  .action((opts) => {
    if (existsSync(PID_FILE)) {
      const pid = readFileSync(PID_FILE, 'utf-8').trim();
      try {
        process.kill(parseInt(pid), 0);
        console.log(`squad-mcp already running (PID ${pid})`);
        return;
      } catch {
        // Stale PID file
      }
    }

    const logFd = openSync(LOG_PATH, 'a');
    const child = spawn('node', [SERVER_PATH], {
      env: { ...process.env, SQUAD_PORT: opts.port },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });

    writeFileSync(PID_FILE, String(child.pid));
    child.unref();
    console.log(`squad-mcp started on port ${opts.port} (PID ${child.pid})`);
    console.log(`Logs: ${LOG_PATH}`);
  });

// --- stop ---
program
  .command('stop')
  .description('Stop the squad-mcp server')
  .action(() => {
    if (!existsSync(PID_FILE)) {
      console.log('squad-mcp is not running');
      return;
    }

    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`squad-mcp stopped (PID ${pid})`);
    } catch {
      console.log('squad-mcp process not found (stale PID)');
    }

    try { unlinkSync(PID_FILE); } catch {}
  });

// --- status ---
program
  .command('status')
  .description('Show server status and summary')
  .action(() => {
    const db = initDb();
    const projects = db.prepare('SELECT name FROM projects').all();
    const tasks = db.prepare('SELECT status, COUNT(*) as count FROM tasks GROUP BY status').all();
    const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get();

    let running = false;
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
      try { process.kill(pid, 0); running = true; } catch {}
    }

    console.log(`Server: ${running ? 'RUNNING' : 'STOPPED'}`);
    console.log(`Projects: ${projects.map(p => p.name).join(', ') || '(none)'}`);
    console.log(`Sessions: ${sessions.count}`);
    console.log('\nTasks:');
    if (tasks.length === 0) {
      console.log('  (none)');
    } else {
      for (const t of tasks) {
        console.log(`  ${t.status}: ${t.count}`);
      }
    }

    db.close();
  });

// --- board ---
program
  .command('board')
  .description('Show kanban board in the terminal')
  .argument('[project]', 'Filter by project name')
  .action((project) => {
    const db = initDb();

    let query = `
      SELECT t.name, t.status, t.session_id, p.name as project_name, e.name as epic_name
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

    const columns = { PENDING: [], STARTED: [], IN_PROGRESS: [], BLOCKED: [], COMPLETE: [], CANCELLED: [] };
    for (const t of tasks) {
      columns[t.status].push(t);
    }

    for (const [status, items] of Object.entries(columns)) {
      if (items.length === 0) continue;
      console.log(`\n=== ${status} (${items.length}) ===`);
      for (const t of items) {
        const owner = t.session_id ? ` [${t.session_id.slice(0, 8)}]` : '';
        const epic = t.epic_name ? ` (${t.epic_name})` : '';
        console.log(`  ${t.name}${epic}${owner}`);
      }
    }

    if (tasks.length === 0) {
      console.log('No tasks found.');
    }

    db.close();
  });

// --- ps ---
program
  .command('ps')
  .description('List active sessions/worktrees')
  .action(() => {
    const db = initDb();

    const sessions = db.prepare(`
      SELECT s.session_id, s.worktree, s.project, s.last_seen_at,
             t.name as current_task
      FROM sessions s
      LEFT JOIN tasks t ON t.session_id = s.session_id
        AND t.status IN ('STARTED', 'IN_PROGRESS')
      ORDER BY s.last_seen_at DESC
    `).all();

    if (sessions.length === 0) {
      console.log('No active sessions.');
    } else {
      for (const s of sessions) {
        const task = s.current_task ? ` -> ${s.current_task}` : '';
        console.log(`  ${s.session_id.slice(0, 8)} | ${s.project || '?'} | ${s.worktree || '?'}${task}`);
      }
    }

    db.close();
  });

// --- graph ---
program
  .command('graph')
  .description('Print ASCII dependency graph')
  .argument('[project]', 'Filter by project name')
  .action((project) => {
    const db = initDb();

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

    const tasks = new Map();
    for (const row of rows) {
      if (!tasks.has(row.name)) {
        tasks.set(row.name, { status: row.status, deps: [] });
      }
      if (row.depends_on) {
        tasks.get(row.name).deps.push(row.depends_on);
      }
    }

    const statusIcon = {
      PENDING: '[ ]', STARTED: '[>]', IN_PROGRESS: '[~]',
      BLOCKED: '[!]', COMPLETE: '[x]', CANCELLED: '[-]',
    };

    if (tasks.size === 0) {
      console.log('No tasks found.');
    } else {
      for (const [name, info] of tasks) {
        const icon = statusIcon[info.status] || '[?]';
        const depStr = info.deps.length > 0 ? ` <-- ${info.deps.join(', ')}` : '';
        console.log(`${icon} ${name}${depStr}`);
      }
    }

    db.close();
  });

// --- init ---
program
  .command('init')
  .description('Initialize squad-mcp in the current project')
  .option('-p, --port <port>', 'Server port', String(DEFAULT_PORT))
  .action((opts) => {
    const cwd = process.cwd();
    const mcpJsonPath = join(cwd, '.mcp.json');
    const claudeMdPath = join(cwd, 'CLAUDE.md');

    // 1. Create/update .mcp.json
    let mcpConfig = {};
    if (existsSync(mcpJsonPath)) {
      try {
        mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      } catch {}
    }

    if (!mcpConfig.mcpServers) {
      mcpConfig.mcpServers = {};
    }

    mcpConfig.mcpServers['squad-mcp'] = {
      type: 'http',
      url: `http://127.0.0.1:${opts.port}/mcp`,
    };

    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n');
    console.log(`Created/updated ${mcpJsonPath}`);

    // 2. Add Squad Orchestration Protocol to CLAUDE.md
    const squadBlock = `
## Squad Orchestration Protocol

This project uses squad-mcp for multi-agent coordination. All sessions MUST follow this protocol.

### Before any implementation:
1. Call \`check_conflicts\` with the files you intend to touch
2. Call \`check_dependencies\` to verify no blockers
3. If CONFLICT or WAITING -> report to user, do NOT proceed without explicit instruction
4. If CLEAR -> call \`register_task\` + \`claim_task\`, then implement
5. On completion -> call \`update_task_status\` with COMPLETE and a summary

### Session startup:
1. Call \`list_active_sessions\` to orient yourself
2. If tech-lead: call \`get_board\` and \`get_dependency_graph\`
3. If dev: call \`get_board\` to see available PENDING tasks

### Roles:
- **tech-lead**: plans epics, creates tasks, monitors board, resolves conflicts
- **dev**: implements tasks, respects file scope, reports status
- **reviewer**: read-only, validates implementations
- **qa**: runs tests, marks tasks BLOCKED if tests fail
`;

    if (existsSync(claudeMdPath)) {
      const content = readFileSync(claudeMdPath, 'utf-8');
      if (content.includes('Squad Orchestration Protocol')) {
        console.log('CLAUDE.md already has Squad Orchestration Protocol block');
      } else {
        appendFileSync(claudeMdPath, '\n' + squadBlock);
        console.log(`Appended Squad Orchestration Protocol to ${claudeMdPath}`);
      }
    } else {
      writeFileSync(claudeMdPath, `# Project\n${squadBlock}`);
      console.log(`Created ${claudeMdPath} with Squad Orchestration Protocol`);
    }

    console.log('\nDone! Make sure the squad-mcp server is running: squad start');
  });

program.parse();
