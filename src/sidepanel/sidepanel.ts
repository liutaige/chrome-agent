// ============================================================================
// Chrome Agent — Side Panel
// ============================================================================

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild as HTMLElement; };

// ─── DOM refs ──────────────────────────────────────────────────────

const chatArea    = $('chat-area');
const userInput   = $<HTMLTextAreaElement>('user-input');
const sendBtn     = $<HTMLButtonElement>('send-btn');
const stopBtn     = $<HTMLButtonElement>('stop-btn');
const settingsBtn = $<HTMLButtonElement>('settings-btn');
const statusDot   = $('status-dot');
const statusText  = $('status-text');
const tokenBadge  = $('token-badge');
const costDisplay = $('cost-display');
const contextChips = $('context-chips');
const onboarding = $('onboarding');
const tabTitle   = $('tab-title');
const tabUrl     = $('tab-url');
const tabFavicon = $<HTMLImageElement>('tab-favicon');

// ─── State ──────────────────────────────────────────────────────────

let port: chrome.runtime.Port | null = null;
let streamingBubble: HTMLElement | null = null;
let streamingText = '';
let running = false;
let tabId = 0;
let heartbeatAt = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let onboardingStep = 0;

// ─── Init ───────────────────────────────────────────────────────────

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? 0;
  updateTabInfo(tab);

  connectBg();
  bindEvents();

  // Listen for tab changes
  chrome.tabs.onActivated.addListener(async ({ tabId: newTabId }) => {
    tabId = newTabId;
    const tab = await chrome.tabs.get(newTabId);
    updateTabInfo(tab);
  });
  chrome.tabs.onUpdated.addListener((updatedTabId, changeInfo, tab) => {
    if (updatedTabId === tabId && (changeInfo.title || changeInfo.url || changeInfo.favIconUrl)) {
      updateTabInfo(tab);
    }
  });

  // Poll for inline onboarding signals (set by index.html inline <script>)
  const checkInterval = setInterval(() => {
    const demoTask = (window as any).__demoTask as string | undefined;
    const done = (window as any).__onboardingDone as boolean | undefined;

    if (demoTask) {
      clearInterval(checkInterval);
      delete (window as any).__demoTask;
      hideOnboarding();
      userInput.value = demoTask;
      submit();
      return;
    }

    if (done) {
      clearInterval(checkInterval);
      delete (window as any).__onboardingDone;
      hideOnboarding();
      renderWelcome();
      return;
    }
  }, 300);

  // Check if onboarding is needed
  const { hasApiKey } = await checkKeyStatus();
  if (!hasApiKey) showOnboarding();
  else hideOnboarding();
}

function updateTabInfo(tab: chrome.tabs.Tab | undefined) {
  if (tab?.title) {
    tabTitle.textContent = tab.title;
    tabTitle.title = tab.title;
  }
  if (tab?.url) {
    try {
      tabUrl.textContent = new URL(tab.url).hostname;
    } catch { tabUrl.textContent = tab.url; }
  }
  if (tab?.favIconUrl) {
    tabFavicon.src = tab.favIconUrl;
    tabFavicon.style.display = '';
  }
}

function connectBg() {
  try {
    port = chrome.runtime.connect({ name: 'sidepanel' });
    port.onMessage.addListener(handleBgMessage);
    port.onDisconnect.addListener(() => { port = null; setTimeout(connectBg, 1500); });
    heartbeatAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (Date.now() - heartbeatAt > 5000 && running) {
        setStatus('thinking', '仍在工作中...');
      }
    }, 2000);
    port.postMessage({ type: 'sidepanel_ready', tabId });
  } catch { setStatus('idle', '后台未连接'); }
}

function bindEvents() {
  sendBtn.addEventListener('click', submit);
  stopBtn.addEventListener('click', stop);
  settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('theme-btn')?.addEventListener('click', () => (window as any).cycleTheme());
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') stop();
  });
  userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 72) + 'px';
  });
}

// ─── Onboarding ─────────────────────────────────────────────────────
// Onboarding UI is handled by inline <script> in index.html.
// This function just shows/hides the overlay and handles API key check.

function showOnboarding() {
  onboarding.classList.remove('hidden');
  // Reset inline onboarding state
  (window as any)._onStep = 1;
  (window as any)._updateOnboarding?.();
}

function hideOnboarding() {
  onboarding.classList.add('hidden');
}

async function checkKeyStatus() {
  return new Promise<{ hasApiKey: boolean; deepseek?: boolean; doubao?: boolean }>(resolve => {
    const p = chrome.runtime.connect({ name: 'settings' });
    p.postMessage({ type: 'get_api_key_status' });
    p.onMessage.addListener((msg) => {
      if (msg.type === 'api_key_status') {
        const doubaoReady = msg.doubaoApiKeyConfigured && msg.doubaoEndpointConfigured;
        resolve({
          hasApiKey: msg.deepseekConfigured,
          deepseek: msg.deepseekConfigured,
          doubao: doubaoReady,
        });
        p.disconnect();
      }
    });
    setTimeout(() => { resolve({ hasApiKey: false }); p.disconnect(); }, 2000);
  });
}

