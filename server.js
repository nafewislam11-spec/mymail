const express = require('express');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const nodemailer = require('nodemailer');
const imapSimple = require('imap-simple');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const { parse: csvParse } = require('csv-parse/sync');

// ── Data Storage Directory & Vercel Compatibility ────────────────────────
const IS_VERCEL = !!process.env.VERCEL;
const DATA_DIR = IS_VERCEL
  ? path.join('/tmp', 'mymail_data')
  : path.join(__dirname, 'data');

try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (e) {
  console.warn('Could not create DATA_DIR:', e.message);
}

const MARKETING_DB = path.join(DATA_DIR, 'marketing.json');
function loadMarketing() {
  try {
    if (!fs.existsSync(MARKETING_DB)) return { campaigns: [], contacts: [], businessProfile: {} };
    return JSON.parse(fs.readFileSync(MARKETING_DB, 'utf8'));
  } catch {
    return { campaigns: [], contacts: [], businessProfile: {} };
  }
}
function saveMarketing(data) {
  try {
    fs.writeFileSync(MARKETING_DB, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('Could not save marketing DB:', e.message);
  }
}
let marketingData = loadMarketing();

// ── Free Provider Configurations ──────────────────────────────────────────
const FREE_PROVIDERS = {
  gmail: {
    label: 'Gmail / Google Workspace',
    note: 'Use a Google App Password (not your normal password)',
    guideUrl: 'https://myaccount.google.com/apppasswords',
    smtp: { host: 'smtp.gmail.com', port: 587, secure: false },
    imap: { host: 'imap.gmail.com', port: 993, tls: true },
    dailyLimit: '500 emails/day (Gmail) or 2000 (Workspace)',
    price: '🆓 Completely Free'
  },
  outlook: {
    label: 'Outlook / Hotmail / Live',
    note: 'Enable SMTP AUTH in Outlook settings, use App Password',
    guideUrl: 'https://account.microsoft.com/security',
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    imap: { host: 'outlook.office365.com', port: 993, tls: true },
    dailyLimit: '300 emails/day',
    price: '🆓 Completely Free'
  },
  brevo: {
    label: 'Brevo (ex-Sendinblue) — Free SMTP',
    note: 'Sign up at brevo.com → Settings → SMTP & API → Generate SMTP key',
    guideUrl: 'https://app.brevo.com/settings/keys/smtp',
    smtp: { host: 'smtp-relay.brevo.com', port: 587, secure: false },
    imap: null,
    dailyLimit: '300 emails/day',
    price: '🆓 Free (no credit card)'
  },
  resend: {
    label: 'Resend.com — Free API (No SMTP needed!)',
    note: 'Sign up at resend.com → API Keys → Create Key. Paste it below.',
    guideUrl: 'https://resend.com/api-keys',
    smtp: null,
    imap: null,
    dailyLimit: '100 emails/day, 3000/month',
    price: '🆓 Free (no credit card)'
  },
  mailgun: {
    label: 'Mailgun — Free Flex Plan',
    note: 'Sign up at mailgun.com → Sending → Domains → SMTP credentials',
    guideUrl: 'https://app.mailgun.com/mg/sending/domains',
    smtp: { host: 'smtp.mailgun.org', port: 587, secure: false },
    imap: null,
    dailyLimit: '100 emails/day',
    price: '🆓 Free tier available'
  },
  zoho_free: {
    label: 'Zoho Mail — IMAP Only (Free plan)',
    note: 'Zoho free plan supports IMAP read but NOT outgoing SMTP. Use another provider to send.',
    guideUrl: 'https://mail.zoho.com/zm/#mail',
    smtp: null,
    imap: { host: 'imap.zoho.com', port: 993, tls: true },
    dailyLimit: 'Receive only',
    price: '🆓 Free (receive only — send via Gmail/Brevo/Resend)'
  },
  custom: {
    label: 'Custom SMTP Server',
    note: 'Your own VPS, cPanel, or any other SMTP server',
    guideUrl: null,
    smtp: { host: '', port: 587, secure: false },
    imap: { host: '', port: 993, tls: true },
    dailyLimit: 'Unlimited',
    price: '💰 Depends on your host'
  }
};

const app = express();
const PORT = process.env.PORT || 3500;
const DB_PATH = path.join(DATA_DIR, 'db.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DB Helpers ─────────────────────────────────────────────────────────────
function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      try {
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
        fs.writeFileSync(DB_PATH, JSON.stringify(defaultDB(), null, 2));
      } catch (err) {
        console.warn('Could not write initial DB_PATH:', err.message);
      }
      return defaultDB();
    }
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch { return defaultDB(); }
}

// ── MongoDB Atlas Cloud Persistence ─────────────────────────────────────────
let mongoDb = null;
async function initMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return;
  try {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    mongoDb = client.db('mymail');
    console.log('✅ Connected to MongoDB Atlas Cloud Database!');
    const cloudState = await mongoDb.collection('app_state').findOne({ _id: 'global_state' });
    if (cloudState && cloudState.db) {
      if (cloudState.db.users) db.users = cloudState.db.users;
      if (cloudState.db.accounts) db.accounts = cloudState.db.accounts;
      if (cloudState.db.activeAccountId) db.activeAccountId = cloudState.db.activeAccountId;
      if (cloudState.db.emailCache) db.emailCache = cloudState.db.emailCache;
      if (cloudState.db.marketing) marketingData = cloudState.db.marketing;
      console.log('✅ Loaded persistent database state from MongoDB Atlas!');
    }
  } catch (err) {
    console.warn('MongoDB connection notice:', err.message);
  }
}
initMongo();

async function saveDB(dbData) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(dbData, null, 2));
  } catch (err) {
    console.warn('Could not save DB to disk:', err.message);
  }
  if (mongoDb) {
    try {
      await mongoDb.collection('app_state').replaceOne(
        { _id: 'global_state' },
        { _id: 'global_state', db: dbData, marketing: marketingData, updatedAt: new Date().toISOString() },
        { upsert: true }
      );
    } catch (mErr) {
      console.warn('Could not save to MongoDB:', mErr.message);
    }
  }
}

function defaultDB() {
  return {
    users: [],
    accounts: [],
    activeAccountId: null,
    // Local cache of emails per account
    emailCache: {},
    drafts: {},
    contacts: {}
  };
}

// ── Preload a demo account so it works out of the box ─────────────────────
function ensureDemoAccount(db) {
  if (db.accounts.length === 0) {
    const demo = {
      id: 'acc_demo',
      name: 'Demo User',
      email: 'demo@mymail.app',
      avatarColor: '#1a73e8',
      smtp: { host: 'smtp.gmail.com', port: 587, secure: false, user: '', pass: '' },
      imap: { host: 'imap.gmail.com', port: 993, tls: true, user: '', pass: '' },
      isDemo: true,
      createdAt: new Date().toISOString()
    };
    db.accounts.push(demo);
    db.activeAccountId = 'acc_demo';
    db.emailCache['acc_demo'] = {
      INBOX: generateDemoEmails(),
      Sent: generateSentEmails(),
      Drafts: [],
      Trash: [],
      Spam: []
    };
    db.contacts['acc_demo'] = [
      { id: 'c1', name: 'Google Workspace', email: 'workspace@google.com', avatar: '#ea4335' },
      { id: 'c2', name: 'Sarah Connor', email: 'sarah@cyberdyne.io', avatar: '#34a853' },
      { id: 'c3', name: 'Liam Chen', email: 'liam@designstudio.co', avatar: '#4285f4' },
      { id: 'c4', name: 'Zara Ahmed', email: 'zara@pulsecreative.io', avatar: '#fbbc05' }
    ];
    saveDB(db);
  }
  return db;
}

