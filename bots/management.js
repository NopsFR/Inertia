// Management Bot — Interactive Admin Control Center (embeds + buttons + modals)
const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const config = require('./config');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
});

let siteData = {};
const SITE_FILE = path.join(__dirname, '..', 'data', 'site.json');
const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');
const LOGS_FILE = path.join(__dirname, '..', 'data', 'logs.json');
const START_TIME = Date.now();

function loadSite() { try { siteData = JSON.parse(fs.readFileSync(SITE_FILE, 'utf8')); } catch { siteData = { products: [] }; } }
function loadLogs(n) { try { return JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8')).slice(-(n || 100)).reverse(); } catch { return []; } }
function loadUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; } }
function getUptime() { var s = Math.floor((Date.now() - START_TIME) / 1000); var d = Math.floor(s / 86400); s %= 86400; var h = Math.floor(s / 3600); s %= 3600; var m = Math.floor(s / 60); return d + 'd ' + h + 'h ' + m + 'm'; }

function hasPerm(member) {
  return member.roles.cache.has(config.roles.management) || member.roles.cache.has(config.roles.inertia) || member.permissions.has('Administrator');
}

// ── Dashboard Embed Builder ───────────────────────────────────────────
function buildDashboardEmbed() {
  var products = siteData.products || [];
  var users = loadUsers();
  var logs = loadLogs(50);
  var mem = process.memoryUsage();
  var totalRev = users.reduce(function (s, u) { return s + (u.totalSpent || 0); }, 0);
  var todayCount = logs.filter(function (l) { return l.type === 'purchase' && l.timestamp > Date.now() - 86400000; }).length;
  var activeUsers = users.filter(function (u) { return u.status === 'active'; }).length;
  var catCounts = {}; products.forEach(function (p) { var c = p.game || 'Universal'; catCounts[c] = (catCounts[c] || 0) + 1; });
  var dbStatus = '📁 File Store';
  try { var mongo = require('mongoose'); if (mongo.connection && mongo.connection.readyState === 1) dbStatus = '🍃 MongoDB Connected'; } catch (e) { /* not loaded */ }

  return new EmbedBuilder()
    .setColor('#3b82f6')
    .setTitle('⚡ Inertia Admin Control Center')
    .setDescription('Real-time system overview — ' + new Date().toLocaleTimeString())
    .addFields(
      {
        name: '💰 Financial Overview',
        value: '' +
          '`Total Revenue ` `$' + totalRev.toFixed(2).padStart(10) + '`\n' +
          '`Today Sales  ` `' + String(todayCount).padStart(10) + '`\n' +
          '`Active Users ` `' + String(activeUsers).padStart(10) + '`',
        inline: false
      },
      {
        name: '📦 Product Catalog',
        value: '' +
          '`Total    ` `' + String(products.length).padStart(10) + '`\n' +
          '`Universal` `' + String(catCounts.UNIVERSAL || 0).padStart(10) + '`\n' +
          '`CS2      ` `' + String(catCounts.CS2 || 0).padStart(10) + '`\n' +
          '`COD      ` `' + String(catCounts.COD || 0).padStart(10) + '`',
        inline: false
      },
      {
        name: '⚙️ System Health',
        value: '' +
          '`Memory    ` `' + (mem.rss / 1024 / 1024).toFixed(0).padStart(10) + ' MB`\n' +
          '`Uptime    ` `' + getUptime().padStart(14) + '`\n' +
          '`Database  ` `' + dbStatus.padStart(24) + '`\n' +
          '`Latency   ` `       ---ms`',
        inline: false
      },
      {
        name: '📝 Recent Audit Logs',
        value: logs.slice(0, 5).map(function (l) {
          return '`' + l.type.padEnd(8) + '` ' + l.action + ' — ' + new Date(l.timestamp).toLocaleTimeString();
        }).join('\n') || '`system  ` No activity recorded yet',
        inline: false
      }
    )
    .setTimestamp()
    .setFooter({ text: 'Inertia Management System • ' + users.length + ' users • ' + products.length + ' products' });
}

// ── Build interaction rows ────────────────────────────────────────────
function buildActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mgmt_products').setLabel('📦 Manage Products').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mgmt_userlookup').setLabel('👥 User Lookup').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mgmt_revenue').setLabel('💰 Revenue').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('mgmt_refresh').setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary),
  );
}

