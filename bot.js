
require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const crypto = require('crypto');

dayjs.extend(customParseFormat);

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false }));

// =========================
// ENV
// =========================
const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL = process.env.DATABASE_URL || '';
const DATABASE_SSL = String(process.env.DATABASE_SSL || process.env.PGSSL || 'true').toLowerCase() !== 'false';

const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN || '';
const MAX_API_BASE = process.env.MAX_API_BASE || 'https://platform-api.max.ru';
const MAX_WEBHOOK_SECRET = process.env.MAX_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || '';

const APP_BASE_URL = String(
  process.env.APP_BASE_URL ||
  process.env.APP_PUBLIC_URL ||
  process.env.PUBLIC_URL ||
  `http://localhost:${PORT}`
).replace(/\/+$/, '');

const GENERAL_CHANNEL_ID = process.env.GENERAL_CHANNEL_ID || '';
const CHECK_INTERVAL_SECONDS = Number(process.env.CHECK_INTERVAL_SECONDS || 30);

const ADMIN_IDS = new Set(
  String(process.env.ADMIN_IDS || process.env.ADMIN_USER_IDS || process.env.ADMIN_USER_ID || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
);

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL не задан');
}

if (!MAX_BOT_TOKEN) {
  throw new Error('MAX_BOT_TOKEN не задан');
}

// =========================
// PostgreSQL
// =========================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_SSL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error);
});

// =========================
// Helpers
// =========================
function isAdmin(userId) {
  return ADMIN_IDS.has(String(userId));
}

function safeText(value, max = 4000) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, max);
}

function randomTicketNumber() {
  return Number(`${Date.now()}${crypto.randomInt(1000, 9999)}`);
}

function shuffleSecure(array) {
  const arr = [...array];

  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr;
}

function parseEndDate(value) {
  const text = String(value || '').trim();

  const formats = [
    'YYYY-MM-DD HH:mm',
    'YYYY-MM-DD H:mm',
    'DD.MM.YYYY HH:mm',
    'DD.MM.YYYY H:mm'
  ];

  for (const format of formats) {
    const parsed = dayjs(text, format, true);

    if (parsed.isValid()) {
      return parsed;
    }
  }

  const fallback = dayjs(text);

  return fallback.isValid() ? fallback : null;
}

const rateMap = new Map();

function isRateLimited(userId, limit = 30, windowMs = 60_000) {
  const key = String(userId || 'unknown');
  const now = Date.now();
  const item = rateMap.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > item.resetAt) {
    item.count = 0;
    item.resetAt = now + windowMs;
  }

  item.count += 1;
  rateMap.set(key, item);

  return item.count > limit;
}

setInterval(() => {
  const now = Date.now();

  for (const [key, item] of rateMap.entries()) {
    if (now > item.resetAt + 10 * 60_000) {
      rateMap.delete(key);
    }
  }
}, 10 * 60_000).unref?.();

// =========================
// MAX API
// =========================
async function maxRequest(path, options = {}) {
  const url = new URL(`${MAX_API_BASE}${path}`);

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== null && String(value).trim()) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers = {
    Authorization: MAX_BOT_TOKEN
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  const bodyText = await response.text();

  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = bodyText;
  }

  if (!response.ok) {
    const details = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`MAX API ${response.status}: ${details}`);
  }

  return body;
}

function normalizeMaxTarget(target) {
  if (target && typeof target === 'object' && target.type && target.id !== undefined && target.id !== null) {
    return {
      type: target.type,
      id: String(target.id)
    };
  }

  const id = String(target || '').trim();

  if (!id) {
    throw new Error('Пустой target для отправки сообщения');
  }

  if (id.startsWith('-')) {
    return {
      type: 'chat_id',
      id
    };
  }

  return {
    type: 'user_id',
    id
  };
}

function convertInlineKeyboardToMax(inlineKeyboard = []) {
  return {
    type: 'inline_keyboard',
    payload: {
      buttons: inlineKeyboard.map(row =>
        row.map(button => {
          if (button.url) {
            return {
              type: 'link',
              text: button.text,
              url: button.url
            };
          }

          return {
            type: 'callback',
            text: button.text,
            payload: button.callback_data || button.payload || button.data || ''
          };
        })
      )
    }
  };
}

function splitForMax(text, maxLength = 3900) {
  const clean = String(text || '').trim();

  if (!clean) {
    return [''];
  }

  const chunks = [];

  for (let i = 0; i < clean.length; i += maxLength) {
    chunks.push(clean.slice(i, i + maxLength));
  }

  return chunks;
}

async function sendMessage(target, text, inlineKeyboard = null) {
  const normalizedTarget = normalizeMaxTarget(target);
  const chunks = splitForMax(text);
  const results = [];

  for (let i = 0; i < chunks.length; i++) {
    const isLastChunk = i === chunks.length - 1;
    const attachments = [];

    if (inlineKeyboard && isLastChunk) {
      attachments.push(convertInlineKeyboardToMax(inlineKeyboard));
    }

    const result = await maxRequest('/messages', {
      method: 'POST',
      query: {
        [normalizedTarget.type]: normalizedTarget.id
      },
      body: {
        text: chunks[i] || null,
        attachments: attachments.length ? attachments : undefined,
        notify: true,
        format: 'markdown'
      }
    });

    results.push(result);
  }

  return results[results.length - 1];
}

async function answerMaxCallback(callbackId, notification = '') {
  if (!callbackId || !notification) return false;

  try {
    await maxRequest('/answers', {
      method: 'POST',
      query: {
        callback_id: callbackId
      },
      body: {
        notification
      }
    });

    return true;
  } catch (error) {
    console.warn('MAX callback answer failed:', error.message);
    return false;
  }
}

function extractMaxMessageId(result) {
  const candidates = [
    result?.message?.body?.mid,
    result?.message?.body?.message_id,
    result?.message?.mid,
    result?.message?.id,
    result?.body?.mid,
    result?.body?.message_id,
    result?.mid,
    result?.message_id,
    result?.id
  ];

  const found = candidates.find(value => value !== undefined && value !== null && String(value).trim());

  return found ? String(found) : null;
}

