// Murmur room UI. Talks only to this computer's Murmur (same origin). All remote text goes through textContent.
import { dotMatrix, tornado } from './fx.js';
import hljs from './hl.js';
const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter(k => k != null)); return n; };
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let S = null, M = null, openPath = null, openLines = [], openHtml = [], recent = new Map(); // path -> color of last editor
let follow = null; const lastEdit = new Map(); // followed agent name; agent name -> last path it edited
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const api = async (action, body = {}) => {
  const r = await fetch(`/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-murmur': '1' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
  return j;
};
// Short status message, like the old hub's flash(). ok=true styles it as success.
function toast(msg, ok) {
  $('toast').replaceChildren(el('div', { className: ok ? 'toast ok' : 'toast', textContent: msg }));
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $('toast').replaceChildren(), 4500);
}
// One WebGL backdrop per screen; swap the canvas only when the effect changes (the old one stops once detached).
let fxKind = null;
function backdrop(kind) {
  if (kind === fxKind) return;
  fxKind = kind;
  const c = el('canvas', { id: 'bg', className: 'fx' });
  c.setAttribute('aria-hidden', 'true');
  $('bg').replaceWith(c);
  try { (kind === 'tornado' ? tornado : dotMatrix)(c); } catch {} // no WebGL: plain background
}
const avatar = (name, color, cls = '') => el('span', { className: `av ${cls}`, textContent: (name || '?')[0].toUpperCase(), title: name, style: `background:${color || '#888'}` });

// ---------------- models + effort (claude, codex) ----------------
const loadModels = async () => { M = await (await fetch('/api/models')).json().catch(() => null); };
const opt = (value, text) => el('option', { value, textContent: text });
function modelOpts(cli, cur) {
  const c = M?.[cli];
  const def = cli === 'codex' && c?.configModel ? `Default (${c.configModel}, from your Codex config)` : 'Default';
  const list = (c?.models ?? []).map(m => opt(m.id, `${m.label}${m.label !== m.id ? ` · ${m.id}` : ''}${m.hidden ? ' (hidden)' : ''}`));
  if (cur && !(c?.models ?? []).some(m => m.id === cur)) list.push(opt(cur, cur));
  return [opt('', def), ...list, opt('__other', 'Other model id…')];
}
function effortOpts(cli, model) {
  const c = M?.[cli], m = c?.models.find(x => x.id === model);
  const levels = m?.efforts?.length ? m.efforts : c?.efforts ?? [];
  const def = cli === 'codex' && c?.configEffort && !model ? `Default (${c.configEffort})` : m?.defaultEffort ? `Default (${m.defaultEffort})` : 'Default';
  return [opt('', def), ...levels.map(e => opt(e, e))];
}
const hasModels = cli => cli === 'claude' || cli === 'codex';

// ---------------- home ----------------
function home() {
  $('home').hidden = false; $('room').hidden = true;
  backdrop('tornado');
  const n = $('h-name');
  if (!n.value) n.value = S.me.name || store.get('name') || '';
  const cf = $('f-create').folder, jf = $('f-join').folder;
  if (!jf.value) jf.value = store.get('joinFolder') || '';
  for (const b of document.querySelectorAll('.choose')) showPick(b);
  $('f-create').querySelector('button.big').disabled = !cf.value;
  $('h-last').hidden = !S.last;
  if (S.last) { $('h-last-name').textContent = S.last.name || 'last room'; $('h-last-folder').textContent = S.last.folder; }
  steps();
}
$('h-rejoin').onclick = async () => {
  const b = $('h-rejoin'); b.disabled = true; b.textContent = 'Rejoining…';
  try { await api('rejoin'); } catch (err) { toast(err.message); }
  b.disabled = false; b.textContent = 'Rejoin room';
};
// Goal-gradient: tick off the landing steps as the user goes.
const steps = () => $('h-steps').children[0].classList.toggle('done', !!$('h-name').value.trim());
$('h-name').oninput = steps;
async function submit(e, action) {
  e.preventDefault();
  const name = $('h-name').value.trim();
  $('h-err').textContent = '';
  if (!name) { $('h-err').textContent = 'Type your name first.'; return $('h-name').focus(); }
  if (action === 'create' && !e.target.folder.value) { $('h-err').textContent = 'Choose a project folder first.'; return e.target.querySelector('.choose').focus(); }
  store.set('name', name);
  const f = Object.fromEntries(new FormData(e.target));
  if (action === 'create') f.maxHops = hopsVal($('c-hops'));
  if (f.folder) store.set(action === 'create' ? 'folder' : 'joinFolder', f.folder);
  const btn = e.target.querySelector('button.big'), label = btn.textContent;
  btn.disabled = true; btn.textContent = action === 'create' ? 'Starting…' : 'Joining…';
  try { await api(action, { ...f, name }); } catch (err) { $('h-err').textContent = err.message; toast(err.message); }
  btn.disabled = false; btn.textContent = label;
}
// Agent reply limit: a number box plus an ∞ toggle. null = unlimited; '' (empty box) is sent as-is and refused.
const hopsVal = w => w.querySelector('.inf').getAttribute('aria-pressed') === 'true' ? null : w.querySelector('input').value === '' ? '' : Number(w.querySelector('input').value);
function setHops(w, v) {
  const inf = v === null, i = w.querySelector('input');
  w.querySelector('.inf').setAttribute('aria-pressed', String(inf));
  i.disabled = inf || i.dataset.locked === '1';
  if (inf) i.value = ''; else if (v !== undefined) i.value = v;
}
$('c-hops').querySelector('.inf').onclick = () => { const w = $('c-hops'); setHops(w, hopsVal(w) === null ? 4 : null); };
// In the room, only the host can change it (the room server runs on their computer).
const saveHops = async v => { try { await api('setMaxHops', { maxHops: v }); } catch (err) { toast(err.message); room(); } };
$('r-hops').querySelector('input').onchange = e => saveHops(e.target.value === '' ? '' : Number(e.target.value));
$('r-hops').querySelector('.inf').onclick = () => saveHops(hopsVal($('r-hops')) === null ? 4 : null);
// Native folder dialog, opened by this computer's Murmur (a browser picker can't return a full path).
// Folder fields are a button only: it opens the dialog and shows the chosen folder's name (full path on hover).
function showPick(b) {
  const v = b.previousElementSibling.value;
  b.textContent = v ? v.split(/[\\/]/).filter(Boolean).pop() || v : b.dataset.empty || 'Choose folder';
  b.title = v ? `${v} (click to change)` : '';
}
for (const b of document.querySelectorAll('.choose')) b.onclick = async () => {
  b.disabled = true;
  try { const { folder } = await api('pickFolder'); if (folder) { b.previousElementSibling.value = folder; showPick(b); } } catch (err) { toast(err.message); }
  b.disabled = false;
  const start = $('f-create').querySelector('button.big'); start.disabled = !$('f-create').folder.value;
};
$('f-create').onsubmit = e => submit(e, 'create');
$('f-join').onsubmit = e => submit(e, 'join');

// ---------------- room ----------------
function room() {
  $('home').hidden = true; $('room').hidden = false;
  backdrop('dots');
  const R = S.room;
  $('r-name').textContent = R.name || 'connecting…';
  const c = $('r-conn');
  c.className = 'live ' + (R.connected ? 'up' : 'down');
  c.textContent = R.denied ? R.denied : R.connected ? (R.hosted ? 'hosting' : 'live') : 'reconnecting…';
  $('r-people').replaceChildren(...S.peers.map(p => avatar(p.name, p.color)));
  const hw = $('r-hops'), hi = hw.querySelector('input');
  hi.dataset.locked = R.hosted ? '0' : '1'; hw.querySelector('.inf').disabled = !R.hosted;
  hw.title = 'Agent replies before the room pauses for a person' + (R.hosted ? '' : ' (only the host can change this)');
  if (document.activeElement !== hi) setHops(hw, R.maxHops === undefined ? 4 : R.maxHops);
  agentsView(); filesView(); toOptions(); foldersView();
}
// Terminal commands for a folder, quoted for that person's OS (PowerShell on Windows, sh elsewhere).
const cdCmd = (dir, os) => os === 'win32' ? `cd "${dir}"` : `cd '${dir.replaceAll("'", `'\\''`)}'`;
const chain = (cmds, os) => cmds.join(os === 'win32' ? '; ' : ' && ');
const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied. Paste it in a terminal.`, true); }
  catch { prompt('Copy this:', text); }
}
function foldersView() {
  $('p-list').replaceChildren(...S.peers.map(p => {
    const me = p.name === S.me.name && p.color === S.me.color, os = me ? S.os : p.os, run = me ? S.run : [];
    return el('li', {},
      avatar(p.name, p.color),
      el('span', { className: 'nm', textContent: me ? `${p.name} (you)` : p.name }), el('span', { className: 'pill', textContent: OS[os] || '?' }),
      el('code', { className: 'path', textContent: p.folder || 'folder not shared', title: p.folder || '' }),
      p.folder ? el('span', { className: 'acts' },
        el('button', { textContent: 'Copy cd', title: cdCmd(p.folder, os), onclick: () => copy(cdCmd(p.folder, os), 'cd command') }),
        run.length ? el('button', { textContent: 'Copy run', title: chain([cdCmd(p.folder, os), ...run], os), onclick: () => copy(chain([cdCmd(p.folder, os), ...run], os), 'Run command') }) : null) : null);
  }));
}
$('r-invite').onclick = async () => {
  try { await navigator.clipboard.writeText(S.room.invite); $('r-invite').textContent = 'Copied!'; toast('Invite link copied. Send it to a friend.', true); }
  catch { prompt('Send this link to your friend:', S.room.invite); }
  setTimeout(() => { $('r-invite').textContent = 'Copy invite link'; }, 1500);
};
$('r-leave').onclick = async () => { if (confirm('Leave this room? Your files stay in the folder.')) await api('leave'); };

function agentsView() {
  const mine = new Set(S.mine.map(a => a.id));
  $('a-list').replaceChildren(...(S.agents.length ? S.agents.map(a => el('li', {
    className: `${a.status === 'working' ? 'working' : ''}${follow === a.name ? ' following' : ''}`, tabIndex: 0, title: follow === a.name ? 'Stop following' : `Follow ${a.name}'s edits in the code view`,
    onclick: e => e.target.closest('button,select,input,label') || (follow === a.name ? stopFollow() : startFollow(a.name)),
    onkeydown: e => e.key === 'Enter' && e.target === e.currentTarget && e.currentTarget.click() },
    avatar(a.name, a.color),
    el('span', {}, el('span', { className: 'nm', textContent: a.name }), ' ',
      el('span', { className: 'pill', textContent: [a.cli, a.model, a.effort].filter(Boolean).join(' · ') })),
    mine.has(a.id) ? el('span', { className: 'acts' },
      a.status === 'working' ? el('button', { textContent: 'stop', onclick: () => api('stopAgent', { id: a.id }).catch(err => toast(err.message)) }) : null,
      el('button', { textContent: '✕', title: 'Remove', onclick: () => confirm(`Remove ${a.name}?`) && api('removeAgent', { id: a.id }).then(() => toast(`Removed ${a.name}`, true), err => toast(err.message)) })) : el('span'),
    mine.has(a.id) && hasModels(a.cli) && M ? mxRow(a) : null,
    mine.has(a.id) ? accessRow(a) : null,
    el('span', { className: 'sub', textContent: `${a.owner}'s computer · ${a.status === 'working' ? (a.doing || 'working') : 'idle'}${a.claims?.length ? ` · ✎ ${a.claims.join(', ')}` : ''}` }),
  )) : [el('li', { className: 'sub', textContent: 'No agents yet. Add an agent, then @mention it in the Hive.' })]));
  const working = S.agents.filter(a => a.status === 'working');
  $('typing').replaceChildren(...working.map((a, i) => el('span', { textContent: `${i ? ', ' : ''}${a.name} is working` })));
}
// Full access = the agent's CLI runs with no permission checks on this computer. Off by default; confirm before turning on.
const fullWarn = n => `Give ${n} full access?\n\n${n} will run any command on this computer with no permission prompts: tests, scripts, installs. `
  + `That includes code your room-mates synced into the folder, and anything someone in the room asks ${n} to do with an @mention.\n\nOnly do this in rooms with people you trust.`;
