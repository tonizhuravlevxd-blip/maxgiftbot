require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const axios = require('axios');
const dayjs = require('dayjs');

const app = express();
app.use(bodyParser.json());

// DATABASE_URL берётся из Render Internal Database (или External, если локально)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render Internal требует SSL
});

// Проверка подключения
pool.query('SELECT NOW()')
  .then(res => console.log('✅ Connected to PostgreSQL via DATABASE_URL, time:', res.rows[0]))
  .catch(err => console.error('❌ DB connection error:', err));

const PORT = process.env.PORT || 3000;
const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN;
const MAX_API_BASE = process.env.MAX_API_BASE || 'https://api.max.ru';
const GENERAL_CHANNEL_ID = process.env.GENERAL_CHANNEL_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'secret';

function buildApiUrl(method) {
  return `${MAX_API_BASE}/bot${MAX_BOT_TOKEN}/${method}`;
}

// =========================
// Универсальный вызов MAX API
// =========================
async function maxApi(method, payload = {}) {
  try {
    const response = await axios.post(buildApiUrl(method), payload, {
      timeout: 15000
    });
    return response.data;
  } catch (error) {
    console.error(`MAX API error in ${method}:`, error.response?.data || error.message);
    throw error;
  }
}

// =========================
// Сообщения
// =========================
async function sendMessage(chatId, text, inlineKeyboard = null) {
  const payload = {
    chat_id: chatId,
    text
  };

  if (inlineKeyboard) {
    payload.reply_markup = {
      inline_keyboard: inlineKeyboard
    };
  }

  // TODO MAX API:
  // если в MAX у sendMessage другой формат — поменяешь здесь один раз
  return await maxApi('sendMessage', payload);
}

async function sendMainMenu(chatId) {
  return sendMessage(
    chatId,
    'Выберите действие:',
    [
      [{ text: '🎉 Создать розыгрыш', callback_data: 'create_raffle' }],
      [{ text: '🔎 Мои розыгрыши', callback_data: 'my_raffles' }],
      [{ text: '🎁 Участвовать в розыгрыше', callback_data: 'join_latest' }],
      [{ text: '📊 Статистика', callback_data: 'stats_global' }]
    ]
  );
}

// =========================
// Работа с БД
// =========================
async function ensureUser(from) {
  const userId = from.id;
  const username = from.username || null;
  const firstName = from.first_name || null;
  const lastName = from.last_name || null;

  await pool.query(`
    INSERT INTO users (max_user_id, username, first_name, last_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (max_user_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name
  `, [userId, username, firstName, lastName]);
}

async function getSession(userId) {
  const res = await pool.query(`SELECT * FROM user_sessions WHERE user_id = $1`, [userId]);
  return res.rows[0] || null;
}

async function setSession(userId, state, data = {}) {
  await pool.query(`
    INSERT INTO user_sessions (user_id, state, data, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
      state = EXCLUDED.state,
      data = EXCLUDED.data,
      updated_at = NOW()
  `, [userId, state, JSON.stringify(data)]);
}

async function clearSession(userId) {
  await pool.query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
}

async function createRaffleDraft(creatorId) {
  const res = await pool.query(`
    INSERT INTO raffles (creator_user_id, title, end_at, status)
    VALUES ($1, 'Без названия', NOW() + INTERVAL '1 day', 'draft')
    RETURNING *
  `, [creatorId]);
  return res.rows[0];
}

async function updateRaffle(raffleId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;

  const sets = [];
  const values = [];
  let i = 1;

  for (const key of keys) {
    sets.push(`${key} = $${i}`);
    values.push(fields[key]);
    i++;
  }

  sets.push(`updated_at = NOW()`);
  values.push(raffleId);

  await pool.query(`
    UPDATE raffles
    SET ${sets.join(', ')}
    WHERE id = $${i}
  `, values);
}

async function getRaffleById(raffleId) {
  const res = await pool.query(`SELECT * FROM raffles WHERE id = $1`, [raffleId]);
  return res.rows[0] || null;
}

