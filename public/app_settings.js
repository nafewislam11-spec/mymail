// ── Provider system ───────────────────────────────────────────────────────────
let allProviders = {};
let selectedProvider = 'gmail';

async function loadProviders() {
  const res = await apiFetch('/api/providers');
  allProviders = res || {};
}

function renderProviderGrid() {
  const grid = document.getElementById('providerGrid');
  if (!grid) return;
  const icons = {
    gmail: '📬', outlook: '💙', brevo: '📗', resend: '⚡',
    mailgun: '📮', zoho_free: '🟠', custom: '🔧'
  };
  grid.innerHTML = Object.entries(allProviders).map(([key, p]) => `
    <div class="provider-card ${selectedProvider === key ? 'selected' : ''}"
         onclick="selectProvider('${key}')" data-provider="${key}">
      <div style="font-size:20px;margin-bottom:4px">${icons[key] || '📧'}</div>
      <div class="provider-card-name">${p.label.split(' — ')[0]}</div>
      <div class="provider-card-price">${p.price}</div>
      <div class="provider-card-limit">${p.dailyLimit}</div>
    </div>
  `).join('');
}

function selectProvider(key) {
  selectedProvider = key;
  document.querySelectorAll('.provider-card').forEach(c => {
    c.classList.toggle('selected', c.getAttribute('data-provider') === key);
  });
  updateProviderUI(key);
}

function updateProviderUI(key) {
  const p = allProviders[key];
  if (!p) return;

  // Info banner
  const banner = document.getElementById('providerInfoBanner');
  if (p.note) {
    banner.style.display = 'block';
    let html = `<strong>${p.label}</strong><br>${p.note}`;
    if (p.guideUrl) {
      html += ` &nbsp;<a href="${p.guideUrl}" target="_blank" style="color:var(--c-blue);font-weight:500">📖 Setup Guide →</a>`;
    }
    banner.innerHTML = html;
  } else {
    banner.style.display = 'none';
  }

  const isResend = key === 'resend';
  const hasSmtp = p.smtp !== null;
  const hasImap = p.imap !== null;

  document.getElementById('resendApiWrap').style.display = isResend ? 'block' : 'none';
  document.getElementById('smtpFieldsWrap').style.display = (hasSmtp && !isResend) ? 'block' : 'none';
  document.getElementById('imapFieldsWrap').style.display = hasImap ? 'block' : 'none';

  // Auto-fill from provider defaults
  if (hasSmtp && p.smtp && p.smtp.host) {
    document.getElementById('settSmtpHost').value = p.smtp.host;
    document.getElementById('settSmtpPort').value = String(p.smtp.port);
  }
  if (hasImap && p.imap && p.imap.host) {
    document.getElementById('settImapHost').value = p.imap.host;
    document.getElementById('settImapPort').value = String(p.imap.port);
  }
}