// A labeled switch on each of my agents: "Use my computer (commands & tests)".
function accessRow(a) {
  const on = !!S.access?.[a.id];
  const box = el('input', { type: 'checkbox', checked: on });
  box.onchange = () => {
    if (box.checked && !confirm(fullWarn(a.name))) return void (box.checked = false);
    api('setAgent', { id: a.id, fullAccess: box.checked }).catch(err => { box.checked = on; toast(err.message); });
  };
  return el('label', { className: on ? 'access on' : 'access', title: on ? 'Can run any command on this computer with no prompts.' : 'Edits files only; cannot run commands or tests.' },
    box, on ? 'Uses my computer: commands & tests ON' : 'Use my computer (commands & tests): off');
}
// Switch one of my agents' model/effort; applies from its next turn.
function mxRow(a) {
  const ms = el('select', { title: 'Model' }, ...modelOpts(a.cli, a.model)), es = el('select', { title: 'Effort' }, ...effortOpts(a.cli, a.model));
  ms.value = a.model ?? ''; es.value = a.effort ?? '';
  if (es.value !== (a.effort ?? '')) es.append(opt(a.effort, a.effort)), es.value = a.effort;
  const save = model => api('setAgent', { id: a.id, model, effort: es.value }).catch(err => toast(err.message));
  ms.onchange = () => {
    if (ms.value === '__other') { const id = prompt('Exact model id:'); return id ? save(id.trim()) : (ms.value = a.model ?? ''); }
    save(ms.value);
  };
  es.onchange = () => save(ms.value);
  return el('span', { className: 'mxrow' }, ms, es);
}
const cliSel = $('a-cli');
$('a-add-btn').onclick = async () => {
  cliSel.replaceChildren(...[...Object.keys(S.presets), 'custom'].map(k => el('option', { value: k, textContent: k === 'custom' ? 'custom command…' : k })));
  $('a-form').hidden = false; $('a-form').name.focus();
  await loadModels(); cliSel.onchange();
};
function syncEffort() {
  const cli = cliSel.value, model = $('a-model').value;
  $('a-model-other').hidden = model !== '__other';
  $('a-effort').replaceChildren(...effortOpts(cli, model === '__other' ? '' : model));
  const c = M?.codex, w = $('a-mwarn');
  w.hidden = !(cli === 'codex' && !model && c?.configModelMissing);
  w.textContent = w.hidden ? '' : `Your Codex config default "${c.configModel}" is not in your account's model list, so Codex may refuse it. Pick a model.`;
}
cliSel.onchange = () => {
  const cli = cliSel.value;
  $('a-cmd').hidden = cli !== 'custom'; $('a-cmd').required = cli === 'custom';
  $('a-mx').hidden = !hasModels(cli);
  if (hasModels(cli)) { $('a-model').replaceChildren(...modelOpts(cli)); syncEffort(); }
};
$('a-model').onchange = syncEffort;
$('a-cancel').onclick = () => { $('a-form').hidden = true; };
$('a-form').onkeydown = e => { if (e.key === 'Escape') { $('a-form').hidden = true; $('a-add-btn').focus(); } };
$('a-form').onsubmit = async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  if (f.model === '__other') f.model = f.modelOther.trim();
  delete f.modelOther;
  f.fullAccess = f.fullAccess === 'on';
  if (f.fullAccess && !confirm(fullWarn(f.name || 'this agent'))) return;
  const btn = e.target.querySelector('button:not([type])');
  btn.disabled = true;
  try { await api('addAgent', f); e.target.reset(); e.target.hidden = true; $('a-cmd').hidden = true; toast(`Added ${f.name}. Say @${f.name} in the Hive.`, true); }
  catch (err) { toast(err.message); }
  btn.disabled = false;
};