// =========================
// MAX update parser
// =========================
function getIncomingText(update) {
  return String(
    update?.message?.body?.text ||
    update?.payload ||
    ''
  ).trim();
}

function getCallbackPayload(update) {
  const candidates = [
    update?.callback?.payload,
    update?.callback?.button?.payload,
    update?.callback?.data,
    update?.payload,
    update?.button?.payload,
    update?.message?.body?.payload
  ];

  for (const value of candidates) {
    if (value === undefined || value === null) continue;

    const text = String(value).trim();

    if (text) return text;
  }

  return '';
}

function getCallbackId(update) {
  return String(
    update?.callback?.callback_id ||
    update?.callback?.id ||
    update?.callback_id ||
    update?.message_callback?.callback_id ||
    ''
  ).trim();
}

function getReplyTarget(update) {
  const callback = update?.callback;
  const callbackMessage = callback?.message;
  const callbackRecipient = callbackMessage?.recipient;

  if (callbackRecipient?.chat_id) {
    return {
      type: 'chat_id',
      id: callbackRecipient.chat_id
    };
  }

  if (callbackRecipient?.user_id) {
    return {
      type: 'user_id',
      id: callbackRecipient.user_id
    };
  }

  const message = update?.message;
  const recipient = message?.recipient;

  if (recipient?.chat_id) {
    return {
      type: 'chat_id',
      id: recipient.chat_id
    };
  }

  if (recipient?.user_id) {
    return {
      type: 'user_id',
      id: recipient.user_id
    };
  }

  if (message?.sender?.user_id) {
    return {
      type: 'user_id',
      id: message.sender.user_id
    };
  }

  if (callback?.user?.user_id) {
    return {
      type: 'user_id',
      id: callback.user.user_id
    };
  }

  if (update?.user?.user_id) {
    return {
      type: 'user_id',
      id: update.user.user_id
    };
  }

  if (update?.user_id) {
    return {
      type: 'user_id',
      id: update.user_id
    };
  }

  return null;
}

function getStableUserId(update, target = null) {
  return (
    update?.callback?.user?.user_id ||
    update?.message?.sender?.user_id ||
    update?.user?.user_id ||
    update?.user_id ||
    target?.id ||
    ''
  );
}

function getUserFromMaxUpdate(update, target = null) {
  const sender = update?.message?.sender || update?.callback?.user || update?.user || {};

  return {
    id: getStableUserId(update, target),
    username: sender.username || sender.login || null,
    first_name: sender.first_name || sender.firstName || sender.name || sender.full_name || null,
    last_name: sender.last_name || sender.lastName || null
  };
}

function normalizeMaxMessage(update) {
  const target = getReplyTarget(update);
  const from = getUserFromMaxUpdate(update, target);

  if (!target || !from.id) {
    return null;
  }

  return {
    from,
    chat: {
      id: target
    },
    text: getIncomingText(update)
  };
}

function normalizeMaxCallback(update) {
  const target = getReplyTarget(update);
  const from = getUserFromMaxUpdate(update, target);
  const data = getCallbackPayload(update);

  if (!target || !from.id || !data) {
    return null;
  }

  return {
    id: getCallbackId(update),
    from,
    message: {
      chat: {
        id: target
      }
    },
    data
  };
}

// =========================
// Меню
// =========================
async function sendWelcome(target, userId) {
  const adminLine = isAdmin(userId)
    ? '\n\n👑 Вам доступна админ-панель: /admin'
    : '';

  return sendMessage(
    target,
    [
      '👋 **Привет! Я бот для честных розыгрышей в MAX.**',
      '',
      'Что я умею:',
      '🎉 создавать розыгрыши;',
      '📢 публиковать их в каналы;',
      '✅ проверять обязательные подписки;',
      '🎟 выдавать билеты участникам;',
      '🔗 делать реферальные ссылки;',
      '🏆 автоматически выбирать победителей;',
      '📊 показывать статистику.',
      '',
      '**Команды:**',
      '/create — создать розыгрыш',
      '/my — мои розыгрыши',
      '/join — участвовать в последнем розыгрыше',
      '/stat — общая статистика',
      '/cancel — отменить создание',
      adminLine
    ].join('\n')
  );
}

async function sendMainMenu(target, userId = null) {
  const keyboard = [
    [{ text: '🎉 Создать розыгрыш', callback_data: 'create_raffle' }],
    [{ text: '🔎 Мои розыгрыши', callback_data: 'my_raffles' }],
    [{ text: '🎁 Участвовать', callback_data: 'join_latest' }],
    [{ text: '📊 Статистика', callback_data: 'stats_global' }]
  ];

  if (userId && isAdmin(userId)) {
    keyboard.push([{ text: '👑 Админ-панель', callback_data: 'admin_panel' }]);
  }

  return sendMessage(target, 'Выберите действие:', keyboard);
}

// =========================
// DB functions
// =========================
async function ensureUser(from) {
  if (!from || !from.id) {
    throw new Error('Не найден ID пользователя');
  }

  const userId = from.id;
  const username = from.username || from.login || null;
  const firstName = from.first_name || from.firstName || from.name || null;
  const lastName = from.last_name || from.lastName || null;

  await pool.query(`
    INSERT INTO users (max_user_id, username, first_name, last_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (max_user_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      updated_at = NOW()
  `, [userId, username, firstName, lastName]);
}

async function getSession(userId) {
  const res = await pool.query(
    `SELECT * FROM user_sessions WHERE user_id = $1`,
    [userId]
  );

  return res.rows[0] || null;
}

async function setSession(userId, state, data = {}) {
  await pool.query(`
    INSERT INTO user_sessions (user_id, state, data, updated_at)
    VALUES ($1, $2, $3::jsonb, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
      state = EXCLUDED.state,
      data = EXCLUDED.data,
      updated_at = NOW()
  `, [userId, state, JSON.stringify(data)]);
}