// ── Product management select menu ─────────────────────────────────────
function buildProductMenu(products) {
  var opts = products.slice(0, 25).map(function (p) {
    return { label: p.name + ' (' + (p.game || '??') + ')', description: '$' + Number(p.price || 0).toFixed(2) + ' ' + (p.stock || 'IN STOCK'), value: 'prod_' + p.id };
  });
  opts.push({ label: '➕ Add New Product', description: 'Trigger /addproduct', value: 'add_new_product', emoji: '➕' });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('mgmt_select_product').setPlaceholder('Select a product to manage...').addOptions(opts)
  );
}

// ── Events ─────────────────────────────────────────────────────────────
client.once('ready', async function () {
  console.log('[Management Bot] Online as ' + client.user.tag);
  loadSite();
  try {
    await client.application.commands.set([
      new SlashCommandBuilder().setName('dashboard').setDescription('Open the interactive admin control center'),
      new SlashCommandBuilder().setName('products').setDescription('List all products'),
      new SlashCommandBuilder().setName('logs').setDescription('View recent activity logs'),
      new SlashCommandBuilder().setName('addproduct').setDescription('Add a new product')
        .addStringOption(function (o) { return o.setName('name').setDescription('Product name').setRequired(true); })
        .addStringOption(function (o) { return o.setName('game').setDescription('Game (e.g. CS2, COD)').setRequired(true); })
        .addNumberOption(function (o) { return o.setName('price').setDescription('Base price in USD').setRequired(true); })
        .addStringOption(function (o) { return o.setName('duration').setDescription('Duration (e.g. 30 Days)').setRequired(false); })
        .addStringOption(function (o) { return o.setName('description').setDescription('Short description').setRequired(false); }),
    ]);
    console.log('[Management] Commands registered');
  } catch (e) { console.warn('[Management] Commands:', e.message); }
});