// Recipients: any mix of agents and people. Sending prepends "@A @B " (the hub wakes every @mentioned agent).
const to = new Set();
const names = () => [...new Set([...S.agents.map(a => a.name), ...(S.agents.length > 1 ? ['all'] : []), ...S.peers.map(p => p.name).filter(n => n && n !== S.me?.name)])];
const toLabel = () => { $('say-to').querySelector('summary').textContent = to.size ? [...to].map(n => '@' + n).join(', ') : 'Everyone'; };
function toOptions() {
  const all = names();
  for (const n of to) if (!all.includes(n)) to.delete(n);
  $('say-to-list').replaceChildren(el('label', {}, el('input', { type: 'checkbox', checked: !to.size, onchange: () => { to.clear(); toOptions(); } }), 'Everyone'),
    ...all.map(n => {
      const c = el('input', { type: 'checkbox', checked: to.has(n), onchange: () => { c.checked ? to.add(n) : to.delete(n); toOptions(); } });
      return el('label', {}, c, `@${n}`);
    }));
  toLabel();
}
document.addEventListener('click', e => { if (!e.composedPath().includes($('say-to'))) $('say-to').open = false; }); // path survives the list re-render
$('say').onsubmit = async e => {
  e.preventDefault();
  const t = $('say-text');
  if (!t.value.trim()) return;
  const text = [...to].filter(n => !t.value.includes('@' + n)).map(n => `@${n} `).join('') + t.value.trim();
  t.value = '';
  await api('say', { text }).catch(err => toast(err.message));
};
// "@" autocomplete in the composer.
const mention = $('mention');
let mIdx = 0;
function mentionView() {
  const t = $('say-text'), m = /@([\w-]*)$/.exec(t.value.slice(0, t.selectionStart));
  const hits = m ? names().filter(n => n.toLowerCase().startsWith(m[1].toLowerCase())).slice(0, 8) : [];
  mention.hidden = !hits.length;
  mIdx = Math.max(0, Math.min(mIdx, hits.length - 1));
  mention.replaceChildren(...hits.map((n, i) => el('li', { role: 'option', className: i === mIdx ? 'on' : '', textContent: '@' + n, onmousedown: e => { e.preventDefault(); pickMention(n); } })));
}
function pickMention(n) {
  const t = $('say-text'), at = t.selectionStart, head = t.value.slice(0, at).replace(/@[\w-]*$/, `@${n} `);
  t.value = head + t.value.slice(at);
  t.selectionStart = t.selectionEnd = head.length;
  mention.hidden = true;
}
$('say-text').oninput = () => { mIdx = 0; mentionView(); };
$('say-text').onblur = () => { mention.hidden = true; };
$('say-text').onkeydown = e => {
  const items = mention.children;
  if (!mention.hidden && items.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mIdx = (mIdx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; return mentionView(); }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickMention(items[mIdx].textContent.slice(1)); }
    if (e.key === 'Escape') { e.preventDefault(); mention.hidden = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('say').requestSubmit(); }
};

