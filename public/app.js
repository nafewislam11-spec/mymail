/* ══════════════════════════════════════════════════════════════
   MyMail — Client-Side Application Logic
   Gmail-like webmail with SMTP/IMAP account support
   ══════════════════════════════════════════════════════════════ */

const API = '';

// ── Application State ────────────────────────────────────────────
const state = {
  currentUser: null,
  token: localStorage.getItem('mymail_token') || null,
  accounts: [],
  activeAccountId: null,
  currentFolder: 'INBOX',
  emails: [],
  selectedEmail: null,
  selectedIds: new Set(),
  editingAccountId: null,
  searchQuery: '',
  isLoading: false
};

// Avatar color palette
const AVATAR_COLORS = [
  '#1a73e8','#ea4335','#34a853','#fbbc04',
  '#e91e63','#9c27b0','#00bcd4','#ff5722',
  '#795548','#607d8b','#4caf50','#ff9800'
];

function getAvatarColor(str) {
  let hash = 0;
  for (let c of (str || 'U')) hash = (hash << 5) - hash + c.charCodeAt(0);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name) {
  return (name || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const isThisYear = d.getFullYear() === now.getFullYear();
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isThisYear) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function senderName(fromStr) {
  if (!fromStr) return 'Unknown';
  const m = fromStr.match(/^"?([^"<]+)"?\s*</);
  return m ? m[1].trim() : fromStr.split('@')[0];
}

function senderEmail(fromStr) {
  const m = (fromStr || '').match(/<([^>]+)>/);
  return m ? m[1] : fromStr;
}

// ── API Helpers ───────────────────────────────────────────────────
async function apiFetch(url, opts = {}) {
  try {
    const token = localStorage.getItem('mymail_token');
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(API + url, { ...opts, headers });
    return await r.json();
  } catch (e) {
    return { error: e.message };
  }
}

// ── Loading Bar ───────────────────────────────────────────────────
function showLoading() {
  document.getElementById('loadingBar').classList.add('visible');
}
function hideLoading() {
  document.getElementById('loadingBar').classList.remove('visible');
}

// ── Toast Notifications ───────────────────────────────────────────
function toast(msg, action = null, actionCb = null) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = msg;
  if (action) {
    const btn = document.createElement('span');
    btn.className = 'toast-action';
    btn.textContent = action;
    btn.onclick = () => { actionCb && actionCb(); el.remove(); };
    el.appendChild(btn);
  }
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 4000);
}

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  showLoading();
  await loadAccounts();
  await loadEmails();
  setupEventListeners();
  setupSSE();
  hideLoading();
}


// ── Zero Data-Loss Vault (Browser Mirror & Self-Healing) ────────────────────
const Vault = {
  save() {
    try {
      const data = {
        timestamp: Date.now(),
        accounts: state.accounts,
        activeAccountId: state.activeAccountId
      };
      localStorage.setItem('mymail_local_vault', JSON.stringify(data));
    } catch (e) {}
  },
  async selfHeal() {
    try {
      const saved = localStorage.getItem('mymail_local_vault');
      if (!saved) return;
      const vault = JSON.parse(saved);
      if (vault.accounts && vault.accounts.length > 0) {
        const res = await apiFetch('/api/sync/vault', {
          method: 'POST',
          body: JSON.stringify({ vault })
        });
        if (res.status === 'restored_from_vault') {
          console.log('✅ Self-healed user data from client vault!');
        }
      }
    } catch (e) {
      console.warn('Vault self-heal warning:', e);
    }
  }
};

// ── Account Management ────────────────────────────────────────────
async function loadAccounts() {
  const res = await apiFetch('/api/accounts');
  state.accounts = Array.isArray(res) ? res : [];
  const active = await apiFetch('/api/accounts/active');
  state.activeAccountId = active?.id || state.accounts[0]?.id || null;
  renderAccounts();
  updateProfileBtn();
  Vault.save();
}

function renderAccounts() {
  const el = document.getElementById('sidebarAccounts');
  el.innerHTML = state.accounts.map(acc => `
    <div class="account-chip ${acc.id === state.activeAccountId ? 'active-acc' : ''}" 
         onclick="switchAccount('${acc.id}')" title="${acc.email}">
      <div class="acc-avatar" style="background:${acc.avatarColor || getAvatarColor(acc.email)}">
        ${getInitials(acc.name)}
      </div>
      <div class="acc-info">
        <div class="acc-name">${esc(acc.name)}</div>
        <div class="acc-email">${esc(acc.email)}</div>
      </div>
      <button onclick="event.stopPropagation();openEditAccount('${acc.id}')" 
        style="border:none;background:transparent;cursor:pointer;color:var(--c-text2);padding:4px;border-radius:50%"
        title="Edit account">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>
        </svg>
      </button>
    </div>
  `).join('');
}

function updateProfileBtn() {
  const btn = document.getElementById('profileBtn');
  const authTrigger = document.getElementById('authTriggerBtn');
  if (!btn) return;

  if (state.currentUser) {
    if (authTrigger) authTrigger.style.display = 'none';
    btn.style.display = 'flex';
    btn.style.background = getAvatarColor(state.currentUser.email);
    btn.textContent = getInitials(state.currentUser.name);
    btn.title = `${state.currentUser.name} (${state.currentUser.email})`;
  } else {
    if (authTrigger) authTrigger.style.display = 'inline-flex';
    const acc = state.accounts.find(a => a.id === state.activeAccountId);
    if (acc) {
      btn.style.display = 'flex';
      btn.style.background = acc.avatarColor || getAvatarColor(acc.email);
      btn.textContent = getInitials(acc.name);
      btn.title = `Guest Mode (${acc.email})`;
    } else {
      btn.style.display = 'flex';
      btn.style.background = '#607d8b';
      btn.textContent = '👤';
      btn.title = 'Guest / Demo Mode';
    }
  }
}

async function switchAccount(id) {
  showLoading();
  state.activeAccountId = id;
  await apiFetch(`/api/accounts/${id}/activate`, { method: 'POST' });
  state.currentFolder = 'INBOX';
  setActiveNavItem('INBOX');
  closeReadingPane();
  renderAccounts();
  updateProfileBtn();
  await loadEmails();
  hideLoading();
}

// ── Email Loading ──────────────────────────────────────────────────
async function loadEmails(folder) {
  if (!state.activeAccountId) { renderEmailList([]); return; }
  if (folder) state.currentFolder = folder;
  showLoading();
  state.selectedIds.clear();
  updateToolbarSelection();

  let emails = [];

  if (state.currentFolder === 'Starred') {
    // Collect starred from all folders
    const res = await apiFetch('/api/imap/fetch', {
      method: 'POST', body: JSON.stringify({ accountId: state.activeAccountId, folder: 'INBOX', limit: 100 })
    });
    emails = (res.emails || []).filter(e => e.starred);
    const sentRes = await apiFetch('/api/imap/fetch', {
      method: 'POST', body: JSON.stringify({ accountId: state.activeAccountId, folder: 'Sent', limit: 100 })
    });
    emails = [...emails, ...(sentRes.emails || []).filter(e => e.starred)];
  } else {
    const res = await apiFetch('/api/imap/fetch', {
      method: 'POST', body: JSON.stringify({ accountId: state.activeAccountId, folder: state.currentFolder, limit: 50 })
    });
    emails = res.emails || [];
    if (res.warning) {
      console.warn('IMAP warning:', res.warning);
      toast(`⚠️ IMAP Sync: ${res.warning}`);
    }
  }

  state.emails = emails;
  renderEmailList(emails);
  updateBadges();
  hideLoading();
}

