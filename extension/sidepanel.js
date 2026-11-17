// PageAssistant side panel: chat UI, page extraction, and the bridge connection.

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), messages: $('messages'), empty: $('empty'), banner: $('banner'),
  form: $('form'), input: $('input'), send: $('send'),
  usePage: $('usePage'), pageChip: $('pageChip'), pageTitle: $('pageTitle'),
  newChat: $('newChat'), openSettings: $('openSettings'), settings: $('settings'),
  token: $('token'), port: $('port'), saveSettings: $('saveSettings'), settingsMsg: $('settingsMsg'),
  sourceCount: $('sourceCount'), pinned: $('pinned'), pinPage: $('pinPage'), addTabs: $('addTabs'),
  tabPicker: $('tabPicker'), tabList: $('tabList'), tickAllTabs: $('tickAllTabs'),
  addSelectedTabs: $('addSelectedTabs'), cancelTabs: $('cancelTabs'), tabMsg: $('tabMsg'),
};

// Keep in step with MAX_SOURCE_CHARS in bridge/prompt.js.
const MAX_SOURCE_CHARS = 150_000;

const state = {
  token: '',
  port: 8765,
  conversationId: crypto.randomUUID(),
  busy: false,
  abort: null,
  bridge: 'unknown', // 'ok' | 'unauthorized' | 'down' | 'unknown'
  // Pages kept as sources: [{ url, title, text, enabled }]. Saved across sessions.
  pinned: [],
  currentUrl: '',
};

const base = () => `http://127.0.0.1:${state.port}`;
const authHeaders = () => ({ Authorization: `Bearer ${state.token}` });

// --- settings --------------------------------------------------------------

async function loadSettings() {
  const saved = await chrome.storage.local.get(['token', 'port', 'pinned']);
  state.token = saved.token ?? '';
  state.port = saved.port ?? 8765;
  state.pinned = Array.isArray(saved.pinned) ? saved.pinned : [];
  els.token.value = state.token;
  els.port.value = state.port;
  if (!state.token) els.settings.hidden = false;
}

els.openSettings.addEventListener('click', () => { els.settings.hidden = !els.settings.hidden; });

els.saveSettings.addEventListener('click', async () => {
  state.token = els.token.value.trim();
  state.port = Number(els.port.value) || 8765;
  await chrome.storage.local.set({ token: state.token, port: state.port });
  await checkBridge();
  els.settingsMsg.textContent = {
    ok: 'Connected.',
    unauthorized: 'Bridge is running, but the token is wrong.',
    down: 'Saved, but the bridge is not reachable.',
  }[state.bridge] ?? '';
  if (state.bridge === 'ok') setTimeout(() => { els.settings.hidden = true; els.settingsMsg.textContent = ''; }, 900);
});

// --- bridge status ---------------------------------------------------------

async function checkBridge() {
  try {
    const res = await fetch(`${base()}/health`, { headers: authHeaders(), signal: AbortSignal.timeout(2500) });
    const body = await res.json();
    state.bridge = body.authorized ? 'ok' : 'unauthorized';
  } catch {
    state.bridge = 'down';
  }
  els.status.className = `dot ${state.bridge === 'ok' ? 'ok' : 'bad'}`;
  const text = {
    ok: '',
    unauthorized: 'The bridge is running but the token is missing or wrong. Open Settings and paste the token the bridge prints.',
    down: 'The bridge is not running. Start it with bridge\\start.cmd, then this will reconnect on its own.',
  }[state.bridge];
  els.status.title = state.bridge === 'ok' ? 'Bridge connected' : text;
  els.banner.textContent = text;
  els.banner.hidden = !text;
}

// --- active page -----------------------------------------------------------

const SCRIPTABLE = /^(https?|file):/;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function canRead(tab) {
  if (!tab?.url || !SCRIPTABLE.test(tab.url)) return false;
  // Chrome blocks extensions on its own store.
  return !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(tab.url);
}

async function refreshPageChip() {
  const tab = await activeTab().catch(() => null);
  const ok = canRead(tab);
  els.pageChip.classList.toggle('unavailable', !ok);
  els.usePage.disabled = !ok;
  els.pageTitle.textContent = ok ? (tab.title || tab.url) : "This page can't be read";
  els.pageChip.title = ok ? tab.url : '';
  state.currentUrl = ok ? tab.url : '';
  els.pinPage.disabled = !ok;
  updateSourceCount();
}

chrome.tabs.onActivated.addListener(refreshPageChip);
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.status === 'complete' || change.title || change.url)) refreshPageChip();
});
chrome.windows.onFocusChanged.addListener(refreshPageChip);

/** Read one tab. Returns { source } or { reason } when it could not be read. */
async function extractTab(tab) {
  if (!canRead(tab)) return { reason: "This page can't be read by extensions." };
  if (tab.discarded) return { reason: 'Chrome has unloaded this tab to save memory; open it once, then add it.' };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['vendor/Readability.js', 'extract.js'],
    });
    const page = results?.[0]?.result;
    if (!page?.text) return { reason: 'No readable text was found (it may be a PDF or an image).' };
    return { source: page };
  } catch (err) {
    return { reason: `Could not read this page (${err.message}).` };
  }
}