function generateDemoEmails() {
  const now = Date.now();
  const h = (n) => now - n * 3600000;
  return [
    {
      id: 'em1', uid: 1, subject: 'Welcome to MyMail — your custom domain inbox is ready 🎉',
      from: 'MyMail Team <hello@mymail.app>', fromEmail: 'hello@mymail.app',
      to: 'demo@mymail.app', date: new Date(h(1)).toISOString(), read: false, starred: true,
      labels: ['Primary'],
      snippet: 'Hey there! Your custom domain email is now fully configured and ready to use.',
      html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#202124">
        <div style="background:linear-gradient(135deg,#1a73e8,#0f56c7);padding:40px 32px;border-radius:8px 8px 0 0;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:28px">Welcome to MyMail ✉️</h1>
          <p style="color:#e8f0fe;margin:12px 0 0">Your custom domain inbox is ready</p>
        </div>
        <div style="padding:32px;background:#fff;border-radius:0 0 8px 8px">
          <p>Hey there! 👋</p>
          <p>Your <strong>custom domain email</strong> is now fully configured and ready to send and receive messages.</p>
          <h3>What you can do:</h3>
          <ul>
            <li>📬 Send & receive emails with your own domain</li>
            <li>🔗 Connect multiple SMTP/IMAP accounts</li>
            <li>⭐ Star, archive, label, and organize your inbox</li>
            <li>🔍 Search across all your mail instantly</li>
          </ul>
          <div style="margin:24px 0;padding:16px;background:#f8f9fa;border-radius:8px;border-left:4px solid #1a73e8">
            <strong>Pro Tip:</strong> Go to <em>Settings → Add Account</em> to connect your real SMTP and IMAP servers.
          </div>
          <p>Cheers,<br><strong>The MyMail Team</strong></p>
        </div>
      </div>`
    },
    {
      id: 'em2', uid: 2, subject: 'Q4 Campaign Results — We closed the Nordhaus contract 🏆',
      from: 'Sarah Connor <sarah@cyberdyne.io>', fromEmail: 'sarah@cyberdyne.io',
      to: 'demo@mymail.app', date: new Date(h(3)).toISOString(), read: false, starred: false,
      labels: ['Primary'],
      snippet: 'Quick update on Q4 — we closed the Nordic Haus Architecture contract. $12k signed. Kickoff Monday.',
      html: `<div style="font-family:Arial,sans-serif;color:#202124;padding:24px">
        <p>Hey,</p>
        <p>Quick update on Q4 — <strong>we closed the Nordic Haus Architecture contract</strong>. $12k signed. Kickoff call is Monday at 10 AM.</p>
        <p>I need you to prep the onboarding deck before EOD Friday. Let me know if you need the brand files.</p>
        <p>Also — are you free for a 30-min call tomorrow at 2 PM to go over the content strategy?</p>
        <p>Best,<br><strong>Sarah Connor</strong><br><span style="color:#5f6368">Head of Growth · Cyberdyne Dynamics</span></p>
      </div>`
    },
    {
      id: 'em3', uid: 3, subject: 'Invoice #1047 — Web Design Retainer (September)',
      from: 'Liam Chen <liam@designstudio.co>', fromEmail: 'liam@designstudio.co',
      to: 'demo@mymail.app', date: new Date(h(6)).toISOString(), read: true, starred: false,
      labels: ['Updates'],
      snippet: 'Please find attached Invoice #1047 for the September web design retainer. Amount due: $4,500.',
      html: `<div style="font-family:Arial,sans-serif;color:#202124;padding:24px">
        <p>Hi,</p>
        <p>Please find attached <strong>Invoice #1047</strong> for the September web design retainer.</p>
        <table style="border-collapse:collapse;width:100%;margin:16px 0">
          <tr style="background:#f1f3f4"><th style="padding:10px;text-align:left;border:1px solid #dadce0">Description</th><th style="padding:10px;text-align:right;border:1px solid #dadce0">Amount</th></tr>
          <tr><td style="padding:10px;border:1px solid #dadce0">Web Design Retainer — September 2026</td><td style="padding:10px;text-align:right;border:1px solid #dadce0">$4,000</td></tr>
          <tr><td style="padding:10px;border:1px solid #dadce0">Figma Component System (add-on)</td><td style="padding:10px;text-align:right;border:1px solid #dadce0">$500</td></tr>
          <tr style="background:#e8f0fe;font-weight:bold"><td style="padding:10px;border:1px solid #dadce0">Total Due</td><td style="padding:10px;text-align:right;border:1px solid #dadce0">$4,500</td></tr>
        </table>
        <p>Payment due by October 10, 2026. Bank transfer details are in the attached PDF.</p>
        <p>Thanks,<br><strong>Liam Chen</strong><br><span style="color:#5f6368">Design Studio Co.</span></p>
      </div>`
    },
    {
      id: 'em4', uid: 4, subject: 'Re: Website copy feedback — love the new direction!',
      from: 'Zara Ahmed <zara@pulsecreative.io>', fromEmail: 'zara@pulsecreative.io',
      to: 'demo@mymail.app', date: new Date(h(24)).toISOString(), read: true, starred: true,
      labels: ['Primary'],
      snippet: 'Absolutely love the new homepage copy! The hero section is spot on. Only one small change — can we swap "Solutions" for "Services"?',
      html: `<div style="font-family:Arial,sans-serif;color:#202124;padding:24px">
        <p>Hi!</p>
        <p>Absolutely <strong>love the new homepage copy!</strong> The hero section is spot on and really captures our voice.</p>
        <p>Only one small change — can we swap <em>"Solutions"</em> for <em>"Services"</em> in the nav? Our audience responds better to it.</p>
        <p>Otherwise, please go ahead and implement it! Looking forward to seeing the live version.</p>
        <p>— <strong>Zara Ahmed</strong><br><span style="color:#5f6368">Creative Director · Pulse Creative</span></p>
      </div>`
    },
    {
      id: 'em5', uid: 5, subject: 'Google Workspace — Your monthly digest is here',
      from: 'Google Workspace <workspace@google.com>', fromEmail: 'workspace@google.com',
      to: 'demo@mymail.app', date: new Date(h(48)).toISOString(), read: true, starred: false,
      labels: ['Updates'],
      snippet: 'Your Google Workspace digest for September 2026. 47 meetings, 312 emails sent, 18 GB storage used.',
      html: `<div style="font-family:Arial,sans-serif;color:#202124;max-width:600px;margin:0 auto">
        <div style="padding:24px;background:#1a73e8;text-align:center">
          <h2 style="color:#fff;margin:0">September 2026 Digest</h2>
        </div>
        <div style="padding:24px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0">
            <div style="padding:16px;background:#f8f9fa;border-radius:8px;text-align:center"><div style="font-size:28px;font-weight:bold;color:#1a73e8">47</div><div>Meetings held</div></div>
            <div style="padding:16px;background:#f8f9fa;border-radius:8px;text-align:center"><div style="font-size:28px;font-weight:bold;color:#34a853">312</div><div>Emails sent</div></div>
          </div>
        </div>
      </div>`
    },
    {
      id: 'em6', uid: 6, subject: 'Meeting request: Brand Discovery Workshop — Oct 3',
      from: 'Sarah Connor <sarah@cyberdyne.io>', fromEmail: 'sarah@cyberdyne.io',
      to: 'demo@mymail.app', date: new Date(h(72)).toISOString(), read: true, starred: false,
      labels: ['Primary'],
      snippet: 'Can we schedule the Brand Discovery Workshop for October 3rd at 2pm? I have the Miro board ready.',
      html: `<div style="font-family:Arial,sans-serif;color:#202124;padding:24px">
        <p>Hi,</p>
        <p>Can we schedule the <strong>Brand Discovery Workshop</strong> for <strong>October 3rd at 2pm</strong>? I have the Miro board ready with all the brand audit materials.</p>
        <p>Agenda:</p>
        <ol>
          <li>Current brand perception audit</li>
          <li>Competitor visual analysis</li>
          <li>Ideal customer persona refinement</li>
          <li>New visual direction moodboard review</li>
        </ol>
        <p>Let me know if this works for you!</p>
        <p>— Sarah</p>
      </div>`
    }
  ];
}

function generateSentEmails() {
  const now = Date.now();
  const h = (n) => now - n * 3600000;
  return [
    {
      id: 'sent1', uid: 10, subject: 'Re: Q4 Campaign Results — Amazing! Let\'s connect Monday',
      from: 'demo@mymail.app', fromEmail: 'demo@mymail.app',
      to: 'sarah@cyberdyne.io', date: new Date(h(2)).toISOString(), read: true, starred: false,
      labels: [],
      snippet: 'Sarah, incredible news! I\'ll have the onboarding deck ready by Thursday EOD. Tuesday 2pm works perfectly for the call.',
      html: `<div style="font-family:Arial,sans-serif;color:#202124;padding:24px"><p>Sarah, incredible news! I'll have the onboarding deck ready by Thursday EOD. Tuesday 2pm works perfectly for the call. See you then!</p></div>`
    },
    {
      id: 'sent2', uid: 11, subject: 'New Project Proposal — Interactive Web Portfolio for Nordic Haus',
      from: 'demo@mymail.app', fromEmail: 'demo@mymail.app',
      to: 'david@nordichaus.design', date: new Date(h(26)).toISOString(), read: true, starred: false,
      labels: [],
      snippet: 'Hi David, please find the full project proposal for the interactive web portfolio attached. Scope, timeline, and investment breakdown included.',
      html: `<div style="font-family:Arial,sans-serif;color:#202124;padding:24px"><p>Hi David,</p><p>Please find the full project proposal for the interactive web portfolio attached. Scope, timeline, and investment breakdown included.</p><p>Looking forward to working together!</p></div>`
    }
  ];
}

