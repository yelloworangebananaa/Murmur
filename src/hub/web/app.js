// Murmur web UI. Vanilla ES module, no build. All server/agent text is untrusted:
// it only ever reaches the DOM through textContent (via h()), never as HTML.
import { dotMatrix, particleDrift, tornado } from '/fx.js';

const $main = document.getElementById('main');
const $nav = document.getElementById('nav');
const $toast = document.getElementById('toast');
const E = encodeURIComponent;

let me = null;          // GET /api/me
let gen = 0;            // render generation, drops stale async renders
let cache = new Map();  // DOM that survives re-renders within one route (lane consoles, drafts)
const keep = (k, make) => { if (!cache.has(k)) cache.set(k, make()); return cache.get(k); };

// Field access tolerant of camelCase or snake_case payloads.
const v = (o, k) => o?.[k] ?? o?.[k.replace(/[A-Z]/g, c => '_' + c.toLowerCase())];
const arr = (x, k) => (Array.isArray(x) ? x : x?.[k] ?? []);
const short = id => String(id ?? '').slice(0, 6);
const when = t => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const caps = a => { const c = v(a, 'capabilities') ?? v(a, 'capabilitiesJson'); try { return Array.isArray(c) ? c : JSON.parse(c || '[]'); } catch { return []; } };
const paths = o => { const p = v(o, 'paths') ?? v(o, 'pathsJson'); try { return Array.isArray(p) ? p : JSON.parse(p || '[]'); } catch { return []; } };

// ---------- DOM builder ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  for (const [k, val] of Object.entries(attrs || {})) {
    if (val == null || val === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), val);
    else if (k === 'value' || k === 'checked' || k === 'open') el[k] = val;
    else el.setAttribute(k, val === true ? '' : String(val));
  }
  return el;
}

function flash(msg, ok) {
  $toast.replaceChildren(h('div', { class: ok ? 'toast ok' : 'toast' }, msg));
  clearTimeout(flash.t);
  flash.t = setTimeout(() => $toast.replaceChildren(), 4500);
}

// Wrap an event handler: errors become a toast, then re-render.
const act = fn => async (...a) => {
  try { await fn(...a); } catch (er) { flash(er.message); }
  show();
};

// ---------- API ----------
async function api(method, path, body, quiet) {
  const init = { method, credentials: 'same-origin', headers: { 'x-murmur-csrf': '1' } };
  if (method !== 'GET') { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body ?? {}); }
  const r = await fetch(path, init);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !quiet) {
    me = null;
    if (!/^#?\/?((login|setup)?(\?|$))/.test(location.hash)) try { sessionStorage.setItem('next', location.hash); } catch {}
    go('#/'); // the landing page handles both first-run setup and login
  }
  if (!r.ok) throw Object.assign(new Error(data.error || `${r.status} ${r.statusText}`), { status: r.status, data });
  return data;
}

// ---------- forms ----------
// fields: {n: name, p: placeholder, t?: type | 'textarea', sel?: [options], v?: default, req?: bool}
function form(fields, submit, label = 'Save', cls = 'row-form') {
  const f = h('form', {
    class: cls,
    onsubmit: async e => {
      e.preventDefault();
      const b = f.querySelector('button[type=submit]');
      b.disabled = true;
      try { await submit(Object.fromEntries([...new FormData(f)].filter(([, x]) => x !== '')), f); }
      catch (er) { flash(er.message); }
      finally { b.disabled = false; }
    },
  },
  fields.map(o => o.sel
    ? h('select', { name: o.n, 'aria-label': o.p, title: o.p, value: o.v }, o.sel.map(x => Array.isArray(x) ? h('option', { value: x[0] }, x[1]) : h('option', { value: x }, x)))
    : o.t === 'textarea'
      ? h('textarea', { name: o.n, placeholder: o.p, 'aria-label': o.p, required: o.req, rows: 3 })
      : h('input', { name: o.n, placeholder: o.p, 'aria-label': o.p, type: o.t || 'text', required: o.req, value: o.v, autocomplete: o.ac })),
  h('button', { type: 'submit' }, label));
  return f;
}

// ---------- router ----------
const go = to => { if (location.hash === to) show(); else location.hash = to; };
const PUBLIC = /^\/((setup|login)?$|invite\/)/;
const routes = [
  [/^\/(?:setup|login)?$/, viewHome], // old #/setup and #/login links land on the same page
  [/^\/invite\/([^/]+)$/, viewInvite],
  [/^\/device(?:\/([^/]+))?$/, viewDevice],
  [/^\/w\/([^/]+)$/, viewDash],
  [/^\/w\/([^/]+)\/s\/([^/]+)$/, viewRoom],
  [/^\/w\/([^/]+)\/board$/, viewBoard],
  [/^\/w\/([^/]+)\/memory$/, viewMemory],
  [/^\/w\/([^/]+)\/people$/, viewPeople],
];

async function show() {
  const my = ++gen;
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const wid = path.match(/^\/w\/([^/]+)/)?.[1];
  const then = new URLSearchParams(qs).get('then');
  if (then && /^\/[A-Za-z0-9/_-]*$/.test(then)) try { sessionStorage.setItem('next', '#' + then); } catch {}
  try {
    if (!PUBLIC.test(path) && !me) me = await api('GET', '/api/me');
    const hit = routes.find(([re]) => re.test(path));
    if (!hit) return go('#/');
    const node = await hit[1](...path.match(hit[0]).slice(1).map(x => x && decodeURIComponent(x)), new URLSearchParams(qs));
    if (my !== gen) return;
    renderNav(wid && decodeURIComponent(wid));
    connect(wid ? decodeURIComponent(wid) : null);
    backdrop(node.dataset?.fx || 'dots');
    $main.replaceChildren(node);
  } catch (er) {
    if (my === gen && er.status !== 401) $main.replaceChildren(h('p', { class: 'err' }, er.message));
  }
}
// One backdrop effect per page; a view picks it with data-fx on its root node (default dots).
// The canvas is only swapped when the effect changes, so re-renders keep the running one.
const FX = { dots: dotMatrix, drift: particleDrift, tornado };
let fxKind = null;
function backdrop(kind) {
  if (kind === fxKind) return;
  fxKind = kind;
  const c = h('canvas', { id: 'bg', class: 'fx', 'aria-hidden': 'true' });
  document.getElementById('bg').replaceWith(c); // the old effect frees itself once detached
  FX[kind](c);
}

