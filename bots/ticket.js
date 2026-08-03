// Ticket Bot — /purchase command with dynamic StringSelectMenu from shared database
var Discord = require('discord.js');
var config = require('./config');
var fs = require('node:fs');
var path = require('node:path');

var client = new Discord.Client({
  intents: [Discord.GatewayIntentBits.Guilds, Discord.GatewayIntentBits.GuildMessages, Discord.GatewayIntentBits.MessageContent],
});

var stripe = null;
try { stripe = require('stripe')(config.stripe.secretKey); } catch (e) { console.warn('[Ticket] Stripe not configured'); }

var PANEL_FLAG_FILE = path.join(__dirname, '..', 'data', '.ticket_panel_posted');
var SITE_FILE = path.join(__dirname, '..', 'data', 'site.json');

// Fetch live products from the shared database
function getLiveProducts() {
  try {
    var data = JSON.parse(fs.readFileSync(SITE_FILE, 'utf8'));
    return (data.products || []).filter(function (p) { return p.stock === 'IN STOCK'; });
  } catch (e) {
    console.error('[Ticket] Could not read site.json:', e.message);
    return [];
  }
}

client.once('ready', async function () {
  console.log('[Ticket Bot] Online as ' + client.user.tag);

  try {
    await client.application.commands.create({
      name: 'purchase',
      description: 'Purchase a product via Stripe checkout'
    });
  } catch (e) { console.warn('[Ticket] Slash commands may already exist:', e.message); }

  // Only post the panel once
  if (fs.existsSync(PANEL_FLAG_FILE)) {
    console.log('[Ticket] Panel already posted, skipping.');
    return;
  }

  try {
    var ch = await client.channels.fetch(config.channels.tickets);
    if (!ch) return;

    var panelEmbed = new Discord.EmbedBuilder()
      .setColor('#3b82f6')
      .setTitle('🎫 Inertia Support Center')
      .setDescription('Need help? Click below to create a private ticket.\n\n**Available Commands:**\n`/purchase` — Buy via Stripe checkout\n\nOur support team will assist you shortly.')
      .setFooter({ text: 'Inertia Support System' });

    var panelRow = new Discord.ActionRowBuilder().addComponents(
      new Discord.ButtonBuilder().setCustomId('create_ticket').setLabel('🎫 Create Ticket').setStyle(Discord.ButtonStyle.Primary),
      new Discord.ButtonBuilder().setCustomId('purchase_cmd').setLabel('🛒 Purchase').setStyle(Discord.ButtonStyle.Success)
    );

    await ch.send({ embeds: [panelEmbed], components: [panelRow] });
    try { fs.writeFileSync(PANEL_FLAG_FILE, Date.now().toString()); } catch (e) { /* ignore */ }
    console.log('[Ticket] Panel posted (one-time)');
  } catch (e) { console.warn('[Ticket] Could not post panel:', e.message); }
});

client.on('interactionCreate', async function (interaction) {
  if (interaction.isButton()) {
    if (interaction.customId === 'create_ticket') return handleCreateTicket(interaction);
    if (interaction.customId === 'purchase_cmd') return handlePurchaseButton(interaction);
    if (interaction.customId === 'close_ticket') return handleCloseTicket(interaction);
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'purchase_select') {
    return handlePurchaseSelect(interaction);
  }
  if (interaction.isCommand() && interaction.commandName === 'purchase') {
    return handlePurchaseSlash(interaction);
  }
});

