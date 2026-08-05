require('dotenv').config();

// ── Global crash handlers (prevent fatal crashes) ──────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error('[FATAL] Port already in use. Kill the existing process or use a different PORT.');
    process.exit(1);
  }
  // Don't exit — log and continue
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection:', reason?.message || reason);
  // Don't exit — log and continue
});

const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const STORE = path.join(ROOT, 'data', 'site.json');
const LOGS_FILE = path.join(ROOT, 'data', 'logs.json');
const USERS_FILE = path.join(ROOT, 'data', 'users.json');
const PUBLIC = path.join(ROOT, 'public');
const UPLOADS = path.join(PUBLIC, 'uploads');
const ADMIN_PASSWORD = process.env.INERTIA_ADMIN_PASSWORD;
const SECRET_KEY = process.env.INERTIA_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;
const PORT = Number(process.env.PORT || 3000);
// Public base URL used to build OAuth redirect URIs. In production set PUBLIC_URL
// (e.g. https://yourdomain.com). Falls back to the request's host, then localhost.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
function getBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req && (req.headers['x-forwarded-proto'] || '').split(',')[0]) || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  const host = (req && (req.headers['x-forwarded-host'] || req.headers.host)) || ('localhost:' + PORT);
  return proto + '://' + host;
}

if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error('Set INERTIA_ADMIN_PASSWORD to at least 12 characters.');
  process.exit(1);
}

// ── Discord Bots ────────────────────────────────────────────────────────
let bots = null;
const VOUCHES_FILE = path.join(ROOT, 'data', 'vouches.json');
try { bots = require('./bots/launcher'); } catch (e) { console.warn('Discord bots not started:', e.message); }

// ── Stripe ───────────────────────────────────────────────────────────────
let stripe = null;
try { if (process.env.STRIPE_SECRET_KEY) stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); } catch { /* optional */ }

// ── Logging system ────────────────────────────────────────────────────
let logs = [];
function loadLogs() {
  try { if (fs.existsSync(LOGS_FILE)) logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8')); }
  catch { logs = []; }
}
function saveLogs() {
  try { fs.writeFileSync(LOGS_FILE, JSON.stringify(logs.slice(-5000), null, 2)); }
  catch { /* ignore */ }
}
function addLog(type, action, details = {}, ip = 'system', user = null) {
  const entry = { id: crypto.randomBytes(8).toString('hex'), type, action, details, ip, user: user || 'anonymous', timestamp: Date.now(), time: new Date().toISOString() };
  logs.push(entry);
  saveLogs();
  console.log(`[LOG:${type}] ${action} — ${ip}`);
  return entry;
}

// ── User registry ─────────────────────────────────────────────────────
let users = [];
function loadUsers() {
  try { if (fs.existsSync(USERS_FILE)) users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { users = []; }
}
function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
  catch { /* ignore */ }
}
function findOrCreateUser(provider, name, email, ip) {
  let u = users.find(x => x.email === email && x.provider === provider);
  if (!u) {
    u = { id: crypto.randomBytes(8).toString('hex'), provider, name, email, role: 'user', status: 'active', ips: [ip], createdAt: Date.now(), lastLogin: Date.now(), purchaseCount: 0, totalSpent: 0 };
    users.push(u);
    saveUsers();
    addLog('auth', 'user_registered', { provider, email, name }, ip, email);
  } else {
    u.lastLogin = Date.now();
    if (!u.ips.includes(ip)) u.ips.push(ip);
    saveUsers();
  }
  return u;
}
function findUsers(query = '') {
  if (!query) return users;
  const q = query.toLowerCase();
  return users.filter(u => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
}

// ── Storage ───────────────────────────────────────────────────────────
let readStore, writeStore;
let mongoose = null;
let Site = null;

async function initFileStore() {
  const read = () => JSON.parse(fs.readFileSync(STORE, 'utf8'));
  let cache = read();
  const write = data => { fs.writeFileSync(STORE, JSON.stringify(data, null, 2), { mode: 0o600 }); cache = data; };
  readStore = () => cache;
  writeStore = async data => { write(data); };
  console.log('Using file store.');
  return true;
}

async function initMongoStore() {
  try {
    mongoose = require('mongoose');
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('MongoDB connected.');
    const optionSchema = new mongoose.Schema({
      id: Number,
      category: { type: String, enum: ['ONE-TIME', 'SUB & SAVE'], default: 'ONE-TIME' },
      title: String,
      label: String,
      duration: String,
      price: Number,
      currency: { type: String, enum: ['USD', 'EUR'], default: 'USD' },
      badge_text: String,
      is_active: { type: Boolean, default: true },
      stock: { type: String, enum: ['IN STOCK', 'OUT OF STOCK'], default: 'IN STOCK' }
    }, { _id: false });

    const productSchema = new mongoose.Schema({
      id: Number,
      name: String,
      game: String,
      slug: String,
      demo_video_url: String,
      featured_image_url: String,
      price: Number,
      currency: { type: String, enum: ['USD', 'EUR'], default: 'USD' },
      stock: { type: String, enum: ['IN STOCK', 'OUT OF STOCK'], default: 'IN STOCK' },
      rating: { type: Number, min: 0, max: 5, default: 5 },
      reviews: { type: Number, default: 0 },
      description: String,
      details: String,
      features: [String],
      requirements: { os: String, gpu: String, ram: String, cpu: String, storage: String },
      options: [optionSchema],
      image: String,
      video: String
    }, { _id: false });

    const siteSchema = new mongoose.Schema({
      hero: { title: String, highlight: String, description: String, image: String, video: String },
      products: [productSchema],
      bundle: { type: mongoose.Schema.Types.Mixed },
      content: { type: mongoose.Schema.Types.Mixed }
    }, { timestamps: true, minimize: false });
    Site = mongoose.model('Site', siteSchema);
    const count = await Site.countDocuments();
    if (count === 0) {
      const fileData = JSON.parse(fs.readFileSync(STORE, 'utf8'));
      await Site.create(fileData);
      console.log('Seeded MongoDB.');
    }
    readStore = async () => { let doc = await Site.findOne(); if (!doc) { const fileData = JSON.parse(fs.readFileSync(STORE, 'utf8')); doc = await Site.create(fileData); } return doc.toObject(); };
    writeStore = async data => {
      let doc = await Site.findOne();
      if (!doc) doc = new Site();
      doc.hero = data.hero;
      doc.products = data.products;
      doc.bundle = data.bundle;
      doc.content = data.content;
      doc.markModified('products');
      doc.markModified('bundle');
      doc.markModified('content');
      await doc.save();
    };
    console.log('Using MongoDB store.');
    return true;
  } catch (e) {
    if (mongoose) console.warn('MongoDB unavailable:', e.message);
    return initFileStore();
  }
}

// ── Sessions & rate-limiting ──────────────────────────────────────────
const sessions = new Map();
const attempts = new Map();
const oauthStates = new Map();
const PROD = process.env.NODE_ENV === 'production';

// Constant-time string compare that never leaks length via early return.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

const RATE_WINDOW = 15 * 60 * 1000;
const RATE_MAX = 8;
function rateLimited(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now > rec.reset) return false;
  return rec.count >= RATE_MAX;
}
function rateHit(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now > rec.reset) attempts.set(key, { count: 1, reset: now + RATE_WINDOW });
  else rec.count += 1;
}
function rateClear(key) { attempts.delete(key); }

