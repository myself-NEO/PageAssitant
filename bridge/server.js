// PageAssistant bridge: a localhost-only HTTP server the Chrome extension talks to.

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTurn } from './claude.js';
import { buildUserMessage, MAX_CONVERSATION_CHARS } from './prompt.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PAGEASSISTANT_PORT) || 8765;
const MODEL = process.env.PAGEASSISTANT_MODEL || undefined;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

// --- token -----------------------------------------------------------------

const TOKEN_FILE = join(here, '.token');
function loadToken() {
  if (existsSync(TOKEN_FILE)) {
    const t = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  }
  const t = randomBytes(24).toString('hex');
  writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  return t;
}
const TOKEN = loadToken();

function tokenOk(req) {
  const header = req.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- origin ----------------------------------------------------------------

// Browsers always send Origin on cross-origin requests. Only extension pages may
// call the bridge; ordinary web pages are refused. Requests with no Origin come
// from local non-browser clients (curl, tests) and still need the token.
function originOk(req) {
  const origin = req.headers.origin;
  return !origin || origin.startsWith('chrome-extension://');
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !origin.startsWith('chrome-extension://')) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

// --- conversations ---------------------------------------------------------

// conversationId -> { sessionId, chars, nextId, sent: Map<key, { title, active }> }
// `sent` records every page the model has been given in this conversation, so a
// page is sent once and later turns only mention what was added or switched off.
const conversations = new Map();

function sourceKey(s) {
  return createHash('sha1').update(`${s.url}\n${s.text.length}`).digest('hex');
}

// --- helpers ---------------------------------------------------------------

function sendJson(req, res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(req) });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cleanSources(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .slice(0, 30)
    .map((s) => ({
      url: String(s.url ?? ''),
      title: String(s.title ?? '') || String(s.url ?? ''),
      text: s.text,
    }));
}

function cleanSelection(raw) {
  if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) return undefined;
  return { title: String(raw.title ?? ''), text: raw.text };
}

// --- routes ----------------------------------------------------------------

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(req, res, err.status ?? 400, { error: err.status ? err.message : 'Invalid JSON' });
  }

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) return sendJson(req, res, 400, { error: 'question is required' });
  const conversationId = typeof body.conversationId === 'string' && body.conversationId
    ? body.conversationId
    : randomBytes(8).toString('hex');
  const sources = cleanSources(body.sources);

  // Work out what changed since the last turn: pages the model has not seen are
  // sent in full; pages it has seen are only switched off or back on by title.
  const convo = conversations.get(conversationId) ?? { chars: 0, nextId: 1, sent: new Map() };
  const sentAfter = new Map([...convo.sent].map(([k, v]) => [k, { ...v }]));
  const current = new Set();
  const newSources = [];
  const switchedOn = [];
  let nextId = convo.nextId;
  for (const s of sources) {
    const k = sourceKey(s);
    if (current.has(k)) continue;
    current.add(k);
    const known = sentAfter.get(k);
    if (!known) newSources.push({ ...s, key: k, id: nextId++ });
    else if (!known.active) { known.active = true; switchedOn.push(known.title); }
  }
  const switchedOff = [];
  for (const [k, v] of sentAfter) {
    if (v.active && !current.has(k)) { v.active = false; switchedOff.push(v.title); }
  }

  const built = buildUserMessage(question, {
    newSources,
    switchedOff,
    switchedOn,
    selection: cleanSelection(body.selection),
    budget: MAX_CONVERSATION_CHARS - convo.chars,
  });
  const { message } = built;
  for (const s of built.sent) sentAfter.set(s.key, { title: s.title, active: true });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    ...corsHeaders(req),
  });
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('meta', {
    conversationId,
    sent: built.sent.map((s) => s.title),
    truncated: built.truncated,
    skipped: built.skipped,
    active: [...sentAfter.values()].filter((v) => v.active).length,
  });

  const turn = runTurn({
    message,
    sessionId: convo.sessionId,
    model: MODEL,
    onDelta: (text) => send('delta', { text }),
    onTool: (tool) => send('tool', tool),
  });

  // If the panel is closed or the user hits Stop, end the Claude process too.
  res.on('close', () => { if (!res.writableEnded) turn.cancel(); });

  try {
    const result = await turn.done;
    // Recorded only after a successful turn, so a failed turn resends its pages.
    conversations.set(conversationId, {
      sessionId: result.sessionId,
      chars: convo.chars + built.chars,
      nextId,
      sent: sentAfter,
    });
    // If nothing streamed (older CLI output shape), deliver the whole answer at once.
    if (!result.streamed && result.text) send('delta', { text: result.text });
    send('done', {});
  } catch (err) {
    if (err.message !== 'cancelled') send('error', { message: err.message });
  } finally {
    res.end();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (!originOk(req)) return sendJson(req, res, 403, { error: 'Origin not allowed' });

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(req, res, 200, { ok: true, authorized: tokenOk(req) });
  }

  if (!tokenOk(req)) return sendJson(req, res, 401, { error: 'Missing or wrong token' });

  if (req.method === 'POST' && url.pathname === '/chat') return handleChat(req, res);

  if (req.method === 'POST' && url.pathname === '/reset') {
    try {
      const { conversationId } = JSON.parse(await readBody(req));
      conversations.delete(conversationId);
    } catch { /* nothing to reset */ }
    return sendJson(req, res, 200, { ok: true });
  }

  sendJson(req, res, 404, { error: 'Not found' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Is the bridge already running?`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`PageAssistant bridge listening on http://${HOST}:${PORT}`);
  console.log(`Token (paste into the extension's settings): ${TOKEN}`);
  console.log('Leave this window open while you use the extension. Ctrl+C to stop.');
});