// Init DB
let db = loadDB();
db = ensureDemoAccount(db);

// ── SSE for real-time events ────────────────────────────────────────────────
const sseClients = new Set();
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});
function broadcast(type, payload) {
  const data = JSON.stringify({ type, payload });
  for (const c of sseClients) c.write(`data: ${data}\n\n`);
}

// ── Auth Hashing & Session Helpers ──────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, originalHash] = storedHash.split(':');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return hash === originalHash;
}

function generateToken() {
  return 'mm_' + crypto.randomBytes(32).toString('hex');
}

// ── Multi-User Context Resolver (Isolates per-user data or falls back to demo) ─
function getContext(req) {
  const auth = req.headers.authorization;
  let user = null;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.substring(7).trim();
    if (token && db.users) {
      user = db.users.find(u => u.token === token) || null;
    }
  }

  if (user) {
    if (!user.accounts) user.accounts = [];
    if (!user.emailCache) user.emailCache = {};
    if (!user.drafts) user.drafts = {};
    if (!user.contacts) user.contacts = {};
    if (!user.marketing) user.marketing = { campaigns: [], contacts: [], businessProfile: {} };
    if (!user.settings) user.settings = {};
    return {
      isAuth: true,
      user,
      get accounts() { return user.accounts; },
      set accounts(val) { user.accounts = val; },
      get activeAccountId() { return user.activeAccountId; },
      set activeAccountId(id) { user.activeAccountId = id; },
      get emailCache() { return user.emailCache; },
      get drafts() { return user.drafts; },
      get contacts() { return user.contacts; },
      get marketing() { return user.marketing; },
      get settings() { return user.settings; }
    };
  }

  // Demo / Unauthenticated fallback
  if (!db.accounts) db.accounts = [];
  if (!db.emailCache) db.emailCache = {};
  if (!db.drafts) db.drafts = {};
  if (!db.contacts) db.contacts = {};
  if (!db.settings) db.settings = {};
  return {
    isAuth: false,
    user: null,
    get accounts() { return db.accounts; },
    set accounts(val) { db.accounts = val; },
    get activeAccountId() { return db.activeAccountId; },
    set activeAccountId(id) { db.activeAccountId = id; },
    get emailCache() { return db.emailCache; },
    get drafts() { return db.drafts; },
    get contacts() { return db.contacts; },
    get marketing() { return marketingData; },
    get settings() { return db.settings; }
  };
}

