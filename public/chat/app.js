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
  key: '', // bearer credential: session token, env key, or legacy team key
  memberKey: '', // stable per-user key for local storage and budget ownership
  username: '',
  authMode: 'password',
  base: '', // gateway origin, '' = same origin
  models: [],
  model: '',
  convos: [], // [{id, title, pinned, system, model, messages:[{role,content}], updated}]
  currentId: null,
  controller: null, // AbortController for the in-flight stream
  admin: false,
  remote: false, // true when conversations sync to the server
  search: '',
  editing: null, // { convId, index } while editing a user message
};

/* ── Storage (scoped per gateway key so users don't see each other's chats) ── */
const lsKey = (suffix) => `teamchat:${hash(state.memberKey || state.key)}:${suffix}`;
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function saveConvos() {
  sortConvos();
  localStorage.setItem(lsKey('convos'), JSON.stringify(state.convos));
}
function loadConvosLocal() {
  try { state.convos = JSON.parse(localStorage.getItem(lsKey('convos')) || '[]'); }
  catch { state.convos = []; }
  normalizeConvos();
}

/* Load from the server (cross-device sync) with a localStorage fallback. */
async function loadConvos() {
  try {
    const res = await fetch(api('/v1/conversations'), { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json();
      state.convos = data.conversations || [];
      normalizeConvos();
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
      messages: c.messages, created: c.created, pinned: Boolean(c.pinned),
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

function normalizeConvos() {
  state.convos = (state.convos || []).map((c) => ({
    ...c,
    title: c.title || 'New chat',
    pinned: Boolean(c.pinned),
    messages: Array.isArray(c.messages) ? c.messages : [],
    created: c.created || Date.now(),
    updated: c.updated || c.created || Date.now(),
  }));
  sortConvos();
}

function sortConvos() {
  state.convos.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return (b.updated || 0) - (a.updated || 0);
  });
}

/* ── Auth header + fetch helper ───────────────────────────── */
function api(path) { return (state.base || '') + path; }
function authHeaders(extra = {}) {
  return { Authorization: 'Bearer ' + state.key, ...extra };
}

/* ── Login ────────────────────────────────────────────────── */
function setLoginMode(mode) {
  state.authMode = mode;
  $('passwordFields').classList.toggle('hidden', mode !== 'password');
  $('keyFields').classList.toggle('hidden', mode !== 'key');
  $('passwordMode').classList.toggle('active', mode === 'password');
  $('keyMode').classList.toggle('active', mode === 'key');
}
$('passwordMode').addEventListener('click', () => setLoginMode('password'));
$('keyMode').addEventListener('click', () => setLoginMode('key'));

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('loginError');
  err.textContent = '';

  let base = $('loginBase').value.trim().replace(/\/+$/, '');

  if (state.authMode === 'password') {
    const username = $('loginUsername').value.trim();
    const password = $('loginPassword').value;
    if (!username || !password) { err.textContent = 'Username and password are required.'; return; }

    try {
      const res = await fetch((base || '') + '/v1/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { err.textContent = 'Invalid username or password.'; return; }
      if (!res.ok) { err.textContent = data.error?.message || ('Gateway error: HTTP ' + res.status); return; }

      state.name = data.member?.name || username;
      state.username = data.member?.username || username;
      state.memberKey = data.member?.key || '';
      state.key = data.token;
      state.base = base;
      localStorage.setItem('teamchat:session', JSON.stringify({
        mode: 'password',
        name: state.name,
        username: state.username,
        memberKey: state.memberKey,
        token: state.key,
        base,
        expiresAt: data.expiresAt,
      }));
      await startApp();
      return;
    } catch (e2) {
      err.textContent = 'Could not reach gateway' + (base ? ' at ' + base : '') + '.';
      return;
    }
  }

  const name = $('loginName').value.trim() || 'You';
  const key = $('loginKey').value.trim();
  if (!key) { err.textContent = 'Gateway API key is required.'; return; }

  try {
    const res = await fetch((base || '') + '/v1/models', {
      headers: { Authorization: 'Bearer ' + key },
    });
    if (res.status === 401) { err.textContent = 'Invalid gateway API key.'; return; }
    if (!res.ok) { err.textContent = 'Gateway error: HTTP ' + res.status; return; }
  } catch (e2) {
    err.textContent = 'Could not reach gateway' + (base ? ' at ' + base : '') + '.';
    return;
  }

  state.name = name;
  state.key = key;
  state.memberKey = key;
  state.username = '';
  state.base = base;
  localStorage.setItem('teamchat:session', JSON.stringify({ mode: 'key', name, key, memberKey: key, base }));
  await startApp();
});

function tryRestoreSession() {
  try {
    const s = JSON.parse(localStorage.getItem('teamchat:session') || 'null');
    if (s && (s.token || s.key)) {
      state.authMode = s.mode || (s.token ? 'password' : 'key');
      state.name = s.name || 'You';
      state.username = s.username || '';
      state.key = s.token || s.key;
      state.memberKey = s.memberKey || s.key || '';
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
  $('userKey').textContent = state.username ? '@' + state.username : maskKey(state.memberKey || state.key);
  $('userAvatar').textContent = (state.name[0] || '?').toUpperCase();

  const ok = await loadMe();
  if (!ok) {
    localStorage.removeItem('teamchat:session');
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
    $('loginError').textContent = 'Session expired. Please sign in again.';
    return;
  }
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
    if (!res.ok) return false;
    const me = await res.json();
    state.admin = Boolean(me.admin);
    state.memberKey = me.key || state.memberKey || state.key;
    state.username = me.username || state.username;
    if (me.name) {
      state.name = me.name;
      $('userName').textContent = me.name;
      $('userAvatar').textContent = (me.name[0] || '?').toUpperCase();
    }
    $('userKey').textContent = state.username ? '@' + state.username : maskKey(state.memberKey || state.key);
    $('adminBtn').classList.toggle('hidden', !state.admin);
    return true;
  } catch { return false; }
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
    pinned: false,
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
$('convSearch').addEventListener('input', (e) => {
  state.search = e.target.value.trim().toLowerCase();
  renderConvList();
});

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

function renderConvListLegacy() {
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
function renameConvo(id, ev) {
  ev.stopPropagation();
  const c = state.convos.find((x) => x.id === id);
  if (!c) return;
  const next = prompt('Rename chat', c.title || 'New chat');
  if (next === null) return;
  const title = next.trim();
  if (!title) return;
  c.title = title.slice(0, 200);
  c.updated = Date.now();
  persist(c);
  if (state.currentId === id) $('convTitle').textContent = c.title;
  renderConvList();
}

function togglePinConvo(id, ev) {
  ev.stopPropagation();
  const c = state.convos.find((x) => x.id === id);
  if (!c) return;
  c.pinned = !c.pinned;
  c.updated = Date.now();
  persist(c);
  renderConvList();
}

function convoMatches(c) {
  if (!state.search) return true;
  const haystack = [
    c.title || '',
    c.system || '',
    ...(c.messages || []).map((m) => m.content || ''),
  ].join('\n').toLowerCase();
  return haystack.includes(state.search);
}

function renderConvList() {
  const wrap = $('convList');
  wrap.innerHTML = '';
  const convos = state.convos.filter(convoMatches);
  if (!convos.length) {
    wrap.innerHTML = '<div class="conv-empty">No chats found</div>';
    return;
  }
  for (const c of convos) {
    const item = document.createElement('div');
    item.className =
      'conv-item' +
      (c.id === state.currentId ? ' active' : '') +
      (c.pinned ? ' pinned' : '');
    item.onclick = () => selectConvo(c.id);

    const pin = document.createElement('span');
    pin.className = 'pinmark';
    pin.textContent = c.pinned ? 'PIN' : '';

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = c.title || 'New chat';

    const actions = document.createElement('div');
    actions.className = 'conv-actions';

    const pinBtn = document.createElement('button');
    pinBtn.textContent = c.pinned ? 'Unpin' : 'Pin';
    pinBtn.title = c.pinned ? 'Unpin chat' : 'Pin chat';
    pinBtn.onclick = (e) => togglePinConvo(c.id, e);

    const rename = document.createElement('button');
    rename.textContent = 'Rename';
    rename.title = 'Rename chat';
    rename.onclick = (e) => renameConvo(c.id, e);

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.title = 'Delete chat';
    del.onclick = (e) => deleteConvo(c.id, e);

    actions.appendChild(pinBtn);
    actions.appendChild(rename);
    actions.appendChild(del);
    item.appendChild(pin);
    item.appendChild(title);
    item.appendChild(actions);
    wrap.appendChild(item);
  }
}

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
  c.messages.forEach((m, index) => box.appendChild(messageEl(m.role, m.content, index)));
  box.scrollTop = box.scrollHeight;
}

function messageElLegacy(role, content) {
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

function renderMessagesLegacy() {
  const box = $('messages');
  const c = current();
  box.innerHTML = '';
  if (!c || c.messages.length === 0) {
    box.innerHTML =
      '<div class="empty-state"><div class="big">Chat</div>' +
      '<h2>Ask anything</h2>' +
      '<div>Shared gateway, your own budget. Pick a model above and start typing.</div></div>';
    return;
  }
  c.messages.forEach((m, index) => box.appendChild(messageEl(m.role, m.content, index)));
  box.scrollTop = box.scrollHeight;
}

function messageEl(role, content, index = null) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap';
  const msg = document.createElement('div');
  msg.className = 'msg ' + role;

  const avatar = document.createElement('div');
  avatar.className = 'role-avatar';
  avatar.textContent = role === 'user' ? (state.name[0] || 'U').toUpperCase() : 'AI';

  const main = document.createElement('div');
  main.className = 'msg-main';

  if (state.editing && state.editing.convId === state.currentId && state.editing.index === index) {
    main.appendChild(editMessageEl(content, index));
  } else {
    const body = document.createElement('div');
    body.className = 'content';
    body.innerHTML = renderMarkdown(content || '');
    main.appendChild(body);

    if (index !== null) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';

      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.onclick = () => copyText(content || '', copy);
      actions.appendChild(copy);

      if (role === 'user') {
        const edit = document.createElement('button');
        edit.textContent = 'Edit';
        edit.onclick = () => startEditMessage(index);
        actions.appendChild(edit);
      }

      if (role === 'assistant') {
        const regen = document.createElement('button');
        regen.textContent = 'Regenerate';
        regen.onclick = () => regenerateFrom(index);
        actions.appendChild(regen);
      }

      main.appendChild(actions);
    }
  }

  msg.appendChild(avatar);
  msg.appendChild(main);
  wrap.appendChild(msg);
  return wrap;
}

function editMessageEl(content, index) {
  const wrap = document.createElement('div');
  wrap.className = 'edit-box';

  const textarea = document.createElement('textarea');
  textarea.value = content || '';

  const actions = document.createElement('div');
  actions.className = 'edit-actions';

  const save = document.createElement('button');
  save.className = 'ghost-btn';
  save.textContent = 'Save & send';
  save.onclick = () => saveEditedMessage(index, textarea.value);

  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => {
    state.editing = null;
    renderMessages();
  };

  actions.appendChild(save);
  actions.appendChild(cancel);
  wrap.appendChild(textarea);
  wrap.appendChild(actions);
  setTimeout(() => textarea.focus(), 0);
  return wrap;
}

function startEditMessage(index) {
  if (state.controller) return;
  const c = current();
  if (!c || !c.messages[index] || c.messages[index].role !== 'user') return;
  state.editing = { convId: c.id, index };
  renderMessages();
}

function saveEditedMessage(index, value) {
  const c = current();
  const text = value.trim();
  if (!c || !text || state.controller) return;
  c.messages = c.messages.slice(0, index);
  c.messages.push({ role: 'user', content: text });
  if (index === 0) {
    c.title = text.slice(0, 40);
    $('convTitle').textContent = c.title;
  }
  c.updated = Date.now();
  state.editing = null;
  persist(c);
  renderConvList();
  renderMessages();
  generateAssistant(c);
}

function regenerateFrom(index) {
  const c = current();
  if (!c || state.controller || !c.messages[index] || c.messages[index].role !== 'assistant') return;
  const prior = c.messages.slice(0, index);
  if (!prior.some((m) => m.role === 'user')) {
    hint('Nothing to regenerate yet.', true);
    return;
  }
  c.messages = prior;
  c.updated = Date.now();
  persist(c);
  renderMessages();
  generateAssistant(c);
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

async function sendLegacy() {
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

async function send() {
  const text = input.value.trim();
  if (!text || state.controller) return;
  const c = current();
  if (!c) return;

  hint('');
  state.editing = null;
  c.messages.push({ role: 'user', content: text });
  if (c.messages.length === 1 || !c.title || c.title === 'New chat') {
    c.title = text.slice(0, 40);
    $('convTitle').textContent = c.title;
  }
  c.updated = Date.now();
  persist(c);

  input.value = '';
  input.style.height = 'auto';
  renderConvList();
  renderMessages();
  await generateAssistant(c);
}

async function generateAssistant(c) {
  if (!c || state.controller) return;
  if (state.currentId !== c.id) selectConvo(c.id);

  const box = $('messages');
  if (box.querySelector('.empty-state')) box.innerHTML = '';

  const asstWrap = messageEl('assistant', '');
  const asstBody = asstWrap.querySelector('.content');
  asstBody.classList.add('cursor-blink');
  box.appendChild(asstWrap);
  box.scrollTop = box.scrollHeight;

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
      const content = 'Warning: ' + detail;
      c.messages.push({ role: 'assistant', content });
      c.updated = Date.now();
      persist(c);
      renderMessages();
      hint(res.status === 429 ? 'Daily budget reached - resets at UTC midnight.' : detail, true);
      return;
    }

    acc = await readSSE(res, (delta) => {
      acc += delta;
      asstBody.innerHTML = renderMarkdown(acc);
      asstBody.classList.add('cursor-blink');
      box.scrollTop = box.scrollHeight;
    });

    c.messages.push({ role: 'assistant', content: acc || '(empty response)' });
    c.updated = Date.now();
    persist(c);
    renderMessages();
    refreshBudget();
  } catch (e) {
    if (e.name === 'AbortError') {
      if (acc) {
        c.messages.push({ role: 'assistant', content: acc });
        c.updated = Date.now();
        persist(c);
      }
      renderMessages();
      hint('Stopped.');
    } else {
      const content = 'Warning: ' + e.message;
      c.messages.push({ role: 'assistant', content });
      c.updated = Date.now();
      persist(c);
      renderMessages();
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

function inviteText(member, password) {
  const url = (state.base || location.origin) + '/chat';
  return [
    'Team Chat login',
    'URL: ' + url,
    'Username: ' + (member.username || ''),
    password ? 'Password: ' + password : 'Password: ask an admin to reset it if needed',
  ].join('\n');
}

function copyText(text, button) {
  navigator.clipboard?.writeText(text);
  if (!button) return;
  const old = button.textContent;
  button.textContent = 'copied';
  setTimeout(() => (button.textContent = old), 1200);
}

function renderTeam(members) {
  const tbody = $('teamRows');
  if (!members.length) { tbody.innerHTML = '<tr><td colspan="6">No members yet. Add one above.</td></tr>'; return; }
  tbody.innerHTML = '';
  for (const m of members) {
    const tr = document.createElement('tr');
    const isMe = m.key === (state.memberKey || state.key);
    const u = m.usage || {};
    tr.innerHTML =
      '<td>' + escapeHtml(m.name) + (m.admin ? ' <span class="tag admin">admin</span>' : '') +
        (isMe ? ' <span class="tag">you</span>' : '') + '</td>' +
      '<td class="keycell"><span>@' + escapeHtml(m.username || 'not-set') + '</span> ' +
        '<button data-invite="' + escapeHtml(m.key) + '">invite</button></td>' +
      '<td>' + (u.requests || 0) + ' req · $' + (u.costUsd || 0).toFixed(4) + '</td>' +
      '<td>' + lim(m.dailyRequests, ' req') + ' · ' + lim(m.dailyCostUsd, '$') + '</td>' +
      '<td><span class="tag ' + (m.disabled ? 'off' : 'on') + '">' + (m.disabled ? 'disabled' : 'active') + '</span></td>' +
      '<td class="row-actions">' +
        '<button data-reset="' + escapeHtml(m.key) + '">Reset password</button>' +
        '<button data-copy-key="' + escapeHtml(m.key) + '">Copy key</button>' +
        '<button data-toggle="' + escapeHtml(m.key) + '" data-dis="' + (m.disabled ? '0' : '1') + '">' +
          (m.disabled ? 'Enable' : 'Disable') + '</button>' +
        '<button class="danger" data-del="' + escapeHtml(m.key) + '">Remove</button>' +
      '</td>';
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('[data-invite]').forEach((b) =>
    b.addEventListener('click', () => {
      const member = members.find((m) => m.key === b.dataset.invite);
      if (member) copyText(inviteText(member), b);
    }));
  tbody.querySelectorAll('[data-copy-key]').forEach((b) =>
    b.addEventListener('click', () => copyText(b.dataset.copyKey, b)));
  tbody.querySelectorAll('[data-reset]').forEach((b) =>
    b.addEventListener('click', () => resetPassword(b.dataset.reset)));
  tbody.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => patchMember(b.dataset.toggle, { disabled: b.dataset.dis === '1' })));
  tbody.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => removeMember(b.dataset.del)));
}

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: $('mName').value.trim(),
    username: $('mUsername').value.trim(),
    password: $('mPassword').value.trim(),
    dailyRequests: $('mReq').value === '' ? null : Number($('mReq').value),
    dailyCostUsd: $('mCost').value === '' ? null : Number($('mCost').value),
    admin: $('mAdmin').checked,
  };
  if (!body.username) delete body.username;
  if (!body.password) delete body.password;
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
    const invite = inviteText(data.member, data.member.password);
    banner.innerHTML =
      'Member created. Share this login with them:<br><code>' +
      escapeHtml(invite).replace(/\n/g, '<br>') +
      '</code><br><button id="copyNewInvite" class="ghost-btn" type="button">Copy invite</button>';
    $('copyNewInvite').addEventListener('click', (ev) => copyText(invite, ev.target));
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

async function resetPassword(key) {
  if (!confirm('Reset this member password? The old password will stop working.')) return;
  try {
    const res = await fetch(api('/admin/team/' + encodeURIComponent(key) + '/password/reset'), {
      method: 'POST',
      headers: authHeaders(),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error?.message || 'Failed'); return; }
    const invite = inviteText(data.member, data.member.password);
    const banner = $('newKeyBanner');
    banner.innerHTML =
      'Password reset. Share this updated login:<br><code>' +
      escapeHtml(invite).replace(/\n/g, '<br>') +
      '</code><br><button id="copyNewInvite" class="ghost-btn" type="button">Copy invite</button>';
    banner.classList.remove('hidden');
    $('copyNewInvite').addEventListener('click', (ev) => copyText(invite, ev.target));
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