// ── Email List Rendering ──────────────────────────────────────────
function renderEmailList(emails) {
  const el = document.getElementById('emailList');
  if (!emails.length) {
    const acc = state.accounts.find(a => a.id === state.activeAccountId);
    const hasImap = Boolean(acc?.imap?.host && acc?.imap?.user);
    const folderLabels = { INBOX: 'inbox', Sent: 'Sent folder', Drafts: 'Drafts', Spam: 'Spam', Trash: 'Trash', Starred: 'Starred' };

    let extraGuide = '';
    if (state.currentFolder === 'INBOX' && !hasImap && !acc?.isDemo) {
      extraGuide = `
        <div style="margin-top:20px;max-width:520px;background:#f8fafd;border:1px solid #d2e3fc;border-radius:10px;padding:16px;text-align:left;font-size:13px;color:#202124;line-height:1.5">
          <div style="font-weight:600;color:#1967d2;margin-bottom:6px;display:flex;align-items:center;gap:6px">
            💡 How to Receive Emails in MyMail
          </div>
          <div>Brevo handles <strong>outgoing mail (sending)</strong>. To receive incoming emails:</div>
          <ul style="margin:8px 0 12px 18px;padding:0;color:#3c4043;font-size:12px">
            <li><strong>Method 1:</strong> Forward your domain emails to a free Gmail account, then connect Gmail IMAP in <em>Settings ⚙️</em>.</li>
            <li><strong>Method 2:</strong> Connect any existing IMAP server (e.g. Gmail with App Password, Outlook, or cPanel).</li>
          </ul>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button onclick="simulateInboundEmail()" style="background:#1a73e8;color:#fff;border:none;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer">
              📥 Receive Test Email Now
            </button>
            <button onclick="openEditAccount(state.activeAccountId)" style="background:#fff;border:1px solid #dadce0;color:#1a73e8;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer">
              ⚙️ Open IMAP Settings
            </button>
          </div>
        </div>`;
    }

    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${state.currentFolder === 'Trash' ? '🗑️' : state.currentFolder === 'Spam' ? '🚫' : '📭'}</div>
        <p style="font-size:16px;font-weight:500">No messages in ${folderLabels[state.currentFolder] || state.currentFolder}</p>
        <p style="font-size:13px;color:var(--c-text2)">Messages you ${state.currentFolder === 'Trash' ? 'delete' : 'receive'} will appear here</p>
        ${extraGuide}
      </div>`;
    return;
  }

  el.innerHTML = emails.map((email, idx) => {
    const name = senderName(email.from);
    const color = getAvatarColor(email.fromEmail || email.from);
    const isUnread = !email.read;
    const labelHtml = (email.labels || []).map(l => `<span class="row-label label-${l.toLowerCase()}">${l}</span>`).join('');
    return `
      <div class="email-row ${isUnread ? 'unread' : 'read'} ${state.selectedIds.has(email.id) ? 'selected' : ''}"
           data-id="${email.id}" data-idx="${idx}"
           onclick="openEmail(event,'${email.id}',${idx})"
           oncontextmenu="showCtxMenu(event,'${email.id}')">
        <div class="row-check-zone">
          <input type="checkbox" class="row-check" data-id="${email.id}"
            onclick="event.stopPropagation();toggleSelect('${email.id}',this)"
            ${state.selectedIds.has(email.id) ? 'checked' : ''}>
          <div class="row-avatar" style="background:${color};display:none" id="av-${email.id}">
            ${getInitials(name)}
          </div>
        </div>
        <div class="row-star-zone">
          <button class="star-btn ${email.starred ? 'starred' : ''}" data-id="${email.id}"
            onclick="event.stopPropagation();toggleStar('${email.id}')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="${email.starred ? '#fbbc04' : 'none'}" stroke="${email.starred ? '#fbbc04' : 'currentColor'}" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
          </button>
        </div>
        <div class="row-content">
          <span class="row-from">${esc(name)}</span>
          <div class="row-mid">
            ${labelHtml}
            <span class="row-subject">${esc(email.subject || '(no subject)')}</span>
            <span class="row-dash">—</span>
            <span class="row-snippet">${esc(email.snippet || '')}</span>
          </div>
          <div class="row-meta">
            <span class="row-date">${formatDate(email.date)}</span>
          </div>
        </div>
      </div>`;
  }).join('');

  // Show unread count
  const unread = emails.filter(e => !e.read).length;
  document.getElementById('toolbarInfo').textContent = `${emails.length} conversations${unread ? ` (${unread} unread)` : ''}`;
}

function updateBadges() {
  const unread = state.emails.filter(e => !e.read).length;
  const el = document.getElementById('inboxCount');
  if (el) el.textContent = unread > 0 ? unread : '';

  const draftCount = document.getElementById('draftsCount');
  if (draftCount) {
    const acc = state.accounts.find(a => a.id === state.activeAccountId);
    draftCount.textContent = ''; // Would need to load drafts separately
  }
}

// ── Star Toggle ───────────────────────────────────────────────────
async function toggleStar(id) {
  const email = state.emails.find(e => e.id === id);
  if (!email) return;
  email.starred = !email.starred;
  await apiFetch(`/api/emails/${state.activeAccountId}/${state.currentFolder}/${id}`, {
    method: 'PUT', body: JSON.stringify({ starred: email.starred })
  });
  // Update star button
  const btn = document.querySelector(`.star-btn[data-id="${id}"]`);
  if (btn) {
    btn.className = `star-btn ${email.starred ? 'starred' : ''}`;
    const svg = btn.querySelector('svg');
    if (svg) {
      svg.setAttribute('fill', email.starred ? '#fbbc04' : 'none');
      svg.setAttribute('stroke', email.starred ? '#fbbc04' : 'currentColor');
    }
  }
}

// ── Select / Bulk Actions ─────────────────────────────────────────
function toggleSelect(id, cb) {
  if (cb.checked) state.selectedIds.add(id);
  else state.selectedIds.delete(id);
  const row = document.querySelector(`.email-row[data-id="${id}"]`);
  if (row) row.classList.toggle('selected', cb.checked);
  updateToolbarSelection();
}

document.getElementById('selectAll').addEventListener('change', function() {
  const checked = this.checked;
  state.emails.forEach(e => {
    if (checked) state.selectedIds.add(e.id);
    else state.selectedIds.delete(e.id);
  });
  document.querySelectorAll('.row-check').forEach(cb => {
    cb.checked = checked;
    const row = cb.closest('.email-row');
    if (row) row.classList.toggle('selected', checked);
  });
  updateToolbarSelection();
});

function updateToolbarSelection() {
  const n = state.selectedIds.size;
  const show = n > 0;
  ['toolbarArchive', 'toolbarDelete', 'toolbarMarkRead'].forEach(id => {
    document.getElementById(id).style.display = show ? 'flex' : 'none';
  });
  if (show) document.getElementById('toolbarInfo').textContent = `${n} selected`;
  else updateBadges();
}

document.getElementById('toolbarDelete').addEventListener('click', async () => {
  for (const id of state.selectedIds) {
    await apiFetch(`/api/emails/${state.activeAccountId}/${state.currentFolder}/${id}/move`, {
      method: 'POST', body: JSON.stringify({ dest: 'Trash' })
    });
  }
  toast(`${state.selectedIds.size} conversation${state.selectedIds.size > 1 ? 's' : ''} moved to Trash`, 'Undo', () => toast('Undo not implemented in demo'));
  state.selectedIds.clear();
  await loadEmails();
});

document.getElementById('toolbarArchive').addEventListener('click', async () => {
  for (const id of state.selectedIds) {
    await apiFetch(`/api/emails/${state.activeAccountId}/${state.currentFolder}/${id}/move`, {
      method: 'POST', body: JSON.stringify({ dest: 'Archive' })
    });
  }
  toast(`${state.selectedIds.size} conversation${state.selectedIds.size > 1 ? 's' : ''} archived`);
  state.selectedIds.clear();
  await loadEmails();
});

document.getElementById('toolbarMarkRead').addEventListener('click', async () => {
  for (const id of state.selectedIds) {
    const email = state.emails.find(e => e.id === id);
    if (email) email.read = true;
    await apiFetch(`/api/emails/${state.activeAccountId}/${state.currentFolder}/${id}`, {
      method: 'PUT', body: JSON.stringify({ read: true })
    });
  }
  state.selectedIds.clear();
  renderEmailList(state.emails);
  updateBadges();
});

// ── Open Email (Reading Pane) ─────────────────────────────────────
async function openEmail(event, id, idx) {
  if (event.target.type === 'checkbox') return;
  const email = state.emails.find(e => e.id === id);
  if (!email) return;

  state.selectedEmail = email;
  email.read = true;

  // Mark read
  await apiFetch(`/api/emails/${state.activeAccountId}/${state.currentFolder}/${id}`, {
    method: 'PUT', body: JSON.stringify({ read: true })
  });

  // Update row
  const row = document.querySelector(`.email-row[data-id="${id}"]`);
  if (row) { row.classList.remove('unread'); row.classList.add('read'); }

  updateBadges();
  showReadingPane(email, idx);
}

function showReadingPane(email, idx) {
  const pane = document.getElementById('readingPane');
  pane.classList.add('open');

  document.getElementById('readerSubject').innerHTML = `
    ${esc(email.subject || '(no subject)')}
    ${(email.labels || []).map(l => `<span class="reader-label-badge label-${l.toLowerCase()}">${l}</span>`).join('')}
  `;

  const name = senderName(email.from);
  const color = getAvatarColor(email.fromEmail || email.from);
  const av = document.getElementById('readerAvatar');
  av.style.background = color;
  av.textContent = getInitials(name);

  document.getElementById('readerFromName').textContent = name;
  document.getElementById('readerFromEmail').textContent = `<${senderEmail(email.from)}>`;
  document.getElementById('readerToLine').textContent = `To: ${email.to || 'me'}`;
  document.getElementById('readerDate').textContent = email.date ? new Date(email.date).toLocaleString() : '';

  // Render body
  const body = document.getElementById('readerBody');
  body.innerHTML = email.html || `<p style="white-space:pre-wrap">${esc(email.snippet || '')}</p>`;

  // Async load full parsed body if IMAP email
  if (email.id.startsWith('imap_') && email.uid && !email._fullLoaded) {
    apiFetch('/api/imap/fetch-body', {
      method: 'POST',
      body: JSON.stringify({ accountId: state.activeAccountId, folder: state.currentFolder, uid: email.uid })
    }).then(res => {
      if (res && res.success && (res.html || res.text)) {
        email.html = res.html || `<pre>${res.text}</pre>`;
        email._fullLoaded = true;
        if (state.selectedEmail?.id === email.id) {
          body.innerHTML = email.html;
        }
      }
    });
  }

  // Pagination
  const total = state.emails.length;
  document.getElementById('readerPagination').innerHTML = `
    ${idx + 1}–${idx + 1} of ${total}
    <button class="reader-toolbar-btn" onclick="navigateEmail(${idx - 1})" ${idx === 0 ? 'disabled' : ''} title="Previous">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
    </button>
    <button class="reader-toolbar-btn" onclick="navigateEmail(${idx + 1})" ${idx >= total - 1 ? 'disabled' : ''} title="Next">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
    </button>
  `;

  // Scroll to top
  pane.scrollTop = 0;
}

function navigateEmail(idx) {
  if (idx < 0 || idx >= state.emails.length) return;
  openEmail({ target: {} }, state.emails[idx].id, idx);
}

function closeReadingPane() {
  document.getElementById('readingPane').classList.remove('open');
  state.selectedEmail = null;
}

function openReplyFromReader() {
  if (!state.selectedEmail) return;
  openCompose({
    to: senderEmail(state.selectedEmail.from),
    subject: state.selectedEmail.subject.startsWith('Re:') ? state.selectedEmail.subject : `Re: ${state.selectedEmail.subject}`,
    body: `\n\n— On ${new Date(state.selectedEmail.date).toLocaleString()}, ${state.selectedEmail.from} wrote:\n${(state.selectedEmail.snippet || '').substring(0, 200)}...`
  });
}

// Reader actions
document.getElementById('readerBack').addEventListener('click', closeReadingPane);
document.getElementById('readerReplyBtn').addEventListener('click', openReplyFromReader);
document.getElementById('readerForwardBtn').addEventListener('click', () => {
  if (!state.selectedEmail) return;
  openCompose({ subject: `Fwd: ${state.selectedEmail.subject}`, body: `\n\n—— Forwarded Message ——\n${state.selectedEmail.snippet}` });
});
document.getElementById('readerDelete').addEventListener('click', async () => {
  if (!state.selectedEmail) return;
  await apiFetch(`/api/emails/${state.activeAccountId}/${state.currentFolder}/${state.selectedEmail.id}/move`, {
    method: 'POST', body: JSON.stringify({ dest: 'Trash' })
  });
  toast('Moved to Trash', 'Undo', () => toast('Undo not available in demo'));
  closeReadingPane();
  await loadEmails();
});
document.getElementById('readerArchive').addEventListener('click', async () => {
  if (!state.selectedEmail) return;
  await apiFetch(`/api/emails/${state.activeAccountId}/${state.currentFolder}/${state.selectedEmail.id}/move`, {
    method: 'POST', body: JSON.stringify({ dest: 'Archive' })
  });
  toast('Archived');
  closeReadingPane();
  await loadEmails();
});
document.getElementById('readerSpam').addEventListener('click', async () => {
  if (!state.selectedEmail) return;
  await apiFetch(`/api/emails/${state.activeAccountId}/${state.currentFolder}/${state.selectedEmail.id}/move`, {
    method: 'POST', body: JSON.stringify({ dest: 'Spam' })
  });
  toast('Reported as spam');
  closeReadingPane();
  await loadEmails();
});

// ── Compose ───────────────────────────────────────────────────────
function openCompose(prefill = {}) {
  document.getElementById('composeOverlay').classList.add('open');
  document.getElementById('composeTo').value = prefill.to || '';
  document.getElementById('composeSubject').value = prefill.subject || '';
  document.getElementById('composeBody').innerHTML = prefill.body ? `<p>${prefill.body.replace(/\n/g, '<br>')}</p>` : '';
  document.getElementById('composeTitleLabel').textContent = prefill.subject ? 'Reply' : 'New Message';
  document.getElementById('composeTo').focus();
}

function closeCompose() {
  document.getElementById('composeOverlay').classList.remove('open');
  document.getElementById('composeTo').value = '';
  document.getElementById('composeSubject').value = '';
  document.getElementById('composeBody').innerHTML = '';
  document.getElementById('composeCcRow').style.display = 'none';
  document.getElementById('composeBccRow').style.display = 'none';
}

function insertComposeLink() {
  const url = prompt('Enter URL:', 'https://');
  if (url) document.execCommand('createLink', false, url);
}

async function saveDraft() {
  const to = document.getElementById('composeTo').value;
  const subject = document.getElementById('composeSubject').value;
  const body = document.getElementById('composeBody').innerHTML;
  if (!subject && !body) return;

  await apiFetch(`/api/drafts/${state.activeAccountId}`, {
    method: 'POST', body: JSON.stringify({ to, subject, html: body })
  });
  toast('Draft saved');
  closeCompose();
}

document.getElementById('composeBtn').addEventListener('click', () => openCompose());
document.getElementById('composeClose').addEventListener('click', closeCompose);
document.getElementById('discardBtn').addEventListener('click', () => {
  if (document.getElementById('composeBody').innerHTML.length > 10 && !confirm('Discard draft?')) return;
  closeCompose();
});
document.getElementById('composeMinimize').addEventListener('click', () => {
  const w = document.getElementById('composeWindow');
  const isMin = w.style.height === '48px';
  w.style.height = isMin ? '' : '48px';
});

document.getElementById('sendEmailBtn').addEventListener('click', async () => {
  const to = document.getElementById('composeTo').value.trim();
  const cc = document.getElementById('composeCc').value.trim();
  const bcc = document.getElementById('composeBcc').value.trim();
  const subject = document.getElementById('composeSubject').value.trim();
  const html = document.getElementById('composeBody').innerHTML;

  if (!to) { toast('Please enter a recipient'); document.getElementById('composeTo').focus(); return; }
  if (!subject) { toast('Subject is empty — please add a subject'); document.getElementById('composeSubject').focus(); return; }

  const acc = state.accounts.find(a => a.id === state.activeAccountId);
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (acc && (!acc.email || !emailRegex.test(acc.email))) {
    toast(`⚠️ Sender email "${acc.email}" is not a valid email! Click Settings ⚙️ to set your full email address (e.g. you@domain.com).`);
    return;
  }

  const btn = document.getElementById('sendEmailBtn');
  btn.disabled = true; btn.textContent = 'Sending...';

  const res = await apiFetch('/api/smtp/send', {
    method: 'POST',
    body: JSON.stringify({ accountId: state.activeAccountId, to, cc: cc || undefined, bcc: bcc || undefined, subject, html })
  });

  btn.disabled = false;
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send`;

  if (res.success) {
    toast(`Message sent to ${to}`);
    closeCompose();
    if (state.currentFolder === 'Sent') await loadEmails();
  } else {
    toast(`❌ Send failed: ${res.error || 'Unknown error'}`);
  }
});