function openAddAccount() {
  state.editingAccountId = null;
  selectedProvider = 'gmail';
  document.getElementById('settingsPanelTitle').textContent = 'Add Email Account';
  document.getElementById('editAccountDangerZone').style.display = 'none';
  ['settName','settEmail','settSmtpHost','settSmtpUser','settSmtpPass',
   'settImapHost','settImapUser','settImapPass'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const apiEl = document.getElementById('settApiKey'); if (apiEl) apiEl.value = '';
  document.getElementById('settSmtpPort').value = '587';
  document.getElementById('settImapPort').value = '993';
  document.getElementById('testConnResult').className = 'test-conn-result';
  renderProviderGrid();
  updateProviderUI('gmail');
  document.getElementById('settingsPanel').classList.add('open');
}

function openEditAccount(id) {
  const acc = state.accounts.find(a => a.id === id);
  if (!acc) return;
  state.editingAccountId = id;
  selectedProvider = acc.emailProvider || 'custom';
  document.getElementById('settingsPanelTitle').textContent = `Edit — ${acc.email}`;
  document.getElementById('editAccountDangerZone').style.display = 'block';
  document.getElementById('settName').value = acc.name || '';
  document.getElementById('settEmail').value = acc.email || '';
  document.getElementById('settSmtpHost').value = acc.smtp?.host || '';
  document.getElementById('settSmtpPort').value = acc.smtp?.port || '587';
  document.getElementById('settSmtpUser').value = acc.smtp?.user || '';
  document.getElementById('settSmtpPass').value = acc.smtp?.pass || '';
  document.getElementById('settImapHost').value = acc.imap?.host || '';
  document.getElementById('settImapPort').value = acc.imap?.port || '993';
  document.getElementById('settImapUser').value = acc.imap?.user || '';
  document.getElementById('settImapPass').value = acc.imap?.pass || '';
  const apiEl = document.getElementById('settApiKey'); if (apiEl) apiEl.value = acc.apiKey || '';
  document.getElementById('testConnResult').className = 'test-conn-result';
  renderProviderGrid();
  updateProviderUI(selectedProvider);
  document.getElementById('settingsPanel').classList.add('open');
}

function closeSettings() {
  document.getElementById('settingsPanel').classList.remove('open');
  state.editingAccountId = null;
}

document.getElementById('addAccountBtn').addEventListener('click', openAddAccount);
document.getElementById('settingsBtn').addEventListener('click', openAddAccount);
document.getElementById('settingsClose').addEventListener('click', closeSettings);
document.getElementById('cancelSettingsBtn').addEventListener('click', closeSettings);
document.getElementById('settingsPanel').addEventListener('click', e => {
  if (e.target === document.getElementById('settingsPanel')) closeSettings();
});

document.getElementById('testSmtpBtn').addEventListener('click', async () => {
  const provider = selectedProvider;
  const host = document.getElementById('settSmtpHost').value;
  const port = document.getElementById('settSmtpPort').value;
  const user = document.getElementById('settSmtpUser').value;
  const pass = document.getElementById('settSmtpPass').value;
  const apiKey = document.getElementById('settApiKey')?.value;
  const result = document.getElementById('testConnResult');
  result.className = 'test-conn-result';
  result.style.whiteSpace = 'normal';
  result.textContent = '⏳ Testing connection...'; result.style.display = 'block';

  const res = await apiFetch('/api/smtp/verify', {
    method: 'POST',
    body: JSON.stringify({ provider, host, port: Number(port), secure: port === '465', user, pass, apiKey })
  });
  if (res.success) {
    result.className = 'test-conn-result ok'; result.textContent = res.message;
  } else {
    result.className = 'test-conn-result err';
    result.style.whiteSpace = 'pre-wrap';
    result.textContent = '❌ ' + res.error;
  }
});

document.getElementById('saveAccountBtn').addEventListener('click', async () => {
  const name = document.getElementById('settName').value.trim();
  const email = document.getElementById('settEmail').value.trim();
  const smtpPort = document.getElementById('settSmtpPort').value;
  const imapPort = document.getElementById('settImapPort').value;
  const apiKey = document.getElementById('settApiKey')?.value?.trim();

  if (!name || !email) { toast('Please fill in Name and Email'); return; }

  const isResend = selectedProvider === 'resend';
  const p = allProviders[selectedProvider];
  const hasSmtp = p?.smtp !== null && !isResend;
  const hasImap = p?.imap !== null;

  if (isResend && !apiKey) { toast('⚠️ Please enter your Resend API key'); return; }

  const payload = {
    name, email,
    emailProvider: selectedProvider,
    avatarColor: getAvatarColor(email),
    apiKey: isResend ? (apiKey || '') : undefined,
    smtp: hasSmtp ? {
      host: document.getElementById('settSmtpHost').value || p?.smtp?.host || '',
      port: Number(smtpPort), secure: smtpPort === '465',
      user: document.getElementById('settSmtpUser').value,
      pass: document.getElementById('settSmtpPass').value
    } : { host: '', port: 587, secure: false, user: '', pass: '' },
    imap: hasImap ? {
      host: document.getElementById('settImapHost').value || p?.imap?.host || '',
      port: Number(imapPort), tls: imapPort === '993',
      user: document.getElementById('settImapUser').value,
      pass: document.getElementById('settImapPass').value
    } : { host: '', port: 993, tls: true, user: '', pass: '' }
  };

  let res;
  if (state.editingAccountId) {
    res = await apiFetch(`/api/accounts/${state.editingAccountId}`, { method: 'PUT', body: JSON.stringify(payload) });
  } else {
    res = await apiFetch('/api/accounts', { method: 'POST', body: JSON.stringify(payload) });
    if (res.success && res.account) {
      state.activeAccountId = res.account.id;
      await apiFetch(`/api/accounts/${res.account.id}/activate`, { method: 'POST' });
    }
  }

  if (res.success || res.account) {
    const providerLabel = allProviders[selectedProvider]?.label?.split(' — ')[0] || selectedProvider;
    toast(state.editingAccountId
      ? `Account updated (${providerLabel})!`
      : `✅ Account ${email} added via ${providerLabel}!`);
    closeSettings();
    await loadAccounts();
    await loadEmails('INBOX');
    setActiveNavItem('INBOX');
  } else {
    toast(`Error: ${res.error || 'Unknown error'}`);
  }
});

document.getElementById('deleteAccountBtn').addEventListener('click', async () => {
  if (!state.editingAccountId) return;
  const acc = state.accounts.find(a => a.id === state.editingAccountId);
  if (!confirm(`Remove account ${acc?.email}? This cannot be undone.`)) return;
  await apiFetch(`/api/accounts/${state.editingAccountId}`, { method: 'DELETE' });
  toast(`Account ${acc?.email} removed`);
  closeSettings();
  await loadAccounts();
  if (state.accounts.length > 0) await loadEmails('INBOX');
  else renderEmailList([]);
});

// Profile btn — open settings for active account
document.getElementById('profileBtn').addEventListener('click', () => {
  if (state.activeAccountId) openEditAccount(state.activeAccountId);
  else openAddAccount();
});

// ── SSE for real-time updates ─────────────────────────────────────
function setupSSE() {
  try {
    const es = new EventSource('/api/events');
    es.onmessage = async (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'email_sent' && data.payload?.accountId === state.activeAccountId) {
        if (state.currentFolder === 'Sent') await loadEmails();
      }
    };
  } catch (e) { /* SSE optional */ }
}

// ── Helper: HTML escape ───────────────────────────────────────────
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setupEventListeners() {
  // Escape key handling already set up in keyboard shortcuts section
}

// ── Start App ─────────────────────────────────────────────────────
async function init() {
  showLoading();
  await loadProviders();
  await loadAccounts();
  await loadEmails();
  setupEventListeners();
  setupSSE();
  hideLoading();
}

init();
