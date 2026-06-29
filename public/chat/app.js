'use strict';

/* ──────────────────────────────────────────────────────────
   Team Chat — a self-hosted ChatGPT-style front end for the
   LLM Gateway. Sign in with a personal gateway key; chats are
   stored per-key in this browser; usage counts against your
   own daily budget on the gateway.
   ────────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

const state = {
  name: '',
  key: '',
  base: '', // gateway origin, '' = same origin
  models: [],
  model: '',
  convos: [], // [{id, title, system, model, messages:[{role,content}], updated}]
  currentId: null,
  controller: null, // AbortController for the in-flight stream
  admin: false,
  remote: false, // true when conversations sync to the server
};

/* ── Storage (scoped per gateway key so users don't see each other's chats) ── */
const lsKey = (suffix) => `teamchat:${hash(state.key)}:${suffix}`;
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function saveConvos() {
  localStorage.setItem(lsKey('convos'), JSON.stringify(state.convos));
}
function loadConvosLocal() {
  try { state.convos = JSON.parse(localStorage.getItem(lsKey('convos')) || '[]'); }
  catch { state.convos = []; }
}

/* Load from the server (cross-device sync) with a localStorage fallback. */
async function loadConvos() {
  try {
    const res = await fetch(api('/v1/conversations'), { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json();
      state.convos = data.conversations || [];
      state.remote = true;
      saveConvos(); // keep a local cache
      return;
    }
  } catch { /* fall through to local */ }
  state.remote = false;
  loadConvosLocal();
}

/* Push a single conversation to the server (fire-and-forget). */
function pushConvo(c) {
  if (!state.remote || !c) return;
  fetch(api('/v1/conversations/' + encodeURIComponent(c.id)), {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      title: c.title, system: c.system, model: c.model,
      messages: c.messages, created: c.created,
    }),
  }).catch(() => {});
}

function remoteDelete(id) {
  if (!state.remote) return;
  fetch(api('/v1/conversations/' + encodeURIComponent(id)), {
    method: 'DELETE', headers: authHeaders(),
  }).catch(() => {});
}

/* Persist a conversation both locally and (if synced) to the server. */
function persist(c) {
  saveConvos();
  pushConvo(c);
}

/* ── Auth header + fetch helper ───────────────────────────── */
function api(path) { return (state.base || '') + path; }
function authHeaders(extra = {}) {
  return { Authorization: 'Bearer ' + state.key, ...extra };
}

/* ── Login ────────────────────────────────────────────────── */
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('loginError');
  err.textContent = '';

  const name = $('loginName').value.trim() || 'You';
  const key = $('loginKey').value.trim();
  let base = $('loginBase').value.trim().replace(/\/+$/, '');
  if (!key) { err.textContent = 'Gateway key is required.'; return; }

  // Validate the key by hitting an authenticated, cheap endpoint.
  try {
    const res = await fetch((base || '') + '/v1/models', {
      headers: { Authorization: 'Bearer ' + key },
    });
    if (res.status === 401) { err.textContent = 'Invalid gateway key.'; return; }
    if (!res.ok) { err.textContent = 'Gateway error: HTTP ' + res.status; return; }
  } catch (e2) {
    err.textContent = 'Could not reach gateway' + (base ? ' at ' + base : '') + '.';
    return;
  }

  state.name = name;
  state.key = key;
  state.base = base;
  localStorage.setItem('teamchat:session', JSON.stringify({ name, key, base }));
  await startApp();
});

function tryRestoreSession() {
  try {
    const s = JSON.parse(localStorage.getItem('teamchat:session') || 'null');
    if (s && s.key) {
      state.name = s.name || 'You';
      state.key = s.key;
      state.base = s.base || '';
      startApp();
    }
  } catch { /* ignore */ }
}

$('logout').addEventListener('click', () => {
  if (state.controller) state.controller.abort();
  localStorage.removeItem('teamchat:session');
  location.reload();
});