async function getUserRaffles(userId) {
  const res = await pool.query(`
    SELECT * FROM raffles
    WHERE creator_user_id = $1
    ORDER BY id DESC
    LIMIT 20
  `, [userId]);
  return res.rows;
}

async function addRaffleChannel(raffleId, channelId, channelTitle, isRequired = true, publishPost = true) {
  await pool.query(`
    INSERT INTO raffle_channels (raffle_id, channel_id, channel_title, is_required, publish_post)
    VALUES ($1, $2, $3, $4, $5)
  `, [raffleId, channelId, channelTitle, isRequired, publishPost]);
}

async function getRaffleChannels(raffleId) {
  const res = await pool.query(`
    SELECT * FROM raffle_channels WHERE raffle_id = $1 ORDER BY id ASC
  `, [raffleId]);
  return res.rows;
}

async function addQueue(raffleId, queueType, scheduledAt, payload = {}) {
  await pool.query(`
    INSERT INTO raffle_queue (raffle_id, queue_type, scheduled_at, payload)
    VALUES ($1, $2, $3, $4)
  `, [raffleId, queueType, scheduledAt, JSON.stringify(payload)]);
}

async function createParticipantEntry(raffleId, userId, invitedBy = null) {
  const already = await pool.query(`
    SELECT * FROM raffle_user_entry WHERE raffle_id = $1 AND user_id = $2
  `, [raffleId, userId]);

  if (already.rows.length) {
    return { alreadyJoined: true };
  }

  await pool.query(`
    INSERT INTO raffle_user_entry (raffle_id, user_id)
    VALUES ($1, $2)
  `, [raffleId, userId]);

  const ticketNumber = Date.now() + Math.floor(Math.random() * 10000);

  await pool.query(`
    INSERT INTO raffle_participants (raffle_id, user_id, ticket_number, invited_by, is_valid)
    VALUES ($1, $2, $3, $4, true)
  `, [raffleId, userId, ticketNumber, invitedBy]);

  if (invitedBy && Number(invitedBy) !== Number(userId)) {
    const bonusTicket = Date.now() + Math.floor(Math.random() * 10000) + 10000000;
    await pool.query(`
      INSERT INTO raffle_participants (raffle_id, user_id, ticket_number, invited_by, is_valid)
      VALUES ($1, $2, $3, $4, true)
    `, [raffleId, invitedBy, bonusTicket, userId]);
  }

  return { alreadyJoined: false, ticketNumber };
}

async function getValidParticipants(raffleId) {
  const res = await pool.query(`
    SELECT * FROM raffle_participants
    WHERE raffle_id = $1 AND is_valid = true
  `, [raffleId]);
  return res.rows;
}

async function saveWinners(raffleId, winners, prizes) {
  for (let i = 0; i < winners.length; i++) {
    const prizeText = prizes[i] || `Приз ${i + 1}`;
    await pool.query(`
      INSERT INTO raffle_winners (raffle_id, user_id, ticket_number, prize_text)
      VALUES ($1, $2, $3, $4)
    `, [raffleId, winners[i].user_id, winners[i].ticket_number, prizeText]);
  }
}

async function getGlobalStats() {
  const users = await pool.query(`SELECT COUNT(*)::int AS count FROM users`);
  const raffles = await pool.query(`SELECT COUNT(*)::int AS count FROM raffles`);
  const participants = await pool.query(`SELECT COUNT(*)::int AS count FROM raffle_participants`);

  return {
    users: users.rows[0].count,
    raffles: raffles.rows[0].count,
    participants: participants.rows[0].count
  };
}

// =========================
// Проверка подписки
// =========================
async function checkUserSubscribedToChannel(userId, channelId) {
  // TODO MAX API:
  // Здесь нужно использовать реальный метод MAX для проверки участия пользователя в чате/канале.
  // Ниже логика-заглушка через условный getChatMember.

  try {
    const data = await maxApi('getChatMember', {
      chat_id: channelId,
      user_id: userId
    });

    const status = data?.result?.status || data?.status;
    return ['member', 'administrator', 'creator', 'owner'].includes(status);
  } catch (e) {
    console.error('checkUserSubscribedToChannel error:', e.message);
    return false;
  }
}

