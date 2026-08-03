// Bot Launcher — Starts all 4 Discord bots
// ── Global crash guards: a bot network error must never take down the app ──
process.on('unhandledRejection', (reason) => {
  console.error('[Bots] Unhandled Rejection:', (reason && reason.message) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Bots] Uncaught Exception:', err && err.message);
  // Log and continue — do not exit the process.
});
console.log('╔══════════════════════════════════════╗');
console.log('║     Inertia Discord Bot System      ║');
console.log('╚══════════════════════════════════════╝');

const bots = {};

try {
  bots.sales = require('./sales');
  console.log('[Launcher] ✓ Sales Bot started');
} catch (e) { console.error('[Launcher] ✗ Sales Bot failed:', e.message); }

try {
  bots.ticket = require('./ticket');
  console.log('[Launcher] ✓ Ticket Bot started');
} catch (e) { console.error('[Launcher] ✗ Ticket Bot failed:', e.message); }

try {
  bots.management = require('./management');
  console.log('[Launcher] ✓ Management Bot started');
} catch (e) { console.error('[Launcher] ✗ Management Bot failed:', e.message); }

try {
  bots.authing = require('./authing');
  console.log('[Launcher] ✓ Authing Bot started');
} catch (e) { console.error('[Launcher] ✗ Authing Bot failed:', e.message); }

try {
  bots.vouches = require('./vouches');
  console.log('[Launcher] ✓ Vouches Bot started');
} catch (e) { console.error('[Launcher] ✗ Vouches Bot failed:', e.message); }

module.exports = bots;