/* ── App start ────────────────────────────────────────────── */
async function startApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');

  $('userName').textContent = state.name;
  $('userKey').textContent = maskKey(state.key);
  $('userAvatar').textContent = (state.name[0] || '?').toUpperCase();

  await loadMe();
  await loadConvos();
  await loadModels();
  await refreshBudget();

  if (state.convos.length === 0) newConvo();
  else selectConvo(state.convos[0].id);

  renderConvList();
}

function maskKey(k) {
  if (k.length <= 8) return k;
  return k.slice(0, 4) + '…' + k.slice(-4);
}

/* ── Identity (/v1/me): prefer server-known name, reveal admin panel ── */
async function loadMe() {
  try {
    const res = await fetch(api('/v1/me'), { headers: authHeaders() });
    if (!res.ok) return;
    const me = await res.json();
    state.admin = Boolean(me.admin);
    if (me.name) {
      state.name = me.name;
      $('userName').textContent = me.name;
      $('userAvatar').textContent = (me.name[0] || '?').toUpperCase();
    }
    $('adminBtn').classList.toggle('hidden', !state.admin);
  } catch { /* ignore */ }
}

/* ── Models ───────────────────────────────────────────────── */
async function loadModels() {
  try {
    const res = await fetch(api('/v1/models'), { headers: authHeaders() });
    const data = await res.json();
    state.models = (data.data || []).map((m) => m.id);
  } catch { state.models = []; }

  const sel = $('modelSelect');
  sel.innerHTML = '';
  const saved = localStorage.getItem(lsKey('model'));
  const list = state.models.length ? state.models : ['gpt-4o-mini'];
  for (const id of list) {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = id;
    sel.appendChild(opt);
  }
  state.model = saved && list.includes(saved) ? saved : list[0];
  sel.value = state.model;
}
$('modelSelect').addEventListener('change', (e) => {
  state.model = e.target.value;
  localStorage.setItem(lsKey('model'), state.model);
  const c = current();
  if (c) { c.model = state.model; persist(c); }
});

/* ── Conversations ────────────────────────────────────────── */
function current() { return state.convos.find((c) => c.id === state.currentId); }

function newConvo() {
  const c = {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: 'New chat',
    system: '',
    model: state.model,
    messages: [],
    created: Date.now(),
    updated: Date.now(),
  };
  state.convos.unshift(c);
  saveConvos();
  selectConvo(c.id);
  renderConvList();
}
$('newChat').addEventListener('click', newConvo);

function selectConvo(id) {
  state.currentId = id;
  const c = current();
  if (c) {
    if (c.model && state.models.includes(c.model)) {
      state.model = c.model;
      $('modelSelect').value = c.model;
    }
    $('sysInput').value = c.system || '';
    $('convTitle').textContent = c.title;
  }
  renderConvList();
  renderMessages();
  $('input').focus();
}

function deleteConvo(id, ev) {
  ev.stopPropagation();
  state.convos = state.convos.filter((c) => c.id !== id);
  saveConvos();
  remoteDelete(id);
  if (state.currentId === id) {
    if (state.convos.length) selectConvo(state.convos[0].id);
    else newConvo();
  }
  renderConvList();
}

function renderConvList() {
  const wrap = $('convList');
  wrap.innerHTML = '';
  for (const c of state.convos) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === state.currentId ? ' active' : '');
    item.onclick = () => selectConvo(c.id);
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = c.title || 'New chat';
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '🗑';
    del.title = 'Delete chat';
    del.onclick = (e) => deleteConvo(c.id, e);
    item.appendChild(title);
    item.appendChild(del);
    wrap.appendChild(item);
  }
}

/* ── System prompt panel ──────────────────────────────────── */
$('sysBtn').addEventListener('click', () => $('sysPanel').classList.toggle('hidden'));
$('sysClose').addEventListener('click', () => $('sysPanel').classList.add('hidden'));
$('sysSave').addEventListener('click', () => {
  const c = current();
  if (c) { c.system = $('sysInput').value.trim(); persist(c); }
  $('sysPanel').classList.add('hidden');
});

