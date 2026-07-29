const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const STORE = path.join(ROOT, 'data', 'site.json');
const ADMIN_PASSWORD = process.env.INERTIA_ADMIN_PASSWORD;
const PORT = Number(process.env.PORT || 3000);
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error('Set INERTIA_ADMIN_PASSWORD to a unique password of at least 12 characters.');
  process.exit(1);
}

const sessions = new Map();
const attempts = new Map();
const readStore = () => JSON.parse(fs.readFileSync(STORE, 'utf8'));
let storeCache = readStore();
const writeStore = data => { fs.writeFileSync(STORE, JSON.stringify(data, null, 2), { mode: 0o600 }); storeCache = data; };
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=').map(decodeURIComponent)).filter(x => x[0]));
const isAdmin = req => { const token = cookie(req).inertia_session; const s = token && sessions.get(token); return !!(s && s.expires > Date.now()); };
const body = req => new Promise((resolve, reject) => { let raw=''; req.on('data', c => { raw += c; if (raw.length > 2_500_000) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); } }); });
const cleanText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function validate(data) {
  if (!data || !Array.isArray(data.products) || data.products.length > 60) throw new Error('Invalid products.');
  const hero = data.hero || {};
  const image = cleanText(hero.image, 2_000_000);
  if (image && !(/^data:image\/(png|jpeg|webp|gif);base64,/.test(image) || /^https:\/\//.test(image))) throw new Error('Use an HTTPS image URL or an uploaded image.');
  return {
    hero: { title: cleanText(hero.title, 100), highlight: cleanText(hero.highlight, 100), description: cleanText(hero.description, 360), image },
    products: data.products.map((p, i) => ({ id: Number.isInteger(p.id) ? p.id : i + 1, name: cleanText(p.name, 80), game: cleanText(p.game, 30), price: Number(p.price) || 0, currency: p.currency === 'EUR' ? 'EUR' : 'USD', stock: p.stock === 'OUT OF STOCK' ? 'OUT OF STOCK' : 'IN STOCK', rating: Math.min(5, Math.max(0, Number(p.rating) || 5)), reviews: Math.max(0, Math.floor(Number(p.reviews) || 0)), description: cleanText(p.description, 380), image: cleanText(p.image, 2_000_000) })).filter(p => p.name && p.game)
  };
}
function auth(req, res) { if (!isAdmin(req)) { json(res, 401, { error: 'Authentication required.' }); return false; } return true; }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const baseHeaders = { 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; base-uri 'self'; frame-ancestors 'none'" };
  Object.entries(baseHeaders).forEach(([k,v]) => res.setHeader(k,v));
  if (url.pathname === '/api/public' && req.method === 'GET') return json(res, 200, storeCache);
  if (url.pathname === '/api/auth/me' && req.method === 'GET') return json(res, 200, { authenticated: isAdmin(req) });
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown', record = attempts.get(ip) || { count: 0, reset: Date.now() + 600000 };
    if (record.reset < Date.now()) { record.count = 0; record.reset = Date.now() + 600000; }
    if (record.count >= 8) return json(res, 429, { error: 'Too many login attempts. Try again later.' });
    try { const { password } = await body(req); const ok = typeof password === 'string' && password.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD)); if (!ok) { record.count++; attempts.set(ip, record); return json(res, 401, { error: 'Invalid credentials.' }); }
      attempts.delete(ip); const token = crypto.randomBytes(32).toString('base64url'); sessions.set(token, { expires: Date.now() + 1000*60*60*8 }); res.setHeader('Set-Cookie', `inertia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`); return json(res, 200, { ok: true });
    } catch { return json(res, 400, { error: 'Invalid request.' }); }
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') { const token = cookie(req).inertia_session; if (token) sessions.delete(token); res.setHeader('Set-Cookie', 'inertia_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }
  if (url.pathname === '/api/admin/state' && req.method === 'GET') { if (!auth(req,res)) return; return json(res, 200, storeCache); }
  if (url.pathname === '/api/admin/state' && req.method === 'PUT') { if (!auth(req,res)) return; if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return json(res, 403, { error: 'Invalid origin.' }); try { const state = validate(await body(req)); writeStore(state); return json(res, 200, state); } catch (e) { return json(res, 400, { error: e.message || 'Unable to save.' }); } }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 404, { error: 'Not found.' });
  return fs.readFile(path.join(ROOT, 'index.html'), (err, file) => { if (err) return json(res,500,{error:'Application unavailable.'}); res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'}); res.end(file); });
});
server.listen(PORT, () => console.log(`Inertia running at http://localhost:${PORT}`));
