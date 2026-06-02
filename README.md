# Chrome Agent

<div align="center">

**AI-powered browser automation — understand pages, tag elements, and operate.**

*Like Claude in Chrome, but with your own API keys and models.*

</div>

---

## What it does

Chrome Agent is a Chrome extension that controls your browser with natural language. Tell it what you want — it reads the page, clicks buttons, types text, scrolls, and navigates on its own.

```
You: "Open YouTube, search for NileRed, and open his latest video"
Agent: [Navigates to YouTube] → [Types in search box] → [Clicks search] → [Clicks first result]
```

---

## How it works

```
┌──────────┐     ┌──────────────┐     ┌───────────────┐
│ DeepSeek │────▶│ Background   │────▶│ Content Script │
│ (Think)  │◀────│ Worker       │◀────│ (Act)          │
│          │     │ (Orchestrate)│     │               │
│  text    │     │              │     │  extract DOM   │
│  decide  │     │  screenshot  │     │  tag elements  │
│  plan    │     │  navigate    │     │  click/type    │
└──────────┘     └──────┬───────┘     └───────────────┘
                        │
                  ┌─────▼──────┐
                  │  Doubao    │
                  │  (Vision)  │  ← only when the page is ambiguous
                  │            │
                  │  screenshot│
                  │  → number  │
                  └────────────┘
```

Three components work together in a **ReAct loop** (Reasoning + Acting):

1. **Extract** — Content Script walks the DOM and produces a compact semantic skeleton (titles, buttons, forms, links). This is cheap — only a few hundred tokens.
2. **Think** — DeepSeek reads the skeleton and decides the next action: extract more, tag elements, click, type, scroll, or ask the user.
3. **Tag** *(on-demand)* — If the page is ambiguous, the agent overlays small numbered badges on ~3-10 specific elements instead of flooding the whole page.
4. **See** — A screenshot of just the tagged area goes to Doubao Vision, which returns the target element's number.
5. **Act** — The Content Script resolves the element (using multi-strategy locators, not stale DOM references) and performs the action.
6. **Repeat** — The result feeds back to DeepSeek, and the loop continues until the task is done (up to 50 steps).

**Why text-first?** Text tokens are orders of magnitude cheaper than images. Vision only kicks in when the page layout is genuinely ambiguous.

---

## Architecture

### Design principles