async function checkUserAllSubscriptions(raffleId, userId) {
  const channels = await getRaffleChannels(raffleId);
  if (!channels.length) return { ok: true, missing: [] };

  const missing = [];

  for (const ch of channels) {
    if (!ch.is_required) continue;
    const subscribed = await checkUserSubscribedToChannel(userId, ch.channel_id);
    if (!subscribed) {
      missing.push(ch);
    }
  }

  return {
    ok: missing.length === 0,
    missing
  };
}

// =========================
// Формирование поста
// =========================
function buildRaffleText(raffle, participantsCount = 0) {
  const prizes = raffle.prizes
    ? raffle.prizes.split('\n').filter(Boolean).map((p, i) => `${i + 1}. ${p}`).join('\n')
    : '1. Приз';

  return [
    `🎉 ${raffle.title}`,
    ``,
    raffle.description || '',
    ``,
    `🎁 Призы:`,
    prizes,
    ``,
    `👥 Участников: ${participantsCount}`,
    `🏆 Призовых мест: ${raffle.prize_count || 1}`,
    `⏰ Окончание: ${dayjs(raffle.end_at).format('DD.MM.YYYY HH:mm')}`,
    ``,
    `Для участия нажмите: "🎁 Участвовать в розыгрыше"`
  ].join('\n');
}

// =========================
// Публикация в канал
// =========================
async function publishRaffleToChannel(raffle, channelId) {
  const countRes = await pool.query(`
    SELECT COUNT(DISTINCT user_id)::int AS count
    FROM raffle_user_entry
    WHERE raffle_id = $1
  `, [raffle.id]);

  const participantsCount = countRes.rows[0].count || 0;
  const text = buildRaffleText(raffle, participantsCount);

  // TODO MAX API:
  // если у MAX другой метод публикации в канал, меняется здесь
  const data = await maxApi('sendMessage', {
    chat_id: channelId,
    text
  });

  const messageId = data?.result?.message_id || data?.message_id || null;

  await pool.query(`
    INSERT INTO raffle_posts (raffle_id, channel_id, message_id)
    VALUES ($1, $2, $3)
  `, [raffle.id, channelId, messageId]);

  return data;
}

// =========================
// Запуск розыгрыша
// =========================
async function activateRaffle(raffleId) {
  const raffle = await getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'scheduled') return;

  const channels = await getRaffleChannels(raffle.id);

  for (const ch of channels) {
    if (ch.publish_post) {
      try {
        await publishRaffleToChannel(raffle, ch.channel_id);
      } catch (e) {
        console.error(`Ошибка публикации в канал ${ch.channel_id}:`, e.message);
      }
    }
  }

  if (raffle.publish_in_general && GENERAL_CHANNEL_ID) {
    try {
      await publishRaffleToChannel(raffle, GENERAL_CHANNEL_ID);
    } catch (e) {
      console.error('Ошибка публикации в общий канал:', e.message);
    }
  }

  await updateRaffle(raffle.id, { status: 'active' });
  await sendMessage(
    raffle.creator_user_id,
    `✅ Розыгрыш #${raffle.id} запущен.\nНазвание: ${raffle.title}`
  );
}

