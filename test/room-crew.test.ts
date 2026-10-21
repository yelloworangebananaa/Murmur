// This computer's agents with a fake turn runner: queueing, batching, PLAN/CLAIM tracking, stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrew, type Turn } from '../src/room/crew.ts';

function setup(view: Partial<ReturnType<Parameters<typeof createCrew>[0]['room']>> = {}) {
  const turns: { prompt: string; out: (k: 'agent' | 'tool' | 'error', t: string) => void; end: () => void; stopped: boolean; extra?: string[] }[] = [];
  const sent: any[] = [];
  const turn: Turn = o => {
    let end!: () => void;
    const t = { prompt: o.prompt, out: o.onOut, end: () => end(), stopped: false, extra: o.extra };
    turns.push(t);
    return { done: new Promise<void>(r => { end = r; }), stop: () => { t.stopped = true; } };
  };
  const crew = createCrew({ turn, send: m => sent.push(m), room: () => ({ name: 'demo', me: 'gio', peers: [{ name: 'gio' }], agents: [], feed: [], cwd: '/x', ...view }) });
  crew.load([{ id: 'a1', name: 'Ann', cli: 'claude', cmd: 'claude -p', model: 'opus' }]);
  return { crew, turns, sent };
}
const tick = () => new Promise(r => setImmediate(r));

test('crew: messages queued during a turn run together as the next turn, at the batch\'s highest hop', async () => {
  const { crew, turns, sent } = setup();
  crew.wake('a1', { from: 'gio', text: 'first', hops: 0 });
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].extra, ['--model', 'opus', '--permission-mode', 'acceptEdits', '--disallowedTools=Bash']);
  assert.equal(crew.busy(), 'Ann');
  crew.wake('a1', { from: 'Bob', text: 'second', hops: 3 });
  crew.wake('a1', { from: 'Cy', text: 'third', hops: 1 });
  assert.equal(turns.length, 1);
  turns[0].end(); await tick();
  assert.equal(turns.length, 2);
  assert.match(turns[1].prompt, /\[Bob\] second\n\[Cy\] third$/);
  turns[1].out('agent', 'done');
  assert.deepEqual(sent.at(-1), { t: 'feed', agentId: 'a1', kind: 'agent', text: 'done', hops: 3 });
  turns[1].end(); await tick();
  assert.equal(turns.length, 2);
  assert.equal(crew.busy(), undefined);
  crew.wake('nobody', { from: 'x', text: 'y', hops: 0 });
});

test('crew: PLAN/CLAIM lines become status, cleared after the turn', async () => {
  const { crew, turns, sent } = setup();
  crew.wake('a1', { from: 'gio', text: 'go', hops: 0 });
  turns[0].out('agent', 'ok\nPLAN: fix login\nCLAIM: src/a.ts, src/b.ts');
  assert.deepEqual(crew.list()[0], { id: 'a1', name: 'Ann', cli: 'claude', model: 'opus', effort: undefined, status: 'working', doing: 'fix login', claims: ['src/a.ts', 'src/b.ts'] });
  assert.equal(sent.filter(m => m.t === 'agents').at(-1).list[0].doing, 'fix login');
  turns[0].end(); await tick();
  assert.deepEqual([crew.list()[0].status, crew.list()[0].doing, crew.list()[0].claims], ['idle', undefined, []]);
});

test('crew: the prompt names the room, other agents and their claims, and recent chat', () => {
  const { crew, turns } = setup({
    agents: [{ id: 'a1', name: 'Ann', cli: 'claude', status: 'idle', claims: ['mine.ts'] }, { id: 'b1', name: 'Bob', cli: 'codex', status: 'working', doing: 'tests', owner: 'sam', claims: ['test/x.ts'] }],
    feed: [{ id: '1', at: 0, kind: 'chat', from: 'sam', fromKind: 'human', text: 'hello all' }, { id: '2', at: 0, kind: 'tool', from: 'Bob', fromKind: 'agent', text: 'Edit x' }],
  });
  crew.wake('a1', { from: 'sam', text: '@Ann help', hops: 0 });
  const p = turns[0].prompt;
  assert.match(p, /going in circles.*stop @mentioning other agents.*write to the people/s);
  assert.match(p, /do not try to finish the whole thing yourself/);
  assert.match(p, /Never @mention an agent just to say you are done/);
  assert.doesNotMatch(p, /When you finish.*@mention/);
  assert.match(p, /You are "Ann", an AI coding agent in the Murmur room "demo"/);
  assert.match(p, /- @Bob \(codex, run by sam\): working - tests/);
  assert.match(p, /claimed \(ask before editing them\): test\/x\.ts \(Bob\)$/m);
  assert.doesNotMatch(p, /mine\.ts/);
  assert.match(p, /\[sam\] hello all/);
  assert.doesNotMatch(p, /Edit x/);
});

test('crew: stop empties the queue and stops the turn; at most 20 messages wait', async () => {
  const { crew, turns } = setup();
  crew.wake('a1', { from: 'gio', text: 'go', hops: 0 });
  for (let i = 0; i < 25; i++) crew.wake('a1', { from: 'gio', text: `m${i}`, hops: 0 });
  crew.stop('a1');
  assert.ok(turns[0].stopped);
  turns[0].end(); await tick();
  assert.equal(turns.length, 1);

  const b = setup();
  b.crew.wake('a1', { from: 'gio', text: 'go', hops: 0 });
  for (let i = 0; i < 25; i++) b.crew.wake('a1', { from: 'gio', text: `m${i}`, hops: 0 });
  b.turns[0].end(); await tick();
  assert.equal(b.turns[1].prompt.split('\n').filter(l => /^\[gio\] m\d+$/.test(l)).length, 20);
  assert.match(b.turns[1].prompt, /\[gio\] m5\n/);
});
