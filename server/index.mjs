// Agent Floor server. Zero dependencies.
//
//   POST /events        one event or an array of events (see docs/protocol.md)
//   GET  /stream        Server-Sent Events: a `snapshot`, then `event` + `effects`
//   GET  /state         current world as JSON
//   POST /reset         clear the floor
//   POST /reload        re-read the rooms file and re-seed roster desks
//   GET  /*             the built web app (dist/)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEvent, createState, normalizeEvent, settlePinned, sweep, PROTOCOL_VERSION } from '../shared/protocol.js';
import { floorHome, loadRooms, roomsFile as defaultRoomsFile, seedEvents } from '../shared/rooms.js';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export function startServer({
  port = Number(process.env.AGENT_FLOOR_PORT) || 4317,
  host = process.env.AGENT_FLOOR_HOST || '127.0.0.1',
  staticDir = resolve(here, '../dist'),
  log = console.log,
  // The CLI and desktop app pass useHome: true, so tests never touch ~/.agent-floor.
  useHome = false,
  roomsFile = useHome ? defaultRoomsFile() : undefined,
  // Saving only happens with a rooms file (no file = behaves as before), one file per port.
  stateFile = useHome && process.env.AGENT_FLOOR_PERSIST !== '0' && roomsFile && existsSync(roomsFile)
    ? join(floorHome(), `state-${port}.json`)
    : undefined,
} = {}) {
  const state = createState();
  const clients = new Set();

  // Restore the roster desks (and their rooms) from the last run. Only pinned desks are
  // saved: lead sessions carry prompts and would come back as stale ghosts.
  const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  if (stateFile) {
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (isObj(saved) && isObj(saved.agents) && isObj(saved.teams)) {
        for (const a of Object.values(saved.agents)) {
          if (!isObj(a) || typeof a.id !== 'string' || typeof a.team !== 'string' || !a.pinned) continue;
          state.agents[a.id] = {
            ...a,
            history: Array.isArray(a.history) ? a.history.filter(isObj) : [],
            status: 'idle',
            activity: a.idleActivity || a.activity,
            tool: undefined,
            parent: undefined,
            boundKey: undefined,
            spawns: 0,
          };
        }
        const used = new Set(Object.values(state.agents).map((a) => a.team));
        for (const [id, t] of Object.entries(saved.teams)) if (used.has(id) && isObj(t)) state.teams[id] = t;
        for (const a of Object.values(state.agents)) if (!state.teams[a.team]) delete state.agents[a.id];
        state.seq = Number(saved.seq) || 0;
        state.updatedAt = Number(saved.updatedAt) || 0;
      }
    } catch {
      // No saved state yet, or it is unreadable: start empty (seeding fills the rooms).
    }
  }
  let savedSeq = -1;
  function save() {
    if (!stateFile || state.seq === savedSeq) return;
    try {
      const agents = Object.fromEntries(Object.values(state.agents).filter((a) => a.pinned).map((a) => [a.id, a]));
      const used = new Set(Object.values(agents).map((a) => a.team));
      const teams = Object.fromEntries(Object.entries(state.teams).filter(([id]) => used.has(id)));
      mkdirSync(dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ teams, agents, seq: state.seq, updatedAt: state.updatedAt }));
      renameSync(tmp, stateFile);
      savedSeq = state.seq;
    } catch (err) {
      log(`Agent Floor could not save state: ${err.message}`);
    }
  }

  function broadcast(name, data) {
    const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  // `external` events come from POST /events: they may not pin agents (only the rooms file can).
  function ingest(raw, { external = false } = {}) {
    if (external && raw && typeof raw === 'object' && 'pinned' in raw) {
      raw = { ...raw };
      delete raw.pinned;
    }
    const ev = normalizeEvent(raw);
    if (!ev) return false;
    const { effects } = applyEvent(state, ev);
    broadcast('event', { event: ev, effects });
    return true;
  }

  // Standing roster desks from the rooms file. Agents that were pinned before
  // but are no longer listed leave the floor normally.
  function seed() {
    if (!roomsFile) return 0;
    const cfg = loadRooms(roomsFile);
    if (!cfg) {
      // Half-saved or broken file: keep the desks we have until it is fixed.
      log('Agent Floor: rooms file is unreadable, keeping the current rooms.');
      return Object.values(state.agents).filter((a) => a.pinned).length;
    }
    const events = seedEvents(cfg);
    const keep = new Set(events.filter((e) => e.type === 'join').map((e) => e.agent));
    for (const a of Object.values(state.agents)) {
      if (a.pinned && !keep.has(a.id)) {
        ingest({ type: 'status', agent: a.id, pinned: false });
        ingest({ type: 'leave', agent: a.id });
      }
    }
    for (const ev of events) ingest(ev);
    return keep.size;
  }
  seed();

  const sweeper = setInterval(() => {
    for (const ev of settlePinned(state)) ingest(ev);
    const removed = sweep(state);
    if (removed.length) broadcast('removed', { agents: removed });
  }, 2000);
  const saver = stateFile ? setInterval(save, 10_000) : null;
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 20000);

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : null;
  }

  function cors(req, res) {
    // Local tool: allow any localhost origin plus the hosted demo to talk to it.
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function serveStatic(req, res) {
    const url = new URL(req.url, 'http://x');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(staticDir, path);
    if (!file.startsWith(staticDir)) return json(res, 403, { error: 'Forbidden' });
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(staticDir, 'index.html');
    }
    try {
      const body = await readFile(file);
      const cache = file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
      res.end(body);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Agent Floor server is running, but the web app is not built.\nRun `npm run build`, or use `npm run dev` while developing.\n');
    }
  }

  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  const server = createServer(async (req, res) => {
    // DNS-rebinding guard: when bound to loopback, only answer loopback hostnames.
    if (loopback && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) {
      return json(res, 403, { error: 'Forbidden host' });
    }
    cors(req, res);
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const { pathname } = new URL(req.url, 'http://x');
    // Requiring JSON forces a CORS preflight, so random web pages cannot post
    // "simple" form requests to your floor. curl and the hooks send this header.
    if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { error: 'Send Content-Type: application/json' });
    }

    try {
      if (pathname === '/events' && req.method === 'POST') {
        const body = await readBody(req);
        const list = Array.isArray(body) ? body : [body];
        let accepted = 0;
        for (const raw of list.slice(0, 200)) if (ingest(raw, { external: true })) accepted++;
        return json(res, accepted ? 202 : 400, { accepted, rejected: list.length - accepted });
      }
      if (pathname === '/stream' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`retry: 1500\nevent: snapshot\ndata: ${JSON.stringify({ version: PROTOCOL_VERSION, state })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (pathname === '/state' && req.method === 'GET') return json(res, 200, state);
      if (pathname === '/health') return json(res, 200, { ok: true, version: PROTOCOL_VERSION, agents: Object.keys(state.agents).length });
      if (pathname === '/reset' && req.method === 'POST') {
        ingest({ type: 'reset' });
        seed();
        return json(res, 200, { ok: true });
      }
      if (pathname === '/reload' && req.method === 'POST') {
        return json(res, 200, { ok: true, roster: seed() });
      }
      if (req.method === 'GET') return serveStatic(req, res);
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message || 'Bad request' });
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log(`Agent Floor is live at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
      resolvePromise({
        server,
        state,
        ingest,
        save,
        close() {
          clearInterval(sweeper);
          clearInterval(heartbeat);
          if (saver) clearInterval(saver);
          save();
          for (const res of clients) res.end();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? 'Port is already in use. Set AGENT_FLOOR_PORT to pick another.' : err);
    process.exit(1);
  });
}
