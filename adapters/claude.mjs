// Claude Code hooks -> Agent Floor events.
// Receives the JSON object Claude Code writes to a hook's stdin.
// https://docs.claude.com/en/docs/claude-code/hooks
import { describeTool, pretty, roomFor, rooms, shortId, shortToolName, slugKey, teamFromCwd } from './common.mjs';
import { idleLine, mailTarget, rosterEntry, rosterId } from '../shared/rooms.js';

const SPAWN_TOOLS = new Set(['Task', 'Agent']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/**
 * @param {Record<string, any>} input hook payload
 * @param {{ source?: string, name?: string }} [opts]
 * @returns {import('../shared/protocol.js').InboundEvent[]}
 */
export function fromClaude(input, opts = {}) {
  if (!input || typeof input !== 'object') return [];
  const source = opts.source || 'claude-code';
  const lead = `${source}:${shortId(input.session_id)}`;
  const team = teamFromCwd(input.cwd);
  // Rooms file: an env team override wins, so only use the room when it is the one in use.
  const room = process.env.AGENT_FLOOR_TEAM ? null : roomFor(input.cwd);
  const base = {
    agent: lead,
    team,
    source,
    name: process.env.AGENT_FLOOR_NAME || room?.leadName || opts.name || (source === 'codex' ? 'Codex' : 'Claude'),
    role: 'Lead',
  };
  // Inside a subagent, newer Claude Code versions add agent_id / agent_type.
  const sub = input.agent_id || input.agent_type ? { key: input.agent_id, type: input.agent_type } : undefined;
  const actor = sub ? { agent: lead, team, source, subagent: sub } : base;

  const tool = input.tool_name;
  const toolInput = input.tool_input || {};

  switch (input.hook_event_name) {
    case 'SessionStart':
      return [{ type: 'join', ...base, status: 'idle', activity: 'Ready' }];

    case 'UserPromptSubmit':
      return [{ type: 'status', ...base, status: 'thinking', activity: `Asked: ${input.prompt ?? ''}` }];

    case 'PreToolUse': {
      if (SPAWN_TOOLS.has(tool)) {
        const type = toolInput.subagent_type || 'general-purpose';
        const key = input.tool_use_id || slugKey(toolInput.description || type);
        const entry = rosterEntry(room, type);
        return [
          { type: 'tool', ...actor, tool, activity: describeTool(tool, toolInput) },
          {
            type: 'join',
            // A roster type lights up its own standing desk instead of a new character.
            agent: entry ? rosterId(room.slug, type) : `${lead}:${shortId(key, 12)}`,
            parent: lead,
            team,
            source: entry ? 'roster' : source,
            name: entry?.name || pretty(type),
            role: type,
            status: 'thinking',
            activity: toolInput.description || 'Starting',
            text: toolInput.description || toolInput.prompt,
          },
        ];
      }
      const events = [{ type: 'tool', ...actor, tool: shortToolName(tool), activity: describeTool(tool, toolInput) }];
      if (WRITE_TOOLS.has(tool)) {
        const mail = mailTarget(rooms(), toolInput.file_path);
        if (mail) events.push({ type: 'message', ...actor, to: mail.to, text: mail.text });
      }
      if (tool === 'TodoWrite' && Array.isArray(toolInput.todos)) {
        const current =
          toolInput.todos.find((t) => t.status === 'in_progress') || toolInput.todos.find((t) => t.status === 'pending');
        if (current) events.push({ type: 'task', ...actor, task: current.activeForm || current.content });
      }
      return events;
    }

    case 'PostToolUse': {
      if (SPAWN_TOOLS.has(tool)) {
        const type = toolInput.subagent_type || 'general-purpose';
        const entry = rosterEntry(room, type);
        if (entry) {
          const desk = rosterId(room.slug, type);
          return [
            { type: 'message', agent: desk, team, to: lead, text: 'Report ready' },
            { type: 'status', agent: desk, status: 'idle', activity: idleLine(entry), parent: null },
            { type: 'status', ...base, status: 'thinking', activity: `Reviewing ${entry.name || pretty(type)} report` },
          ];
        }
        const key = input.tool_use_id || slugKey(toolInput.description || toolInput.subagent_type || 'general-purpose');
        const child = `${lead}:${shortId(key, 12)}`;
        return [
          { type: 'message', agent: child, parent: lead, team, source, to: lead, text: 'Report ready', status: 'done' },
          { type: 'status', agent: child, status: 'done', activity: 'Handed back results' },
          { type: 'status', ...base, status: 'thinking', activity: `Reviewing ${pretty(toolInput.subagent_type || 'helper')} report` },
        ];
      }
      return [{ type: 'status', ...actor, status: 'thinking', activity: `Done: ${describeTool(tool, toolInput)}` }];
    }

    case 'Notification':
      return [{ type: 'status', ...base, status: 'waiting', activity: input.message || 'Needs your input' }];

    case 'Stop':
      return [{ type: 'status', ...base, status: 'idle', activity: 'Waiting for you' }];

    case 'SubagentStop':
      if (!sub) return [];
      return [{ type: 'status', ...actor, status: 'done', activity: 'Finished' }];

    case 'PreCompact':
      return [{ type: 'status', ...base, status: 'thinking', activity: 'Tidying up memory' }];

    case 'SessionEnd':
      return [{ type: 'leave', ...base, activity: 'Session ended' }];

    default:
      return [];
  }
}