async function clearSession(userId) {
  await pool.query(
    `DELETE FROM user_sessions WHERE user_id = $1`,
    [userId]
  );
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
  const allowedFields = new Set([
    'title',
    'description',
    'prizes',
    'prize_count',
    'end_at',
    'status',
    'publish_in_general'
  ]);

  const keys = Object.keys(fields).filter(key => allowedFields.has(key));

  if (!keys.length) return;

  const sets = [];
  const values = [];
  let i = 1;

  for (const key of keys) {
    sets.push(`${key} = $${i}`);
    values.push(fields[key]);
    i++;
  }

  sets.push('updated_at = NOW()');
  values.push(raffleId);

  await pool.query(`
    UPDATE raffles
    SET ${sets.join(', ')}
    WHERE id = $${i}
  `, values);
}

async function getRaffleById(raffleId) {
  const res = await pool.query(
    `SELECT * FROM raffles WHERE id = $1`,
    [raffleId]
  );

  return res.rows[0] || null;
}

async function getUserRaffles(userId) {
  const res = await pool.query(`
    SELECT *
    FROM raffles
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
    SELECT *
    FROM raffle_channels
    WHERE raffle_id = $1
    ORDER BY id ASC
  `, [raffleId]);

  return res.rows;
}

async function addQueue(raffleId, queueType, scheduledAt, payload = {}) {
  await pool.query(`
    INSERT INTO raffle_queue (raffle_id, queue_type, scheduled_at, payload)
    VALUES ($1, $2, $3, $4::jsonb)
  `, [raffleId, queueType, scheduledAt, JSON.stringify(payload)]);
}

