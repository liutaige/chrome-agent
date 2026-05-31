# Chrome Agent

<div align="center">

**AI-powered browser automation — understand pages, tag elements, and operate.**

*Like Claude in Chrome, but with your own API keys and models.*

</div>

---

## What it does

Chrome Agent is a browser extension that lets you control your browser with natural language. Tell it what you want, and it reads the page, clicks buttons, types text, scrolls, and navigates — all by itself.

```
You: "Open YouTube, search for NileRed, and open his latest video"
Agent: [Navigates to YouTube] → [Types in search box] → [Clicks search] → [Clicks first result]
```

### How it works

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

1. **Extract** — Reads the page's text structure (titles, buttons, forms, links) into a compact semantic skeleton
2. **Think** — DeepSeek decides what to do next: read more, tag elements, click, type, scroll
3. **Tag (on-demand)** — If the page is ambiguous, overlays small numbered badges on ~3-10 specific elements
4. **See** — Takes a screenshot of just the tagged area, sends it to Doubao Vision to identify the right element
5. **Act** — Clicks, types, scrolls, navigates
6. **Repeat** — Feeds the result back to DeepSeek and continues

---

## Installation

### 1. Load the extension

```
git clone https://github.com/YOUR_USERNAME/chrome-agent.git
cd chrome-agent
```

Then in Chrome:
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `chrome-agent` folder

### 2. Configure API keys

Right-click the extension icon → **Options**, or click the ⚙ icon in the Side Panel.

| Service | What you need | Where to get it |
|---------|--------------|-----------------|
| **DeepSeek** (required) | API Key (`sk-xxx`) | [platform.deepseek.com](https://platform.deepseek.com) → API Keys |
| **Doubao Vision** (optional) | ARK API Key + Endpoint ID (`ep-xxx`) | [Volcengine ARK Console](https://console.volcengine.com/ark) → API Key + Online Inference → Create Endpoint |

> **Model recommendation for Doubao:** Create an inference endpoint with `Doubao-1.5-vision-pro-32k`.

Without Doubao, the agent works in text-only mode — slightly less accurate for ambiguous pages, but still functional.

### 3. Open the Side Panel

Click the extension icon in the toolbar, or press the Side Panel shortcut. The agent is ready.

---

## Features

- **Text-first, vision-on-demand** — Reads page structure as text first (cheap). Only uses vision when necessary.
- **Streaming thoughts** — Watch the agent think in real-time. Every decision is transparent.
- **Stop anytime** — Click ■ or press Esc to cancel mid-task.
- **Ask user** — The agent asks for confirmation when uncertain. You stay in control.
- **Multi-step ReAct loop** — Think → Perceive → Act → Verify, up to 50 steps per task.
- **Error self-healing** — Aborted operations auto-retry (3 attempts). Circuit breaker for API failures.
- **Content filter pipeline** — PII, CSRF tokens, passwords, and credit card numbers are stripped before sending to AI.
- **API key encryption** — Keys stored with AES-256-GCM + PBKDF2 (600K iterations).
- **Three themes** — Dark, Light, and Cream. Your preference is remembered.
- **Markdown rendering** — Agent responses render headings, code blocks, lists, and links.

---

## Build from source

```bash
npm install
node build.mjs        # one-time build
node build.mjs --watch  # watch mode
```

The build bundles three entry points with [esbuild](https://esbuild.github.io/):
- `content/content.js` — injected into every page
- `background/worker.js` — Service Worker (orchestrator)
- `sidepanel/sidepanel.js` — Side Panel UI

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
│   │   ├── worker.ts          #   Entry point + message routing + Side Panel
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
│   └── *.test.ts              #   154 tests
│
└── icons/                     # Extension icons
```

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Extension framework | Chrome Manifest V3 |
| Language | TypeScript |
| Build | esbuild |
| Test | Vitest + jsdom |
| AI (decision) | DeepSeek V4 Pro (via API) |
| AI (vision) | Doubao Vision (via ARK API) |
| UI | Vanilla HTML/CSS/TS with liquid glass design |

---

## Privacy & Security

- **No data leaves your browser** except the text you explicitly send to AI APIs
- API keys are encrypted with AES-256-GCM before storage
- Content filter strips PII, passwords, CSRF tokens, and credit card numbers
- Screenshots require per-domain authorization
- `execute_javascript` requires explicit user approval for each call
- All extension messages validated: sender ID, action whitelist, parameter bounds

---

## License

MIT

---

*Built with DeepSeek, Doubao, and Claude Code.*
