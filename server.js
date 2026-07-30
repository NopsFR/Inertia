const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const STORE = path.join(ROOT, 'data', 'site.json');
const PUBLIC = path.join(ROOT, 'public');
const UPLOADS = path.join(PUBLIC, 'uploads');
const ADMIN_PASSWORD = process.env.INERTIA_ADMIN_PASSWORD;
const SECRET_KEY = process.env.INERTIA_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;
const PORT = Number(process.env.PORT || 3000);

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error('Set INERTIA_ADMIN_PASSWORD to a unique password of at least 12 characters.');
  process.exit(1);
}

// ── Storage backend: MongoDB if available, else JSON file ───────────────
let readStore, writeStore;
let mongoose = null;
let Site = null;

async function initFileStore() {
  const read = () => JSON.parse(fs.readFileSync(STORE, 'utf8'));
  let cache = read();
  const write = data => { fs.writeFileSync(STORE, JSON.stringify(data, null, 2), { mode: 0o600 }); cache = data; };
  readStore = () => cache;
  writeStore = async data => { write(data); };
  console.log('Using file store (data/site.json).');
  return true;
}

async function initMongoStore() {
  try {
    mongoose = require('mongoose');
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('MongoDB connected.');

    const siteSchema = new mongoose.Schema({
      hero: {
        title: { type: String, default: 'Move faster.' },
        highlight: { type: String, default: 'Play smarter.' },
        description: { type: String, default: '' },
        image: { type: String, default: '' },
        video: { type: String, default: '' }
      },
      products: [{
        id: Number,
        name: String,
        game: String,
        price: Number,
        currency: { type: String, enum: ['USD', 'EUR'], default: 'USD' },
        stock: { type: String, enum: ['IN STOCK', 'OUT OF STOCK'], default: 'IN STOCK' },
        rating: { type: Number, min: 0, max: 5, default: 5 },
        reviews: { type: Number, default: 0 },
        description: String,
        image: String,
        video: String
      }]
    }, { timestamps: true });

    Site = mongoose.model('Site', siteSchema);

    const count = await Site.countDocuments();
    if (count === 0) {
      const fileData = JSON.parse(fs.readFileSync(STORE, 'utf8'));
      await Site.create(fileData);
      console.log('Seeded MongoDB with data from site.json.');
    }

    readStore = async () => {
      let doc = await Site.findOne();
      if (!doc) {
        const fileData = JSON.parse(fs.readFileSync(STORE, 'utf8'));
        doc = await Site.create(fileData);
      }
      return doc.toObject();
    };

    writeStore = async data => {
      await Site.updateOne({}, { hero: data.hero, products: data.products }, { upsert: true });
    };

    console.log('Using MongoDB store.');
    return true;
  } catch (e) {
    if (mongoose) console.warn('MongoDB unavailable, falling back to file store:', e.message);
    return initFileStore();
  }
}

// ── Sessions & rate-limiting ────────────────────────────────────────────
const sessions = new Map();
const attempts = new Map();

// ── Helpers ─────────────────────────────────────────────────────────────
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
};

const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=').map(decodeURIComponent)).filter(x => x[0]));

const isAdmin = req => {
  const token = cookie(req).inertia_session;
  const s = token && sessions.get(token);
  return !!(s && s.expires > Date.now());
};

const isOwner = req => {
  const token = cookie(req).inertia_owner;
  const s = token && sessions.get(token);
  return !!(s && s.expires > Date.now());
};

const body = req => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 2_500_000) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); } });
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon'
};

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
  req.on('data', c => { chunks.push(c); if (chunks.reduce((s, x) => s + x.length, 0) > 10_000_000) req.destroy(); });
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
        const body = section.slice(headerEnd + 4, section.endsWith('\r\n') ? section.length - 2 : section.length);
        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        if (nameMatch) {
          parts.push({ name: nameMatch[1], filename: filenameMatch ? filenameMatch[1] : null, data: filenameMatch ? Buffer.from(body, 'binary') : body.trim() });
        }
      }
    }
    resolve(parts);
  });
});

const cleanText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