async function finishRaffle(raffleId) {
  const raffle = await getRaffleById(raffleId);
  if (!raffle || !['active', 'scheduled'].includes(raffle.status)) return;

  const prizes = raffle.prizes
    ? raffle.prizes.split('\n').filter(Boolean)
    : ['Главный приз'];

  const neededCount = raffle.prize_count || prizes.length || 1;

  const participants = await getValidParticipants(raffle.id);

  if (!participants.length) {
    await updateRaffle(raffle.id, { status: 'finished' });
    await sendMessage(
      raffle.creator_user_id,
      `⚠️ Розыгрыш #${raffle.id} завершён, но участников не было.`
    );
    return;
  }

  const shuffled = [...participants].sort(() => Math.random() - 0.5);

  const uniqueByUser = [];
  const usedUsers = new Set();

  for (const p of shuffled) {
    if (!usedUsers.has(p.user_id)) {
      uniqueByUser.push(p);
      usedUsers.add(p.user_id);
    }
    if (uniqueByUser.length >= neededCount) break;
  }

  await saveWinners(raffle.id, uniqueByUser, prizes);
  await updateRaffle(raffle.id, { status: 'finished' });

  let winnersText = `🥳 Итоги розыгрыша #${raffle.id} "${raffle.title}"\n\n`;

  for (let i = 0; i < uniqueByUser.length; i++) {
    const w = uniqueByUser[i];
    const prize = prizes[i] || `Приз ${i + 1}`;
    winnersText += `${i + 1}. Пользователь ${w.user_id} — ${prize}\n`;

    await sendMessage(
      w.user_id,
      `🎉 Поздравляем!\nВы выиграли в розыгрыше "${raffle.title}"\nВаш приз: ${prize}`
    );
  }

  await sendMessage(raffle.creator_user_id, winnersText);
}

// =========================
// Очередь задач
// =========================
async function processQueue() {
  const res = await pool.query(`
    SELECT * FROM raffle_queue
    WHERE status = 'pending'
      AND scheduled_at <= NOW()
    ORDER BY scheduled_at ASC
    LIMIT 20
  `);

  for (const item of res.rows) {
    try {
      if (item.queue_type === 'general_publish') {
        const raffle = await getRaffleById(item.raffle_id);
        if (raffle && raffle.publish_in_general) {
          await publishRaffleToChannel(raffle, GENERAL_CHANNEL_ID);
        }
      }

      if (item.queue_type === 'raffle_start') {
        await activateRaffle(item.raffle_id);
      }

      if (item.queue_type === 'raffle_finish') {
        await finishRaffle(item.raffle_id);
      }

      await pool.query(`
        UPDATE raffle_queue
        SET status = 'done'
        WHERE id = $1
      `, [item.id]);
    } catch (e) {
      console.error('Queue error:', e.message);

      await pool.query(`
        UPDATE raffle_queue
        SET status = 'failed'
        WHERE id = $1
      `, [item.id]);
    }
  }
}

// =========================
// Статистика
// =========================
async function sendRaffleStats(chatId, raffleId) {
  const raffle = await getRaffleById(raffleId);
  if (!raffle) {
    return sendMessage(chatId, 'Розыгрыш не найден.');
  }

  const totalUsers = await pool.query(`
    SELECT COUNT(DISTINCT user_id)::int AS count
    FROM raffle_user_entry
    WHERE raffle_id = $1
  `, [raffleId]);

  const totalTickets = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM raffle_participants
    WHERE raffle_id = $1 AND is_valid = true
  `, [raffleId]);

  const perChannels = await getRaffleChannels(raffleId);

  let text = `📊 Статистика розыгрыша #${raffle.id}\n`;
  text += `Название: ${raffle.title}\n`;
  text += `Статус: ${raffle.status}\n`;
  text += `Участников: ${totalUsers.rows[0].count}\n`;
  text += `Билетов: ${totalTickets.rows[0].count}\n\n`;
  text += `Каналы:\n`;

  for (const ch of perChannels) {
    text += `- ${ch.channel_title || ch.channel_id}\n`;
  }

  await sendMessage(chatId, text);
}