/* ── Sidebar collapse ─────────────────────────────────────── */
$('collapseBtn').addEventListener('click', () => {
  $('sidebar').classList.add('collapsed');
  $('showSidebar').classList.remove('hidden');
});
$('showSidebar').addEventListener('click', () => {
  $('sidebar').classList.remove('collapsed');
  $('showSidebar').classList.add('hidden');
});

/* ── Rendering messages ───────────────────────────────────── */
function renderMessages() {
  const box = $('messages');
  const c = current();
  box.innerHTML = '';
  if (!c || c.messages.length === 0) {
    box.innerHTML =
      '<div class="empty-state"><div class="big">💬</div>' +
      '<h2>Ask anything</h2>' +
      '<div>Shared gateway, your own budget. Pick a model above and start typing.</div></div>';
    return;
  }
  for (const m of c.messages) box.appendChild(messageEl(m.role, m.content));
  box.scrollTop = box.scrollHeight;
}

function messageEl(role, content) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap';
  const msg = document.createElement('div');
  msg.className = 'msg ' + role;
  const avatar = document.createElement('div');
  avatar.className = 'role-avatar';
  avatar.textContent = role === 'user' ? (state.name[0] || 'U').toUpperCase() : '✦';
  const body = document.createElement('div');
  body.className = 'content';
  body.innerHTML = renderMarkdown(content);
  msg.appendChild(avatar);
  msg.appendChild(body);
  wrap.appendChild(msg);
  return wrap;
}

/* Minimal, XSS-safe markdown: escape first, then format. */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderMarkdown(text) {
  let t = escapeHtml(text);
  // Fenced code blocks
  t = t.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) =>
    '<pre><code>' + code.replace(/\n$/, '') + '</code></pre>');
  // Inline code
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Bold / italic
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // Paragraphs (skip splitting inside <pre>)
  const parts = t.split(/\n{2,}/).map((block) => {
    if (block.startsWith('<pre>')) return block;
    return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
  });
  return parts.join('');
}

/* ── Sending / streaming ──────────────────────────────────── */
const input = $('input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('send').addEventListener('click', send);
$('stop').addEventListener('click', () => { if (state.controller) state.controller.abort(); });

function setSending(on) {
  $('send').classList.toggle('hidden', on);
  $('stop').classList.toggle('hidden', !on);
  $('send').disabled = on;
}
function hint(msg, isError = false) {
  const h = $('hint');
  h.textContent = msg || '';
  h.classList.toggle('error', isError);
}

async function send() {
  const text = input.value.trim();
  if (!text || state.controller) return;
  const c = current();
  if (!c) return;

  hint('');
  c.messages.push({ role: 'user', content: text });
  if (c.messages.length === 1) {
    c.title = text.slice(0, 40);
    $('convTitle').textContent = c.title;
    renderConvList();
  }
  c.updated = Date.now();
  saveConvos();

  input.value = '';
  input.style.height = 'auto';

  const box = $('messages');
  if (box.querySelector('.empty-state')) box.innerHTML = '';
  box.appendChild(messageEl('user', text));

  // Placeholder assistant bubble we stream into.
  const asstWrap = messageEl('assistant', '');
  const asstBody = asstWrap.querySelector('.content');
  asstBody.classList.add('cursor-blink');
  box.appendChild(asstWrap);
  box.scrollTop = box.scrollHeight;

  // Build payload: optional system prompt + full history.
  const payloadMsgs = [];
  if (c.system) payloadMsgs.push({ role: 'system', content: c.system });
  for (const m of c.messages) payloadMsgs.push({ role: m.role, content: m.content });

  state.controller = new AbortController();
  setSending(true);
  let acc = '';

  try {
    const res = await fetch(api('/v1/chat/completions'), {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: state.model, stream: true, messages: payloadMsgs }),
      signal: state.controller.signal,
    });

    updateBudgetFromHeaders(res.headers);

    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      try { const j = await res.json(); detail = j.error?.message || detail; } catch {}
      asstBody.classList.remove('cursor-blink');
      asstBody.innerHTML = renderMarkdown('⚠️ ' + detail);
      hint(res.status === 429 ? 'Daily budget reached — resets at UTC midnight.' : detail, true);
      c.messages.push({ role: 'assistant', content: '⚠️ ' + detail });
      persist(c);
      return;
    }

    acc = await readSSE(res, (delta) => {
      acc += delta;
      asstBody.innerHTML = renderMarkdown(acc);
      asstBody.classList.add('cursor-blink');
      box.scrollTop = box.scrollHeight;
    });

    asstBody.classList.remove('cursor-blink');
    asstBody.innerHTML = renderMarkdown(acc || '(empty response)');
    c.messages.push({ role: 'assistant', content: acc });
    c.updated = Date.now();
    persist(c);
    refreshBudget();
  } catch (e) {
    asstBody.classList.remove('cursor-blink');
    if (e.name === 'AbortError') {
      const partial = acc + '\n\n_(stopped)_';
      asstBody.innerHTML = renderMarkdown(partial);
      if (acc) { c.messages.push({ role: 'assistant', content: acc }); persist(c); }
      hint('Stopped.');
    } else {
      asstBody.innerHTML = renderMarkdown('⚠️ ' + e.message);
      hint(e.message, true);
    }
  } finally {
    state.controller = null;
    setSending(false);
    input.focus();
  }
}