async function handleCreateTicket(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    var guild = interaction.guild;
    var user = interaction.user;
    var chName = 'ticket-' + user.username.toLowerCase().replace(/[^a-z0-9]/g, '-');
    var channel = await guild.channels.create({
      name: chName,
      type: Discord.ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.id, deny: [Discord.PermissionsBitField.Flags.ViewChannel] },
        { id: user.id, allow: [Discord.PermissionsBitField.Flags.ViewChannel, Discord.PermissionsBitField.Flags.SendMessages, Discord.PermissionsBitField.Flags.ReadMessageHistory] },
        { id: config.roles.support, allow: [Discord.PermissionsBitField.Flags.ViewChannel, Discord.PermissionsBitField.Flags.SendMessages, Discord.PermissionsBitField.Flags.ReadMessageHistory] },
        { id: config.roles.inertia, allow: [Discord.PermissionsBitField.Flags.ViewChannel, Discord.PermissionsBitField.Flags.SendMessages, Discord.PermissionsBitField.Flags.ReadMessageHistory] },
        { id: config.roles.management, allow: [Discord.PermissionsBitField.Flags.ViewChannel, Discord.PermissionsBitField.Flags.SendMessages, Discord.PermissionsBitField.Flags.ReadMessageHistory] },
      ],
    });

    var embed = new Discord.EmbedBuilder()
      .setColor('#3b82f6')
      .setTitle('🎫 Support Ticket')
      .setDescription('Welcome ' + user.toString() + '! A support team member will assist you shortly.\n\n**Use `/purchase` to buy products via Stripe.**\n\nClick 🔒 below to close this ticket when resolved.')
      .setFooter({ text: 'Inertia Support' })
      .setTimestamp();

    var closeRow = new Discord.ActionRowBuilder().addComponents(
      new Discord.ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 Close Ticket').setStyle(Discord.ButtonStyle.Danger)
    );

    await channel.send({ content: user.toString(), embeds: [embed], components: [closeRow] });
    await interaction.editReply({ content: '✅ Ticket created: ' + channel.toString(), ephemeral: true });
  } catch (e) {
    console.error('[Ticket] Error:', e.message);
    await interaction.editReply({ content: '❌ Failed to create ticket.', ephemeral: true });
  }
}

async function handleCloseTicket(interaction) {
  await interaction.deferReply({ ephemeral: true });
  if (!interaction.channel.name.startsWith('ticket-')) return interaction.editReply({ content: '❌ Not a ticket channel.' });
  await interaction.editReply({ content: '🔒 Closing ticket in 5 seconds...' });
  setTimeout(async function () {
    try { await interaction.channel.delete(); } catch (e) { console.error('[Ticket] Close error:', e.message); }
  }, 5000);
}

async function handlePurchaseButton(interaction) {
  await interaction.deferReply({ ephemeral: true });
  var products = getLiveProducts();
  if (!products.length) return interaction.editReply({ content: '❌ No products available. Check back later.' });

  var embed = buildCatalogEmbed(products);
  await interaction.editReply({ embeds: [embed] });
}

// ── Build clean categorized product catalog embed ──
function buildCatalogEmbed(products) {
  var categories = {};
  products.forEach(function (p) {
    var cat = p.game || 'UNIVERSAL';
    if (cat === 'UNIVERSAL') cat = '🌐 Universal Keys';
    else if (cat === 'CS2') cat = '🔫 Counter-Strike 2 (CS2)';
    else if (cat === 'COD') cat = '💣 Call of Duty (COD)';
    else cat = '📦 ' + cat;
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(p);
  });

  var embed = new Discord.EmbedBuilder()
    .setColor('#22c55e')
    .setTitle('🛒 Inertia Product Store')
    .setDescription('High-quality gaming tools — instant delivery after purchase.\nUse **`/purchase`** in any ticket channel to buy.');

  var catOrder = ['🌐 Universal Keys', '🔫 Counter-Strike 2 (CS2)', '💣 Call of Duty (COD)'];
  catOrder.forEach(function (cat) {
    if (!categories[cat] || !categories[cat].length) return;
    var lines = categories[cat].map(function (p) {
      return '🔹 **' + p.name + '** — `$' + Number(p.price || 0).toFixed(2) + '` *(' + (p.duration || p.name) + ')*';
    });
    embed.addFields({ name: cat, value: lines.join('\n'), inline: false });
  });

  // Handle any uncategorized products
  Object.keys(categories).forEach(function (cat) {
    if (catOrder.indexOf(cat) !== -1) return;
    var lines = categories[cat].map(function (p) {
      return '🔹 **' + p.name + '** — `$' + Number(p.price || 0).toFixed(2) + '` *(' + (p.duration || p.name) + ')*';
    });
    embed.addFields({ name: cat, value: lines.join('\n'), inline: false });
  });

  embed.setFooter({ text: products.length + ' products • Create a ticket • Use /purchase' });
  embed.setTimestamp();
  return embed;
}

// Build the dynamic StringSelectMenu from live products
function buildProductSelectMenu(products) {
  if (!products.length) return null;

  var options = products.map(function (p, i) {
    return {
      label: p.name + ' — $' + Number(p.price || 0).toFixed(2),
      description: (p.duration || '') + (p.game ? ' | ' + p.game : ''),
      value: String(p.id || i),
      emoji: p.slug ? undefined : '🛒',
    };
  }).slice(0, 25); // Discord max 25 options

  return new Discord.ActionRowBuilder().addComponents(
    new Discord.StringSelectMenuBuilder()
      .setCustomId('purchase_select')
      .setPlaceholder('Choose a product to purchase...')
      .addOptions(options)
  );
}