// =========================
// Обработка шагов создания
// =========================
async function handleSessionMessage(message) {
  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text || '';
  const session = await getSession(userId);

  if (!session) return false;

  const state = session.state;
  const data = session.data || {};

  if (state === 'await_title') {
    data.title = text.trim();
    await setSession(userId, 'await_description', data);
    await sendMessage(chatId, 'Введите описание розыгрыша:');
    return true;
  }

  if (state === 'await_description') {
    data.description = text.trim();
    await setSession(userId, 'await_prizes', data);
    await sendMessage(chatId, 'Введите список призов, каждый с новой строки:');
    return true;
  }

  if (state === 'await_prizes') {
    const prizes = text.trim();
    data.prizes = prizes;
    data.prize_count = prizes.split('\n').filter(Boolean).length || 1;
    await setSession(userId, 'await_end_date', data);
    await sendMessage(chatId, 'Введите дату окончания в формате: 2026-06-10 20:00');
    return true;
  }

  if (state === 'await_end_date') {
    const parsed = dayjs(text.trim());
    if (!parsed.isValid()) {
      await sendMessage(chatId, 'Неверный формат даты. Пример: 2026-06-10 20:00');
      return true;
    }

    data.end_at = parsed.toISOString();
    await setSession(userId, 'await_channels', data);
    await sendMessage(
      chatId,
      'Введите ID обязательных каналов через запятую.\nПример:\n123456789,987654321'
    );
    return true;
  }

  if (state === 'await_channels') {
    const channelIds = text
      .split(',')
      .map(x => x.trim())
      .filter(Boolean);

    data.channels = channelIds;
    await setSession(userId, 'await_publish_general', data);
    await sendMessage(chatId, 'Публиковать в общем канале? Напишите: да или нет');
    return true;
  }

  if (state === 'await_publish_general') {
    const publishGeneral = ['да', 'yes', 'y', '1'].includes(text.trim().toLowerCase());
    data.publish_in_general = publishGeneral;

    const raffle = await createRaffleDraft(userId);

    await updateRaffle(raffle.id, {
      title: data.title,
      description: data.description,
      prizes: data.prizes,
      prize_count: data.prize_count,
      end_at: data.end_at,
      publish_in_general: publishGeneral,
      status: 'scheduled'
    });

    for (const chId of data.channels || []) {
      await addRaffleChannel(raffle.id, chId, `Канал ${chId}`, true, true);
    }

    await addQueue(raffle.id, 'raffle_start', new Date());
    await addQueue(raffle.id, 'raffle_finish', new Date(data.end_at));

    if (publishGeneral) {
      const when = new Date(Date.now() + 60 * 1000);
      await addQueue(raffle.id, 'general_publish', when);
    }

    await clearSession(userId);

    await sendMessage(
      chatId,
      `✅ Розыгрыш создан!\nID: ${raffle.id}\nНазвание: ${data.title}\nОкончание: ${dayjs(data.end_at).format('DD.MM.YYYY HH:mm')}`
    );
    return true;
  }

  return false;
}

// =========================
// Участие в розыгрыше
// =========================
async function joinLatestRaffle(chatId, userId) {
  const res = await pool.query(`
    SELECT * FROM raffles
    WHERE status IN ('scheduled', 'active')
    ORDER BY id DESC
    LIMIT 1
  `);

  const raffle = res.rows[0];
  if (!raffle) {
    return sendMessage(chatId, 'Сейчас нет активных или запланированных розыгрышей.');
  }

  const sub = await checkUserAllSubscriptions(raffle.id, userId);
  if (!sub.ok) {
    let text = `❌ Вы не подписаны на все обязательные каналы.\n\nНужно подписаться на:\n`;
    for (const ch of sub.missing) {
      text += `- ${ch.channel_title || ch.channel_id}\n`;
    }
    return sendMessage(chatId, text);
  }

  const entry = await createParticipantEntry(raffle.id, userId, null);

  if (entry.alreadyJoined) {
    return sendMessage(chatId, `Вы уже участвуете в розыгрыше #${raffle.id}.`);
  }

  const refLink = `${process.env.APP_BASE_URL}/join/${raffle.id}?ref=${userId}`;

  await sendMessage(
    chatId,
    `🎟 Вы успешно участвуете в розыгрыше #${raffle.id}!\nВаш билет №${entry.ticketNumber}\n\nВаша пригласительная ссылка:\n${refLink}`
  );
}

