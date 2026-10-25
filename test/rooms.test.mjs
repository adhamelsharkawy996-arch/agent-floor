import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The adapters read the rooms file once per process, so point them at a test file first.
const dir = mkdtempSync(join(tmpdir(), 'agent-floor-rooms-'));
const roomsPath = join(dir, 'rooms.json');
const ROOMS = {
  rooms: [
    {
      slug: 'ceo',
      name: 'CEO Office',
      leadName: 'CEO',
      task: 'Judge reports',
      paths: ['D:\\Projects\\alpha-offices\\ceo'],
      roster: [
        { type: 'report-intake', name: 'Intake', job: 'Collect reports', model: 'haiku' },
        { type: 'jev-judge', name: 'JEV Judge', job: 'Adopt / revise / drop', model: 'sonnet' },
      ],
    },
    {
      slug: 'conquer',
      name: 'Conquer',
      leadName: 'Conquer Lead',
      paths: ['C:\\DarkConquer-6192'],
      roster: [
        { type: 'live-ops-auditor', name: 'Live Ops', job: 'Health checks', model: 'haiku' },
        { type: 'reporter', name: 'Reporter', job: 'Reports to CEO', model: 'haiku' },
      ],
    },
    { slug: 'nested', name: 'Nested', paths: ['C:\\DarkConquer-6192\\inner'], roster: [] },
    { name: 'no slug, ignored' },
  ],
  mail: { inbox: 'D:\\Projects\\alpha-offices\\ceo\\inbox', decisions: 'D:\\Projects\\alpha-offices\\ceo\\decisions' },
};
writeFileSync(roomsPath, JSON.stringify(ROOMS));
process.env.AGENT_FLOOR_ROOMS = roomsPath;
delete process.env.AGENT_FLOOR_TEAM;
delete process.env.AGENT_FLOOR_NAME;

const { loadRooms, roomForPath, mailTarget, seedEvents } = await import('../shared/rooms.js');
const { applyEvent, createState, normalizeEvent, settlePinned, sweep } = await import('../shared/protocol.js');
const { fromClaude } = await import('../adapters/claude.mjs');
const { startServer } = await import('../server/index.mjs');

const run = (state, raw) => applyEvent(state, normalizeEvent(raw));
const cfg = loadRooms(roomsPath);