// --- pinned sources --------------------------------------------------------

const sameUrl = (a, b) => a.split('#')[0] === b.split('#')[0];

async function savePinned() {
  try {
    await chrome.storage.local.set({ pinned: state.pinned });
  } catch (err) {
    addEl('note error', `Could not save pinned sources (${err.message}).`);
  }
}

function updateSourceCount() {
  const pinnedOn = state.pinned.filter((p) => p.enabled);
  let n = pinnedOn.length;
  const currentCounts = els.usePage.checked && !els.usePage.disabled
    && !pinnedOn.some((p) => sameUrl(p.url, state.currentUrl));
  if (currentCounts) n += 1;
  els.sourceCount.textContent = n === 0 ? 'No sources (web only)' : `${n} source${n === 1 ? '' : 's'} in use`;
}

function renderPinned() {
  els.pinned.replaceChildren(...state.pinned.map((p) => {
    const row = document.createElement('label');
    row.className = 'chip';
    row.title = p.url;

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = p.enabled;
    box.addEventListener('change', () => { p.enabled = box.checked; savePinned(); updateSourceCount(); });

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = p.title || p.url;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = 'Remove this source';
    remove.addEventListener('click', (e) => {
      e.preventDefault();
      state.pinned = state.pinned.filter((x) => x !== p);
      savePinned();
      renderPinned();
    });

    row.append(box, title, remove);
    return row;
  }));
  updateSourceCount();
}

/** Add or refresh a pinned source. Returns true when the text had to be cut. */
function pin(page) {
  const cut = page.text.length > MAX_SOURCE_CHARS;
  const entry = {
    url: page.url,
    title: page.title || page.url,
    text: cut ? page.text.slice(0, MAX_SOURCE_CHARS) : page.text,
    enabled: true,
  };
  const i = state.pinned.findIndex((p) => sameUrl(p.url, page.url));
  if (i === -1) state.pinned.push(entry);
  else state.pinned[i] = entry;
  return cut;
}

els.usePage.addEventListener('change', updateSourceCount);

els.pinPage.addEventListener('click', async () => {
  const { source, reason } = await extractTab(await activeTab());
  if (!source) { addEl('note', reason); scrollDown(true); return; }
  pin(source);
  await savePinned();
  renderPinned();
});

// --- open-tabs picker ------------------------------------------------------

let pickerTabs = [];

els.addTabs.addEventListener('click', async () => {
  if (!els.tabPicker.hidden) { els.tabPicker.hidden = true; return; }
  const tabs = await chrome.tabs.query({ currentWindow: true });
  pickerTabs = tabs.filter(canRead);
  els.tabMsg.textContent = pickerTabs.length ? '' : 'No readable tabs are open in this window.';
  els.tabList.replaceChildren(...pickerTabs.map((tab, i) => {
    const row = document.createElement('label');
    row.className = 'chip';
    row.title = tab.url;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.index = i;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = tab.title || tab.url;
    row.append(box, title);
    if (state.pinned.some((p) => sameUrl(p.url, tab.url))) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'pinned';
      row.append(tag);
    }
    return row;
  }));
  els.tabPicker.hidden = false;
});

els.tickAllTabs.addEventListener('click', () => {
  const boxes = [...els.tabList.querySelectorAll('input')];
  const allOn = boxes.every((b) => b.checked);
  for (const b of boxes) b.checked = !allOn;
});

els.cancelTabs.addEventListener('click', () => { els.tabPicker.hidden = true; });

els.addSelectedTabs.addEventListener('click', async () => {
  const chosen = [...els.tabList.querySelectorAll('input:checked')].map((b) => pickerTabs[Number(b.dataset.index)]);
  if (!chosen.length) { els.tabMsg.textContent = 'Tick at least one tab.'; return; }
  els.addSelectedTabs.disabled = true;
  els.tabMsg.textContent = 'Reading tabs…';
  const failed = [];
  let added = 0;
  for (const tab of chosen) {
    const { source, reason } = await extractTab(tab);
    if (source) { pin(source); added += 1; }
    else failed.push(`${tab.title || tab.url}: ${reason}`);
  }
  await savePinned();
  renderPinned();
  els.addSelectedTabs.disabled = false;
  els.tabPicker.hidden = true;
  if (failed.length) {
    addEl('note', `Added ${added} of ${chosen.length} tabs. Not added: ${failed.join(' | ')}`);
    scrollDown(true);
  }
});

// --- rendering -------------------------------------------------------------

marked.setOptions({ gfm: true, breaks: false });

// Links in answers open in a new tab instead of replacing the panel.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function renderMarkdown(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ['style', 'form', 'input', 'button'] });
}

function nearBottom() {
  const m = els.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
}
function scrollDown(force) {
  if (force || nearBottom()) els.messages.scrollTop = els.messages.scrollHeight;
}