/* Parse an OpenAI-style SSE stream, calling onDelta with each content chunk. */
async function readSSE(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return full;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onDelta(delta); }
      } catch { /* ignore keep-alives / partials */ }
    }
  }
  return full;
}

/* ── Budget widget ────────────────────────────────────────── */
async function refreshBudget() {
  try {
    const res = await fetch(api('/v1/usage'), { headers: authHeaders() });
    if (!res.ok) return;
    const d = await res.json();
    renderBudget(d.usage, d.limits);
  } catch { /* ignore */ }
}

function updateBudgetFromHeaders(headers) {
  const reqUsed = headers.get('X-Budget-Requests-Used');
  const reqLimit = headers.get('X-Budget-Requests-Limit');
  const costUsed = headers.get('X-Budget-Cost-Used');
  const costLimit = headers.get('X-Budget-Cost-Limit');
  if (reqUsed == null && costUsed == null) return;
  renderBudget(
    { requests: num(reqUsed), costUsd: num(costUsed) },
    { dailyRequests: reqLimit != null ? num(reqLimit) : null,
      dailyCostUsd: costLimit != null ? num(costLimit) : null }
  );
}
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

function renderBudget(usage, limits) {
  usage = usage || {}; limits = limits || {};
  const req = usage.requests || 0;
  const cost = usage.costUsd || 0;

  if (limits.dailyRequests != null) {
    $('budReq').textContent = req + ' / ' + limits.dailyRequests;
    setBar('budReqBar', req / limits.dailyRequests);
  } else {
    $('budReq').textContent = req + ' / ∞';
    setBar('budReqBar', 0);
  }

  if (limits.dailyCostUsd != null) {
    $('budCost').textContent = '$' + cost.toFixed(4) + ' / $' + limits.dailyCostUsd;
    setBar('budCostBar', cost / limits.dailyCostUsd);
  } else {
    $('budCost').textContent = '$' + cost.toFixed(4) + ' / ∞';
    setBar('budCostBar', 0);
  }
}
function setBar(id, ratio) {
  const el = $(id);
  const pct = Math.max(0, Math.min(1, ratio || 0)) * 100;
  el.style.width = pct + '%';
  el.classList.toggle('over', ratio >= 1);
}

/* ── Team admin panel (admins only) ───────────────────────── */
$('adminBtn').addEventListener('click', openAdmin);
$('adminClose').addEventListener('click', () => $('adminModal').classList.add('hidden'));
$('adminModal').addEventListener('click', (e) => {
  if (e.target === $('adminModal')) $('adminModal').classList.add('hidden');
});

async function openAdmin() {
  $('newKeyBanner').classList.add('hidden');
  $('adminModal').classList.remove('hidden');
  await loadTeam();
}

