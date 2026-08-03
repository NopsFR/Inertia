// Shared bot configuration
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

module.exports = {
  // Bot tokens
  tokens: {
    sales: process.env.SALES_BOT_TOKEN,
    ticket: process.env.TICKET_BOT_TOKEN,
    management: process.env.MANAGEMENT_BOT_TOKEN,
    authing: process.env.AUTHING_BOT_TOKEN,
    vouches: process.env.VOUCHES_BOT_TOKEN,
  },

  // Discord IDs
  guildId: process.env.DISCORD_GUILD_ID,
  channels: {
    vouches: process.env.VOUCHES_CHANNEL_ID,
    tickets: process.env.TICKET_SUPPORT_CHANNEL_ID,
    sales: process.env.SALES_CHANNEL_ID,
    management: process.env.MANAGEMENT_CHANNEL_ID,
  },

  // Role IDs
  roles: {
    inertia: process.env.INERTIA_ROLE_ID,
    serverBooster: process.env.SERVER_BOOSTER_ROLE_ID,
    customer: process.env.CUSTOMER_ROLE_ID,
    support: process.env.SUPPORT_ROLE_ID,
    management: process.env.MANAGEMENT_ROLE_ID,
    reseller: process.env.RESELLER_ROLE_ID,
    media: process.env.MEDIA_ROLE_ID,
    member: process.env.MEMBER_ROLE_ID,
  },

  // Stripe
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },

  // Products
  products: [
    {
      name: 'Day Key',
      game: 'UNIVERSAL',
      prices: { usd: 5.00 },
      stripePriceId: 'price_day',
      emoji: '☀️',
    },
    {
      name: 'Week Key',
      game: 'UNIVERSAL',
      prices: { usd: 25.00 },
      stripePriceId: 'price_week',
      emoji: '📅',
    },
    {
      name: 'Month Key',
      game: 'UNIVERSAL',
      prices: { usd: 50.00 },
      stripePriceId: 'price_month',
      emoji: '🌙',
    },
    {
      name: '3 Month Key',
      game: 'UNIVERSAL',
      prices: { usd: 125.00 },
      stripePriceId: 'price_3month',
      emoji: '📦',
    },
    {
      name: 'Lifetime Key',
      game: 'UNIVERSAL',
      prices: { usd: 200.00 },
      stripePriceId: 'price_lifetime',
      emoji: '👑',
    },
    {
      name: 'CS2 14D',
      game: 'CS2',
      prices: { usd: 5.00 },
      stripePriceId: 'price_cs2_14d',
      emoji: '🔫',
    },
    {
      name: 'CS2 30D',
      game: 'CS2',
      prices: { usd: 7.00 },
      stripePriceId: 'price_cs2_30d',
      emoji: '🎯',
    },
    {
      name: 'CS2 90D',
      game: 'CS2',
      prices: { usd: 16.00 },
      stripePriceId: 'price_cs2_90d',
      emoji: '⚔️',
    },
    {
      name: 'CS2 180D',
      game: 'CS2',
      prices: { usd: 30.00 },
      stripePriceId: 'price_cs2_180d',
      emoji: '🛡️',
    },
    {
      name: 'CS2 Lifetime',
      game: 'CS2',
      prices: { usd: 60.00 },
      stripePriceId: 'price_cs2_lifetime',
      emoji: '🏆',
    },
    {
      name: 'COD 1D',
      game: 'COD',
      prices: { usd: 5.00 },
      stripePriceId: 'price_cod_1d',
      emoji: '💣',
    },
    {
      name: 'COD 7D',
      game: 'COD',
      prices: { usd: 20.00 },
      stripePriceId: 'price_cod_7d',
      emoji: '🔥',
    },
    {
      name: 'COD 30D',
      game: 'COD',
      prices: { usd: 40.00 },
      stripePriceId: 'price_cod_30d',
      emoji: '⚡',
    },
    {
      name: 'COD Lifetime',
      game: 'COD',
      prices: { usd: 100.00 },
      stripePriceId: 'price_cod_lifetime',
      emoji: '💎',
    },
  ],
};