// ── Keyboard Shortcuts ────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.contentEditable === 'true';

  if (!inInput) {
    if (e.key === 'c' || e.key === 'C') openCompose();
    if (e.key === 'r' || e.key === 'R') openReplyFromReader();
    if (e.key === 'Escape') {
      closeReadingPane();
      closeCompose();
      document.getElementById('searchResultsPanel').classList.remove('open');
    }
    if (e.key === '/') { e.preventDefault(); document.getElementById('searchInput').focus(); }
  }
  if (e.key === 'Escape' && inInput && document.getElementById('composeOverlay').classList.contains('open')) {
    // don't close if typing in compose
  }
});

// ── Navigation ────────────────────────────────────────────────────
function setActiveNavItem(folder) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const el = document.querySelector(`[data-folder="${folder}"]`);
  if (el) el.classList.add('active');
}

document.querySelectorAll('.nav-item[data-folder]').forEach(el => {
  el.addEventListener('click', async () => {
    const folder = el.getAttribute('data-folder');
    setActiveNavItem(folder);
    closeReadingPane();
    await loadEmails(folder);
  });
});

// ── Search ────────────────────────────────────────────────────────
const searchInput = document.getElementById('searchInput');
const searchClearBtn = document.getElementById('searchClearBtn');

let searchTimer;
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  searchClearBtn.style.display = q ? 'flex' : 'none';
  clearTimeout(searchTimer);
  if (!q) { document.getElementById('searchResultsPanel').classList.remove('open'); return; }
  searchTimer = setTimeout(() => runSearch(q), 300);
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') runSearch(searchInput.value.trim());
  if (e.key === 'Escape') {
    searchInput.value = '';
    searchClearBtn.style.display = 'none';
    document.getElementById('searchResultsPanel').classList.remove('open');
  }
});

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchClearBtn.style.display = 'none';
  document.getElementById('searchResultsPanel').classList.remove('open');
});