async function createParticipantEntry(raffleId, userId, invitedBy = null) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const entryRes = await client.query(`
      INSERT INTO raffle_user_entry (raffle_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (raffle_id, user_id) DO NOTHING
      RETURNING id
    `, [raffleId, userId]);

    if (!entryRes.rows.length) {
      await client.query('ROLLBACK');
      return { alreadyJoined: true };
    }

    const ticketNumber = randomTicketNumber();

    await client.query(`
      INSERT INTO raffle_participants (raffle_id, user_id, ticket_number, invited_by, is_valid)
      VALUES ($1, $2, $3, $4, true)
    `, [raffleId, userId, ticketNumber, invitedBy]);

    if (invitedBy && Number(invitedBy) !== Number(userId)) {
      const refUser = await client.query(
        `SELECT max_user_id FROM users WHERE max_user_id = $1`,
        [invitedBy]
      );

      if (refUser.rows.length) {
        const bonusTicket = randomTicketNumber();

        await client.query(`
          INSERT INTO raffle_participants (raffle_id, user_id, ticket_number, invited_by, is_valid)
          VALUES ($1, $2, $3, $4, true)
        `, [raffleId, invitedBy, bonusTicket, userId]);
      }
    }

    await client.query('COMMIT');

    return { alreadyJoined: false, ticketNumber };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getValidParticipants(raffleId) {
  const res = await pool.query(`
    SELECT *
    FROM raffle_participants
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
// Проверка подписки MAX
// =========================
function getMemberUserId(member) {
  if (typeof member === 'string' || typeof member === 'number') {
    return String(member);
  }

  return String(
    member?.user_id ||
    member?.userId ||
    member?.id ||
    member?.user?.user_id ||
    member?.user?.userId ||
    member?.user?.id ||
    member?.member?.user_id ||
    member?.member?.userId ||
    member?.member?.id ||
    member?.profile?.user_id ||
    member?.profile?.userId ||
    member?.profile?.id ||
    ''
  );
}

function isMemberActive(member) {
  if (!member) return false;

  if (typeof member === 'string' || typeof member === 'number') {
    return true;
  }

  const status = String(
    member?.status ||
    member?.membership?.status ||
    member?.member?.status ||
    member?.role ||
    ''
  ).toLowerCase();

  const negativeStatuses = [
    'left',
    'leave',
    'kicked',
    'banned',
    'blocked',
    'not_member',
    'not_found',
    'none',
    'deleted'
  ];

  if (negativeStatuses.includes(status)) {
    return false;
  }

  if (
    member?.is_member === false ||
    member?.isMember === false ||
    member?.subscribed === false ||
    member?.is_subscriber === false ||
    member?.isSubscriber === false
  ) {
    return false;
  }

  return Boolean(getMemberUserId(member));
}

function extractMembersFromMaxResponse(body) {
  if (!body) return [];

  if (Array.isArray(body)) {
    return body;
  }

  const candidates = [
    body.members,
    body.items,
    body.users,
    body.subscribers,
    body.chat_members,
    body.chatMembers,
    body.memberships,
    body.data,
    body.result,
    body.result?.members,
    body.result?.items,
    body.result?.users,
    body.result?.subscribers,
    body.result?.chat_members,
    body.result?.chatMembers,
    body.payload?.members,
    body.payload?.items,
    body.payload?.users,
    body.payload?.subscribers
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    if (Array.isArray(candidate)) {
      return candidate;
    }

    if (typeof candidate === 'object') {
      if (getMemberUserId(candidate)) {
        return [candidate];
      }

      const values = Object.values(candidate);

      if (values.some(value => getMemberUserId(value))) {
        return values;
      }

      const firstArray = values.find(Array.isArray);

      if (firstArray) {
        return firstArray;
      }
    }
  }

  if (typeof body === 'object' && getMemberUserId(body)) {
    return [body];
  }

  return [];
}

function responseContainsActiveUser(body, userId) {
  const expectedUserId = String(userId);

  const rootUserId = getMemberUserId(body);

  if (rootUserId === expectedUserId && isMemberActive(body)) {
    return true;
  }

  const members = extractMembersFromMaxResponse(body);

  return members.some(member => {
    const memberUserId = getMemberUserId(member);

    return memberUserId === expectedUserId && isMemberActive(member);
  });
}

function getNextMembersMarker(body) {
  return String(
    body?.marker ||
    body?.next_marker ||
    body?.nextMarker ||
    body?.pagination?.marker ||
    body?.pagination?.next_marker ||
    body?.result?.marker ||
    body?.result?.next_marker ||
    body?.payload?.marker ||
    body?.payload?.next_marker ||
    ''
  ).trim();
}

async function checkUserSubscribedToChannel(userId, channelId) {
  const expectedUserId = String(userId).trim();
  const encodedChannelId = encodeURIComponent(String(channelId).trim());
  const path = `/chats/${encodedChannelId}/members`;

  try {
    const directQueries = [
      { user_ids: expectedUserId },
      { user_id: expectedUserId },
      { count: 100, user_ids: expectedUserId },
      { count: 100, user_id: expectedUserId }
    ];

    for (const query of directQueries) {
      try {
        const directResult = await maxRequest(path, {
          method: 'GET',
          query
        });

        if (responseContainsActiveUser(directResult, expectedUserId)) {
          return true;
        }
      } catch (error) {
        console.warn('Direct subscription check failed:', error.message);
      }
    }

    let marker = '';
    let page = 0;

    const maxPages = Number(process.env.SUBSCRIPTION_MAX_PAGES || 300);
    const pageSize = Number(process.env.SUBSCRIPTION_PAGE_SIZE || 100);
    const seenMarkers = new Set();

    while (page < maxPages) {
      page += 1;

      const query = {
        count: pageSize
      };

      if (marker) {
        query.marker = marker;
      }

      const result = await maxRequest(path, {
        method: 'GET',
        query
      });

      if (responseContainsActiveUser(result, expectedUserId)) {
        return true;
      }

      const nextMarker = getNextMembersMarker(result);

      if (!nextMarker || nextMarker === marker || seenMarkers.has(nextMarker)) {
        break;
      }

      seenMarkers.add(nextMarker);
      marker = nextMarker;
    }

    return false;
  } catch (error) {
    console.warn(
      `Subscription check failed for user ${expectedUserId}, channel ${channelId}:`,
      error.message
    );

    return false;
  }
}

async function checkUserAllSubscriptions(raffleId, userId) {
  const channels = await getRaffleChannels(raffleId);

  if (!channels.length) {
    return { ok: true, missing: [] };
  }

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
// Розыгрыши
// =========================
function buildRaffleText(raffle, participantsCount = 0) {
  const prizes = raffle.prizes
    ? raffle.prizes
        .split('\n')
        .filter(Boolean)
        .map((p, i) => `${i + 1}. ${p}`)
        .join('\n')
    : '1. Главный приз';

  return [
    `🎉 **${raffle.title}**`,
    '',
    raffle.description || 'Участвуйте и выигрывайте!',
    '',
    '🎁 **Призы:**',
    prizes,
    '',
    `👥 Участников: **${participantsCount}**`,
    `🏆 Призовых мест: **${raffle.prize_count || 1}**`,
    `⏰ Окончание: **${dayjs(raffle.end_at).format('DD.MM.YYYY HH:mm')}**`,
    '',
    `🆔 ID розыгрыша: **${raffle.id}**`,
    '',
    `Для участия отправьте боту команду:`,
    `/join_${raffle.id}`
  ].join('\n');
}

async function publishRaffleToChannel(raffle, channelId) {
  const countRes = await pool.query(`
    SELECT COUNT(DISTINCT user_id)::int AS count
    FROM raffle_user_entry
    WHERE raffle_id = $1
  `, [raffle.id]);

  const participantsCount = countRes.rows[0].count || 0;
  const text = buildRaffleText(raffle, participantsCount);

  const data = await sendMessage(
    {
      type: 'chat_id',
      id: channelId
    },
    text,
    [
      [{ text: '🎁 Участвовать', callback_data: `join_raffle:${raffle.id}` }]
    ]
  );

  const messageId = extractMaxMessageId(data);

  await pool.query(`
    INSERT INTO raffle_posts (raffle_id, channel_id, message_id)
    VALUES ($1, $2, $3)
  `, [raffle.id, channelId, messageId]);

  return data;
}

async function activateRaffle(raffleId) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle || raffle.status !== 'scheduled') {
    return;
  }

  const channels = await getRaffleChannels(raffle.id);

  for (const ch of channels) {
    if (!ch.publish_post) continue;

    try {
      await publishRaffleToChannel(raffle, ch.channel_id);
    } catch (error) {
      console.error(`Ошибка публикации в канал ${ch.channel_id}:`, error.message);
    }
  }

  if (raffle.publish_in_general && GENERAL_CHANNEL_ID) {
    try {
      await publishRaffleToChannel(raffle, GENERAL_CHANNEL_ID);
    } catch (error) {
      console.error('Ошибка публикации в общий канал:', error.message);
    }
  }

  await updateRaffle(raffle.id, { status: 'active' });

  await sendMessage(
    raffle.creator_user_id,
    `✅ Розыгрыш #${raffle.id} запущен.\nНазвание: ${raffle.title}`
  ).catch(error => {
    console.warn('Не удалось уведомить создателя:', error.message);
  });
}

async function finishRaffle(raffleId) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle || !['active', 'scheduled'].includes(raffle.status)) {
    return;
  }

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
    ).catch(() => {});

    return;
  }

  const shuffled = shuffleSecure(participants);
  const uniqueByUser = [];
  const usedUsers = new Set();

  for (const p of shuffled) {
    if (!usedUsers.has(String(p.user_id))) {
      uniqueByUser.push(p);
      usedUsers.add(String(p.user_id));
    }

    if (uniqueByUser.length >= neededCount) {
      break;
    }
  }

  await saveWinners(raffle.id, uniqueByUser, prizes);
  await updateRaffle(raffle.id, { status: 'finished' });

  let winnersText = `🥳 **Итоги розыгрыша #${raffle.id}**\n"${raffle.title}"\n\n`;

  for (let i = 0; i < uniqueByUser.length; i++) {
    const w = uniqueByUser[i];
    const prize = prizes[i] || `Приз ${i + 1}`;

    winnersText += `${i + 1}. Пользователь ${w.user_id} — **${prize}**\n`;

    await sendMessage(
      w.user_id,
      `🎉 Поздравляем!\nВы выиграли в розыгрыше "${raffle.title}"\nВаш приз: **${prize}**`
    ).catch(error => {
      console.warn(`Не удалось отправить победителю ${w.user_id}:`, error.message);
    });
  }

  await sendMessage(raffle.creator_user_id, winnersText).catch(() => {});
}

