// Authing Bot — Discord OAuth role assignment + /link command + verification embed
var Discord = require('discord.js');
var config = require('./config');
var fs = require('node:fs');
var path = require('node:path');

var client = new Discord.Client({
  intents: [Discord.GatewayIntentBits.Guilds, Discord.GatewayIntentBits.GuildMembers],
});

var LINK_CHANNEL_ID = '1532909735110774844';
var EMBED_FLAG_FILE = path.join(__dirname, '..', 'data', '.auth_embed_posted');

client.once('ready', async function () {
  console.log('[Authing Bot] Online as ' + client.user.tag);

  // Register /link command
  try {
    await client.application.commands.create({
      name: 'link',
      description: 'Link your Discord account to the Inertia website'
    });
    console.log('[Authing] /link command registered');
  } catch (e) { console.warn('[Authing] /link already exists:', e.message); }

  // Post verification embed once in the link channel
  if (fs.existsSync(EMBED_FLAG_FILE)) {
    console.log('[Authing] Verification embed already posted, skipping.');
    return;
  }

  try {
    var ch = await client.channels.fetch(LINK_CHANNEL_ID);
    if (!ch) { console.warn('[Authing] Link channel ' + LINK_CHANNEL_ID + ' not found'); return; }

    // Clear old messages and post fresh embed
    try {
      var messages = await ch.messages.fetch({ limit: 5 });
      var botMessages = messages.filter(function (m) { return m.author.id === client.user.id; });
      if (botMessages.size > 0) botMessages.forEach(function (m) { m.delete().catch(function () {}); });
    } catch (e) { /* channel may not allow bulk delete */ }

    var origin = (process.env.PUBLIC_URL || 'http://localhost:' + (process.env.PORT || 3000)).replace(/\/+$/, '');
    var linkUrl = 'https://discord.com/oauth2/authorize?client_id=' + process.env.DISCORD_CLIENT_ID + '&redirect_uri=' + encodeURIComponent(origin + '/api/auth/discord/callback') + '&response_type=code&scope=' + encodeURIComponent('identify email guilds guilds.members.read');

    var embed = new Discord.EmbedBuilder()
      .setColor('#3b82f6')
      .setTitle('🔗 Link Your Discord to Inertia')
      .setDescription('Connect your Discord account to the Inertia website to access your purchases, dashboard, and exclusive features.\n\n**How to link:**\n1️⃣ Click the button below\n2️⃣ Authorize the Inertia app\n3️⃣ You\'ll be redirected back — and logged in!\n\n**Use `/link`** in this channel if you need a fresh link.')
      .addFields(
        { name: '🎮 Game Access', value: 'Access your product keys and downloads', inline: true },
        { name: '📊 Dashboard', value: 'View purchase history & stats', inline: true },
        { name: '⭐ Customer Role', value: 'Unlock exclusive Discord channels', inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Inertia Account Linking System' });

    var row = new Discord.ActionRowBuilder().addComponents(
      new Discord.ButtonBuilder()
        .setLabel('🔗 Link Account')
        .setURL(linkUrl)
        .setStyle(Discord.ButtonStyle.Link)
    );

    await ch.send({ embeds: [embed], components: [row] });
    try { fs.writeFileSync(EMBED_FLAG_FILE, Date.now().toString()); } catch (e) { /* ignore */ }
    console.log('[Authing] Verification embed posted (one-time)');
  } catch (e) {
    console.warn('[Authing] Could not post verification embed:', e.message);
  }
});

// Handle /link slash command
client.on('interactionCreate', async function (interaction) {
  if (!interaction.isCommand()) return;
  if (interaction.commandName !== 'link') return;

  await interaction.deferReply({ ephemeral: true });

  var origin = 'http://localhost:' + (process.env.PORT || 3000);
  var linkUrl = 'https://discord.com/oauth2/authorize?client_id=' + process.env.DISCORD_CLIENT_ID + '&redirect_uri=' + encodeURIComponent(origin + '/api/auth/discord/callback') + '&response_type=code&scope=' + encodeURIComponent('identify email guilds guilds.members.read');

  var embed = new Discord.EmbedBuilder()
    .setColor('#3b82f6')
    .setTitle('🔗 Link Your Account')
    .setDescription('[Click here to link your Discord account to Inertia](' + linkUrl + ')\n\nAfter linking, you\'ll be able to access your purchases and dashboard.');

  var row = new Discord.ActionRowBuilder().addComponents(
    new Discord.ButtonBuilder().setLabel('🔗 Link Account').setURL(linkUrl).setStyle(Discord.ButtonStyle.Link)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
});

// Called by server.js when a user logs in
async function assignMemberRole(discordUserId) {
  try {
    var guild = client.guilds.cache.get(config.guildId);
    if (!guild) return console.error('[Authing] Guild not found');
    var member = await guild.members.fetch(discordUserId).catch(function () { return null; });
    if (!member) return console.warn('[Authing] User ' + discordUserId + ' not in server');
    await member.roles.add(config.roles.member);
    console.log('[Authing] Member role assigned to ' + member.user.tag);
  } catch (e) {
    console.error('[Authing] Role assignment error:', e.message);
  }
}

async function assignCustomerRole(discordUserId) {
  try {
    var guild = client.guilds.cache.get(config.guildId);
    if (!guild) return console.error('[Authing] Guild not found');
    var member = await guild.members.fetch(discordUserId).catch(function () { return null; });
    if (!member) return console.warn('[Authing] User ' + discordUserId + ' not in server');
    await member.roles.add([config.roles.customer, config.roles.member]);
    console.log('[Authing] Customer role assigned to ' + member.user.tag);
    try {
      await member.send({ embeds: [new Discord.EmbedBuilder().setColor('#22c55e').setTitle('🎉 Welcome to Inertia!').setDescription('Thank you for your purchase! You now have the **Customer** role and access to exclusive channels.')] });
    } catch (e) { /* DMs closed */ }
  } catch (e) {
    console.error('[Authing] Customer role error:', e.message);
  }
}

client.assignMemberRole = assignMemberRole;
client.assignCustomerRole = assignCustomerRole;

client.on('error', function (e) { console.error('[Authing Bot] Client error:', e && e.message); });
client.on('shardError', function (e) { console.error('[Authing Bot] Shard error:', e && e.message); });

client.login(config.tokens.authing).catch(function (e) { console.error('[Authing Bot] Login failed:', e.message); });

module.exports = client;