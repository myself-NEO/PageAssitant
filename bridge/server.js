// PageAssistant bridge: a localhost-only HTTP server the Chrome extension talks to.

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTurn } from './claude.js';
import { buildUserMessage } from './prompt.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PAGEASSISTANT_PORT) || 8765;
const MODEL = process.env.PAGEASSISTANT_MODEL || undefined;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

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

// conversationId -> { sessionId, sourcesKey }
const conversations = new Map();

function sourcesKey(sources) {
  const h = createHash('sha1');
  for (const s of sources) h.update(`${s.url}\n${s.text?.length ?? 0}\n${s.selection ?? ''}\n`);
  return h.digest('hex');
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
    .slice(0, 20)
    .map((s) => ({
      url: String(s.url ?? ''),
      title: String(s.title ?? ''),
      text: s.text,
      selection: typeof s.selection === 'string' && s.selection.trim() ? s.selection : undefined,
    }));
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

  // Send the page text only when the model has not already seen this exact set.
  const convo = conversations.get(conversationId) ?? {};
  const key = sources.length ? sourcesKey(sources) : convo.sourcesKey;
  const includeSources = sources.length > 0 && key !== convo.sourcesKey;
  const { message, truncated } = buildUserMessage(question, includeSources ? sources : []);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    ...corsHeaders(req),
  });
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('meta', { conversationId, sourcesSent: includeSources, truncated });

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
    conversations.set(conversationId, { sessionId: result.sessionId, sourcesKey: key });
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