// =========================
// Callback-кнопки
// =========================
async function handleCallbackQuery(cb) {
  const userId = cb.from.id;
  const chatId = cb.message.chat.id;
  const data = cb.data;

  if (data === 'create_raffle') {
    await setSession(userId, 'await_title', {});
    await sendMessage(chatId, 'Введите название розыгрыша:');
    return;
  }

  if (data === 'my_raffles') {
    const raffles = await getUserRaffles(userId);
    if (!raffles.length) {
      await sendMessage(chatId, 'У вас пока нет розыгрышей.');
      return;
    }

    let text = '🔎 Ваши розыгрыши:\n\n';
    for (const r of raffles) {
      text += `#${r.id} | ${r.title} | ${r.status} | до ${dayjs(r.end_at).format('DD.MM.YYYY HH:mm')}\n`;
    }
    await sendMessage(chatId, text);
    return;
  }

  if (data === 'join_latest') {
    await joinLatestRaffle(chatId, userId);
    return;
  }

  if (data === 'stats_global') {
    const stats = await getGlobalStats();
    await sendMessage(
      chatId,
      `📊 Общая статистика:\nПользователей: ${stats.users}\nРозыгрышей: ${stats.raffles}\nБилетов: ${stats.participants}`
    );
    return;
  }
}

// =========================
// Web routes
// =========================
app.get('/', (req, res) => {
  res.send('MAX raffle bot is running');
});

// реферальная ссылка
app.get('/join/:raffleId', async (req, res) => {
  const raffleId = Number(req.params.raffleId);
  const ref = req.query.ref || '';

  res.send(`
    <html>
      <head><meta charset="UTF-8"><title>Участие в розыгрыше</title></head>
      <body>
        <h2>Розыгрыш #${raffleId}</h2>
        <p>Откройте бота в MAX и нажмите /start</p>
        <p>Реферал: ${ref}</p>
      </body>
    </html>
  `);
});

app.post('/webhook', async (req, res) => {
  try {
    if (req.headers['x-webhook-secret'] && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
      return res.status(403).send('Forbidden');
    }

    const update = req.body;

    if (update.message) {
      const message = update.message;
      const from = message.from;
      const chatId = message.chat.id;
      const text = message.text || '';

      await ensureUser(from);

      const handledBySession = await handleSessionMessage(message);
      if (handledBySession) {
        return res.sendStatus(200);
      }

      if (text === '/start' || text.toLowerCase() === 'старт') {
        await sendMessage(chatId, 'Привет! Я бот для розыгрышей 🎉');
        await sendMainMenu(chatId);
        return res.sendStatus(200);
      }

      if (text === '/menu' || text.toLowerCase() === 'меню') {
        await sendMainMenu(chatId);
        return res.sendStatus(200);
      }

      if (text === '/create' || text.toLowerCase() === 'создать розыгрыш') {
        await setSession(from.id, 'await_title', {});
        await sendMessage(chatId, 'Введите название розыгрыша:');
        return res.sendStatus(200);
      }

      if (text === '/my' || text.toLowerCase() === 'мои розыгрыши') {
        const raffles = await getUserRaffles(from.id);
        if (!raffles.length) {
          await sendMessage(chatId, 'У вас пока нет розыгрышей.');
        } else {
          let msg = '🔎 Ваши розыгрыши:\n\n';
          for (const r of raffles) {
            msg += `#${r.id} | ${r.title} | ${r.status}\n`;
          }
          await sendMessage(chatId, msg);
        }
        return res.sendStatus(200);
      }

      if (text === '/join' || text.toLowerCase() === 'участвовать') {
        await joinLatestRaffle(chatId, from.id);
        return res.sendStatus(200);
      }

      if (text.startsWith('/stat_')) {
        const raffleId = Number(text.replace('/stat_', '').trim());
        await sendRaffleStats(chatId, raffleId);
        return res.sendStatus(200);
      }

      if (text === '/stat' || text.toLowerCase() === 'статистика') {
        const stats = await getGlobalStats();
        await sendMessage(
          chatId,
          `📊 Общая статистика:\nПользователей: ${stats.users}\nРозыгрышей: ${stats.raffles}\nБилетов: ${stats.participants}`
        );
        return res.sendStatus(200);
      }

      if (text.startsWith('/pick_')) {
        const raffleId = Number(text.replace('/pick_', '').trim());
        const raffle = await getRaffleById(raffleId);

        if (!raffle) {
          await sendMessage(chatId, 'Розыгрыш не найден.');
          return res.sendStatus(200);
        }

        if (Number(raffle.creator_user_id) !== Number(from.id)) {
          await sendMessage(chatId, 'Только создатель розыгрыша может запустить выбор победителей.');
          return res.sendStatus(200);
        }

        await finishRaffle(raffleId);
        return res.sendStatus(200);
      }

      await sendMainMenu(chatId);
      return res.sendStatus(200);
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error.response?.data || error.message);
    return res.sendStatus(200);
  }
});

