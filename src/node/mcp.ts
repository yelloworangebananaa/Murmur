// "murmur" MCP stdio server spawned by claude. Forwards each tool call to the local node; lane identity comes only from env.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { untrusted } from '../shared.ts';
import { callNode } from './loopback.ts';

const s = z.string(), paths = z.array(s);

const TOOLS: Record<string, [string, z.ZodRawShape]> = {
  team_status: ['Who is working on what: sessions, lanes, current steps, presence, open conflicts. Call before starting work.', {}],
  publish_plan: ['Replace this session\'s plan with these steps (and the paths each touches).', { steps: z.array(z.object({ text: s, paths: paths.optional() })) }],
  update_step: ['Change a plan step\'s status as you progress.', { stepId: s, status: s, note: s.optional(), version: z.number().optional() }],
  claim_step: ['Take ownership of a plan step before working on it.', { stepId: s }],
  release_step: ['Give up ownership of a plan step you will not finish.', { stepId: s }],
  board_list: ['List the shared task board.', {}],
  create_task: ['Add a task to the shared board for later or for someone else.', { title: s, notes: s.optional(), paths: paths.optional(), acceptance: s.optional() }],
  claim_task: ['Claim a board task (pass the version you saw).', { taskId: s, version: z.number() }],
  update_task: ['Move or edit a board task (pass the version you saw).', { taskId: s, version: z.number(), col: s.optional(), notes: s.optional(), title: s.optional() }],
  lease_files: ['Reserve paths before editing them so others do not collide; returns holders on conflict.', { paths, ttlSec: z.number().optional() }],
  release_files: ['Release file leases once you are done with those paths.', { paths }],
  check_overlap: ['See which lanes are touching, planning or leasing these paths, plus open conflicts.', { paths: paths.optional() }],
  peer_changes: ['See uncommitted changes other lanes are making (dirty paths and patches).', { laneId: s.optional() }],
  send_message: ['Message another lane ("lane:<id>"), the session, a user ("user:<id>") or "all".', { to: s, body: s }],
  get_messages: ['Read messages sent to this lane.', {}],
  remember: ['Save a durable team note, anchored to the given paths.', { body: s, paths: paths.optional() }],
  recall: ['Search team memory; hits flagged stale if their files changed.', { query: s, paths: paths.optional() }],
  request_approval: ['Ask a human before a risky non-tool action (e.g. a deploy plan).', { action: s, reason: s }],
  hand_off: ['Stop and hand this lane to a human with a brief of where things stand.', { reason: s }],
  read_lane: ['Read recent output of another lane.', { laneId: s, tail: z.number().optional() }],
  record_outcome: ['Record whether an action worked, so the team learns from it.', { toolUseId: s.optional(), outcome: s }],
};

const server = new McpServer({ name: 'murmur', version: '0.1.0' });
const err = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

server.registerTool('ping', { description: 'Check the murmur server is alive.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
for (const [name, [description, inputSchema]] of Object.entries(TOOLS)) {
  server.registerTool(name, { description, inputSchema }, async (args: any) => {
    try {
      const r = await callNode(`/mcp/${name}`, JSON.stringify({ args }));
      const j: any = await r.json().catch(() => ({ ok: false, error: `node returned HTTP ${r.status}` }));
      if (!j.ok) return err(String(j.error ?? `node returned HTTP ${r.status}`));
      return { content: [{ type: 'text', text: untrusted('murmur', j.result) }] };
    } catch (e: any) {
      return err(`murmur node unreachable: ${e.message}`);
    }
  });
}

await server.connect(new StdioServerTransport());
