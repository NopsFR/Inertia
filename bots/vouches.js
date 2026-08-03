// Vouches Bot — /vouch command for customer reviews with star ratings
var Discord = require('discord.js');
var config = require('./config');
var fs = require('node:fs');
var path = require('node:path');

var client = new Discord.Client({
  intents: [Discord.GatewayIntentBits.Guilds, Discord.GatewayIntentBits.GuildMessages, Discord.GatewayIntentBits.MessageContent],
});

client.once('ready', async function () {
  console.log('[Vouches Bot] Online as ' + client.user.tag);

  try {
    await client.application.commands.create({
      name: 'vouch',
      description: 'Leave a review with a star rating (1-5)',
      options: [
        { name: 'rating', description: 'Star rating 1-5', type: 4, required: true, min_value: 1, max_value: 5 },
        { name: 'review', description: 'Your review text', type: 3, required: true }
      ]
    });
    console.log('[Vouches] /vouch command registered');
  } catch (e) { console.warn('[Vouches] Command already exists:', e.message); }
});

client.on('interactionCreate', async function (interaction) {
  if (!interaction.isCommand()) return;
  if (interaction.commandName !== 'vouch') return;

  await interaction.deferReply({ ephemeral: true });

  try {
    // Check if rating and review were provided as slash command options
    var rating = interaction.options.getInteger('rating');
    var review = interaction.options.getString('review');

    if (rating && review) {
      // Direct submission via slash command options
      review = review.slice(0, 500);
      var stars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
      var colorMap = { 1: '#ef4444', 2: '#f97316', 3: '#eab308', 4: '#22c55e', 5: '#3b82f6' };
      var color = colorMap[rating] || '#3b82f6';

      var vouchesChannel = await client.channels.fetch(config.channels.vouches).catch(function () { return null; });
      if (!vouchesChannel) {
        return interaction.editReply({ content: '❌ Vouches channel not found.' });
      }

      var vouchEmbed = new Discord.EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL({ size: 128 }) })
        .setTitle(stars)
        .setDescription(review)
        .setTimestamp()
        .setFooter({ text: 'Inertia Verified Review' });

      await vouchesChannel.send({ embeds: [vouchEmbed] });

      // Save to vouches.json
      var vouchesFile = path.join(__dirname, '..', 'data', 'vouches.json');
      var vouches = [];
      try { vouches = JSON.parse(fs.readFileSync(vouchesFile, 'utf8')); } catch (e) { vouches = []; }
      vouches.push({ id: interaction.id, author: interaction.user.username, authorId: interaction.user.id, avatar: interaction.user.displayAvatarURL({ size: 128 }), content: review, rating: rating, stars: stars, timestamp: Date.now() });
      if (vouches.length > 500) vouches = vouches.slice(-500);
      fs.writeFileSync(vouchesFile, JSON.stringify(vouches, null, 2));

      var doneEmbed = new Discord.EmbedBuilder().setColor(color).setTitle('✅ Review Submitted!').setDescription('Thank you! Your review has been posted.').addFields({ name: 'Your Rating', value: stars, inline: true });
      return interaction.editReply({ embeds: [doneEmbed] });
    }

    // Fallback to interactive flow if no options provided
    var askEmbed = new Discord.EmbedBuilder()
      .setColor('#f59e0b')
      .setTitle('⭐ Leave a Vouch / Review')
      .setDescription('Please reply with your review text (max 500 characters).\n\nExample: "Been using Inertia for months, the products are undetected and support is amazing!"')
      .setFooter({ text: 'Type your review below' });

    await interaction.editReply({ embeds: [askEmbed] });

    // Wait for user's review text
    var filter = function (m) { return m.author.id === interaction.user.id && m.content.length > 5; };
    var collected = await interaction.channel.awaitMessages({ filter: filter, max: 1, time: 120000, errors: ['time'] });
    var review = collected.first().content.slice(0, 500);

    // Ask for star rating
    var starEmbed = new Discord.EmbedBuilder()
      .setColor('#f59e0b')
      .setTitle('⭐ Rate Your Experience')
      .setDescription('How many stars? Reply with a number **1-5**:\n\n⭐ = Poor\n⭐⭐ = Below Average\n⭐⭐⭐ = Good\n⭐⭐⭐⭐ = Very Good\n⭐⭐⭐⭐⭐ = Excellent')
      .setFooter({ text: 'Type 1-5' });

    await interaction.followUp({ embeds: [starEmbed], ephemeral: true });

    var starFilter = function (m) { return m.author.id === interaction.user.id && /^[1-5]$/.test(m.content.trim()); };
    var starCollected = await interaction.channel.awaitMessages({ filter: starFilter, max: 1, time: 60000, errors: ['time'] });
    var rating = parseInt(starCollected.first().content.trim());

    // Build stars
    var stars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);

    // Get color based on rating
    var colorMap = { 1: '#ef4444', 2: '#f97316', 3: '#eab308', 4: '#22c55e', 5: '#3b82f6' };
    var color = colorMap[rating] || '#3b82f6';

    // Post to vouches channel
    var vouchesChannel = await client.channels.fetch(config.channels.vouches).catch(function () { return null; });
    if (!vouchesChannel) {
      return interaction.followUp({ content: '❌ Vouches channel not found. Please contact an admin.', ephemeral: true });
    }

    var vouchEmbed = new Discord.EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL({ size: 128 }) })
      .setTitle(stars)
      .setDescription(review)
      .setTimestamp()
      .setFooter({ text: 'Inertia Verified Review' });

    await vouchesChannel.send({ embeds: [vouchEmbed] });

    // Save to vouches.json for website API
    var vouchesFile = path.join(__dirname, '..', 'data', 'vouches.json');
    var vouches = [];
    try { vouches = JSON.parse(fs.readFileSync(vouchesFile, 'utf8')); } catch (e) { vouches = []; }

    vouches.push({
      id: interaction.id,
      author: interaction.user.username,
      authorId: interaction.user.id,
      avatar: interaction.user.displayAvatarURL({ size: 128 }),
      content: review,
      rating: rating,
      stars: stars,
      timestamp: Date.now(),
    });

    if (vouches.length > 500) vouches = vouches.slice(-500);
    fs.writeFileSync(vouchesFile, JSON.stringify(vouches, null, 2));

    // Done
    var doneEmbed = new Discord.EmbedBuilder()
      .setColor(color)
      .setTitle('✅ Review Submitted!')
      .setDescription('Thank you for your vouch! It has been posted to the reviews channel.')
      .addFields({ name: 'Your Rating', value: stars, inline: true }, { name: 'Your Review', value: review.slice(0, 100) + (review.length > 100 ? '...' : ''), inline: true });

    await interaction.followUp({ embeds: [doneEmbed], ephemeral: true });

  } catch (e) {
    console.error('[Vouches] Error:', e.message);
    try { await interaction.followUp({ content: '⏰ Review submission timed out. Please try again with `/vouch`.', ephemeral: true }); } catch (e2) { /* ignore */ }
  }
});

client.on('error', function (e) { console.error('[Vouches Bot] Client error:', e && e.message); });
client.on('shardError', function (e) { console.error('[Vouches Bot] Shard error:', e && e.message); });

client.login(config.tokens.vouches).catch(function (e) { console.error('[Vouches Bot] Login failed:', e.message); });

module.exports = client;