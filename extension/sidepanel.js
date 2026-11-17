// PageAssistant side panel: chat UI, page extraction, and the bridge connection.

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), messages: $('messages'), empty: $('empty'), banner: $('banner'),
  form: $('form'), input: $('input'), send: $('send'),
  usePage: $('usePage'), pageChip: $('pageChip'), pageTitle: $('pageTitle'),
  newChat: $('newChat'), openSettings: $('openSettings'), settings: $('settings'),
  token: $('token'), port: $('port'), saveSettings: $('saveSettings'), settingsMsg: $('settingsMsg'),
};

const state = {
  token: '',
  port: 8765,
  conversationId: crypto.randomUUID(),
  busy: false,
  abort: null,
  bridge: 'unknown', // 'ok' | 'unauthorized' | 'down' | 'unknown'
};

const base = () => `http://127.0.0.1:${state.port}`;
const authHeaders = () => ({ Authorization: `Bearer ${state.token}` });

// --- settings --------------------------------------------------------------

async function loadSettings() {
  const saved = await chrome.storage.local.get(['token', 'port']);
  state.token = saved.token ?? '';
  state.port = saved.port ?? 8765;
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
  els.pageTitle.textContent = ok ? (tab.title || tab.url) : "This page can't be read (web-only answers)";
  els.pageChip.title = ok ? tab.url : '';
}

chrome.tabs.onActivated.addListener(refreshPageChip);
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.status === 'complete' || change.title || change.url)) refreshPageChip();
});
chrome.windows.onFocusChanged.addListener(refreshPageChip);

/** Returns { source } or { reason } when the page could not be read. */
async function extractPage() {
  const tab = await activeTab();
  if (!canRead(tab)) return { reason: "This page can't be read by extensions, so the answer uses the web only." };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['vendor/Readability.js', 'extract.js'],
    });
    const page = results?.[0]?.result;
    if (!page?.text) return { reason: 'No readable text was found on this page (it may be a PDF or an image), so the answer uses the web only.' };
    return { source: page };
  } catch (err) {
    return { reason: `Could not read this page (${err.message}), so the answer uses the web only.` };
  }
}

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

  const sources = [];
  if (els.usePage.checked && !els.usePage.disabled) {
    const { source, reason } = await extractPage();
    if (source) sources.push(source);
    else addEl('note', reason);
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
      body: JSON.stringify({ conversationId: state.conversationId, question, sources }),
      signal: state.abort.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(res.status === 401 ? 'The bridge rejected the token. Check Settings.' : (body.error || `Bridge error ${res.status}`));
    }

    await readSse(res, (name, data) => {
      if (name === 'meta') {
        if (data.sourcesSent && sources[0]) {
          const how = sources[0].selection ? 'page + your selection' : 'page';
          addEl('note source', `Using ${how}: ${sources[0].title || sources[0].url}${data.truncated ? ' (long page, truncated)' : ''}`);
          els.messages.appendChild(thinking); // keep "Thinking…" last
        }
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
  await Promise.all([checkBridge(), refreshPageChip()]);
  setInterval(checkBridge, 5000);
  els.input.focus();
})();
