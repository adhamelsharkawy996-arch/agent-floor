// Optional rooms file: fixed rooms, standing rosters and "mail" paths.
// Node only (used by the server and the hook adapters, never by the browser).
//
// ~/.agent-floor/rooms.json (or AGENT_FLOOR_ROOMS):
// {
//   "rooms": [{ "slug": "ceo", "name": "CEO Office", "leadName": "CEO", "model": "opus", "task": "...",
//               "paths": ["D:\\Projects\\alpha-offices\\ceo"],
//               "roster": [{ "type": "report-intake", "name": "Intake", "job": "Collect reports", "model": "haiku" }] }],
//   "mail": { "inbox": "D:\\...\\ceo\\inbox", "inboxTo": "ceo:report-intake",
//             "decisions": "D:\\...\\ceo\\decisions", "decisionsTo": "{slug}:reporter" }
// }
// A missing file means "no rooms": Agent Floor behaves exactly as before.
// A broken file (half-saved, bad JSON) makes loadRooms return null, so callers keep what they have.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { slug } from './protocol.js';

export const EMPTY = Object.freeze({ rooms: [], mail: {} });

export function floorHome() {
  return process.env.AGENT_FLOOR_HOME || join(homedir(), '.agent-floor');
}

export function roomsFile() {
  return process.env.AGENT_FLOOR_ROOMS || join(floorHome(), 'rooms.json');
}

const str = (v, max = 120) => (v == null ? undefined : String(v).slice(0, max));

export function normalizeRooms(json) {
  const rooms = (Array.isArray(json?.rooms) ? json.rooms : [])
    .filter((r) => r && r.slug && r.name)
    .map((r) => ({
      slug: slug(r.slug),
      name: str(r.name, 48),
      leadName: str(r.leadName, 40),
      model: str(r.model, 40),
      task: str(r.task),
      paths: (Array.isArray(r.paths) ? r.paths : []).map(String),
      roster: (Array.isArray(r.roster) ? r.roster : [])
        .filter((e) => e && e.type)
        .map((e) => ({ type: str(e.type, 40), name: str(e.name, 40), job: str(e.job, 80), model: str(e.model, 20) })),
    }));
  const m = json?.mail || {};
  const mail = {
    inbox: str(m.inbox, 512),
    inboxTo: str(m.inboxTo, 80) || 'ceo:report-intake',
    decisions: str(m.decisions, 512),
    decisionsTo: str(m.decisionsTo, 80) || '{slug}:reporter',
  };
  return { rooms, mail };
}

/** EMPTY when the file does not exist, null when it exists but cannot be read or parsed. */
export function loadRooms(file = roomsFile()) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? EMPTY : null;
  }
  try {
    return normalizeRooms(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Windows and POSIX paths compare the same way: forward slashes, no trailing slash, lower case. */
function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function under(path, base) {
  return Boolean(base) && (path === base || path.startsWith(base + '/'));
}

/** The room whose path is the longest prefix of `cwd`, or null. */
export function roomForPath(cfg, cwd) {
  const p = normPath(cwd);
  if (!p) return null;
  let best = null;
  let len = -1;
  for (const room of cfg.rooms) {
    for (const prefix of room.paths) {
      const q = normPath(prefix);
      if (under(p, q) && q.length > len) {
        best = room;
        len = q.length;
      }
    }
  }
  return best;
}

export function rosterEntry(room, type) {
  return (room && type && room.roster.find((e) => e.type === type)) || null;
}

export function rosterId(roomSlug, type) {
  return `roster:${roomSlug}:${type}`;
}

/** "job · model" line shown at an idle roster desk. */
export function idleLine(entry) {
  return [entry.job, entry.model].filter(Boolean).join(' · ') || 'Ready';
}

/**
 * A file written under the mail inbox or decisions folder becomes a paper plane.
 * Returns { to, text } for `<base>/<slug>/<file>`, or null.
 */
export function mailTarget(cfg, filePath) {
  const p = normPath(filePath);
  if (!p) return null;
  const route = (base, pattern) => {
    const b = normPath(base);
    if (!b || !p.startsWith(b + '/')) return null;
    const parts = p.slice(b.length + 1).split('/');
    if (parts.length < 2) return null;
    const room = cfg.rooms.find((r) => r.slug === parts[0]);
    if (!room) return null;
    const [roomSlug, type] = pattern.replace('{slug}', room.slug).split(':');
    const target = cfg.rooms.find((r) => r.slug === roomSlug);
    if (!rosterEntry(target, type)) return null;
    return { to: rosterId(roomSlug, type), text: basename(String(filePath).replace(/\\/g, '/')) };
  };
  return route(cfg.mail.inbox, cfg.mail.inboxTo) || route(cfg.mail.decisions, cfg.mail.decisionsTo);
}

/** Events that put every roster desk on the floor (idempotent). */
export function seedEvents(cfg) {
  const events = [];
  for (const room of cfg.rooms) {
    for (const e of room.roster) {
      events.push({
        type: 'join',
        agent: rosterId(room.slug, e.type),
        team: room.name,
        name: e.name || e.type,
        role: e.type,
        source: 'roster',
        status: 'idle',
        activity: idleLine(e),
        pinned: true,
      });
    }
    if (room.task && room.roster.length) {
      events.push({ type: 'task', agent: rosterId(room.slug, room.roster[0].type), task: room.task });
    }
  }
  return events;
}
