import { basename } from 'node:path';
import { loadRooms, roomForPath } from '../shared/rooms.js';

let roomsCache;
/** The rooms file, read once per hook process. */
export function rooms() {
  return (roomsCache ??= loadRooms());
}

/** Room for a working directory from the rooms file, or null. */
export function roomFor(cwd) {
  return roomForPath(rooms(), cwd);
}

export function shortId(value, n = 8) {
  return String(value || 'local').replace(/[^a-zA-Z0-9]/g, '').slice(0, n) || 'local';
}

export function slugKey(value) {
  return String(value || 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
}

export function teamFromCwd(cwd) {
  return process.env.AGENT_FLOOR_TEAM || roomFor(cwd)?.name || (cwd ? basename(cwd) : 'workspace');
}

export function pretty(value) {
  return String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function file(p) {
  return p ? basename(String(p)) : 'file';
}

function oneLine(s, max = 80) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Human-readable sentence for a tool call. Covers Claude Code, Codex and common MCP names. */
export function describeTool(name, input = {}) {
  const i = input || {};
  switch (name) {
    case 'Bash':
    case 'shell':
    case 'exec_command':
      return `Running ${oneLine(i.command ?? i.cmd, 60)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'apply_patch':
      return `Editing ${file(i.file_path ?? i.path)}`;
    case 'Write':
      return `Writing ${file(i.file_path ?? i.path)}`;
    case 'Read':
      return `Reading ${file(i.file_path ?? i.path)}`;
    case 'NotebookEdit':
      return `Editing ${file(i.notebook_path)}`;
    case 'Grep':
      return `Searching for "${oneLine(i.pattern, 40)}"`;
    case 'Glob':
      return `Finding ${oneLine(i.pattern, 40)}`;
    case 'WebFetch':
      try {
        return `Reading ${new URL(i.url).host}`;
      } catch {
        return 'Reading a web page';
      }
    case 'WebSearch':
      return `Searching the web for "${oneLine(i.query, 40)}"`;
    case 'TodoWrite':
      return 'Updating the plan';
    case 'Task':
    case 'Agent':
      return `Briefing ${pretty(i.subagent_type || 'a helper')}`;
    default:
      if (typeof name === 'string' && name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        return `${pretty(server)}: ${pretty(tool)}`;
      }
      return `Using ${name || 'a tool'}`;
  }
}

export function shortToolName(name) {
  if (typeof name === 'string' && name.startsWith('mcp__')) return 'MCP';
  return name;
}