async function processQueue() {
  const res = await pool.query(`
    WITH picked AS (
      SELECT id
      FROM raffle_queue
      WHERE status = 'pending'
        AND scheduled_at <= NOW()
      ORDER BY scheduled_at ASC
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    UPDATE raffle_queue q
    SET status = 'processing', updated_at = NOW()
    FROM picked
    WHERE q.id = picked.id
    RETURNING q.*
  `);

  for (const item of res.rows) {
    try {
      if (item.queue_type === 'raffle_start') {
        await activateRaffle(item.raffle_id);
      }

      if (item.queue_type === 'raffle_finish') {
        await finishRaffle(item.raffle_id);
      }

      if (item.queue_type === 'general_publish') {
        const raffle = await getRaffleById(item.raffle_id);

        if (raffle && raffle.publish_in_general && GENERAL_CHANNEL_ID) {
          await publishRaffleToChannel(raffle, GENERAL_CHANNEL_ID);
        }
      }

      await pool.query(`
        UPDATE raffle_queue
        SET status = 'done', updated_at = NOW()
        WHERE id = $1
      `, [item.id]);
    } catch (error) {
      console.error('Queue error:', error.message);

      await pool.query(`
        UPDATE raffle_queue
        SET status = 'failed', updated_at = NOW()
        WHERE id = $1
      `, [item.id]);
    }
  }
}

// =========================
// Статистика
// =========================
async function sendRaffleStats(target, raffleId) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
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

  const winners = await pool.query(`
    SELECT *
    FROM raffle_winners
    WHERE raffle_id = $1
    ORDER BY id ASC
  `, [raffleId]);

  const channels = await getRaffleChannels(raffleId);

  let text = `📊 **Статистика розыгрыша #${raffle.id}**\n`;
  text += `Название: ${raffle.title}\n`;
  text += `Статус: ${raffle.status}\n`;
  text += `Участников: ${totalUsers.rows[0].count}\n`;
  text += `Билетов: ${totalTickets.rows[0].count}\n\n`;

  text += '**Каналы:**\n';

  if (!channels.length) {
    text += 'Каналы не указаны.\n';
  } else {
    for (const ch of channels) {
      text += `• ${ch.channel_title || ch.channel_id}\n`;
    }
  }

  if (winners.rows.length) {
    text += '\n🏆 **Победители:**\n';

    for (const w of winners.rows) {
      text += `• ${w.user_id} — ${w.prize_text}\n`;
    }
  }

  return sendMessage(target, text);
}

// =========================
// Создание розыгрыша по шагам
// =========================
async function handleSessionMessage(message) {
  const userId = message.from.id;
  const target = message.chat.id;
  const text = message.text || '';
  const session = await getSession(userId);

  if (!session) {
    return false;
  }

  if (['/cancel', 'отмена', 'cancel'].includes(text.trim().toLowerCase())) {
    await clearSession(userId);
    await sendMessage(target, 'Создание розыгрыша отменено.');
    await sendMainMenu(target, userId);
    return true;
  }

  const state = session.state;
  const data = typeof session.data === 'string'
    ? JSON.parse(session.data || '{}')
    : session.data || {};

  if (state === 'await_title') {
    data.title = safeText(text, 255);

    if (!data.title) {
      await sendMessage(target, 'Название не может быть пустым. Введите название розыгрыша:');
      return true;
    }

    await setSession(userId, 'await_description', data);
    await sendMessage(target, 'Введите описание розыгрыша:');
    return true;
  }

  if (state === 'await_description') {
    data.description = safeText(text, 2000);

    await setSession(userId, 'await_prizes', data);
    await sendMessage(target, 'Введите список призов, каждый с новой строки:');
    return true;
  }

  if (state === 'await_prizes') {
    const prizes = safeText(text, 3000);
    const prizeList = prizes.split('\n').map(x => x.trim()).filter(Boolean);

    if (!prizeList.length) {
      await sendMessage(target, 'Добавьте хотя бы один приз.');
      return true;
    }

    data.prizes = prizeList.join('\n');
    data.prize_count = prizeList.length;

    await setSession(userId, 'await_end_date', data);
    await sendMessage(
      target,
      [
        'Введите дату окончания.',
        '',
        'Форматы:',
        '`2026-06-10 20:00`',
        '`10.06.2026 20:00`'
      ].join('\n')
    );

    return true;
  }

  if (state === 'await_end_date') {
    const parsed = parseEndDate(text);

    if (!parsed || !parsed.isValid()) {
      await sendMessage(target, 'Неверный формат даты. Пример: `2026-06-10 20:00`');
      return true;
    }

    if (parsed.isBefore(dayjs().add(1, 'minute'))) {
      await sendMessage(target, 'Дата окончания должна быть в будущем.');
      return true;
    }

    data.end_at = parsed.toISOString();

    await setSession(userId, 'await_channels', data);

    await sendMessage(
      target,
      [
        'Введите ID обязательных каналов через запятую.',
        'Если каналов нет — отправьте `0`.',
        '',
        'Пример:',
        '`-73970192098593,-72952296540698`'
      ].join('\n')
    );

    return true;
  }

  if (state === 'await_channels') {
    const raw = text.trim();

    const channelIds = raw === '0'
      ? []
      : raw
          .split(',')
          .map(x => x.trim())
          .filter(Boolean)
          .filter(x => /^-?\d+$/.test(x));

    if (raw !== '0' && !channelIds.length) {
      await sendMessage(target, 'Введите корректные ID каналов через запятую или `0`, если каналов нет.');
      return true;
    }

    data.channels = channelIds;

    await setSession(userId, 'await_publish_general', data);
    await sendMessage(target, 'Публиковать в общем канале? Напишите: `да` или `нет`');
    return true;
  }

  if (state === 'await_publish_general') {
    const publishGeneral = ['да', 'yes', 'y', '1', '+'].includes(text.trim().toLowerCase());
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

    await clearSession(userId);

    await sendMessage(
      target,
      [
        '✅ **Розыгрыш создан!**',
        `ID: **${raffle.id}**`,
        `Название: **${data.title}**`,
        `Окончание: **${dayjs(data.end_at).format('DD.MM.YYYY HH:mm')}**`,
        '',
        `Команда участия: /join_${raffle.id}`,
        `Статистика: /stat_${raffle.id}`,
        `Завершить вручную: /pick_${raffle.id}`
      ].join('\n')
    );

    return true;
  }

  return false;
}

