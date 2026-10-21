// Room mode end to end: two computers in one process, live folder sync, merge, and agent cross-talk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get } from 'node:http';
import { createPeer } from '../src/room/peer.ts';
import { WebSocket } from 'ws';
import { merge3, createRoomHub, blockedPath } from '../src/room/hub.ts';
import { session, newNonce, connect } from '../src/room/wire.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'murmur-room-'));
async function until(what: string, fn: () => unknown, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (fn()) return;
  assert.fail(`timed out waiting for ${what}`);
}
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

test('merge3 merges edits to different lines and marks real conflicts', () => {
  const b = Buffer.from('a\nb\nc\n');
  assert.deepEqual(merge3(Buffer.from('A\nb\nc\n'), b, Buffer.from('a\nb\nC\n')), { out: Buffer.from('A\nb\nC\n'), clean: true });
  const c = merge3(Buffer.from('X\nb\nc\n'), b, Buffer.from('Y\nb\nc\n'))!;
  assert.equal(c.clean, false);
  assert.match(String(c.out), /<<<<<<< theirs/);
  assert.equal(merge3(Buffer.from([0, 1]), b, b), null);
});

test('two computers share a folder live and their agents talk', async () => {
  const dirA = tmp(), dirB = join(tmp(), 'proj');
  mkdirSync(join(dirA, 'src'));
  writeFileSync(join(dirA, 'src', 'app.js'), 'line1\nline2\nline3\n');
  writeFileSync(join(dirA, '.env'), 'SECRET=1');
  // A fake agent CLI: announces a plan, edits a file, and pings the other agent once.
  const fake = join(tmp(), 'fake-agent.mjs');
  writeFileSync(fake, `import { appendFileSync, readFileSync } from 'node:fs';
const [me, other] = process.argv.slice(2), prompt = readFileSync(process.argv[4], 'utf8');
appendFileSync('agent-log.txt', me + ' ran\\n');
console.log('PLAN: say hi');
console.log(prompt.includes('[' + other + ']') ? 'thanks ' + other : '@' + other + ': hello from ' + me);
`);
  const A = await createPeer({ home: tmp(), port: 0, hubPort: 0, hubHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const B = await createPeer({ home: tmp(), port: 0 });
  try {
    await A.api.create({ name: 'gio', room: 'demo', folder: dirA });
    const invite = A.state().room!.invite;
    assert.match(invite, /^http:\/\/127\.0\.0\.1:\d+\/r\/[\w-]+#key=/);
    await until('A connected', () => A.state().room?.connected);

    // Joining downloads the room's files once; secrets never leave A.
    await B.api.join({ name: 'sam', link: invite, folder: dirB });
    await until('B has the file', () => read(join(dirB, 'src', 'app.js')) === 'line1\nline2\nline3\n');
    assert.equal(existsSync(join(dirB, '.env')), false);

    // Edits flow both ways, file by file.
    writeFileSync(join(dirB, 'src', 'new.txt'), 'from sam');
    await until('A sees B\'s new file', () => read(join(dirA, 'src', 'new.txt')) === 'from sam');
    writeFileSync(join(dirA, 'src', 'app.js'), 'LINE1\nline2\nline3\n');
    await until('B sees A\'s edit', () => read(join(dirB, 'src', 'app.js')) === 'LINE1\nline2\nline3\n');
    unlinkSync(join(dirB, 'src', 'new.txt'));
    await until('delete reaches A', () => !existsSync(join(dirA, 'src', 'new.txt')));

    // Both edit the same file at once (different lines): both edits survive on both computers.
    writeFileSync(join(dirA, 'src', 'app.js'), 'LINE1\nline2\nA-was-here\n');
    writeFileSync(join(dirB, 'src', 'app.js'), 'B-was-here\nline2\nline3\n');
    const merged = 'B-was-here\nline2\nA-was-here\n';
    await until('merge on both sides', () => read(join(dirA, 'src', 'app.js')) === merged && read(join(dirB, 'src', 'app.js')) === merged);

    // Agents on different computers wake each other with @Name and reply.
    A.api.addAgent({ name: 'Ann', cli: 'custom', cmd: `'${process.execPath}' '${fake}' Ann Bob {promptfile}` });
    B.api.addAgent({ name: 'Bob', cli: 'custom', cmd: `'${process.execPath}' '${fake}' Bob Ann {promptfile}` });
    await until('both agents visible', () => A.state().agents.length === 2 && B.state().agents.length === 2);
    B.api.say({ text: '@Ann please start' });
    await until('Bob answered Ann', () => A.state().feed.some(e => e.from === 'Bob' && /hello from Bob|thanks Ann/.test(e.text)));
    const feed = A.state().feed;
    assert.ok(feed.some(e => e.from === 'Ann' && e.fromKind === 'agent' && e.to?.includes('Bob')));
    // Agent activity is a file edit like any other: it synced too.
    await until('agent log synced', () => /Ann ran/.test(read(join(dirB, 'agent-log.txt')) ?? ''));
  } finally {
    await B.close(); await A.close();
  }
});

test('local UI rejects foreign hosts and cross-site posts', async () => {
  const P = await createPeer({ home: tmp(), port: 0 });
  try {
    const port = new URL(P.url).port;
    assert.equal((await fetch(`${P.url}/api/leave`, { method: 'POST' })).status, 403);
    const foreign = await new Promise<number>(r => get({ host: '127.0.0.1', port, path: '/', headers: { host: `evil.example:${port}` } }, res => r(res.statusCode!)));
    assert.equal(foreign, 403);
    assert.equal((await fetch(`${P.url}/api/leave`, { method: 'POST', headers: { 'x-murmur': '1' } })).status, 200);
    assert.match(await (await fetch(`${P.url}/`)).text(), /Start a room/);
  } finally { await P.close(); }
});

test('claude/codex model + effort become the right CLI flags', async () => {
  const { modelArgs, modelOptions, runTurn } = await import('../src/room/agent.ts');
  assert.deepEqual(modelArgs('claude', 'opus', 'max'), ['--model', 'opus', '--effort', 'max']);
  assert.deepEqual(modelArgs('codex', 'gpt-5.6-sol', 'xhigh'), ['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=xhigh']);
  assert.deepEqual(modelArgs('codex', 'bad model; rm -rf', 'high'), ['-c', 'model_reasoning_effort=high']);
  assert.deepEqual(modelArgs('gemini', 'x', 'high'), []);

  // Flags land before codex's trailing "-" (read prompt from stdin), and the prompt still arrives on stdin.
  const dir = tmp(), script = join(dir, 'args.mjs');
  writeFileSync(script, `let s = ''; for await (const c of process.stdin) s += c; console.log(JSON.stringify([process.argv.slice(2), s]));`);
  const out: string[] = [];
  await runTurn({ template: `'${process.execPath}' '${script}' exec -`, prompt: 'hi', cwd: dir, extra: modelArgs('codex', 'm1', 'low'), onOut: (_k, t) => out.push(t) }).done;
  assert.deepEqual(JSON.parse(out.join('')), [['exec', '-m', 'm1', '-c', 'model_reasoning_effort=low', '-'], 'hi']);

  // Codex models come from the account's cache; a config default outside it is flagged.
  const home = tmp();
  writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-a', display_name: 'GPT A', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] }] }));
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-zzz"\nmodel_reasoning_effort = "high"\n[projects."x"]\nmodel = "nope"\n');
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const o = modelOptions();
    assert.deepEqual(o.codex.models.map(m => [m.id, m.efforts]), [['gpt-a', ['low', 'max']]]);
    assert.equal(o.codex.configModel, 'gpt-zzz');
    assert.equal(o.codex.configEffort, 'high');
    assert.equal(o.codex.configModelMissing, true);
    assert.ok(o.claude.models.some(m => m.id === 'opus') && o.claude.efforts.includes('xhigh'));
  } finally { if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev; }
});

test('wire: wrong key is denied, the key never travels, replays are rejected', async () => {
  const hub = await createRoomHub({ dataDir: tmp(), port: 0, host: '127.0.0.1' });
  const { id, key } = hub.createRoom('r');
  // Connect with the real client, recording every frame it sends.
  const join = (k: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`), sent: (string | Buffer)[] = [], raw = ws.send.bind(ws);
    ws.send = ((d: string | Buffer) => { sent.push(d); raw(d); }) as typeof ws.send;
    return connect(ws, id, k, { peerId: 'p1', name: 'raw', folder: '' }).then(c => ({ c, sent }));
  };
  try {
    assert.deepEqual((await join('not-the-key')).c, { denied: 'room not found or wrong link' });

    const ok = await join(key);
    assert.ok(ok.c && 'welcome' in ok.c);
    assert.equal(ok.c.welcome.room.name, 'r');
    assert.ok(ok.sent.every(f => !String(f).includes(key)));

    // Same session on both ends: a frame opens once, its replay does not; the key is not in a sealed frame.
    const n1 = newNonce(), n2 = newNonce(), a = session(key, n1, n2, false), b = session(key, n1, n2, true);
    const f = a.seal({ t: 'say', text: key });
    assert.ok(!f.includes(key));
    assert.equal(b.open(f).text, key);
    assert.throws(() => b.open(f));

    assert.ok(['.GIT/config', '.git./hooks/x', '.claude/settings.json', 'a/.Env', '.mcp.json'].every(blockedPath));
    assert.ok(!blockedPath('src/app.js'));
  } finally { await hub.close(); }
});

test('restart opens home (offers rejoin, no old chat); presence carries folders; run steps per project', async () => {
  const { runSteps } = await import('../src/room/peer.ts');
  const d = tmp();
  writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  assert.deepEqual(runSteps(d), ['npm install', 'npm run dev']);
  const py = tmp(); writeFileSync(join(py, 'main.py'), '');
  assert.deepEqual(runSteps(py, 'win32'), ['python main.py']);

  const home = tmp(), folder = tmp();
  let P = await createPeer({ home, port: 0, hubPort: 0, hubHost: '127.0.0.1', publicHost: '127.0.0.1' });
  await P.api.create({ name: 'gio', room: 'old', folder });
  await until('connected', () => P.state().room?.connected);
  await until('presence has my folder', () => P.state().peers[0]?.folder === folder);
  P.api.say({ text: 'old project chat' });
  await until('chat', () => P.state().feed.some(e => e.text === 'old project chat'));
  await P.close();
  P = await createPeer({ home, port: 0, hubPort: 0, hubHost: '127.0.0.1', publicHost: '127.0.0.1' });
  try {
    assert.equal(P.state().room, null);
    assert.deepEqual(P.state().feed, []);
    assert.equal(P.state().last?.name, 'old');
    await P.api.rejoin({});
    await until('rejoined with history', () => P.state().feed.some(e => e.text === 'old project chat'));
  } finally { await P.close(); }
});

test('folder dialog: native picker per OS, wired to both folder fields', async () => {
  const { folderDialog } = await import('../src/room/peer.ts');
  assert.equal(folderDialog('darwin')[0][0], 'osascript');
  assert.equal(folderDialog('win32')[0][0], 'powershell');
  assert.deepEqual(folderDialog('linux').map(a => a[0]), ['zenity', 'kdialog']);
  const html = readFileSync(new URL('../src/room/web/index.html', import.meta.url), 'utf8');
  assert.equal(html.match(/<input type="hidden" name="folder"><button type="button" class="choose"/g)?.length, 2);
});

test('starting a room requires a chosen folder', async () => {
  const P = await createPeer({ home: tmp(), port: 0, hubPort: 0, hubHost: '127.0.0.1', publicHost: '127.0.0.1' });
  try {
    await assert.rejects(P.api.create({ name: 'gio', room: 'x' }), /choose a project folder/);
    await assert.rejects(P.api.create({ name: 'gio', room: 'x', folder: '  ' }), /choose a project folder/);
    assert.equal(P.state().room, null);
  } finally { await P.close(); }
});

test('agent reply limit: set when starting a room, changeable by the host only', async () => {
  const P = await createPeer({ home: tmp(), port: 0, hubPort: 0, hubHost: '127.0.0.1', publicHost: '127.0.0.1' });
  try {
    await assert.rejects(P.api.setMaxHops({ maxHops: 3 }), /only the room host/);
    await assert.rejects(P.api.create({ name: 'gio', room: 'x', folder: tmp(), maxHops: -1 }), /agent reply limit/);
    await P.api.create({ name: 'gio', room: 'x', folder: tmp(), maxHops: null });
    await until('unlimited', () => P.state().room?.connected && P.state().room?.maxHops === null);
    await assert.rejects(P.api.setMaxHops({ maxHops: 2.5 }), /agent reply limit/);
    await P.api.setMaxHops({ maxHops: 7 });
    await until('limit 7', () => P.state().room?.maxHops === 7);
  } finally { await P.close(); }
});

test('agent full access: off unless asked, toggled per agent, kept with model settings', async () => {
  const P = await createPeer({ home: tmp(), port: 0, hubPort: 0, hubHost: '127.0.0.1', publicHost: '127.0.0.1' });
  try {
    await P.api.create({ name: 'gio', room: 'x', folder: tmp() });
    await P.api.addAgent({ name: 'Safe', cli: 'claude', model: 'opus' });
    await P.api.addAgent({ name: 'Root', cli: 'claude', fullAccess: true });
    const id = (n: string) => P.state().mine.find((a: any) => a.name === n).id;
    assert.deepEqual(P.state().access, { [id('Safe')]: false, [id('Root')]: true });
    await P.api.setAgent({ id: id('Safe'), fullAccess: true });
    assert.equal(P.state().access[id('Safe')], true);
    assert.equal(P.state().mine.find((a: any) => a.name === 'Safe').model, 'opus'); // toggling access keeps the model
    await assert.rejects(P.api.setAgent({ id: id('Safe'), fullAccess: 'yes' }), /fullAccess/);
  } finally { await P.close(); }
});
