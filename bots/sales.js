// Sales Bot — Posts real-time purchases to #sales channel, tracks vouches
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const config = require('./config');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', () => {
  console.log(`[Sales Bot] Online as ${client.user.tag}`);
});

// Called by the web server when a purchase completes
async function postSale({ productName, game, price, currency, duration, email, orderId }) {
  try {
    const channel = await client.channels.fetch(config.channels.sales);
    if (!channel) return console.error('[Sales] Channel not found');

    const embed = new EmbedBuilder()
      .setColor('#3b82f6')
      .setTitle('🛒 New Purchase')
      .setDescription(`**${productName}** — ${game}`)
      .addFields(
        { name: 'Price', value: `${currency === 'EUR' ? '€' : '$'}${Number(price).toFixed(2)}`, inline: true },
        { name: 'Duration', value: duration || 'N/A', inline: true },
        { name: 'Order ID', value: `\`${orderId}\``, inline: true },
        { name: 'Customer', value: email || 'Guest', inline: true },
      )
      .setTimestamp()
      .setFooter({ text: 'Inertia Sales Bot' });

    await channel.send({ embeds: [embed] });
    console.log(`[Sales] Posted: ${productName} - ${price}`);
  } catch (e) {
    console.error('[Sales] Error posting:', e.message);
  }
}

// Listen for vouch messages in #vouches channel
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== config.channels.vouches) return;

  // Store vouch for website API
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const vouchesFile = path.join(__dirname, '..', 'data', 'vouches.json');

    let vouches = [];
    try { vouches = JSON.parse(fs.readFileSync(vouchesFile, 'utf8')); } catch { vouches = []; }

    vouches.push({
      id: message.id,
      author: message.author.username,
      authorId: message.author.id,
      avatar: message.author.displayAvatarURL({ size: 128 }),
      content: message.content,
      timestamp: message.createdTimestamp,
      attachments: message.attachments.map(a => a.url),
    });

    // Keep last 500 vouches
    if (vouches.length > 500) vouches = vouches.slice(-500);
    fs.writeFileSync(vouchesFile, JSON.stringify(vouches, null, 2));
  } catch (e) {
    console.error('[Vouches] Error saving:', e.message);
  }
});

// Expose for use by server.js
client.postSale = postSale;

client.on('error', function (e) { console.error('[Sales Bot] Client error:', e && e.message); });
client.on('shardError', function (e) { console.error('[Sales Bot] Shard error:', e && e.message); });

client.login(config.tokens.sales).catch(e => console.error('[Sales Bot] Login failed:', e.message));

module.exports = client;