// ============================================================================
// Chrome Agent — Settings Page
// ============================================================================

const $ = (id) => document.getElementById(id);

// Load saved values
async function loadSettings() {
  const p = chrome.runtime.connect({ name: 'settings' });
  p.postMessage({ type: 'get_api_key_status' });
  p.onMessage.addListener((msg) => {
    if (msg.type === 'api_key_status') {
      if (msg.deepseekConfigured) {
        $('deepseek-key').placeholder = '已配置 (已加密存储)';
      }
      if (msg.doubaoApiKeyConfigured) {
        $('doubao-api-key').placeholder = '已配置 (已加密存储)';
      }
      if (msg.doubaoEndpointConfigured) {
        $('doubao-endpoint').placeholder = '已配置: ' + (msg.doubaoEndpointId || 'ep-xxx');
      }
    }
  });

  // Load block list
  const data = await chrome.storage.local.get(['screenshots:domain_block']);
  renderBlockList(data['screenshots:domain_block'] || []);
}

// Domain block list
function renderBlockList(domains) {
  const container = $('block-list');
  container.innerHTML = domains.map(d =>
    `<span class="domain-tag">${esc(d)} <span class="remove" data-domain="${esc(d)}">×</span></span>`
  ).join('');
  container.querySelectorAll('.remove').forEach(el => {
    el.addEventListener('click', () => removeDomain(el.dataset.domain));
  });
}

async function removeDomain(domain) {
  const data = await chrome.storage.local.get(['screenshots:domain_block']);
  const list = (data['screenshots:domain_block'] || []).filter(d => d !== domain);
  await chrome.storage.local.set({ 'screenshots:domain_block': list });
  renderBlockList(list);
  toast('已移除: ' + domain, 'success');
}

async function addDomain() {
  const domain = $('new-domain').value.trim().toLowerCase();
  if (!domain) return;
  const data = await chrome.storage.local.get(['screenshots:domain_block']);
  const list = data['screenshots:domain_block'] || [];
  if (list.includes(domain)) return toast('已存在', 'error');
  list.push(domain);
  await chrome.storage.local.set({ 'screenshots:domain_block': list });
  renderBlockList(list);
  $('new-domain').value = '';
  toast('已添加: ' + domain, 'success');
}

// Save all
async function saveAll() {
  const deepseekKey = $('deepseek-key').value.trim();
  const doubaoApiKey = $('doubao-api-key').value.trim();
  const doubaoEndpoint = $('doubao-endpoint').value.trim();
  let saved = 0;

  const p = chrome.runtime.connect({ name: 'settings' });

  if (deepseekKey) {
    p.postMessage({ type: 'store_api_key', keyType: 'deepseek', apiKey: deepseekKey });
    $('deepseek-key').value = '';
    $('deepseek-key').placeholder = '已保存 (已加密)';
    saved++;
  }

  if (doubaoApiKey) {
    p.postMessage({ type: 'store_api_key', keyType: 'doubao', apiKey: doubaoApiKey });
    $('doubao-api-key').value = '';
    $('doubao-api-key').placeholder = '已保存 (已加密)';
    saved++;
  }

  if (doubaoEndpoint) {
    if (!doubaoEndpoint.startsWith('ep-')) {
      toast('Endpoint ID 应以 ep- 开头', 'error');
    } else {
      p.postMessage({ type: 'store_doubao_endpoint', endpointId: doubaoEndpoint });
      $('doubao-endpoint').value = '';
      $('doubao-endpoint').placeholder = '已保存: ' + doubaoEndpoint;
      saved++;
    }
  }

  if (saved === 0) {
    toast('没有新的内容需要保存', 'error');
  } else {
    toast(`已保存 ${saved} 项`, 'success');
  }
}

// Test connections
async function testApi(type) {
  if (type === 'deepseek') {
    const key = $('deepseek-key').value.trim();
    if (!key) return toast('请先输入 DeepSeek API Key', 'error');
    testKey('deepseek', key);
  } else if (type === 'doubao') {
    const apiKey = $('doubao-api-key').value.trim();
    const endpoint = $('doubao-endpoint').value.trim();
    if (!apiKey) return toast('请先输入 ARK API Key', 'error');
    if (!endpoint || !endpoint.startsWith('ep-')) return toast('请先输入有效的 Endpoint ID (ep-xxx)', 'error');
    testDoubaoConnection(apiKey, endpoint);
  }
}

function testKey(keyType, apiKey) {
  const p = chrome.runtime.connect({ name: 'settings' });
  p.postMessage({ type: 'test_api_key', keyType, apiKey });
  p.onMessage.addListener((msg) => {
    if (msg.type === 'api_key_test_result') {
      toast(msg.success ? (keyType === 'deepseek' ? 'DeepSeek' : 'ARK') + ' 连接成功 ✓' : '失败: ' + (msg.error || ''), msg.success ? 'success' : 'error');
      p.disconnect();
    }
  });
  toast('正在验证...', 'success');
}

function testDoubaoConnection(apiKey, endpoint) {
  const p = chrome.runtime.connect({ name: 'settings' });
  p.postMessage({ type: 'test_doubao', apiKey, endpointId: endpoint });
  p.onMessage.addListener((msg) => {
    if (msg.type === 'api_key_test_result') {
      toast(msg.success ? '豆包连接成功 ✓' : '失败: ' + (msg.error || ''), msg.success ? 'success' : 'error');
      p.disconnect();
    }
  });
  toast('正在验证豆包连接...', 'success');
}

// Toast
function toast(text, type) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast ' + type;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 3000);
}

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  $('save-all').addEventListener('click', saveAll);
  $('test-deepseek').addEventListener('click', () => testApi('deepseek'));
  $('test-doubao').addEventListener('click', () => testApi('doubao'));
  $('add-domain-btn').addEventListener('click', addDomain);
  $('new-domain').addEventListener('keydown', (e) => { if (e.key === 'Enter') addDomain(); });
});