let refreshT;
const refresh = () => { clearTimeout(refreshT); refreshT = setTimeout(show, 200); };
addEventListener('hashchange', () => { cache = new Map(); show(); });

function renderNav(wid) {
  if (!me) return $nav.replaceChildren(h('b', { class: 'brand' }, 'Murmur'));
  const wss = arr(me, 'workspaces');
  const link = (href, label) => h('a', { href, class: location.hash === href ? 'on' : null }, label);
  // replaceChildren would stringify the falsy `x && el` holes, so drop them first.
  $nav.replaceChildren(...[
    h('a', { class: 'brand', href: '#/' }, 'Murmur'),
    h('select', { 'aria-label': 'Workspace', value: wid ?? '', onchange: e => go(e.target.value ? `#/w/${E(e.target.value)}` : '#/') },
      h('option', { value: '' }, 'Workspaces…'), wss.map(w => h('option', { value: w.id }, `${w.name} (${w.role})`))),
    wid && [link(`#/w/${E(wid)}`, 'Sessions'), link(`#/w/${E(wid)}/board`, 'Board'), link(`#/w/${E(wid)}/memory`, 'Memory'), link(`#/w/${E(wid)}/people`, 'People')],
    h('span', { class: 'grow' }),
    wid && h('span', { class: 'live ' + (sock?.readyState === 1 ? 'up' : 'down'), title: 'Live connection' }, sock?.readyState === 1 ? 'live' : 'offline'),
    'Notification' in window && Notification.permission === 'default' &&
      h('button', { class: 'ghost', onclick: () => Notification.requestPermission().then(() => renderNav(wid)) }, 'Enable alerts'),
    h('span', { class: 'muted' }, v(me, 'user')?.name),
    h('button', { class: 'ghost', onclick: act(async () => { await api('POST', '/api/logout'); me = null; connect(null); go('#/'); }) }, 'Log out'),
  ].flat().filter(k => k != null && k !== false));
}

// ---------- WS client (one per open workspace) ----------
let sock = null, sockWs = null, retry = 0;
const lastSeq = {};

function connect(wid) {
  if (wid === sockWs) return;
  if (sock) { const s = sock; sock = null; s.close(); }
  sockWs = wid; retry = 0;
  if (wid) open();
}