// =========================
// Участие
// =========================
async function joinRaffle(target, userId, raffleId, invitedBy = null) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
  }

  if (!['scheduled', 'active'].includes(raffle.status)) {
    return sendMessage(target, 'Этот розыгрыш уже недоступен для участия.');
  }

  if (raffle.end_at && dayjs(raffle.end_at).isBefore(dayjs())) {
    return sendMessage(target, 'Время участия в этом розыгрыше уже закончилось.');
  }

  const sub = await checkUserAllSubscriptions(raffle.id, userId);

  if (!sub.ok) {
    let text = '❌ Для участия нужно подписаться на обязательные каналы:\n\n';

    for (const ch of sub.missing) {
      text += `• ${ch.channel_title || ch.channel_id}\n`;
    }

    text += '\nПосле подписки снова нажмите участие.';

    return sendMessage(target, text);
  }

  const entry = await createParticipantEntry(raffle.id, userId, invitedBy);

  if (entry.alreadyJoined) {
    return sendMessage(target, `✅ Вы уже участвуете в розыгрыше #${raffle.id}.`);
  }

  const refLink = `${APP_BASE_URL}/join/${raffle.id}?ref=${userId}`;

  return sendMessage(
    target,
    [
      `🎟 Вы участвуете в розыгрыше #${raffle.id}!`,
      `🎉 **${raffle.title}**`,
      `Ваш билет: **№${entry.ticketNumber}**`,
      '',
      '🔗 Ваша пригласительная ссылка:',
      refLink,
      '',
      'За приглашённых участников можно получать дополнительные билеты.'
    ].join('\n')
  );
}

async function joinLatestRaffle(target, userId) {
  const res = await pool.query(`
    SELECT *
    FROM raffles
    WHERE status IN ('scheduled', 'active')
      AND end_at > NOW()
    ORDER BY id DESC
    LIMIT 1
  `);

  const raffle = res.rows[0];

  if (!raffle) {
    return sendMessage(target, 'Сейчас нет активных или запланированных розыгрышей.');
  }

  return joinRaffle(target, userId, raffle.id, null);
}

// =========================
// Админ
// =========================
async function sendAdminPanel(target, userId) {
  if (!isAdmin(userId)) {
    return sendMessage(target, '⛔ У вас нет доступа к админ-панели.');
  }

  return sendMessage(
    target,
    [
      '👑 **Админ-панель**',
      '',
      '/admin_stats — глобальная статистика',
      '/admin_active — активные розыгрыши',
      '/pick_ID — завершить розыгрыш и выбрать победителей',
      '',
      'Пример:',
      '`/pick_15`'
    ].join('\n'),
    [
      [{ text: '📊 Статистика', callback_data: 'admin_stats' }],
      [{ text: '🔥 Активные розыгрыши', callback_data: 'admin_active' }]
    ]
  );
}

async function sendAdminStats(target, userId) {
  if (!isAdmin(userId)) {
    return sendMessage(target, '⛔ Нет доступа.');
  }

  const stats = await getGlobalStats();

  const active = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM raffles
    WHERE status IN ('scheduled', 'active')
  `);

  const finished = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM raffles
    WHERE status = 'finished'
  `);

  return sendMessage(
    target,
    [
      '📊 **Админ-статистика**',
      '',
      `Пользователей: ${stats.users}`,
      `Розыгрышей всего: ${stats.raffles}`,
      `Активных/запланированных: ${active.rows[0].count}`,
      `Завершённых: ${finished.rows[0].count}`,
      `Билетов: ${stats.participants}`
    ].join('\n')
  );
}

async function sendAdminActiveRaffles(target, userId) {
  if (!isAdmin(userId)) {
    return sendMessage(target, '⛔ Нет доступа.');
  }

  const res = await pool.query(`
    SELECT id, title, status, end_at, creator_user_id
    FROM raffles
    WHERE status IN ('scheduled', 'active')
    ORDER BY id DESC
    LIMIT 30
  `);

  if (!res.rows.length) {
    return sendMessage(target, 'Активных розыгрышей нет.');
  }

  let text = '🔥 **Активные и запланированные розыгрыши:**\n\n';

  for (const r of res.rows) {
    text += `#${r.id} | ${r.title} | ${r.status} | до ${dayjs(r.end_at).format('DD.MM.YYYY HH:mm')}\n`;
    text += `Создатель: ${r.creator_user_id}\n`;
    text += `Завершить: /pick_${r.id}\n\n`;
  }

  return sendMessage(target, text);
}