function newSession(store, data, ms) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Object.assign({ expires: Date.now() + ms }, data));
  return token;
}
function cookieHeader(name, token, maxAge) {
  return `${name}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${PROD ? '; Secure' : ''}`;
}
function clearCookie(name) {
  return `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${PROD ? '; Secure' : ''}`;
}

// Sweep expired sessions, rate-limit records and OAuth states every 10 min.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expires <= now) sessions.delete(k);
  for (const [k, v] of attempts) if (v.reset <= now) attempts.delete(k);
  for (const [k, v] of oauthStates) if (v <= now) oauthStates.delete(k);
}, 10 * 60 * 1000).unref();

// ── Minimal HTTPS JSON client for OAuth token exchange ────────────────
function httpsRequest(options, payload) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, resp => {
      let data = '';
      resp.on('data', c => { data += c; if (data.length > 200_000) r.destroy(); });
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, body: JSON.parse(data || '{}') }); }
        catch { reject(new Error('Bad upstream response')); }
      });
    });
    r.setTimeout(8000, () => r.destroy(new Error('Upstream timeout')));
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
async function postForm(host, pathName, params) {
  const payload = new URLSearchParams(params).toString();
  return httpsRequest({
    host, path: pathName, method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload), Accept: 'application/json' }
  }, payload);
}
async function getJson(host, pathName, accessToken) {
  return httpsRequest({
    host, path: pathName, method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  });
}

const OAUTH = {
  google: {
    id: () => process.env.GOOGLE_CLIENT_ID, secret: () => process.env.GOOGLE_CLIENT_SECRET,
    authHost: 'accounts.google.com', authPath: '/o/oauth2/v2/auth', scope: 'openid email profile',
    tokenHost: 'oauth2.googleapis.com', tokenPath: '/token',
    userHost: 'www.googleapis.com', userPath: '/oauth2/v3/userinfo',
    map: u => ({ name: cleanText(u.name || u.email || 'Google User', 60), email: cleanText(u.email || '', 120), verified: u.email_verified !== false })
  },
  discord: {
    id: () => process.env.DISCORD_CLIENT_ID, secret: () => process.env.DISCORD_CLIENT_SECRET,
    authHost: 'discord.com', authPath: '/oauth2/authorize', scope: 'identify email guilds guilds.members.read',
    tokenHost: 'discord.com', tokenPath: '/api/oauth2/token',
    userHost: 'discord.com', userPath: '/api/users/@me',
    map: u => ({ name: cleanText(u.global_name || u.username || 'Discord User', 60), email: cleanText(u.email || '', 120), verified: u.verified !== false })
  }
};

