# PageAssistant

A personal Chrome side-panel assistant that answers questions about the page you have open, and searches the web when the page doesn't cover it. It runs on your Claude Code subscription through a small local bridge; no API key is involved.

```
Chrome side panel  ──►  bridge on 127.0.0.1:8765  ──►  claude -p  (WebSearch + WebFetch only)
```

For personal use on this machine. Usage counts against your Claude subscription limits.

## Setup (once)

1. Make sure Claude Code is installed and logged in (`claude` works in a terminal) and Node 20+ is installed.
2. Start the bridge: double-click `bridge\start.cmd` (or run `node server.js` inside `bridge`). It prints a token.
3. In Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `extension` folder.
4. Click the PageAssistant toolbar icon to open the side panel, open **Settings**, paste the token and save. The dot turns green.

## Daily use

- Start `bridge\start.cmd` and leave its window open.
- Open any page, click the toolbar icon, ask.
- Highlight text on the page before asking to focus the question on it.
- Untick the page chip above the input for a web-only question.
- **New chat** starts a fresh conversation. Closing the panel also clears the chat.

## Notes

- The page text is sent once per conversation, and again if you move to a different page. Follow-ups reuse the same Claude session.
- Pages longer than about 150,000 characters are truncated; the panel says so.
- `chrome://` pages, the Chrome Web Store and Chrome's PDF viewer can't be read by extensions; you get web-only answers there. For local `file://` pages, enable "Allow access to file URLs" on the extension's details page.
- Optional environment variables for the bridge: `PAGEASSISTANT_PORT`, `PAGEASSISTANT_MODEL` (for example `sonnet` for faster, lighter answers), `CLAUDE_BIN`.

## Safety

Web pages are untrusted, so the Claude process the bridge starts can only search and fetch the web: no shell, no file access, no MCP servers, and none of your Claude Code settings or plugins. The bridge listens on localhost only, requires the token in `bridge\.token`, and refuses requests from ordinary web pages.

## Layout

- `extension/` — the Chrome extension (plain JavaScript, no build step). `vendor/` holds Readability 0.5.0, marked 12.0.2 and DOMPurify 3.1.6.
- `bridge/` — the Node server. `server.js` (HTTP, auth, streaming), `claude.js` (runs the CLI), `prompt.js` (system prompt and source formatting).