function addEl(className, text) {
  els.empty.hidden = true;
  const el = document.createElement('div');
  el.className = className;
  if (text) el.textContent = text;
  els.messages.appendChild(el);
  return el;
}

const TOOL_LABELS = { WebSearch: 'Searching the web', WebFetch: 'Reading' };

// --- chat ------------------------------------------------------------------

/** Parse a fetch body as server-sent events, calling onEvent(name, data). */
async function readSse(response, onEvent) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let name = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      try { onEvent(name, JSON.parse(data || '{}')); } catch { /* malformed event: skip */ }
    }
  }
}

function setBusy(busy) {
  state.busy = busy;
  els.send.textContent = busy ? 'Stop' : 'Send';
}

async function ask(question) {
  setBusy(true);
  addEl('msg user', question);
  scrollDown(true);

  // Sources for this turn: every ticked pinned page, plus the current tab if it
  // is ticked and not already pinned. Highlighted text on the current tab goes
  // along separately so it works for pinned pages too.
  const sources = state.pinned.filter((p) => p.enabled).map(({ url, title, text }) => ({ url, title, text }));
  let selection;
  const currentIsPinned = sources.some((s) => sameUrl(s.url, state.currentUrl));
  const wantCurrent = els.usePage.checked && !els.usePage.disabled;
  if (wantCurrent || currentIsPinned) {
    const { source, reason } = await extractTab(await activeTab());
    if (source) {
      if (wantCurrent && !sources.some((s) => sameUrl(s.url, source.url))) {
        sources.push({ url: source.url, title: source.title, text: source.text });
      }
      if (source.selection) selection = { title: source.title, text: source.selection };
    } else if (wantCurrent && !currentIsPinned) {
      addEl('note', `${reason} The current tab is left out of this answer.`);
    }
  }

  const thinking = addEl('note', 'Thinking…');
  let answerEl = null;
  let answer = '';
  let frame = 0;
  let failed = false;

  const paint = () => {
    frame = 0;
    if (!answerEl) answerEl = addEl('msg assistant');
    const stick = nearBottom();
    renderMarkdown(answerEl, answer);
    scrollDown(stick);
  };

  state.abort = new AbortController();
  try {
    const res = await fetch(`${base()}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ conversationId: state.conversationId, question, sources, selection }),
      signal: state.abort.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(res.status === 401 ? 'The bridge rejected the token. Check Settings.' : (body.error || `Bridge error ${res.status}`));
    }

    await readSse(res, (name, data) => {
      if (name === 'meta') {
        if (data.sent?.length) {
          addEl('note source', `Added ${data.sent.length === 1 ? 'source' : `${data.sent.length} sources`}: ${data.sent.join(' · ')}`);
        }
        if (selection) addEl('note source', 'Including the text you highlighted.');
        if (data.truncated?.length) addEl('note', `Too long, only the first part was used: ${data.truncated.join(' · ')}`);
        if (data.skipped?.length) {
          addEl('note error', `Left out because this conversation's source limit is full: ${data.skipped.join(' · ')}. Start a new chat with fewer sources ticked to use them.`);
        }
        els.messages.appendChild(thinking); // keep "Thinking…" last
      } else if (name === 'tool') {
        thinking.remove();
        // A tool call ends the current text block; later text starts a new bubble.
        if (frame) { cancelAnimationFrame(frame); paint(); }
        answerEl = null;
        answer = '';
        addEl('note tool', `${TOOL_LABELS[data.name] ?? data.name}${data.detail ? `: ${data.detail}` : '…'}`);
        scrollDown();
      } else if (name === 'delta') {
        thinking.remove();
        answer += data.text;
        if (!frame) frame = requestAnimationFrame(paint);
      } else if (name === 'error') {
        failed = true;
        addEl('note error', data.message);
      }
    });
    if (!failed && !answer && !answerEl) addEl('note', 'No answer came back.');
  } catch (err) {
    if (err.name === 'AbortError') addEl('note', 'Stopped.');
    else {
      addEl('note error', err instanceof TypeError ? 'Could not reach the bridge. Is it running?' : err.message);
      checkBridge();
    }
  } finally {
    thinking.remove();
    if (frame) { cancelAnimationFrame(frame); paint(); }
    state.abort = null;
    setBusy(false);
    scrollDown();
    els.input.focus();
  }
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.busy) { state.abort?.abort(); return; }
  const question = els.input.value.trim();
  if (!question) return;
  els.input.value = '';
  ask(question);
});

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!state.busy) els.form.requestSubmit();
  }
});

els.newChat.addEventListener('click', () => {
  state.abort?.abort();
  fetch(`${base()}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ conversationId: state.conversationId }),
  }).catch(() => {});
  state.conversationId = crypto.randomUUID();
  els.messages.replaceChildren(els.empty);
  els.empty.hidden = false;
  els.input.focus();
});

// --- start -----------------------------------------------------------------

(async () => {
  await loadSettings();
  renderPinned();
  await Promise.all([checkBridge(), refreshPageChip()]);
  setInterval(checkBridge, 5000);
  els.input.focus();
})();