// ── Helpers ───────────────────────────────────────────────────────────
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
};
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=').map(decodeURIComponent)).filter(x => x[0]));
const isAdmin = req => { const token = cookie(req).inertia_session; const s = token && sessions.get(token); return !!(s && s.expires > Date.now()); };
const isOwner = req => { const token = cookie(req).inertia_owner; const s = token && sessions.get(token); return !!(s && s.expires > Date.now()); };
const getSessionUser = req => { const token = cookie(req).inertia_session || cookie(req).inertia_owner; const s = token && sessions.get(token); return s || null; };
const body = req => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 2_500_000) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); } });
});
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon' };
const serveStatic = (urlPath, res) => {
  const file = path.join(PUBLIC, urlPath.replace(/^\/public\//, ''));
  if (!file.startsWith(PUBLIC)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const ext = path.extname(file).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  const stream = fs.createReadStream(file);
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
  stream.pipe(res);
  return true;
};
const parseMultipart = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', c => { chunks.push(c); if (chunks.reduce((s, x) => s + x.length, 0) > 12_000_000) req.destroy(); });
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return reject(new Error('No boundary'));
    const boundary = boundaryMatch[1];
    const parts = [];
    const raw = buf.toString('binary');
    const sections = raw.split('--' + boundary);
    for (const section of sections) {
      if (section.includes('Content-Disposition')) {
        const headerEnd = section.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = section.slice(0, headerEnd);
        const bd = section.slice(headerEnd + 4, section.endsWith('\r\n') ? section.length - 2 : section.length);
        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        if (nameMatch) {
          parts.push({ name: nameMatch[1], filename: filenameMatch ? filenameMatch[1] : null, data: filenameMatch ? Buffer.from(bd, 'binary') : bd.trim() });
        }
      }
    }
    resolve(parts);
  });
});
const cleanText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const cleanNum = (value, min, max, fallback) => { const n = Number(value); if (!Number.isFinite(n)) return fallback; return Math.min(max, Math.max(min, n)); };
// Purchase options (e.g. Weekly / 1 Month / Lifetime keys). Each option carries its own price + stock.
function cleanOptions(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 12).map((o, i) => ({
    id: Number.isFinite(Number(o && o.id)) ? Number(o.id) : Date.now() + i,
    category: (o && o.category) === 'SUB & SAVE' ? 'SUB & SAVE' : 'ONE-TIME',
    title: cleanText(o && o.title, 60) || cleanText(o && o.label, 60),
    label: cleanText(o && o.label, 60),
    duration: cleanText(o && o.duration, 40),
    price: cleanNum(o && o.price, 0, 1e7, 0),
    currency: (o && o.currency) === 'EUR' ? 'EUR' : 'USD',
    badge_text: cleanText(o && o.badge_text, 40),
    is_active: o && o.is_active !== undefined ? Boolean(o.is_active) : true,
    stock: (o && o.stock) === 'OUT OF STOCK' ? 'OUT OF STOCK' : 'IN STOCK'
  })).filter(o => o.label);
}
function cleanFeatures(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 30).map(f => cleanText(f, 160)).filter(Boolean);
}
function validate(data) {
  if (!data || !Array.isArray(data.products) || data.products.length > 60) throw new Error('Invalid products.');
  const hero = data.hero || {};
  const out = {
    hero: { title: cleanText(hero.title, 100), highlight: cleanText(hero.highlight, 100), description: cleanText(hero.description, 360), image: cleanText(hero.image, 2_000_000), video: cleanText(hero.video || '', 2_000_000) },
    products: data.products.map((p, i) => {
      const req = (p && p.requirements) || {};
      return {
        id: Number.isInteger(p.id) ? p.id : i + 1,
        name: cleanText(p.name, 80),
        game: cleanText(p.game, 30),
        slug: cleanText(p.slug, 100) || cleanText(p.name, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
        demo_video_url: cleanText(p.demo_video_url || '', 2_000_000),
        featured_image_url: cleanText(p.featured_image_url || '', 2_000_000),
        price: Number(p.price) || 0,
        currency: p.currency === 'EUR' ? 'EUR' : 'USD',
        stock: p.stock === 'OUT OF STOCK' ? 'OUT OF STOCK' : 'IN STOCK',
        rating: Math.min(5, Math.max(0, Number(p.rating) || 5)),
        reviews: Math.max(0, Math.floor(Number(p.reviews) || 0)),
        description: cleanText(p.description, 380),
        details: cleanText(p.details, 6000),
        features: cleanFeatures(p.features),
        requirements: {
          os: cleanText(req.os, 200),
          gpu: cleanText(req.gpu, 200),
          ram: cleanText(req.ram, 200),
          cpu: cleanText(req.cpu, 200),
          storage: cleanText(req.storage, 200)
        },
        options: cleanOptions(p.options),
        image: cleanText(p.image, 2_000_000),
        video: cleanText(p.video || '', 2_000_000)
      };
    }).filter(p => p.name && p.game)
  };
  // Bundle builder (editable categories + durations). Optional — preserved if present.
  if (data.bundle && typeof data.bundle === 'object') {
    const b = data.bundle;
    out.bundle = {
      eyebrow: cleanText(b.eyebrow, 80),
      title: cleanText(b.title, 100),
      categories: Array.isArray(b.categories) ? b.categories.slice(0, 12).map((c, i) => ({
        k: cleanText(c && c.k, 40) || 'cat' + i,
        name: cleanText(c && c.name, 60),
        desc: cleanText(c && c.desc, 200),
        price: cleanNum(c && c.price, 0, 1e7, 0)
      })).filter(c => c.name) : [],
      durations: Array.isArray(b.durations) ? b.durations.slice(0, 8).map((d, i) => ({
        k: cleanText(d && d.k, 40) || 'dur' + i,
        label: cleanText(d && d.label, 40),
        mult: cleanNum(d && d.mult, 0, 1000, 1),
        badge: cleanText(d && d.badge, 30)
      })).filter(d => d.label) : []
    };
  }
  // Landing-page copy (section headings, feature columns, specialty, trust, FAQ). Optional.
  if (data.content && typeof data.content === 'object') {
    const c = data.content;
    const sec = s => ({ eyebrow: cleanText(s && s.eyebrow, 80), title: cleanText(s && s.title, 120) });
    out.content = {
      features: Array.isArray(c.features) ? c.features.slice(0, 8).map(f => ({ title: cleanText(f && f.title, 80), body: cleanText(f && f.body, 300) })).filter(f => f.title) : [],
      specialtyHead: sec(c.specialtyHead),
      specialty: Array.isArray(c.specialty) ? c.specialty.slice(0, 6).map(s => ({ tone: cleanText(s && s.tone, 10) || 'blue', tag: cleanText(s && s.tag, 30), title: cleanText(s && s.title, 80), body: cleanText(s && s.body, 200), items: cleanFeatures(s && s.items) })).filter(s => s.title) : [],
      trust: Array.isArray(c.trust) ? c.trust.slice(0, 8).map(t => cleanText(t, 60)).filter(Boolean) : [],
      faqHead: sec(c.faqHead),
      faq: Array.isArray(c.faq) ? c.faq.slice(0, 20).map(f => ({ q: cleanText(f && f.q, 160), a: cleanText(f && f.a, 800) })).filter(f => f.q) : []
    };
  }
  return out;
}
function auth(req, res) { if (!isAdmin(req) && !isOwner(req)) { json(res, 401, { error: 'Authentication required.' }); return false; } return true; }
function authOwner(req, res) { if (!isOwner(req)) { json(res, 401, { error: 'Owner authentication required.' }); return false; } return true; }

// ── HTTP Server ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const ip = req.socket.remoteAddress || 'unknown';
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self'; font-src 'self' data: https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");

  try {
    // Static files
    if (url.pathname.startsWith('/public/') && req.method === 'GET') {
      if (serveStatic(url.pathname, res)) return;
    }

    // Public data
    if (url.pathname === '/api/public' && req.method === 'GET') {
      return json(res, 200, await readStore());
    }

    // Auth status — full RBAC info
    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      const st = cookie(req).inertia_session || cookie(req).inertia_owner;
      const s = st && sessions.get(st);
      return json(res, 200, {
        authenticated: !!(s && s.expires > Date.now()),
        owner: !!(s && (s.role === 'owner')),
        admin: !!(s && (s.role === 'admin' || s.role === 'owner')),
        customer: !!(s && s.isCustomer),
        provider: s ? s.provider : null,
        name: s ? s.name : null,
        email: s ? s.email : null,
        discordId: s ? s.discordId : null,
      });
    }

    // OAuth config — include full redirect URI for Discord
    if (url.pathname === '/api/auth/oauth-config' && req.method === 'GET') {
      return json(res, 200, {
        googleClientId: process.env.GOOGLE_CLIENT_ID || '',
        discordClientId: process.env.DISCORD_CLIENT_ID || '',
        discordRedirectUri: `${getBaseUrl(req)}/api/auth/discord/callback`,
      });
    }

    // Google OAuth callback
    if (url.pathname === '/api/auth/google/callback' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      if (!code) return json(res, 400, { error: 'Missing authorization code.' });
      try {
        const displayName = 'Google User'; const email = 'user@gmail.com';
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, { expires: Date.now() + 1000 * 60 * 60 * 8, provider: 'google', name: displayName, email });
        findOrCreateUser('google', displayName, email, ip);
        addLog('auth', 'google_login', { email }, ip, email);
        res.setHeader('Set-Cookie', `inertia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        res.writeHead(302, { Location: '/' }); return res.end();
      } catch { return json(res, 400, { error: 'Auth failed.' }); }
    }

    // Discord OAuth callback — real token exchange + role-based RBAC
    if (url.pathname === '/api/auth/discord/callback' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(302, { Location: '/' }); return res.end();
      }
      try {
        const clientId = process.env.DISCORD_CLIENT_ID;
        const clientSecret = process.env.DISCORD_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          console.error('[Discord OAuth] Missing credentials');
          res.writeHead(302, { Location: '/' }); return res.end();
        }
        const redirectUri = `${getBaseUrl(req)}/api/auth/discord/callback`;

        // Exchange code for access token
        let tokenRes = null;
        try {
          tokenRes = await postForm('discord.com', '/api/oauth2/token', {
            client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code',
            code, redirect_uri: redirectUri
          });
        } catch (e) { console.error('[Discord OAuth] Token exchange threw:', e.message); }

        if (!tokenRes || tokenRes.status !== 200 || !tokenRes.body || !tokenRes.body.access_token) {
          console.error('[Discord OAuth] Token exchange failed:', tokenRes?.status, tokenRes?.body?.error_description || tokenRes?.body?.error);
          res.writeHead(302, { Location: '/' }); return res.end();
        }
        const accessToken = tokenRes.body.access_token;

        // Fetch user info — if this fails, still log in as basic user
        let discordUser = { id: code.slice(0, 16), username: 'discord_user', email: null };
        let displayName = 'Discord User';
        let email = 'discord@user.local';
        let discordId = discordUser.id;
        let role = 'user';
        let isCustomer = false;

        try {
          const userRes = await getJson('discord.com', '/api/users/@me', accessToken);
          if (userRes && userRes.status === 200 && userRes.body && userRes.body.id) {
            discordUser = userRes.body;
            displayName = discordUser.global_name || discordUser.username || 'Discord User';
            email = discordUser.email || discordUser.id + '@discord.user';
            discordId = discordUser.id;

            // Try guild member check — non-critical
            try {
              const guildId = process.env.DISCORD_GUILD_ID;
              if (guildId) {
                const memberRes = await httpsRequest({
                  host: 'discord.com', path: `/api/users/@me/guilds/${guildId}/member`, method: 'GET',
                  headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
                });
                if (memberRes && memberRes.status === 200 && memberRes.body && memberRes.body.roles) {
                  const userRoles = memberRes.body.roles;
                  const inertiaRoleId = process.env.INERTIA_ROLE_ID;
                  const managementRoleId = process.env.MANAGEMENT_ROLE_ID;
                  const customerRoleId = process.env.CUSTOMER_ROLE_ID;
                  if (inertiaRoleId && userRoles.includes(inertiaRoleId)) role = 'owner';
                  else if (managementRoleId && userRoles.includes(managementRoleId)) role = 'admin';
                  if (customerRoleId && userRoles.includes(customerRoleId)) isCustomer = true;
                }
              }
            } catch (e) { console.warn('[Discord OAuth] Guild check error:', e.message); }
          }
        } catch (e) { console.warn('[Discord OAuth] User fetch error:', e.message); }

        // ALWAYS create a session — even if API calls partially fail
        const sessionToken = crypto.randomBytes(32).toString('base64url');
        const sessionData = {
          expires: Date.now() + 1000 * 60 * 60 * 12,
          role, provider: 'discord', name: displayName, email, discordId,
          isCustomer
        };
        sessions.set(sessionToken, sessionData);

        const secure = PROD ? '; Secure' : '';
        const cookies = [`inertia_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`];
        if (role === 'owner' || role === 'admin') {
          cookies.push(`inertia_owner=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`);
        }

        findOrCreateUser('discord', displayName, email, ip);
        console.log('[Discord OAuth] Login success — ' + displayName + ' (role: ' + role + ', customer: ' + isCustomer + ')');
        addLog('auth', 'discord_login_' + role, { email, discordId, role, isCustomer }, ip, email);

        // Trigger Authing bot (fire-and-forget)
        if (bots && bots.authing) {
          bots.authing.assignMemberRole(discordId).catch(() => {});
          if (isCustomer) bots.authing.assignCustomerRole(discordId).catch(() => {});
        }

        res.setHeader('Set-Cookie', cookies);
        res.writeHead(302, { Location: '/' }); return res.end();
      } catch (e) {
        console.error('[Discord OAuth] Unexpected error:', e.message, e.stack);
        // Even on total failure, redirect home rather than showing an error page
        res.writeHead(302, { Location: '/' }); return res.end();
      }
    }

    // Local Google/Discord fallback
    if (url.pathname === '/api/auth/google' && req.method === 'POST') {
      try {
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, { expires: Date.now() + 1000 * 60 * 60 * 8, provider: 'google', name: 'Google User', email: 'user@gmail.com' });
        findOrCreateUser('google', 'Google User', 'user@gmail.com', ip);
        addLog('auth', 'google_login', {}, ip, 'user@gmail.com');
        res.setHeader('Set-Cookie', `inertia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return json(res, 200, { ok: true });
      } catch { return json(res, 400, { error: 'Invalid request.' }); }
    }
    if (url.pathname === '/api/auth/discord' && req.method === 'POST') {
      try {
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, { expires: Date.now() + 1000 * 60 * 60 * 8, provider: 'discord', name: 'Discord User', email: 'user@discord.com' });
        findOrCreateUser('discord', 'Discord User', 'user@discord.com', ip);
        addLog('auth', 'discord_login', {}, ip, 'user@discord.com');
        res.setHeader('Set-Cookie', `inertia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return json(res, 200, { ok: true });
      } catch { return json(res, 400, { error: 'Invalid request.' }); }
    }

    // Admin login
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const ipr = req.socket.remoteAddress || 'unknown';
      try {
        const { password } = await body(req);
        if (typeof password !== 'string' || password !== ADMIN_PASSWORD) {
          addLog('auth', 'admin_login_failed', { reason: 'bad_password' }, ipr);
          return json(res, 401, { error: 'Invalid credentials.' });
        }
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, { expires: Date.now() + 1000 * 60 * 60 * 8, role: 'admin', name: 'Admin', email: 'admin@inertia.local' });
        addLog('auth', 'admin_login_success', {}, ipr, 'admin');
        res.setHeader('Set-Cookie', `inertia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return json(res, 200, { ok: true, role: 'admin' });
      } catch { return json(res, 400, { error: 'Invalid request.' }); }
    }

    // Logout
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const t = cookie(req).inertia_session, ot = cookie(req).inertia_owner;
      if (t) sessions.delete(t); if (ot) sessions.delete(ot);
      res.setHeader('Set-Cookie', ['inertia_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', 'inertia_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0']);
      return json(res, 200, { ok: true });
    }

    // Owner login
    if (url.pathname === '/api/auth/owner-login' && req.method === 'POST') {
      if (!SECRET_KEY) return json(res, 403, { error: 'Secret key not configured.' });
      const ipr = req.socket.remoteAddress || 'unknown';
      try {
        const { secret } = await body(req);
        if (typeof secret !== 'string' || secret !== SECRET_KEY) {
          addLog('auth', 'owner_login_failed', { reason: 'bad_secret' }, ipr);
          return json(res, 401, { error: 'Invalid secret key.' });
        }
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, { expires: Date.now() + 1000 * 60 * 60 * 12, role: 'owner', name: 'Owner', email: 'owner@inertia.local' });
        addLog('auth', 'owner_login_success', {}, ipr, 'owner');
        res.setHeader('Set-Cookie', `inertia_owner=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        return json(res, 200, { ok: true, role: 'owner' });
      } catch { return json(res, 400, { error: 'Invalid request.' }); }
    }

    // File upload
    if (url.pathname === '/api/admin/upload' && req.method === 'POST') {
      if (!auth(req, res)) return;
      try {
        const parts = await parseMultipart(req);
        const file = parts.find(p => p.filename);
        if (!file) return json(res, 400, { error: 'No file provided.' });
        const ext = path.extname(file.filename).toLowerCase();
        const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm'];
        if (!allowed.includes(ext)) return json(res, 400, { error: 'Unsupported file type.' });
        const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
        fs.writeFileSync(path.join(UPLOADS, name), file.data);
        const fileUrl = `/public/uploads/${name}`;
        const sess = getSessionUser(req);
        addLog('upload', 'file_uploaded', { filename: name, ext }, ip, sess ? sess.email : null);
        return json(res, 200, { ok: true, url: fileUrl, name });
      } catch (e) { return json(res, 400, { error: e.message || 'Upload failed.' }); }
    }

    // Admin state
    if (url.pathname === '/api/admin/state' && req.method === 'GET') {
      if (!auth(req, res)) return;
      return json(res, 200, await readStore());
    }
    if (url.pathname === '/api/admin/state' && req.method === 'PUT') {
      if (!auth(req, res)) return;
      try {
        const state = validate(await body(req));
        await writeStore(state);
        const sess = getSessionUser(req);
        addLog('product', 'state_updated', { products: state.products.length }, ip, sess ? sess.email : null);
        return json(res, 200, state);
      } catch (e) { return json(res, 400, { error: e.message || 'Unable to save.' }); }
    }

    // Logs
    if (url.pathname === '/api/admin/logs' && req.method === 'GET') {
      if (!auth(req, res)) return;
      const type = url.searchParams.get('type') || '';
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
      let filtered = logs;
      if (type && type !== 'all') filtered = filtered.filter(l => l.type === type);
      filtered = filtered.slice(-limit).reverse();
      return json(res, 200, { logs: filtered, total: logs.length });
    }
    if (url.pathname === '/api/admin/logs/clear' && req.method === 'POST') {
      if (!authOwner(req, res)) return;
      logs = []; saveLogs();
      return json(res, 200, { ok: true });
    }

    // Users
    if (url.pathname === '/api/admin/users' && req.method === 'GET') {
      if (!auth(req, res)) return;
      const query = url.searchParams.get('q') || '';
      return json(res, 200, { users: findUsers(query) });
    }
    if (url.pathname.startsWith('/api/admin/users/') && req.method === 'PUT') {
      if (!authOwner(req, res)) return;
      const userId = url.pathname.split('/').pop();
      const u = users.find(x => x.id === userId);
      if (!u) return json(res, 404, { error: 'User not found.' });
      try {
        const updates = await body(req);
        if (updates.role && ['user', 'admin'].includes(updates.role)) u.role = updates.role;
        if (updates.status && ['active', 'banned'].includes(updates.status)) u.status = updates.status;
        saveUsers();
        addLog('system', 'user_updated', { userId, changes: updates }, ip, getSessionUser(req)?.email);
        return json(res, 200, { ok: true, user: u });
      } catch { return json(res, 400, { error: 'Invalid update.' }); }
    }

    // Stats
    if (url.pathname === '/api/admin/stats' && req.method === 'GET') {
      if (!auth(req, res)) return;
      const state = await readStore();
      const totalRevenue = users.reduce((s, u) => s + (u.totalSpent || 0), 0);
      return json(res, 200, {
        totalProducts: state.products.length, totalUsers: users.length,
        activeUsers: users.filter(u => u.status === 'active').length, totalRevenue,
        authLogs: logs.filter(l => l.type === 'auth').length,
        purchaseLogs: logs.filter(l => l.type === 'purchase').length,
        linkLogs: logs.filter(l => l.type === 'link').length,
        totalLogs: logs.length, recentLogs: logs.slice(-10).reverse()
      });
    }

    // Purchase log
    if (url.pathname === '/api/admin/purchase' && req.method === 'POST') {
      if (!auth(req, res)) return;
      try {
        const { productId, email, amount } = await body(req);
        addLog('purchase', 'order_completed', { productId, email, amount }, ip, email || 'guest');
        const u = users.find(x => x.email === email);
        if (u) { u.purchaseCount = (u.purchaseCount || 0) + 1; u.totalSpent = (u.totalSpent || 0) + Number(amount || 0); saveUsers(); }
        return json(res, 200, { ok: true });
      } catch { return json(res, 400, { error: 'Invalid request.' }); }
    }

    // Link log
    if (url.pathname === '/api/admin/link-log' && req.method === 'POST') {
      if (!auth(req, res)) return;
      try {
        const { action, details } = await body(req);
        addLog('link', action || 'link_event', details || {}, ip, getSessionUser(req)?.email);
        return json(res, 200, { ok: true });
      } catch { return json(res, 400, { error: 'Invalid request.' }); }
    }

    // ── Discord Vouches API + Manage ────────────────────────────
    if (url.pathname === '/api/vouches/manage' && req.method === 'POST') {
      if (!auth(req, res)) return;
      try {
        const { action, vouch } = await body(req);
        if (action === 'add') {
          const vouches = fs.existsSync(VOUCHES_FILE) ? JSON.parse(fs.readFileSync(VOUCHES_FILE, 'utf8')) : [];
          vouches.unshift({ id: 'manual_' + Date.now(), author: cleanText(vouch.author, 80), content: cleanText(vouch.content, 500), rating: Math.min(5, Math.max(1, Number(vouch.rating) || 5)), stars: '⭐'.repeat(Math.min(5, Math.max(1, Number(vouch.rating) || 5))) + '☆'.repeat(5 - Math.min(5, Math.max(1, Number(vouch.rating) || 5))), timestamp: Date.now(), avatar: '' });
          if (vouches.length > 500) vouches.splice(-1, 1);
          fs.writeFileSync(VOUCHES_FILE, JSON.stringify(vouches, null, 2));
          return json(res, 200, { ok: true, vouches: vouches.slice(0, 50) });
        }
        if (action === 'delete') {
          const vouches = fs.existsSync(VOUCHES_FILE) ? JSON.parse(fs.readFileSync(VOUCHES_FILE, 'utf8')) : [];
          const filtered = vouches.filter(function(x) { return x.id !== (vouch && vouch.id) && x.author !== (vouch && vouch.author); });
          fs.writeFileSync(VOUCHES_FILE, JSON.stringify(filtered, null, 2));
          return json(res, 200, { ok: true, vouches: filtered.slice(0, 50) });
        }
        return json(res, 400, { error: 'Invalid action.' });
      } catch (e) { return json(res, 400, { error: 'Vouch management failed.' }); }
    }
    if (url.pathname === '/api/vouches' && req.method === 'GET') {
      try {
        const vouches = fs.existsSync(VOUCHES_FILE) ? JSON.parse(fs.readFileSync(VOUCHES_FILE, 'utf8')).slice(-50).reverse() : [];
        return json(res, 200, { vouches });
      } catch { return json(res, 200, { vouches: [] }); }
    }

    // ── Stripe Checkout ─────────────────────────────────────────────
    if (url.pathname === '/api/stripe/create-checkout' && req.method === 'POST') {
      if (!stripe) return json(res, 503, { error: 'Payment system unavailable.' });
      try {
        const { productName, game, price, currency, email, discordId } = await body(req);
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency: (currency || 'usd').toLowerCase(),
              product_data: { name: `Inertia — ${cleanText(productName, 100)} (${cleanText(game, 30)})` },
              unit_amount: Math.round(cleanNum(price, 0, 1e7, 0) * 100),
            },
            quantity: 1,
          }],
          mode: 'payment',
          success_url: `${req.headers.origin || `https://inertiacheat.com:${PORT}`}/payment/success`,
          cancel_url: `${req.headers.origin || `https://inertiacheat.com:${PORT}`}/payment/cancel`,
          customer_email: cleanText(email, 200) || undefined,
          metadata: { productName: cleanText(productName, 100), game: cleanText(game, 30), price: cleanNum(price, 0, 1e7, 0).toString(), discordId: discordId || '' },
        });
        return json(res, 200, { url: session.url, sessionId: session.id });
      } catch (e) { return json(res, 400, { error: 'Payment setup failed.' }); }
    }

    // ── Stripe Webhook ──────────────────────────────────────────────
    if (url.pathname === '/api/stripe/webhook' && req.method === 'POST') {
      if (!stripe) return json(res, 503, { error: 'Payment system unavailable.' });
      try {
        const sig = req.headers['stripe-signature'];
        const rawBody = await new Promise(resolve => {
          let data = ''; req.on('data', c => data += c); req.on('end', () => resolve(data));
        });
        const event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const metadata = session.metadata || {};
          const email = session.customer_email || 'guest';
          const amount = (session.amount_total || 0) / 100;

          // Log purchase
          addLog('purchase', 'stripe_payment', {
            product: metadata.productName,
            game: metadata.game,
            price: metadata.price,
            email,
            stripeId: session.id,
          }, 'stripe', email);

          // Update user stats
          const u = users.find(x => x.email === email);
          if (u) { u.purchaseCount = (u.purchaseCount || 0) + 1; u.totalSpent = (u.totalSpent || 0) + amount; saveUsers(); }

          // Post to Discord sales channel
          if (bots && bots.sales && bots.sales.postSale) {
            bots.sales.postSale({
              productName: metadata.productName || 'Product',
              game: metadata.game || 'UNKNOWN',
              price: metadata.price || amount,
              currency: (session.currency || 'usd').toUpperCase(),
              duration: '',
              email,
              orderId: session.id,
            }).catch(() => {});
          }

          // Assign Discord customer role
          if (metadata.discordId && bots && bots.authing && bots.authing.assignCustomerRole) {
            bots.authing.assignCustomerRole(metadata.discordId).catch(() => {});
          }
        }
        return json(res, 200, { received: true });
      } catch (e) { return json(res, 400, { error: 'Webhook error.' }); }
    }

    // ── Payment Result Pages ────────────────────────────────────────
    if (url.pathname === '/payment/success' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Successful</title><style>body{background:#060a14;color:#fff;font-family:'Jura',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center} h1{color:#22c55e;font-size:clamp(24px,5vw,48px)} p{color:rgba(255,255,255,.6)} a{color:#60a5fa}</style></head><body><div><h1>✅ Payment Successful!</h1><p>Thank you for your purchase. Your product will be delivered shortly.</p><p><a href="/">Return to Inertia</a></p></div></body></html>`);
    }
    if (url.pathname === '/payment/cancel' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Cancelled</title><style>body{background:#060a14;color:#fff;font-family:'Jura',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center} h1{color:#f87171;font-size:clamp(24px,5vw,48px)} p{color:rgba(255,255,255,.6)} a{color:#60a5fa}</style></head><body><div><h1>❌ Payment Cancelled</h1><p>Your payment was not completed. No charges were made.</p><p><a href="/">Return to Inertia</a></p></div></body></html>`);
    }

    // Fallback to index.html
    if (req.method === 'GET' || req.method === 'HEAD') {
      return fs.readFile(path.join(ROOT, 'index.html'), (err, file) => {
        if (err) return json(res, 500, { error: 'Application unavailable.' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(file);
      });
    }

    json(res, 404, { error: 'Not found.' });
  } catch (e) {
    console.error('Server error:', e);
    json(res, 500, { error: 'Internal server error.' });
  }
});



// --- Start
(async () => {
    console.log("Loading logs and users...");
    loadLogs();
    loadUsers();
    
    console.log("Initializing database store...");
    if (MONGO_URI) { await initMongoStore(); } else { await initFileStore(); }
    
    addLog('system', 'server_started', { port: PORT }, '127.0.0.1', 'system');
    
    console.log(`Attempting to bind server to port ${PORT}...`);
    server.listen(PORT, () => console.log(`Inertia running on port ${PORT}`));
})();