async function createTablesIfNotExist() {
  const queries = [
    // users
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      max_user_id BIGINT UNIQUE NOT NULL,
      username VARCHAR(255),
      first_name VARCHAR(255),
      last_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`,

    // user_sessions
    `CREATE TABLE IF NOT EXISTS user_sessions (
      user_id BIGINT PRIMARY KEY REFERENCES users(max_user_id),
      state VARCHAR(50),
      data JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP DEFAULT NOW()
    );`,

    // raffles
    `CREATE TABLE IF NOT EXISTS raffles (
      id SERIAL PRIMARY KEY,
      creator_user_id BIGINT REFERENCES users(max_user_id),
      title VARCHAR(255) DEFAULT 'Без названия',
      description TEXT,
      prizes TEXT,
      prize_count INT DEFAULT 1,
      end_at TIMESTAMP,
      status VARCHAR(20) DEFAULT 'draft',
      publish_in_general BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`,

    // raffle_channels
    `CREATE TABLE IF NOT EXISTS raffle_channels (
      id SERIAL PRIMARY KEY,
      raffle_id INT REFERENCES raffles(id),
      channel_id BIGINT NOT NULL,
      channel_title VARCHAR(255),
      is_required BOOLEAN DEFAULT true,
      publish_post BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`,

    // raffle_queue
    `CREATE TABLE IF NOT EXISTS raffle_queue (
      id SERIAL PRIMARY KEY,
      raffle_id INT REFERENCES raffles(id),
      queue_type VARCHAR(50) NOT NULL,
      scheduled_at TIMESTAMP NOT NULL,
      payload JSONB DEFAULT '{}'::jsonb,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`,

    // raffle_user_entry
    `CREATE TABLE IF NOT EXISTS raffle_user_entry (
      id SERIAL PRIMARY KEY,
      raffle_id INT REFERENCES raffles(id),
      user_id BIGINT REFERENCES users(max_user_id),
      created_at TIMESTAMP DEFAULT NOW()
    );`,

    // raffle_participants
    `CREATE TABLE IF NOT EXISTS raffle_participants (
      id SERIAL PRIMARY KEY,
      raffle_id INT REFERENCES raffles(id),
      user_id BIGINT REFERENCES users(max_user_id),
      ticket_number BIGINT,
      invited_by BIGINT,
      is_valid BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );`,

    // raffle_winners
    `CREATE TABLE IF NOT EXISTS raffle_winners (
      id SERIAL PRIMARY KEY,
      raffle_id INT REFERENCES raffles(id),
      user_id BIGINT REFERENCES users(max_user_id),
      ticket_number BIGINT,
      prize_text VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );`,

    // raffle_posts
    `CREATE TABLE IF NOT EXISTS raffle_posts (
      id SERIAL PRIMARY KEY,
      raffle_id INT REFERENCES raffles(id),
      channel_id BIGINT,
      message_id BIGINT,
      created_at TIMESTAMP DEFAULT NOW()
    );`
  ];

  for (const q of queries) {
    try {
      await pool.query(q);
    } catch (err) {
      console.error('Error creating table:', err.message);
    }
  }

  console.log('✅ All tables are ensured.');
}

createTablesIfNotExist().then(() => {
  console.log('✅ Tables created or already exist, starting server...');

  setInterval(processQueue, Number(process.env.CHECK_INTERVAL_SECONDS || 30) * 1000);

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