client.on('interactionCreate', async function (interaction) {
  // ── Slash Commands ────────────────────────────────────────────────
  if (interaction.isCommand()) {
    try { await interaction.deferReply({ ephemeral: false }); } catch (e) { return; }
    try {
      loadSite();
      switch (interaction.commandName) {
        case 'dashboard': {
          var ping = Date.now() - interaction.createdTimestamp;
          var embed = buildDashboardEmbed();
          embed.setFields(embed.data.fields.map(function (f) {
    if (f.name === '⚙️ System Health') {
      f.value = f.value.replace('---ms', ping + 'ms');
    }
            return f;
          }));
          await interaction.editReply({ embeds: [embed], components: [buildActionRow()] });
          break;
        }
        case 'products': {
          var list = (siteData.products || []).map(function (p) { return '**' + p.name + '** — `$' + Number(p.price||0).toFixed(2) + '` (' + (p.game||'??') + ') `' + (p.stock||'IN STOCK') + '`'; }).join('\n');
          await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#3b82f6').setTitle('📦 Products').setDescription(list || 'None').setFooter({ text: (siteData.products||[]).length + ' products' })] });
          break;
        }
        case 'logs': {
          var logs = loadLogs(20);
          await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#3b82f6').setTitle('📝 Logs').setDescription(logs.map(function (l) { return '`[' + l.type + ']` ' + l.action + ' — ' + l.user + ' — ' + new Date(l.timestamp).toLocaleString(); }).join('\n') || 'No logs')] });
          break;
        }
        case 'addproduct': {
          if (!hasPerm(interaction.member)) return interaction.editReply({ content: '❌ Permission denied.' });
          var name = interaction.options.getString('name');
          var game = interaction.options.getString('game');
          var price = interaction.options.getNumber('price');
          var duration = interaction.options.getString('duration') || '';
          var desc = interaction.options.getString('description') || '';
          if (!siteData.products) siteData.products = [];
          var newId = Date.now();
          siteData.products.push({ id: newId, name: name, game: game, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), price: price, currency: 'USD', stock: 'IN STOCK', rating: 5, reviews: 0, description: desc, duration: duration, category: game, features: [], options: [], image: '', video: '' });
          fs.writeFileSync(SITE_FILE, JSON.stringify(siteData, null, 2));
          await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#22c55e').setTitle('✅ Product Added').setDescription('**' + name + '** (' + game + ') — $' + price.toFixed(2) + (duration ? ' • ' + duration : '')).setTimestamp()] });
          break;
        }
        default: await interaction.editReply({ content: '❌ Unknown command.' }); break;
      }
    } catch (e) {
      console.error('[Management] Error:', e.message);
      try { await interaction.editReply({ content: '❌ An error occurred.' }); } catch (e2) { /* ignore */ }
    }
    return;
  }

  // ── Buttons ──────────────────────────────────────────────────────
  if (interaction.isButton()) {
    if (!hasPerm(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use management controls.', ephemeral: true });

    if (interaction.customId === 'mgmt_refresh') {
      try { await interaction.deferUpdate(); } catch (e) { return; }
      loadSite();
      var embed = buildDashboardEmbed();
      var ping = Date.now() - interaction.createdTimestamp;
      embed.setFields(embed.data.fields.map(function (f) {
        if (f.name === '⚙️ System Health') { f.value = f.value.replace('---ms', ping + 'ms'); }
        return f;
      }));
      await interaction.editReply({ embeds: [embed], components: [buildActionRow()] });
      return;
    }

    if (interaction.customId === 'mgmt_products') {
      loadSite();
      var products = siteData.products || [];
      if (!products.length) return interaction.reply({ content: '❌ No products in catalog.', ephemeral: true });
      await interaction.reply({ embeds: [new EmbedBuilder().setColor('#3b82f6').setTitle('📦 Manage Products').setDescription('Select a product below or add a new one.')], components: [buildProductMenu(products)], ephemeral: true });
      return;
    }

    if (interaction.customId === 'mgmt_userlookup') {
      var modal = new ModalBuilder().setCustomId('mgmt_modal_lookup').setTitle('👥 User Lookup');
      var input = new TextInputBuilder().setCustomId('discord_user_id').setLabel('Enter Discord User ID').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 123456789012345678');
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId === 'mgmt_revenue') {
      await interaction.deferReply({ ephemeral: true });
      loadSite();
      var users = loadUsers();
      var total = users.reduce(function (s, u) { return s + (u.totalSpent || 0); }, 0);
      var today = loadLogs(500).filter(function (l) { return l.type === 'purchase' && l.timestamp > Date.now() - 86400000; });
      var todayRev = today.reduce(function (s, l) { return s + Number((l.details && l.details.price) || 0); }, 0);
      var categories = {}; (siteData.products || []).forEach(function (p) { var c = p.game || 'Other'; categories[c] = (categories[c] || 0) + 1; });
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#22c55e').setTitle('💰 Revenue Report').setDescription('Total Revenue: **$' + total.toFixed(2) + '**\nToday: **$' + todayRev.toFixed(2) + '** (' + today.length + ' sales)\n\n**Catalog Breakdown:**\n' + Object.keys(categories).map(function (c) { return '• ' + c + ': ' + categories[c] + ' products'; }).join('\n')).setTimestamp()] });
      return;
    }

    return interaction.reply({ content: '❌ Unknown action.', ephemeral: true });
  }

  // ── StringSelectMenu — Product Management ────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'mgmt_select_product') {
    if (!hasPerm(interaction.member)) return interaction.reply({ content: '❌ Permission denied.', ephemeral: true });
    var val = interaction.values[0];
    if (val === 'add_new_product') {
      return interaction.reply({ content: 'Use **`/addproduct`** to add a new product.', ephemeral: true });
    }
    var pid = parseInt(val.replace('prod_', ''));
    loadSite();
    var p = (siteData.products || []).find(function (x) { return x.id === pid; });
    if (!p) return interaction.reply({ content: '❌ Product not found.', ephemeral: true });

    var embed = new EmbedBuilder().setColor('#3b82f6').setTitle('📦 ' + p.name)
      .setDescription('**Game:** ' + (p.game || 'N/A') + '\n**Price:** $' + Number(p.price||0).toFixed(2) + '\n**Stock:** ' + (p.stock||'IN STOCK') + '\n**Duration:** ' + (p.duration||'N/A') + '\n**Description:** ' + (p.description||'None'))
      .setFooter({ text: 'ID: ' + p.id + ' • Slug: ' + (p.slug||'none') });

    var toggleLabel = p.stock === 'OUT OF STOCK' ? '🟢 Set In Stock' : '🔴 Set Out of Stock';
    var row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mgmt_toggle_' + p.id).setLabel(toggleLabel).setStyle(p.stock === 'OUT OF STOCK' ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('mgmt_delete_' + p.id).setLabel('🗑️ Delete').setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    return;
  }

  // ── Product toggle/delete buttons ────────────────────────────────
  if (interaction.isButton() && (interaction.customId.startsWith('mgmt_toggle_') || interaction.customId.startsWith('mgmt_delete_'))) {
    if (!hasPerm(interaction.member)) return interaction.reply({ content: '❌ Permission denied.', ephemeral: true });
    await interaction.deferUpdate();
    var pid = parseInt(interaction.customId.split('_').pop());
    loadSite();
    var idx = (siteData.products || []).findIndex(function (x) { return x.id === pid; });
    if (idx === -1) return interaction.editReply({ content: '❌ Product not found.', components: [] });

    if (interaction.customId.startsWith('mgmt_toggle_')) {
      siteData.products[idx].stock = siteData.products[idx].stock === 'OUT OF STOCK' ? 'IN STOCK' : 'OUT OF STOCK';
      fs.writeFileSync(SITE_FILE, JSON.stringify(siteData, null, 2));
      await interaction.editReply({ content: '✅ ' + siteData.products[idx].name + ' is now **' + siteData.products[idx].stock + '**', embeds: [], components: [] });
    } else if (interaction.customId.startsWith('mgmt_delete_')) {
      var name = siteData.products[idx].name;
      siteData.products.splice(idx, 1);
      fs.writeFileSync(SITE_FILE, JSON.stringify(siteData, null, 2));
      await interaction.editReply({ content: '🗑️ **' + name + '** has been deleted.', embeds: [], components: [] });
    }
    return;
  }

  // ── Modal — User Lookup ──────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'mgmt_modal_lookup') {
    if (!hasPerm(interaction.member)) return interaction.reply({ content: '❌ Permission denied.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    var discordId = interaction.fields.getTextInputValue('discord_user_id');
    try {
      var member = await interaction.guild.members.fetch(discordId);
      var users = loadUsers();
      var user = users.find(function (u) { return u.email && member.user.username && u.name === member.user.username; }) || null;
      var roles = member.roles.cache.map(function (r) { return r.name; }).join(', ');
      var hasCustomer = member.roles.cache.has(config.roles.customer);

      var embed = new EmbedBuilder().setColor('#3b82f6').setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() }).setDescription('**Roles:** ' + (roles || 'None')).addFields({ name: 'Data from server', value: '**Customer Role:** ' + (hasCustomer ? '✅ Yes' : '❌ No') + '\n**Purchases:** ' + ((user && user.purchaseCount) || 0) + '\n**Total Spent:** $' + ((user && user.totalSpent) || 0).toFixed(2) }).setFooter({ text: 'ID: ' + discordId }).setTimestamp();

      var toggleRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mgmt_togglerole_' + discordId + '_customer').setLabel(hasCustomer ? '❌ Remove Customer' : '✅ Grant Customer').setStyle(hasCustomer ? ButtonStyle.Danger : ButtonStyle.Success)
      );
      await interaction.editReply({ embeds: [embed], components: [toggleRow] });
    } catch (e) {
      await interaction.editReply({ content: '❌ User not found in this server.' });
    }
    return;
  }

  // ── Role toggle from lookup ──────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('mgmt_togglerole_')) {
    if (!hasPerm(interaction.member)) return interaction.reply({ content: '❌ Permission denied.', ephemeral: true });
    await interaction.deferUpdate();
    var parts = interaction.customId.split('_');
    var uid = parts[2];
    try {
      var member = await interaction.guild.members.fetch(uid);
      var hasRole = member.roles.cache.has(config.roles.customer);
      if (hasRole) { await member.roles.remove(config.roles.customer); }
      else { await member.roles.add(config.roles.customer); }
      var newLabel = !hasRole ? '❌ Remove Customer' : '✅ Grant Customer';
      var newStyle = !hasRole ? ButtonStyle.Danger : ButtonStyle.Success;
      var row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mgmt_togglerole_' + uid + '_customer').setLabel(newLabel).setStyle(newStyle)
      );
      await interaction.editReply({ components: [row] });
      await interaction.followUp({ content: '✅ Customer role ' + (!hasRole ? 'granted' : 'removed') + ' for <@' + uid + '>', ephemeral: true });
    } catch (e) {
      await interaction.followUp({ content: '❌ Failed to modify role.', ephemeral: true });
    }
    return;
  }
});

client.on('error', function (e) { console.error('[Management Bot] Client error:', e && e.message); });
client.on('shardError', function (e) { console.error('[Management Bot] Shard error:', e && e.message); });

client.login(config.tokens.management).catch(function (e) { console.error('[Management Bot] Login failed:', e.message); });

module.exports = client;