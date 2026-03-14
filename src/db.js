import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SQUAD_DIR = join(homedir(), '.squad-mcp');
export const DB_PATH = join(SQUAD_DIR, 'squad.db');
export const LOG_PATH = join(SQUAD_DIR, 'squad.log');

export function initDb() {
  mkdirSync(SQUAD_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  return db;
}