function open() {
  const wid = sockWs;
  // ponytail: since=0 on first load replays the workspace's whole event log; hub should cap it.
  const s = sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/ui?workspace=${E(wid)}&since=${lastSeq[wid] || 0}`);
  s.onopen = () => { retry = 0; renderNav(wid); };
  s.onmessage = m => {
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.seq) lastSeq[wid] = Math.max(lastSeq[wid] || 0, ev.seq);
    onEvent(ev);
  };
  s.onclose = () => {
    if (sock !== s) return;
    renderNav(wid);
    setTimeout(() => { if (sock === s) open(); }, Math.min(15000, 500 * 2 ** retry++) + Math.random() * 300);
  };
}

function onEvent(ev) {
  if (ev.type === 'lane.events') {
    // ponytail: replayed ring-buffer events are skipped; the room loads history via /events?tail. Gap possible across a reconnect.
    if (ev.replay) return;
    const st = cache.get('lane:' + ev.laneId);
    if (st) for (const e of arr(ev.d, 'batch')) feed(st, e);
    return;
  }
  if (ev.type === 'approval.requested') notify(ev.d);
  if (ev.type === 'computer.linked' && v(ev.d, 'userId') === myId() && Date.now() - (ev.at ?? 0) < 60000) {
    const d = ev.d;
    flash(d.ok ? `Ready on ${v(d, 'deviceName')}` : `Setup on ${v(d, 'deviceName')} failed: ${d.error}`, d.ok);
  }
  refresh();
}

function notify(a) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !a) return;
  const t = v(a, 'createdAt');
  if (t && Date.now() - t > 60000) return; // replayed old event
  new Notification('Murmur: approval needed', { body: `${a.tool ?? ''}: ${a.target ?? ''}`.slice(0, 200), tag: String(a.id) });
}

// ---------- auth views ----------
const auth = card => h('div', { class: 'auth', 'data-fx': 'drift' }, card);
const authCard = (eyebrow, ...kids) => h('div', { class: 'auth-card' }, h('p', { class: 'eyebrow' }, eyebrow), ...kids);

const takeNext = () => { let n = null; try { n = sessionStorage.getItem('next'); sessionStorage.removeItem('next'); } catch {} return n; };
function afterLogin() {
  me = null;
  go(takeNext() || '#/');
}

// The front door: tornado backdrop, a Log in button, and whichever form this hub needs right now.
async function viewLanding(q) {
  const s = await api('GET', '/api/setup', undefined, true);
  const card = s.needed
    ? authCard('First run', h('h2', {}, 'Create the owner account'),
      h('p', { class: 'muted' }, q.get('code') ? 'Pick your name and password. You are the owner of this team.' : 'Paste the one-time setup code printed in the terminal running Murmur.'),
      form([{ n: 'code', p: 'Setup code', req: true, v: q.get('code') || '', ac: 'one-time-code', t: q.get('code') ? 'hidden' : 'text' }, { n: 'name', p: 'Name', req: true, ac: 'username' }, { n: 'password', p: 'Password (8+ characters)', t: 'password', req: true, ac: 'new-password' }],
        async d => { await api('POST', '/api/setup', d); afterLogin(); }, 'Create account', 'stack'))
    : authCard('Log in', h('h2', {}, 'Welcome back'), h('p', { class: 'muted' }, 'Log in to your team.'),
      form([{ n: 'name', p: 'Name', req: true, ac: 'username' }, { n: 'password', p: 'Password', t: 'password', req: true, ac: 'current-password' }],
        async d => { await api('POST', '/api/login', d); afterLogin(); }, 'Log in', 'stack'));
  const slot = h('div', { class: 'landing-slot' });
  const openCard = () => { slot.replaceChildren(card); cta.remove(); card.querySelector('input:not([type=hidden])')?.focus(); };
  const cta = h('div', { class: 'cta' }, h('button', { class: 'big', onclick: openCard }, s.needed ? 'Get started' : 'Log in'),
    h('span', { class: 'muted' }, s.needed ? 'Takes a minute.' : 'Got an invite link? Just open it.'));
  let pending = null; try { pending = sessionStorage.getItem('next'); } catch {}
  if (q.get('code') || pending) queueMicrotask(openCard); // arrived mid-flow: skip the button
  return h('div', { class: 'landing', 'data-fx': 'tornado' },
    h('div', { class: 'landing-copy' },
      h('p', { class: 'eyebrow' }, 'Murmur'),
      h('h1', {}, 'Every Claude on your team, in one room.'),
      h('p', { class: 'muted lede' }, 'Your agents share one plan, see each other\'s work, message each other and hand work off, while you approve what matters.'),
      h('ol', { class: 'steps' },
        h('li', {}, h('b', {}, s.needed ? 'Create your account' : 'Log in'), h('span', { class: 'muted' }, ' here')),
        h('li', {}, h('b', {}, 'Connect your computer'), h('span', { class: 'muted' }, ' with one click')),
        h('li', {}, h('b', {}, 'Invite your team'), h('span', { class: 'muted' }, ' with a link'))),
      cta),
    slot);
}

async function viewInvite(token) {
  const inv = await api('GET', `/api/invites/${E(token)}`, undefined, true);
  const cur = await api('GET', '/api/me', undefined, true).catch(() => null);
  const accept = async d => {
    const r = await api('POST', `/api/invites/${E(token)}/accept`, d);
    me = null;
    const w = v(r, 'workspaceId') ?? r.workspace?.id;
    go(takeNext() || (w ? `#/w/${E(w)}` : '#/'));
  };
  const logIn = () => { try { sessionStorage.setItem('next', location.hash.split('?')[0]); } catch {} go('#/login'); };
  return auth(authCard('Invitation',
    h('h2', {}, 'Join ', v(inv, 'workspaceName')),
    h('p', { class: 'muted' }, `You're invited as ${inv.role}. Pick a name and password to join.`),
    cur?.user
      ? h('div', { class: 'btns' }, h('button', { class: 'big', onclick: () => accept({}).catch(e => flash(e.message)) }, `Join as ${cur.user.name}`))
      : [form([{ n: 'name', p: 'Name', req: true, ac: 'username' }, { n: 'password', p: 'Password (8+ characters)', t: 'password', req: true, ac: 'new-password' }], accept, 'Join the team', 'stack'),
        h('p', { class: 'muted' }, 'Already have an account here? ', h('a', { href: '#/login', onclick: e => { e.preventDefault(); logIn(); } }, 'Log in'), ' first.')]));
}

// Opened by Murmur on the computer being connected; one click pairs it with this account.
async function viewDevice(code, q) {
  code = code || q.get('code') || '';
  const info = code ? await api('GET', `/api/device/lookup/${E(code)}`).catch(e => (e.status === 401 ? Promise.reject(e) : { error: e.message })) : { error: 'no code' };
  const box = authCard('Connect a computer');
  const done = (title, text) => box.replaceChildren(h('p', { class: 'eyebrow' }, 'Connect a computer'), h('h2', {}, title), h('p', { class: 'muted' }, text));
  if (info.error) done('This link has expired', 'Restart Murmur on that computer and it will open a fresh one.');
  else if (info.used) done('Already connected', `${info.name} is connected to your account.`);
  else box.append(
    h('h2', {}, `Connect ${info.name}?`),
    h('p', { class: 'muted' }, 'Murmur will run your Claude Code sessions on this computer. Only connect a computer where you just started Murmur.'),
    h('div', { class: 'btns' }, h('button', {
      class: 'big',
      onclick: async e => {
        e.target.disabled = true;
        try {
          await api('POST', '/api/device/approve', { userCode: code });
          done('Connected', `${info.name} is ready. Taking you back…`);
          setTimeout(() => go(takeNext() || '#/'), 1200);
        } catch (er) { e.target.disabled = false; flash(er.message); }
      },
    }, 'Connect this computer')),
    h('p', { class: 'muted mono' }, `Code ${code}`));
  return auth(box);
}