// =========================
// Callback
// =========================
async function handleCallbackQuery(cb) {
  const userId = cb.from.id;
  const target = cb.message.chat.id;
  const data = cb.data;

  if (data === 'create_raffle') {
    await setSession(userId, 'await_title', {});
    await sendMessage(target, 'Введите название розыгрыша:');
    return;
  }

  if (data === 'my_raffles') {
    const raffles = await getUserRaffles(userId);

    if (!raffles.length) {
      await sendMessage(target, 'У вас пока нет розыгрышей.');
      return;
    }

    let text = '🔎 **Ваши розыгрыши:**\n\n';

    for (const r of raffles) {
      text += `#${r.id} | ${r.title} | ${r.status} | до ${dayjs(r.end_at).format('DD.MM.YYYY HH:mm')}\n`;
      text += `Статистика: /stat_${r.id}\n`;
      text += `Завершить: /pick_${r.id}\n\n`;
    }

    await sendMessage(target, text);
    return;
  }

  if (data === 'join_latest') {
    await joinLatestRaffle(target, userId);
    return;
  }

  if (data.startsWith('join_raffle:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await joinRaffle(target, userId, raffleId, null);
    return;
  }

  if (data === 'stats_global') {
    const stats = await getGlobalStats();

    await sendMessage(
      target,
      `📊 Общая статистика:\nПользователей: ${stats.users}\nРозыгрышей: ${stats.raffles}\nБилетов: ${stats.participants}`
    );

    return;
  }

  if (data === 'admin_panel') {
    await sendAdminPanel(target, userId);
    return;
  }

  if (data === 'admin_stats') {
    await sendAdminStats(target, userId);
    return;
  }

  if (data === 'admin_active') {
    await sendAdminActiveRaffles(target, userId);
    return;
  }

  await sendMessage(target, 'Неизвестная кнопка.');
}

// =========================
// MAX update handler
// =========================
async function handleMaxUpdate(update) {
  try {
    const updateType = update?.update_type;
    const target = getReplyTarget(update);
    const userId = getStableUserId(update, target);

    if (!target || !userId) {
      console.warn('MAX update without target/user:', JSON.stringify(update));
      return;
    }

    if (updateType === 'bot_started') {
      const from = getUserFromMaxUpdate(update, target);

      await ensureUser(from);
      await sendWelcome(target, from.id);
      await sendMainMenu(target, from.id);

      return;
    }

    const callbackPayload = getCallbackPayload(update);
    const callbackId = getCallbackId(update);

    const isCallbackUpdate =
      updateType === 'message_callback' ||
      Boolean(callbackPayload) ||
      Boolean(callbackId);

    if (isCallbackUpdate) {
      const cb = normalizeMaxCallback(update);

      if (!cb) {
        console.warn('Cannot normalize MAX callback:', JSON.stringify(update));
        return;
      }

      if (isRateLimited(cb.from.id)) {
        await answerMaxCallback(callbackId, '⏳ Слишком часто. Попробуйте позже.');
        return;
      }

      await answerMaxCallback(callbackId, '✅');

      await ensureUser(cb.from);
      await handleCallbackQuery(cb);

      return;
    }

    if (updateType !== 'message_created') {
      return;
    }

    const message = normalizeMaxMessage(update);

    if (!message) {
      console.warn('Cannot normalize MAX message:', JSON.stringify(update));
      return;
    }

    const from = message.from;
    const chatTarget = message.chat.id;
    const text = message.text || '';

    await ensureUser(from);

    if (isRateLimited(from.id)) {
      await sendMessage(chatTarget, '⏳ Слишком много запросов. Попробуйте чуть позже.');
      return;
    }

    const handledBySession = await handleSessionMessage(message);

    if (handledBySession) {
      return;
    }

    if (text === '/start' || text.toLowerCase() === 'старт') {
      await sendWelcome(chatTarget, from.id);
      await sendMainMenu(chatTarget, from.id);
      return;
    }

    if (text === '/menu' || text.toLowerCase() === 'меню') {
      await sendMainMenu(chatTarget, from.id);
      return;
    }

    if (text === '/admin') {
      await sendAdminPanel(chatTarget, from.id);
      return;
    }

    if (text === '/admin_stats') {
      await sendAdminStats(chatTarget, from.id);
      return;
    }

    if (text === '/admin_active') {
      await sendAdminActiveRaffles(chatTarget, from.id);
      return;
    }

    if (text === '/create' || text.toLowerCase() === 'создать розыгрыш') {
      await setSession(from.id, 'await_title', {});
      await sendMessage(chatTarget, 'Введите название розыгрыша:');
      return;
    }

    if (text === '/my' || text.toLowerCase() === 'мои розыгрыши') {
      const raffles = await getUserRaffles(from.id);

      if (!raffles.length) {
        await sendMessage(chatTarget, 'У вас пока нет розыгрышей.');
      } else {
        let msg = '🔎 **Ваши розыгрыши:**\n\n';

        for (const r of raffles) {
          msg += `#${r.id} | ${r.title} | ${r.status}\n`;
          msg += `Статистика: /stat_${r.id}\n`;
          msg += `Завершить: /pick_${r.id}\n\n`;
        }

        await sendMessage(chatTarget, msg);
      }

      return;
    }

    if (text === '/join' || text.toLowerCase() === 'участвовать') {
      await joinLatestRaffle(chatTarget, from.id);
      return;
    }

    if (text.startsWith('/join_')) {
      const parts = text.replace('/join_', '').split('_');
      const raffleId = Number(parts[0]);
      const ref = parts[1] ? Number(parts[1]) : null;

      if (!Number.isInteger(raffleId)) {
        await sendMessage(chatTarget, 'Некорректная команда участия. Пример: /join_15');
        return;
      }

      await joinRaffle(chatTarget, from.id, raffleId, ref);
      return;
    }

    if (text.startsWith('/stat_')) {
      const raffleId = Number(text.replace('/stat_', '').trim());

      if (!Number.isInteger(raffleId)) {
        await sendMessage(chatTarget, 'Некорректный ID розыгрыша.');
        return;
      }

      await sendRaffleStats(chatTarget, raffleId);
      return;
    }

    if (text === '/stat' || text.toLowerCase() === 'статистика') {
      const stats = await getGlobalStats();

      await sendMessage(
        chatTarget,
        `📊 Общая статистика:\nПользователей: ${stats.users}\nРозыгрышей: ${stats.raffles}\nБилетов: ${stats.participants}`
      );

      return;
    }

    if (text.startsWith('/pick_')) {
      const raffleId = Number(text.replace('/pick_', '').trim());
      const raffle = await getRaffleById(raffleId);

      if (!raffle) {
        await sendMessage(chatTarget, 'Розыгрыш не найден.');
        return;
      }

      const canPick =
        Number(raffle.creator_user_id) === Number(from.id) ||
        isAdmin(from.id);

      if (!canPick) {
        await sendMessage(chatTarget, 'Только создатель или админ может выбрать победителей.');
        return;
      }

      await finishRaffle(raffleId);
      return;
    }

    await sendMainMenu(chatTarget, from.id);
  } catch (error) {
    console.error('MAX update handling error:', error.message);
  }
}

// =========================
// Web routes
// =========================
app.get('/', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'MAX raffle bot',
    webhook: '/webhook'
  });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      ok: true,
      db: true,
      time: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      db: false,
      error: error.message
    });
  }
});

