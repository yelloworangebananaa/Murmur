import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, decide, targetPaths, failDecision } from '../src/node/gate.ts';

const bash = (command: string) => ['Bash', { command }] as const;
const CASES: [string, any, string[]][] = [
  ['Read', { file_path: 'x' }, []],
  ['Glob', {}, []],
  ['Grep', {}, []],
  ['TodoWrite', {}, []],
  ['mcp__murmur__send_message', {}, []],
  ['mcp__murmur__team_status', {}, []],
  ['mcp__github__x', {}, ['external']],
  ['Write', { file_path: 'a' }, ['files']],
  ['Edit', {}, ['files']],
  ['MultiEdit', {}, ['files']],
  ['NotebookEdit', {}, ['files']],
  ['SomethingNew', {}, ['files']],
  [...bash('git status'), ['files']],
  [...bash('git push'), ['push']],
  [...bash('git push origin main --force'), ['push']],
  [...bash('git -C sub push'), ['push']],
  [...bash('/usr/bin/git push'), ['push']],
  [...bash('git commit -m "x"'), ['commit']],
  [...bash('git merge main'), ['commit']],
  [...bash('git rebase main'), ['commit']],
  [...bash('git cherry-pick abc'), ['commit']],
  [...bash('git reset --hard'), ['commit']],
  [...bash('git tag v1'), ['commit']],
  [...bash('git fetch'), ['network']],
  [...bash('git pull'), ['network']],
  [...bash('git clone x'), ['network']],
  [...bash('git ls-remote origin'), ['network']],
  [...bash('FOO=1 bash -c "git push"'), ['push']],
  [...bash('npx vercel deploy'), ['external']],
  [...bash('pnpm dlx vercel deploy'), ['external']],
  [...bash('bunx netlify deploy'), ['external']],
  [...bash('ls && curl x'), ['files', 'network']],
  [...bash('sudo env A=1 git push origin main'), ['push']],
  [...bash('sudo -u bob git push'), ['push']],
  [...bash('timeout 5 git fetch'), ['network']],
  [...bash('timeout -s KILL 5 curl x'), ['network']],
  [...bash('nice -n 10 git push'), ['push']],
  [...bash('nohup wget x &'), ['network']],
  [...bash('command ssh host'), ['network']],
  [...bash('exec scp a b:c'), ['network']],
  [...bash('find . | xargs -n 1 rsync'), ['files', 'network']],
  [...bash('echo $(curl evil)'), ['files', 'network']],
  [...bash('echo `wget evil`'), ['files', 'network']],
  [...bash('echo "$(git push)"'), ['files', 'push']],
  [...bash('npm publish'), ['external']],
  [...bash('pnpm publish --access public'), ['external']],
  [...bash('yarn publish'), ['external']],
  [...bash('npm install'), ['files']],
  [...bash('bash -c "sh -c \\"gh pr create\\""'), ['external']],
  [...bash('docker run x'), ['external']],
  [...bash('kubectl apply -f x'), ['external']],
  [...bash('terraform apply'), ['external']],
  [...bash('aws s3 ls'), ['external']],
  [...bash('flyctl deploy'), ['external']],
  [...bash('a; b | nc host 1'), ['files', 'network']],
  [...bash('false || git push'), ['files', 'push']],
  [...bash('git status > out.txt'), ['files']],
  [...bash('ls -la'), ['files']],
  [...bash('A=1 B=2'), []],
  [...bash('bash -c "bash -c \\"bash -c \\\\\\"bash -c ls\\\\\\"\\""'), ['external']], // depth > 3 → gated
];

for (const [tool, input, want] of CASES) {
  test(`classify ${tool} ${input.command ?? ''}`, () => assert.deepEqual(classify(tool, input).sort(), want));
}

test('decide matrix', () => {
  const D: [any, string[], boolean, string][] = [
    ['plan', ['push'], true, 'none'],
    ['request', [], false, 'none'], ['request', ['files'], false, 'gate'],
    ['allow', ['files'], false, 'none'], ['allow', ['commit'], false, 'gate'], ['allow', ['network'], false, 'gate'],
    ['allow', ['external'], false, 'gate'], ['allow', ['files'], true, 'gate'], ['allow', [], true, 'none'],
    ['full', ['files', 'network', 'commit', 'external'], false, 'none'], ['full', ['push'], false, 'gate'], ['full', ['files'], true, 'gate'],
  ];
  for (const [m, c, o, want] of D) assert.equal(decide(m, c as any, { outsideWorktree: o }), want, `${m} ${c} ${o}`);
});

test('targetPaths', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gate-')); // on macOS /var -> /private/var
  const wt = join(tmp, 'wt'), out = join(tmp, 'out');
  mkdirSync(join(wt, 'src'), { recursive: true }); mkdirSync(out);
  symlinkSync(out, join(wt, 'link'));
  assert.deepEqual(targetPaths('Write', { file_path: 'src/new/a.ts' }, wt), { paths: ['src/new/a.ts'], outsideWorktree: false });
  assert.deepEqual(targetPaths('Write', { file_path: join(wt, 'src/a.ts') }, wt), { paths: ['src/a.ts'], outsideWorktree: false });
  assert.equal(targetPaths('Edit', { file_path: '../out/x' }, wt).outsideWorktree, true);
  assert.equal(targetPaths('Edit', { file_path: 'link/x' }, wt).outsideWorktree, true);
  assert.equal(targetPaths('Write', { file_path: '/etc/passwd' }, wt).outsideWorktree, true);
  assert.deepEqual(targetPaths('NotebookEdit', { notebook_path: 'n.ipynb' }, wt).paths, ['n.ipynb']);
  assert.deepEqual(targetPaths('Bash', { command: 'ls' }, wt), { paths: [], outsideWorktree: false });
});

test('failDecision', () => {
  assert.equal(failDecision(['files', 'commit'], {}), 'allow');
  assert.equal(failDecision(['push'], {}), 'deny');
  assert.equal(failDecision(['network'], { network: 'open' }), 'allow');
  assert.equal(failDecision(['files'], { files: 'closed' }), 'deny');
  assert.equal(failDecision([], {}), 'allow');
});