// ─── Welcome / Empty ────────────────────────────────────────────────

function renderWelcome() {
  chatArea.innerHTML = `
    <div class="welcome-view">
      <div class="w-icon">✦</div>
      <h2>你好，我能帮你操作浏览器</h2>
      <p>用自然语言告诉我要做什么<br>我会自动浏览、点击、输入、搜索</p>
      <div class="w-actions">
        <button class="quick-task" data-task="总结当前页面的主要内容">📄 总结本页内容</button>
        <button class="quick-task" data-task="找到页面中的搜索框，搜索最近的 AI 新闻">🔍 搜索内容</button>
        <button class="quick-task" data-task="帮我填写页面中第一个表单">✏️ 填写表单</button>
      </div>
    </div>`;

  chatArea.querySelectorAll('.quick-task').forEach(btn => {
    btn.addEventListener('click', () => {
      const task = btn.getAttribute('data-task');
      if (task) { userInput.value = task; submit(); }
    });
  });
}

// ─── Send / Stop ────────────────────────────────────────────────────

function submit() {
  const text = userInput.value.trim();
  if (!text || running || !port) return;

  running = true;
  updateInputState();

  addUserMessage(text);
  userInput.value = '';
  userInput.style.height = 'auto';

  // Remove welcome if present
  const welcome = chatArea.querySelector('.welcome-view');
  if (welcome) welcome.remove();

  port.postMessage({ type: 'user_task', tabId, text });
  setStatus('thinking', '正在理解页面...');
}

function stop() {
  if (!running) return;
  running = false;
  updateInputState();
  finishStreaming();
  setStatus('idle', '已停止');

  // Try port first, fallback to sendMessage
  if (port) {
    try { port.postMessage({ type: 'stop_task', tabId }); } catch {}
  }
  try {
    chrome.runtime.sendMessage({ action: 'stop_task', tabId, protocolVersion: 1, requestId: 'stop' });
  } catch {}
}

// ─── Background Messages ────────────────────────────────────────────

function handleBgMessage(msg: Record<string, unknown>) {
  heartbeatAt = Date.now();

  switch (msg.type) {
    case 'stream_chunk':
      handleStreamChunk(msg);
      break;
    case 'step_status':
      handleStepStatus(msg);
      break;
    case 'cost_update':
      handleCostUpdate(msg);
      break;
    case 'ask_user_prompt':
      handleAskUser(msg);
      break;
  }
}

// ─── Streaming ──────────────────────────────────────────────────────

function handleStreamChunk(msg: Record<string, unknown>) {
  if (!streamingBubble) {
    streamingBubble = createBubble('agent', '');
    streamingBubble.classList.add('streaming');
    streamingText = '';
  }
  if (msg.delta) {
    streamingText += msg.delta;
    streamingBubble.textContent = streamingText;
    scrollDown();
  }
  if (msg.done || msg.status === 'completed') finishStreaming();
}

function finishStreaming() {
  if (streamingBubble) {
    // Render Markdown now that streaming is complete
    const mdHtml = renderMarkdown(streamingText);
    streamingBubble.innerHTML = mdHtml;
    streamingBubble.classList.remove('streaming');
    updateMdLinks(streamingBubble);
    streamingBubble = null;
    streamingText = '';
  }
}

// Open markdown links in new tabs
function updateMdLinks(bubble: HTMLElement) {
  bubble.querySelectorAll('a[href]').forEach(a => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener');
  });
}

// ─── Step Status ────────────────────────────────────────────────────

function handleStepStatus(msg: Record<string, unknown>) {
  finishStreaming();
  const detail = (msg.detail as string) ?? '';
  const status = (msg.status as string) ?? 'thinking';

  addStepLine(status, detail);
  setStatus(status, detail);

  if (status === 'completed' || status === 'errored') {
    running = false;
    updateInputState();
    setStatus('idle', '就绪');
    tokenBadge.textContent = '—';
    costDisplay.textContent = '';
    if (status === 'errored') addSystemMessage(`✗ ${detail}`);
  }
}

// ─── Cost ───────────────────────────────────────────────────────────

function handleCostUpdate(msg: Record<string, unknown>) {
  const tokens = msg.totalTokens as number;
  const cost = msg.estimatedCost as number;
  tokenBadge.textContent = tokens > 0 ? `${(tokens / 1000).toFixed(1)}k tok` : '—';
  costDisplay.textContent = cost > 0 ? `¥${cost.toFixed(4)}` : '';
}