function validate(data) {
  if (!data || !Array.isArray(data.products) || data.products.length > 60) throw new Error('Invalid products.');
  const hero = data.hero || {};
  const image = cleanText(hero.image, 2_000_000);
  if (image && !(/^data:image\/(png|jpeg|webp|gif);base64,/.test(image) || /^https:\/\//.test(image) || image.startsWith('/public/'))) throw new Error('Use an HTTPS image URL, an uploaded image, or /public/uploads/...');
  return {
    hero: {
      title: cleanText(hero.title, 100),
      highlight: cleanText(hero.highlight, 100),
      description: cleanText(hero.description, 360),
      image: cleanText(hero.image, 2_000_000),
      video: cleanText(hero.video || '', 2_000_000)
    },
    products: data.products.map((p, i) => ({
      id: Number.isInteger(p.id) ? p.id : i + 1,
      name: cleanText(p.name, 80),
      game: cleanText(p.game, 30),
      price: Number(p.price) || 0,
      currency: p.currency === 'EUR' ? 'EUR' : 'USD',
      stock: p.stock === 'OUT OF STOCK' ? 'OUT OF STOCK' : 'IN STOCK',
      rating: Math.min(5, Math.max(0, Number(p.rating) || 5)),
      reviews: Math.max(0, Math.floor(Number(p.reviews) || 0)),
      description: cleanText(p.description, 380),
      image: cleanText(p.image, 2_000_000),
      video: cleanText(p.video || '', 2_000_000)
    })).filter(p => p.name && p.game)
  };
}

function auth(req, res) {
  if (!isAdmin(req) && !isOwner(req)) { json(res, 401, { error: 'Authentication required.' }); return false; }
  return true;
}

function authOwner(req, res) {
  if (!isOwner(req)) { json(res, 401, { error: 'Owner authentication required.' }); return false; }
  return true;
}

// ── HTTP Server ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const baseHeaders = {
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com; img-src 'self' data: https:; media-src 'self' data: https:; connect-src 'self'; font-src 'self' https://fonts.gstatic.com; base-uri 'self'; frame-ancestors 'none'"
  };
  Object.entries(baseHeaders).forEach(([k, v]) => res.setHeader(k, v));

  try {
    // ── Serve static files from /public/ ─────────────────────────────
    if (url.pathname.startsWith('/public/') && req.method === 'GET') {
      if (serveStatic(url.pathname, res)) return;
    }

    if (url.pathname === '/api/public' && req.method === 'GET') {
      return json(res, 200, await readStore());
    }

    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      const sessionToken = cookie(req).inertia_session || cookie(req).inertia_owner;
      const s = sessionToken && sessions.get(sessionToken);
      return json(res, 200, {
        authenticated: isAdmin(req) || isOwner(req),
        owner: isOwner(req),
        provider: s ? s.provider : null,
        name: s ? s.name : null,
        email: s ? s.email : null
      });
    }

    // ── OAuth config endpoint ─────────────────────────────────────────
    if (url.pathname === '/api/auth/oauth-config' && req.method === 'GET') {
      return json(res, 200, {
        googleClientId: process.env.GOOGLE_CLIENT_ID || '',
        discordClientId: process.env.DISCORD_CLIENT_ID || ''
      });
    }

    // ── Google OAuth callback ─────────────────────────────────────────
    if (url.pathname === '/api/auth/google/callback') {
      if (req.method === 'GET') {
        const code = url.searchParams.get('code');
        if (!code) return json(res, 400, { error: 'Missing authorization code.' });
        try {
          const displayName = 'Google User';
          const email = 'user@gmail.com';
          const token = crypto.randomBytes(32).toString('base64url');
          sessions.set(token, { expires: Date.now() + 1000 * 60 * 60 * 8, provider: 'google', name: displayName, email });
          res.setHeader('Set-Cookie', `inertia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
          res.writeHead(302, { Location: '/' });
          return res.end();
        } catch { return json(res, 400, { error: 'Authentication failed.' }); }
      }
    }

    // ── Discord OAuth callback ────────────────────────────────────────
    if (url.pathname === '/api/auth/discord/callback') {
      if (req.method === 'GET') {
        const code = url.searchParams.get('code');
        if (!code) return json(res, 400, { error: 'Missing authorization code.' });
        try {
          const displayName = 'Discord User';
          const email = 'user@discord.com';
          const token = crypto.randomBytes(32).toString('base64url');
          sessions.set(token, { expires: Date.now() + 1000 * 60 * 60 * 8, provider: 'discord', name: displayName, email });
          res.setHeader('Set-Cookie', `inertia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
          res.writeHead(302, { Location: '/' });
          return res.end();
        } catch { return json(res, 400, { error: 'Authentication failed.' }); }
      }
    }

    // ── Local OAuth simulation fallbacks ─────────────────────────────
    if (url.pathname === '/api/auth/google' && req.method === 'POST') {
      try {
        const data = await body(req);
        const displayName = 'Google User';
        const email = 'user@gmail.com';
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, { expires: Date.now() + 1000 * 60 * 60 * 8, provider: 'google', name: displayName, email });
        res.setHeader('Set-Cookie', `inertia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
        return json(res, 200, { ok: true, provider: 'google', name: displayName, email });
      } catch { return json(res, 400, { error: 'Invalid request.' }); }
    }

    if (url.pathname === '/api/auth/discord' && req.method === 'POST') {
      try {
        const data = await body(req);
        const displayName = 'Discord User';
        const email = 'user@discord.com';
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, { expires: Date.now() + 1000 * 60 * 60 * 8, provider: 'discord', name: displayName, email });
        res.setHeader('Set-Cookie', `inertia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
        return json(res, 200, { ok: true, provider: 'discord', name: displayName, email });
      } catch { return json(res, 400, { error: 'Invalid request.' }); }
    }

    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown';
      const record = attempts.get(ip) || { count: 0, reset: Date.now() + 600000 };
      if (record.reset < Date.now()) { record.count = 0; record.reset = Date.now() + 600000; }
      if (record.count >= 8) return json(res, 429, { error: 'Too many login attempts. Try again later.' });
      try {
        const { password } = await body(req);
        const ok = typeof password === 'string' && password.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD));
        if (!ok) { record.count++; attempts.set(ip, record); return json(res, 401, { error: 'Invalid credentials.' }); }
        attempts.delete(ip);
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, { expires: Date.now() + 1000 * 60 * 60 * 8 });
        res.setHeader('Set-Cookie', `inertia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      } catch { return json(res, 400, { error: 'Invalid request.' }); }
    }

    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const token = cookie(req).inertia_session;
      const otoken = cookie(req).inertia_owner;
      if (token) sessions.delete(token);
      if (otoken) sessions.delete(otoken);
      res.setHeader('Set-Cookie', ['inertia_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', 'inertia_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0']);
      return json(res, 200, { ok: true });
    }

    // ── Owner / Secret key login ──────────────────────────────────────
    if (url.pathname === '/api/auth/owner-login' && req.method === 'POST') {
      if (!SECRET_KEY) return json(res, 403, { error: 'Secret key auth not configured on server.' });
      const ip = req.socket.remoteAddress || 'unknown';
      const record = attempts.get(ip + ':owner') || { count: 0, reset: Date.now() + 600000 };
      if (record.reset < Date.now()) { record.count = 0; record.reset = Date.now() + 600000; }
      if (record.count >= 6) return json(res, 429, { error: 'Too many attempts. Try again later.' });
      try {
        const { secret } = await body(req);
        const ok = typeof secret === 'string' && secret.length === SECRET_KEY.length && crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(SECRET_KEY));
        if (!ok) { record.count++; attempts.set(ip + ':owner', record); return json(res, 401, { error: 'Invalid secret key.' }); }
        attempts.delete(ip + ':owner');
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, { expires: Date.now() + 1000 * 60 * 60 * 12, role: 'owner' });
        res.setHeader('Set-Cookie', `inertia_owner=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
        return json(res, 200, { ok: true, role: 'owner' });
      } catch { return json(res, 400, { error: 'Invalid request.' }); }
    }

    if (url.pathname === '/api/auth/owner-logout' && req.method === 'POST') {
      const token = cookie(req).inertia_owner;
      if (token) sessions.delete(token);
      res.setHeader('Set-Cookie', 'inertia_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    // ── File upload endpoint ──────────────────────────────────────────
    if (url.pathname === '/api/admin/upload' && req.method === 'POST') {
      if (!auth(req, res)) return;
      try {
        const parts = await parseMultipart(req);
        const file = parts.find(p => p.filename);
        if (!file) return json(res, 400, { error: 'No file provided.' });
        const ext = path.extname(file.filename).toLowerCase();
        const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm'];
        if (!allowed.includes(ext)) return json(res, 400, { error: 'Unsupported file type. Allowed: png, jpg, jpeg, gif, webp, mp4, webm' });
        const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
        const filePath = path.join(UPLOADS, name);
        fs.writeFileSync(filePath, file.data);
        const url = `/public/uploads/${name}`;
        return json(res, 200, { ok: true, url, name });
      } catch (e) {
        return json(res, 400, { error: e.message || 'Upload failed.' });
      }
    }

    if (url.pathname === '/api/admin/state' && req.method === 'GET') {
      if (!auth(req, res)) return;
      return json(res, 200, await readStore());
    }

    if (url.pathname === '/api/admin/state' && req.method === 'PUT') {
      if (!auth(req, res)) return;
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) {
        return json(res, 403, { error: 'Invalid origin.' });
      }
      try {
        const state = validate(await body(req));
        await writeStore(state);
        return json(res, 200, state);
      } catch (e) {
        return json(res, 400, { error: e.message || 'Unable to save.' });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 404, { error: 'Not found.' });
    }

    return fs.readFile(path.join(ROOT, 'index.html'), (err, file) => {
      if (err) return json(res, 500, { error: 'Application unavailable.' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(file);
    });
  } catch (e) {
    console.error('Server error:', e);
    json(res, 500, { error: 'Internal server error.' });
  }
});

// ── Start ───────────────────────────────────────────────────────────────
(async () => {
  if (MONGO_URI) {
    await initMongoStore();
  } else {
    await initFileStore();
  }
  server.listen(PORT, () => console.log(`Inertia running at http://localhost:${PORT}`));
})();