app.get('/join/:raffleId', async (req, res) => {
  const raffleId = Number(req.params.raffleId);
  const ref = req.query.ref || '';

  const command = ref
    ? `/join_${raffleId}_${ref}`
    : `/join_${raffleId}`;

  res.type('html').send(`
    <!doctype html>
    <html lang="ru">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Участие в розыгрыше</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 30px;
            line-height: 1.5;
            background: #f5f5f5;
          }

          .card {
            max-width: 520px;
            margin: 0 auto;
            background: #fff;
            padding: 24px;
            border-radius: 18px;
            box-shadow: 0 12px 30px rgba(0,0,0,.08);
          }

          code {
            background: #f2f2f2;
            padding: 10px 14px;
            display: inline-block;
            border-radius: 8px;
            font-size: 18px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>🎉 Розыгрыш #${raffleId}</h2>
          <p>Откройте бота в MAX и отправьте команду:</p>
          <code>${command}</code>
          <p>После этого бот проверит условия и выдаст билет.</p>
        </div>
      </body>
    </html>
  `);
});

app.post(['/', '/webhook'], (req, res) => {
  console.log('📩 WEBHOOK RECEIVED:', {
    path: req.path,
    time: new Date().toISOString(),
    contentType: req.get('Content-Type'),
    userAgent: req.get('User-Agent'),
    hasBody: Boolean(req.body && Object.keys(req.body).length),
    bodyPreview: JSON.stringify(req.body || {}).slice(0, 1000)
  });

  if (MAX_WEBHOOK_SECRET) {
    const receivedSecret =
      req.get('X-Max-Bot-Api-Secret') ||
      req.get('X-Webhook-Secret') ||
      req.query.secret ||
      '';

    if (receivedSecret !== MAX_WEBHOOK_SECRET) {
      console.warn('❌ Invalid webhook secret:', {
        path: req.path,
        receivedSecretPresent: Boolean(receivedSecret),
        expectedSecretEnabled: Boolean(MAX_WEBHOOK_SECRET)
      });

      res.status(401).json({
        ok: false,
        error: 'Invalid webhook secret'
      });

      return;
    }
  }

  res.status(200).json({
    ok: true
  });

  const payload = req.body;
  const updates = Array.isArray(payload?.updates) ? payload.updates : [payload];

  console.log(`📦 Updates count: ${updates.length}`);

  for (const update of updates) {
    handleMaxUpdate(update).catch(error => {
      console.error('Unhandled MAX update error:', error);
    });
  }
});

// =========================
// Tables
// =========================
async function createTablesIfNotExist() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      max_user_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      user_id BIGINT PRIMARY KEY REFERENCES users(max_user_id) ON DELETE CASCADE,
      state TEXT,
      data JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS raffles (
      id SERIAL PRIMARY KEY,
      creator_user_id BIGINT REFERENCES users(max_user_id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT 'Без названия',
      description TEXT,
      prizes TEXT,
      prize_count INT DEFAULT 1,
      end_at TIMESTAMP NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      publish_in_general BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS raffle_channels (
      id SERIAL PRIMARY KEY,
      raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      channel_id BIGINT NOT NULL,
      channel_title TEXT,
      is_required BOOLEAN DEFAULT true,
      publish_post BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS raffle_queue (
      id SERIAL PRIMARY KEY,
      raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      queue_type TEXT NOT NULL,
      scheduled_at TIMESTAMP NOT NULL,
      payload JSONB DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS raffle_user_entry (
      id SERIAL PRIMARY KEY,
      raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (raffle_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS raffle_participants (
      id SERIAL PRIMARY KEY,
      raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
      ticket_number BIGINT NOT NULL,
      invited_by BIGINT,
      is_valid BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (raffle_id, user_id, ticket_number)
    );

    CREATE TABLE IF NOT EXISTS raffle_winners (
      id SERIAL PRIMARY KEY,
      raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
      ticket_number BIGINT NOT NULL,
      prize_text TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS raffle_posts (
      id SERIAL PRIMARY KEY,
      raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      channel_id BIGINT,
      message_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS ix_raffles_status_end_at
    ON raffles (status, end_at);

    CREATE INDEX IF NOT EXISTS ix_raffle_queue_status_scheduled
    ON raffle_queue (status, scheduled_at);

    CREATE INDEX IF NOT EXISTS ix_raffle_participants_raffle_valid
    ON raffle_participants (raffle_id, is_valid);

    CREATE INDEX IF NOT EXISTS ix_raffle_channels_raffle
    ON raffle_channels (raffle_id);

    CREATE INDEX IF NOT EXISTS ix_raffle_winners_raffle
    ON raffle_winners (raffle_id);
  `);

  console.log('✅ Все таблицы созданы или уже существуют');
}

// =========================
// Start
// =========================
async function startServer() {
  try {
    const dbTime = await pool.query('SELECT NOW()');
    console.log('✅ Connected to PostgreSQL:', dbTime.rows[0]);

    await createTablesIfNotExist();

    setInterval(() => {
      processQueue().catch(error => {
        console.error('processQueue interval error:', error.message);
      });
    }, CHECK_INTERVAL_SECONDS * 1000).unref?.();

    setTimeout(() => {
      processQueue().catch(error => {
        console.error('processQueue warmup error:', error.message);
      });
    }, 3000).unref?.();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ MAX raffle bot is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}
startServer();