// ---------- workspaces ----------
async function viewHome(q) {
  me ??= await api('GET', '/api/me', undefined, true).catch(() => null);
  if (!me) return viewLanding(q);
  const wss = arr(me, 'workspaces');
  const devs = arr(await api('GET', '/api/devices'), 'devices').filter(d => !v(d, 'revokedAt'));
  const step = (done, title, ...body) => h('li', { class: done ? 'step done' : 'step' }, h('b', {}, title), ...body);
  return h('div', { class: 'home', 'data-fx': 'drift' },
    h('header', { class: 'pagehead' }, h('p', { class: 'eyebrow' }, 'Murmur hub'), h('h2', {}, `Welcome, ${v(me, 'user')?.name ?? ''}`)),
    (!wss.length || !devs.length) && h('section', { class: 'panel' }, h('h3', {}, 'Get started'), h('ol', { class: 'steps' },
      step(devs.length > 0, 'Connect your computer', h('p', { class: 'muted' }, 'Start Murmur on the computer that has Claude Code. It opens a page here; click Connect.')),
      step(wss.length > 0, 'Create a workspace', h('p', { class: 'muted' }, 'One per repository: give it a name and the repository address (the URL you would clone).')),
      step(false, 'Invite your team', h('p', { class: 'muted' }, 'Open the workspace and click Invite people. Send the link; they click it and they are in.')))),
    devs.length > 0 && h('p', { class: 'muted' }, 'Your computers: ', devs.map(d => h('span', { class: 'dev' }, dot(d.online ? 'idle' : 'stopped'), d.name, d.online ? '' : ' (offline)'))),
    h('h3', {}, `Workspaces (${wss.length})`),
    wss.length ? h('div', { class: 'grid' }, wss.map(w => h('a', { class: 'scard wcard', href: `#/w/${E(w.id)}` }, h('span', { class: 'title' }, w.name), h('span', { class: 'badge' }, w.role))))
      : h('p', { class: 'muted' }, 'No workspaces yet.'),
    h('section', { class: 'panel' }, h('h3', {}, 'New workspace'), form([{ n: 'name', p: 'Name', req: true }, { n: 'gitRemote', p: 'Repository URL, e.g. https://github.com/you/app', req: true }],
      async d => { const r = await api('POST', '/api/workspaces', d); me = null; go(`#/w/${E(r.id ?? r.workspace?.id)}`); }, 'Create')));
}

const wsName = wid => arr(me, 'workspaces').find(w => w.id === wid)?.name ?? 'Workspace';
const pagehead = (wid, title) => h('header', { class: 'pagehead' }, h('p', { class: 'eyebrow' }, wsName(wid)), h('h2', {}, title));
const roleIn = wid => arr(me, 'workspaces').find(w => w.id === wid)?.role;
const myId = () => v(me, 'user')?.id;
const ownerName = l => v(l, 'ownerName') ?? v(l, 'owner')?.name ?? short(v(l, 'ownerUserId'));
const dot = s => h('span', { class: 'dot s-' + s, title: s, 'aria-label': s });
const MODES = ['plan', 'request', 'allow', 'full'];

function approvalsStrip(list, lanes) {
  if (!list.length) return null;
  const decide = (a, decision, scope) => act(async () => {
    try { await api('POST', `/api/approvals/${E(a.id)}/decide`, { decision, scope }); }
    catch (e) { if (e.status === 409) flash('Already decided by someone else'); else throw e; }
  });
  return h('section', { class: 'alerts' }, h('h3', {}, `Pending approvals (${list.length})`), list.map(a => {
    const lane = lanes?.find(l => l.id === v(a, 'laneId'));
    const c = caps(a);
    return h('div', { class: 'approval' },
      h('div', {}, h('b', {}, a.tool), ' ', c.map(x => h('span', { class: 'badge cap-' + x }, x)),
        h('span', { class: 'muted' }, ` lane ${short(v(a, 'laneId'))} · ${v(a, 'ownerName') ?? (lane ? ownerName(lane) : '')} · ${when(v(a, 'createdAt'))}`)),
      h('pre', { class: 'target' }, a.target),
      a.reason && h('div', { class: 'muted' }, a.reason),
      h('div', { class: 'btns' },
        h('button', { onclick: decide(a, 'allow', 'once') }, 'Allow'),
        !c.some(x => x === 'push' || x === 'external') && h('button', { class: 'ghost', onclick: decide(a, 'allow', 'session') }, 'Allow for session'),
        h('button', { class: 'danger', onclick: decide(a, 'deny') }, 'Deny')));
  }));
}

async function joinSession(wid, sid) {
  const lane = (await api('POST', `/api/sessions/${E(sid)}/join`, {})).lane;
  flash(`Joined as lane ${short(lane?.id)}`, true);
  go(`#/w/${E(wid)}/s/${E(sid)}`);
}

// One button that copies a single-use invite link.
function inviteButton(wid) {
  return keep('invite', () => {
    const out = h('span', { class: 'muted' });
    const make = act(async () => {
      const r = await api('POST', `/api/workspaces/${E(wid)}/invites`, { role: 'editor' });
      const url = r.url || `${location.origin}/#/invite/${E(r.token)}`;
      const inp = h('input', { readonly: true, value: url, 'aria-label': 'Invite link', class: 'mono wide', onfocus: e => e.target.select() });
      const copied = await navigator.clipboard?.writeText(url).then(() => true, () => false);
      out.replaceChildren(inp, copied ? ' Copied. Send it to a teammate; it works once.' : ' Send this link to a teammate; it works once.');
    });
    return h('div', { class: 'invite' }, h('button', { class: 'ghost', onclick: make }, 'Invite people'), out);
  });
}

// Until one of my computers has this repo, the dashboard leads with the button that sets it up.
function setupPanel(wid, computers) {
  const online = computers.filter(c => c.online);
  const ready = online.filter(c => c.linked);
  if (ready.length) return h('p', { class: 'muted' }, 'Runs on ', ready.map(c => h('span', { class: 'dev' }, dot('idle'), c.name)));
  const link = (deviceId, body = {}) => act(async () => {
    const r = await api('POST', `/api/workspaces/${E(wid)}/link`, { deviceId, ...body });
    flash(`Setting up on ${computers.find(c => c.id === r.deviceId)?.name ?? 'your computer'}…`, true);
  });
  return h('section', { class: 'panel setup' }, h('h3', {}, 'Set up on your computer'),
    !online.length
      ? h('p', { class: 'muted' }, 'None of your computers is connected. Start Murmur on the computer that has Claude Code; it opens a page here where you click Connect.')
      : [h('p', { class: 'muted' }, 'Murmur finds your copy of this repository on that computer, or downloads one.'),
        h('div', { class: 'btns' }, online.map(c => h('button', { onclick: link(c.id) }, `Set up on ${c.name}`))),
        h('details', {}, h('summary', {}, 'Use a specific folder'),
          form([{ n: 'clonePath', p: 'Folder, e.g. ~/code/my-repo', req: true }], async d => link(online[0].id, d)(), 'Use this folder'))]);
}

