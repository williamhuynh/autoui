# autoui — talk a prototype into existence

Live transcription that automatically builds a working UI prototype while you speak.
Inspired by the "Claude was transcribing my customer call and building the features in
real time" demo: you talk (or someone on a call talks), the transcript streams to
**Claude Fable** (`claude-fable-5`), and the prototype on the right half of the screen
rebuilds itself every few seconds to match what's being said.

## How it works

```
mic ──▶ Web Speech API (in-browser, live transcription)
            │  finalized utterances
            ▼
     build loop (debounced ~2s of silence, max 15s between builds)
            │  full transcript + previous prototype
            ▼
     POST /api/build ──▶ Claude Fable (streaming) ──▶ single-file HTML
            │  SSE deltas
            ▼
     live preview iframe (paints progressively while the model streams)
```

Each build sends the whole transcript plus the previous prototype, and asks the model
to *evolve* it rather than start over — so the design stays stable as the call goes on.

## Which version can I use?

| Your credential | Single-file `autoui.html` | Server (`npm start`) |
|---|---|---|
| API key (`sk-ant-api03-…`), org allows browser CORS | ✅ | ✅ |
| API key, org blocks browser CORS | ❌ (CORS) | ✅ |
| Claude Code subscription token (`sk-ant-oat01-…`) | ❌ (CORS + token is Claude-Code-gated) | ✅ |

The browser-direct single-file build only works if your Anthropic **organization allows
CORS** *and* you use an API key. Many orgs (and all subscription/`setup-token`
credentials) block browser CORS — you'll see `"CORS requests are not allowed for this
Organization"`. In that case, **run the server version**, which calls the API
server-to-server and has no CORS or token-gating limitation.

> Subscription tokens from `claude setup-token` are scoped to Claude Code: the server
> automatically prepends the required Claude Code identity to satisfy that gate. Using a
> Claude Code token outside Claude Code is a gray area under Anthropic's terms — for
> anything beyond personal experimentation, prefer a normal API key.

## Single-file version (no server)

[`autoui.html`](autoui.html) is the whole app in one file — open it and go. The browser
calls the Anthropic API directly (the API supports browser-direct access via the
`anthropic-dangerous-direct-browser-access` header), so there is nothing to deploy.

1. Open `autoui.html` in Chrome/Edge — **serve it over http(s)** for mic access
   (`python3 -m http.server` in the repo dir works; `file://` may block the mic,
   though typed input still works).
2. Paste your credential into the key bar — an OAuth token (`sk-ant-oat01-…`, from
   `claude setup-token`) or an API key (`sk-ant-api03-…`). It's stored in that
   browser's localStorage. To bake it into the file instead, set `EMBEDDED_KEY`
   at the top of the `<script>` — but note anyone with a copy of the file can
   then spend your tokens.
3. Talk.

Verified end-to-end with `scripts/verify.mjs` (headless Chrome): the full pipeline
against a mocked API, and both auth header styles against the real API.

## Setup (server version)

```bash
npm install
```

Provide credentials — either works:

| Option | How |
|---|---|
| Claude subscription (OAuth) | Run `claude setup-token` on a machine with Claude Code, then `export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...` |
| API key | `export ANTHROPIC_API_KEY=sk-ant-api03-...` (from the Claude Console) |

You can also put either line in a `.env` file next to `server.js` (see `.env.example`).

## Run

```bash
npm start
# → http://localhost:3000
```

Open it in **Chrome or Edge** (the Web Speech API isn't in Firefox/Safari to the same
degree), click **Start listening**, allow the microphone, and start talking about a
product. To demo a customer call, just put the call on speaker near your mic.

No microphone handy? Type lines into the box under the transcript — each one is
treated as a spoken utterance and triggers the same build loop.

Controls:
- **Reset** — keeps the transcript but throws away the prototype, so the next build starts fresh.
- **Open ↗** — opens the current prototype in its own tab (it's a self-contained HTML file).

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` | — | OAuth bearer token auth |
| `ANTHROPIC_API_KEY` | — | API-key auth (takes precedence) |
| `AUTOUI_MODEL` | `claude-fable-5` | Model used for builds |
| `AUTOUI_EFFORT` | `medium` | `low` for faster rebuilds, `high` for fancier prototypes |
| `PORT` | `3000` | Server port |

## Notes & limitations

- Speech recognition runs in the browser via the Web Speech API; in Chrome the audio
  is processed by Google's speech service. It requires `localhost` or HTTPS.
- The preview iframe is sandboxed (`allow-scripts allow-forms allow-modals allow-popups`).
- Builds are sequential: if you keep talking during a build, a follow-up build is
  queued automatically as soon as the current one finishes.
- Each build is a full streaming Fable request with the whole transcript + previous
  prototype, so long calls cost real tokens. Set `AUTOUI_EFFORT=low` to cut cost/latency.