// ---------------- feed ----------------
const fmtTime = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// Tool line "Verb some/path" -> [verb, known file path or undefined, raw rest].
function toolPath(ev) {
  const m = /^(\S+)\s+(.*)$/.exec(ev.text);
  return m ? [m[1], S.files.find(f => m[2] === f || m[2].endsWith('/' + f)), m[2]] : [ev.text];
}
// Agent text with "PLAN:" / "CLAIM:" lines shown as labelled badges.
function agentText(text) {
  const tx = el('div', { className: 'tx' });
  let tag = true;
  for (const l of text.split('\n')) {
    const m = /^\s*(PLAN|CLAIM):\s*(.*)$/i.exec(l);
    if (m) tx.append(el('div', { className: 'tag' }, el('span', { className: 'badge', textContent: m[1].toUpperCase() }), m[2]));
    else tx.append((tag ? '' : '\n') + l);
    tag = !!m;
  }
  return tx;
}
// Make an agent's avatar/name in the Hive start following it.
const followable = (n, name) => Object.assign(n, { title: `Follow ${name}'s edits`, onclick: () => startFollow(name), className: n.className + ' who' });
function evNode(ev) {
  if (ev.kind === 'note' || ev.kind === 'error' || ev.kind === 'tool') {
    const tx = el('p', { className: 'tx' });
    if (ev.kind === 'tool') {
      const [verb, path, rest] = toolPath(ev);
      tx.append(`${ev.from} · ${verb} `, path ? el('a', { textContent: path, onclick: () => pick(path) }) : (rest ?? ''));
    } else tx.textContent = ev.kind === 'error' ? `${ev.from}: ${ev.text}` : ev.text;
    return el('li', { className: `ev ${ev.kind}` }, tx);
  }
  const isAgent = ev.fromKind === 'agent', av = avatar(ev.from, ev.color), nm = el('b', { textContent: ev.from });
  if (isAgent) followable(av, ev.from), followable(nm, ev.from);
  return el('li', { className: `ev ${isAgent ? 'agent' : 'human'}${isAgent && ev.to?.length ? ' x2a' : ''}` },
    av,
    el('div', {},
      el('div', { className: 'hd' }, nm, isAgent ? el('span', { className: 'pill', textContent: 'agent' }) : null,
        ev.to?.length ? el('span', { className: 'to', textContent: `→ ${ev.to.map(n => '@' + n).join(', ')}` }) : null,
        el('time', { textContent: fmtTime(ev.at) })),
      isAgent ? agentText(ev.text) : el('div', { className: 'tx', textContent: ev.text })));
}
function addEv(ev) {
  const f = $('feed'), stick = f.scrollHeight - f.scrollTop - f.clientHeight < 80;
  f.append(evNode(ev));
  while (f.children.length > 400) f.firstChild.remove();
  if (stick) f.scrollTop = f.scrollHeight;
}
const renderFeed = () => { $('feed').replaceChildren(); S.feed.forEach(addEv); $('feed').scrollTop = $('feed').scrollHeight; };