async function viewDash(wid) {
  const [ss, ap, comps] = await Promise.all([api('GET', `/api/workspaces/${E(wid)}/sessions`), api('GET', `/api/workspaces/${E(wid)}/approvals?status=pending`),
    api('GET', `/api/workspaces/${E(wid)}/computers`)]);
  const sessions = arr(ss, 'sessions');
  const card = s => {
    const lanes = arr(s, 'lanes');
    const conflicts = v(s, 'openConflicts') ?? v(s, 'conflictCount') ?? v(s, 'conflicts') ?? 0;
    const mine = lanes.some(l => v(l, 'ownerUserId') === myId() && l.status !== 'stopped');
    return h('div', { class: 'scard' },
      h('a', { href: `#/w/${E(wid)}/s/${E(s.id)}`, class: 'title' }, s.title),
      h('div', { class: 'muted' }, s.status, ' · ', s.branch),
      h('ul', { class: 'lanes-mini' }, lanes.map(l => h('li', {}, dot(l.status), ownerName(l), h('span', { class: 'muted' }, ` ${l.mode} · ${l.status}`)))),
      h('div', {},
        (v(s, 'overlap') === true || arr(s, 'overlaps').length > 0) && h('span', { class: 'badge warn' }, 'overlap'),
        +conflicts > 0 && h('span', { class: 'badge bad' }, `${conflicts} conflict${conflicts > 1 ? 's' : ''}`),
        s.status === 'active' && !mine && h('button', { class: 'ghost small', onclick: () => joinSession(wid, s.id).catch(e => flash(e.message)) }, 'Join')));
  };
  const active = sessions.filter(s => s.status === 'active'), rest = sessions.filter(s => s.status !== 'active');
  return h('div', {},
    approvalsStrip(arr(ap, 'approvals'), sessions.flatMap(s => arr(s, 'lanes'))),
    h('div', { class: 'headrow' }, pagehead(wid, 'Sessions'), roleIn(wid) === 'owner' && inviteButton(wid)),
    setupPanel(wid, arr(comps, 'computers')),
    h('section', { class: 'panel' }, h('h3', {}, 'New session'), keep('newsession', () => form([{ n: 'title', p: 'New session title', req: true }, { n: 'base', p: 'Base (default branch)' }, { n: 'mode', p: 'Mode', sel: MODES, v: 'request' }],
      async (d, f) => {
        if (d.mode === 'full' && !confirm('Full mode runs edits and commands without approval. Continue?')) return;
        const r = await api('POST', `/api/workspaces/${E(wid)}/sessions`, d);
        f.reset();
        go(`#/w/${E(wid)}/s/${E(r.session?.id)}`);
      }, 'Start session'))),
    h('h3', {}, `Active (${active.length})`),
    active.length ? h('div', { class: 'grid' }, active.map(card)) : h('p', { class: 'muted' }, 'No active sessions.'),
    rest.length > 0 && h('details', {}, h('summary', {}, `History (${rest.length})`), h('div', { class: 'grid' }, rest.map(card))));
}

// ---------- session room ----------
const brief = i => String(i?.command ?? i?.file_path ?? i?.path ?? i?.notebook_path ?? i?.pattern ?? i?.url ?? '').slice(0, 140);

// Render one LaneEvent into a lane console.
function feed(st, e) {
  const L = st.log;
  const stick = L.scrollHeight - L.scrollTop - L.clientHeight < 40;
  const add = n => (L.append(n), n);
  switch (e.k) {
    case 'assistant.delta':
      (st.text ??= add(h('div', { class: 'ev asst streaming' }))).append(e.text);
      break;
    case 'thinking.delta':
      (st.think ??= add(h('details', { class: 'ev think' }, h('summary', {}, 'thinking'), h('pre', {})))).lastChild.append(e.text);
      break;
    case 'assistant.message':
      if (st.text) { st.text.textContent = e.text; st.text.classList.remove('streaming'); } else add(h('div', { class: 'ev asst' }, e.text));
      st.text = st.think = null;
      break;
    case 'tool.start':
      st.text = st.think = null;
      st.tools.set(e.id, add(h('details', { class: 'ev tool' }, h('summary', {}, h('b', {}, e.name), ' ', h('code', {}, brief(e.input))),
        h('pre', {}, JSON.stringify(e.input, null, 2)))));
      break;
    case 'tool.result': {
      const c = st.tools.get(e.id), p = h('pre', { class: e.isError ? 'res err' : 'res' }, e.text);
      if (c) { c.append(p); c.classList.add(e.isError ? 'err' : 'done'); } else add(p);
      break;
    }
    case 'turn.end':
      if (st.text) st.text.classList.remove('streaming');
      st.text = st.think = null;
      add(h('div', { class: 'ev turn' + (e.isError ? ' err' : '') }, 'turn end',
        e.costUsd != null && ` · $${Number(e.costUsd).toFixed(4)}`, e.isError && e.text && ` · ${e.text}`));
      break;
    case 'user.prompt':
      st.text = st.think = null;
      add(h('div', { class: 'ev user' }, h('b', {}, `${e.from || 'user'} › `), e.text));
      break;
    case 'lane.status':
      add(h('div', { class: 'ev sys' }, `status → ${e.status}`, e.reason && ` (${e.reason})`));
      break;
    case 'error':
      add(h('div', { class: 'ev err' }, e.text));
      break;
  }
  while (L.childElementCount > 1500) L.firstChild.remove(); // ponytail: hard cap, older output via read_lane
  if (stick) L.scrollTop = L.scrollHeight;
}