// ─── Ask User ───────────────────────────────────────────────────────

function handleAskUser(msg: Record<string, unknown>) {
  setStatus('waiting', '需要你的确认');
  const question = (msg.question as string) ?? '确认继续？';
  const card = el(`<div class="msg agent"><div class="ask-card">
    <p>${escHtml(question)}</p>
    <div class="ask-actions">
      <button class="ask-btn" data-answer="yes">是</button>
      <button class="ask-btn" data-answer="no">否</button>
      <button class="ask-btn" data-answer="custom">自定义...</button>
    </div>
  </div></div>`);
  chatArea.appendChild(card);
  scrollDown();

  card.querySelectorAll('.ask-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const answer = btn.getAttribute('data-answer')!;
      if (answer === 'custom') {
        const custom = prompt('请输入你的回复：');
        if (custom === null) return;
        sendAskResponse(custom);
      } else {
        sendAskResponse(answer);
      }
      card.querySelectorAll('.ask-btn').forEach(b => {
        (b as HTMLButtonElement).disabled = true;
        (b as HTMLButtonElement).style.opacity = '0.5';
      });
    });
  });
}

function sendAskResponse(answer: string) {
  port?.postMessage({ type: 'ask_user_response', tabId, answer });
  addUserMessage(answer);
  setStatus('thinking', '继续...');
}

// ─── UI Helpers ─────────────────────────────────────────────────────

function addUserMessage(text: string) {
  chatArea.appendChild(el(`<div class="msg user"><div class="msg-bubble">${escHtml(text)}</div></div>`));
  scrollDown();
}

function createBubble(role: string, text: string): HTMLElement {
  const div = el(`<div class="msg ${role}"><div class="msg-bubble">${escHtml(text)}</div></div>`);
  chatArea.appendChild(div);
  return div.querySelector('.msg-bubble')!;
}

function addSystemMessage(text: string) {
  chatArea.appendChild(el(`<div class="msg system"><div class="msg-bubble">${escHtml(text)}</div></div>`));
  scrollDown();
}

function addStepLine(status: string, text: string) {
  const icons: Record<string, string> = {
    thinking: '💭', executing: '⚡', completed: '✓', errored: '✗', waiting_user: '⏳',
  };
  const cls: Record<string, string> = {
    thinking: 'thinking', executing: 'executing', completed: 'done', errored: 'fail', waiting_user: 'wait',
  };
  chatArea.appendChild(el(`<div class="step-line">
    <span class="dot ${cls[status] ?? 'thinking'}"></span>
    <span>${icons[status] ?? ''} ${escHtml(text)}</span>
  </div>`));
  scrollDown();
}

function setStatus(status: string, text: string) {
  statusDot.className = `status-dot ${status}`;
  statusText.textContent = text;
}

function updateInputState() {
  sendBtn.disabled = running;
  stopBtn.disabled = !running;
  userInput.disabled = running;
  userInput.placeholder = running ? 'Agent 执行中...' : '告诉 Chrome Agent 你想做什么...';
}

function scrollDown() {
  requestAnimationFrame(() => { chatArea.scrollTop = chatArea.scrollHeight; });
}

function escHtml(s: string) {
  const d = document.createElement('span'); d.textContent = s; return d.innerHTML;
}

// ─── Theme ──────────────────────────────────────────────────────────

const THEMES = ['dark', 'light', 'cream'];
let currentTheme = (localStorage.getItem('chrome-agent-theme') as string) || 'dark';

function applyTheme(theme: string) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('chrome-agent-theme', theme);
  currentTheme = theme;
  // Update button icon
  const icons: Record<string, string> = { dark: '🌙', light: '☀️', cream: '📜' };
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = icons[theme] ?? '🌓';
}
(window as any).cycleTheme = () => {
  const idx = THEMES.indexOf(currentTheme);
  const next = THEMES[(idx + 1) % THEMES.length];
  applyTheme(next);
};

// ─── Markdown Renderer (lightweight) ─────────────────────────────────

function renderMarkdown(text: string): string {
  let html = text;

  // Fenced code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m: string, _lang: string, code: string) => {
    return `<pre><code>${escHtml(code.trim())}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Headings
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Unordered lists
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Blockquotes
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');

  // Wrap in paragraphs
  html = '<p>' + html + '</p>';

  // Clean up empty paragraphs
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<p>(<h[1-4]|<ul|<ol|<pre|<blockquote|<hr)/g, '$1');
  html = html.replace(/(<\/h[1-4]>|<\/ul>|<\/ol>|<\/pre>|<\/blockquote>|<\/hr>)<\/p>/g, '$1');

  return html;
}

// ─── Start ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  applyTheme(currentTheme);
  init();
});