async function loadTeam() {
  const tbody = $('teamRows');
  tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
  try {
    const res = await fetch(api('/admin/team'), { headers: authHeaders() });
    if (!res.ok) { tbody.innerHTML = '<tr><td colspan="6">Failed: HTTP ' + res.status + '</td></tr>'; return; }
    const data = await res.json();
    renderTeam(data.members || []);
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6">Error: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

function lim(v, unit) { return v == null ? '∞' : (unit === '$' ? '$' + v : v + unit); }

function renderTeam(members) {
  const tbody = $('teamRows');
  if (!members.length) { tbody.innerHTML = '<tr><td colspan="6">No members yet. Add one above.</td></tr>'; return; }
  tbody.innerHTML = '';
  for (const m of members) {
    const tr = document.createElement('tr');
    const isMe = m.key === state.key;
    const u = m.usage || {};
    tr.innerHTML =
      '<td>' + escapeHtml(m.name) + (m.admin ? ' <span class="tag admin">admin</span>' : '') +
        (isMe ? ' <span class="tag">you</span>' : '') + '</td>' +
      '<td class="keycell"><span>' + maskKey(m.key) + '</span> ' +
        '<button data-copy="' + escapeHtml(m.key) + '">copy</button></td>' +
      '<td>' + (u.requests || 0) + ' req · $' + (u.costUsd || 0).toFixed(4) + '</td>' +
      '<td>' + lim(m.dailyRequests, ' req') + ' · ' + lim(m.dailyCostUsd, '$') + '</td>' +
      '<td><span class="tag ' + (m.disabled ? 'off' : 'on') + '">' + (m.disabled ? 'disabled' : 'active') + '</span></td>' +
      '<td class="row-actions">' +
        '<button data-toggle="' + escapeHtml(m.key) + '" data-dis="' + (m.disabled ? '0' : '1') + '">' +
          (m.disabled ? 'Enable' : 'Disable') + '</button>' +
        '<button class="danger" data-del="' + escapeHtml(m.key) + '">Remove</button>' +
      '</td>';
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => {
      navigator.clipboard?.writeText(b.dataset.copy);
      b.textContent = 'copied'; setTimeout(() => (b.textContent = 'copy'), 1200);
    }));
  tbody.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => patchMember(b.dataset.toggle, { disabled: b.dataset.dis === '1' })));
  tbody.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => removeMember(b.dataset.del)));
}

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: $('mName').value.trim(),
    dailyRequests: $('mReq').value === '' ? null : Number($('mReq').value),
    dailyCostUsd: $('mCost').value === '' ? null : Number($('mCost').value),
    admin: $('mAdmin').checked,
  };
  if (!body.name) return;
  try {
    const res = await fetch(api('/admin/team'), {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error?.message || 'Failed'); return; }
    const banner = $('newKeyBanner');
    banner.innerHTML = 'Member created. Share this key — it is shown only once:<br><code>' +
      escapeHtml(data.member.key) + '</code>';
    banner.classList.remove('hidden');
    $('addForm').reset();
    await loadTeam();
  } catch (e2) { alert(e2.message); }
});

async function patchMember(key, patch) {
  try {
    const res = await fetch(api('/admin/team/' + encodeURIComponent(key)), {
      method: 'PATCH',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(patch),
    });
    if (!res.ok) { const j = await res.json(); alert(j.error?.message || 'Failed'); return; }
    await loadTeam();
  } catch (e) { alert(e.message); }
}

async function removeMember(key) {
  if (!confirm('Remove this member? Their key will stop working immediately.')) return;
  try {
    const res = await fetch(api('/admin/team/' + encodeURIComponent(key)), {
      method: 'DELETE', headers: authHeaders(),
    });
    if (!res.ok) { const j = await res.json(); alert(j.error?.message || 'Failed'); return; }
    await loadTeam();
  } catch (e) { alert(e.message); }
}

/* ── Go ───────────────────────────────────────────────────── */
tryRestoreSession();