async function handlePurchaseSlash(interaction) {
  if (!interaction.channel.name.startsWith('ticket-')) {
    return interaction.reply({ content: '❌ Use `/purchase` inside your ticket channel.', ephemeral: true });
  }
  if (!stripe) {
    return interaction.reply({ content: '❌ Payment system is not configured yet.', ephemeral: true });
  }

  var products = getLiveProducts();
  if (!products.length) {
    return interaction.reply({ content: '❌ No products available at the moment.', ephemeral: true });
  }

  var row = buildProductSelectMenu(products);
  if (!row) {
    return interaction.reply({ content: '❌ Could not build product menu.', ephemeral: true });
  }

  var embed = new Discord.EmbedBuilder()
    .setColor('#22c55e')
    .setTitle('🛒 Select a Product')
    .setDescription(products.length + ' products available. Choose one from the dropdown below:')
    .setFooter({ text: 'Select a product to continue' });

  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// Handle product selection from the dropdown
async function handlePurchaseSelect(interaction) {
  await interaction.deferReply({ ephemeral: true });
  var productId = interaction.values[0];
  var products = getLiveProducts();
  var product = products.find(function (p) { return String(p.id) === productId; });
  if (!product) {
    return interaction.editReply({ content: '❌ Product not found.' });
  }

  // Collect email
  var askEmbed = new Discord.EmbedBuilder()
    .setColor('#3b82f6')
    .setTitle('📧 Enter Email')
    .setDescription('Please enter your email address for order delivery.\n\n**Product:** ' + product.name + '\n**Price:** $' + Number(product.price || 0).toFixed(2))
    .setFooter({ text: 'Type your email below' });

  await interaction.editReply({ embeds: [askEmbed] });

  var emailFilter = function (m) { return m.author.id === interaction.user.id && m.content.includes('@'); };
  try {
    var emailCollected = await interaction.channel.awaitMessages({ filter: emailFilter, max: 1, time: 120000, errors: ['time'] });
    var email = emailCollected.first().content.trim();

    var origin = 'http://localhost:' + (process.env.PORT || 3000);
    var session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: (product.currency || 'usd').toLowerCase(),
          product_data: { name: 'Inertia — ' + product.name + ' (' + (product.game || 'UNIVERSAL') + ')' },
          unit_amount: Math.round(Number(product.price || 0) * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: origin + '/payment/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: origin + '/payment/cancel',
      customer_email: email,
      metadata: {
        productId: String(product.id),
        productName: product.name,
        slug: product.slug || '',
        game: product.game || 'UNIVERSAL',
        price: String(product.price || 0),
        duration: product.duration || '',
        category: product.category || '',
        discordId: interaction.user.id,
      },
    });

    var payEmbed = new Discord.EmbedBuilder()
      .setColor('#22c55e')
      .setTitle('💳 Complete Your Purchase')
      .setDescription('**' + product.name + '** — $' + Number(product.price || 0).toFixed(2) + '\n\n[Click here to pay](' + session.url + ')\n\nYour order will be delivered instantly after payment.')
      .addFields(
        { name: 'Product', value: product.name, inline: true },
        { name: 'Price', value: '$' + Number(product.price || 0).toFixed(2), inline: true },
        { name: 'Duration', value: product.duration || 'N/A', inline: true }
      )
      .setFooter({ text: 'Secure checkout via Stripe' });

    await interaction.followUp({ embeds: [payEmbed], ephemeral: true });
  } catch (e) {
    console.error('[Ticket] Purchase flow error:', e.message);
    try { await interaction.followUp({ content: '⏰ Session timed out. Try `/purchase` again.', ephemeral: true }); } catch (e2) { /* ignore */ }
  }
}

client.on('error', function (e) { console.error('[Ticket Bot] Client error:', e && e.message); });
client.on('shardError', function (e) { console.error('[Ticket Bot] Shard error:', e && e.message); });

client.login(config.tokens.ticket).catch(function (e) { console.error('[Ticket Bot] Login failed:', e.message); });

module.exports = client;