function laneState(id) {
  return keep('lane:' + id, () => {
    const st = { log: h('div', { class: 'log', role: 'log', 'aria-live': 'off' }), tools: new Map(), text: null, think: null };
    api('GET', `/api/lanes/${E(id)}/events?tail=200`).then(r => { for (const e of arr(r, 'events')) feed(st, e); }).catch(() => {});
    return st;
  });
}

function diffView(patch) {
  if (!patch) return h('pre', { class: 'diff muted' }, '(no patch: binary or too large)');
  return h('pre', { class: 'diff' }, patch.split('\n').map(l =>
    h('span', { class: /^(\+\+\+|---|diff |index )/.test(l) ? 'dh' : l[0] === '+' ? 'da' : l[0] === '-' ? 'dd' : l.startsWith('@@') ? 'dk' : null }, l + '\n')));
}

async function viewRoom(wid, sid) {
  const [d, ms, ap] = await Promise.all([
    api('GET', `/api/sessions/${E(sid)}`),
    api('GET', `/api/workspaces/${E(wid)}/messages`),
    api('GET', `/api/workspaces/${E(wid)}/approvals?status=pending`),
  ]);
  const s = d.session, lanes = arr(d, 'lanes'), dirty = d.dirty || {}, laneIds = new Set(lanes.map(l => l.id));
  const byId = id => lanes.find(l => l.id === id);
  const live = lanes.filter(l => l.status !== 'stopped');
  const mine = live.some(l => v(l, 'ownerUserId') === myId());

  // path -> lane ids that touch it (overlap badges)
  const touch = new Map();
  for (const [lid, files] of Object.entries(dirty)) for (const f of files) touch.set(f.path, [...(touch.get(f.path) ?? []), lid]);

  const laneCol = l => {
    const own = v(l, 'ownerUserId') === myId();
    const st = laneState(l.id);
    const files = dirty[l.id] ?? [];
    const post = (path, body) => act(() => api('POST', `/api/lanes/${E(l.id)}/${path}`, body));
    return h('section', { class: 'lane' },
      h('header', {},
        dot(l.status), h('b', {}, ownerName(l)), h('span', { class: 'muted' }, ` lane ${short(l.id)} · ${l.status}`, v(l, 'statusReason') && ` (${v(l, 'statusReason')})`),
        h('span', { class: 'grow' }),
        own ? h('select', {
          'aria-label': 'Mode', value: l.mode,
          onchange: act(async e => {
            const mode = e.target.value;
            if (mode === 'full' && !confirm('Full mode: edits and commands run without approval (push still gated). Continue?')) return;
            await api('POST', `/api/lanes/${E(l.id)}/mode`, { mode });
          }),
        }, MODES.map(m => h('option', { value: m }, m))) : h('span', { class: 'badge' }, l.mode),
        own && l.status !== 'stopped' && [
          h('button', { class: 'ghost small', onclick: post('interrupt') }, 'Interrupt'),
          h('button', { class: 'ghost small', onclick: act(async () => { const reason = prompt('Hand-off reason', 'manual'); if (reason != null) await api('POST', `/api/lanes/${E(l.id)}/handoff`, { reason }); }) }, 'Hand off'),
        ],
        !own && (l.status === 'awaiting_takeover' || l.status === 'stale') && h('button', {
          class: 'small',
          onclick: act(async () => {
            try { await api('POST', `/api/lanes/${E(l.id)}/takeover`, { expectedOwner: v(l, 'ownerUserId'), version: l.version }); flash('Lane taken over; starting on your node', true); }
            catch (e) { if (e.status !== 409) throw e; const c = e.data?.current; flash(`Already taken by ${v(c, 'ownerName') ?? c?.owner ?? 'someone else'}`); }
          }),
        }, 'Take over')),
      st.log,
      own && l.status !== 'stopped' && keep('composer:' + l.id, () => {
        const ta = h('textarea', { rows: 2, placeholder: 'Prompt this lane (Ctrl+Enter to send)', 'aria-label': 'Prompt' });
        const send = async () => {
          const text = ta.value.trim(); if (!text) return;
          try { await api('POST', `/api/lanes/${E(l.id)}/prompt`, { text }); ta.value = ''; } catch (e) { flash(e.message); }
        };
        ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
        return h('div', { class: 'composer' }, ta, h('button', { onclick: send }, 'Send'));
      }),
      h('div', { class: 'files' }, h('div', { class: 'muted' }, `Changed files (${files.length})`), files.map(f => {
        const others = (touch.get(f.path) ?? []).filter(x => x !== l.id);
        const k = `diff:${l.id}:${f.path}`;
        const det = h('details', { open: cache.get(k) === true, ontoggle: () => { cache.set(k, det.open); if (det.open && !det.lastChild.matches?.('pre')) det.append(diffView(f.patch)); } },
          h('summary', {}, h('code', {}, f.path), ' ', h('span', { class: 'add' }, `+${f.added}`), ' ', h('span', { class: 'del' }, `−${f.removed}`),
            others.map(o => h('span', { class: 'badge warn' }, `overlap: ${byId(o) ? ownerName(byId(o)) : short(o)}`))));
        if (det.open) det.append(diffView(f.patch));
        return det;
      })));
  };

  const plan = arr(d, 'plan');
  const conflicts = arr(d, 'conflicts');
  const msgs = arr(ms, 'messages').filter(m => v(m, 'sessionId') === sid || v(m, 'toKind') === 'broadcast' || laneIds.has(v(m, 'toId')) || laneIds.has(v(m, 'fromLaneId')));
  const STEP = ['unstarted', 'ready', 'in_progress', 'done', 'blocked'];

  return h('div', { class: 'room' },
    h('div', { class: 'roomhead' },
      h('h2', {}, s.title), h('span', { class: 'muted' }, `${s.status} · ${s.branch}`), h('span', { class: 'grow' }),
      s.status === 'active' && !mine && h('button', { onclick: () => joinSession(wid, sid).catch(e => flash(e.message)) }, 'Join session'),
      s.status === 'active' && h('button', { class: 'ghost', onclick: act(async () => {
        if (confirm('Finish: integrate every lane into the session branch and close the session?')) await api('POST', `/api/sessions/${E(sid)}/finish`);
      }) }, 'Finish')),
    approvalsStrip(arr(ap, 'approvals').filter(a => laneIds.has(v(a, 'laneId'))), lanes),
    h('div', { class: 'lanes' }, (live.length ? live : lanes).map(laneCol)),
    h('div', { class: 'panels' },
      h('section', { class: 'panel' }, h('h3', {}, 'Plan'), plan.length ? h('ol', { class: 'plan' }, plan.map(p => h('li', {},
        h('select', {
          'aria-label': 'Step status', value: p.status,
          onchange: act(async e => {
            try { await api('PATCH', `/api/steps/${E(p.id)}`, { status: e.target.value, version: p.version }); }
            catch (er) { if (er.status === 409) flash('Step changed elsewhere; reloaded'); else throw er; }
          }),
        }, STEP.map(x => h('option', { value: x }, x))),
        ' ', p.text,
        v(p, 'ownerLaneId') && h('span', { class: 'badge' }, byId(v(p, 'ownerLaneId')) ? ownerName(byId(v(p, 'ownerLaneId'))) : short(v(p, 'ownerLaneId'))),
        paths(p).length > 0 && h('div', { class: 'muted mono' }, paths(p).join(', ')),
        p.note && h('div', { class: 'muted' }, p.note)))) : h('p', { class: 'muted' }, 'No plan published yet.')),
      h('section', { class: 'panel' }, h('h3', {}, 'Conflicts'), conflicts.length ? h('ul', { class: 'list' }, conflicts.map(c => {
        const a = byId(v(c, 'laneA')), b = byId(v(c, 'laneB'));
        const keepIt = choice => act(() => api('POST', `/api/conflicts/${E(c.id)}/resolve`, { choice }));
        return h('li', { class: c.status === 'resolved' ? 'dim' : null }, h('code', {}, c.path), ' ',
          c.status === 'resolved' ? h('span', { class: 'muted' }, `resolved ${c.resolution ?? ''}`) : [
            h('button', { class: 'small', onclick: keepIt('a') }, `Keep ${a ? ownerName(a) : 'A'}`),
            h('button', { class: 'small', onclick: keepIt('b') }, `Keep ${b ? ownerName(b) : 'B'}`)]);
      })) : h('p', { class: 'muted' }, 'No conflicts.')),
      h('section', { class: 'panel' }, h('h3', {}, 'Messages'),
        h('div', { class: 'msgs' }, msgs.map(m => h('div', { class: 'msg' },
          h('span', { class: 'muted' }, when(v(m, 'createdAt')), ' '),
          h('b', {}, v(m, 'fromName') ?? (v(m, 'fromLaneId') ? `lane ${short(v(m, 'fromLaneId'))}` : short(v(m, 'fromUserId')))),
          h('span', { class: 'muted' }, ` → ${v(m, 'toKind') === 'lane' && byId(v(m, 'toId')) ? ownerName(byId(v(m, 'toId'))) : v(m, 'toKind') ?? ''} `), m.body))),
        keep('msgform', () => form([
          { n: 'to', p: 'To', sel: [[`session:${sid}`, 'Everyone in this session'], ['all', 'Whole workspace'], ...live.map(l => [`lane:${l.id}`, `${ownerName(l)}'s agent`])], v: `session:${sid}` },
          { n: 'body', p: 'Message', req: true },
        ], async (dd, f) => { await api('POST', '/api/messages', { workspaceId: wid, ...dd }); f.elements.body.value = ''; refresh(); }, 'Send')))));
}