async function runSearch(q) {
  if (!q || !state.activeAccountId) return;
  const res = await apiFetch(`/api/search/${state.activeAccountId}?q=${encodeURIComponent(q)}`);
  const results = Array.isArray(res) ? res : [];
  const panel = document.getElementById('searchResultsPanel');
  panel.classList.add('open');
  document.getElementById('searchResultsHeader').textContent = `${results.length} result${results.length !== 1 ? 's' : ''} for "${q}"`;
  const list = document.getElementById('searchResultsList');
  if (!results.length) {
    list.innerHTML = '<div class="empty-state" style="padding:60px"><p>No matching emails found.</p></div>';
    return;
  }
  list.innerHTML = results.map((email, idx) => {
    const name = senderName(email.from);
    const color = getAvatarColor(email.fromEmail || email.from);
    return `
      <div class="email-row ${email.read ? 'read' : 'unread'}" data-id="${email.id}"
           onclick="openSearchEmail('${email.id}','${email.folder}')">
        <div class="row-check-zone">
          <div class="row-avatar" style="background:${color}">${getInitials(name)}</div>
        </div>
        <div class="row-star-zone">
          <span style="font-size:11px;color:var(--c-text2);padding:2px 6px;background:var(--c-hover);border-radius:4px">${email.folder}</span>
        </div>
        <div class="row-content">
          <span class="row-from">${esc(name)}</span>
          <div class="row-mid">
            <span class="row-subject">${esc(email.subject || '(no subject)')}</span>
            <span class="row-dash">—</span>
            <span class="row-snippet">${esc(email.snippet || '')}</span>
          </div>
          <div class="row-meta"><span class="row-date">${formatDate(email.date)}</span></div>
        </div>
      </div>`;
  }).join('');
}

function openSearchEmail(id, folder) {
  state.currentFolder = folder;
  document.getElementById('searchResultsPanel').classList.remove('open');
  loadEmails(folder).then(() => {
    const email = state.emails.find(e => e.id === id);
    const idx = state.emails.indexOf(email);
    if (email) showReadingPane(email, idx);
  });
}

// ── Context Menu ──────────────────────────────────────────────────
let ctxTargetId = null;