- **Cost minimal, capability decoupled** — DeepSeek V4 Pro as the decision brain (strongest Agent capability at this price), Doubao Vision as the perception eye (fills DeepSeek's vision gap, low cost, strong Chinese UI recognition)
- **Understand first, then operate** — Don't blindly tag everything. Extract the page's semantic skeleton first so DeepSeek can "speed-read" the page. Only tag elements when localization is needed.
- **Conversational collaboration** — The AI can ask questions back, confirm with the user, and accept mid-task corrections.
- **Transparency = trust** — Stream the AI's reasoning in real-time so the user always knows what the agent is doing.

### Page semantic extraction

The Content Script uses a **TreeWalker** to traverse the DOM and produces a structured semantic skeleton before any tags are placed:

- Page title, main navigation items
- Form areas (input labels, placeholders, names)
- Interactive elements (button text, link text, key attributes)
- Structural regions (lists, cards, search results)

This summary is only a few hundred tokens — cheap to send to DeepSeek. The extractor runs in the **MAIN world** for full DOM access, but never returns live Element references.

**SPA & dynamic content handling:**
- `MutationObserver` for incremental updates instead of one-shot snapshots
- `IntersectionObserver` to detect lazy-loaded containers entering the viewport
- Viewport-limited extraction: TreeWalker capped at 200 interactive elements (depth 15), yields to the event loop every 50 elements, aborts and returns partial results if extraction exceeds 1 second
- Pages with >5000 total elements automatically switch to viewport-only mode
- Pseudo-element content (`::before`/`::after`) read via `getComputedStyle`

### Content filter pipeline

Before any semantic data leaves the browser, it passes through 6 filter stages:

1. **Exclude sensitive inputs** — strip `input[type=hidden]`, `input[type=password]`, `input[type=file]`
2. **Filter security-named patterns** — replace values whose name/id matches `token|nonce|csrf|session|auth|key|secret|password|verification|credential|__` with `[filtered]`
3. **URL sanitization** — keep only origin + pathname, strip all query parameters and fragments
4. **PII removal** — regex-strip email addresses, phone numbers, 13-19 digit sequences (credit cards/account numbers)
5. **Token budget truncation** — cap total output at ~2000 tokens, allocated proportionally across categories
6. **Normalized text only** — never send raw HTML or attribute values (except name/placeholder/aria-label)

### On-demand tagging

Traditional Set-of-Mark floods the entire page with numbered badges. Chrome Agent does it on demand:

1. DeepSeek reads the semantic skeleton and decides *which region* needs visual confirmation
2. It calls `tag_elements(selector="input, button", region="search area")`
3. The Content Script tags only ~3-10 elements in that region
4. A cropped screenshot of the tagged area goes to Doubao Vision
5. Doubao returns the number, and the action executes

**Rendering implementation:**
- **Shadow DOM isolation** (`attachShadow({mode: 'closed'})`) — tag styles cannot be affected by page CSS, and tags cannot leak into the page
- **Z-index scanning** — injector scans the page for the highest z-index and places tags at `max(pageMax + 1, 2147483647)`
- **Position sync** — coordinate calculation via `getBoundingClientRect() + window.scrollY`; scroll/resize events trigger `requestAnimationFrame` updates; no polling when idle
- **Non-interference** — tags set `pointer-events: none` and `aria-hidden="true"`

### Tag mapping stability

DOM element references are fragile in SPAs (React re-renders, Turbo/HTMX innerHTML swaps, SPA route changes, infinite scroll). Instead of storing `tag → Element`, the injector stores `tag → multi-strategy locator`. Before each action, the executor re-resolves the locator in priority order:

1. `[data-tag-id="@N"]` — custom attribute injected at tag time (most reliable)
2. **CSS path** — `:nth-child()` path from the nearest stable ancestor (one with `id` or `data-*`)
3. **Attribute selector** — `tagName[type="..."][aria-label="..."][name="..."]`
4. **Text fragment** — tagName + first 100 chars of textContent (weakest, last resort)

Additional safeguards: 30-second TTL auto-expiry, content fingerprint verification (first 200 chars of outerHTML + boundingRect), `document.contains()` heartbeat check, MutationObserver on the tagged element's container.

### ReAct loop & error recovery

Each step in the loop is idempotent — crash at any point, resume without duplicate side effects. The system tracks executed actions to avoid re-running non-idempotent operations (e.g., clicking a toggle 3 times would flip it back and forth).

**Error self-healing:**
- After each action, re-query the DOM for the latest state (never trust cached references)
- Record a state checksum (DOM text content hash) before each action; compare after — if nothing changed, retrying is pointless
- Exponential backoff: 1s → 2s → 4s, max 3 retries per operation
- Same verification failure 3 times → circuit breaker triggers `ask_user` instead of looping
- Global cap of 10 tool calls per ReAct cycle

**Navigation guard:**
- Before sending a message, check `tab.pendingUrl` — abort if the tab is navigating
- Cache `tab.documentId` before sending, re-check after receiving — discard the response if the document changed
- Listen to `chrome.webNavigation.onBeforeNavigation` to proactively abort pending operations

### Screenshot privacy

- **Per-domain authorization + session memory** — first screenshot on a new domain triggers a consent prompt (showing the domain and purpose). Once granted, subsequent screenshots on that domain skip the prompt. Switching to a new domain re-triggers consent.
- **Bounding-box crop** — the screenshot is cropped to the union bounding box of all tagged elements +20px margin. Coordinates come from the already-computed tag positions in the Content Script — no natural language coordinate parsing.
- **DPR correction** — reads `window.devicePixelRatio`; model-returned coordinates are divided by DPR to get CSS-pixel coordinates
- **Overlay hiding** — fixed-position overlays (sticky headers, cookie banners) are temporarily hidden during capture and restored afterward
- **PNG lossless** — forced `format: 'png'` to avoid JPEG compression making small elements illegible

### API key encryption

Keys are never stored in plaintext. The full key derivation chain:

1. Generate a random 32-byte **DEK** (Data Encryption Key) — used for AES-256-GCM encrypt/decrypt of the API key
2. Generate a random 16-byte **salt** — stored in plaintext in `chrome.storage.local` (salt doesn't need secrecy; it prevents rainbow table attacks and cross-device key reuse)
3. Derive a 256-bit **KEK** (Key Encryption Key) via PBKDF2 with `chrome.runtime.id` as the input password + the random salt, 600,000 SHA-256 iterations
4. Wrap the DEK with KEK using AES-KW; store the wrapped result in `chrome.storage.local`
5. Encrypt the API key with DEK using AES-256-GCM; store ciphertext + 12-byte IV in `chrome.storage.local`
6. At runtime: read salt → PBKDF2 derive KEK → unwrap DEK → decrypt API key → plaintext lives only in `chrome.storage.session` (memory, cleared on browser close)

The extension ID is fixed in `manifest.json` (via the `"key"` field) so that unpacked reloads don't change the ID and break decryption.

### Streaming message protocol

The Side Panel displays AI reasoning in real-time via three message types:

| Message | Structure | Purpose |
|---------|-----------|---------|
| `stream_chunk` | `{ type, step_id, delta, sequence, done }` | Incremental text with sequence numbers to prevent ordering issues |
| `step_status` | `{ type, step_id, status, detail }` | Operation progress: thinking / executing / completed / errored |
| `heartbeat` | `{ type, timestamp }` | Sent every 2s; Side Panel shows "Still working..." if 5s pass without a message |

Text is displayed as plaintext during streaming and Markdown-rendered only on `done: true` (prevents unclosed code block flickering). If the Side Panel is closed and reopened, partial responses are recovered from `chrome.storage.session`.

### Storage model

| Tier | Storage | Contents | Lifetime |
|------|---------|----------|----------|
| **Runtime** | `chrome.storage.session` | ReAct loop execution state, active port IDs, temporary UI state | Browser session |
| **Persistent** | `chrome.storage.local` (+ `unlimitedStorage`) | Full conversation history, completed loop summaries, user preferences, encrypted API keys, page snapshot cache | Cross-session |
| **Optional sync** | `chrome.storage.sync` or backend | Cross-device conversation sync | On demand |

Every meaningful state transition writes to both session and local simultaneously. On Service Worker startup, state is restored from local. Local storage evicts conversations older than 30 days, keeping the 20 most recent.

---

## Features

### Capabilities
- **Click, type, scroll, hover, press keys** — full keyboard and mouse control
- **Wait for conditions** — element visible, text present, network idle, DOM stable
- **Handle dialogs** — alert/confirm/prompt without deadlocking the page
- **Execute JavaScript** — read-only sandboxed JS for edge cases (requires per-call user approval)

### Transparency
- **Streaming thoughts** — watch the agent reason in real-time; every decision is visible
- **Ask user** — the agent pauses and asks for confirmation when uncertain
- **Stop anytime** — click ■ or press Esc to cancel mid-task

### Resilience
- **Error self-healing** — failed operations auto-retry with exponential backoff (3 attempts), then circuit-break and ask the user
- **Navigation guard** — detects page navigations mid-operation and aborts safely
- **Idempotent steps** — crash at any point, resume without duplicate side effects

### Privacy & Security
- **Content filter pipeline** — strips PII, CSRF tokens, passwords, credit card numbers before anything leaves your browser
- **API key encryption** — AES-256-GCM + PBKDF2 (600K iterations); decrypted keys live only in session memory
- **Per-domain screenshot authorization** — first screenshot on a new domain requires consent
- **Message validation** — every cross-context message checked: sender ID, action whitelist, parameter bounds

---

## Installation

### Step 1 — Open a terminal

| Platform | What to open |
|----------|--------------|
| **Windows** | `cmd` (Command Prompt) or `PowerShell` |
| **macOS** | `Terminal` (in `/Applications/Utilities`) |

### Step 2 — Pick a folder

In File Explorer (Windows) or Finder (macOS), navigate to the folder where you want to save the project. Copy the absolute path — for example:

- Windows: `C:\Users\lucasyan\projects`
- macOS: `/Users/lucasyan/projects`

### Step 3 — Navigate there

In the terminal, type `cd` followed by the path you copied:

```bash
cd 'C:\Users\lucasyan\projects'   # Windows
# or
cd '/Users/lucasyan/projects'     # macOS
```

### Step 4 — Clone the repo

In the same terminal window, run:

```bash
git clone https://github.com/liutaige/chrome-agent.git
```

This creates a `chrome-agent` folder in your current directory.

### Step 5 — Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Turn on **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked** in the top bar
4. Select the `chrome-agent` folder you just cloned

### Step 6 — Configure and start

The extension icon will appear in Chrome's toolbar. Click it to open the Side Panel and follow the setup guide to configure your API keys.

---

## Configuration

Right-click the extension icon → **Options**, or click the ⚙ icon in the Side Panel.

| Service | What you need | Where to get it |
|---------|--------------|-----------------|
| **DeepSeek** (required) | API Key (`sk-xxx`) | [platform.deepseek.com](https://platform.deepseek.com) → API Keys |
| **Doubao Vision** (optional) | ARK API Key + Endpoint ID (`ep-xxx`) | [Volcengine ARK Console](https://console.volcengine.com/ark) → API Key + Online Inference → Create Endpoint |

> **Model recommendation for Doubao:** Create an inference endpoint with `Doubao-1.5-vision-pro-32k`.

Without Doubao, the agent works in text-only mode — slightly less accurate for ambiguous pages, but still functional.

---

## Build from source

The repo includes pre-built bundles, so you can load it directly. If you modify the source or want to build yourself:

```bash
cd chrome-agent
npm install
node build.mjs          # one-time build
node build.mjs --watch  # watch mode (auto-rebuild on changes)
```

Three entry points are bundled with [esbuild](https://esbuild.github.io/):
- `content/content.js` — injected into every page
- `background/worker.js` — Service Worker (orchestrator)
- `sidepanel/sidepanel.js` — Side Panel UI

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Extension framework | Chrome Manifest V3 |
| Language | TypeScript |
| Build | esbuild |
| Test | Vitest + jsdom (154 tests) |
| AI (decision) | DeepSeek V4 Pro |
| AI (vision) | Doubao Vision (via ARK API) |
| UI | Vanilla HTML/CSS/TS with liquid glass design |

---

## Project structure

```
chrome-agent/
├── manifest.json              # Chrome MV3 manifest
├── build.mjs                  # esbuild build script
├── package.json
├── tsconfig.json
│
├── src/
│   ├── content/               # Content script (injected into pages)
│   │   ├── content.ts         #   Entry point + Shadow DOM patch
│   │   ├── extractor.ts       #   Semantic extraction engine (TreeWalker)
│   │   ├── injector.ts        #   On-demand tag rendering (Shadow DOM)
│   │   ├── executor.ts        #   Action execution (click/type/scroll)
│   │   ├── dispatcher.ts      #   Message routing + state machine
│   │   └── filter.ts          #   Content filter pipeline (PII/safety)
│   │
│   ├── background/            # Service Worker
│   │   ├── worker.ts          #   Entry point + message routing
│   │   └── react-loop.ts      #   ReAct loop orchestrator
│   │
│   ├── api/                   # AI model clients
│   │   ├── deepseek.ts        #   DeepSeek (streaming + function calling)
│   │   └── doubao.ts          #   Doubao Vision (screenshot → element ID)
│   │
│   ├── sidepanel/             # Side Panel UI
│   │   └── sidepanel.ts       #   Chat UI + streaming + markdown
│   │
│   └── shared/                # Shared modules
│       ├── messages.ts        #   Message protocol (16 action types)
│       ├── validation.ts      #   Message validation + security checks
│       ├── retry.ts           #   Exponential backoff + circuit breaker
│       ├── sandbox.ts         #   execute_javascript sandbox
│       ├── encryption.ts      #   AES-256-GCM key encryption
│       └── storage.ts         #   Three-layer storage model
│
├── sidepanel/                 # Side Panel static files
│   ├── index.html
│   └── sidepanel.css
│
├── settings/                  # Options page
│   ├── index.html
│   └── settings.js
│
├── tests/                     # Test suite (Vitest)
│   ├── fixtures/              #   HTML test fixtures
│   └── *.test.ts
│
└── icons/                     # Extension icons
```

---

## License

MIT

---

*Built with DeepSeek, Doubao, and Claude Code.*
