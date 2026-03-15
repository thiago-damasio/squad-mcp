#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, openSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = '.squad/state.json';
const SKILL_SOURCE = join(__dirname, '..', 'skill', 'squad.md');
const ADDON_SERVER = join(__dirname, '..', 'src', 'addon', 'server.js');
const SQUAD_HOME = join(homedir(), '.squad-mcp');
const PID_FILE = join(SQUAD_HOME, 'squad.pid');
const LOG_PATH = join(SQUAD_HOME, 'squad.log');
const DEFAULT_PORT = parseInt(process.env.SQUAD_PORT || '3456', 10);

function findStateFile() {
  let dir = process.cwd();
  while (dir !== dirname(dir)) {
    const candidate = join(dir, STATE_FILE);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

function loadState() {
  const path = findStateFile();
  if (!path) {
    console.error('No .squad/state.json found. Run "squad init" first.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

const STATUS_ICON = {
  PENDING: '[ ]',
  STARTED: '[>]',
  IN_PROGRESS: '[~]',
  BLOCKED: '[!]',
  COMPLETE: '[x]',
  CANCELLED: '[-]',
};

const program = new Command();

program
  .name('squad')
  .description('Squad — Multi-agent coordination for Claude Code')
  .version('2.0.0');

// --- init ---
program
  .command('init')
  .description('Initialize squad coordination in the current project')
  .option('--with-hooks', 'Also configure Claude Code post-agent hook')
  .option('--with-server', 'Also configure MCP addon server for multi-session coordination')
  .action((opts) => {
    const cwd = process.cwd();
    const squadDir = join(cwd, '.squad');
    const statePath = join(cwd, STATE_FILE);
    const gitignorePath = join(cwd, '.gitignore');
    const skillTarget = join(cwd, '.claude', 'commands', 'squad.md');

    // 1. Create .squad/state.json
    if (!existsSync(squadDir)) {
      mkdirSync(squadDir, { recursive: true });
    }

    if (existsSync(statePath)) {
      console.log('.squad/state.json already exists, skipping.');
    } else {
      const projectName = JSON.parse(
        existsSync(join(cwd, 'package.json'))
          ? readFileSync(join(cwd, 'package.json'), 'utf-8')
          : '{"name":"project"}'
      ).name || 'project';

      const initialState = {
        version: 1,
        project: projectName,
        updated_at: new Date().toISOString(),
        epics: {},
        tasks: {},
        sessions: {},
      };

      writeFileSync(statePath, JSON.stringify(initialState, null, 2) + '\n');
      console.log(`Created ${STATE_FILE}`);
    }

    // 2. Add .squad/ to .gitignore
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8');
      if (!content.includes('.squad/')) {
        writeFileSync(gitignorePath, content.trimEnd() + '\n.squad/\n');
        console.log('Added .squad/ to .gitignore');
      }
    } else {
      writeFileSync(gitignorePath, '.squad/\n');
      console.log('Created .gitignore with .squad/');
    }

    // 3. Copy skill to .claude/commands/
    const skillDir = dirname(skillTarget);
    if (!existsSync(skillDir)) {
      mkdirSync(skillDir, { recursive: true });
    }

    if (existsSync(SKILL_SOURCE)) {
      copyFileSync(SKILL_SOURCE, skillTarget);
      console.log(`Installed skill to .claude/commands/squad.md`);
    } else {
      console.log('Warning: skill source not found. Install squad-mcp globally or copy skill/squad.md manually.');
    }

    // 4. Optional: configure hook
    if (opts.withHooks) {
      const settingsPath = join(cwd, '.claude', 'settings.json');
      let settings = {};
      if (existsSync(settingsPath)) {
        try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {}
      }

      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

      const hasHook = settings.hooks.PostToolUse.some(
        h => h.hooks && h.hooks.some(hk => hk.command && hk.command.includes('squad-hook'))
      );

      if (!hasHook) {
        settings.hooks.PostToolUse.push({
          matcher: 'Agent',
          hooks: [{ type: 'command', command: 'squad-hook post-agent' }],
        });
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        console.log('Configured post-agent hook in .claude/settings.json');
      }
    }

    // 5. Optional: configure MCP addon server
    if (opts.withServer) {
      const mcpJsonPath = join(cwd, '.mcp.json');
      let mcpConfig = {};
      if (existsSync(mcpJsonPath)) {
        try { mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8')); } catch {}
      }

      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      mcpConfig.mcpServers['squad-mcp'] = {
        type: 'http',
        url: `http://127.0.0.1:${DEFAULT_PORT}/mcp`,
      };

      writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n');
      console.log(`Configured MCP addon in .mcp.json (port ${DEFAULT_PORT})`);
      console.log('Start the server with: squad serve');
    }

    console.log('\nReady! Use "/squad" in Claude Code to start coordinating.');
  });

// --- board ---
program
  .command('board')
  .description('Show kanban board')
  .argument('[epic]', 'Filter by epic name')
  .action((epicFilter) => {
    const state = loadState();
    const tasks = state.tasks;
    const entries = Object.entries(tasks);

    if (entries.length === 0) {
      console.log('No tasks found.');
      return;
    }

    // Group by epic if showing all
    const epics = new Set(entries.map(([, t]) => t.epic).filter(Boolean));

    // Show epic progress
    for (const epicName of epics) {
      if (epicFilter && epicName !== epicFilter) continue;
      const epicTasks = entries.filter(([, t]) => t.epic === epicName);
      const complete = epicTasks.filter(([, t]) => t.status === 'COMPLETE').length;
      console.log(`\n=== Epic: ${epicName} (${complete}/${epicTasks.length} complete) ===`);
    }

    // Group by status
    const columns = {};
    for (const [name, task] of entries) {
      if (epicFilter && task.epic !== epicFilter) continue;
      if (!columns[task.status]) columns[task.status] = [];
      columns[task.status].push({ name, ...task });
    }

    const order = ['PENDING', 'STARTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETE', 'CANCELLED'];
    for (const status of order) {
      const items = columns[status];
      if (!items || items.length === 0) continue;

      console.log(`\n${status} (${items.length})`);
      for (const t of items) {
        const icon = STATUS_ICON[status];
        const epic = t.epic ? ` (${t.epic})` : '';
        const assigned = t.assigned_to ? ` [${t.assigned_to}]` : '';

        // Show blocking deps for PENDING tasks
        let blocked = '';
        if (status === 'PENDING' && t.depends_on && t.depends_on.length > 0) {
          const unmet = t.depends_on.filter(d => tasks[d]?.status !== 'COMPLETE');
          if (unmet.length > 0) {
            blocked = `  <- blocked by: ${unmet.join(', ')}`;
          }
        }

        console.log(`  ${icon} ${t.name}${epic}${assigned}${blocked}`);
      }
    }
  });

// --- graph ---
program
  .command('graph')
  .description('Show dependency graph')
  .argument('[epic]', 'Filter by epic name')
  .action((epicFilter) => {
    const state = loadState();
    const entries = Object.entries(state.tasks);

    if (entries.length === 0) {
      console.log('No tasks found.');
      return;
    }

    for (const [name, task] of entries) {
      if (epicFilter && task.epic !== epicFilter) continue;
      const icon = STATUS_ICON[task.status] || '[?]';
      const deps = task.depends_on && task.depends_on.length > 0
        ? ` <-- ${task.depends_on.join(', ')}`
        : '';
      console.log(`${icon} ${name}${deps}`);
    }
  });

// --- status ---
program
  .command('status')
  .description('Show summary of all epics')
  .action(() => {
    const state = loadState();
    const entries = Object.entries(state.tasks);

    if (entries.length === 0) {
      console.log('No tasks.');
      return;
    }

    // Group by epic
    const byEpic = {};
    for (const [name, task] of entries) {
      const epic = task.epic || '(no epic)';
      if (!byEpic[epic]) byEpic[epic] = { total: 0, complete: 0, in_progress: 0, blocked: 0 };
      byEpic[epic].total++;
      if (task.status === 'COMPLETE') byEpic[epic].complete++;
      if (task.status === 'IN_PROGRESS' || task.status === 'STARTED') byEpic[epic].in_progress++;
      if (task.status === 'BLOCKED') byEpic[epic].blocked++;
    }

    for (const [epic, counts] of Object.entries(byEpic)) {
      const pct = Math.round((counts.complete / counts.total) * 100);
      const parts = [`${counts.complete}/${counts.total} complete (${pct}%)`];
      if (counts.in_progress > 0) parts.push(`${counts.in_progress} in progress`);
      if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
      console.log(`${epic}: ${parts.join(', ')}`);
    }
  });

// --- serve (MCP addon) ---
program
  .command('serve')
  .description('Start the MCP addon server for multi-session coordination')
  .option('-p, --port <port>', 'Server port', String(DEFAULT_PORT))
  .option('-d, --daemon', 'Run in background')
  .action((opts) => {
    if (opts.daemon) {
      if (existsSync(PID_FILE)) {
        const pid = readFileSync(PID_FILE, 'utf-8').trim();
        try {
          process.kill(parseInt(pid), 0);
          console.log(`squad-mcp addon already running (PID ${pid})`);
          return;
        } catch {
          // Stale PID
        }
      }

      mkdirSync(SQUAD_HOME, { recursive: true });
      const logFd = openSync(LOG_PATH, 'a');
      const child = spawn('node', [ADDON_SERVER], {
        env: { ...process.env, SQUAD_PORT: opts.port },
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });

      writeFileSync(PID_FILE, String(child.pid));
      child.unref();
      console.log(`squad-mcp addon started on port ${opts.port} (PID ${child.pid})`);
      console.log(`Logs: ${LOG_PATH}`);
    } else {
      // Foreground mode — just import and run
      process.env.SQUAD_PORT = opts.port;
      import(ADDON_SERVER);
    }
  });

// --- stop ---
program
  .command('stop')
  .description('Stop the MCP addon server')
  .action(() => {
    if (!existsSync(PID_FILE)) {
      console.log('squad-mcp addon is not running.');
      return;
    }

    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`squad-mcp addon stopped (PID ${pid})`);
    } catch {
      console.log('Process not found (stale PID).');
    }

    try { unlinkSync(PID_FILE); } catch {}
  });

program.parse();