// ---------- board ----------
const COLS = [['backlog', 'Backlog'], ['ready', 'Ready'], ['in_progress', 'In progress'], ['review', 'Review'], ['done', 'Done']];

async function viewBoard(wid) {
  const tasks = arr(await api('GET', `/api/workspaces/${E(wid)}/tasks`), 'tasks');
  const move = act(async (t, col) => {
    if (!t || t.col === col) return;
    try { await api('PATCH', `/api/tasks/${E(t.id)}`, { col, version: t.version }); }
    catch (e) { if (e.status === 409) flash('Card changed elsewhere; reloaded'); else throw e; }
  });
  return h('div', {},
    pagehead(wid, 'Board'),
    keep('addtask', () => form([{ n: 'title', p: 'New card title', req: true }, { n: 'notes', p: 'Notes' }, { n: 'acceptance', p: 'Acceptance' }],
      async (d, f) => { await api('POST', `/api/workspaces/${E(wid)}/tasks`, d); f.reset(); refresh(); }, 'Add card')),
    h('div', { class: 'kanban' }, COLS.map(([col, label]) => {
      const el = h('div', {
        class: 'kcol',
        ondragover: e => { e.preventDefault(); el.classList.add('over'); },
        ondragleave: () => el.classList.remove('over'),
        ondrop: e => { e.preventDefault(); el.classList.remove('over'); move(tasks.find(t => t.id === e.dataTransfer.getData('text/plain')), col); },
      }, h('h3', {}, label, ' ', h('span', { class: 'muted' }, tasks.filter(t => t.col === col).length)),
      tasks.filter(t => t.col === col).map(t => h('div', { class: 'task', draggable: 'true', ondragstart: e => e.dataTransfer.setData('text/plain', t.id) },
        h('b', {}, t.title),
        t.notes && h('div', {}, t.notes),
        t.acceptance && h('div', { class: 'muted' }, 'Accept: ', t.acceptance),
        paths(t).length > 0 && h('div', { class: 'muted mono' }, paths(t).join(', ')),
        v(t, 'claimedByLaneId') && h('span', { class: 'badge' }, `lane ${short(v(t, 'claimedByLaneId'))}`),
        // keyboard / touch fallback for drag and drop
        h('select', { class: 'small', 'aria-label': 'Move to column', value: col, onchange: e => move(t, e.target.value) }, COLS.map(([c, lb]) => h('option', { value: c }, lb))))));
      return el;
    })));
}

