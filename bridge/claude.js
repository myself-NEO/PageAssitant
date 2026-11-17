// Runs one turn through the Claude Code CLI and reports progress via callbacks.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT } from './prompt.js';

const here = dirname(fileURLToPath(import.meta.url));
const WORKDIR = join(here, 'workdir');
mkdirSync(WORKDIR, { recursive: true });

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const TOOLS = 'WebSearch,WebFetch';

/**
 * @param {object} opts
 * @param {string} opts.message        user turn (written to stdin)
 * @param {string} [opts.sessionId]    Claude Code session to resume
 * @param {string} [opts.model]        model alias or id
 * @param {(text: string) => void} opts.onDelta
 * @param {(tool: {name: string, detail?: string}) => void} opts.onTool
 * @returns {{ done: Promise<{sessionId?: string, text: string}>, cancel: () => void }}
 */
export function runTurn({ message, sessionId, model, onDelta, onTool }) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--system-prompt', SYSTEM_PROMPT,
    // Only these two built-in tools exist for the child; nothing can run code or touch files.
    '--tools', TOOLS,
    '--allowedTools', TOOLS,
    // Anything that would still ask for permission is denied rather than left hanging.
    '--permission-prompts', 'none',
    // No CLAUDE.md, skills, plugins, hooks or MCP servers from the user's setup.
    '--safe-mode',
    '--strict-mcp-config',
    '--disable-slash-commands',
  ];
  if (model) args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);

  const child = spawn(CLAUDE_BIN, args, {
    cwd: WORKDIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    child.kill();
  };

  const done = new Promise((resolve, reject) => {
    let newSessionId = sessionId;
    let streamedText = '';
    let finalText = '';
    let resultError = null;
    let sawResult = false;
    let stderr = '';
    let buffer = '';
    // Tool input arrives as partial JSON; collect it per content block to show the query.
    const toolBlocks = new Map();

    const handle = (evt) => {
      if (evt.session_id) newSessionId = evt.session_id;

      if (evt.type === 'stream_event') {
        const e = evt.event ?? {};
        if (e.type === 'content_block_start') {
          const block = e.content_block ?? {};
          if (block.type === 'tool_use' || block.type === 'server_tool_use') {
            toolBlocks.set(e.index, { name: block.name, json: '' });
          }
        } else if (e.type === 'content_block_delta') {
          const d = e.delta ?? {};
          if (d.type === 'text_delta' && d.text) {
            streamedText += d.text;
            onDelta(d.text);
          } else if (d.type === 'input_json_delta' && toolBlocks.has(e.index)) {
            toolBlocks.get(e.index).json += d.partial_json ?? '';
          }
        } else if (e.type === 'content_block_stop' && toolBlocks.has(e.index)) {
          const t = toolBlocks.get(e.index);
          toolBlocks.delete(e.index);
          let detail;
          try {
            const input = JSON.parse(t.json || '{}');
            detail = input.query ?? input.url;
          } catch { /* partial or empty input: show the tool name only */ }
          onTool({ name: t.name, detail });
        }
      } else if (evt.type === 'result') {
        sawResult = true;
        if (evt.is_error || (evt.subtype && evt.subtype !== 'success')) {
          resultError = evt.result || evt.error || evt.subtype || 'Claude Code reported an error';
        } else {
          finalText = evt.result ?? '';
        }
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { /* not JSON: ignore */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });

    child.on('error', (err) => {
      reject(new Error(
        err.code === 'ENOENT'
          ? `Could not start "${CLAUDE_BIN}". Is Claude Code installed and on PATH?`
          : err.message
      ));
    });

    child.on('close', (code) => {
      if (cancelled) return reject(new Error('cancelled'));
      if (resultError) return reject(new Error(String(resultError)));
      if (!sawResult) {
        return reject(new Error(stderr.trim() || `Claude Code exited with code ${code} and no result`));
      }
      resolve({ sessionId: newSessionId, text: streamedText || finalText, streamed: Boolean(streamedText) });
    });

    child.stdin.on('error', () => { /* child exited early; 'close' reports it */ });
    child.stdin.end(message, 'utf8');
  });

  return { done, cancel };
}