function showCtxMenu(e, id) {
  e.preventDefault();
  ctxTargetId = id;
  const menu = document.getElementById('ctxMenu');
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - 200)}px`;
  menu.classList.add('open');
}

document.addEventListener('click', () => document.getElementById('ctxMenu').classList.remove('open'));
document.getElementById('ctxMenu').querySelectorAll('.ctx-item').forEach(item => {
  item.addEventListener('click', async () => {
    const action = item.getAttribute('data-action');
    const email = state.emails.find(e => e.id === ctxTargetId);
    if (!email) return;
    const idx = state.emails.indexOf(email);

    if (action === 'reply') { showReadingPane(email, idx); openReplyFromReader(); }
    if (action === 'forward') { showReadingPane(email, idx); document.getElementById('readerForwardBtn').click(); }
    if (action === 'archive') {
      await apiFetch(`/api/emails/${state.activeAccountId}/${state.currentFolder}/${email.id}/move`, { method: 'POST', body: JSON.stringify({ dest: 'Archive' }) });
      toast('Archived'); await loadEmails();
    }
    if (action === 'trash') {
      await apiFetch(`/api/emails/${state.activeAccountId}/${state.currentFolder}/${email.id}/move`, { method: 'POST', body: JSON.stringify({ dest: 'Trash' }) });
      toast('Moved to Trash'); await loadEmails();
    }
    if (action === 'markRead') {
      email.read = true;
      await apiFetch(`/api/emails/${state.activeAccountId}/${state.currentFolder}/${email.id}`, { method: 'PUT', body: JSON.stringify({ read: true }) });
      renderEmailList(state.emails);
    }
    if (action === 'star') { await toggleStar(email.id); }
  });
});

// ── Refresh ───────────────────────────────────────────────────────
['refreshBtn', 'toolbarRefresh'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', async () => {
    const btn = document.getElementById(id);
    btn.style.animation = 'spin .5s linear';
    setTimeout(() => btn.style.animation = '', 500);
    await loadEmails();
    toast('Inbox refreshed');
  });
});

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
  document.getElementById('imapFieldsWrap').style.display = 'block';

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

window.fillZohoImap = function() {
  document.getElementById('settImapHost').value = 'imap.zoho.com';
  document.getElementById('settImapPort').value = '993';
  const email = document.getElementById('settEmail').value.trim();
  if (email && email.includes('@')) {
    document.getElementById('settImapUser').value = email;
  }
  document.getElementById('settImapPass').focus();
  toast('🟠 IMAP set to Zoho (imap.zoho.com:993). Enter your Zoho password below.');
};

window.fillGmailImap = function() {
  document.getElementById('settImapHost').value = 'imap.gmail.com';
  document.getElementById('settImapPort').value = '993';
  toast('⚡ IMAP set to Gmail (imap.gmail.com:993). Enter your Gmail and App Password below.');
};

window.clearImapFields = function() {
  document.getElementById('settImapHost').value = '';
  document.getElementById('settImapUser').value = '';
  document.getElementById('settImapPass').value = '';
  toast('IMAP fields cleared (Send-only mode).');
};

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

const testImapBtn = document.getElementById('testImapBtn');
if (testImapBtn) {
  testImapBtn.addEventListener('click', async () => {
    const host = document.getElementById('settImapHost').value.trim();
    const port = document.getElementById('settImapPort').value;
    const user = document.getElementById('settImapUser').value.trim();
    const pass = document.getElementById('settImapPass').value;
    const result = document.getElementById('testConnResult');
    result.className = 'test-conn-result';
    result.style.whiteSpace = 'normal';
    result.textContent = '⏳ Testing IMAP connection to ' + (host || 'server') + '...';
    result.style.display = 'block';

    const res = await apiFetch('/api/imap/verify', {
      method: 'POST',
      body: JSON.stringify({ host, port: Number(port), tls: port === '993', user, pass })
    });
    if (res.success) {
      result.className = 'test-conn-result ok';
      result.textContent = res.message;
    } else {
      result.className = 'test-conn-result err';
      result.style.whiteSpace = 'pre-wrap';
      result.textContent = '❌ ' + res.error;
    }
  });
}

document.getElementById('saveAccountBtn').addEventListener('click', async () => {
  const name = document.getElementById('settName').value.trim();
  const email = document.getElementById('settEmail').value.trim();
  const smtpPort = document.getElementById('settSmtpPort').value;
  const imapPort = document.getElementById('settImapPort').value;
  const apiKey = document.getElementById('settApiKey')?.value?.trim();

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!name) { toast('⚠️ Please enter your Display Name'); document.getElementById('settName').focus(); return; }
  if (!email || !emailRegex.test(email)) {
    toast(`⚠️ "${email}" is not a valid email address! Please enter a full email like name@domain.com.`);
    document.getElementById('settEmail').focus();
    return;
  }

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


// ── Auth & Account Hub Controller ───────────────────────────────────────────
let pendingAuthEmail = '';
let pendingAuthType = 'email_verification';
let pendingResetEmail = '';

async function checkAuth() {
  const token = localStorage.getItem('mymail_token');
  if (!token) {
    state.currentUser = null;
    updateProfileBtn();
    return;
  }
  const res = await apiFetch('/api/auth/me');
  if (res.isAuth && res.user) {
    state.currentUser = res.user;
  } else {
    state.currentUser = null;
    localStorage.removeItem('mymail_token');
  }
  updateProfileBtn();
}

function openAuthModal(tab = 'signin') {
  const modal = document.getElementById('authModal');
  if (!modal) return;
  modal.classList.add('open');
  switchAuthTab(tab);
  hideAuthAlert();
}

function closeAuthModal() {
  const modal = document.getElementById('authModal');
  if (modal) modal.classList.remove('open');
}

function switchAuthTab(tab) {
  const tabSignIn = document.getElementById('tabSignIn');
  const tabSignUp = document.getElementById('tabSignUp');
  const signInForm = document.getElementById('signInForm');
  const signUpForm = document.getElementById('signUpForm');
  const verifyView = document.getElementById('verifyOtpView');
  const forgotView = document.getElementById('forgotPassView');
  const tabsContainer = tabSignIn?.parentElement;

  if (tabsContainer) tabsContainer.style.display = 'flex';
  if (verifyView) verifyView.style.display = 'none';
  if (forgotView) forgotView.style.display = 'none';
  hideAuthAlert();

  if (tab === 'signin') {
    tabSignIn.style.color = 'var(--c-blue)';
    tabSignIn.style.borderBottom = '2px solid var(--c-blue)';
    tabSignIn.style.fontWeight = '600';
    tabSignUp.style.color = 'var(--c-text2)';
    tabSignUp.style.borderBottom = '2px solid transparent';
    tabSignUp.style.fontWeight = '500';
    signInForm.style.display = 'flex';
    signUpForm.style.display = 'none';
  } else {
    tabSignUp.style.color = 'var(--c-blue)';
    tabSignUp.style.borderBottom = '2px solid var(--c-blue)';
    tabSignUp.style.fontWeight = '600';
    tabSignIn.style.color = 'var(--c-text2)';
    tabSignIn.style.borderBottom = '2px solid transparent';
    tabSignIn.style.fontWeight = '500';
    signUpForm.style.display = 'flex';
    signInForm.style.display = 'none';
  }
}

function showAuthAlert(msg, isSuccess = false) {
  const el = document.getElementById('authAlert');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = msg;
  if (isSuccess) {
    el.style.background = 'rgba(52,211,153,.15)';
    el.style.border = '1px solid rgba(52,211,153,.3)';
    el.style.color = '#10b981';
  } else {
    el.style.background = 'rgba(239,68,68,.12)';
    el.style.border = '1px solid rgba(239,68,68,.25)';
    el.style.color = '#ef4444';
  }
}

function hideAuthAlert() {
  const el = document.getElementById('authAlert');
  if (el) el.style.display = 'none';
}

function showOtpVerification(email, type = 'email_verification', devCode = null) {
  pendingAuthEmail = email;
  pendingAuthType = type;
  hideAuthAlert();

  const tabContainer = document.getElementById('tabSignIn')?.parentElement;
  if (tabContainer) tabContainer.style.display = 'none';
  document.getElementById('signInForm').style.display = 'none';
  document.getElementById('signUpForm').style.display = 'none';
  document.getElementById('forgotPassView').style.display = 'none';

  const verifyView = document.getElementById('verifyOtpView');
  verifyView.style.display = 'flex';

  const titleEl = document.getElementById('otpViewTitle');
  const descEl = document.getElementById('otpViewDesc');
  if (type === '2fa_login') {
    titleEl.textContent = 'Two-Factor Authentication (2FA)';
    descEl.innerHTML = `Enter the 6-digit login code sent to <strong>${esc(email)}</strong>`;
  } else {
    titleEl.textContent = 'Confirm Your Email';
    descEl.innerHTML = `Enter the 6-digit confirmation code sent to <strong>${esc(email)}</strong>`;
  }

  const input = document.getElementById('otpCodeInput');
  input.value = '';
  input.focus();

  if (devCode) {
    showAuthAlert(`🔑 Dev Notice: Your verification code is ${devCode}`, true);
  }
}

function showForgotPassword() {
  hideAuthAlert();
  const tabContainer = document.getElementById('tabSignIn')?.parentElement;
  if (tabContainer) tabContainer.style.display = 'none';
  document.getElementById('signInForm').style.display = 'none';
  document.getElementById('signUpForm').style.display = 'none';
  document.getElementById('verifyOtpView').style.display = 'none';

  const forgotView = document.getElementById('forgotPassView');
  forgotView.style.display = 'flex';

  document.getElementById('forgotStep1Form').style.display = 'flex';
  document.getElementById('forgotStep2Form').style.display = 'none';
  const emailInput = document.getElementById('forgotEmail');
  emailInput.value = document.getElementById('signInEmail')?.value || '';
  emailInput.focus();
}

async function handleSignIn(e) {
  e.preventDefault();
  const email = document.getElementById('signInEmail').value.trim();
  const password = document.getElementById('signInPassword').value;
  const submitBtn = document.getElementById('signInSubmit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in...';

  const res = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });

  submitBtn.disabled = false;
  submitBtn.textContent = 'Sign In';

  if (res.requires2FA) {
    showOtpVerification(email, '2fa_login', res.devCode);
    toast('🛡️ 2FA login code sent to your email!');
    return;
  }

  if (res.success && res.token) {
    localStorage.setItem('mymail_token', res.token);
    state.currentUser = res.user;
    closeAuthModal();
    toast(`Welcome back, ${res.user.name}! 👋`);
    await loadAccounts();
    await loadEmails('INBOX');
  } else {
    showAuthAlert(res.error || 'Failed to sign in');
  }
}

async function handleSignUp(e) {
  e.preventDefault();
  const name = document.getElementById('signUpName').value.trim();
  const email = document.getElementById('signUpEmail').value.trim();
  const password = document.getElementById('signUpPassword').value;
  const confirm = document.getElementById('signUpConfirm').value;
  const submitBtn = document.getElementById('signUpSubmit');

  if (password !== confirm) {
    showAuthAlert('Passwords do not match');
    return;
  }
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating account...';

  const res = await apiFetch('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name, email, password })
  });

  submitBtn.disabled = false;
  submitBtn.textContent = 'Create Account & Protect My Data';

  if (res.requiresVerification) {
    showOtpVerification(email, 'email_verification', res.devCode);
    toast('📬 Verification code sent to your email!');
    return;
  }

  if (res.success && res.token) {
    localStorage.setItem('mymail_token', res.token);
    state.currentUser = res.user;
    closeAuthModal();
    toast(`Account created! Welcome, ${res.user.name} 🎉`);
    await loadAccounts();
    await loadEmails('INBOX');
  } else {
    showAuthAlert(res.error || 'Signup failed');
  }
}

async function handleVerifyOtp() {
  const code = document.getElementById('otpCodeInput').value.trim();
  if (code.length < 6) {
    showAuthAlert('Please enter the full 6-digit code');
    return;
  }

  const submitBtn = document.getElementById('otpSubmitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Verifying...';

  const res = await apiFetch('/api/auth/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ email: pendingAuthEmail, code, type: pendingAuthType })
  });

  submitBtn.disabled = false;
  submitBtn.textContent = 'Verify & Continue';

  if (res.success && res.token) {
    localStorage.setItem('mymail_token', res.token);
    state.currentUser = res.user;
    closeAuthModal();
    toast(`🎉 Verification successful! Welcome, ${res.user.name}!`);
    await loadAccounts();
    await loadEmails('INBOX');
  } else {
    showAuthAlert(res.error || 'Invalid verification code');
  }
}

async function handleResendOtp(e) {
  e.preventDefault();
  if (!pendingAuthEmail) return;
  toast('Sending new code...');
  const res = await apiFetch('/api/auth/resend-otp', {
    method: 'POST',
    body: JSON.stringify({ email: pendingAuthEmail, type: pendingAuthType })
  });

  if (res.success) {
    toast('New code sent to ' + pendingAuthEmail);
    if (res.devCode) {
      showAuthAlert(`🔑 New code: ${res.devCode}`, true);
    }
  } else {
    showAuthAlert(res.error || 'Failed to resend code');
  }
}

async function handleForgotStep1(e) {
  e.preventDefault();
  const email = document.getElementById('forgotEmail').value.trim();
  const sendBtn = document.getElementById('forgotSendBtn');
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending code...';

  const res = await apiFetch('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email })
  });

  sendBtn.disabled = false;
  sendBtn.textContent = 'Send Reset Code';

  if (res.success) {
    pendingResetEmail = email;
    document.getElementById('forgotStep1Form').style.display = 'none';
    document.getElementById('forgotStep2Form').style.display = 'flex';
    document.getElementById('forgotCode').focus();
    toast('Reset code sent to your email!');
    if (res.devCode) {
      showAuthAlert(`🔑 Dev Reset Code: ${res.devCode}`, true);
    }
  } else {
    showAuthAlert(res.error || 'Failed to request reset code');
  }
}

async function handleForgotStep2(e) {
  e.preventDefault();
  const code = document.getElementById('forgotCode').value.trim();
  const newPassword = document.getElementById('forgotNewPassword').value;
  const confirmPassword = document.getElementById('forgotConfirmPassword').value;

  if (newPassword !== confirmPassword) {
    showAuthAlert('Passwords do not match');
    return;
  }
  if (newPassword.length < 6) {
    showAuthAlert('Password must be at least 6 characters');
    return;
  }

  const submitBtn = document.getElementById('forgotResetSubmitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Resetting password...';

  const res = await apiFetch('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ email: pendingResetEmail, code, newPassword })
  });

  submitBtn.disabled = false;
  submitBtn.textContent = 'Reset Password & Sign In';

  if (res.success && res.token) {
    localStorage.setItem('mymail_token', res.token);
    state.currentUser = res.user;
    closeAuthModal();
    toast('🎉 Password reset successfully! Logged in.');
    await loadAccounts();
    await loadEmails('INBOX');
  } else {
    showAuthAlert(res.error || 'Failed to reset password');
  }
}

async function openAccountModal() {
  const modal = document.getElementById('accountModal');
  if (!modal) return;
  modal.classList.add('open');
  switchAccountTab('mailboxes');

  const nameEl = document.getElementById('accModalName');
  const emailEl = document.getElementById('accModalEmail');
  const avatarEl = document.getElementById('accModalAvatar');
  const badgeEl = document.getElementById('accModalBadge');
  const footerStatus = document.getElementById('accFooterStatus');
  const signOutBtn = document.getElementById('accSignOutBtn');

  if (state.currentUser) {
    nameEl.textContent = state.currentUser.name;
    emailEl.textContent = state.currentUser.email;
    avatarEl.style.background = getAvatarColor(state.currentUser.email);
    avatarEl.textContent = getInitials(state.currentUser.name);
    badgeEl.textContent = 'DATA PROTECTED';
    badgeEl.style.background = 'rgba(52,211,153,.15)';
    badgeEl.style.color = '#10b981';
    footerStatus.textContent = `Signed in as ${state.currentUser.email}`;
    signOutBtn.style.display = 'inline-block';
    signOutBtn.textContent = '🚪 Sign Out';
    signOutBtn.style.border = '1px solid #ef4444';
    signOutBtn.style.background = 'rgba(239,68,68,.1)';
    signOutBtn.style.color = '#ef4444';
    const editName = document.getElementById('accEditName');
    if (editName) editName.value = state.currentUser.name;
    const toggle2fa = document.getElementById('toggle2faCheckbox');
    if (toggle2fa) toggle2fa.checked = !!state.currentUser.twoFactorEnabled;
  } else {
    nameEl.textContent = 'Guest / Demo User';
    emailEl.textContent = 'Stored locally in browser';
    avatarEl.style.background = '#607d8b';
    avatarEl.textContent = '👤';
    badgeEl.textContent = 'GUEST MODE';
    badgeEl.style.background = 'rgba(251,191,36,.15)';
    badgeEl.style.color = '#f59e0b';
    footerStatus.textContent = 'Not signed in';
    signOutBtn.style.display = 'inline-block';
    signOutBtn.textContent = '🔑 Sign In / Register';
    signOutBtn.style.border = '1px solid var(--c-blue)';
    signOutBtn.style.background = 'rgba(26,115,232,.1)';
    signOutBtn.style.color = 'var(--c-blue)';
    const editName = document.getElementById('accEditName');
    if (editName) editName.value = 'Guest';
  }

  renderAccountModalMailboxes();
  updateDataVaultStats();
}

function closeAccountModal() {
  const modal = document.getElementById('accountModal');
  if (modal) modal.classList.remove('open');
}

function switchAccountTab(tab) {
  const btnMailboxes = document.getElementById('accTabMailboxes');
  const btnData = document.getElementById('accTabData');
  const btnSettings = document.getElementById('accTabSettings');

  const viewMailboxes = document.getElementById('accViewMailboxes');
  const viewData = document.getElementById('accViewData');
  const viewSettings = document.getElementById('accViewSettings');

  [btnMailboxes, btnData, btnSettings].forEach(b => {
    b.style.color = 'var(--c-text2)';
    b.style.borderBottom = '2px solid transparent';
    b.style.fontWeight = '500';
  });
  [viewMailboxes, viewData, viewSettings].forEach(v => v.style.display = 'none');

  if (tab === 'mailboxes') {
    btnMailboxes.style.color = 'var(--c-blue)';
    btnMailboxes.style.borderBottom = '2px solid var(--c-blue)';
    btnMailboxes.style.fontWeight = '600';
    viewMailboxes.style.display = 'block';
  } else if (tab === 'data') {
    btnData.style.color = 'var(--c-blue)';
    btnData.style.borderBottom = '2px solid var(--c-blue)';
    btnData.style.fontWeight = '600';
    viewData.style.display = 'flex';
  } else {
    btnSettings.style.color = 'var(--c-blue)';
    btnSettings.style.borderBottom = '2px solid var(--c-blue)';
    btnSettings.style.fontWeight = '600';
    viewSettings.style.display = 'flex';
  }
}

function renderAccountModalMailboxes() {
  const list = document.getElementById('accMailboxList');
  if (!list) return;
  if (state.accounts.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:24px;color:var(--c-text2);font-size:13px;">No mailboxes connected yet. Click "+ Connect Mailbox" to add one!</div>`;
    return;
  }
  list.innerHTML = state.accounts.map(acc => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:10px;border:1px solid ${acc.id === state.activeAccountId ? 'var(--c-blue)' : 'var(--c-border)'};background:${acc.id === state.activeAccountId ? 'rgba(26,115,232,.05)' : 'var(--c-surface2)'};">
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="width:36px;height:36px;border-radius:50%;background:${acc.avatarColor || getAvatarColor(acc.email)};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;">
          ${getInitials(acc.name)}
        </div>
        <div>
          <div style="font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px;">
            ${esc(acc.name)}
            ${acc.id === state.activeAccountId ? '<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;background:rgba(26,115,232,.2);color:var(--c-blue)">ACTIVE</span>' : ''}
          </div>
          <div style="font-size:12px;color:var(--c-text2);">${esc(acc.email)} (${acc.emailProvider || 'Custom'})</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        ${acc.id !== state.activeAccountId ? `<button onclick="switchAccount('${acc.id}');closeAccountModal();" class="btn-text" style="padding:4px 10px;font-size:12px;border:1px solid var(--c-border);border-radius:6px;cursor:pointer;">Set Active</button>` : ''}
        <button onclick="closeAccountModal();openEditAccount('${acc.id}');" class="btn-text" style="padding:4px 10px;font-size:12px;border:1px solid var(--c-border);border-radius:6px;cursor:pointer;">Settings</button>
      </div>
    </div>
  `).join('');
}

async function updateDataVaultStats() {
  const statMail = document.getElementById('statMailboxes');
  const statEmails = document.getElementById('statEmails');
  const statContacts = document.getElementById('statContacts');
  if (statMail) statMail.textContent = state.accounts.length;
  if (statEmails) statEmails.textContent = state.emails.length;

  try {
    const contacts = await apiFetch('/api/marketing/contacts');
    if (statContacts) statContacts.textContent = Array.isArray(contacts) ? contacts.length : 0;
  } catch (e) {}

  if (state.currentUser) {
    const me = await apiFetch('/api/auth/me');
    if (me.user) {
      if (statEmails && me.user.cachedEmailsCount) statEmails.textContent = me.user.cachedEmailsCount;
      if (statContacts && me.user.contactsCount !== undefined) statContacts.textContent = me.user.contactsCount;
      const backendLabel = document.getElementById('accStorageBackendLabel');
      if (backendLabel && me.user.hasMongo) {
        backendLabel.textContent = '☁️ MongoDB Atlas Cloud';
        backendLabel.style.color = '#10b981';
      }
    }
  }
}

function downloadBackup() {
  const token = localStorage.getItem('mymail_token');
  const url = '/api/backup/export' + (token ? `?auth=${encodeURIComponent(token)}` : '');
  window.open(url, '_blank');
  toast('📥 Full backup JSON download started!');
}

async function handleRestoreFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    showLoading();
    const res = await apiFetch('/api/backup/restore', {
      method: 'POST',
      body: JSON.stringify(json)
    });
    hideLoading();
    if (res.success) {
      toast('🎉 All data successfully restored!');
      await loadAccounts();
      await loadEmails('INBOX');
      openAccountModal();
    } else {
      toast(`Restore error: ${res.error || 'Failed'}`);
    }
  } catch (err) {
    hideLoading();
    toast('Invalid backup file: ' + err.message);
  }
}

async function handleProfileSave(e) {
  e.preventDefault();
  const name = document.getElementById('accEditName').value.trim();
  const currentPassword = document.getElementById('accCurrentPass').value;
  const newPassword = document.getElementById('accNewPass').value;

  if (!state.currentUser) {
    toast('Please Sign In to save profile changes');
    openAuthModal('signin');
    return;
  }

  const res = await apiFetch('/api/auth/update-profile', {
    method: 'POST',
    body: JSON.stringify({ name, currentPassword, newPassword })
  });

  if (res.success) {
    toast('Profile updated successfully! ✅');
    state.currentUser.name = res.user.name;
    document.getElementById('accCurrentPass').value = '';
    document.getElementById('accNewPass').value = '';
    updateProfileBtn();
    openAccountModal();
  } else {
    toast(res.error || 'Update failed');
  }
}

async function signOut() {
  if (!confirm('Are you sure you want to sign out?')) return;
  await apiFetch('/api/auth/logout', { method: 'POST' });
  localStorage.removeItem('mymail_token');
  state.currentUser = null;
  closeAccountModal();
  toast('Signed out successfully');
  await loadAccounts();
  await loadEmails('INBOX');
  updateProfileBtn();
}

// Header Profile & Auth Listeners
const profileBtnEl = document.getElementById('profileBtn');
if (profileBtnEl) {
  profileBtnEl.addEventListener('click', () => {
    openAccountModal();
  });
}

const authTriggerEl = document.getElementById('authTriggerBtn');
if (authTriggerEl) {
  authTriggerEl.addEventListener('click', () => {
    openAuthModal('signin');
  });
}

// Auth modal listeners
document.getElementById('authClose')?.addEventListener('click', closeAuthModal);
document.getElementById('tabSignIn')?.addEventListener('click', () => switchAuthTab('signin'));
document.getElementById('tabSignUp')?.addEventListener('click', () => switchAuthTab('signup'));
document.getElementById('signInForm')?.addEventListener('submit', handleSignIn);
document.getElementById('signUpForm')?.addEventListener('submit', handleSignUp);
document.getElementById('authDemoBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  closeAuthModal();
  toast('Continuing in Demo / Guest mode');
});

// Account Hub modal listeners
document.getElementById('accountModalClose')?.addEventListener('click', closeAccountModal);
document.getElementById('accTabMailboxes')?.addEventListener('click', () => switchAccountTab('mailboxes'));
document.getElementById('accTabData')?.addEventListener('click', () => switchAccountTab('data'));
document.getElementById('accTabSettings')?.addEventListener('click', () => switchAccountTab('settings'));
document.getElementById('accAddMailboxBtn')?.addEventListener('click', () => {
  closeAccountModal();
  openAddAccount();
});
document.getElementById('accDownloadBackupBtn')?.addEventListener('click', downloadBackup);
document.getElementById('accRestoreFileInput')?.addEventListener('change', handleRestoreFile);
document.getElementById('accProfileForm')?.addEventListener('submit', handleProfileSave);
document.getElementById('accSignOutBtn')?.addEventListener('click', () => {
  if (!state.currentUser) {
    closeAccountModal();
    openAuthModal('signin');
  } else {
    signOut();
  }
});

// Forgot Password & 2FA Listeners
document.getElementById('authForgotBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  showForgotPassword();
});
document.getElementById('otpSubmitBtn')?.addEventListener('click', handleVerifyOtp);
document.getElementById('otpResendBtn')?.addEventListener('click', handleResendOtp);
document.getElementById('otpBackBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  switchAuthTab('signin');
});
document.getElementById('forgotBackBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  switchAuthTab('signin');
});
document.getElementById('forgotStep1Form')?.addEventListener('submit', handleForgotStep1);
document.getElementById('forgotStep2Form')?.addEventListener('submit', handleForgotStep2);

// Auto-submit OTP when 6 digits are typed
document.getElementById('otpCodeInput')?.addEventListener('input', (e) => {
  if (e.target.value.length === 6) handleVerifyOtp();
});

// Toggle 2FA in Account Hub
document.getElementById('toggle2faCheckbox')?.addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  const res = await apiFetch('/api/auth/toggle-2fa', {
    method: 'POST',
    body: JSON.stringify({ enabled })
  });
  if (res.success) {
    if (state.currentUser) state.currentUser.twoFactorEnabled = enabled;
    toast(enabled ? '🛡️ 2FA Email Confirmation enabled!' : '2FA disabled');
  } else {
    e.target.checked = !enabled;
    toast(res.error || 'Failed to update 2FA setting');
  }
});



// Simulate incoming email test
window.simulateInboundEmail = async function() {
  toast('⏳ Requesting test incoming email...');
  const res = await apiFetch('/api/inbound/test', {
    method: 'POST',
    body: JSON.stringify({ accountId: state.activeAccountId })
  });
  if (res.success) {
    toast('🎉 Incoming test email received in INBOX!');
    await loadEmails('INBOX');
    setActiveNavItem('INBOX');
  } else {
    toast(`Error: ${res.error || 'Failed'}`);
  }
};

const simBtn = document.getElementById('simulateInboundBtn');
if (simBtn) simBtn.addEventListener('click', window.simulateInboundEmail);

// ── SSE for real-time updates ─────────────────────────────────────
function setupSSE() {
  try {
    const es = new EventSource('/api/events');
    es.onmessage = async (e) => {
      const data = JSON.parse(e.data);
      if (data.payload?.accountId === state.activeAccountId) {
        if (data.type === 'email_sent' && state.currentFolder === 'Sent') await loadEmails();
        if (data.type === 'email_received' && state.currentFolder === 'INBOX') await loadEmails();
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
  await checkAuth();
  await loadProviders();
  await Vault.selfHeal();
  await loadAccounts();
  await loadEmails();
  setupEventListeners();
  setupSSE();
  hideLoading();

  // Background auto-sync emails every 20 seconds
  setInterval(async () => {
    if (state.activeAccountId && state.currentFolder === 'INBOX' && !document.hidden) {
      const res = await apiFetch('/api/imap/fetch', {
        method: 'POST', body: JSON.stringify({ accountId: state.activeAccountId, folder: 'INBOX', limit: 50 })
      });
      if (res.emails && res.emails.length !== state.emails.length) {
        state.emails = res.emails;
        renderEmailList(res.emails);
        updateBadges();
      }
    }
  }, 20000);
}

init();