// ---------------- files ----------------
const openDirs = new Set(JSON.parse(store.get('openDirs') || '[]'));
function filesView() {
  $('f-count').textContent = S.files.length ? `${S.files.length}` : '';
  const tree = {};
  for (const p of [...S.files].sort()) { let n = tree; const parts = p.split('/'); parts.slice(0, -1).forEach(d => { n = n[d + '/'] ??= {}; }); n[parts.at(-1)] = p; }
  const build = (node, depth, prefix) => Object.keys(node).sort((a, b) => (b.endsWith('/') - a.endsWith('/')) || a.localeCompare(b)).map(k => {
    if (!k.endsWith('/')) {
      const p = node[k];
      return el('div', { className: `f${p === openPath ? ' sel' : ''}`, style: `--d:${depth}`, onclick: () => pick(p), title: p },
        recent.has(p) ? el('span', { className: 'dot', style: `--c:${recent.get(p)}` }) : null, k);
    }
    const dir = prefix + k, d = el('details', { open: openDirs.has(dir) || depth === 0 && S.files.length < 40 });
    d.ontoggle = () => { d.open ? openDirs.add(dir) : openDirs.delete(dir); store.set('openDirs', JSON.stringify([...openDirs])); };
    d.append(el('summary', { style: `--d:${depth}`, textContent: k.slice(0, -1) }), ...build(node[k], depth + 1, dir));
    return d;
  });
  $('f-tree').replaceChildren(...(S.files.length ? build(tree, 0, '') : [el('p', { className: 'empty', textContent: 'No files yet.' })]));
}
// ---------------- code view: VS Code colors, live line diff, follow an agent ----------------
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
// Highlight the whole file (so multi-line strings/comments color right), then split per line, re-opening spans that cross a break.
function hlLines(text, path) {
  const lang = /\.([^./]+)$/.exec(path)?.[1].toLowerCase();
  if (!lang || !hljs.getLanguage(lang) || text.length > 200e3) return text.split('\n').map(esc);
  const open = [];
  return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value.split('\n').map(l => {
    const pre = open.join('');
    for (const [t] of l.matchAll(/<span[^>]*>|<\/span>/g)) t[1] === '/' ? open.pop() : open.push(t);
    return pre + l + '</span>'.repeat(open.length);
  });
}
// Line diff old -> new as [op, index] with op ' ' (keep new[i]), '-' (old[i]), '+' (new[i]). null = too big, replace everything.
function diff(a, b) {
  let s = 0, ea = a.length, eb = b.length;
  while (s < ea && s < eb && a[s] === b[s]) s++;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) ea--, eb--;
  const n = ea - s, m = eb - s;
  // ponytail: O(n*m) LCS table on the changed middle; above ~2000x2000 changed lines we skip the animation and redraw. Myers if that bites.
  if (n * m > 4e6) return null;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[s + i] === b[s + j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  for (let k = 0; k < s; k++) ops.push([' ', k]);
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && a[s + i] === b[s + j]) ops.push([' ', s + j]), i++, j++;
    else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) ops.push(['-', s + i++]);
    else ops.push(['+', s + j++]);
  }
  for (let k = eb; k < b.length; k++) ops.push([' ', k]);
  return ops;
}
let openSeq = 0;
async function openFile(path, color) {
  const seq = ++openSeq, switching = path !== openPath;
  openPath = path;
  $('c-path').textContent = path;
  if (switching) $('c-by').textContent = '';
  const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
  const j = await r.json().catch(() => ({}));
  if (seq !== openSeq) return; // a newer open/edit won
  const body = $('c-body');
  if (!r.ok || j.binary) { openLines = openHtml = []; body.replaceChildren(el('p', { className: 'empty', textContent: j.binary ? `Binary file (${j.size} bytes)` : 'File was deleted.' })); return filesView(); }
  const lines = j.text.split('\n'), html = hlLines(j.text, path), live = !switching && color;
  const ops = live && !reduce.matches ? diff(openLines, lines) : null;
  const line = (h, cls = '') => { const n = el('span', { className: `ln ${cls}` }); n.innerHTML = h; return n; }; // h is escaped (esc or hljs)
  let pend = 0; // deleted lines waiting to pair with inserts: those inserts are "changed" lines
  const nodes = ops ? ops.map(([op, k]) => op === '-' ? (pend++, line(openHtml[k], 'del'))
    : op === '+' ? line(html[k], pend > 0 ? (pend--, 'hot') : 'ins') : (pend = 0, line(html[k])))
    : html.map((h, k) => line(h, live && lines[k] !== openLines[k] ? 'hot' : ''));
  if (color) body.style.setProperty('--c', color);
  body.replaceChildren(...nodes);
  openLines = lines; openHtml = html;
  const first = body.querySelector('.hot,.ins,.del');
  if (first) {
    first.scrollIntoView({ block: 'center', behavior: reduce.matches ? 'auto' : 'smooth' });
    setTimeout(() => body.querySelectorAll('.hot').forEach(n => n.classList.remove('hot')), 200);
    setTimeout(() => body.querySelectorAll('.del').forEach(n => n.remove()), 900);
  }
  filesView();
}
function startFollow(name) {
  follow = name; followView();
  let p = lastEdit.get(name);
  for (let i = S.feed.length - 1; !p && i >= 0; i--) if (S.feed[i].kind === 'tool' && S.feed[i].from === name) p = toolPath(S.feed[i])[1];
  if (p) openFile(p); else toast(`Following ${name}. Its next edit opens here.`, true);
}
function stopFollow() { follow = null; followView(); }
function followView() {
  $('c-follow').hidden = !follow;
  $('c-follow-nm').textContent = follow ? `Following @${follow}` : '';
  if (S?.room) agentsView();
}
$('c-unfollow').onclick = stopFollow;
const pick = p => { if (follow) stopFollow(); openFile(p); }; // a manual pick ends follow