// ── AUTHENTICATION APIS ─────────────────────────────────────────────────────
app.post('/api/auth/signup', express.json(), async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const emailStr = String(email || '').trim().toLowerCase();
    if (!emailStr || !emailStr.includes('@') || !emailStr.includes('.')) {
      return res.status(400).json({ error: 'Valid email address is required' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const cleanEmail = email.toLowerCase().trim();
    if (!db.users) db.users = [];
    if (db.users.some(u => u.email.toLowerCase() === cleanEmail)) {
      return res.status(400).json({ error: 'An account with this email already exists. Please Sign In.' });
    }

    const token = generateToken();
    const newUser = {
      id: 'usr_' + Date.now(),
      name: (name || cleanEmail.split('@')[0]).trim(),
      email: cleanEmail,
      passwordHash: hashPassword(password),
      token,
      createdAt: new Date().toISOString(),
      accounts: [],
      activeAccountId: null,
      emailCache: {},
      drafts: {},
      contacts: {},
      marketing: { campaigns: [], contacts: [], businessProfile: {} },
      settings: { senderName: name || '', senderEmail: cleanEmail, geminiKey: '' }
    };

    db.users.push(newUser);
    await saveDB(db);

    res.json({
      success: true,
      token,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        createdAt: newUser.createdAt
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Signup error: ' + err.message });
  }
});

app.post('/api/auth/login', express.json(), async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const user = db.users?.find(u => u.email.toLowerCase() === cleanEmail);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    user.token = generateToken();
    user.lastLogin = new Date().toISOString();
    await saveDB(db);

    res.json({
      success: true,
      token: user.token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Login error: ' + err.message });
  }
});

app.get('/api/auth/me', (req, res) => {
  const ctx = getContext(req);
  if (!ctx.isAuth || !ctx.user) {
    return res.json({ isAuth: false, user: null });
  }
  let totalEmails = 0;
  try {
    for (const f of Object.values(ctx.user.emailCache || {})) {
      if (Array.isArray(f)) totalEmails += f.length;
      else if (typeof f === 'object') {
        for (const sub of Object.values(f)) if (Array.isArray(sub)) totalEmails += sub.length;
      }
    }
  } catch (e) {}

  res.json({
    isAuth: true,
    user: {
      id: ctx.user.id,
      name: ctx.user.name,
      email: ctx.user.email,
      createdAt: ctx.user.createdAt,
      accountsCount: ctx.user.accounts?.length || 0,
      activeAccountId: ctx.user.activeAccountId,
      cachedEmailsCount: totalEmails,
      contactsCount: ctx.user.marketing?.contacts?.length || 0,
      campaignsCount: ctx.user.marketing?.campaigns?.length || 0,
      hasMongo: !!mongoDb
    }
  });
});

app.post('/api/auth/logout', (req, res) => {
  const ctx = getContext(req);
  if (ctx.user) {
    ctx.user.token = null;
    saveDB(db);
  }
  res.json({ success: true });
});

app.post('/api/auth/update-profile', express.json(), async (req, res) => {
  const ctx = getContext(req);
  if (!ctx.isAuth || !ctx.user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, currentPassword, newPassword } = req.body;
  if (name) ctx.user.name = name.trim();
  if (newPassword) {
    if (!verifyPassword(currentPassword, ctx.user.passwordHash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    ctx.user.passwordHash = hashPassword(newPassword);
  }
  await saveDB(db);
  res.json({ success: true, user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email } });
});

// ── BACKUP & DATA LOSS PREVENTION APIS ──────────────────────────────────────
app.get('/api/backup/export', (req, res) => {
  const ctx = getContext(req);
  const data = ctx.isAuth ? ctx.user : {
    accounts: db.accounts,
    emailCache: db.emailCache,
    contacts: db.contacts,
    marketing: marketingData,
    settings: db.settings
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=mymail-backup-${new Date().toISOString().slice(0,10)}.json`);
  res.send(JSON.stringify(data, null, 2));
});

app.post('/api/backup/restore', express.json({ limit: '50mb' }), async (req, res) => {
  const ctx = getContext(req);
  const data = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid backup JSON' });
  }

  if (ctx.isAuth && ctx.user) {
    if (data.accounts) ctx.user.accounts = data.accounts;
    if (data.emailCache) ctx.user.emailCache = data.emailCache;
    if (data.drafts) ctx.user.drafts = data.drafts;
    if (data.contacts) ctx.user.contacts = data.contacts;
    if (data.marketing) ctx.user.marketing = data.marketing;
    if (data.settings) ctx.user.settings = data.settings;
    if (data.activeAccountId) ctx.user.activeAccountId = data.activeAccountId;
  } else {
    if (data.accounts) db.accounts = data.accounts;
    if (data.emailCache) db.emailCache = data.emailCache;
    if (data.drafts) db.drafts = data.drafts;
    if (data.contacts) db.contacts = data.contacts;
    if (data.marketing) { marketingData = data.marketing; saveMarketing(marketingData); }
    if (data.settings) db.settings = data.settings;
  }
  await saveDB(db);
  res.json({ success: true, message: 'All data restored successfully!' });
});

// Self-healing vault sync
app.post('/api/sync/vault', express.json({ limit: '20mb' }), async (req, res) => {
  const ctx = getContext(req);
  const { vault } = req.body;
  if (!vault) return res.json({ status: 'ignored' });

  if (ctx.isAuth && ctx.user) {
    const hasData = (ctx.user.accounts && ctx.user.accounts.length > 0) ||
                    (ctx.user.marketing?.contacts && ctx.user.marketing.contacts.length > 0);
    // If server lost data due to serverless restart, restore from client vault!
    if (!hasData && vault.accounts && vault.accounts.length > 0) {
      ctx.user.accounts = vault.accounts;
      ctx.user.emailCache = vault.emailCache || {};
      ctx.user.contacts = vault.contacts || {};
      ctx.user.marketing = vault.marketing || { campaigns: [], contacts: [], businessProfile: {} };
      ctx.user.settings = vault.settings || {};
      if (vault.activeAccountId) ctx.user.activeAccountId = vault.activeAccountId;
      await saveDB(db);
      return res.json({ status: 'restored_from_vault', message: 'Data auto-recovered from client vault!' });
    }
  }
  res.json({ status: 'synced' });
});

// ── Account APIs ────────────────────────────────────────────────────────────
app.get('/api/accounts', (req, res) => {
  const ctx = getContext(req);
  res.json(ctx.accounts);
});

app.get('/api/accounts/active', (req, res) => {
  const ctx = getContext(req);
  const acc = ctx.accounts.find(a => a.id === ctx.activeAccountId);
  res.json(acc || null);
});

app.post('/api/accounts', (req, res) => {
  const { name, email, avatarColor, smtp, imap, emailProvider, apiKey } = req.body;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(String(email).trim())) {
    return res.status(400).json({ error: `"${email}" is not a valid email address. Please enter a full email like name@yourdomain.com.` });
  }
  const acc = {
    id: 'acc_' + Date.now(),
    name: (name || '').trim(),
    email: email.trim(),
    emailProvider: emailProvider || 'custom',
    apiKey: apiKey || '',
    avatarColor: avatarColor || '#1a73e8',
    smtp, imap,
    isDemo: false,
    createdAt: new Date().toISOString()
  };
  const ctx = getContext(req);
  ctx.accounts.push(acc);
  ctx.emailCache[acc.id] = { INBOX: [], Sent: [], Drafts: [], Trash: [], Spam: [] };
  ctx.contacts[acc.id] = [];
  if (ctx.accounts.length === 1) ctx.activeAccountId = acc.id;
  saveDB(db);
  broadcast('account_added', { id: acc.id, email: acc.email });
  res.json({ success: true, account: acc });
});

app.put('/api/accounts/:id', (req, res) => {
  const ctx = getContext(req);
  const idx = ctx.accounts.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Account not found' });
  if (req.body.email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(String(req.body.email).trim())) {
      return res.status(400).json({ error: `"${req.body.email}" is not a valid email address. Please enter a full email like name@yourdomain.com.` });
    }
  }
  ctx.accounts[idx] = { ...ctx.accounts[idx], ...req.body };
  saveDB(db);
  res.json({ success: true, account: ctx.accounts[idx] });
});

app.delete('/api/accounts/:id', (req, res) => {
  const ctx = getContext(req);
  ctx.accounts = ctx.accounts.filter(a => a.id !== req.params.id);
  delete ctx.emailCache[req.params.id];
  if (ctx.activeAccountId === req.params.id) {
    ctx.activeAccountId = ctx.accounts[0]?.id || null;
  }
  saveDB(db);
  res.json({ success: true });
});

app.post('/api/accounts/:id/activate', (req, res) => {
  const ctx = getContext(req);
  ctx.activeAccountId = req.params.id;
  saveDB(db);
  res.json({ success: true });
});

// ── Return all free provider info ────────────────────────────────────────────
app.get('/api/providers', (req, res) => {
  res.json(FREE_PROVIDERS);
});

// ── SMTP / API Verification ────────────────────────────────────────────────────
app.post('/api/smtp/verify', async (req, res) => {
  const { provider, host, port, secure, user, pass, apiKey } = req.body;

  // Resend API verify
  if (provider === 'resend') {
    if (!apiKey) return res.status(400).json({ success: false, error: 'Please enter your Resend API key' });
    try {
      const result = await callResendApi(apiKey, {
        from: 'test@resend.dev', to: 'delivered@resend.dev',
        subject: 'MyMail connection test', html: '<p>Test</p>'
      });
      if (result.id || result.data?.id) {
        return res.json({ success: true, message: '✅ Resend API key is valid! 3,000 free emails/month.' });
      } else {
        return res.status(400).json({ success: false, error: result.message || result.error || 'Invalid API key' });
      }
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message });
    }
  }

  // SMTP verify
  const smtpHost = host || FREE_PROVIDERS[provider]?.smtp?.host;
  const smtpPort = port || FREE_PROVIDERS[provider]?.smtp?.port || 587;
  if (!smtpHost) return res.status(400).json({ success: false, error: 'No SMTP host configured for this provider' });

  try {
    const t = nodemailer.createTransport({
      host: smtpHost, port: Number(smtpPort),
      secure: Boolean(secure),
      auth: { user, pass },
      connectionTimeout: 8000,
      tls: { rejectUnauthorized: false }
    });
    await t.verify();
    res.json({ success: true, message: `✅ Connected to ${smtpHost}:${smtpPort} — credentials verified!` });
  } catch (e) {
    let hint = e.message;
    if (provider === 'gmail' && hint.includes('535')) hint += '\n\n💡 Tip: Make sure you are using a Google App Password, not your normal Gmail password. Enable 2FA first at myaccount.google.com.';
    if (provider === 'outlook' && hint.includes('535')) hint += '\n\n💡 Tip: Enable "SMTP AUTH" in Outlook settings and use an App Password.';
    res.status(400).json({ success: false, error: hint });
  }
});

// ── IMAP Verification ──────────────────────────────────────────────────────────
app.post('/api/imap/verify', async (req, res) => {
  const { host, port, tls, user, pass } = req.body;
  if (!host || !user || !pass) {
    return res.status(400).json({ success: false, error: 'Please enter IMAP Host, Username, and Password' });
  }

  try {
    const config = {
      imap: {
        user, password: pass,
        host, port: Number(port) || 993,
        tls: tls !== false, authTimeout: 10000,
        tlsOptions: { rejectUnauthorized: false }
      }
    };
    const connection = await imapSimple.connect(config);
    await connection.openBox('INBOX');
    connection.end();
    res.json({ success: true, message: `✅ Successfully connected to ${host}:${port}! Found your INBOX.` });
  } catch (e) {
    let hint = e.message;
    if (host.includes('zoho')) {
      if (hint.includes('AUTHENTICATIONFAILED') || hint.includes('credentials') || hint.includes('Invalid')) {
        hint = `Zoho IMAP Login Failed.\n1. Make sure your Zoho Password is correct.\n2. If 2FA is enabled in Zoho, you MUST generate an App Password at accounts.zoho.com → Security → App Passwords.\n3. Verify that "IMAP Access" is turned ON in mail.zoho.com → Settings → Mail Accounts.`;
      } else if (hint.includes('AUTHORIZATIONFAILED') || hint.includes('disabled')) {
        hint = `Zoho has blocked IMAP for this free account. To receive emails in MyMail without paying Zoho: Forward your Zoho emails to a free Gmail account, then connect Gmail IMAP here!`;
      }
    } else if (host.includes('gmail')) {
      if (hint.includes('AUTHENTICATIONFAILED')) {
        hint = `Gmail IMAP Login Failed. Please use a 16-digit Google App Password (myaccount.google.com/apppasswords), not your normal Gmail password.`;
      }
    }
    res.status(400).json({ success: false, error: hint });
  }
});

// ── Helper: Send via Resend REST API (no SMTP needed) ───────────────────────
function callResendApi(apiKey, { from, to, subject, html, cc, bcc, replyTo }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ from, to, subject, html, cc, bcc, reply_to: replyTo });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ error: data }); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Inbound Webhook (Cloudflare Email Worker, Brevo Inbound, SendGrid, etc.) ─
app.post('/api/inbound', express.json({ limit: '10mb' }), (req, res) => {
  const { accountId, from, fromEmail, to, subject, html, text, date } = req.body;
  const targetAcc = accountId 
    ? db.accounts.find(a => a.id === accountId)
    : (to ? db.accounts.find(a => a.email.toLowerCase() === to.toLowerCase()) : null) || db.accounts.find(a => a.id === db.activeAccountId);

  if (!targetAcc) return res.status(404).json({ error: 'Target account not found' });

  const emailId = 'inbound_' + Date.now();
  const newEmail = {
    id: emailId,
    uid: Date.now(),
    subject: subject || '(no subject)',
    from: from || fromEmail || 'unknown',
    fromEmail: fromEmail || (from && from.match(/<([^>]+)>/)?.[1]) || from || 'unknown@domain.com',
    to: to || targetAcc.email,
    date: date || new Date().toISOString(),
    read: false,
    starred: false,
    labels: ['Primary'],
    snippet: (text || html?.replace(/<[^>]*>/g, '') || '').substring(0, 160).replace(/\s+/g, ' '),
    html: html || `<p>${text || 'No content'}</p>`
  };

  db.emailCache[targetAcc.id] = db.emailCache[targetAcc.id] || {};
  db.emailCache[targetAcc.id].INBOX = db.emailCache[targetAcc.id].INBOX || [];
  db.emailCache[targetAcc.id].INBOX.unshift(newEmail);
  saveDB(db);

  broadcast('email_received', { accountId: targetAcc.id, email: newEmail });
  res.json({ success: true, message: '✅ Incoming email received and placed in INBOX', email: newEmail });
});

// Simulate / Test an incoming email
app.post('/api/inbound/test', (req, res) => {
  const { accountId } = req.body;
  const targetAcc = db.accounts.find(a => a.id === (accountId || db.activeAccountId));
  if (!targetAcc) return res.status(404).json({ error: 'Account not found' });

  const testSenders = [
    { name: 'Sarah Jenkins', email: 'sarah.j@acmepartners.com' },
    { name: 'Alex Rivera', email: 'alex@innovatehub.org' },
    { name: 'Support Team', email: 'support@cloudservices.io' }
  ];
  const sender = testSenders[Math.floor(Math.random() * testSenders.length)];
  const subjects = [
    'Quick update on the partnership proposal',
    'Confirmation: Your account setup is active',
    'Follow up on our meeting yesterday'
  ];
  const subject = subjects[Math.floor(Math.random() * subjects.length)];

  const emailId = 'test_inbound_' + Date.now();
  const newEmail = {
    id: emailId,
    uid: Date.now(),
    subject,
    from: `${sender.name} <${sender.email}>`,
    fromEmail: sender.email,
    to: targetAcc.email,
    date: new Date().toISOString(),
    read: false,
    starred: false,
    labels: ['Primary'],
    snippet: `Hi ${targetAcc.name || 'there'}, thanks for reaching out. Everything looks great from our side...`,
    html: `<div style="font-family:Arial,sans-serif;color:#202124;padding:20px;line-height:1.6">
      <p>Hi <strong>${targetAcc.name || 'there'}</strong>,</p>
      <p>Thanks for getting in touch! We received your message and wanted to confirm that everything is connected properly.</p>
      <p>This is a live test email in your <strong>MyMail</strong> inbox. You can star, reply, or delete this email just like in Gmail.</p>
      <p style="margin-top:24px;border-top:1px solid #eee;padding-top:12px;color:#5f6368;font-size:12px">
        Best regards,<br>
        <strong>${sender.name}</strong><br>
        ${sender.email}
      </p>
    </div>`
  };

  db.emailCache[targetAcc.id] = db.emailCache[targetAcc.id] || {};
  db.emailCache[targetAcc.id].INBOX = db.emailCache[targetAcc.id].INBOX || [];
  db.emailCache[targetAcc.id].INBOX.unshift(newEmail);
  saveDB(db);

  broadcast('email_received', { accountId: targetAcc.id, email: newEmail });
  res.json({ success: true, message: `✅ Test email received from ${sender.email}`, email: newEmail });
});

// ── IMAP Fetch ────────────────────────────────────────────────────────────────
app.post('/api/imap/fetch', async (req, res) => {
  const { accountId, folder = 'INBOX', limit = 50 } = req.body;
  const acc = db.accounts.find(a => a.id === accountId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });

  if (acc.isDemo || !acc.imap.user) {
    const cache = db.emailCache[accountId] || {};
    return res.json({ success: true, emails: cache[folder] || [], fromCache: true });
  }

  try {
    const config = {
      imap: {
        user: acc.imap.user, password: acc.imap.pass,
        host: acc.imap.host, port: acc.imap.port,
        tls: acc.imap.tls, authTimeout: 10000,
        tlsOptions: { rejectUnauthorized: false }
      }
    };

    const connection = await imapSimple.connect(config);
    await connection.openBox(folder);

    const searchCriteria = ['ALL'];
    const fetchOptions = { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'], struct: true, markSeen: false };
    const messages = await connection.search(searchCriteria, fetchOptions);
    const emails = [];

    for (const msg of messages.slice(-limit).reverse()) {
      try {
        const headerPart = msg.parts.find(p => p.which.includes('HEADER'))?.body || {};
        const textPart = msg.parts.find(p => p.which === 'TEXT')?.body || '';

        const subject = Array.isArray(headerPart.subject) ? headerPart.subject[0] : (headerPart.subject || '(no subject)');
        const from = Array.isArray(headerPart.from) ? headerPart.from[0] : (headerPart.from || 'unknown');
        const to = Array.isArray(headerPart.to) ? headerPart.to[0] : (headerPart.to || acc.email);
        const dateStr = Array.isArray(headerPart.date) ? headerPart.date[0] : (headerPart.date || new Date().toISOString());

        const fromEmail = (from.match(/<([^>]+)>/)?.[1]) || from.trim();
        let snippet = String(textPart || '')
          .replace(/--[a-zA-Z0-9_-]+/g, '')
          .replace(/Content-[A-Za-z-]+:[^\r\n]+/g, '')
          .replace(/[\r\n\t]+/g, ' ')
          .trim()
          .substring(0, 160);
        if (!snippet) snippet = subject;

        const isRead = Array.isArray(msg.attributes.flags) && msg.attributes.flags.includes('\\Seen');
        const isStarred = Array.isArray(msg.attributes.flags) && msg.attributes.flags.includes('\\Flagged');

        emails.push({
          id: 'imap_' + msg.attributes.uid,
          uid: msg.attributes.uid,
          subject,
          from,
          fromEmail,
          to,
          date: new Date(dateStr).toISOString(),
          read: isRead,
          starred: isStarred,
          snippet,
          html: `<p>${snippet}</p>`,
          labels: []
        });
      } catch (err) {
        console.error('Error parsing IMAP msg:', err.message);
      }
    }

    connection.end();
    db.emailCache[accountId] = db.emailCache[accountId] || {};
    db.emailCache[accountId][folder] = emails;
    saveDB(db);
    res.json({ success: true, emails });
  } catch (e) {
    // Fall back to cache on error
    const cache = db.emailCache[accountId] || {};
    res.json({ success: true, emails: cache[folder] || [], fromCache: true, warning: e.message });
  }
});

// Fetch a single full email body
app.post('/api/imap/fetch-body', async (req, res) => {
  const { accountId, folder = 'INBOX', uid } = req.body;
  const acc = db.accounts.find(a => a.id === accountId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });

  if (acc.isDemo || !acc.imap.user) {
    const cache = db.emailCache[accountId]?.[folder] || [];
    const email = cache.find(e => e.id === uid || String(e.uid) === String(uid));
    return res.json({ success: true, email });
  }

  try {
    const config = {
      imap: {
        user: acc.imap.user, password: acc.imap.pass,
        host: acc.imap.host, port: acc.imap.port, tls: acc.imap.tls,
        authTimeout: 10000, tlsOptions: { rejectUnauthorized: false }
      }
    };
    const connection = await imapSimple.connect(config);
    await connection.openBox(folder);
    const messages = await connection.search([['UID', uid]], { bodies: [''], struct: true, markSeen: true });
    if (!messages.length) { connection.end(); return res.json({ success: false, error: 'Not found' }); }
    const fullBody = messages[0].parts.find(p => p.which === '')?.body || '';
    const parsed = await simpleParser(fullBody);
    connection.end();
    res.json({ success: true, html: parsed.html || `<pre>${parsed.text}</pre>`, text: parsed.text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Smart Multi-Provider Send ────────────────────────────────────────────────
app.post('/api/smtp/send', async (req, res) => {
  const { accountId, to, cc, bcc, subject, html, text, replyTo } = req.body;
  if (!to || !subject) return res.status(400).json({ error: 'Missing to/subject' });

  const acc = db.accounts.find(a => a.id === accountId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });

  const sentEmail = {
    id: 'sent_' + Date.now(), uid: Date.now(),
    subject, from: `${acc.name} <${acc.email}>`, fromEmail: acc.email,
    to, cc, bcc, date: new Date().toISOString(),
    read: true, starred: false, labels: [],
    snippet: (text || html?.replace(/<[^>]*>/g, '') || '').substring(0, 160),
    html: html || `<p>${text}</p>`
  };

  function saveSentRecord() {
    db.emailCache[accountId] = db.emailCache[accountId] || {};
    db.emailCache[accountId].Sent = db.emailCache[accountId].Sent || [];
    db.emailCache[accountId].Sent.unshift(sentEmail);
    saveDB(db);
    broadcast('email_sent', { accountId, email: sentEmail });
  }

  // ── Sandbox / Demo mode ────────────────────────────────────────────────────
  const provider = acc.emailProvider || (acc.smtp?.host?.includes('brevo') ? 'brevo' : 'custom');
  if (acc.isDemo || (!acc.smtp?.user && !acc.apiKey)) {
    saveSentRecord();
    return res.json({ success: true, message: '(Sandbox) Email saved to Sent folder — connect a real provider to actually send.', email: sentEmail });
  }

  // ── Sender email validation ───────────────────────────────────────────────
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const senderEmail = (acc.email || '').trim();
  if (!emailRegex.test(senderEmail)) {
    return res.status(400).json({
      error: `Invalid Sender Email: "${acc.email}". Please open Settings ⚙️ and change "Email Address" to your full email address (e.g. name@domain.com or your Brevo registered email), not just your name.`
    });
  }

  const cleanName = (acc.name || '').replace(/["<>\r\n]/g, '').trim();
  const fromHeader = cleanName ? `"${cleanName}" <${senderEmail}>` : senderEmail;

  try {
    // ── Resend API (no SMTP needed!) ─────────────────────────────────────────
    if (provider === 'resend') {
      if (!acc.apiKey) throw new Error('No Resend API key found. Add it in Settings.');
      const fromAddr = acc.resendDomain ? `${cleanName} <${senderEmail}>` : `${cleanName || 'MyMail'} <onboarding@resend.dev>`;
      const result = await callResendApi(acc.apiKey, {
        from: fromAddr, to, cc, bcc, subject,
        html: html || `<p>${text}</p>`,
        replyTo: replyTo || senderEmail
      });
      if (result.id || result.data?.id) {
        saveSentRecord();
        return res.json({ success: true, message: `✅ Email sent via Resend API to ${to}`, email: sentEmail });
      } else {
        throw new Error(result.message || result.name || JSON.stringify(result));
      }
    }

    // ── SMTP Providers (Gmail, Outlook, Brevo, Mailgun, Custom) ─────────────
    const smtpHost = acc.smtp?.host || FREE_PROVIDERS[provider]?.smtp?.host;
    const smtpPort = Number(acc.smtp?.port || FREE_PROVIDERS[provider]?.smtp?.port || 587);
    const smtpSecure = acc.smtp?.secure || smtpPort === 465;

    if (!smtpHost || !acc.smtp?.user) {
      throw new Error('SMTP not configured. Please add your credentials in Settings.');
    }

    const t = nodemailer.createTransport({
      host: smtpHost, port: smtpPort, secure: smtpSecure,
      auth: { user: acc.smtp.user, pass: acc.smtp.pass },
      tls: { rejectUnauthorized: false }
    });

    const toList = [to];
    if (cc) toList.push(cc);
    if (bcc) toList.push(bcc);

    await t.sendMail({
      from: fromHeader,
      envelope: {
        from: senderEmail,
        to: toList
      },
      to, cc, bcc, subject,
      html: html || undefined,
      text: text || html?.replace(/<[^>]*>/g, '') || '',
      replyTo: replyTo || senderEmail
    });

    saveSentRecord();
    res.json({ success: true, message: `✅ Email sent via ${provider.toUpperCase()} to ${to}`, email: sentEmail });
  } catch (e) {
    let msg = e.message;
    if (msg.includes('501') || msg.includes('syntax of FROM')) {
      msg = `Brevo rejected sender address: "${acc.email}". Make sure your Email Address in Settings is a full email (like yourname@domain.com or the email you registered on Brevo).`;
    } else if (provider === 'brevo' && (msg.includes('550') || msg.includes('unauthenticated') || msg.includes('sender'))) {
      msg = `Brevo rejected sender: "${acc.email}". Please verify this email or your domain at app.brevo.com/senders.`;
    } else if (provider === 'gmail' && msg.includes('535')) {
      msg = 'Gmail rejected your password. Please use a Google App Password (not your normal password). Go to myaccount.google.com → Security → App Passwords.';
    } else if (provider === 'resend' && msg.includes('domain')) {
      msg = 'Resend: Domain not verified. Either verify your domain at resend.com/domains, or leave the "From" email as your Resend test address.';
    } else if (msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED')) {
      msg = `Cannot connect to ${provider} server. Check your host/port settings, or try a different provider.`;
    }
    res.status(500).json({ error: msg });
  }
});

// ── In-app email actions (star, read, trash, move) ───────────────────────────
app.put('/api/emails/:accountId/:folder/:id', (req, res) => {
  const { accountId, folder, id } = req.params;
  const cache = db.emailCache[accountId]?.[folder] || [];
  const idx = cache.findIndex(e => e.id === id);
  if (idx !== -1) {
    db.emailCache[accountId][folder][idx] = { ...cache[idx], ...req.body };
    saveDB(db);
  }
  res.json({ success: true });
});

app.post('/api/emails/:accountId/:folder/:id/move', (req, res) => {
  const { accountId, folder, id } = req.params;
  const { dest } = req.body;
  const cache = db.emailCache[accountId]?.[folder] || [];
  const idx = cache.findIndex(e => e.id === id);
  if (idx !== -1) {
    const email = cache.splice(idx, 1)[0];
    db.emailCache[accountId][dest] = db.emailCache[accountId][dest] || [];
    db.emailCache[accountId][dest].unshift(email);
    saveDB(db);
  }
  res.json({ success: true });
});

// Save Draft
app.post('/api/drafts/:accountId', (req, res) => {
  const { accountId } = req.params;
  const draft = { id: 'draft_' + Date.now(), ...req.body, savedAt: new Date().toISOString() };
  db.emailCache[accountId] = db.emailCache[accountId] || {};
  db.emailCache[accountId].Drafts = db.emailCache[accountId].Drafts || [];
  db.emailCache[accountId].Drafts.unshift(draft);
  saveDB(db);
  res.json({ success: true, draft });
});

// ── Contacts ─────────────────────────────────────────────────────────────────
app.get('/api/contacts/:accountId', (req, res) => {
  res.json(db.contacts[req.params.accountId] || []);
});

// ── Search ─────────────────────────────────────────────────────────────────────
app.get('/api/search/:accountId', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const cache = db.emailCache[req.params.accountId] || {};
  const results = [];
  for (const folder of Object.keys(cache)) {
    for (const email of (cache[folder] || [])) {
      const hay = `${email.subject} ${email.from} ${email.snippet}`.toLowerCase();
      if (hay.includes(q.toLowerCase())) results.push({ ...email, folder });
    }
  }
  res.json(results.slice(0, 30));
});

// ═══════════════════════════════════════════════════════════════════════════
// AI MARKETING MODULE
// ═══════════════════════════════════════════════════════════════════════════

// ── Business Profile ────────────────────────────────────────────────────────
app.get('/api/marketing/profile', (req, res) => {
  const ctx = getContext(req);
  res.json(ctx.marketing.businessProfile || {});
});

app.post('/api/marketing/profile', express.json(), (req, res) => {
  const ctx = getContext(req);
  ctx.marketing.businessProfile = { ...ctx.marketing.businessProfile, ...req.body };
  if (ctx.isAuth) saveDB(db);
  else saveMarketing(marketingData);
  res.json({ ok: true, profile: ctx.marketing.businessProfile });
});

// ── Contacts ────────────────────────────────────────────────────────────────
app.get('/api/marketing/contacts', (req, res) => {
  const ctx = getContext(req);
  res.json(ctx.marketing.contacts || []);
});

app.post('/api/marketing/contacts', express.json(), (req, res) => {
  const { name, email, company, tags } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const exists = marketingData.contacts.find(c => c.email === email);
  if (exists) return res.status(409).json({ error: 'Contact already exists' });
  const contact = {
    id: 'c_' + Date.now(),
    name: name || '',
    email,
    company: company || '',
    tags: tags || [],
    addedAt: new Date().toISOString(),
    unsubscribed: false
  };
  marketingData.contacts.push(contact);
  saveMarketing(marketingData);
  res.json({ ok: true, contact });
});

app.post('/api/marketing/contacts/import', express.json({ limit: '2mb' }), (req, res) => {
  // Accepts CSV text or JSON array
  const { csv, contacts: jsonContacts } = req.body;
  let imported = 0, skipped = 0;

  if (csv) {
    const rows = csvParse(csv, { columns: true, skip_empty_lines: true, trim: true });
    for (const row of rows) {
      const email = row.email || row.Email || row.EMAIL;
      if (!email) { skipped++; continue; }
      if (marketingData.contacts.find(c => c.email === email)) { skipped++; continue; }
      marketingData.contacts.push({
        id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: row.name || row.Name || '',
        email,
        company: row.company || row.Company || '',
        tags: [],
        addedAt: new Date().toISOString(),
        unsubscribed: false
      });
      imported++;
    }
  } else if (Array.isArray(jsonContacts)) {
    for (const c of jsonContacts) {
      if (!c.email) { skipped++; continue; }
      if (marketingData.contacts.find(x => x.email === c.email)) { skipped++; continue; }
      marketingData.contacts.push({
        id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: c.name || '',
        email: c.email,
        company: c.company || '',
        tags: c.tags || [],
        addedAt: new Date().toISOString(),
        unsubscribed: false
      });
      imported++;
    }
  }

  saveMarketing(marketingData);
  res.json({ ok: true, imported, skipped, total: marketingData.contacts.length });
});

app.delete('/api/marketing/contacts/:id', (req, res) => {
  marketingData.contacts = marketingData.contacts.filter(c => c.id !== req.params.id);
  saveMarketing(marketingData);
  res.json({ ok: true });
});

// ── AI Email Generator ──────────────────────────────────────────────────────
app.post('/api/marketing/ai/generate', express.json(), async (req, res) => {
  const { geminiKey, instruction, businessProfile, contactSample, emailType } = req.body;
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API key required. Get it free at aistudio.google.com' });

  const profile = businessProfile || marketingData.businessProfile;
  const typeLabel = emailType || 'cold outreach';

  const prompt = `You are an expert email marketer. Write a professional, warm, humanized ${typeLabel} email for the following business:

Business Name: ${profile.businessName || 'Our Company'}
Website: ${profile.website || 'N/A'}
What we do: ${profile.description || 'N/A'}
Unique value: ${profile.valueProposition || 'N/A'}
Target audience: ${profile.targetAudience || 'professionals'}

Campaign goal / instruction: ${instruction}

Sample recipient (personalize for them):
Name: ${contactSample?.name || '[First Name]'}
Company: ${contactSample?.company || '[Their Company]'}

Requirements:
- Write a compelling subject line on the FIRST LINE starting with "Subject: "
- Write the full email body below (no extra labels, just the email)
- Sound like a real human wrote it, NOT a robot or template
- Keep it concise (under 200 words)
- Include a clear call to action
- Do NOT use placeholder brackets like [Your Name] - use the actual business name
- End with a natural signature using the business name

Return format:
Subject: <subject here>

<email body here>`;

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const subjectMatch = text.match(/^Subject:\s*(.+)/m);
    const subject = subjectMatch ? subjectMatch[1].trim() : 'Following up with you';
    const body = text.replace(/^Subject:.+\n?/m, '').trim();

    res.json({ ok: true, subject, body, raw: text });
  } catch (err) {
    console.error('Gemini error:', err.message);
    res.status(500).json({ error: 'AI generation failed: ' + err.message });
  }
});

// ── Campaigns ───────────────────────────────────────────────────────────────
app.get('/api/marketing/campaigns', (req, res) => {
  const ctx = getContext(req);
  res.json(ctx.marketing.campaigns || []);
});

app.post('/api/marketing/campaigns', express.json(), (req, res) => {
  const { name, subject, body, contactIds, scheduledAt, followUpDays } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body required' });

  const campaign = {
    id: 'camp_' + Date.now(),
    name: name || 'Campaign ' + new Date().toLocaleDateString(),
    subject,
    body,
    contactIds: contactIds || [],
    scheduledAt: scheduledAt || null,
    followUpDays: followUpDays || [],
    status: 'draft',
    createdAt: new Date().toISOString(),
    stats: { sent: 0, failed: 0, followUpsSent: 0 },
    log: []
  };

  marketingData.campaigns.push(campaign);
  saveMarketing(marketingData);
  res.json({ ok: true, campaign });
});

// ── Send Campaign ───────────────────────────────────────────────────────────
app.post('/api/marketing/campaigns/:id/send', express.json(), async (req, res) => {
  const campaign = marketingData.campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const db = loadDB();
  const settings = db.settings || {};

  const contacts = campaign.contactIds.length > 0
    ? marketingData.contacts.filter(c => campaign.contactIds.includes(c.id) && !c.unsubscribed)
    : marketingData.contacts.filter(c => !c.unsubscribed);

  if (contacts.length === 0) return res.status(400).json({ error: 'No contacts to send to' });

  campaign.status = 'sending';
  campaign.sentAt = new Date().toISOString();
  saveMarketing(marketingData);

  // Send in background
  res.json({ ok: true, message: `Sending to ${contacts.length} contacts...`, campaignId: campaign.id });

  let sent = 0, failed = 0;
  for (const contact of contacts) {
    try {
      // Personalize email
      const personalSubject = campaign.subject
        .replace(/\{name\}/gi, contact.name || '')
        .replace(/\{company\}/gi, contact.company || '');
      const personalBody = campaign.body
        .replace(/\{name\}/gi, contact.name || 'there')
        .replace(/\{company\}/gi, contact.company || '');

      await sendEmailViaSettings(settings, {
        to: contact.email,
        subject: personalSubject,
        text: personalBody,
        html: personalBody.replace(/\n/g, '<br>') + `<br><br><p style="font-size:11px;color:#999;">If you'd like to unsubscribe, reply with "unsubscribe".</p>`
      });

      sent++;
      campaign.log.push({ contactId: contact.id, email: contact.email, status: 'sent', at: new Date().toISOString() });
    } catch (err) {
      failed++;
      campaign.log.push({ contactId: contact.id, email: contact.email, status: 'failed', error: err.message, at: new Date().toISOString() });
    }
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  campaign.status = 'sent';
  campaign.stats.sent = sent;
  campaign.stats.failed = failed;
  saveMarketing(marketingData);
  console.log(`Campaign "${campaign.name}" done: ${sent} sent, ${failed} failed`);

  // Schedule follow-ups
  if (campaign.followUpDays && campaign.followUpDays.length > 0) {
    for (const days of campaign.followUpDays) {
      const followUpDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      campaign.followUps = campaign.followUps || [];
      campaign.followUps.push({ days, scheduledFor: followUpDate.toISOString(), status: 'pending' });
    }
    saveMarketing(marketingData);
    console.log(`Scheduled follow-ups for campaign "${campaign.name}" at days: ${campaign.followUpDays.join(', ')}`);
  }
});

app.get('/api/marketing/campaigns/:id/stats', (req, res) => {
  const campaign = marketingData.campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json({ ok: true, stats: campaign.stats, log: campaign.log, followUps: campaign.followUps || [] });
});

// ── Unsubscribe ─────────────────────────────────────────────────────────────
app.post('/api/marketing/unsubscribe', express.json(), (req, res) => {
  const { email } = req.body;
  const contact = marketingData.contacts.find(c => c.email === email);
  if (contact) { contact.unsubscribed = true; saveMarketing(marketingData); }
  res.json({ ok: true, message: 'Unsubscribed successfully' });
});

// ── Helper: send via current settings ──────────────────────────────────────
async function sendEmailViaSettings(settings, { to, subject, text, html }) {
  if (settings.provider === 'resend' && settings.resendApiKey) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ from: settings.senderEmail, to, subject, text, html });
      const options = {
        hostname: 'api.resend.com', path: '/emails', method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.resendApiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      };
      const req = https.request(options, r => {
        let data = '';
        r.on('data', d => data += d);
        r.on('end', () => r.statusCode < 300 ? resolve(JSON.parse(data)) : reject(new Error('Resend: ' + data)));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  } else {
    const transporter = nodemailer.createTransport({
      host: settings.smtpHost, port: parseInt(settings.smtpPort) || 587,
      secure: settings.smtpPort == 465,
      auth: { user: settings.smtpUser, pass: settings.smtpPass }
    });
    await transporter.sendMail({ from: `"${settings.senderName}" <${settings.senderEmail}>`, to, subject, text, html });
  }
}

// ── Follow-up Cron (every hour, checks pending follow-ups) ─────────────────
if (!IS_VERCEL) {
  cron.schedule('0 * * * *', async () => {
    const now = new Date();
    let changed = false;
    const db = loadDB();
  const settings = db.settings || {};

  for (const campaign of marketingData.campaigns) {
    if (!campaign.followUps) continue;
    for (const fu of campaign.followUps) {
      if (fu.status !== 'pending') continue;
      if (new Date(fu.scheduledFor) > now) continue;

      // Time to send follow-up
      const contacts = campaign.contactIds.length > 0
        ? marketingData.contacts.filter(c => campaign.contactIds.includes(c.id) && !c.unsubscribed)
        : marketingData.contacts.filter(c => !c.unsubscribed);

      let sent = 0;
      for (const contact of contacts) {
        // Only send if original email was sent to this contact
        const originalLog = campaign.log.find(l => l.contactId === contact.id && l.status === 'sent');
        if (!originalLog) continue;
        try {
          const followUpBody = `Hi ${contact.name || 'there'},\n\nJust following up on my previous email. I wanted to make sure you had a chance to see it.\n\n${campaign.body}\n\nLooking forward to hearing from you!`;
          await sendEmailViaSettings(settings, {
            to: contact.email,
            subject: 'Re: ' + campaign.subject,
            text: followUpBody,
            html: followUpBody.replace(/\n/g, '<br>')
          });
          sent++;
          await new Promise(r => setTimeout(r, 500));
        } catch (e) { console.error('Follow-up send error:', e.message); }
      }

      fu.status = 'sent';
      fu.sentAt = now.toISOString();
      fu.sentCount = sent;
      campaign.stats.followUpsSent += sent;
      changed = true;
      console.log(`Follow-up sent for campaign "${campaign.name}": ${sent} emails`);
    }
  }
  if (changed) saveMarketing(marketingData);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// AI CHATBOT — Full App Access
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/chatbot', express.json(), async (req, res) => {
  const { message, history, geminiKey: key } = req.body;
  const gemKey = key || (process.env.GEMINI_KEY || '');
  if (!gemKey) return res.status(400).json({ error: 'Gemini API key required' });
  if (!message) return res.status(400).json({ error: 'Message required' });

  // Gather all app context
  const db = loadDB();

  const settings = db.settings || {};
  const emailCache = db.emailCache || {};
  const marketing = loadMarketing();

  // Build a rich context snapshot
  const allEmails = Object.values(emailCache).flat().slice(0, 30);
  const recentEmails = allEmails.map(e => ({
    id: e.id, subject: e.subject, from: e.from, to: e.to,
    date: e.date, snippet: (e.snippet || e.body || '').substring(0, 200),
    folder: e.folder || 'inbox'
  }));

  const contactCount = marketing.contacts?.length || 0;
  const activeContacts = marketing.contacts?.filter(c => !c.unsubscribed).length || 0;
  const campaigns = marketing.campaigns || [];
  const bizProfile = marketing.businessProfile || {};

  const systemPrompt = `You are MyMail AI Assistant — a smart, helpful chatbot embedded inside the MyMail email app.
You have COMPLETE access to the user's email app data. Be concise, friendly, and action-oriented.

=== CURRENT APP STATE ===

📧 EMAIL ACCOUNT:
- Provider: ${settings.provider || 'Not configured'}
- Sender: ${settings.senderName || 'Unknown'} <${settings.senderEmail || 'N/A'}>
- IMAP: ${settings.imapHost || 'Not configured'}

📥 RECENT EMAILS (last 30):
${recentEmails.map((e, i) => `${i + 1}. [${e.folder}] From: ${e.from} | Subject: "${e.subject}" | ${e.date ? new Date(e.date).toLocaleDateString() : ''}\n   Preview: ${e.snippet}`).join('\n') || 'No emails loaded yet'}

👥 CONTACTS:
- Total: ${contactCount} contacts (${activeContacts} active, ${contactCount - activeContacts} unsubscribed)
${marketing.contacts?.slice(0, 10).map(c => `  • ${c.name || 'No name'} <${c.email}> - ${c.company || ''}`).join('\n') || '  No contacts yet'}
${contactCount > 10 ? `  ... and ${contactCount - 10} more` : ''}

📤 CAMPAIGNS (${campaigns.length} total):
${campaigns.slice(-5).map(c => `  • "${c.name}" — ${c.status} — ${c.stats?.sent || 0} sent — Subject: "${c.subject}"`).join('\n') || '  No campaigns yet'}

🏢 BUSINESS PROFILE:
- Name: ${bizProfile.businessName || 'Not set'}
- Website: ${bizProfile.website || 'Not set'}
- Description: ${bizProfile.description || 'Not set'}
- Target: ${bizProfile.targetAudience || 'Not set'}

=== CAPABILITIES ===
You CAN:
- Answer questions about any emails, contacts, campaigns above
- Search and summarize emails
- Draft email content / suggest subject lines
- Give marketing advice
- Help compose campaigns
- Analyze email stats
- Tell what actions to take in the app

You CANNOT (yet) take autonomous actions — guide the user to do them.

=== RESPONSE FORMAT ===
- Be concise and direct
- Use emojis sparingly for clarity
- If drafting an email, format it clearly with Subject: and Body:
- If searching, list results with bullet points
- Always end with a helpful next step if relevant`;

  try {
    const genAI = new GoogleGenerativeAI(gemKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.8-flash',
      systemInstruction: systemPrompt
    });

    // Build chat history
    const chatHistory = (history || []).map(h => ({
      role: h.role,
      parts: [{ text: h.text }]
    }));

    const chat = model.startChat({ history: chatHistory });
    const result = await chat.sendMessage(message);
    const reply = result.response.text();

    res.json({ ok: true, reply });
  } catch (err) {
    console.error('Chatbot error:', err.message);
    res.status(500).json({ error: 'AI error: ' + err.message });
  }
});

// Catch-all → SPA
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module || !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`MyMail running → http://localhost:${PORT}`));
}

module.exports = app;