// ---------- memory ----------
async function viewMemory(wid, q) {
  const query = q.get('q') || '';
  const mems = arr(await api('GET', `/api/workspaces/${E(wid)}/memory${query ? `?q=${E(query)}` : ''}`), 'memories');
  const patch = (m, body) => act(() => api('PATCH', `/api/memory/${E(m.id)}`, body));
  return h('div', {},
    pagehead(wid, 'Memory'),
    form([{ n: 'q', p: 'Search memory', v: query }], async d => go(`#/w/${E(wid)}/memory${d.q ? `?q=${E(d.q)}` : ''}`), 'Search'),
    h('ul', { class: 'list mem' }, mems.map(m => {
      const retired = !!(v(m, 'retiredAt') ?? m.retired);
      const editing = cache.get('memedit:' + m.id);
      const refs = arr(m, 'refs').map(r => r.path ?? r).concat(paths(m));
      return h('li', { class: retired ? 'dim' : null },
        editing ? editing : h('div', { class: 'body' }, m.body),
        refs.length > 0 && h('div', { class: 'muted mono' }, refs.join(', ')),
        h('div', { class: 'btns' },
          m.pinned ? h('span', { class: 'badge' }, 'pinned') : null,
          retired && h('span', { class: 'badge' }, 'retired'),
          h('button', { class: 'ghost small', onclick: patch(m, { pinned: !m.pinned }) }, m.pinned ? 'Unpin' : 'Pin'),
          !retired && h('button', { class: 'ghost small', onclick: patch(m, { retired: true }) }, 'Retire'),
          editing
            ? h('button', { class: 'small', onclick: act(async () => { await api('PATCH', `/api/memory/${E(m.id)}`, { body: editing.value }); cache.delete('memedit:' + m.id); }) }, 'Save')
            : h('button', { class: 'ghost small', onclick: () => { cache.set('memedit:' + m.id, h('textarea', { rows: 4, value: m.body, 'aria-label': 'Memory text' })); show(); } }, 'Edit')));
    })),
    !mems.length && h('p', { class: 'muted' }, query ? 'No matches.' : 'No memories yet.'),
    h('h3', {}, 'Add memory'),
    keep('addmem', () => form([{ n: 'body', p: 'What should the team remember?', t: 'textarea', req: true }, { n: 'paths', p: 'Paths (comma-separated)' }],
      async (d, f) => {
        await api('POST', `/api/workspaces/${E(wid)}/memory`, { body: d.body, paths: d.paths ? d.paths.split(',').map(x => x.trim()).filter(Boolean) : undefined });
        f.reset(); refresh();
      }, 'Remember', 'stack')));
}

// ---------- people ----------
async function viewPeople(wid) {
  const [w, dv] = await Promise.all([api('GET', `/api/workspaces/${E(wid)}`), api('GET', '/api/devices')]);
  const members = arr(w, 'members');
  const devices = arr(dv, 'devices');
  const owner = roleIn(wid) === 'owner';
  return h('div', {},
    pagehead(wid, 'People'),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Member'), h('th', {}, 'Role'), h('th', {}, 'Devices'))),
      h('tbody', {}, members.map(m => h('tr', {},
        h('td', {}, m.name), h('td', {}, m.role),
        h('td', {}, arr(m, 'devices').map(d => h('span', { class: 'dev' }, dot(d.online ? 'idle' : 'stopped'), d.name)), !arr(m, 'devices').length && h('span', { class: 'muted' }, '—')))))),
    owner && [h('h3', {}, 'Invite'), keep('invite', () => {
      const out = h('div', {});
      const f = form([{ n: 'role', p: 'Role', sel: ['viewer', 'commenter', 'editor', 'owner'], v: 'editor' }, { n: 'ttlHours', p: 'Expires in hours', t: 'number', v: '72' }],
        async d => {
          const r = await api('POST', `/api/workspaces/${E(wid)}/invites`, { role: d.role, ttlHours: d.ttlHours ? Number(d.ttlHours) : undefined });
          const url = r.url || `${location.origin}/#/invite/${E(r.token)}`;
          const inp = h('input', { readonly: true, value: url, 'aria-label': 'Invite link', class: 'mono wide' });
          out.replaceChildren(inp, h('button', { onclick: () => navigator.clipboard?.writeText(url).then(() => flash('Copied', true), () => inp.select()) }, 'Copy'),
            h('p', { class: 'muted' }, 'Send this link out-of-band. It works once.'));
        }, 'Create invite link');
      return h('div', {}, f, out);
    })],
    h('h3', {}, 'My devices'),
    devices.length ? h('ul', { class: 'list' }, devices.map(d => h('li', { class: v(d, 'revokedAt') ? 'dim' : null },
      dot(d.online ? 'idle' : 'stopped'), h('b', {}, d.name), h('span', { class: 'muted' }, ` ${short(d.id)}`, v(d, 'lastSeenAt') && ` · seen ${new Date(v(d, 'lastSeenAt')).toLocaleString()}`),
      v(d, 'revokedAt') ? h('span', { class: 'badge' }, 'revoked')
        : h('button', { class: 'danger small', onclick: act(async () => { if (confirm(`Revoke device "${d.name}"? Its node is disconnected immediately.`)) await api('DELETE', `/api/devices/${E(d.id)}`); }) }, 'Revoke'))))
      : h('p', { class: 'muted' }, 'No devices. Run `murmur login <hub-url>` on your machine.'));
}

show();