// ---------------- live connection to this computer's Murmur ----------------
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'state') {
      const was = S;
      S = m;
      if (was?.room?.invite !== S.room?.invite) { // another room: drop the old room's view state
        openPath = null; openLines = openHtml = []; recent.clear(); lastEdit.clear(); follow = null;
        $('c-path').textContent = 'No file open'; $('c-by').textContent = ''; $('c-follow').hidden = true;
        $('c-body').replaceChildren(el('p', { className: 'empty', textContent: 'Pick a file on the left. It updates live as people and agents edit it.' }));
        $('feed').replaceChildren();
      }
      if (!S.room) return home();
      if (!M) loadModels().then(() => S.room && agentsView());
      room();
      if (!was || was.feed.length !== S.feed.length || was.feed.at(-1)?.id !== S.feed.at(-1)?.id) renderFeed();
    } else if (!S?.room) return;
    else if (m.t === 'feed') {
      S.feed.push(m.ev); addEv(m.ev);
      if (follow && m.ev.kind === 'tool' && m.ev.from === follow) { const [verb, p] = toolPath(m.ev); if (p && p !== openPath && /edit|write/i.test(verb)) openFile(p); }
    }
    else if (m.t === 'presence') { S.peers = m.peers; S.agents = m.agents; if (S.room && m.maxHops !== undefined) S.room.maxHops = m.maxHops; room(); }
    else if (m.t === 'files') { S.files = m.paths; filesView(); }
    else if (m.t === 'file') {
      recent.set(m.path, m.color || '#7c9cff');
      setTimeout(() => { recent.delete(m.path); filesView(); }, 6000);
      if (m.by) lastEdit.set(m.by, m.path);
      if (follow && m.by === follow && m.path !== openPath && !m.deleted) openFile(m.path);
      else if (m.path === openPath) openFile(m.path, m.color || '#7c9cff'); else filesView();
      if (m.path === openPath) $('c-by').textContent = `edited by ${m.by}`;
    }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
connect();