test('rooms file: junk entries dropped, missing file = no rooms, broken file = null', () => {
  assert.equal(cfg.rooms.length, 3);
  assert.deepEqual(loadRooms(join(dir, 'missing.json')).rooms, []);
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{nope');
  assert.equal(loadRooms(broken), null);
});

test('roomForPath: Windows paths, any case, longest prefix wins', () => {
  assert.equal(roomForPath(cfg, 'c:/darkconquer-6192')?.slug, 'conquer');
  assert.equal(roomForPath(cfg, 'C:\\DarkConquer-6192\\DarkConquer-6192')?.slug, 'conquer');
  assert.equal(roomForPath(cfg, 'C:\\DarkConquer-6192\\inner\\x')?.slug, 'nested');
  assert.equal(roomForPath(cfg, 'C:\\DarkConquer-61920'), null, 'a longer sibling name is not inside the room');
  assert.equal(roomForPath(cfg, 'D:\\Elsewhere'), null);
});

test('seeded roster survives three hours of sweeping and keeps its room', () => {
  const s = createState();
  for (const ev of seedEvents(cfg)) run(s, { ...ev, ts: 1000 });
  assert.ok(s.agents['roster:ceo:report-intake'].pinned);
  assert.equal(s.agents['roster:ceo:report-intake'].activity, 'Collect reports · haiku');
  assert.equal(s.teams['ceo-office'].task, 'Judge reports');
  const removed = sweep(s, 1000 + 3 * 60 * 60_000);
  assert.deepEqual(removed, []);
  assert.ok(s.teams['ceo-office'] && s.teams.conquer);
});

test('a roster spawn lights up its own desk and goes back to idle', () => {
  const s = createState();
  for (const ev of seedEvents(cfg)) run(s, ev);
  const base = { session_id: 'sess5678', cwd: 'C:\\DarkConquer-6192' };
  for (const ev of fromClaude({ ...base, hook_event_name: 'SessionStart' })) run(s, ev);
  const lead = Object.values(s.agents).find((a) => a.role === 'Lead');
  assert.equal(lead.name, 'Conquer Lead');
  assert.equal(lead.team, 'conquer');
  const count = Object.keys(s.agents).length;
  const spawn = { ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu_1', tool_input: { subagent_type: 'live-ops-auditor', description: 'Check containers' } };

  for (const round of [1, 2]) {
    for (const ev of fromClaude(spawn)) run(s, ev);
    const desk = s.agents['roster:conquer:live-ops-auditor'];
    assert.equal(desk.status, 'thinking');
    assert.equal(desk.parent, lead.id);
    for (const ev of fromClaude({ ...base, hook_event_name: 'PreToolUse', agent_id: `ag_${round}`, agent_type: 'live-ops-auditor', tool_name: 'Bash', tool_input: { command: 'docker ps' } }))
      run(s, ev);
    assert.equal(desk.status, 'working');
    assert.equal(desk.activity, 'Running docker ps');
    assert.equal(Object.keys(s.agents).length, count, `round ${round}: no extra character`);
    for (const ev of fromClaude({ ...spawn, hook_event_name: 'PostToolUse' })) run(s, ev);
    assert.equal(desk.status, 'idle');
    assert.equal(desk.activity, 'Health checks · haiku');
    assert.equal(desk.parent, undefined);
    assert.equal(desk.boundKey, undefined);
  }
});

test('a non-roster spawn still gets a temporary desk', () => {
  const s = createState();
  const evs = fromClaude({ session_id: 's1', cwd: 'C:\\DarkConquer-6192', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu_9', tool_input: { subagent_type: 'Explore' } });
  assert.ok(!evs[1].agent.startsWith('roster:'));
});

test('writing a report or a decision sends a paper plane to the right desk', () => {
  assert.deepEqual(mailTarget(cfg, 'D:\\Projects\\alpha-offices\\ceo\\inbox\\conquer\\2026-10-27-x.md'), {
    to: 'roster:ceo:report-intake',
    text: '2026-10-27-x.md',
  });
  assert.equal(mailTarget(cfg, 'D:\\Projects\\alpha-offices\\ceo\\decisions\\conquer\\x.md')?.to, 'roster:conquer:reporter');
  assert.equal(mailTarget(cfg, 'D:\\Projects\\alpha-offices\\ceo\\decisions\\nested\\x.md'), null, 'no reporter desk, no plane');
  assert.equal(mailTarget(cfg, 'D:\\Projects\\alpha-offices\\ceo\\inbox\\unknown\\x.md'), null);

  const s = createState();
  for (const ev of seedEvents(cfg)) run(s, ev);
  const evs = fromClaude({ session_id: 's2', cwd: 'C:\\DarkConquer-6192', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'D:\\Projects\\alpha-offices\\ceo\\inbox\\conquer\\r.md' } });
  let effects = [];
  for (const ev of evs) effects = effects.concat(run(s, ev).effects);
  assert.ok(effects.some((e) => e.kind === 'message' && e.to === 'roster:ceo:report-intake' && e.text === 'r.md'));
});

test('a finished roster desk settles back to idle', () => {
  const s = createState();
  for (const ev of seedEvents(cfg)) run(s, { ...ev, ts: 1000 });
  run(s, { type: 'status', agent: 'roster:ceo:jev-judge', status: 'done', ts: 2000 });
  assert.deepEqual(settlePinned(s, 2000 + 10_000), [], 'not yet');
  const evs = settlePinned(s, 2000 + 60_000);
  assert.equal(evs.length, 1);
  for (const ev of evs) run(s, ev);
  assert.equal(s.agents['roster:ceo:jev-judge'].status, 'idle');
  assert.equal(s.agents['roster:ceo:jev-judge'].activity, 'Adopt / revise / drop · sonnet');
});

const post = (base, path, body) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('server seeds, reloads, and restores roster desks after a restart', async () => {
  const stateFile = join(dir, 'state.json');
  let floor = await startServer({ port: 0, log: () => {}, roomsFile: roomsPath, stateFile });
  let base = `http://127.0.0.1:${floor.server.address().port}`;
  try {
    let state = await (await fetch(`${base}/state`)).json();
    assert.ok(state.agents['roster:conquer:reporter']?.pinned);
    await post(base, '/events', [
      { type: 'join', agent: 'guest', team: 'Guest', activity: 'Asked: a private prompt' },
      { type: 'tool', agent: 'roster:conquer:reporter', tool: 'Write', activity: 'Writing r.md' },
    ]);

    // A broken rooms file keeps the current desks.
    writeFileSync(roomsPath, '{"rooms": [');
    assert.equal((await (await post(base, '/reload', {})).json()).roster, 4);
    // Drop a room from the file and reload: its roster leaves, the rest stays.
    writeFileSync(roomsPath, JSON.stringify({ ...ROOMS, rooms: ROOMS.rooms.filter((r) => r.slug !== 'ceo') }));
    assert.equal((await (await post(base, '/reload', {})).json()).roster, 2);
    state = await (await fetch(`${base}/state`)).json();
    assert.equal(state.agents['roster:ceo:report-intake'].status, 'offline');
    assert.ok(!state.agents['roster:ceo:report-intake'].pinned);
    assert.equal(state.agents['roster:conquer:reporter'].status, 'working', 're-seed keeps a working desk working');
  } finally {
    await floor.close();
    writeFileSync(roomsPath, JSON.stringify(ROOMS));
  }

  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(saved.agents.guest, undefined, 'lead sessions and prompts are not written to disk');

  floor = await startServer({ port: 0, log: () => {}, roomsFile: roomsPath, stateFile });
  base = `http://127.0.0.1:${floor.server.address().port}`;
  try {
    const state = await (await fetch(`${base}/state`)).json();
    assert.equal(state.agents.guest, undefined);
    const desk = state.agents['roster:conquer:reporter'];
    assert.equal(desk.status, 'idle', 'restored desks come back idle');
    assert.ok(desk.history.some((h) => h.text === 'Writing r.md'), 'desk history restored');
    assert.ok(state.agents['roster:ceo:report-intake'].pinned, 're-seeded from the rooms file');
  } finally {
    await floor.close();
  }
});

test('a corrupt state file never stops the server', async () => {
  for (const [i, text] of ['{"agents":null,"teams":{}}', '{"agents":{"x":null,"y":{"id":"y","team":"t","pinned":true}},"teams":null}', 'nope'].entries()) {
    const stateFile = join(dir, `bad-${i}.json`);
    writeFileSync(stateFile, text);
    const floor = await startServer({ port: 0, log: () => {}, roomsFile: roomsPath, stateFile });
    try {
      for (const ev of settlePinned(floor.state, Date.now() + 3_600_000)) floor.ingest(ev);
      sweep(floor.state, Date.now() + 3_600_000);
      assert.ok(floor.state.agents['roster:ceo:report-intake']);
    } finally {
      await floor.close();
    }
  }
});

test('POST /events cannot pin agents', async () => {
  const floor = await startServer({ port: 0, log: () => {} });
  const base = `http://127.0.0.1:${floor.server.address().port}`;
  try {
    await post(base, '/events', { type: 'join', agent: 'sneaky', team: 'x', pinned: true });
    assert.equal(floor.state.agents.sneaky.pinned, undefined);
  } finally {
    await floor.close();
  }
});

test('parent:null is ignored for ordinary agents', () => {
  const s = createState();
  run(s, { type: 'join', agent: 'lead', team: 't' });
  run(s, { type: 'join', agent: 'kid', parent: 'lead' });
  run(s, { type: 'status', agent: 'kid', status: 'idle', parent: null });
  assert.equal(s.agents.kid.parent, 'lead');
});

test('two overlapping spawns of one roster type: desk idles only after both finish', () => {
  const s = createState();
  for (const ev of seedEvents(cfg)) run(s, ev);
  const base = { session_id: 'sess9', cwd: 'C:\\DarkConquer-6192' };
  const spawn = (id) => ({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: id, tool_input: { subagent_type: 'live-ops-auditor' } });
  for (const ev of fromClaude(spawn('a'))) run(s, ev);
  for (const ev of fromClaude(spawn('b'))) run(s, ev);
  const desk = s.agents['roster:conquer:live-ops-auditor'];
  for (const ev of fromClaude({ ...spawn('a'), hook_event_name: 'PostToolUse' })) run(s, ev);
  assert.notEqual(desk.status, 'idle', 'still busy with the second spawn');
  assert.ok(desk.parent);
  for (const ev of fromClaude({ ...spawn('b'), hook_event_name: 'PostToolUse' })) run(s, ev);
  assert.equal(desk.status, 'idle');
  assert.equal(desk.parent, undefined);
  assert.equal(desk.spawns, 0);
});

test('a desk stuck after an interrupted subagent is reset after 30 minutes', () => {
  const s = createState();
  for (const ev of seedEvents(cfg)) run(s, { ...ev, ts: 1000 });
  run(s, { type: 'join', agent: 'roster:ceo:jev-judge', parent: 'lead', status: 'thinking', ts: 2000 });
  assert.deepEqual(settlePinned(s, 2000 + 20 * 60_000), []);
  for (const ev of settlePinned(s, 2000 + 31 * 60_000)) run(s, ev);
  const desk = s.agents['roster:ceo:jev-judge'];
  assert.equal(desk.status, 'idle');
  assert.equal(desk.spawns, 0);
  assert.equal(desk.parent, undefined);
});

test('without a rooms file the server and adapter behave as before', async () => {
  const floor = await startServer({ port: 0, log: () => {} });
  try {
    const state = await (await fetch(`http://127.0.0.1:${floor.server.address().port}/state`)).json();
    assert.deepEqual(Object.keys(state.agents), []);
  } finally {
    await floor.close();
  }
});
