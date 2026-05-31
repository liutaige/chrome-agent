// src/sidepanel/sidepanel.ts
var $ = (id) => document.getElementById(id);
var el = (html) => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.firstElementChild;
};
var chatArea = $("chat-area");
var userInput = $("user-input");
var sendBtn = $("send-btn");
var stopBtn = $("stop-btn");
var settingsBtn = $("settings-btn");
var statusDot = $("status-dot");
var statusText = $("status-text");
var tokenBadge = $("token-badge");
var costDisplay = $("cost-display");
var contextChips = $("context-chips");
var onboarding = $("onboarding");
var tabTitle = $("tab-title");
var tabUrl = $("tab-url");
var tabFavicon = $("tab-favicon");
var port = null;
var streamingBubble = null;
var streamingText = "";
var running = false;
var tabId = 0;
var heartbeatAt = 0;
var heartbeatTimer = null;
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? 0;
  updateTabInfo(tab);
  connectBg();
  bindEvents();
  chrome.tabs.onActivated.addListener(async ({ tabId: newTabId }) => {
    tabId = newTabId;
    const tab2 = await chrome.tabs.get(newTabId);
    updateTabInfo(tab2);
  });
  chrome.tabs.onUpdated.addListener((updatedTabId, changeInfo, tab2) => {
    if (updatedTabId === tabId && (changeInfo.title || changeInfo.url || changeInfo.favIconUrl)) {
      updateTabInfo(tab2);
    }
  });
  const checkInterval = setInterval(() => {
    const demoTask = window.__demoTask;
    const done = window.__onboardingDone;
    if (demoTask) {
      clearInterval(checkInterval);
      delete window.__demoTask;
      hideOnboarding();
      userInput.value = demoTask;
      submit();
      return;
    }
    if (done) {
      clearInterval(checkInterval);
      delete window.__onboardingDone;
      hideOnboarding();
      renderWelcome();
      return;
    }
  }, 300);
  const { hasApiKey } = await checkKeyStatus();
  if (!hasApiKey) showOnboarding();
  else hideOnboarding();
}
function updateTabInfo(tab) {
  if (tab?.title) {
    tabTitle.textContent = tab.title;
    tabTitle.title = tab.title;
  }
  if (tab?.url) {
    try {
      tabUrl.textContent = new URL(tab.url).hostname;
    } catch {
      tabUrl.textContent = tab.url;
    }
  }
  if (tab?.favIconUrl) {
    tabFavicon.src = tab.favIconUrl;
    tabFavicon.style.display = "";
  }
}
function connectBg() {
  try {
    port = chrome.runtime.connect({ name: "sidepanel" });
    port.onMessage.addListener(handleBgMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connectBg, 1500);
    });
    heartbeatAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (Date.now() - heartbeatAt > 5e3 && running) {
        setStatus("thinking", "\u4ECD\u5728\u5DE5\u4F5C\u4E2D...");
      }
    }, 2e3);
    port.postMessage({ type: "sidepanel_ready", tabId });
  } catch {
    setStatus("idle", "\u540E\u53F0\u672A\u8FDE\u63A5");
  }
}
function bindEvents() {
  sendBtn.addEventListener("click", submit);
  stopBtn.addEventListener("click", stop);
  settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.getElementById("theme-btn")?.addEventListener("click", () => window.cycleTheme());
  userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") stop();
  });
  userInput.addEventListener("input", () => {
    userInput.style.height = "auto";
    userInput.style.height = Math.min(userInput.scrollHeight, 72) + "px";
  });
}
function showOnboarding() {
  onboarding.classList.remove("hidden");
  window._onStep = 1;
  window._updateOnboarding?.();
}
function hideOnboarding() {
  onboarding.classList.add("hidden");
}
async function checkKeyStatus() {
  return new Promise((resolve) => {
    const p = chrome.runtime.connect({ name: "settings" });
    p.postMessage({ type: "get_api_key_status" });
    p.onMessage.addListener((msg) => {
      if (msg.type === "api_key_status") {
        const doubaoReady = msg.doubaoApiKeyConfigured && msg.doubaoEndpointConfigured;
        resolve({
          hasApiKey: msg.deepseekConfigured,
          deepseek: msg.deepseekConfigured,
          doubao: doubaoReady
        });
        p.disconnect();
      }
    });
    setTimeout(() => {
      resolve({ hasApiKey: false });
      p.disconnect();
    }, 2e3);
  });
}
function renderWelcome() {
  chatArea.innerHTML = `
    <div class="welcome-view">
      <div class="w-icon">\u2726</div>
      <h2>\u4F60\u597D\uFF0C\u6211\u80FD\u5E2E\u4F60\u64CD\u4F5C\u6D4F\u89C8\u5668</h2>
      <p>\u7528\u81EA\u7136\u8BED\u8A00\u544A\u8BC9\u6211\u8981\u505A\u4EC0\u4E48<br>\u6211\u4F1A\u81EA\u52A8\u6D4F\u89C8\u3001\u70B9\u51FB\u3001\u8F93\u5165\u3001\u641C\u7D22</p>
      <div class="w-actions">
        <button class="quick-task" data-task="\u603B\u7ED3\u5F53\u524D\u9875\u9762\u7684\u4E3B\u8981\u5185\u5BB9">\u{1F4C4} \u603B\u7ED3\u672C\u9875\u5185\u5BB9</button>
        <button class="quick-task" data-task="\u627E\u5230\u9875\u9762\u4E2D\u7684\u641C\u7D22\u6846\uFF0C\u641C\u7D22\u6700\u8FD1\u7684 AI \u65B0\u95FB">\u{1F50D} \u641C\u7D22\u5185\u5BB9</button>
        <button class="quick-task" data-task="\u5E2E\u6211\u586B\u5199\u9875\u9762\u4E2D\u7B2C\u4E00\u4E2A\u8868\u5355">\u270F\uFE0F \u586B\u5199\u8868\u5355</button>
      </div>
    </div>`;
  chatArea.querySelectorAll(".quick-task").forEach((btn) => {
    btn.addEventListener("click", () => {
      const task = btn.getAttribute("data-task");
      if (task) {
        userInput.value = task;
        submit();
      }
    });
  });
}
function submit() {
  const text = userInput.value.trim();
  if (!text || running || !port) return;
  running = true;
  updateInputState();
  addUserMessage(text);
  userInput.value = "";
  userInput.style.height = "auto";
  const welcome = chatArea.querySelector(".welcome-view");
  if (welcome) welcome.remove();
  port.postMessage({ type: "user_task", tabId, text });
  setStatus("thinking", "\u6B63\u5728\u7406\u89E3\u9875\u9762...");
}
function stop() {
  if (!running) return;
  running = false;
  updateInputState();
  finishStreaming();
  setStatus("idle", "\u5DF2\u505C\u6B62");
  if (port) {
    try {
      port.postMessage({ type: "stop_task", tabId });
    } catch {
    }
  }
  try {
    chrome.runtime.sendMessage({ action: "stop_task", tabId, protocolVersion: 1, requestId: "stop" });
  } catch {
  }
}
function handleBgMessage(msg) {
  heartbeatAt = Date.now();
  switch (msg.type) {
    case "stream_chunk":
      handleStreamChunk(msg);
      break;
    case "step_status":
      handleStepStatus(msg);
      break;
    case "cost_update":
      handleCostUpdate(msg);
      break;
    case "ask_user_prompt":
      handleAskUser(msg);
      break;
  }
}
function handleStreamChunk(msg) {
  if (!streamingBubble) {
    streamingBubble = createBubble("agent", "");
    streamingBubble.classList.add("streaming");
    streamingText = "";
  }
  if (msg.delta) {
    streamingText += msg.delta;
    streamingBubble.textContent = streamingText;
    scrollDown();
  }
  if (msg.done || msg.status === "completed") finishStreaming();
}
function finishStreaming() {
  if (streamingBubble) {
    const mdHtml = renderMarkdown(streamingText);
    streamingBubble.innerHTML = mdHtml;
    streamingBubble.classList.remove("streaming");
    updateMdLinks(streamingBubble);
    streamingBubble = null;
    streamingText = "";
  }
}
function updateMdLinks(bubble) {
  bubble.querySelectorAll("a[href]").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener");
  });
}
function handleStepStatus(msg) {
  finishStreaming();
  const detail = msg.detail ?? "";
  const status = msg.status ?? "thinking";
  addStepLine(status, detail);
  setStatus(status, detail);
  if (status === "completed" || status === "errored") {
    running = false;
    updateInputState();
    setStatus("idle", "\u5C31\u7EEA");
    tokenBadge.textContent = "\u2014";
    costDisplay.textContent = "";
    if (status === "errored") addSystemMessage(`\u2717 ${detail}`);
  }
}
function handleCostUpdate(msg) {
  const tokens = msg.totalTokens;
  const cost = msg.estimatedCost;
  tokenBadge.textContent = tokens > 0 ? `${(tokens / 1e3).toFixed(1)}k tok` : "\u2014";
  costDisplay.textContent = cost > 0 ? `\xA5${cost.toFixed(4)}` : "";
}
function handleAskUser(msg) {
  setStatus("waiting", "\u9700\u8981\u4F60\u7684\u786E\u8BA4");
  const question = msg.question ?? "\u786E\u8BA4\u7EE7\u7EED\uFF1F";
  const card = el(`<div class="msg agent"><div class="ask-card">
    <p>${escHtml(question)}</p>
    <div class="ask-actions">
      <button class="ask-btn" data-answer="yes">\u662F</button>
      <button class="ask-btn" data-answer="no">\u5426</button>
      <button class="ask-btn" data-answer="custom">\u81EA\u5B9A\u4E49...</button>
    </div>
  </div></div>`);
  chatArea.appendChild(card);
  scrollDown();
  card.querySelectorAll(".ask-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const answer = btn.getAttribute("data-answer");
      if (answer === "custom") {
        const custom = prompt("\u8BF7\u8F93\u5165\u4F60\u7684\u56DE\u590D\uFF1A");
        if (custom === null) return;
        sendAskResponse(custom);
      } else {
        sendAskResponse(answer);
      }
      card.querySelectorAll(".ask-btn").forEach((b) => {
        b.disabled = true;
        b.style.opacity = "0.5";
      });
    });
  });
}
function sendAskResponse(answer) {
  port?.postMessage({ type: "ask_user_response", tabId, answer });
  addUserMessage(answer);
  setStatus("thinking", "\u7EE7\u7EED...");
}
function addUserMessage(text) {
  chatArea.appendChild(el(`<div class="msg user"><div class="msg-bubble">${escHtml(text)}</div></div>`));
  scrollDown();
}
function createBubble(role, text) {
  const div = el(`<div class="msg ${role}"><div class="msg-bubble">${escHtml(text)}</div></div>`);
  chatArea.appendChild(div);
  return div.querySelector(".msg-bubble");
}
function addSystemMessage(text) {
  chatArea.appendChild(el(`<div class="msg system"><div class="msg-bubble">${escHtml(text)}</div></div>`));
  scrollDown();
}
function addStepLine(status, text) {
  const icons = {
    thinking: "\u{1F4AD}",
    executing: "\u26A1",
    completed: "\u2713",
    errored: "\u2717",
    waiting_user: "\u23F3"
  };
  const cls = {
    thinking: "thinking",
    executing: "executing",
    completed: "done",
    errored: "fail",
    waiting_user: "wait"
  };
  chatArea.appendChild(el(`<div class="step-line">
    <span class="dot ${cls[status] ?? "thinking"}"></span>
    <span>${icons[status] ?? ""} ${escHtml(text)}</span>
  </div>`));
  scrollDown();
}
function setStatus(status, text) {
  statusDot.className = `status-dot ${status}`;
  statusText.textContent = text;
}
function updateInputState() {
  sendBtn.disabled = running;
  stopBtn.disabled = !running;
  userInput.disabled = running;
  userInput.placeholder = running ? "Agent \u6267\u884C\u4E2D..." : "\u544A\u8BC9 Chrome Agent \u4F60\u60F3\u505A\u4EC0\u4E48...";
}
function scrollDown() {
  requestAnimationFrame(() => {
    chatArea.scrollTop = chatArea.scrollHeight;
  });
}
function escHtml(s) {
  const d = document.createElement("span");
  d.textContent = s;
  return d.innerHTML;
}
var THEMES = ["dark", "light", "cream"];
var currentTheme = localStorage.getItem("chrome-agent-theme") || "dark";
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("chrome-agent-theme", theme);
  currentTheme = theme;
  const icons = { dark: "\u{1F319}", light: "\u2600\uFE0F", cream: "\u{1F4DC}" };
  const btn = document.getElementById("theme-btn");
  if (btn) btn.textContent = icons[theme] ?? "\u{1F313}";
}
window.cycleTheme = () => {
  const idx = THEMES.indexOf(currentTheme);
  const next = THEMES[(idx + 1) % THEMES.length];
  applyTheme(next);
};
function renderMarkdown(text) {
  let html = text;
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre><code>${escHtml(code.trim())}</code></pre>`;
  });
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/^[\-\*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  html = html.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/^---$/gm, "<hr>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  html = "<p>" + html + "</p>";
  html = html.replace(/<p><\/p>/g, "");
  html = html.replace(/<p>(<h[1-4]|<ul|<ol|<pre|<blockquote|<hr)/g, "$1");
  html = html.replace(/(<\/h[1-4]>|<\/ul>|<\/ol>|<\/pre>|<\/blockquote>|<\/hr>)<\/p>/g, "$1");
  return html;
}
document.addEventListener("DOMContentLoaded", () => {
  applyTheme(currentTheme);
  init();
});
