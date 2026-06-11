require('dotenv').config();
process.env.TZ = process.env.TZ || 'UTC';

const express = require('express');
const { Pool } = require('pg');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const utc = require('dayjs/plugin/utc');
const crypto = require('crypto');
const { setupApostModule } = require('./apost_module');

dayjs.extend(customParseFormat);
dayjs.extend(utc);

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
const MAX_API_TIMEOUT_MS = Number(process.env.MAX_API_TIMEOUT_MS || 15000);
const MAX_WEBHOOK_SECRET = process.env.MAX_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || '';

let APP_BASE_URL = String(
  process.env.APP_BASE_URL ||
  process.env.APP_PUBLIC_URL ||
  process.env.PUBLIC_URL ||
  `http://localhost:${PORT}`
).replace(/\/+$/, '');

if (
  APP_BASE_URL &&
  !APP_BASE_URL.startsWith('http://') &&
  !APP_BASE_URL.startsWith('https://')
) {
  APP_BASE_URL = `https://${APP_BASE_URL}`;
}

const GENERAL_CHANNEL_ID = process.env.GENERAL_CHANNEL_ID || '';
const RESULTS_CHANNEL_ID = String(
  process.env.RESULTS_CHANNEL_ID ||
  process.env.RESULT_CHANNEL_ID ||
  process.env.WINNERS_CHANNEL_ID ||
  ''
).trim();
const MIN_RAFFLE_DURATION_MINUTES = Number(process.env.MIN_RAFFLE_DURATION_MINUTES || 30);
const MIN_RAFFLE_PUBLISH_DELAY_MINUTES = Number(
  process.env.MIN_RAFFLE_PUBLISH_DELAY_MINUTES ||
  MIN_RAFFLE_DURATION_MINUTES ||
  30
);
const MIN_RAFFLE_DURATION_AFTER_PUBLISH_MINUTES = Number(
  process.env.MIN_RAFFLE_DURATION_AFTER_PUBLISH_MINUTES ||
  MIN_RAFFLE_DURATION_MINUTES ||
  30
);
const MAX_USER_LINK_TEMPLATE = String(
  // В MAX личные профили часто имеют вид https://max.ru/u/<opaque-token>.
  // Такой token нельзя надёжно получить из numeric user_id, поэтому по умолчанию
  // не создаём искусственные ссылки. Если у вас есть официальный рабочий шаблон,
  // задайте его в .env вручную.
  process.env.MAX_USER_LINK_TEMPLATE || ''
).trim();
const CHECK_INTERVAL_SECONDS = Number(process.env.CHECK_INTERVAL_SECONDS || 30);
const REMINDER_BEFORE_FINISH_MINUTES = Number(process.env.REMINDER_BEFORE_FINISH_MINUTES || 15);

// Как часто обновлять счётчик участников в уже опубликованных постах.
// 0 = отключить фоновое обновление, но обновление после нового участника всё равно останется.
const POST_PARTICIPANTS_UPDATE_SECONDS = Number(process.env.POST_PARTICIPANTS_UPDATE_SECONDS || 60);

// После нового участника не редактируем пост сразу.
// Ставим отложенную задачу и обновляем счётчик пачкой.
const RAFFLE_POST_UPDATE_DEBOUNCE_SECONDS = Math.max(
  5,
  Number(process.env.RAFFLE_POST_UPDATE_DEBOUNCE_SECONDS || 30)
);

// Через сколько секунд после нажатия «Участвовать» напомнить пользователю,
// если он не завершил проверку подписки и билет ещё не создан.
const PENDING_JOIN_REMINDER_DELAY_SECONDS = Math.max(
  30,
  Number(process.env.PENDING_JOIN_REMINDER_DELAY_SECONDS || 60)
);

// Как часто искать незавершённые участия для такого напоминания.
const PENDING_JOIN_REMINDER_SCAN_SECONDS = Math.max(
  15,
  Number(process.env.PENDING_JOIN_REMINDER_SCAN_SECONDS || 30)
);

// Задержка между сообщениями при админской рассылке всем пользователям.
// Небольшая пауза снижает риск лимитов MAX API.
const ADMIN_BROADCAST_SEND_DELAY_MS = Math.max(
  0,
  Number(process.env.ADMIN_BROADCAST_SEND_DELAY_MS || 120)
);

// Админская рассылка теперь отправляется через отдельные broadcast_jobs,
// чтобы web-сервер не зависал на длинной рассылке.
const ADMIN_BROADCAST_BATCH_SIZE = Math.max(
  1,
  Number(process.env.ADMIN_BROADCAST_BATCH_SIZE || 25)
);

const ADMIN_BROADCAST_WORKER_INTERVAL_SECONDS = Math.max(
  5,
  Number(process.env.ADMIN_BROADCAST_WORKER_INTERVAL_SECONDS || 10)
);

// Как часто повторять предупреждение организатору/соадмину, если активный розыгрыш под угрозой
// из-за отсутствия прав бота в канале.
const RAFFLE_PERMISSION_ALERT_INTERVAL_MINUTES = Math.max(
  5,
  Number(process.env.RAFFLE_PERMISSION_ALERT_INTERVAL_MINUTES || 30)
);

// Фоновая проверка прав больше не используется, чтобы не ловить ложные 403 по всем каналам.
// Оставлено только для совместимости со старыми настройками Render.
const RAFFLE_PERMISSION_WATCH_SECONDS = Math.max(
  60,
  Number(process.env.RAFFLE_PERMISSION_WATCH_SECONDS || 300)
);

// Подробные логи проверки подписки выключены по умолчанию, чтобы Render не засорялся
// длинными списками страниц участников. Для диагностики можно включить:
// SUBSCRIPTION_CHECK_VERBOSE_LOGS=true
const SUBSCRIPTION_CHECK_VERBOSE_LOGS = String(
  process.env.SUBSCRIPTION_CHECK_VERBOSE_LOGS || 'false'
).toLowerCase() === 'true';

// Сколько страниц участников максимум листать, если прямой поиск user_ids не нашёл пользователя.
// 3 = максимум 300 участников запасным способом вместо десятков страниц.
const SUBSCRIPTION_FALLBACK_MAX_PAGES = Math.max(
  0,
  Number(process.env.SUBSCRIPTION_FALLBACK_MAX_PAGES || 3)
);

const SUBSCRIPTION_PAGE_SIZE = Math.max(
  1,
  Number(process.env.SUBSCRIPTION_PAGE_SIZE || 100)
);

const BOT_PUBLIC_URL = String(
  process.env.BOT_PUBLIC_URL ||
  process.env.MAX_BOT_LINK ||
  process.env.BOT_LINK ||
  APP_BASE_URL
).replace(/\/+$/, '');

const BOT_BRAND_NAME = process.env.BOT_BRAND_NAME || 'РОЗЫГРЫШ БОТ';
const BOT_USERNAME = process.env.BOT_USERNAME || '@id231711659887_bot';
const BOT_SEARCH_NAME = process.env.BOT_SEARCH_NAME || 'РОЗЫГРЫШ БОТ';
const BOT_TIMEZONE_LABEL = process.env.BOT_TIMEZONE_LABEL || 'МСК';
const BOT_UTC_OFFSET_MINUTES = Number(process.env.BOT_UTC_OFFSET_MINUTES || 180);
const MAX_CHANNEL_LINK_TEMPLATE = String(process.env.MAX_CHANNEL_LINK_TEMPLATE || '').trim();
const MAX_POST_LINK_TEMPLATE = String(process.env.MAX_POST_LINK_TEMPLATE || '').trim();
const MAX_POST_URL_BASE = String(
  process.env.MAX_POST_URL_BASE ||
  process.env.MAX_POST_BASE_URL ||
  process.env.MAX_POST_CHANNEL_URL ||
  ''
).replace(/\/+$/, '').trim();
const USER_RAFFLES_VISIBLE_LIMIT = Math.max(
  1,
  Number(process.env.USER_RAFFLES_VISIBLE_LIMIT || 5)
);
const MAX_REFERRAL_BONUS_TICKETS = Math.max(
  0,
  Number(process.env.MAX_REFERRAL_BONUS_TICKETS || 5)
);

const MORE_PRIZES_URL = String(
  process.env.MORE_PRIZES_URL ||
  process.env.BOT_MORE_PRIZES_URL ||
  BOT_PUBLIC_URL ||
  APP_BASE_URL ||
  ''
).replace(/\/+$/, '');
const MORE_PRIZES_LABEL = String(process.env.MORE_PRIZES_LABEL || 'ТУТ').trim() || 'ТУТ';


const ADMIN_COMMUNITY_INVITE_URL = String(
  process.env.ADMIN_COMMUNITY_INVITE_URL ||
  'https://max.ru/join/q0K8nkgKBzOpSaDUqx2NhTytafJp1jNmTcx15SmYY8Q'
).trim();
const ADMIN_COMMUNITY_INVITE_LABEL = String(process.env.ADMIN_COMMUNITY_INVITE_LABEL || 'Админов').trim() || 'Админов';
const ADMIN_COMMUNITY_INVITE_DELAY_MINUTES = Math.max(
  1,
  Number(process.env.ADMIN_COMMUNITY_INVITE_DELAY_MINUTES || 30)
);

const LEGAL_PRIVACY_URL = String(
  process.env.LEGAL_PRIVACY_URL ||
  process.env.PRIVACY_POLICY_URL ||
  ''
).trim();

const LEGAL_OFFER_URL = String(
  process.env.LEGAL_OFFER_URL ||
  process.env.PUBLIC_OFFER_URL ||
  process.env.OFFER_URL ||
  ''
).trim();

const LEGAL_PERSONAL_DATA_URL = String(
  process.env.LEGAL_PERSONAL_DATA_URL ||
  process.env.PERSONAL_DATA_POLICY_URL ||
  process.env.PERSONAL_DATA_URL ||
  ''
).trim();

const LEGAL_VERSION = String(process.env.LEGAL_VERSION || '2026-06-05').trim();

const RAFFLE_RULES_URL = String(
  process.env.RAFFLE_RULES_URL ||
  process.env.RAFFLE_RULES_PUBLIC_URL ||
  LEGAL_OFFER_URL ||
  ''
).trim();

function buildRaffleRulesLine() {
  return RAFFLE_RULES_URL
    ? `Принимая участие, вы подтверждаете, что ознакомлены с ${markdownLink('правилами', RAFFLE_RULES_URL)}.`
    : 'Принимая участие, вы подтверждаете, что ознакомлены с правилами розыгрыша.';
}

function buildRaffleWinWarningLine() {
  return '‼️ **ЧТОБЫ победить в розыгрыше, НЕ отписывайтесь от каналов и не удаляйте бота до конца розыгрыша.**';
}

const PERMISSIONS_HELP_IMAGE_URL = String(
  process.env.PERMISSIONS_HELP_IMAGE_URL ||
  process.env.BOT_PERMISSIONS_HELP_IMAGE_URL ||
  'https://v3b.fal.media/files/b/0a9d026e/QEmmNq9GOE5GeHkWFsiXU_qNKm4RQp1xuHoqwH46yOlXmubgnubbBBeaknohnIuLqMn9YTPFlQNkKbGEO8JYP4K_Ge2XAlwApRdA1JTjDaqDPO.jpg'
).trim();

const PERMISSIONS_HELP_TEXT = String(
  process.env.PERMISSIONS_HELP_TEXT ||
  'На изображении показано, какие права нужно выдать боту для публикации розыгрышей.'
).trim();


const FLOOD_WINDOW_MS = Number(process.env.FLOOD_WINDOW_MS || 60_000);
const FLOOD_MAX_ACTIONS = Number(process.env.FLOOD_MAX_ACTIONS || 25);
const FLOOD_ACTION_COOLDOWN_MS = Number(process.env.FLOOD_ACTION_COOLDOWN_MS || 1500);
const FLOOD_TEMP_BAN_MINUTES = Number(process.env.FLOOD_TEMP_BAN_MINUTES || 10);


const YOOKASSA_SHOP_ID = String(process.env.YOOKASSA_SHOP_ID || '').trim();
const YOOKASSA_SECRET_KEY = String(process.env.YOOKASSA_SECRET_KEY || '').trim();
const YOOKASSA_API_BASE = String(process.env.YOOKASSA_API_BASE || 'https://api.yookassa.ru/v3').replace(/\/+$/, '');
const YOOKASSA_RECEIPT_EMAIL = String(
  process.env.YOOKASSA_RECEIPT_EMAIL ||
  process.env.DEFAULT_RECEIPT_EMAIL ||
  'toni.zhuravlev.xd@mail.ru'
).trim();
const YOOKASSA_VAT_CODE = Number(process.env.YOOKASSA_VAT_CODE || 1);
const YOOKASSA_TAX_SYSTEM_CODE = process.env.YOOKASSA_TAX_SYSTEM_CODE
  ? Number(process.env.YOOKASSA_TAX_SYSTEM_CODE)
  : undefined;

const PROMO_GENERAL_PRICE_RUB = String(process.env.PROMO_GENERAL_PRICE_RUB || '500.00');
const PROMO_BOT_PRICE_RUB = String(process.env.PROMO_BOT_PRICE_RUB || '1200.00');
const PROMO_GENERAL_PRODUCT_CODE = 'raffle_general_channel_publish';
const PROMO_BOT_PRODUCT_CODE = 'raffle_bot_7000_publish';
const GENERAL_PROMO_SPACING_MINUTES = Math.max(
  1,
  Number(process.env.GENERAL_PROMO_SPACING_MINUTES || 15)
);

const PROMO_ADMIN_IDS = new Set(
  String(process.env.PROMO_ADMIN_IDS || process.env.ADMIN_IDS || process.env.ADMIN_USER_IDS || process.env.ADMIN_USER_ID || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
);

const MAX_UPDATE_TYPES = String(process.env.MAX_UPDATE_TYPES || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const DEBUG_MAX_FULL_UPDATES = String(
  process.env.DEBUG_MAX_FULL_UPDATES || 'true'
).toLowerCase() !== 'false';

// По умолчанию не засоряем логи и bot_seen_chats чужими розыгрышами из message_edited.
// Если нужно снова смотреть конкурентов, поставьте в Render:
// SHOW_FOREIGN_RAFFLE_EDIT_UPDATES=true
const SHOW_FOREIGN_RAFFLE_EDIT_UPDATES = String(
  process.env.SHOW_FOREIGN_RAFFLE_EDIT_UPDATES || 'false'
).toLowerCase() === 'true';

const MAX_SEEN_CHAT_REFRESH_LIMIT = Number(
  process.env.MAX_SEEN_CHAT_REFRESH_LIMIT || 500
);

let BOT_USER_ID = String(process.env.MAX_BOT_USER_ID || process.env.BOT_USER_ID || '').trim();

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

const apostModule = setupApostModule({
  app,
  pool,
  sendMessage,
  markdownLink,
  normalizeHttpLink,
  safeText,
  formatChannelWithLink,
  APP_BASE_URL,
  BOT_PUBLIC_URL,
  BOT_BRAND_NAME,
  BOT_UTC_OFFSET_MINUTES,
  maxRequest
});

// =========================
// Helpers
// =========================
function isAdmin(userId) {
  return ADMIN_IDS.has(String(userId));
}

function extractUserIdFromAny(obj) {
  if (obj === undefined || obj === null) return '';

  if (typeof obj === 'string' || typeof obj === 'number') {
    return String(obj).trim();
  }

  if (typeof obj !== 'object') return '';

  const candidates = [
    obj.user_id,
    obj.userId,
    obj.id,
    obj.bot_id,
    obj.botId,
    obj.max_user_id,
    obj.maxUserId,
    obj.user?.user_id,
    obj.user?.userId,
    obj.user?.id,
    obj.bot?.user_id,
    obj.bot?.userId,
    obj.bot?.id,
    obj.me?.user_id,
    obj.me?.userId,
    obj.me?.id,
    obj.result?.user_id,
    obj.result?.userId,
    obj.result?.id,
    obj.result?.bot_id,
    obj.payload?.user_id,
    obj.payload?.userId,
    obj.payload?.id,
    obj.profile?.user_id,
    obj.profile?.userId,
    obj.profile?.id
  ];

  for (const value of candidates) {
    const text = String(value || '').trim();
    if (text) return text;
  }

  return '';
}

function safeText(value, max = 4000) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, max);
}

function sleep(ms) {
  const delay = Math.max(0, Number(ms || 0));
  return new Promise(resolve => setTimeout(resolve, delay));
}

function buildRaffleTitlePrompt() {
  return [
    'Введите название розыгрыша👇',
    'Пример:',
    'РОЗЫГРЫШ *Iphone 17 PRO*'
  ].join('\n');
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
      // Пользователь вводит часы по МСК. Превращаем их в реальный UTC-момент.
      return dayjs
        .utc(`${parsed.format('YYYY-MM-DD')}T${parsed.format('HH:mm')}:00.000Z`)
        .subtract(BOT_UTC_OFFSET_MINUTES, 'minute');
    }
  }

  // ISO-строки со смещением считаем уже абсолютным временем.
  const fallback = dayjs.utc(text);

  return fallback.isValid() ? fallback : null;
}

function toUtcMoment(value) {
  if (!value) return null;

  const parsed = dayjs.isDayjs(value)
    ? value
    : dayjs.utc(value);

  return parsed.isValid() ? parsed.utc() : null;
}

const rateMap = new Map();
const actionCooldownMap = new Map();

function isRateLimited(userId, limit = FLOOD_MAX_ACTIONS, windowMs = FLOOD_WINDOW_MS) {
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

function isActionCooldownLimited(userId, action = 'global', cooldownMs = FLOOD_ACTION_COOLDOWN_MS) {
  const safeAction = String(action || 'global').slice(0, 80);
  const key = `${String(userId || 'unknown')}:${safeAction}`;
  const now = Date.now();
  const lastAt = actionCooldownMap.get(key) || 0;

  if (cooldownMs > 0 && now - lastAt < cooldownMs) {
    return true;
  }

  actionCooldownMap.set(key, now);
  return false;
}

function formatBanUntil(value) {
  const parsed = toUtcMoment(value);
  return parsed ? formatDateTime(parsed) : 'не указано';
}

async function getActiveBan(userId) {
  const id = String(userId || '').trim();
  if (!id) return null;

  const res = await pool.query(`
    SELECT *
    FROM user_bans
    WHERE user_id = $1
      AND banned_until > NOW()
    ORDER BY banned_until DESC, id DESC
    LIMIT 1
  `, [id]);

  return res.rows[0] || null;
}

async function banUser(userId, minutes = FLOOD_TEMP_BAN_MINUTES, reason = 'anti_flood', bannedBy = null) {
  const id = String(userId || '').trim();
  if (!id) return null;

  const duration = Math.max(1, Number(minutes || FLOOD_TEMP_BAN_MINUTES || 10));

  await pool.query(`
    INSERT INTO users (max_user_id)
    VALUES ($1)
    ON CONFLICT (max_user_id) DO NOTHING
  `, [id]);

  const res = await pool.query(`
    INSERT INTO user_bans (user_id, banned_until, reason, banned_by, updated_at)
    VALUES ($1, NOW() + ($2::text || ' minutes')::interval, $3, $4, NOW())
    RETURNING *
  `, [id, duration, safeText(reason || 'ban', 500), bannedBy || null]);

  return res.rows[0] || null;
}

async function unbanUser(userId) {
  const id = String(userId || '').trim();
  if (!id) return 0;

  const res = await pool.query(`
    UPDATE user_bans
    SET banned_until = NOW(), updated_at = NOW()
    WHERE user_id = $1
      AND banned_until > NOW()
    RETURNING id
  `, [id]);

  return res.rowCount || 0;
}

async function checkFloodOrBan(userId, target, options = {}) {
  const id = String(userId || '').trim();
  if (!id || isAdmin(id)) return { blocked: false };

  const callbackId = options.callbackId || '';
  const action = options.action || 'global';
  const isCallback = Boolean(callbackId);

  const activeBan = await getActiveBan(id);
  if (activeBan) {
    const text = `⛔ Временная блокировка до ${formatBanUntil(activeBan.banned_until)}. Причина: ${displayValue(activeBan.reason, 'флуд')}`;

    if (isCallback) {
      await answerMaxCallback(callbackId, text.slice(0, 180));
    } else {
      await sendMessage(target, text).catch(() => {});
    }

    return { blocked: true, reason: 'banned', ban: activeBan };
  }

  if (isActionCooldownLimited(id, action)) {
    if (isCallback) {
      await answerMaxCallback(callbackId, '⏳ Не нажимайте так часто.');
    }

    return { blocked: true, reason: 'cooldown' };
  }

  if (isRateLimited(id)) {
    const ban = await banUser(id, FLOOD_TEMP_BAN_MINUTES, 'Автобан за флуд кнопками/сообщениями', null);
    const text = `⛔ Слишком много действий. Временная блокировка на ${FLOOD_TEMP_BAN_MINUTES} мин.`;

    if (isCallback) {
      await answerMaxCallback(callbackId, text);
    } else {
      await sendMessage(target, text).catch(() => {});
    }

    return { blocked: true, reason: 'flood', ban };
  }

  return { blocked: false };
}

setInterval(() => {
  const now = Date.now();

  for (const [key, item] of rateMap.entries()) {
    if (now > item.resetAt + 10 * 60_000) {
      rateMap.delete(key);
    }
  }

  for (const [key, lastAt] of actionCooldownMap.entries()) {
    if (now - lastAt > 10 * 60_000) {
      actionCooldownMap.delete(key);
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

  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || MAX_API_TIMEOUT_MS || 15000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`MAX API timeout after ${timeoutMs}ms: ${path}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

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

async function getMaxMe() {
  const result = await maxRequest('/me', {
    method: 'GET'
  });

  const detectedBotUserId = extractUserIdFromAny(result);
  if (detectedBotUserId) {
    BOT_USER_ID = detectedBotUserId;
  }

  console.log('🤖 MAX /me:', JSON.stringify(result).slice(0, 1000));

  return result;
}

async function getBotUserIdSafe() {
  if (BOT_USER_ID) return BOT_USER_ID;

  try {
    await getMaxMe();
  } catch (error) {
    console.warn('Не удалось получить ID бота через /me:', error.message);
  }

  return BOT_USER_ID;
}

function buildWebhookUrl() {
  return MAX_WEBHOOK_SECRET
    ? `${APP_BASE_URL}/webhook?secret=${encodeURIComponent(MAX_WEBHOOK_SECRET)}`
    : `${APP_BASE_URL}/webhook`;
}

async function registerMaxWebhook() {
  if (!APP_BASE_URL) {
    throw new Error('APP_BASE_URL не задан');
  }

  const body = {
    url: buildWebhookUrl()
  };

  if (MAX_UPDATE_TYPES.length) {
    body.update_types = MAX_UPDATE_TYPES;
  }

  console.log('🔗 Registering MAX webhook:', body);

  const result = await maxRequest('/subscriptions', {
    method: 'POST',
    body
  });

  console.log('✅ MAX webhook registered:', JSON.stringify(result).slice(0, 1500));

  return result;
}

async function getMaxSubscriptions() {
  const result = await maxRequest('/subscriptions', {
    method: 'GET'
  });

  console.log('📋 MAX subscriptions:', JSON.stringify(result).slice(0, 2000));

  return result;
}


// =========================
// MAX system command hints
// =========================
// Эти команды показываются пользователю через значок "/" в поле ввода MAX.
// Админские и технические команды сюда не добавляем.
const SOS_SUPPORT_URL = 'https://max.ru/u/f9LHodD0cOK-A0lZdI24jE547UNSp4Gdn57gyHn8TJVc5hh-0NCZiBCjktg';

const BOT_PUBLIC_COMMANDS = [
  { name: 'start', description: 'Запустить бота 📳' },
  { name: 'menu', description: 'Главное меню 🎛️' },
  { name: 'create', description: 'Создать розыгрыш 🥳' },
  { name: 'cancel', description: 'Отмена 🚫' },
  { name: 'my', description: 'Мои розыгрыши 📁' },
  { name: 'apost', description: 'Автопост/ТЕСТЫ 🔊' },
  { name: 'sos', description: 'Вопросы и помощь ❓' }
];

async function registerBotCommandsWithMaxLibrary() {
  if (String(process.env.REGISTER_BOT_COMMANDS || 'true').toLowerCase() === 'false') {
    console.log('ℹ️ Регистрация системных команд MAX отключена: REGISTER_BOT_COMMANDS=false');
    return false;
  }

  try {
    const maxBotApi = await import('@maxhub/max-bot-api');
    const Bot = maxBotApi.Bot || maxBotApi.default?.Bot || maxBotApi.default;

    if (!Bot) {
      throw new Error('В пакете @maxhub/max-bot-api не найден экспорт Bot');
    }

    const bot = new Bot(MAX_BOT_TOKEN);

    if (!bot?.api?.setMyCommands) {
      throw new Error('В библиотеке @maxhub/max-bot-api не найден метод bot.api.setMyCommands');
    }

    await bot.api.setMyCommands(BOT_PUBLIC_COMMANDS);

    console.log('✅ Системные команды MAX зарегистрированы через @maxhub/max-bot-api:', BOT_PUBLIC_COMMANDS);
    return true;
  } catch (error) {
    console.warn('⚠️ Не удалось зарегистрировать системные команды MAX через библиотеку:', error.message);
    console.warn('ℹ️ Проверьте, что в package.json есть зависимость: @maxhub/max-bot-api');
    return false;
  }
}

async function sendSosMessage(target) {
  return sendMessage(
    target,
    `Если возникли какие-то вопросы, обязательно пишите [сюда](${SOS_SUPPORT_URL}).`,
    [
      [{ text: '❓ Написать сюда', url: SOS_SUPPORT_URL }],
      [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
    ]
  );
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

async function sendMessage(target, text, inlineKeyboard = null, extraAttachments = []) {
  const normalizedTarget = normalizeMaxTarget(target);
  const chunks = splitForMax(text);
  const results = [];

  for (let i = 0; i < chunks.length; i++) {
    const isLastChunk = i === chunks.length - 1;
    const attachments = isLastChunk && Array.isArray(extraAttachments)
      ? extraAttachments.filter(Boolean)
      : [];

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

async function deleteMaxMessageSafe(target, messageId) {
  const id = String(messageId || '').trim();
  if (!id) return false;

  let normalizedTarget = null;
  try {
    normalizedTarget = normalizeMaxTarget(target);
  } catch {
    normalizedTarget = null;
  }

  const targetQuery = normalizedTarget
    ? { [normalizedTarget.type]: normalizedTarget.id }
    : {};

  const attempts = [
    {
      path: `/messages/${encodeURIComponent(id)}`,
      query: targetQuery
    },
    {
      path: '/messages',
      query: {
        ...targetQuery,
        message_id: id
      }
    },
    {
      path: `/messages/${encodeURIComponent(id)}`,
      query: {}
    }
  ];

  for (const attempt of attempts) {
    try {
      await maxRequest(attempt.path, {
        method: 'DELETE',
        query: attempt.query
      });

      return true;
    } catch (error) {
      // MAX может запретить удаление или использовать другой endpoint.
      // Не ломаем сценарий: просто продолжаем и отправляем следующее сообщение.
    }
  }

  console.warn('Не удалось удалить сообщение MAX:', {
    message_id: id,
    target: normalizedTarget
  });

  return false;
}


function normalizeReceiptEmail(value) {
  const text = String(value || '').trim();
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

  if (match) return match[0].toLowerCase();
  return YOOKASSA_RECEIPT_EMAIL;
}

function priceRubToValue(priceRub) {
  const value = Number(String(priceRub || '0').replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Некорректная цена YooKassa: ${priceRub}`);
  }
  return value.toFixed(2);
}

function isYooKassaReady() {
  return Boolean(YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY && APP_BASE_URL);
}

async function yookassaRequest(path, options = {}) {
  if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
    throw new Error('YOOKASSA_SHOP_ID или YOOKASSA_SECRET_KEY не заданы');
  }

  const headers = {
    Authorization: `Basic ${Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64')}`
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (options.idempotenceKey) {
    headers['Idempotence-Key'] = options.idempotenceKey;
  }

  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || MAX_API_TIMEOUT_MS || 15000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${YOOKASSA_API_BASE}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`YooKassa API timeout after ${timeoutMs}ms: ${path}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const bodyText = await response.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = bodyText;
  }

  if (!response.ok) {
    const details = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`YooKassa API ${response.status}: ${details}`);
  }

  return body;
}

function buildYooKassaReceipt(description, priceValue, receiptEmail) {
  const email = normalizeReceiptEmail(receiptEmail);

  if (!email) {
    throw new Error('Email для чека не найден');
  }

  const receipt = {
    customer: { email },
    items: [
      {
        description: String(description || 'Услуга бота').slice(0, 128),
        quantity: '1.00',
        amount: {
          value: priceValue,
          currency: 'RUB'
        },
        vat_code: YOOKASSA_VAT_CODE,
        payment_mode: 'full_payment',
        payment_subject: 'service'
      }
    ]
  };

  if (YOOKASSA_TAX_SYSTEM_CODE) {
    receipt.tax_system_code = YOOKASSA_TAX_SYSTEM_CODE;
  }

  return receipt;
}

async function getYooKassaPayment(paymentId) {
  const id = encodeURIComponent(String(paymentId || '').trim());
  if (!id) throw new Error('Пустой paymentId YooKassa');
  return yookassaRequest(`/payments/${id}`, { method: 'GET' });
}

function getPromotionProductInfo(product) {
  const code = String(product || '').trim();

  if (code === PROMO_GENERAL_PRODUCT_CODE) {
    return {
      product: PROMO_GENERAL_PRODUCT_CODE,
      title: 'Публикация в нашем канале розыгрышей',
      shortTitle: 'Публикация в канале',
      priceRub: PROMO_GENERAL_PRICE_RUB,
      description: 'Публикация розыгрыша в канале розыгрышей'
    };
  }

  if (code === PROMO_BOT_PRODUCT_CODE) {
    return {
      product: PROMO_BOT_PRODUCT_CODE,
      title: 'Размещение в боте с 7000 пользователей',
      shortTitle: 'Размещение в боте 7000+',
      priceRub: PROMO_BOT_PRICE_RUB,
      description: 'Размещение розыгрыша в боте с аудиторией 7000 пользователей'
    };
  }

  return null;
}

function buildPaymentReturnUrl(raffleId, product) {
  const url = new URL(`${APP_BASE_URL}/payment/return`);
  if (raffleId) url.searchParams.set('raffle_id', String(raffleId));
  if (product) url.searchParams.set('product', String(product));
  return url.toString();
}

async function savePromotionPayment(payment, metadata = {}) {
  const paymentId = String(payment?.id || '').trim();
  if (!paymentId) throw new Error('YooKassa payment id is missing');

  await pool.query(`
    INSERT INTO raffle_promo_payments (
      payment_id,
      raffle_id,
      user_id,
      product,
      status,
      amount,
      currency,
      receipt_email,
      raw,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
    ON CONFLICT (payment_id)
    DO UPDATE SET
      raffle_id = COALESCE(EXCLUDED.raffle_id, raffle_promo_payments.raffle_id),
      user_id = COALESCE(EXCLUDED.user_id, raffle_promo_payments.user_id),
      product = COALESCE(EXCLUDED.product, raffle_promo_payments.product),
      status = EXCLUDED.status,
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      receipt_email = COALESCE(EXCLUDED.receipt_email, raffle_promo_payments.receipt_email),
      raw = EXCLUDED.raw,
      updated_at = NOW()
  `, [
    paymentId,
    metadata.raffle_id ? Number(metadata.raffle_id) : null,
    metadata.user_id ? String(metadata.user_id) : null,
    metadata.product || null,
    String(payment?.status || metadata.status || 'pending'),
    String(payment?.amount?.value || metadata.amount || '0.00'),
    String(payment?.amount?.currency || metadata.currency || 'RUB'),
    metadata.receipt_email || payment?.metadata?.receipt_email || null,
    JSON.stringify(payment || {})
  ]);
}

async function createPromotionPayment({ userId, raffleId, product, receiptEmail }) {
  const info = getPromotionProductInfo(product);
  if (!info) throw new Error('Неизвестный продукт продвижения');

  if (!isYooKassaReady()) {
    throw new Error('YooKassa не настроена: проверьте YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY и APP_BASE_URL');
  }

  const raffle = await getRaffleById(raffleId);
  if (!raffle) throw new Error('Розыгрыш не найден');

  if (Number(raffle.creator_user_id) !== Number(userId) && !isAdmin(userId)) {
    throw new Error('Оплатить продвижение может только организатор розыгрыша');
  }

  const email = normalizeReceiptEmail(receiptEmail);
  const priceValue = priceRubToValue(info.priceRub);
  const description = `${info.description} #${getRafflePublicNumber(raffle)}`.slice(0, 128);

  const metadata = {
    product: info.product,
    type: 'raffle_promo',
    user_id: String(userId),
    raffle_id: String(raffle.id),
    receipt_email: email
  };

  const payment = await yookassaRequest('/payments', {
    method: 'POST',
    idempotenceKey: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    body: {
      amount: {
        value: priceValue,
        currency: 'RUB'
      },
      confirmation: {
        type: 'redirect',
        return_url: buildPaymentReturnUrl(raffle.id, info.product)
      },
      capture: true,
      description,
      metadata,
      receipt: buildYooKassaReceipt(description, priceValue, email)
    }
  });

  await savePromotionPayment(payment, {
    ...metadata,
    amount: priceValue,
    currency: 'RUB'
  });

  return payment;
}

async function markPromotionPaymentSucceeded(payment) {
  const metadata = payment?.metadata || {};
  const paymentId = String(payment?.id || '').trim();
  if (!paymentId) return null;

  await savePromotionPayment(payment, {
    raffle_id: metadata.raffle_id,
    user_id: metadata.user_id,
    product: metadata.product,
    receipt_email: metadata.receipt_email,
    status: String(payment?.status || 'succeeded'),
    amount: payment?.amount?.value,
    currency: payment?.amount?.currency
  });

  const res = await pool.query(`
    UPDATE raffle_promo_payments
    SET
      status = $2,
      paid_at = COALESCE(paid_at, NOW()),
      updated_at = NOW()
    WHERE payment_id = $1
    RETURNING *
  `, [paymentId, String(payment?.status || 'succeeded')]);

  return res.rows[0] || null;
}

async function tryMarkPromotionPaymentApplied(paymentId) {
  const res = await pool.query(`
    UPDATE raffle_promo_payments
    SET applied = true, applied_at = NOW(), updated_at = NOW()
    WHERE payment_id = $1
      AND COALESCE(applied, false) = false
    RETURNING *
  `, [String(paymentId || '').trim()]);

  return res.rows[0] || null;
}

function buildPromotionOfferText(raffle) {
  const number = getRafflePublicNumber(raffle);

  return [
    '📣 **Хотите увеличить охват розыгрыша?**',
    '',
    `Для розыгрыша № **${number}** доступны платные размещения:`,
    '',
    `1. **Публикация в нашем канале розыгрышей** — ${Number(PROMO_GENERAL_PRICE_RUB).toFixed(0)} ₽.`,
    `После каждой оплаты бот поставит розыгрыш в очередь General-канала и опубликует в ближайшее свободное окно. Активный розыгрыш можно размещать повторно, интервал между платными публикациями — ${GENERAL_PROMO_SPACING_MINUTES} мин.`,
    '',
    `2. **Размещение в боте с 7000+ пользователей** — ${Number(PROMO_BOT_PRICE_RUB).toFixed(0)} ₽.`,
    'После оплаты администратор получит ваш ID и кликабельный профиль, затем свяжется с вами для размещения.',
    '',
    'Перед оплатой бот попросит email для чека.'
  ].join('\n');
}

function buildPromotionOfferKeyboard(raffle) {
  return [
    [{ text: `📢 В канал — ${Number(PROMO_GENERAL_PRICE_RUB).toFixed(0)} ₽`, callback_data: `promo_buy:${raffle.id}:${PROMO_GENERAL_PRODUCT_CODE}` }],
    [{ text: `🚀 В боте 7000+ — ${Number(PROMO_BOT_PRICE_RUB).toFixed(0)} ₽`, callback_data: `promo_buy:${raffle.id}:${PROMO_BOT_PRODUCT_CODE}` }]
  ];
}

async function sendPromotionOffer(target, userId, raffleIdOrRow) {
  const raffle = typeof raffleIdOrRow === 'object'
    ? raffleIdOrRow
    : await getRaffleById(raffleIdOrRow);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
  }

  if (Number(raffle.creator_user_id) !== Number(userId) && !isAdmin(userId)) {
    return sendMessage(target, '⛔ Купить продвижение может только организатор розыгрыша или админ бота.');
  }

  return sendMessage(target, buildPromotionOfferText(raffle), buildPromotionOfferKeyboard(raffle));
}

async function startPromotionPaymentEmailFlow(target, userId, raffleId, product) {
  const raffle = await getRaffleById(raffleId);
  const info = getPromotionProductInfo(product);

  if (!raffle || !info) {
    return sendMessage(target, 'Не удалось найти розыгрыш или услугу продвижения.');
  }

  if (Number(raffle.creator_user_id) !== Number(userId) && !isAdmin(userId)) {
    return sendMessage(target, '⛔ Оплатить продвижение может только организатор розыгрыша или админ бота.');
  }

  if (product === PROMO_GENERAL_PRODUCT_CODE && !GENERAL_CHANNEL_ID) {
    return sendMessage(target, '⚠️ GENERAL_CHANNEL_ID не задан в `.env`, поэтому публикация в общий канал пока недоступна.');
  }

  await setSession(userId, 'await_promo_receipt_email', {
    raffle_id: raffle.id,
    product
  });

  return sendMessage(
  target,
  [
    `🧾 **${info.title}**`,
    `Стоимость: **${Number(info.priceRub).toFixed(0)} ₽**`,
    '',
    'Введите email для чека одним сообщением.'
  ].join('\n')
);
}

async function handlePromotionEmailMessage(message, data = {}) {
  const userId = message.from.id;
  const target = message.chat.id;
  const email = normalizeReceiptEmail(message.text || '');
  const raffleId = Number(data.raffle_id);
  const product = String(data.product || '').trim();
  const info = getPromotionProductInfo(product);

  if (!Number.isInteger(raffleId) || !info) {
    await clearSession(userId);
    await sendMessage(target, 'Не удалось создать платёж: потерян ID розыгрыша или услуги. Откройте розыгрыш и нажмите кнопку покупки ещё раз.');
    return true;
  }

  try {
    const payment = await createPromotionPayment({
      userId,
      raffleId,
      product,
      receiptEmail: email
    });

    const confirmationUrl = payment?.confirmation?.confirmation_url;

    if (!confirmationUrl) {
      throw new Error(`YooKassa confirmation_url is missing: ${JSON.stringify(payment)}`);
    }

    await clearSession(userId);

    await sendMessage(
      target,
      [
        '✅ **Счёт создан**',
        '',
        `Услуга: **${info.title}**`,
        `Сумма: **${Number(info.priceRub).toFixed(0)} ₽**`,
        `Email для чека: **${email}**`,
        '',
        'Нажмите кнопку ниже, чтобы оплатить через YooKassa.'
      ].join('\n'),
      [[{ text: '💳 Оплатить', url: confirmationUrl }]]
    );
  } catch (error) {
    console.error('Promotion payment creation failed:', error);
    await sendMessage(
      target,
      [
        '⚠️ Не удалось создать платёж.',
        '',
        `Ошибка: ${safeText(error.message, 500)}`,
        '',
        'Проверьте настройки YooKassa в `.env` и попробуйте ещё раз.'
      ].join('\n')
    );
  }

  return true;
}

async function notifyPromoAdmins(text) {
  const adminIds = PROMO_ADMIN_IDS.size ? [...PROMO_ADMIN_IDS] : [...ADMIN_IDS];

  if (!adminIds.length) {
    console.warn('No admin ids configured for promo payment notification');
    return;
  }

  for (const adminId of adminIds) {
    await sendMessage(adminId, text).catch(error => {
      console.warn(`Не удалось отправить уведомление админу ${adminId}:`, error.message);
    });
  }
}

async function applyGeneralChannelPromoPayment(payment, row) {
  const raffleId = Number(row?.raffle_id || payment?.metadata?.raffle_id);
  const userId = String(row?.user_id || payment?.metadata?.user_id || '').trim();
  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    await sendMessage(userId, '✅ Оплата прошла, но розыгрыш не найден. Администратор проверит оплату вручную.').catch(() => {});
    await notifyPromoAdmins(`⚠️ Оплата публикации в General прошла, но розыгрыш #${raffleId} не найден. Payment: ${payment?.id}`);
    return;
  }

  if (!GENERAL_CHANNEL_ID) {
    await sendMessage(userId, '✅ Оплата прошла, но GENERAL_CHANNEL_ID не задан. Администратор проверит размещение вручную.').catch(() => {});
    await notifyPromoAdmins(`⚠️ Оплата публикации в General прошла, но GENERAL_CHANNEL_ID не задан. Розыгрыш #${getRafflePublicNumber(raffle)}, user ${userId}.`);
    return;
  }

  await updateRaffle(raffle.id, { publish_in_general: true });

  if (raffle.status === 'active') {
    const queueResult = await schedulePaidGeneralPublish(raffle.id, {
      userId,
      paymentId: payment?.id || row?.payment_id || '',
      reason: 'payment_succeeded_active_raffle'
    });

    await sendMessage(
      userId,
      [
        '✅ **Оплата прошла. Платное размещение принято.**',
        '',
        `Розыгрыш № **${getRafflePublicNumber(raffle)}**`,
        `Название: **${displayValue(raffle.title, 'Без названия')}**`,
        '',
        formatGeneralPromoQueueResult(queueResult)
      ].join('\n')
    ).catch(() => {});

    return;
  }

  await sendMessage(
    userId,
    [
      '✅ **Оплата прошла. Публикация в нашем канале включена.**',
      '',
      `Розыгрыш № **${getRafflePublicNumber(raffle)}** будет поставлен в очередь General-канала после запуска розыгрыша.`,
      `Интервал между платными публикациями — **${GENERAL_PROMO_SPACING_MINUTES} мин.**`
    ].join('\n')
  ).catch(() => {});
}

async function applyBotAudiencePromoPayment(payment, row) {
  const raffleId = Number(row?.raffle_id || payment?.metadata?.raffle_id);
  const userId = String(row?.user_id || payment?.metadata?.user_id || '').trim();
  const raffle = await getRaffleById(raffleId);
  const buyer = await getUserByMaxId(userId);
  const buyerText = formatPublicUser({
    user_id: userId,
    max_user_id: buyer?.max_user_id || userId,
    username: buyer?.username,
    first_name: buyer?.first_name,
    last_name: buyer?.last_name,
    profile_link: buyer?.profile_link
  });

  await sendMessage(
    userId,
    [
      '✅ **Оплата прошла. Заявка на размещение в боте с 7000+ пользователей принята.**',
      '',
      'Администратор получил ваши данные и свяжется с вами для размещения.'
    ].join('\n')
  ).catch(() => {});

  await notifyPromoAdmins([
    '💰 **Купили размещение в боте с 7000+ пользователей — 1200 ₽**',
    '',
    `Покупатель: ${buyerText}`,
    `ID покупателя: **${userId || 'не найден'}**`,
    buyer?.profile_link ? `Ссылка профиля: ${buyer.profile_link}` : '',
    '',
    raffle
      ? `Розыгрыш: № **${getRafflePublicNumber(raffle)}** — **${displayValue(raffle.title, 'Без названия')}**`
      : `Розыгрыш: #${raffleId || 'не найден'}`,
    `Payment ID: \`${payment?.id || ''}\``
  ].filter(Boolean).join('\n'));
}

async function applyPromotionPayment(payment) {
  const metadata = payment?.metadata || {};
  const product = String(metadata.product || '').trim();

  if (![PROMO_GENERAL_PRODUCT_CODE, PROMO_BOT_PRODUCT_CODE].includes(product)) {
    return false;
  }

  const saved = await markPromotionPaymentSucceeded(payment);
  const row = await tryMarkPromotionPaymentApplied(payment?.id);

  if (!row) {
    console.log('Promotion payment already applied or not found:', payment?.id);
    return true;
  }

  if (product === PROMO_GENERAL_PRODUCT_CODE) {
    await applyGeneralChannelPromoPayment(payment, saved || row);
    return true;
  }

  if (product === PROMO_BOT_PRODUCT_CODE) {
    await applyBotAudiencePromoPayment(payment, saved || row);
    return true;
  }

  return true;
}

async function handleYooKassaWebhook(req, res) {
  res.status(200).json({ ok: true });

  const notification = req.body;

  (async () => {
    try {
      const event = String(notification?.event || '');
      const object = notification?.object || {};
      const paymentId = String(object?.id || '').trim();

      if (event !== 'payment.succeeded' || !paymentId) {
        return;
      }

      const payment = await getYooKassaPayment(paymentId);
      await applyPromotionPayment(payment);
    } catch (error) {
      console.error('YooKassa webhook processing failed:', error);
    }
  })();
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


function normalizeHttpLink(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  if (!/^https?:\/\//i.test(text)) return '';

  try {
    const url = new URL(text);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeMaxPostToken(value) {
  const token = String(value || '').trim();

  if (!token) return '';
  if (token.startsWith('mid.')) return '';
  if (/^\d+$/.test(token)) return '';
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(token)) return '';

  return token;
}

function findTokenByKeyDeep(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return '';

  const tokenKeyPattern = /(post|share|public|short|message|link).*(token|code|slug|hash|id)$|^(token|code|slug|hash|public_id|publicId|share_token|shareToken|link_token|linkToken|short_id|shortId)$/i;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findTokenByKeyDeep(item, depth + 1);
      if (found) return found;
    }
    return '';
  }

  for (const [key, value] of Object.entries(obj)) {
    if (tokenKeyPattern.test(key)) {
      const token = normalizeMaxPostToken(value);
      if (token) return token;
    }
  }

  for (const value of Object.values(obj)) {
    const found = findTokenByKeyDeep(value, depth + 1);
    if (found) return found;
  }

  return '';
}

function extractMaxPostToken(result) {
  const candidates = [
    result?.message?.post_token,
    result?.message?.postToken,
    result?.message?.share_token,
    result?.message?.shareToken,
    result?.message?.link_token,
    result?.message?.linkToken,
    result?.message?.public_token,
    result?.message?.publicToken,
    result?.message?.public_id,
    result?.message?.publicId,
    result?.message?.short_id,
    result?.message?.shortId,
    result?.message?.code,
    result?.message?.token,
    result?.message?.body?.post_token,
    result?.message?.body?.postToken,
    result?.message?.body?.share_token,
    result?.message?.body?.shareToken,
    result?.message?.body?.link_token,
    result?.message?.body?.linkToken,
    result?.message?.body?.public_token,
    result?.message?.body?.publicToken,
    result?.message?.body?.public_id,
    result?.message?.body?.publicId,
    result?.message?.body?.short_id,
    result?.message?.body?.shortId,
    result?.message?.body?.code,
    result?.message?.body?.token,
    result?.body?.post_token,
    result?.body?.postToken,
    result?.body?.share_token,
    result?.body?.shareToken,
    result?.body?.link_token,
    result?.body?.linkToken,
    result?.body?.public_token,
    result?.body?.publicToken,
    result?.body?.public_id,
    result?.body?.publicId,
    result?.body?.short_id,
    result?.body?.shortId,
    result?.body?.code,
    result?.body?.token,
    result?.post_token,
    result?.postToken,
    result?.share_token,
    result?.shareToken,
    result?.link_token,
    result?.linkToken,
    result?.public_token,
    result?.publicToken,
    result?.public_id,
    result?.publicId,
    result?.short_id,
    result?.shortId,
    result?.code,
    result?.token
  ];

  for (const value of candidates) {
    const token = normalizeMaxPostToken(value);
    if (token) return token;
  }

  return findTokenByKeyDeep(result);
}

function buildPostUrlFromToken(token) {
  const cleanToken = normalizeMaxPostToken(token);
  const base = String(MAX_POST_URL_BASE || '').trim().replace(/\/+$/, '');

  if (!cleanToken || !base) return '';

  return normalizeHttpLink(`${base}/${encodeURIComponent(cleanToken)}`);
}

function extractMaxPostUrl(result) {
  const candidates = [
    result?.message?.link,
    result?.message?.url,
    result?.message?.web_url,
    result?.message?.webUrl,
    result?.message?.permalink,
    result?.message?.message_link,
    result?.message?.messageLink,
    result?.message?.body?.link,
    result?.message?.body?.url,
    result?.message?.body?.web_url,
    result?.message?.body?.webUrl,
    result?.message?.body?.permalink,
    result?.body?.link,
    result?.body?.url,
    result?.body?.web_url,
    result?.body?.permalink,
    result?.link,
    result?.url,
    result?.web_url,
    result?.permalink
  ];

  for (const value of candidates) {
    const link = normalizeHttpLink(value);
    if (link) return link;
  }

  return buildPostUrlFromToken(extractMaxPostToken(result));
}

function buildPostUrlFromTemplate(channelId, messageId, channelLink = '') {
  const template = String(MAX_POST_LINK_TEMPLATE || '').trim();
  const cleanMessageId = String(messageId || '').trim();

  if (!template || !cleanMessageId) return '';

  const cleanChannelId = String(channelId || '').trim();
  const cleanChannelLink = String(channelLink || '').trim().replace(/\/+$/, '');

  const url = template
    .replace(/\{channel_id\}/g, encodeURIComponent(cleanChannelId))
    .replace(/\{chat_id\}/g, encodeURIComponent(cleanChannelId))
    .replace(/\{message_id\}/g, encodeURIComponent(cleanMessageId))
    .replace(/\{mid\}/g, encodeURIComponent(cleanMessageId))
    .replace(/\{channel_link\}/g, cleanChannelLink);

  return normalizeHttpLink(url);
}

function buildRafflePostUrl(channelId, messageId, channelLink = '', savedPostUrl = '') {
  const saved = normalizeHttpLink(savedPostUrl);
  if (saved) return saved;

  const fromTemplate = buildPostUrlFromTemplate(channelId, messageId, channelLink);
  if (fromTemplate) return fromTemplate;

  return '';
}

async function getBestRafflePostForLink(raffleId) {
  const generalChannelId = String(GENERAL_CHANNEL_ID || '').trim();

  const res = await pool.query(`
    SELECT
      rp.*,
      COALESCE(rc.channel_title, uc.channel_title, bsc.chat_title) AS channel_title,
      COALESCE(rc.channel_link, uc.channel_link, bsc.chat_link) AS channel_link,
      CASE WHEN $2 <> '' AND rp.channel_id::text = $2 THEN true ELSE false END AS is_general
    FROM raffle_posts rp
    LEFT JOIN raffle_channels rc
      ON rc.raffle_id = rp.raffle_id
     AND rc.channel_id = rp.channel_id
    LEFT JOIN user_channels uc
      ON uc.channel_id = rp.channel_id
    LEFT JOIN bot_seen_chats bsc
      ON bsc.chat_id = rp.channel_id
    WHERE rp.raffle_id = $1
    ORDER BY
      CASE WHEN $2 <> '' AND rp.channel_id::text = $2 THEN 0 ELSE 1 END,
      rp.created_at DESC,
      rp.id DESC
    LIMIT 1
  `, [raffleId, generalChannelId]);

  const post = res.rows[0] || null;
  if (!post) {
    return {
      hasPost: false,
      url: '',
      isGeneral: false,
      channelTitle: ''
    };
  }

  const url = buildRafflePostUrl(
    post.channel_id,
    post.message_id,
    post.channel_link,
    post.post_url
  );

  return {
    hasPost: true,
    url,
    isGeneral: Boolean(post.is_general),
    channelTitle: post.is_general
      ? 'General'
      : displayValue(post.channel_title, post.channel_id ? `Канал ${post.channel_id}` : 'канал')
  };
}




async function saveManualRafflePostUrl(target, userId, raffleId, postUrl) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    await sendMessage(target, 'Розыгрыш не найден.');
    return;
  }

  if (String(raffle.creator_user_id) !== String(userId) && !isAdmin(userId)) {
    await sendMessage(target, '⛔ Ссылку на пост может сохранить только создатель розыгрыша или админ.');
    return;
  }

  const cleanUrl = normalizeHttpLink(postUrl);
  if (!cleanUrl) {
    await sendMessage(
      target,
      [
        'Не вижу корректную ссылку на пост.',
        '',
        'Пример:',
        '`/postlink 38 https://max.ru/id231711659887_biz/AZ6d5qhScfI`'
      ].join('\n')
    );
    return;
  }

  const generalChannelId = String(GENERAL_CHANNEL_ID || '').trim();

  const updateRes = await pool.query(`
    WITH target_post AS (
      SELECT id
      FROM raffle_posts
      WHERE raffle_id = $1
      ORDER BY
        CASE WHEN $3 <> '' AND channel_id::text = $3 THEN 0 ELSE 1 END,
        created_at DESC,
        id DESC
      LIMIT 1
    )
    UPDATE raffle_posts rp
    SET post_url = $2, updated_at = NOW()
    FROM target_post tp
    WHERE rp.id = tp.id
    RETURNING rp.*
  `, [raffle.id, cleanUrl, generalChannelId]);

  let savedPost = updateRes.rows[0] || null;

  if (!savedPost) {
    const insertRes = await pool.query(`
      INSERT INTO raffle_posts (raffle_id, channel_id, message_id, post_url, participants_count, updated_at)
      VALUES ($1, $2, NULL, $3, 0, NOW())
      RETURNING *
    `, [
      raffle.id,
      generalChannelId ? Number(generalChannelId) : null,
      cleanUrl
    ]);

    savedPost = insertRes.rows[0] || null;
  }

  await sendMessage(
    target,
    [
      '✅ Ссылка на пост сохранена.',
      '',
      `Розыгрыш: **#${getRafflePublicNumber(raffle)} — ${displayValue(raffle.title, 'Без названия')}**`,
      `Пост: ${markdownLink('открыть', cleanUrl)}`,
      '',
      'Теперь в **Мои розыгрыши** название будет кликабельным.'
    ].join('\n'),
    [
      [{ text: '🔎 Мои розыгрыши', callback_data: 'my_raffles' }],
      [{ text: '🔗 Открыть пост', url: cleanUrl }]
    ]
  );
}

function parsePostLinkCommand(text) {
  const clean = String(text || '').trim();
  const m = clean.match(/^\/(?:postlink|post_link|linkpost|постссылка)\s+(\d+)\s+(https?:\/\/\S+)/i);
  if (!m) return null;
  return {
    raffleId: Number(m[1]),
    url: m[2]
  };
}

function parseDeleteCollaboratorCommand(text) {
  const clean = String(text || '').trim();
  const m = clean.match(/^\/(?:delcollaber|delcollabor|delcollab|delcollaborator)\s+(-?\d+)(?:\s+(\d+))?$/i);
  if (!m) return null;

  return {
    channelId: String(m[1]).trim(),
    raffleId: m[2] ? Number(m[2]) : null
  };
}

async function editMaxMessageText(target, messageId, text, inlineKeyboard = null, extraAttachments = []) {
  const id = String(messageId || '').trim();
  if (!id) return false;

  const normalizedTarget = normalizeMaxTarget(target);
  const attachments = Array.isArray(extraAttachments)
    ? extraAttachments.filter(Boolean)
    : [];

  if (inlineKeyboard) {
    attachments.push(convertInlineKeyboardToMax(inlineKeyboard));
  }

  const body = {
    text: String(text || ''),
    attachments: attachments.length ? attachments : undefined,
    format: 'markdown'
  };

  // У MAX Bot API на разных сборках встречались разные варианты endpoint для редактирования.
  // Пробуем несколько безопасных вариантов. Если ни один не сработал — просто логируем,
  // чтобы бот не падал и розыгрыш продолжал работать.
  const attempts = [
    {
      path: `/messages/${encodeURIComponent(id)}`,
      method: 'PATCH',
      query: { [normalizedTarget.type]: normalizedTarget.id },
      body
    },
    {
      path: `/messages/${encodeURIComponent(id)}`,
      method: 'PUT',
      query: { [normalizedTarget.type]: normalizedTarget.id },
      body
    },
    {
      path: '/messages',
      method: 'PATCH',
      query: { [normalizedTarget.type]: normalizedTarget.id, message_id: id },
      body
    },
    {
      path: '/messages',
      method: 'PUT',
      query: { [normalizedTarget.type]: normalizedTarget.id, message_id: id },
      body
    }
  ];

  for (const attempt of attempts) {
    try {
      await maxRequest(attempt.path, {
        method: attempt.method,
        query: attempt.query,
        body: attempt.body
      });

      return true;
    } catch (error) {
      // Пробуем следующий вариант.
    }
  }

  console.warn('Не удалось отредактировать MAX сообщение:', {
    message_id: id,
    target: normalizedTarget,
    raffle_update: true
  });

  return false;
}


function extractMessageAttachments(update) {
  const candidates = [
    update?.message?.body?.attachments,
    update?.message?.attachments,
    update?.body?.attachments,
    update?.attachments
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

function isPhotoLikeAttachment(attachment) {
  const type = String(attachment?.type || attachment?.attachment_type || '').toLowerCase();
  const mediaType = String(attachment?.payload?.type || attachment?.payload?.media_type || '').toLowerCase();
  const mime = String(attachment?.payload?.mime_type || attachment?.mime_type || '').toLowerCase();

  return type.includes('image') ||
    type.includes('photo') ||
    mediaType.includes('image') ||
    mediaType.includes('photo') ||
    mime.startsWith('image/');
}

function normalizeAttachmentForReuse(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;

  // MAX обычно возвращает attachment уже в формате, который можно попробовать отправить обратно.
  // Оставляем только безопасные части, чтобы не тащить лишние поля сообщения.
  const normalized = {
    type: attachment.type || attachment.attachment_type || 'image'
  };

  if (attachment.payload && typeof attachment.payload === 'object') {
    normalized.payload = attachment.payload;
  }

  if (attachment.url) normalized.url = attachment.url;
  if (attachment.file_id) normalized.file_id = attachment.file_id;
  if (attachment.photo_id) normalized.photo_id = attachment.photo_id;
  if (attachment.image_id) normalized.image_id = attachment.image_id;

  return normalized.payload || normalized.url || normalized.file_id || normalized.photo_id || normalized.image_id
    ? normalized
    : attachment;
}

function extractFirstPhotoAttachmentFromMessage(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const photo = attachments.find(isPhotoLikeAttachment);
  return normalizeAttachmentForReuse(photo);
}

function normalizeStoredPhotoAttachment(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (typeof value === 'object') return value;

  return null;
}

function getRafflePhotoAttachments(raffleOrData = {}) {
  const photo = normalizeStoredPhotoAttachment(
    raffleOrData.photo_attachment ||
    raffleOrData.photoAttachment ||
    raffleOrData.photo
  );

  return photo ? [photo] : [];
}


function safeCallbackPart(value) {
  return encodeURIComponent(String(value || '').trim());
}

function unsafeCallbackPart(value) {
  return decodeURIComponent(String(value || '').trim());
}

function truncateButtonText(text, max = 42) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function markdownLink(text, url) {
  const cleanText = String(text || '').replace(/[\[\]\n\r]/g, ' ').trim();
  const cleanUrl = String(url || '').trim();

  if (!cleanUrl) return cleanText || 'Канал';

  return `[${cleanText || 'Канал'}](${cleanUrl})`;
}

function formatChannelName(channel) {
  return String(
    channel?.channel_title ||
    channel?.title ||
    channel?.name ||
    'Канал'
  ).trim() || 'Канал';
}

function buildChannelPublicLink(channel) {
  const directLink = String(channel?.channel_link || channel?.link || '').trim();

  if (directLink) return directLink;

  const channelId = String(channel?.channel_id || channel?.chat_id || channel?.id || '').trim();

  if (channelId && MAX_CHANNEL_LINK_TEMPLATE) {
    return MAX_CHANNEL_LINK_TEMPLATE
      .replace(/\{id\}/g, encodeURIComponent(channelId))
      .replace(/\{channel_id\}/g, encodeURIComponent(channelId));
  }

  return '';
}

function formatChannelWithLink(channel) {
  const title = formatChannelName(channel);
  const link = buildChannelPublicLink(channel);

  return link ? markdownLink(title, link) : title;
}

function buildRafflePublicChannelsText(channels = []) {
  if (!channels.length) {
    return '';
  }

  const unique = [];
  const seen = new Set();

  for (const channel of channels) {
    const key = String(channel?.channel_id || channel?.chat_id || channel?.id || formatChannelName(channel)).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(channel);
  }

  if (!unique.length) return '';

  const lines = unique.map((channel, index) => {
    // В публичных постах и сообщениях участникам не показываем, какие каналы обязательные,
    // чтобы условия были видны только организатору на этапах настройки/предпросмотра.
    return `${index + 1}. ${formatChannelWithLink(channel)}`;
  });

  return [
    '📢 **Подписаться на каналы:**',
    ...lines
  ].join('\n');
}

function buildBotDeepLink(payload = '') {
  const base = BOT_PUBLIC_URL || APP_BASE_URL;
  const cleanPayload = String(payload || '').trim();

  if (!cleanPayload) return base;

  const separator = base.includes('?') ? '&' : '?';

  return `${base}${separator}start=${encodeURIComponent(cleanPayload)}`;
}

function buildBotBrandKeyboard(extraRows = []) {
  const rows = [...extraRows];

  if (BOT_PUBLIC_URL) {
    rows.push([
      {
        text: BOT_BRAND_NAME,
        url: BOT_PUBLIC_URL
      }
    ]);
  }

  return rows;
}

function buildBotBrandLine() {
  return `Розыгрыш создан с помощью ${markdownLink(BOT_BRAND_NAME, BOT_PUBLIC_URL)}`;
}

function buildMorePrizesLine() {
  return `Еще больше призов 🥳 ${markdownLink(MORE_PRIZES_LABEL, MORE_PRIZES_URL || BOT_PUBLIC_URL)}`;
}

function getRafflePublicNumber(raffle) {
  return Number(raffle?.public_number || raffle?.id || 0) || raffle?.id || '';
}

function buildRaffleNumberLine(raffle) {
  const number = getRafflePublicNumber(raffle);
  // MAX не даёт надёжного CSS-выравнивания внутри текстового поста, поэтому номер ставится последней строкой.
  // Полноширинные пробелы помогают визуально увести номер вправо в клиентах, которые их сохраняют.
  return `　　　　　　　　　№ ${number}`;
}

function buildRaffleFooter(raffle) {
  return [
    buildBotBrandLine(),
    buildMorePrizesLine(),
    buildRaffleNumberLine(raffle)
  ].join('\n');
}

function normalizeUsername(username) {
  return String(username || '').replace(/^@/, '').trim();
}

function normalizeMaxProfileLink(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  let url = raw;

  if (url.startsWith('max.ru/')) {
    url = `https://${url}`;
  }

  if (!/^https?:\/\//i.test(url)) return '';

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();

    if (host !== 'max.ru') return '';

    // Поддерживаем настоящие публичные ссылки MAX:
    // https://max.ru/u/<token> и https://max.ru/<username>.
    // Не принимаем синтетические /id123, потому что они ведут на 404.
    if (/^\/u\/[A-Za-z0-9_-]+\/?$/i.test(parsed.pathname)) {
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    }

    if (/^\/[A-Za-z0-9_.-]+\/?$/i.test(parsed.pathname) && !/^\/id\d+\/?$/i.test(parsed.pathname)) {
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    }
  } catch {
    return '';
  }

  return '';
}

function looksLikeMaxOpaqueToken(value) {
  const token = String(value || '').trim();
  // MAX profile tokens and callback_id values are opaque base64url-like strings.
  // Не используем короткие значения, чтобы не превращать payload кнопок в ссылки.
  return /^[A-Za-z0-9_-]{40,}$/.test(token);
}

function buildMaxUserLinkFromCallbackId(callbackId) {
  // callback_id — это ID нажатия кнопки, а не токен профиля пользователя.
  // Из него нельзя строить ссылку https://max.ru/u/..., иначе MAX открывает “не найдено”.
  return '';
}

function extractCallbackProfileLinkFromUpdate(update) {
  return '';
}


function extractUserProfileLinkFromObject(obj) {
  if (!obj || typeof obj !== 'object') return '';

  const candidates = [
    obj.profile_link,
    obj.profileLink,
    obj.profile_url,
    obj.profileUrl,
    obj.web_url,
    obj.webUrl,
    obj.public_link,
    obj.publicLink,
    obj.link,
    obj.url,
    obj.user?.profile_link,
    obj.user?.profile_url,
    obj.user?.web_url,
    obj.user?.link,
    obj.result?.profile_link,
    obj.result?.profile_url,
    obj.result?.web_url,
    obj.result?.link,
    obj.payload?.profile_link,
    obj.payload?.profile_url,
    obj.payload?.web_url,
    obj.payload?.link
  ];

  for (const value of candidates) {
    const link = normalizeMaxProfileLink(value);
    if (link) return link;
  }

  const username = normalizeUsername(obj.username || obj.login || obj.screen_name || obj.screenName || '');
  return username ? `https://max.ru/${username}` : '';
}


function isBotProfileAccidentallySavedForUser(user) {
  const userId = String(user?.user_id || user?.max_user_id || '').trim();
  const botId = String(BOT_USER_ID || '').trim();
  const username = normalizeUsername(user?.username || user?.login);
  const botUsername = normalizeUsername(BOT_USERNAME);

  // В callback-сообщениях MAX рядом есть callback.user и message.sender.
  // Если случайно сохранить profile из message.sender, реальный участник начинает отображаться как бот.
  // Для чужого user_id такой профиль игнорируем при выводе, чтобы в итогах не было “SMM Хэлпер” вместо участника.
  if (userId && botId && String(userId) === String(botId)) return false;
  if (username && botUsername && username === botUsername) return true;

  return false;
}

function buildMaxUserMentionLink(user) {
  const userId = String(user?.user_id || user?.max_user_id || '').trim();

  if (!userId) return '';

  // Официальный формат MAX для кликабельного упоминания пользователя в сообщении:
  // Markdown: [Имя Фамилия](max://user/user_id)
  // Это не web-ссылка https://max.ru/..., а внутренний deep-link приложения MAX.
  return `max://user/${encodeURIComponent(userId)}`;
}

function buildUserProfileLink(user) {
  const userId = String(user?.user_id || user?.max_user_id || '').trim();
  const botId = String(BOT_USER_ID || '').trim();
  const username = normalizeUsername(user?.username || user?.login);
  const savedLink = normalizeMaxProfileLink(user?.profile_link || user?.profileLink || user?.profile_url || user?.profileUrl || '');

  if (!isBotProfileAccidentallySavedForUser(user) && savedLink) {
    return savedLink;
  }

  if (!isBotProfileAccidentallySavedForUser(user) && username) {
    return `https://max.ru/${username}`;
  }

  if (userId && MAX_USER_LINK_TEMPLATE) {
    const templated = normalizeMaxProfileLink(
      MAX_USER_LINK_TEMPLATE
        .replace(/\{id\}/g, encodeURIComponent(userId))
        .replace(/\{user_id\}/g, encodeURIComponent(userId))
        .replace(/\{max_user_id\}/g, encodeURIComponent(userId))
    );

    if (templated) return templated;
  }

  // Если это точно сам бот, ссылку на бота оставляем.
  if (userId && botId && String(userId) === String(botId) && username) {
    return `https://max.ru/${username}`;
  }

  return '';
}

function buildUserDisplayName(user) {
  const userId = String(user?.user_id || user?.max_user_id || '').trim();
  const username = normalizeUsername(user?.username || user?.login);

  if (!isBotProfileAccidentallySavedForUser(user)) {
    const firstName = String(user?.first_name || user?.firstName || '').trim();
    const lastName = String(user?.last_name || user?.lastName || '').trim();
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();

    if (fullName) return fullName;
    if (username) return `@${username}`;
  }

  return userId ? `Пользователь ${userId}` : 'Пользователь';
}

function formatPublicUser(user) {
  const name = buildUserDisplayName(user);
  const mentionLink = buildMaxUserMentionLink(user);
  const userId = String(user?.user_id || user?.max_user_id || '').trim();

  // Для победителей и организатора используем официальный MAX mention,
  // чтобы нажатие по имени открывало карточку/диалог пользователя в приложении MAX.
  // Не используем https://max.ru/id... и не используем callback_id.
  if (mentionLink) return markdownLink(name, mentionLink);
  if (userId) return `${name} (${userId})`;
  return name;
}

function buildRaffleInviteLink(token) {
  return `${APP_BASE_URL}/collab/${encodeURIComponent(String(token))}`;
}

function buildJoinLink(raffleId, ref = '') {
  const query = ref ? `?ref=${encodeURIComponent(String(ref))}` : '';
  return `${APP_BASE_URL}/join/${raffleId}${query}`;
}

function isRaffleInviteActive(invite) {
  if (!invite) return false;
  if (invite.is_active === false) return false;
  if (invite.closed_at) return false;
  return true;
}

function formatRaffleInviteStatus(invite) {
  return isRaffleInviteActive(invite)
    ? '🟢 открыта'
    : '🔒 закрыта';
}

function buildCollabInviteDisplay(invite) {
  if (!invite?.token) {
    return 'Ссылка не найдена.';
  }

  if (!isRaffleInviteActive(invite)) {
    return [
      '🔒 Ссылка закрыта организатором.',
      'Новые соадмины больше не смогут подключать каналы по этой ссылке.'
    ].join('\n');
  }

  return buildRaffleInviteLink(invite.token);
}

function buildCollabInviteBlock(invite) {
  const display = buildCollabInviteDisplay(invite);

  if (!invite?.token || !isRaffleInviteActive(invite)) {
    return display;
  }

  return [
    display,
    '',
    'Если ссылка не открывается, соадмин может написать боту:',
    `\`/collab ${invite.token}\``
  ].join('\n');
}

function isChatTarget(target) {
  return target && target.type === 'chat_id' && String(target.id || '').trim();
}

function isDialogLikeRecipient(recipient) {
  if (!recipient || typeof recipient !== 'object') return false;

  const type = String(
    recipient.chat_type ||
    recipient.chatType ||
    recipient.type ||
    recipient.kind ||
    ''
  ).toLowerCase();

  return type.includes('dialog') || type.includes('private') || type.includes('user');
}

function isChannelIdLike(value) {
  return String(value || '').trim().startsWith('-');
}

function isChannelTarget(target) {
  return Boolean(isChatTarget(target) && isChannelIdLike(target.id));
}

function isBotRemovedUpdate(update) {
  const updateType = String(update?.update_type || '').toLowerCase();

  return updateType === 'bot_removed' ||
    updateType === 'bot_left' ||
    updateType === 'bot_kicked' ||
    updateType.includes('bot_removed') ||
    updateType.includes('bot_left') ||
    updateType.includes('bot_kicked');
}

function isBotAddedOrUpdatedUpdate(update) {
  const updateType = String(update?.update_type || '').toLowerCase();

  return updateType === 'bot_added' ||
    updateType === 'bot_updated' ||
    updateType === 'bot_member_updated' ||
    updateType === 'chat_member_updated' ||
    updateType.includes('bot_added') ||
    updateType.includes('bot_updated') ||
    updateType.includes('member_updated') ||
    updateType.includes('bot_admin');
}

function isTrustedChannelAttachUpdate(update) {
  const updateType = String(update?.update_type || '').toLowerCase();

  return updateType === 'bot_added' ||
    updateType === 'bot_updated' ||
    updateType === 'bot_member_updated' ||
    updateType.includes('bot_added') ||
    updateType.includes('bot_updated') ||
    updateType.includes('bot_admin');
}

function isSeenChatLinkedByUser(candidate, userId) {
  if (!candidate || !userId) return false;

  const actor = String(candidate.last_actor_user_id || '').trim();
  if (actor !== String(userId)) return false;

  const updateType = String(candidate.source_update_type || '').toLowerCase();

  return updateType === 'bot_added' ||
    updateType === 'bot_updated' ||
    updateType === 'bot_member_updated' ||
    updateType.includes('bot_added') ||
    updateType.includes('bot_updated') ||
    updateType.includes('bot_admin');
}

function extractChatTitleFromUpdate(update, chatId = '') {
  const candidates = [
    update?.message?.recipient?.chat_title,
    update?.message?.recipient?.title,
    update?.message?.recipient?.name,
    update?.message?.chat?.title,
    update?.message?.chat?.name,
    update?.chat?.title,
    update?.chat?.name,
    update?.recipient?.chat_title,
    update?.recipient?.title,
    update?.recipient?.name,
    update?.callback?.message?.recipient?.chat_title,
    update?.callback?.message?.recipient?.title,
    update?.callback?.message?.chat?.title
  ];

  for (const value of candidates) {
    const text = String(value || '').trim();
    if (text) return text;
  }

  return chatId ? `Канал ${chatId}` : 'Канал';
}

function extractChatLinkFromObject(obj) {
  if (!obj || typeof obj !== 'object') return '';

  const candidates = [
    obj.link,
    obj.url,
    obj.web_url,
    obj.webUrl,
    obj.public_link,
    obj.publicLink,
    obj.invite_link,
    obj.inviteLink,
    obj.chat_link,
    obj.chatLink,
    obj.result?.link,
    obj.result?.url,
    obj.result?.web_url,
    obj.result?.public_link,
    obj.payload?.link,
    obj.payload?.url,
    obj.payload?.web_url,
    obj.payload?.public_link
  ];

  for (const value of candidates) {
    const text = String(value || '').trim();
    if (text.startsWith('http://') || text.startsWith('https://')) return text;
  }

  const username = String(
    obj.username ||
    obj.login ||
    obj.screen_name ||
    obj.screenName ||
    obj.result?.username ||
    obj.result?.login ||
    obj.payload?.username ||
    ''
  ).replace(/^@/, '').trim();

  if (username) return `https://max.ru/${username}`;

  return '';
}

function extractChatLinkFromUpdate(update) {
  return extractChatLinkFromObject(update?.message?.recipient) ||
    extractChatLinkFromObject(update?.message?.chat) ||
    extractChatLinkFromObject(update?.chat) ||
    extractChatLinkFromObject(update?.recipient) ||
    extractChatLinkFromObject(update?.callback?.message?.recipient) ||
    '';
}

async function getChatInfoSafe(chatId) {
  const encodedChatId = encodeURIComponent(String(chatId).trim());

  try {
    const result = await maxRequest(`/chats/${encodedChatId}`, {
      method: 'GET'
    });

    return result;
  } catch (error) {
    console.warn(`Не удалось получить информацию о чате ${chatId}:`, error.message);
    return null;
  }
}

function extractTitleFromChatInfo(info) {
  if (!info) return '';

  const candidates = [
    info.title,
    info.name,
    info.chat_title,
    info.chat?.title,
    info.chat?.name,
    info.result?.title,
    info.result?.name,
    info.payload?.title,
    info.payload?.name
  ];

  for (const value of candidates) {
    const text = String(value || '').trim();
    if (text) return text;
  }

  return '';
}

async function resolveChannelMeta(channelId, update = null) {
  const info = await getChatInfoSafe(channelId);

  return {
    title: extractTitleFromChatInfo(info) ||
      extractChatTitleFromUpdate(update, channelId),
    link: extractChatLinkFromObject(info) ||
      extractChatLinkFromUpdate(update)
  };
}


function pickFirstDefinedBoolean(values) {
  for (const value of values) {
    if (value === true || value === false) return value;
  }

  return null;
}

function getMemberRoleText(member) {
  if (!member || typeof member !== 'object') return '';

  const values = [
    member.role,
    member.status,
    member.member_role,
    member.memberRole,
    member.chat_role,
    member.chatRole,
    member.membership?.role,
    member.membership?.status,
    member.member?.role,
    member.member?.status,
    member.permissions?.role,
    member.user?.role,
    member.profile?.role
  ];

  return values
    .map(value => String(value || '').toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function isAdminLikeMember(member) {
  const roleText = getMemberRoleText(member);

  return ['owner', 'creator', 'admin', 'administrator', 'moderator']
    .some(role => roleText.includes(role));
}

function extractCanPublishPermission(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const permissions = obj.permissions || obj.rights || obj.privileges || obj.chat_permissions || obj.chatPermissions || {};
  const memberPermissions = obj.member?.permissions || obj.membership?.permissions || obj.user?.permissions || {};

  return pickFirstDefinedBoolean([
    obj.can_publish,
    obj.canPublish,
    obj.can_post,
    obj.canPost,
    obj.can_post_messages,
    obj.canPostMessages,
    obj.can_send_messages,
    obj.canSendMessages,
    obj.can_write,
    obj.canWrite,
    permissions.can_publish,
    permissions.canPublish,
    permissions.can_post,
    permissions.canPost,
    permissions.can_post_messages,
    permissions.canPostMessages,
    permissions.can_send_messages,
    permissions.canSendMessages,
    permissions.can_write,
    permissions.canWrite,
    memberPermissions.can_publish,
    memberPermissions.canPublish,
    memberPermissions.can_post,
    memberPermissions.canPost,
    memberPermissions.can_post_messages,
    memberPermissions.canPostMessages,
    memberPermissions.can_send_messages,
    memberPermissions.canSendMessages
  ]);
}

function findMemberInResponse(body, userId) {
  const expectedUserId = String(userId || '').trim();
  if (!expectedUserId) return null;

  if (getMemberUserId(body) === expectedUserId) return body;

  const members = extractMembersFromMaxResponse(body);
  return members.find(member => getMemberUserId(member) === expectedUserId) || null;
}

async function fetchChatMemberSafe(chatId, userId) {
  const expectedUserId = String(userId || '').trim();
  const cleanChatId = String(chatId || '').trim();

  if (!expectedUserId || !cleanChatId) return null;

  // /chats/{id}/members в MAX работает для каналов/чатов, но не для личных диалогов.
  // Личные dialog chat_id обычно положительные, каналы в этом боте используются с отрицательными ID.
  if (!isChannelIdLike(cleanChatId)) {
    return null;
  }

  const encodedChannelId = encodeURIComponent(cleanChatId);
  const path = `/chats/${encodedChannelId}/members`;

  const queries = [
    { user_id: expectedUserId },
    { user_ids: expectedUserId },
    { count: 100, user_id: expectedUserId },
    { count: 100, user_ids: expectedUserId }
  ];

  for (const query of queries) {
    try {
      const result = await maxRequest(path, { method: 'GET', query });
      const member = findMemberInResponse(result, expectedUserId);
      if (member) return member;
    } catch (error) {
      console.warn(`Не удалось проверить участника ${expectedUserId} в канале ${chatId}:`, error.message);
    }
  }

  return null;
}

async function isUserAdminInChannel(userId, channelId) {
  const member = await fetchChatMemberSafe(channelId, userId);
  if (!member || !isMemberActive(member)) return false;
  return isAdminLikeMember(member);
}

async function checkBotCanPublishInChannel(channelId, info = null) {
  const infoPermission = extractCanPublishPermission(info);

  if (infoPermission === false) return false;
  if (infoPermission === true) return true;

  const botUserId = await getBotUserIdSafe();
  if (!botUserId) return false;

  const botMember = await fetchChatMemberSafe(channelId, botUserId);
  if (!botMember || !isMemberActive(botMember)) return false;

  const memberPermission = extractCanPublishPermission(botMember);

  if (memberPermission === false) return false;
  if (memberPermission === true) return true;

  return isAdminLikeMember(botMember);
}

function extractChatIdFromObject(obj) {
  if (!obj || typeof obj !== 'object') return '';

  const candidates = [
    obj.chat_id,
    obj.chatId,
    obj.id,
    obj.channel_id,
    obj.channelId,
    obj.recipient?.chat_id,
    obj.recipient?.chatId,
    obj.chat?.chat_id,
    obj.chat?.chatId,
    obj.chat?.id,
    obj.result?.chat_id,
    obj.result?.chatId,
    obj.result?.id,
    obj.payload?.chat_id,
    obj.payload?.chatId,
    obj.payload?.id
  ];

  for (const value of candidates) {
    const text = String(value || '').trim();
    if (text) return text;
  }

  return '';
}

function isProbablyChannelChat(candidate) {
  const chatId = extractChatIdFromObject(candidate);
  const type = String(
    candidate?.type ||
    candidate?.chat_type ||
    candidate?.chatType ||
    candidate?.kind ||
    candidate?.recipient?.type ||
    candidate?.chat?.type ||
    ''
  ).toLowerCase();

  if (type.includes('dialog') || type.includes('private') || type.includes('user')) return false;
  if (type.includes('channel') || type.includes('chat') || type.includes('group')) return true;

  return String(chatId).startsWith('-');
}

function getActorUserIdFromUpdate(update) {
  return String(
    update?.callback?.user?.user_id ||
    update?.message?.sender?.user_id ||
    update?.user?.user_id ||
    update?.user_id ||
    update?.member?.user_id ||
    update?.member?.user?.user_id ||
    update?.chat_member?.user_id ||
    update?.chat_member?.user?.user_id ||
    update?.payload?.user_id ||
    update?.payload?.user?.user_id ||
    ''
  ).trim();
}

function makeUpdatePreview(update) {
  let raw = '';

  try {
    raw = JSON.stringify(update || {});
  } catch {
    raw = String(update || '');
  }

  return {
    update_type: String(update?.update_type || '').slice(0, 100),
    preview: raw.replace(/\u0000/g, '').slice(0, 12000)
  };
}

function getCandidateChatTitle(candidate, fallbackChatId = '') {
  return String(
    candidate?.title ||
    candidate?.name ||
    candidate?.chat_title ||
    candidate?.chatTitle ||
    candidate?.recipient?.title ||
    candidate?.recipient?.name ||
    candidate?.recipient?.chat_title ||
    candidate?.chat?.title ||
    candidate?.chat?.name ||
    ''
  ).trim() || (fallbackChatId ? `Канал ${fallbackChatId}` : 'Канал');
}

function getCandidateChatLink(candidate) {
  return extractChatLinkFromObject(candidate) ||
    extractChatLinkFromObject(candidate?.recipient) ||
    extractChatLinkFromObject(candidate?.chat) ||
    '';
}

function extractChatCandidatesFromUpdate(update) {
  const candidates = [
    update?.recipient,
    update?.chat,
    update?.channel,
    update?.message?.recipient,
    update?.message?.chat,
    update?.message?.channel,
    update?.callback?.message?.recipient,
    update?.callback?.message?.chat,
    update?.callback?.chat,
    update?.member?.chat,
    update?.chat_member?.chat,
    update?.payload?.chat,
    update?.payload?.recipient,
    update?.result?.chat,
    update?.result?.recipient
  ].filter(Boolean);

  if (update?.chat_id) {
    candidates.push({
      chat_id: update.chat_id,
      title: update?.chat_title || update?.title || update?.name
    });
  }

  const map = new Map();

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;

    const chatId = extractChatIdFromObject(candidate);
    if (!chatId) continue;

    if (!isProbablyChannelChat(candidate)) continue;

    map.set(String(chatId), candidate);
  }

  return [...map.entries()].map(([chatId, candidate]) => ({ chatId, candidate }));
}

async function upsertBotSeenChat(chatId, chatTitle, chatLink, sourceUpdateType = '', actorUserId = null, payload = {}, isRemoved = false) {
  const id = String(chatId || '').trim();
  if (!id || !isChannelIdLike(id)) return null;

  const title = safeText(chatTitle || `Канал ${id}`, 255);
  const link = safeText(chatLink || '', 1000);
  const updateType = safeText(sourceUpdateType || '', 100);
  const actor = actorUserId ? String(actorUserId) : null;
  const removed = Boolean(isRemoved);

  const res = await pool.query(`
    INSERT INTO bot_seen_chats (
      chat_id,
      chat_title,
      chat_link,
      source_update_type,
      last_actor_user_id,
      last_payload,
      seen_count,
      is_probably_channel,
      is_removed,
      last_removed_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, true, $7, CASE WHEN $7 THEN NOW() ELSE NULL END, NOW())
    ON CONFLICT (chat_id)
    DO UPDATE SET
      chat_title = COALESCE(NULLIF(EXCLUDED.chat_title, ''), bot_seen_chats.chat_title),
      chat_link = COALESCE(NULLIF(EXCLUDED.chat_link, ''), bot_seen_chats.chat_link),
      source_update_type = EXCLUDED.source_update_type,
      last_actor_user_id = COALESCE(EXCLUDED.last_actor_user_id, bot_seen_chats.last_actor_user_id),
      last_payload = EXCLUDED.last_payload,
      seen_count = bot_seen_chats.seen_count + 1,
      is_probably_channel = true,
      is_removed = EXCLUDED.is_removed,
      last_removed_at = CASE WHEN EXCLUDED.is_removed THEN NOW() ELSE NULL END,
      updated_at = NOW()
    RETURNING *
  `, [
    id,
    title,
    link,
    updateType,
    actor,
    JSON.stringify(payload || {}),
    removed
  ]);

  return res.rows[0] || null;
}

async function rememberSeenChatsFromUpdate(update) {
  const candidates = extractChatCandidatesFromUpdate(update);
  if (!candidates.length) return [];

  const actorUserId = getActorUserIdFromUpdate(update);
  const payload = makeUpdatePreview(update);
  const removed = isBotRemovedUpdate(update);
  const saved = [];

  for (const { chatId, candidate } of candidates) {
    try {
      const title = getCandidateChatTitle(candidate, chatId);
      const link = getCandidateChatLink(candidate);

      const row = await upsertBotSeenChat(
        chatId,
        title,
        link,
        update?.update_type || '',
        actorUserId || null,
        payload,
        removed
      );

      if (row) saved.push(row);
    } catch (error) {
      console.warn(`Не удалось сохранить увиденный канал ${chatId}:`, error.message);
    }
  }

  if (saved.length) {
    console.log('👀 Saved seen chats:', saved.map(ch => ({
      chat_id: ch.chat_id,
      title: ch.chat_title,
      update_type: ch.source_update_type,
      is_removed: ch.is_removed
    })));
  }

  return saved;
}

async function getSeenChannelCandidates() {
  const res = await pool.query(`
    SELECT *
    FROM bot_seen_chats
    WHERE is_probably_channel = true
      AND COALESCE(is_removed, false) = false
      AND chat_id < 0
    ORDER BY updated_at DESC, id DESC
    LIMIT $1
  `, [MAX_SEEN_CHAT_REFRESH_LIMIT]);

  return res.rows;
}

async function discoverUserChannelsForUser(userId) {
  const candidates = await getSeenChannelCandidates();
  const added = [];
  const skipped = [];

  for (const candidate of candidates) {
    const channelId = String(candidate.chat_id || '').trim();
    if (!channelId || !isChannelIdLike(channelId)) continue;

    const trustedByWebhook = isSeenChatLinkedByUser(candidate, userId);

    if (!trustedByWebhook) {
      // Не проверяем старые/чужие seen-чаты через MAX API.
      // Иначе кнопка «Обновить каналы» долго висит и даёт много 403:
      // User is not admin / Not enough permissions.
      // Канал должен попасть в список через доверенное событие bot_added/bot_updated
      // или через уже сохранённый user_channels.
      skipped.push({ channelId, reason: 'not_linked_by_this_user_webhook' });
      continue;
    }

    const meta = {
      title: candidate.chat_title || `Канал ${channelId}`,
      link: candidate.chat_link || ''
    };

    const channel = await upsertUserChannel(userId, channelId, meta.title, meta.link, userId, true);
    added.push(channel);
  }

  return { added, skipped, checked: candidates.length };
}

async function markSeenChatRemoved(chatId, sourceUpdateType = 'bot_removed') {
  const id = String(chatId || '').trim();
  if (!id) return;

  await pool.query(`
    UPDATE bot_seen_chats
    SET
      is_removed = true,
      source_update_type = $2,
      last_removed_at = NOW(),
      updated_at = NOW()
    WHERE chat_id = $1
  `, [id, sourceUpdateType]);
}


async function restoreSeenChatAfterTrustedAttach(chatId, sourceUpdateType = 'bot_added', actorUserId = null, meta = {}) {
  const id = String(chatId || '').trim();
  if (!id || !isChannelIdLike(id)) return null;

  const title = safeText(meta?.title || `Канал ${id}`, 255);
  const link = safeText(meta?.link || '', 1000);
  const updateType = safeText(sourceUpdateType || 'bot_added', 100);
  const actor = actorUserId ? String(actorUserId) : null;

  const res = await pool.query(`
    INSERT INTO bot_seen_chats (
      chat_id,
      chat_title,
      chat_link,
      source_update_type,
      last_actor_user_id,
      last_payload,
      seen_count,
      is_probably_channel,
      is_removed,
      last_removed_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 1, true, false, NULL, NOW())
    ON CONFLICT (chat_id)
    DO UPDATE SET
      chat_title = COALESCE(NULLIF(EXCLUDED.chat_title, ''), bot_seen_chats.chat_title),
      chat_link = COALESCE(NULLIF(EXCLUDED.chat_link, ''), bot_seen_chats.chat_link),
      source_update_type = EXCLUDED.source_update_type,
      last_actor_user_id = COALESCE(EXCLUDED.last_actor_user_id, bot_seen_chats.last_actor_user_id),
      is_probably_channel = true,
      is_removed = false,
      last_removed_at = NULL,
      updated_at = NOW()
    RETURNING *
  `, [
    id,
    title,
    link,
    updateType,
    actor
  ]);

  return res.rows[0] || null;
}

async function deactivateUserChannelsByChannelId(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return 0;

  const res = await pool.query(`
    UPDATE user_channels
    SET
      is_active = false,
      can_publish = false,
      updated_at = NOW()
    WHERE channel_id = $1
      AND is_active = true
    RETURNING id
  `, [id]);

  return res.rowCount || 0;
}

async function handleBotRemovedFromChannel(update, target) {
  if (!isChannelTarget(target)) return;

  const channelId = String(target.id || '').trim();
  await markSeenChatRemoved(channelId, update?.update_type || 'bot_removed');
  const deactivated = await deactivateUserChannelsByChannelId(channelId);

  console.log('🗑️ Bot removed from channel. Channel disabled for raffles:', {
    channel_id: channelId,
    deactivated_user_channels: deactivated
  });

  await notifyActiveRafflesAboutChannelPermissionProblem(channelId, 'bot_removed').catch(error => {
    console.warn('Не удалось предупредить активные розыгрыши о потере прав канала:', error.message);
  });
}

async function getActiveRaffleChannelsForPermissionAlert(channelId = '') {
  const cleanChannelId = String(channelId || '').trim();

  const params = [];
  let channelFilter = '';

  if (cleanChannelId) {
    params.push(cleanChannelId);
    channelFilter = `AND rc.channel_id::text = $${params.length}`;
  }

  const res = await pool.query(`
    SELECT
      r.id AS raffle_id,
      r.id AS public_number,
      r.title AS raffle_title,
      r.creator_user_id,
      r.status,
      r.end_at,
      rc.id AS raffle_channel_row_id,
      rc.channel_id,
      rc.channel_title,
      rc.channel_link,
      rc.owner_user_id,
      rc.is_required,
      rc.publish_post,
      COALESCE(uc.can_publish, true) AS saved_can_publish,
      COALESCE(uc.is_active, true) AS saved_is_active,
      COALESCE(bsc.is_removed, false) AS seen_is_removed
    FROM raffles r
    JOIN raffle_channels rc ON rc.raffle_id = r.id
    LEFT JOIN user_channels uc
      ON uc.channel_id = rc.channel_id
     AND uc.owner_user_id = rc.owner_user_id
    LEFT JOIN bot_seen_chats bsc ON bsc.chat_id = rc.channel_id
    WHERE r.status = 'active'
      AND r.end_at > NOW()
      AND (COALESCE(rc.is_required, true) = true OR COALESCE(rc.publish_post, true) = true)
      ${channelFilter}
    ORDER BY r.id ASC, rc.id ASC
  `, params);

  return res.rows;
}

function getPermissionAlertRecipients(row) {
  return [...new Set([
    String(row?.creator_user_id || '').trim(),
    String(row?.owner_user_id || '').trim()
  ].filter(Boolean))];
}

async function shouldSendRafflePermissionAlert(raffleId, channelId, recipientUserId) {
  const res = await pool.query(`
    SELECT last_sent_at
    FROM raffle_permission_alerts
    WHERE raffle_id = $1
      AND channel_id = $2
      AND recipient_user_id = $3
      AND alert_type = 'permissions_lost'
    LIMIT 1
  `, [raffleId, channelId, recipientUserId]);

  const lastSentAt = res.rows[0]?.last_sent_at;

  if (lastSentAt) {
    const lastMs = new Date(lastSentAt).getTime();
    const intervalMs = RAFFLE_PERMISSION_ALERT_INTERVAL_MINUTES * 60 * 1000;

    if (Number.isFinite(lastMs) && Date.now() - lastMs < intervalMs) {
      return false;
    }
  }

  await pool.query(`
    INSERT INTO raffle_permission_alerts (
      raffle_id,
      channel_id,
      recipient_user_id,
      alert_type,
      last_sent_at,
      send_count,
      resolved_at,
      updated_at
    )
    VALUES ($1, $2, $3, 'permissions_lost', NOW(), 1, NULL, NOW())
    ON CONFLICT (raffle_id, channel_id, recipient_user_id, alert_type)
    DO UPDATE SET
      last_sent_at = NOW(),
      send_count = raffle_permission_alerts.send_count + 1,
      resolved_at = NULL,
      updated_at = NOW()
  `, [raffleId, channelId, recipientUserId]);

  return true;
}

async function resolveRafflePermissionAlerts(raffleId, channelId) {
  await pool.query(`
    UPDATE raffle_permission_alerts
    SET resolved_at = NOW(), updated_at = NOW()
    WHERE raffle_id = $1
      AND channel_id = $2
      AND alert_type = 'permissions_lost'
      AND resolved_at IS NULL
  `, [raffleId, channelId]);
}

function buildRafflePermissionAlertText(row, reason = 'permissions_lost') {
  const raffleNumber = getRafflePublicNumber({
    id: row.raffle_id,
    public_number: row.public_number
  });
  const channelTitle = displayValue(row.channel_title, `Канал ${row.channel_id}`);

  return [
    '🚨 **Розыгрыш под угрозой‼️**',
    '',
    `${BOT_USERNAME} нет прав на канал **${channelTitle}**.`,
    `Розыгрыш № **${raffleNumber}**: **${displayValue(row.raffle_title, 'Без названия')}**`,
    '',
    reason === 'bot_removed'
      ? 'Бот был удалён из канала или потерял доступ.'
      : 'Бот не может проверить/использовать канал для активного розыгрыша.',
    '',
    'Что сделать:',
    `1. Верните ${BOT_USERNAME} в администраторы канала.`,
    '2. Дайте права на публикацию и проверку участников.'
  ].join('\n');
}

async function notifyRafflePermissionProblem(row, reason = 'permissions_lost') {
  const recipients = getPermissionAlertRecipients(row);

  for (const recipient of recipients) {
    const due = await shouldSendRafflePermissionAlert(row.raffle_id, row.channel_id, recipient);
    if (!due) continue;

    await sendMessage(recipient, buildRafflePermissionAlertText(row, reason)).catch(error => {
      console.warn('Не удалось отправить предупреждение о правах канала:', {
        raffle_id: row.raffle_id,
        channel_id: String(row.channel_id),
        recipient,
        error: error.message
      });
    });
  }
}

async function notifyActiveRafflesAboutChannelPermissionProblem(channelId, reason = 'bot_removed') {
  const rows = await getActiveRaffleChannelsForPermissionAlert(channelId);

  for (const row of rows) {
    await notifyRafflePermissionProblem(row, reason);
  }

  if (rows.length) {
    console.warn('🚨 Active raffles have channel permission problem:', {
      channel_id: String(channelId),
      reason,
      raffles: rows.map(row => Number(row.raffle_id))
    });
  }

  return rows.length;
}

async function checkActiveRaffleChannelPermissionsOnce() {
  const rows = await getActiveRaffleChannelsForPermissionAlert();

  for (const row of rows) {
    const hasLocalProblemFlag =
      row.seen_is_removed === true ||
      row.saved_is_active === false ||
      row.saved_can_publish === false;

    // Важно: не шлём предупреждение только из-за того, что MAX API не дал проверить
    // очередной канал активного розыгрыша. В некоторых каналах проверка прав через API
    // может возвращать false/403, хотя проверка подписки и розыгрыш работают.
    // Поэтому уведомляем только канал, где уже есть реальный локальный сигнал проблемы:
    // bot_removed / user_channels.is_active=false / can_publish=false.
    if (!hasLocalProblemFlag) {
      continue;
    }

    // Даже если в базе остался старый флаг проблемы, сначала перепроверяем права.
    // Если права уже восстановлены — очищаем флаги и не отправляем сообщение.
    const canPublish = await checkBotCanPublishInChannel(row.channel_id).catch(error => {
      console.warn('Не удалось проверить права бота в канале с локальным флагом проблемы:', {
        raffle_id: row.raffle_id,
        channel_id: String(row.channel_id),
        error: error.message
      });
      return false;
    });

    if (canPublish) {
      await resolveRafflePermissionAlerts(row.raffle_id, row.channel_id);

      await pool.query(`
        UPDATE bot_seen_chats
        SET is_removed = false, last_removed_at = NULL, updated_at = NOW()
        WHERE chat_id::text = $1
      `, [String(row.channel_id)]).catch(() => {});

      await pool.query(`
        UPDATE user_channels
        SET is_active = true, can_publish = true, updated_at = NOW()
        WHERE channel_id::text = $1
      `, [String(row.channel_id)]).catch(() => {});

      continue;
    }

    await notifyRafflePermissionProblem(row, 'permissions_lost');
  }
}

async function removeCollaboratorChannelFromActiveRaffle(target, userId, channelId, raffleId = null) {
  const cleanChannelId = String(channelId || '').trim();
  const cleanRaffleId = raffleId ? Number(raffleId) : null;

  if (!/^-?\d+$/.test(cleanChannelId)) {
    return sendMessage(target, 'Используйте: `/delcollaber ID_КАНАЛА`, например `/delcollaber -743535735754494`.');
  }

  if (cleanRaffleId !== null && !Number.isInteger(cleanRaffleId)) {
    return sendMessage(target, 'Некорректный ID розыгрыша. Пример: `/delcollaber -743535735754494 40`.');
  }

  const params = [cleanChannelId, String(userId)];
  // Команда /delcollaber доступна только создателю розыгрыша.
  // Даже соадмин канала и глобальный админ бота не удаляют канал из чужого активного розыгрыша этой командой.
  const ownerFilter = `AND r.creator_user_id::text = $2`;
  let raffleFilter = '';

  if (cleanRaffleId !== null) {
    params.push(cleanRaffleId);
    raffleFilter = `AND r.id = $${params.length}`;
  }

  const res = await pool.query(`
    SELECT
      r.id AS raffle_id,
      r.id AS public_number,
      r.title AS raffle_title,
      r.creator_user_id,
      rc.id AS raffle_channel_row_id,
      rc.channel_id,
      rc.channel_title,
      rc.owner_user_id
    FROM raffles r
    JOIN raffle_channels rc ON rc.raffle_id = r.id
    WHERE r.status = 'active'
      AND r.end_at > NOW()
      AND rc.channel_id::text = $1
      ${ownerFilter}
      ${raffleFilter}
    ORDER BY r.id DESC, rc.id DESC
  `, params);

  if (!res.rows.length) {
    return sendMessage(
      target,
      [
        'Канал не найден в активных розыгрышах, где вы являетесь организатором.',
        '',
        'Используйте:',
        '`/delcollaber ID_КАНАЛА`',
        '',
        'Если у вас несколько активных розыгрышей, можно указать ID розыгрыша:',
        '`/delcollaber ID_КАНАЛА ID_РОЗЫГРЫША`'
      ].join('\n')
    );
  }

  if (res.rows.length > 1 && cleanRaffleId === null) {
    const lines = res.rows
      .slice(0, 10)
      .map(row => `• № ${getRafflePublicNumber({ id: row.raffle_id, public_number: row.public_number })} — ${displayValue(row.raffle_title, 'Без названия')}: \`/delcollaber ${cleanChannelId} ${row.raffle_id}\``);

    return sendMessage(
      target,
      [
        'Нашла этот канал в нескольких активных розыгрышах. Укажите, из какого удалить:',
        '',
        ...lines
      ].join('\n')
    );
  }

  const row = res.rows[0];

  await pool.query('DELETE FROM raffle_channels WHERE id = $1', [row.raffle_channel_row_id]);

  // Больше не обновляем пост, опубликованный именно в удалённом канале.
  // Остальные посты активного розыгрыша обновятся и покажут список каналов уже без него.
  await pool.query(`
    DELETE FROM raffle_posts
    WHERE raffle_id = $1
      AND channel_id::text = $2
  `, [row.raffle_id, cleanChannelId]);

  await resolveRafflePermissionAlerts(row.raffle_id, cleanChannelId);

  const updateResult = await updateRafflePublishedPosts(row.raffle_id, { force: true }).catch(error => ({
    updated: 0,
    failed: 0,
    skipped: 0,
    error: error.message
  }));

  return sendMessage(
    target,
    [
      '✅ Канал удалён из активного розыгрыша.',
      '',
      `Розыгрыш № **${getRafflePublicNumber({ id: row.raffle_id, public_number: row.public_number })}**: **${displayValue(row.raffle_title, 'Без названия')}**`,
      `Канал: **${displayValue(row.channel_title, cleanChannelId)}**`,
      '',
      'Теперь этот канал:',
      '• исчезнет из условий в обновлённых постах;',
      '• не будет проверяться при участии;',
      '• не будет получать новые предупреждения по этому розыгрышу.',
      '',
      `Обновление постов: обновлено **${Number(updateResult.updated || 0)}**, ошибок **${Number(updateResult.failed || 0)}**, пропущено **${Number(updateResult.skipped || 0)}**.`
    ].join('\n')
  );
}

async function refreshUserChannels(target, userId, options = {}) {
  const result = await discoverUserChannelsForUser(userId);
  const session = await getSession(userId);

  if (session && ['await_channel_selection', 'collab_channel_selection'].includes(session.state)) {
    const sessionData = typeof session.data === 'string'
      ? JSON.parse(session.data || '{}')
      : session.data || {};

    // Внутри создания/коллаборации не отправляем отдельное сообщение «Каналы обновлены».
    // Просто заменяем текущий блок выбора каналов.
    return sendChannelSelectionMenu(
      target,
      userId,
      sessionData,
      session.state === 'collab_channel_selection' ? 'collab' : 'create',
      options
    );
  }

  if (result.added.length) {
    let text = '🔄 **Каналы обновлены**\n\n';

    for (const channel of result.added) {
      text += `• ${formatChannelWithLink(channel)}\n`;
    }

    text += '\nЭти каналы уже доступны при создании розыгрыша.';
    await sendMessage(target, text);
  } else {
    await sendMessage(
      target,
      [
        '🔄 **Проверка завершена**',
        '',
        'Новые каналы не найдены.',
        '',
        'Проверьте, что:',
        `1. бот ${BOT_USERNAME} добавлен в канал;`,
        '2. у бота есть права администратора на размещение постов;',
        '3. после добавления бота вернитесь сюда и нажмите **🔄 Обновить**.',
        '',
        `Проверено каналов: ${result.checked}.`
      ].join('\n')
    );
  }

  return sendMyChannels(target, userId);
}

async function tryAutoRegisterChannelFromUpdate(update, target, from) {
  if (!isChannelTarget(target) || !from?.id) {
    return { ok: false, reason: 'not_channel_update' };
  }

  if (BOT_USER_ID && String(from.id) === String(BOT_USER_ID)) {
    return { ok: false, reason: 'bot_actor' };
  }

  const channelId = target.id;
  const trustedByWebhook = isTrustedChannelAttachUpdate(update);

  // В MAX событие bot_added уже содержит chat_id канала и user_id пользователя, который добавил бота.
  // Проверка участника через /chats/{id}/members может возвращать 403: User is not admin / Not enough permissions,
  // даже когда бот уже добавлен админом. Поэтому для bot_added/bot_updated не блокируем добавление канала.
  if (!trustedByWebhook) {
    const canUserManage = await isUserAdminInChannel(from.id, channelId);
    if (!canUserManage) return { ok: false, reason: 'user_not_admin' };
  }

  const meta = await resolveChannelMeta(channelId, update);

  // Если канал ранее был помечен как удалённый после bot_removed,
  // доверенное новое событие bot_added/bot_updated должно восстановить его.
  // Иначе тот же канал не появится у нового пользователя в выборе розыгрыша.
  if (trustedByWebhook) {
    await restoreSeenChatAfterTrustedAttach(
      channelId,
      update?.update_type || 'bot_added',
      from.id,
      meta
    );
  }

  const channel = await upsertUserChannel(from.id, channelId, meta.title, meta.link, from.id, true);

  return {
    ok: true,
    channel,
    trustedByWebhook
  };
}

async function upsertUserChannel(ownerUserId, channelId, channelTitle, channelLink = '', addedByUserId = null, canPublish = true) {
  const title = safeText(channelTitle || `Канал ${channelId}`, 255);
  const link = safeText(channelLink || '', 1000);

  const res = await pool.query(`
    INSERT INTO user_channels (
      owner_user_id,
      channel_id,
      channel_title,
      channel_link,
      added_by_user_id,
      can_publish,
      is_active,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
    ON CONFLICT (owner_user_id, channel_id)
    DO UPDATE SET
      channel_title = EXCLUDED.channel_title,
      channel_link = COALESCE(NULLIF(EXCLUDED.channel_link, ''), user_channels.channel_link),
      added_by_user_id = EXCLUDED.added_by_user_id,
      can_publish = EXCLUDED.can_publish,
      is_active = true,
      updated_at = NOW()
    RETURNING *
  `, [
    ownerUserId,
    channelId,
    title,
    link,
    addedByUserId || ownerUserId,
    canPublish
  ]);

  return res.rows[0];
}

async function getUserChannels(userId) {
  const res = await pool.query(`
    SELECT *
    FROM user_channels
    WHERE owner_user_id = $1
      AND is_active = true
    ORDER BY updated_at DESC, id DESC
  `, [userId]);

  return res.rows;
}

async function getUserChannel(userId, channelId) {
  const res = await pool.query(`
    SELECT *
    FROM user_channels
    WHERE owner_user_id = $1
      AND channel_id = $2
      AND is_active = true
    LIMIT 1
  `, [userId, channelId]);

  return res.rows[0] || null;
}

async function sendAddChannelInstruction(target, options = {}) {
  const fromChannelSelection = Boolean(options.fromChannelSelection);
  const mode = options.mode === 'collab' ? 'collab' : 'create';

  const text = fromChannelSelection
    ? [
      '➕ **Добавить канал**',
      '',
      'Чтобы добавить канал к этому розыгрышу:',
      '',
      `1. Добавьте бота ${BOT_USERNAME} в канал или найдите его по имени **${BOT_SEARCH_NAME}**.`,
      '2. Выдайте боту права администратора на размещение постов.',
      '3. Вернитесь сюда и нажмите **⬅️ Назад к выбору каналов**.',
      '',
      'Бот обновит список и покажет доступные каналы для этого розыгрыша.'
    ].join('\n')
    : [
      '➕ **Добавить канал**',
      '',
      'Чтобы бот мог публиковать розыгрыш в вашем канале:',
      '',
      `1. Добавьте бота ${BOT_USERNAME} в канал или найдите его по имени **${BOT_SEARCH_NAME}**.`,
      '2. Выдайте боту права администратора на размещение постов.',
      '3. Вернитесь сюда и нажмите **🔄 Обновить**.',
      '',
      'Бот сам проверит подключение и добавит канал в раздел **Мои каналы**.'
    ].join('\n');

  const keyboard = fromChannelSelection
    ? [
      [{ text: '⬅️ Назад к выбору каналов', callback_data: mode === 'collab' ? 'back_to_collab_channels' : 'back_to_raffle_channels' }],
      [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
    ]
    : [
      [{ text: '🔄 Обновить', callback_data: 'refresh_channels' }],
      [{ text: '📢 Мои каналы', callback_data: 'my_channels' }],
      [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
    ];

  return sendMessage(target, text, keyboard);
}

async function sendMyChannels(target, userId) {
  const channels = await getUserChannels(userId);

  if (!channels.length) {
    return sendMessage(
      target,
      [
        '📢 **Мои каналы**',
        '',
        'Пока нет подключённых каналов.',
        '',
        'Добавьте бота в канал, дайте ему права администратора на публикацию постов, затем нажмите **🔄 Обновить**.'
      ].join('\n'),
      [
        [{ text: '🔄 Обновить', callback_data: 'refresh_channels' }],
        [{ text: '➕ Добавить канал', callback_data: 'add_channel' }],
        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
      ]
    );
  }

  let text = '📢 **Мои каналы**\n\n';

  for (const ch of channels) {
    text += `• ${formatChannelWithLink(ch)}\n`;
  }

  text += '\nЭти каналы можно выбрать при создании розыгрыша.';

  return sendMessage(
    target,
    text,
    [
      [{ text: '🔄 Обновить', callback_data: 'refresh_channels' }],
      [{ text: '➕ Добавить канал', callback_data: 'add_channel' }],
      [{ text: '🎉 Создать розыгрыш', callback_data: 'create_raffle' }],
      [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
    ]
  );
}

function getSelectedChannelsFromSession(data) {
  if (!Array.isArray(data.channels)) data.channels = [];
  return data.channels;
}

function findSelectedChannel(data, channelId) {
  const id = String(channelId);
  return getSelectedChannelsFromSession(data).find(ch => String(ch.channel_id) === id);
}

function selectedChannelIndex(data, channelId) {
  const id = String(channelId);
  return getSelectedChannelsFromSession(data).findIndex(ch => String(ch.channel_id) === id);
}

function pruneSelectedChannelsAgainstUserChannels(data, userChannels = []) {
  const selected = getSelectedChannelsFromSession(data);
  const activeIds = new Set((userChannels || []).map(ch => String(ch.channel_id)));
  const beforeCount = selected.length;

  data.channels = selected.filter(ch => activeIds.has(String(ch.channel_id)));

  return {
    removed: beforeCount - data.channels.length,
    selected: data.channels
  };
}

async function pruneUnavailableSessionChannels(userId, data, sessionState = '') {
  const userChannels = await getUserChannels(userId);
  const result = pruneSelectedChannelsAgainstUserChannels(data, userChannels);

  if (result.removed > 0 && sessionState) {
    await setSession(userId, sessionState, data);
  }

  return {
    ...result,
    userChannels
  };
}

async function sendChannelSelectionMenu(target, userId, data, mode = 'create', options = {}) {
  const userChannels = await getUserChannels(userId);
  const sessionState = options.sessionState || (mode === 'collab' ? 'collab_channel_selection' : 'await_channel_selection');
  const pruneResult = pruneSelectedChannelsAgainstUserChannels(data, userChannels);

  if (pruneResult.removed > 0 && options.persistPruned !== false) {
    await setSession(userId, sessionState, data);
  }

  const selected = getSelectedChannelsFromSession(data);

  let text = mode === 'collab'
    ? '🤝 **Каналы для совместного розыгрыша**\n\n'
    : '📢 **Каналы для розыгрыша**\n\n';

  text += 'Выберите каналы из списка ниже. Для каждого канала можно отдельно включить:\n';
  text += '✔️ обязательную подписку;\n';
  text += '📣 размещение поста с розыгрышем.\n\n';

  if (pruneResult.removed > 0) {
    text += `⚠️ ${pruneResult.removed === 1 ? 'Выбранный канал больше недоступен и был убран из розыгрыша.' : `Недоступные каналы (${pruneResult.removed}) были убраны из розыгрыша.`}\n`;
    text += 'Проверьте права бота и добавьте канал заново, если нужно.\n\n';
  }

  if (!userChannels.length) {
    text += 'У вас пока нет подключённых каналов.\n';
    text += mode === 'collab'
      ? 'Сначала добавьте бота в канал, дайте права администратора на публикацию и нажмите **🔄 Обновить каналы**.'
      : 'Нажмите **➕ Добавить канал**, добавьте бота в канал и вернитесь назад к выбору каналов.';
  } else if (!selected.length) {
    text += 'Каналы пока **не** выбраны. Можно продолжить без каналов или выбрать канал ниже,нажав ☑️';
  } else {
    text += '**Выбрано:**\n';

    for (const ch of selected) {
      text += `• ${formatChannelWithLink(ch)} — `;
      text += `${ch.is_required ? 'обязательная подписка✔️' : 'подписка не обязательна❌'}, `;
      text += `${ch.publish_post ? 'с размещением📣' : 'без размещения🙈'}\n`;
    }
  }

  const keyboard = [];

  for (const ch of userChannels) {
    const stored = findSelectedChannel(data, ch.channel_id);
    const id = safeCallbackPart(ch.channel_id);
    const title = truncateButtonText(formatChannelName(ch), 34);

    keyboard.push([
      {
        text: `${stored ? '✅' : '☑️'} ${title}`,
        callback_data: `${mode === 'collab' ? 'collab_ch_toggle' : 'raffle_ch_toggle'}:${id}`
      }
    ]);

    if (stored) {
      keyboard.push([
        {
          text: stored.is_required ? '❌ Подписка не обязательна' : '✔️ Обязательная подписка',
          callback_data: `${mode === 'collab' ? 'collab_ch_req' : 'raffle_ch_req'}:${id}`
        },
        {
          text: stored.publish_post ? '🙈 Без размещения' : '📣 С размещением',
          callback_data: `${mode === 'collab' ? 'collab_ch_pub' : 'raffle_ch_pub'}:${id}`
        }
      ]);
    }
  }

  if (mode === 'collab') {
    keyboard.push([{ text: '🔄 Обновить каналы', callback_data: 'refresh_channels' }]);
  }
  keyboard.push([{ text: '➕ Добавить канал', callback_data: 'add_channel' }]);
  keyboard.push([{ text: mode === 'collab' ? '✅ Добавить к розыгрышу' : '➡️ Далее к шаблону', callback_data: mode === 'collab' ? 'collab_channels_done' : 'raffle_channels_done' }]);
  keyboard.push([{ text: '❌ Отмена', callback_data: 'cancel_session' }]);

  const editMessageId = String(options.editMessageId || '').trim();

  if (editMessageId) {
    const edited = await editMaxMessageText(target, editMessageId, text, keyboard);
    if (edited) return true;
  }

  return sendMessage(target, text, keyboard);
}

async function toggleSessionChannel(userId, channelId) {
  const session = await getSession(userId);

  if (!session) return null;

  const data = typeof session.data === 'string'
    ? JSON.parse(session.data || '{}')
    : session.data || {};


  const channel = await getUserChannel(userId, channelId);

  if (!channel) return { session, data, missing: true };

  const idx = selectedChannelIndex(data, channelId);

  if (idx >= 0) {
    data.channels.splice(idx, 1);
  } else {
    getSelectedChannelsFromSession(data).push({
      channel_id: String(channel.channel_id),
      channel_title: channel.channel_title,
      channel_link: channel.channel_link,
      is_required: true,
      publish_post: true,
      owner_user_id: userId
    });
  }

  await setSession(userId, session.state, data);

  return { session, data };
}

async function toggleSessionChannelFlag(userId, channelId, flag) {
  const session = await getSession(userId);

  if (!session) return null;

  const data = typeof session.data === 'string'
    ? JSON.parse(session.data || '{}')
    : session.data || {};

  const selected = findSelectedChannel(data, channelId);

  if (!selected) return { session, data, missing: true };

  selected[flag] = !selected[flag];

  await setSession(userId, session.state, data);

  return { session, data };
}

async function createRaffleFromSession(userId, data) {
  // Финальная страховка: если во время создания бот был удалён из выбранного канала,
  // не сохраняем такой канал в розыгрыш. Основная очистка происходит раньше,
  // в меню выбора каналов и перед предпросмотром.
  await pruneUnavailableSessionChannels(userId, data).catch(error => {
    console.warn('Не удалось очистить недоступные каналы перед созданием розыгрыша:', error.message);
  });

  const raffle = await createRaffleDraft(userId);

  await updateRaffle(raffle.id, {
    title: data.title,
    description: data.description,
    prizes: data.prizes,
    prize_count: data.prize_count,
    publish_at: data.publish_at,
    end_at: data.end_at,
    photo_attachment: data.photo_attachment ? JSON.stringify(data.photo_attachment) : null,
    publish_in_general: false,
    status: 'scheduled'
  });

  for (const ch of data.channels || []) {
    await addRaffleChannel(
      raffle.id,
      ch.channel_id,
      ch.channel_title,
      ch.is_required,
      ch.publish_post,
      ch.channel_link,
      ch.owner_user_id || userId
    );
  }

  const inviteToken = await createRaffleInvite(raffle.id, userId);

  await addQueue(raffle.id, 'raffle_start', new Date(data.publish_at || Date.now()));

  const reminderAt = toUtcMoment(data.end_at)?.subtract(REMINDER_BEFORE_FINISH_MINUTES, 'minute');
  if (reminderAt && reminderAt.isAfter(dayjs.utc())) {
    await addQueue(raffle.id, 'raffle_subscription_reminder', reminderAt.toDate());
  }

  await addQueue(raffle.id, 'raffle_finish', new Date(data.end_at));

  return { raffle, inviteToken };
}

async function createRaffleInvite(raffleId, userId) {
  const token = crypto.randomBytes(18).toString('hex');

  await pool.query(`
    INSERT INTO raffle_invites (raffle_id, token, invited_by_user_id, is_active)
    VALUES ($1, $2, $3, true)
  `, [raffleId, token, userId]);

  return token;
}

async function getRaffleInviteByToken(token) {
  const res = await pool.query(`
    SELECT *
    FROM raffle_invites
    WHERE token = $1
    LIMIT 1
  `, [token]);

  return res.rows[0] || null;
}

async function getRaffleInviteByRaffleId(raffleId) {
  const res = await pool.query(`
    SELECT *
    FROM raffle_invites
    WHERE raffle_id = $1
    ORDER BY id ASC
    LIMIT 1
  `, [raffleId]);

  return res.rows[0] || null;
}

async function closeRaffleInviteByRaffleId(raffleId, userId) {
  const res = await pool.query(`
    UPDATE raffle_invites
    SET
      is_active = false,
      closed_at = COALESCE(closed_at, NOW()),
      closed_by_user_id = COALESCE(closed_by_user_id, $2)
    WHERE raffle_id = $1
    RETURNING *
  `, [raffleId, userId]);

  return res.rows[0] || null;
}

async function closeCollabInviteLink(target, userId, raffleId) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
  }

  if (!isAdmin(userId) && Number(raffle.creator_user_id) !== Number(userId)) {
    return sendMessage(target, '⛔ Закрыть ссылку коллаборации может только организатор розыгрыша или админ бота.');
  }

  const invite = await getRaffleInviteByRaffleId(raffle.id);

  if (!invite) {
    return sendMessage(target, 'Ссылка коллаборации для этого розыгрыша не найдена.');
  }

  if (!isRaffleInviteActive(invite)) {
    return sendMessage(
      target,
      [
        '🔒 **Ссылка коллаборации уже закрыта.**',
        '',
        `Розыгрыш № **${getRafflePublicNumber(raffle)}**`,
        `Название: **${displayValue(raffle.title, 'Без названия')}**`,
        '',
        'Новые соадмины уже не могут подключать каналы по старой ссылке.'
      ].join('\n'),
      buildCreatedRaffleKeyboard(raffle, userId)
    );
  }

  await closeRaffleInviteByRaffleId(raffle.id, userId);

  return sendMessage(
    target,
    [
      '🔒 **Ссылка коллаборации закрыта.**',
      '',
      `Розыгрыш № **${getRafflePublicNumber(raffle)}**`,
      `Название: **${displayValue(raffle.title, 'Без названия')}**`,
      '',
      'Новые соадмины больше не смогут подключать каналы по этой ссылке.',
      'Уже добавленные каналы и соадмины остаются в розыгрыше.'
    ].join('\n'),
    buildCreatedRaffleKeyboard(raffle, userId)
  );
}

async function getRaffleChannelsWithOwners(raffleId) {
  const res = await pool.query(`
    SELECT
      rc.*,
      u.username AS owner_username,
      u.first_name AS owner_first_name,
      u.last_name AS owner_last_name
    FROM raffle_channels rc
    LEFT JOIN users u ON u.max_user_id = rc.owner_user_id
    WHERE rc.raffle_id = $1
    ORDER BY rc.id ASC
  `, [raffleId]);

  return res.rows;
}

async function startCollabFlow(target, userId, token) {
  const invite = await getRaffleInviteByToken(token);

  if (!invite) {
    return sendMessage(target, 'Ссылка для совместного розыгрыша недействительна или устарела.');
  }

  if (!isRaffleInviteActive(invite)) {
    return sendMessage(
      target,
      [
        '🔒 **Ссылка коллаборации закрыта.**',
        '',
        'Организатор уже остановил добавление новых соадминов к этому розыгрышу.',
        'Если вы уже были добавлены раньше, ваши каналы остаются в розыгрыше.'
      ].join('\n')
    );
  }

  const raffle = await getRaffleById(invite.raffle_id);

  if (!raffle || !['scheduled', 'active'].includes(raffle.status)) {
    return sendMessage(target, 'Этот розыгрыш уже недоступен для подключения каналов.');
  }

  await setSession(userId, 'collab_channel_selection', {
    raffle_id: raffle.id,
    invite_token: token,
    channels: []
  });

  return sendChannelSelectionMenu(target, userId, {
    raffle_id: raffle.id,
    invite_token: token,
    channels: []
  }, 'collab');
}

async function addCollabChannelsFromSession(target, userId, data) {
  const raffle = await getRaffleById(data.raffle_id);

  if (!raffle || !['scheduled', 'active'].includes(raffle.status)) {
    await clearSession(userId);
    return sendMessage(target, 'Этот розыгрыш уже недоступен для подключения каналов.');
  }

  const inviteToken = String(data.invite_token || '').trim();

  if (!inviteToken) {
    await clearSession(userId);
    return sendMessage(target, 'Сессия коллаборации устарела. Откройте актуальную ссылку ещё раз.');
  }

  const invite = await getRaffleInviteByToken(inviteToken);

  if (!invite || Number(invite.raffle_id) !== Number(raffle.id) || !isRaffleInviteActive(invite)) {
    await clearSession(userId);
    return sendMessage(
      target,
      [
        '🔒 **Ссылка коллаборации закрыта.**',
        '',
        'Организатор уже остановил добавление новых соадминов к этому розыгрышу.',
        'Канал не был добавлен.'
      ].join('\n')
    );
  }

  const channels = data.channels || [];

  if (!channels.length) {
    return sendMessage(target, 'Выберите хотя бы один канал или отмените подключение.');
  }

  for (const ch of channels) {
    await addRaffleChannel(
      raffle.id,
      ch.channel_id,
      ch.channel_title,
      ch.is_required,
      ch.publish_post,
      ch.channel_link,
      userId
    );

    if (raffle.status === 'active' && ch.publish_post) {
      await publishRaffleToChannel(raffle, ch.channel_id).catch(error => {
        console.warn(`Не удалось сразу опубликовать в канале ${ch.channel_id}:`, error.message);
      });
    }
  }

  await clearSession(userId);

  return sendMessage(
    target,
    [
      '✅ Каналы добавлены к совместному розыгрышу.',
      '',
      `Розыгрыш: **${displayValue(raffle.title, 'Без названия')}**`,
      '',
      'Теперь условия подписки и размещения будут учитываться в этом розыгрыше.'
    ].join('\n'),
    [
      [{ text: '📊 Статистика розыгрыша', callback_data: `raffle_stats:${raffle.id}` }],
      [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
    ]
  );
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

function getUpdateTextAndLinksForFiltering(update) {
  const parts = [
    update?.message?.body?.text,
    update?.message?.text,
    update?.payload,
    update?.callback?.payload
  ];

  const attachments = update?.message?.body?.attachments || update?.message?.attachments || [];
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      const buttons = attachment?.payload?.buttons;
      if (Array.isArray(buttons)) {
        for (const row of buttons) {
          if (!Array.isArray(row)) continue;
          for (const button of row) {
            parts.push(button?.url, button?.text, button?.payload);
          }
        }
      }
    }
  }

  const markup = update?.message?.body?.markup || update?.message?.markup || [];
  if (Array.isArray(markup)) {
    for (const item of markup) {
      parts.push(item?.url);
    }
  }

  return parts
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value))
    .join('\n');
}

function isOwnRaffleEditedUpdate(update) {
  const text = getUpdateTextAndLinksForFiltering(update);
  const cleanBotUsername = normalizeUsername(BOT_USERNAME);

  if (BOT_BRAND_NAME && text.includes(BOT_BRAND_NAME)) return true;
  if (cleanBotUsername && text.includes(cleanBotUsername)) return true;
  if (BOT_PUBLIC_URL && text.includes(BOT_PUBLIC_URL)) return true;

  return false;
}

function isForeignRaffleEditedUpdate(update) {
  const updateType = String(update?.update_type || '').toLowerCase();
  if (updateType !== 'message_edited') return false;
  if (isOwnRaffleEditedUpdate(update)) return false;

  const text = getUpdateTextAndLinksForFiltering(update);

  return text.includes('Приз_КитБот') ||
    text.includes('id772975617249_bot') ||
    /[?&]start=participate_\d+/i.test(text);
}

function shouldSkipForeignRaffleEditedUpdate(update) {
  if (SHOW_FOREIGN_RAFFLE_EDIT_UPDATES) return false;
  return isForeignRaffleEditedUpdate(update);
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

    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      if (text) return text;
    }

    if (typeof value === 'object') {
      const nested =
        value.payload ||
        value.data ||
        value.value ||
        value.text ||
        value.callback_data ||
        value.callbackData;

      if (nested !== undefined && nested !== null) {
        const text = String(nested).trim();
        if (text) return text;
      }
    }
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
  if (String(update?.update_type || '').toLowerCase() === 'bot_started') {
    const startedUserId = String(
      update?.user?.user_id ||
      update?.user_id ||
      update?.user?.id ||
      ''
    ).trim();

    if (startedUserId) {
      return {
        type: 'user_id',
        id: startedUserId
      };
    }
  }

  const callback = update?.callback;
  const callbackMessage = callback?.message;
  const callbackRecipient = callbackMessage?.recipient;

  // В личном диалоге recipient.user_id часто является ID бота/получателя,
  // а реальный человек находится в callback.user. Отвечаем именно человеку.
  if (isDialogLikeRecipient(callbackRecipient) && callback?.user?.user_id) {
    return {
      type: 'user_id',
      id: callback.user.user_id
    };
  }

  if (callbackRecipient?.chat_id && isProbablyChannelChat(callbackRecipient)) {
    return {
      type: 'chat_id',
      id: callbackRecipient.chat_id
    };
  }

  if (callback?.user?.user_id) {
    return {
      type: 'user_id',
      id: callback.user.user_id
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

  // В message_created из личного диалога recipient.user_id — это получатель,
  // поэтому для ответа нужен sender.user_id. Иначе MAX может получить chat_id: 0.
  if (isDialogLikeRecipient(recipient) && message?.sender?.user_id) {
    return {
      type: 'user_id',
      id: message.sender.user_id
    };
  }

  if (recipient?.chat_id && isProbablyChannelChat(recipient)) {
    return {
      type: 'chat_id',
      id: recipient.chat_id
    };
  }

  if (message?.sender?.user_id) {
    return {
      type: 'user_id',
      id: message.sender.user_id
    };
  }

  if (recipient?.user_id) {
    return {
      type: 'user_id',
      id: recipient.user_id
    };
  }

  if (update?.chat_id && isChannelIdLike(update.chat_id)) {
    return {
      type: 'chat_id',
      id: update.chat_id
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
    update?.callback?.message?.recipient?.user_id ||
    update?.message?.sender?.user_id ||
    update?.message?.recipient?.user_id ||
    update?.user?.user_id ||
    update?.user_id ||
    (target?.type === 'user_id' ? target.id : '') ||
    ''
  );
}

function getUserFromMaxUpdate(update, target = null) {
  const id = String(getStableUserId(update, target) || '').trim();

  // Для callback MAX присылает два разных пользователя:
  // callback.user — реальный человек, который нажал кнопку;
  // message.sender — бот, который отправил сообщение с кнопкой.
  // Поэтому callback.user должен иметь приоритет, иначе в таблицу users пишется имя бота.
  const candidates = [
    update?.callback?.user,
    update?.user,
    update?.message?.sender,
    update?.callback?.message?.recipient,
    target?.type === 'user_id' ? { user_id: target.id } : null
  ].filter(Boolean);

  let sender = candidates.find(candidate => {
    const candidateId = String(
      candidate?.user_id ||
      candidate?.userId ||
      candidate?.id ||
      ''
    ).trim();

    return id && candidateId && String(candidateId) === String(id);
  }) || candidates[0] || {};

  return {
    id,
    username: sender.username || sender.login || null,
    first_name: sender.first_name || sender.firstName || sender.name || sender.full_name || null,
    last_name: sender.last_name || sender.lastName || null,
    profile_link: extractUserProfileLinkFromObject(sender) || extractUserProfileLinkFromObject(update) || null
  };
}

function normalizeMaxMessage(update) {
  const target = getReplyTarget(update);
  const from = getUserFromMaxUpdate(update, target);
  const body = update?.message?.body || update?.body || {};

  if (!target || !from.id) {
    return null;
  }

  return {
    from,
    chat: {
      id: target
    },
    text: getIncomingText(update),
    attachments: extractMessageAttachments(update),
    markup: Array.isArray(body?.markup) ? body.markup : [],
    body,
    raw: update
  };
}

function extractCallbackMessageId(update) {
  const candidates = [
    update?.callback?.message?.body?.mid,
    update?.callback?.message?.body?.message_id,
    update?.callback?.message?.mid,
    update?.callback?.message?.message_id,
    update?.callback?.message?.id,
    update?.message?.body?.mid,
    update?.message?.body?.message_id,
    update?.message?.mid,
    update?.message?.message_id,
    update?.message?.id
  ];

  const found = candidates.find(value => value !== undefined && value !== null && String(value).trim());
  return found ? String(found).trim() : '';
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
      id: extractCallbackMessageId(update),
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
function buildWelcomeText(userOrId) {
  const userId = typeof userOrId === 'object' ? userOrId.id : userOrId;
  const firstName = typeof userOrId === 'object'
    ? String(userOrId.first_name || userOrId.firstName || userOrId.name || '').trim()
    : '';
  const helloName = firstName || 'друг';
  const permissionsLink = markdownLink('права', PERMISSIONS_HELP_IMAGE_URL);
  const adminLine = isAdmin(userId)
    ? '\n\n👑 Вам доступна админ-панель в главном меню.'
    : '';

  return [
    `👋 **Привет, ${helloName}!**`,
    '',
    'Я бот для честных розыгрышей в MAX.',
    '',
    `Сначала добавьте бота ${BOT_USERNAME} в канал или найдите его по имени **${BOT_SEARCH_NAME}**.`,
    `Затем выдайте боту ${permissionsLink} администратора на размещение постов и нажмите **Добавить канал** / **Обновить** в меню.`,
    '',
    '**Через меню можно создать розыгрыш, подключить каналы, добавить фото к посту, создавать АВТОПОСТ и тесты для ваших каналов, пригласить соадмина и смотреть статистику.**',
    adminLine
  ].join('\n');
}

async function sendWelcome(target, userOrId) {
  return sendMessage(target, buildWelcomeText(userOrId));
}

function buildPermissionsHelpAttachment() {
  if (!PERMISSIONS_HELP_IMAGE_URL) return null;

  return {
    type: 'image',
    url: PERMISSIONS_HELP_IMAGE_URL,
    payload: {
      url: PERMISSIONS_HELP_IMAGE_URL
    }
  };
}

async function sendPermissionsHelp(target) {
  const keyboard = [[{ text: '⬅️ Назад', callback_data: 'welcome_back' }]];
  const attachment = buildPermissionsHelpAttachment();

  if (attachment) {
    try {
      return await sendMessage(
        target,
        PERMISSIONS_HELP_TEXT || 'Инструкция по выдаче прав боту.',
        keyboard,
        [attachment]
      );
    } catch (error) {
      console.warn('Не удалось отправить фото инструкции по правам:', error.message);
    }
  }

  return sendMessage(
    target,
    [
      PERMISSIONS_HELP_TEXT || 'Инструкция по выдаче прав боту.',
      '',
      PERMISSIONS_HELP_IMAGE_URL
        ? markdownLink('Открыть инструкцию', PERMISSIONS_HELP_IMAGE_URL)
        : 'Ссылка на фото инструкции пока не настроена. Добавьте `PERMISSIONS_HELP_IMAGE_URL` в `.env`.'
    ].join('\n'),
    keyboard
  );
}

async function sendMainMenu(target, userId = null) {
  const keyboard = [
    [{ text: '🎉 Создать розыгрыш', callback_data: 'create_raffle' }],
    [
      { text: '➕ Добавить канал', callback_data: 'add_channel' },
      { text: '📢 Мои каналы', callback_data: 'my_channels' }
    ],
    [{ text: '🔎 Мои розыгрыши', callback_data: 'my_raffles' }],
    [{ text: '🎁 Участвовать', callback_data: 'join_latest' }]
  ];

  if (userId && isAdmin(userId)) {
    keyboard.push([{ text: '👑 Админ-панель', callback_data: 'admin_panel' }]);
  }


  return sendMessage(target, 'Выберите действие:', keyboard);
}

function buildLegalLinksLines() {
  const lines = [];

  if (LEGAL_PRIVACY_URL) {
    lines.push(`• ${markdownLink('Политика конфиденциальности', LEGAL_PRIVACY_URL)}`);
  } else {
    lines.push('• Политика конфиденциальности');
  }

  if (LEGAL_OFFER_URL) {
    lines.push(`• ${markdownLink('Публичная оферта', LEGAL_OFFER_URL)}`);
  } else {
    lines.push('• Публичная оферта');
  }

  if (LEGAL_PERSONAL_DATA_URL) {
    lines.push(`• ${markdownLink('Согласие на обработку персональных данных', LEGAL_PERSONAL_DATA_URL)}`);
  } else {
    lines.push('• Согласие на обработку персональных данных');
  }

  return lines;
}

function buildLegalAcceptanceKeyboard() {
  return [
    [{ text: '✅ Принять и продолжить', callback_data: 'legal_accept' }]
  ];
}

function buildLegalAcceptanceText() {
  return [
    'Перед началом работы с ботом нужно принять условия.',
    '',
    'Продолжая пользоваться ботом, вы подтверждаете, что ознакомились и соглашаетесь с документами:',
    ...buildLegalLinksLines(),
    '',
    'Нажмите **✅ Принять и продолжить**.'
  ].join('\n');
}

async function sendLegalAcceptance(target) {
  return sendMessage(
    target,
    buildLegalAcceptanceText(),
    buildLegalAcceptanceKeyboard()
  );
}

async function hasAcceptedLegal(userId) {
  const id = String(userId || '').trim();
  if (!id) return false;

  const res = await pool.query(`
    SELECT 1
    FROM user_legal_acceptances
    WHERE user_id = $1
      AND legal_version = $2
    LIMIT 1
  `, [id, LEGAL_VERSION]);

  return Boolean(res.rows[0]);
}

async function acceptLegal(userId) {
  const id = String(userId || '').trim();
  if (!id) return false;

  await pool.query(`
    INSERT INTO user_legal_acceptances (user_id, legal_version, accepted_at, updated_at)
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (user_id, legal_version)
    DO UPDATE SET
      accepted_at = COALESCE(user_legal_acceptances.accepted_at, NOW()),
      updated_at = NOW()
  `, [id, LEGAL_VERSION]);

  return true;
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
  const profileLink = normalizeMaxProfileLink(from.profile_link || from.profileLink || from.profile_url || from.profileUrl || from.link || from.url || '');

  await pool.query(`
    INSERT INTO users (max_user_id, username, first_name, last_name, profile_link, is_broadcast_available)
    VALUES ($1, $2, $3, $4, $5, true)
    ON CONFLICT (max_user_id)
    DO UPDATE SET
      username = COALESCE(EXCLUDED.username, users.username),
      first_name = COALESCE(EXCLUDED.first_name, users.first_name),
      last_name = COALESCE(EXCLUDED.last_name, users.last_name),
      profile_link = COALESCE(NULLIF(EXCLUDED.profile_link, ''), users.profile_link),
      is_broadcast_available = true,
      broadcast_failed_at = NULL,
      broadcast_fail_reason = NULL,
      updated_at = NOW()
  `, [userId, username, firstName, lastName, profileLink || null]);
}


async function getUserByMaxId(userId) {
  const id = String(userId || '').trim();
  if (!id) return null;

  const res = await pool.query(`
    SELECT max_user_id, username, first_name, last_name, profile_link
    FROM users
    WHERE max_user_id = $1
    LIMIT 1
  `, [id]);

  return res.rows[0] || {
    max_user_id: id,
    user_id: id,
    username: null,
    first_name: null,
    last_name: null,
    profile_link: null
  };
}


async function setUserProfileLink(userId, profileLink) {
  const id = String(userId || '').trim();
  const link = normalizeMaxProfileLink(profileLink);

  if (!id || !link) return null;

  const res = await pool.query(`
    UPDATE users
    SET profile_link = $2, updated_at = NOW()
    WHERE max_user_id = $1
    RETURNING max_user_id, username, first_name, last_name, profile_link
  `, [id, link]);

  return res.rows[0] || null;
}

function extractProfileLinkCommand(text) {
  const clean = String(text || '').trim();
  const match = clean.match(/^(?:\/profile|\/профиль|\/link|\/ссылка)(?:\s+(.+))?$/i);

  if (!match) return null;

  return String(match[1] || '').trim();
}

function buildProfileLinkInstruction() {
  return [
    'Чтобы имя в итогах было кликабельным, отправьте свою ссылку профиля MAX командой:',
    '`/profile https://max.ru/u/ВАША_ССЫЛКА`',
    '',
    'Ссылку можно скопировать в приложении MAX из профиля. В итогах бот также использует официальное MAX-упоминание max://user/user_id, поэтому отдельная ссылка нужна только как запасной вариант.'
  ].join('\n');
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
    INSERT INTO raffles (creator_user_id, title, publish_at, end_at, status)
    VALUES ($1, 'Без названия', NOW(), NOW() + INTERVAL '1 day', 'draft')
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
    'publish_at',
    'end_at',
    'photo_attachment',
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

async function cleanupUserRafflesList(userId) {
  // В разделе «Мои розыгрыши» показываем только последние USER_RAFFLES_VISIBLE_LIMIT розыгрышей.
  // Старые завершённые/черновые записи мягко скрываются из списка, а не удаляются из БД:
  // статистика, участники, победители и посты остаются доступны по ID, пока розыгрыш нужен организатору.
  await pool.query(`
    UPDATE raffles
    SET
      is_hidden_from_my_raffles = false,
      updated_at = NOW()
    WHERE creator_user_id = $1
      AND status IN ('scheduled', 'active')
      AND COALESCE(is_hidden_from_my_raffles, false) = true
  `, [userId]);

  await pool.query(`
    UPDATE raffles r
    SET
      is_hidden_from_my_raffles = true,
      updated_at = NOW()
    WHERE r.creator_user_id = $1
      AND COALESCE(r.is_hidden_from_my_raffles, false) = false
      AND r.status IN ('finished', 'draft', 'cancelled', 'failed', 'archived')
      AND r.id NOT IN (
        SELECT id
        FROM raffles
        WHERE creator_user_id = $1
          AND COALESCE(is_hidden_from_my_raffles, false) = false
        ORDER BY id DESC
        LIMIT $2
      )
  `, [userId, USER_RAFFLES_VISIBLE_LIMIT]);
}

async function getUserRaffles(userId) {
  await cleanupUserRafflesList(userId);

  // В «Мои розыгрыши» сначала всегда показываем последние активные/запланированные.
  // Так действующие розыгрыши не пропадают из списка из-за новых завершённых/архивных записей.
  const res = await pool.query(`
    SELECT *
    FROM raffles
    WHERE creator_user_id = $1
      AND COALESCE(is_hidden_from_my_raffles, false) = false
    ORDER BY
      CASE WHEN status IN ('scheduled', 'active') THEN 0 ELSE 1 END,
      id DESC
    LIMIT $2
  `, [userId, USER_RAFFLES_VISIBLE_LIMIT]);

  return res.rows;
}


async function getUserCollaborationRaffles(userId) {
  const cleanUserId = String(userId || '').trim();

  if (!cleanUserId) {
    return [];
  }

  const res = await pool.query(`
    SELECT
      r.*,
      COUNT(DISTINCT rc.channel_id)::int AS collab_channels_count,
      STRING_AGG(DISTINCT COALESCE(rc.channel_title, rc.channel_id::text), ', ' ORDER BY COALESCE(rc.channel_title, rc.channel_id::text)) AS collab_channels_titles
    FROM raffles r
    JOIN raffle_channels rc ON rc.raffle_id = r.id
    WHERE rc.owner_user_id::text = $1
      AND r.creator_user_id::text <> $1
    GROUP BY r.id
    ORDER BY
      CASE WHEN r.status IN ('scheduled', 'active') THEN 0 ELSE 1 END,
      r.id DESC
    LIMIT $2
  `, [cleanUserId, USER_RAFFLES_VISIBLE_LIMIT]);

  return res.rows;
}

async function addRaffleChannel(
  raffleId,
  channelId,
  channelTitle,
  isRequired = true,
  publishPost = true,
  channelLink = '',
  ownerUserId = null
) {
  await pool.query(`
    INSERT INTO raffle_channels (
      raffle_id,
      channel_id,
      channel_title,
      channel_link,
      owner_user_id,
      is_required,
      publish_post
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT DO NOTHING
  `, [
    raffleId,
    channelId,
    safeText(channelTitle || `Канал ${channelId}`, 255),
    safeText(channelLink || '', 1000),
    ownerUserId,
    isRequired,
    publishPost
  ]);
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

function findNextGeneralPromoSlot(busyRows = [], startDate = new Date()) {
  const spacingMs = GENERAL_PROMO_SPACING_MINUTES * 60 * 1000;
  let candidateMs = Math.max(Date.now(), new Date(startDate).getTime());

  const busyTimes = busyRows
    .map(row => new Date(row.busy_at || row.scheduled_at || row.created_at).getTime())
    .filter(value => Number.isFinite(value))
    .sort((a, b) => a - b);

  for (const busyMs of busyTimes) {
    if (busyMs < candidateMs - spacingMs) {
      continue;
    }

    if (Math.abs(busyMs - candidateMs) < spacingMs) {
      candidateMs = busyMs + spacingMs;
      continue;
    }

    if (busyMs > candidateMs) {
      break;
    }
  }

  return new Date(candidateMs);
}


function buildAdminCommunityInviteText() {
  return `⁉️У вас свой канал в MAX. Заходите в наш закрытый канал🔐 для ${markdownLink(ADMIN_COMMUNITY_INVITE_LABEL, ADMIN_COMMUNITY_INVITE_URL)} для общения и продвижения каналов📢`;
}

async function scheduleAdminCommunityInviteAfterRaffleCreate(raffleId, userId) {
  const cleanUserId = String(userId || '').trim();

  if (!cleanUserId) return null;

  const res = await pool.query(`
    INSERT INTO raffle_queue (raffle_id, queue_type, scheduled_at, payload)
    VALUES (
      $1,
      'admin_community_invite',
      NOW() + ($2::text || ' minutes')::interval,
      $3::jsonb
    )
    RETURNING *
  `, [
    raffleId,
    ADMIN_COMMUNITY_INVITE_DELAY_MINUTES,
    JSON.stringify({
      user_id: cleanUserId,
      delay_minutes: ADMIN_COMMUNITY_INVITE_DELAY_MINUTES,
      reason: 'after_raffle_created'
    })
  ]);

  return res.rows[0] || null;
}

async function sendAdminCommunityInviteQueuedItem(item) {
  const payload = item?.payload && typeof item.payload === 'object' ? item.payload : {};
  let userId = String(payload.user_id || '').trim();

  if (!userId && item?.raffle_id) {
    const raffle = await getRaffleById(item.raffle_id);
    userId = String(raffle?.creator_user_id || '').trim();
  }

  if (!userId) {
    throw new Error(`Не найден user_id для admin_community_invite queue item ${item?.id || ''}`);
  }

  await sendMessage(userId, buildAdminCommunityInviteText());

  return { status: 'sent', userId };
}

async function schedulePaidGeneralPublish(raffleId, options = {}) {
  if (!GENERAL_CHANNEL_ID) {
    return { status: 'missing_general_channel' };
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Глобальный lock для General-очереди: два платежа одновременно не займут одно и то же окно.
    await client.query('SELECT pg_advisory_xact_lock($1)', [2026060501]);

    const raffleRes = await client.query(`
      SELECT *
      FROM raffles
      WHERE id = $1
      FOR UPDATE
    `, [raffleId]);

    const raffle = raffleRes.rows[0] || null;

    if (!raffle) {
      await client.query('COMMIT');
      return { status: 'missing_raffle' };
    }

    if (String(raffle.status || '') !== 'active') {
      await client.query('COMMIT');
      return { status: 'not_active', raffle };
    }

    const isAdminManualGeneralPublish = Boolean(options.adminManual || options.allowWithoutPayment);
    const requestedPaymentId = String(options.paymentId || '').trim();
    let paidPayment = null;

    if (isAdminManualGeneralPublish) {
      paidPayment = {
        payment_id: requestedPaymentId || `admin_manual_${raffle.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        manual_admin_publish: true,
        status: 'succeeded'
      };
    } else if (requestedPaymentId) {
      const paidRes = await client.query(`
        SELECT *
        FROM raffle_promo_payments
        WHERE payment_id = $1
          AND raffle_id = $2
          AND product = $3
          AND status = 'succeeded'
        LIMIT 1
      `, [requestedPaymentId, raffle.id, PROMO_GENERAL_PRODUCT_CODE]);

      paidPayment = paidRes.rows[0] || null;
    } else {
      const paidRes = await client.query(`
        SELECT p.*
        FROM raffle_promo_payments p
        WHERE p.raffle_id = $1
          AND p.product = $2
          AND p.status = 'succeeded'
          AND NOT EXISTS (
            SELECT 1
            FROM raffle_queue q
            WHERE q.queue_type = 'general_publish'
              AND q.status IN ('pending', 'processing', 'done')
              AND q.payload->>'payment_id' = p.payment_id
          )
        ORDER BY p.paid_at ASC NULLS LAST, p.created_at ASC
        LIMIT 1
      `, [raffle.id, PROMO_GENERAL_PRODUCT_CODE]);

      paidPayment = paidRes.rows[0] || null;
    }

    if (!paidPayment) {
      await client.query('COMMIT');
      return { status: 'not_paid', raffle };
    }

    const paymentId = String(paidPayment.payment_id || requestedPaymentId || '').trim();

    if (!paymentId) {
      await client.query('COMMIT');
      return { status: 'missing_payment_id', raffle };
    }

    // Повторные платные размещения одного активного розыгрыша разрешены.
    // Поэтому НЕ проверяем “уже есть пост в General” по raffle_id.
    // Дедупликация идёт только по конкретной оплате/payment_id, чтобы webhook-ретраи не создали дубль.
    const existingQueueRes = await client.query(`
      SELECT *
      FROM raffle_queue
      WHERE queue_type = 'general_publish'
        AND status IN ('pending', 'processing', 'done')
        AND payload->>'payment_id' = $1
      ORDER BY scheduled_at ASC
      LIMIT 1
    `, [paymentId]);

    if (existingQueueRes.rows[0]) {
      await client.query('COMMIT');
      return {
        status: 'already_queued',
        raffle,
        payment: paidPayment,
        queue: existingQueueRes.rows[0],
        scheduledAt: existingQueueRes.rows[0].scheduled_at
      };
    }

    const busyRes = await client.query(`
      SELECT scheduled_at AS busy_at
      FROM raffle_queue
      WHERE queue_type = 'general_publish'
        AND status IN ('pending', 'processing', 'done')
        AND scheduled_at >= NOW() - ($1::text || ' minutes')::interval

      UNION ALL

      SELECT created_at AS busy_at
      FROM raffle_posts
      WHERE channel_id = $2
        AND created_at >= NOW() - ($1::text || ' minutes')::interval

      ORDER BY busy_at ASC
    `, [GENERAL_PROMO_SPACING_MINUTES, GENERAL_CHANNEL_ID]);

    const scheduledAt = findNextGeneralPromoSlot(busyRes.rows);

    const insertRes = await client.query(`
      INSERT INTO raffle_queue (raffle_id, queue_type, scheduled_at, payload)
      VALUES ($1, 'general_publish', $2, $3::jsonb)
      RETURNING *
    `, [
      raffle.id,
      scheduledAt,
      JSON.stringify({
        product: PROMO_GENERAL_PRODUCT_CODE,
        payment_id: paymentId,
        spacing_minutes: GENERAL_PROMO_SPACING_MINUTES,
        requested_by: options.userId ? String(options.userId) : String(raffle.creator_user_id || ''),
        reason: options.reason || (isAdminManualGeneralPublish ? 'admin_manual_general_publish' : 'paid_general_promo'),
        admin_manual_publish: isAdminManualGeneralPublish
      })
    ]);

    await client.query('COMMIT');

    return {
      status: 'queued',
      raffle,
      payment: paidPayment,
      queue: insertRes.rows[0],
      scheduledAt
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function schedulePaidGeneralPublishesForRaffle(raffleId, options = {}) {
  const results = [];

  while (true) {
    const result = await schedulePaidGeneralPublish(raffleId, options);
    results.push(result);

    if (result?.status !== 'queued') {
      break;
    }
  }

  return results;
}

function formatGeneralPromoQueueResult(result) {
  const scheduledAt = result?.scheduledAt || result?.queue?.scheduled_at;

  if (['queued', 'already_queued'].includes(String(result?.status || '')) && scheduledAt) {
    return `Публикация в General-канале запланирована на **${formatDateTime(scheduledAt)}**. Интервал между платными постами — **${GENERAL_PROMO_SPACING_MINUTES} мин.**`;
  }

  return `Бот поставит розыгрыш в очередь General-канала и опубликует в ближайшее свободное окно с интервалом **${GENERAL_PROMO_SPACING_MINUTES} мин.**`;
}

function formatGeneralPublishAdminResult(result) {
  const status = String(result?.status || '');

  if (status === 'missing_general_channel') {
    return '⚠️ GENERAL_CHANNEL_ID не задан в `.env`, поэтому публикация в General-канал невозможна.';
  }

  if (status === 'missing_raffle') {
    return '⚠️ Розыгрыш не найден.';
  }

  if (status === 'not_active') {
    return '⚠️ В General можно поставить только активный розыгрыш.';
  }

  if (['queued', 'already_queued'].includes(status)) {
    return `✅ Розыгрыш поставлен в очередь General-канала. ${formatGeneralPromoQueueResult(result)}`;
  }

  return `⚠️ Не удалось поставить розыгрыш в очередь General. Статус: ${displayValue(status, 'неизвестно')}.`;
}

async function adminScheduleGeneralPublish(target, userId, raffleId) {
  if (!isAdmin(userId)) {
    return sendMessage(target, '⛔ Публикация в General из админ-панели доступна только администраторам.');
  }

  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
  }

  if (String(raffle.status || '') !== 'active') {
    return sendMessage(
      target,
      [
        '⚠️ В General-канал можно поставить только **активный** розыгрыш.',
        '',
        `Розыгрыш № **${getRafflePublicNumber(raffle)}**`,
        `Текущий статус: **${formatRaffleStatus(raffle.status)}**`
      ].join('\n')
    );
  }

  if (!GENERAL_CHANNEL_ID) {
    return sendMessage(target, '⚠️ GENERAL_CHANNEL_ID не задан в `.env`. Сначала укажите ID General-канала и перезапустите бота.');
  }

  try {
    const result = await schedulePaidGeneralPublish(raffle.id, {
      userId,
      adminManual: true,
      reason: 'admin_panel_general_publish'
    });

    return sendMessage(
      target,
      [
        '📣 **Админ-публикация в General**',
        '',
        `Розыгрыш № **${getRafflePublicNumber(raffle)}**`,
        `Название: **${displayValue(raffle.title, 'Без названия')}**`,
        '',
        formatGeneralPublishAdminResult(result)
      ].join('\n'),
      [
        [{ text: '🔥 Активные розыгрыши', callback_data: 'admin_active' }],
        [{ text: '📊 Статистика розыгрыша', callback_data: `raffle_stats:${raffle.id}` }],
        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
      ]
    );
  } catch (error) {
    console.error('Ошибка ручной General-публикации админом:', error);
    return sendMessage(
      target,
      [
        '⚠️ Не удалось поставить розыгрыш в очередь General.',
        '',
        `Ошибка: ${safeText(error.message, 500)}`
      ].join('\n')
    );
  }
}

async function publishPaidGeneralQueuedItem(item) {
  const raffle = await getRaffleById(item.raffle_id);

  if (!raffle) {
    throw new Error(`Розыгрыш ${item.raffle_id} не найден для платной публикации в General`);
  }

  if (String(raffle.status || '') !== 'active') {
    throw new Error(`Розыгрыш ${item.raffle_id} ещё не active, текущий статус: ${raffle.status}`);
  }

  if (!GENERAL_CHANNEL_ID) {
    throw new Error('GENERAL_CHANNEL_ID не задан');
  }

  const payload = item?.payload && typeof item.payload === 'object' ? item.payload : {};
  const isAdminManualGeneralPublish = Boolean(payload.admin_manual_publish);

  if (!isAdminManualGeneralPublish) {
    const paidRes = await pool.query(`
      SELECT 1
      FROM raffle_promo_payments
      WHERE raffle_id = $1
        AND product = $2
        AND status = 'succeeded'
      LIMIT 1
    `, [raffle.id, PROMO_GENERAL_PRODUCT_CODE]);

    if (!paidRes.rows.length) {
      throw new Error(`Для розыгрыша ${raffle.id} нет успешной оплаты General-размещения`);
    }
  }

  const paymentId = String(payload.payment_id || '').trim();

  if (paymentId) {
    const paymentQueueRes = await pool.query(`
      SELECT id
      FROM raffle_queue
      WHERE queue_type = 'general_publish'
        AND status IN ('done', 'processing')
        AND payload->>'payment_id' = $1
        AND id <> $2
      LIMIT 1
    `, [paymentId, item.id]);

    if (paymentQueueRes.rows.length) {
      return { status: 'already_published_for_payment', raffle };
    }
  }

  await publishRaffleToChannel(raffle, GENERAL_CHANNEL_ID);

  await sendMessage(
    raffle.creator_user_id,
    [
      isAdminManualGeneralPublish
        ? '✅ **Админ-размещение опубликовано в General-канале.**'
        : '✅ **Платное размещение опубликовано в нашем канале розыгрышей.**',
      '',
      `Розыгрыш № **${getRafflePublicNumber(raffle)}**`,
      `Название: **${displayValue(raffle.title, 'Без названия')}**`
    ].join('\n')
  ).catch(() => {});

  return { status: 'published', raffle };
}

async function createParticipantEntry(raffleId, userId, invitedBy = null, sourceChannelId = null) {
  const client = await pool.connect();
  const referrerId = invitedBy && Number(invitedBy) !== Number(userId)
    ? Number(invitedBy)
    : null;

  try {
    await client.query('BEGIN');

    // Не используем ON CONFLICT здесь напрямую: у старых баз таблица могла быть создана
    // без уникального индекса (raffle_id, user_id), из-за чего PostgreSQL падал с ошибкой:
    // "there is no unique or exclusion constraint matching the ON CONFLICT specification".
    const existingEntry = await client.query(`
      SELECT id, source_channel_id
      FROM raffle_user_entry
      WHERE raffle_id = $1 AND user_id = $2
      LIMIT 1
    `, [raffleId, userId]);

    if (existingEntry.rows.length) {
      if (sourceChannelId && !existingEntry.rows[0].source_channel_id) {
        await client.query(`
          UPDATE raffle_user_entry
          SET source_channel_id = $3
          WHERE raffle_id = $1 AND user_id = $2
        `, [raffleId, userId, sourceChannelId]);
      }

      await client.query('COMMIT');
      return { alreadyJoined: true };
    }

    try {
      await client.query(`
        INSERT INTO raffle_user_entry (raffle_id, user_id, source_channel_id)
        VALUES ($1, $2, $3)
      `, [raffleId, userId, sourceChannelId]);
    } catch (error) {
      if (error?.code === '23505') {
        await client.query('ROLLBACK');
        return { alreadyJoined: true };
      }

      throw error;
    }

    const ticketNumber = randomTicketNumber();

    await client.query(`
      INSERT INTO raffle_participants (raffle_id, user_id, ticket_number, invited_by, is_valid, ticket_type)
      VALUES ($1, $2, $3, $4, true, 'main')
    `, [raffleId, userId, ticketNumber, referrerId]);

    let bonusAdded = false;
    let bonusTicketNumber = null;
    let bonusLimitReached = false;
    let referrerNotFound = false;
    let referrerBonusCount = 0;

    if (referrerId) {
      const refUser = await client.query(
        `SELECT max_user_id FROM users WHERE max_user_id = $1`,
        [referrerId]
      );

      if (refUser.rows.length) {
        const countRes = await client.query(`
          SELECT COUNT(*)::int AS count
          FROM raffle_participants
          WHERE raffle_id = $1
            AND user_id = $2
            AND COALESCE(ticket_type, '') = 'referral_bonus'
        `, [raffleId, referrerId]);

        referrerBonusCount = countRes.rows[0]?.count || 0;

        if (referrerBonusCount < MAX_REFERRAL_BONUS_TICKETS) {
          bonusTicketNumber = randomTicketNumber();

          await client.query(`
            INSERT INTO raffle_participants (raffle_id, user_id, ticket_number, invited_by, is_valid, ticket_type)
            VALUES ($1, $2, $3, $4, true, 'referral_bonus')
          `, [raffleId, referrerId, bonusTicketNumber, userId]);

          bonusAdded = true;
          referrerBonusCount += 1;
        } else {
          bonusLimitReached = true;
        }
      } else {
        referrerNotFound = true;
      }
    }

    await client.query('COMMIT');

    return {
      alreadyJoined: false,
      ticketNumber,
      bonusAdded,
      bonusTicketNumber,
      bonusLimitReached,
      referrerNotFound,
      referrerId,
      referrerBonusCount
    };
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
  const usedUsers = new Set();
  let prizeIndex = 0;

  for (const winner of winners) {
    const userId = String(winner?.user_id || '').trim();
    if (!userId || usedUsers.has(userId)) continue;

    usedUsers.add(userId);
    const prizeText = prizes[prizeIndex] || `Приз ${prizeIndex + 1}`;

    try {
      await pool.query(`
        INSERT INTO raffle_winners (raffle_id, user_id, ticket_number, prize_text)
        VALUES ($1, $2, $3, $4)
      `, [raffleId, winner.user_id, winner.ticket_number, prizeText]);
    } catch (error) {
      // Дополнительная защита на уровне кода: один пользователь не может получить два приза
      // в одном розыгрыше, даже если в БД остались старые дубли билетов.
      if (error?.code !== '23505') throw error;
    }

    prizeIndex += 1;
  }
}

function isBroadcastDialogUnavailableError(error) {
  const message = String(error?.message || error || '').toLowerCase();

  return (
    message.includes('dialog.not.found') ||
    message.includes('error.dialog.notfound') ||
    message.includes('dialog.notfound') ||
    message.includes('dialog.suspended') ||
    message.includes('error.dialog.suspended') ||
    message.includes('bot was blocked') ||
    message.includes('user blocked')
  );
}

async function markUserBroadcastUnavailable(userId, reason = '') {
  const id = String(userId || '').trim();
  if (!id) return false;

  await pool.query(`
    UPDATE users
    SET
      is_broadcast_available = false,
      broadcast_failed_at = NOW(),
      broadcast_fail_reason = $2,
      updated_at = NOW()
    WHERE max_user_id = $1
  `, [id, safeText(reason || 'dialog unavailable', 500)]);

  return true;
}

async function markUserBroadcastSuccess(userId) {
  const id = String(userId || '').trim();
  if (!id) return false;

  await pool.query(`
    UPDATE users
    SET
      is_broadcast_available = true,
      last_broadcast_success_at = NOW(),
      broadcast_failed_at = NULL,
      broadcast_fail_reason = NULL,
      updated_at = NOW()
    WHERE max_user_id = $1
  `, [id]);

  return true;
}

async function getGlobalStats() {
  const users = await pool.query(`SELECT COUNT(*)::int AS count FROM users`);
  const activeUsers = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM users
    WHERE COALESCE(is_broadcast_available, true) = true
  `);
  const inactiveUsers = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM users
    WHERE COALESCE(is_broadcast_available, true) = false
  `);
  const raffles = await pool.query(`SELECT COUNT(*)::int AS count FROM raffles`);
  const participants = await pool.query(`SELECT COUNT(*)::int AS count FROM raffle_participants`);

  return {
    users: users.rows[0].count,
    activeUsers: activeUsers.rows[0].count,
    inactiveUsers: inactiveUsers.rows[0].count,
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

  if (negativeStatuses.includes(status)) return false;

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

  if (Array.isArray(body)) return body;

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

    if (Array.isArray(candidate)) return candidate;

    if (typeof candidate === 'object') {
      if (getMemberUserId(candidate)) return [candidate];

      const values = Object.values(candidate);

      if (values.some(value => getMemberUserId(value))) return values;

      const firstArray = values.find(Array.isArray);
      if (firstArray) return firstArray;
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
        if (SUBSCRIPTION_CHECK_VERBOSE_LOGS) {
          console.log('Outgoing DIRECT raffle subscription check:', JSON.stringify({
            method: 'GET',
            path,
            query,
            expectedUserId,
            channelId
          }));
        }

        const directResult = await maxRequest(path, {
          method: 'GET',
          query
        });

        const directMembers = extractMembersFromMaxResponse(directResult);
        if (SUBSCRIPTION_CHECK_VERBOSE_LOGS) {
          console.log('DIRECT raffle subscription check response:', JSON.stringify({
            channelId,
            expectedUserId,
            membersCount: directMembers.length,
            sampleIds: directMembers.slice(0, 10).map(member => String(getMemberUserId(member) || ''))
          }));
        }

        if (responseContainsActiveUser(directResult, expectedUserId)) {
          return true;
        }
      } catch (error) {
        console.warn('Direct subscription check failed:', error.message);
      }
    }

    let marker = '';
    let page = 0;

    const maxPages = SUBSCRIPTION_FALLBACK_MAX_PAGES;
    const pageSize = SUBSCRIPTION_PAGE_SIZE;
    const seenMarkers = new Set();

    while (page < maxPages) {
      page += 1;

      const query = { count: pageSize };
      if (marker) query.marker = marker;

      if (SUBSCRIPTION_CHECK_VERBOSE_LOGS) {
        console.log('Outgoing raffle subscription check page:', JSON.stringify({
          method: 'GET',
          path,
          query,
          expectedUserId,
          channelId,
          page
        }));
      }

      const result = await maxRequest(path, {
        method: 'GET',
        query
      });

      const pageMembers = extractMembersFromMaxResponse(result);
      if (SUBSCRIPTION_CHECK_VERBOSE_LOGS) {
        if (SUBSCRIPTION_CHECK_VERBOSE_LOGS) {
          console.log('Raffle subscription check page response:', JSON.stringify({
            page,
            channelId,
            expectedUserId,
            membersCount: pageMembers.length,
            sampleIds: pageMembers.slice(0, 10).map(member => String(getMemberUserId(member) || ''))
          }));
        }
      }

      if (responseContainsActiveUser(result, expectedUserId)) {
        return true;
      }

      const nextMarker = getNextMembersMarker(result);

      if (!nextMarker || nextMarker === marker || seenMarkers.has(nextMarker)) break;

      seenMarkers.add(nextMarker);
      marker = nextMarker;
    }

    console.log('🔎 Проверка подписки завершена:', JSON.stringify({
      user_id: expectedUserId,
      channel_id: String(channelId),
      subscribed: false,
      fallback_pages_checked: page
    }));

    return false;
  } catch (error) {
    console.warn(
      `Subscription check failed for user ${expectedUserId}, channel ${channelId}:`,
      error.message
    );

    return false;
  }
}


function isMaxChannelPermissionError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('chat.denied') ||
    message.includes('not enough permissions') ||
    message.includes('user is not admin') ||
    message.includes('max api 403');
}

async function checkUserSubscribedToChannelDetailed(userId, channelId) {
  const expectedUserId = String(userId).trim();
  const encodedChannelId = encodeURIComponent(String(channelId).trim());
  const path = `/chats/${encodedChannelId}/members`;
  let permissionProblem = false;
  let lastPermissionError = '';

  try {
    const directQueries = [
      { user_ids: expectedUserId },
      { user_id: expectedUserId },
      { count: 100, user_ids: expectedUserId },
      { count: 100, user_id: expectedUserId }
    ];

    for (const query of directQueries) {
      try {
        if (SUBSCRIPTION_CHECK_VERBOSE_LOGS) {
          console.log('Outgoing DIRECT raffle subscription check:', JSON.stringify({
            method: 'GET',
            path,
            query,
            expectedUserId,
            channelId
          }));
        }

        const directResult = await maxRequest(path, {
          method: 'GET',
          query
        });

        const directMembers = extractMembersFromMaxResponse(directResult);
        if (SUBSCRIPTION_CHECK_VERBOSE_LOGS) {
          console.log('DIRECT raffle subscription check response:', JSON.stringify({
            channelId,
            expectedUserId,
            membersCount: directMembers.length,
            sampleIds: directMembers.slice(0, 10).map(member => String(getMemberUserId(member) || ''))
          }));
        }

        if (responseContainsActiveUser(directResult, expectedUserId)) {
          return { subscribed: true, permissionProblem: false, error: '' };
        }
      } catch (error) {
        console.warn('Direct subscription check failed:', error.message);
        if (isMaxChannelPermissionError(error)) {
          permissionProblem = true;
          lastPermissionError = error.message;
        }
      }
    }

    let marker = '';
    let page = 0;

    const maxPages = SUBSCRIPTION_FALLBACK_MAX_PAGES;
    const pageSize = SUBSCRIPTION_PAGE_SIZE;
    const seenMarkers = new Set();

    while (page < maxPages) {
      page += 1;

      const query = { count: pageSize };
      if (marker) query.marker = marker;

      if (SUBSCRIPTION_CHECK_VERBOSE_LOGS) {
        console.log('Outgoing raffle subscription check page:', JSON.stringify({
          method: 'GET',
          path,
          query,
          expectedUserId,
          channelId,
          page
        }));
      }

      try {
        const result = await maxRequest(path, {
          method: 'GET',
          query
        });

        const pageMembers = extractMembersFromMaxResponse(result);
        if (SUBSCRIPTION_CHECK_VERBOSE_LOGS) {
          console.log('Raffle subscription check page response:', JSON.stringify({
            page,
            channelId,
            expectedUserId,
            membersCount: pageMembers.length,
            sampleIds: pageMembers.slice(0, 10).map(member => String(getMemberUserId(member) || ''))
          }));
        }

        if (responseContainsActiveUser(result, expectedUserId)) {
          return { subscribed: true, permissionProblem: false, error: '' };
        }

        const nextMarker = getNextMembersMarker(result);

        if (!nextMarker || nextMarker === marker || seenMarkers.has(nextMarker)) break;

        seenMarkers.add(nextMarker);
        marker = nextMarker;
      } catch (error) {
        console.warn(
          `Subscription check failed for user ${expectedUserId}, channel ${channelId}:`,
          error.message
        );

        if (isMaxChannelPermissionError(error)) {
          permissionProblem = true;
          lastPermissionError = error.message;
        }

        break;
      }
    }

    console.log('🔎 Проверка подписки завершена:', JSON.stringify({
      user_id: expectedUserId,
      channel_id: String(channelId),
      subscribed: false,
      permission_problem: permissionProblem,
      fallback_pages_checked: page
    }));

    return {
      subscribed: false,
      permissionProblem,
      error: lastPermissionError
    };
  } catch (error) {
    console.warn(
      `Subscription check failed for user ${expectedUserId}, channel ${channelId}:`,
      error.message
    );

    return {
      subscribed: false,
      permissionProblem: isMaxChannelPermissionError(error),
      error: error.message
    };
  }
}

async function notifyRafflePermissionProblemsFromJoinCheck(raffle, channels = []) {
  if (!raffle || !Array.isArray(channels) || !channels.length) return;

  const seen = new Set();

  for (const ch of channels) {
    const channelId = String(ch?.channel_id || '').trim();
    if (!channelId || seen.has(channelId)) continue;
    seen.add(channelId);

    await notifyRafflePermissionProblem({
      raffle_id: raffle.id,
      public_number: getRafflePublicNumber(raffle),
      raffle_title: raffle.title,
      creator_user_id: raffle.creator_user_id,
      channel_id: channelId,
      channel_title: ch.channel_title,
      channel_link: ch.channel_link,
      owner_user_id: ch.owner_user_id
    }, 'subscription_check_403').catch(error => {
      console.warn('Не удалось отправить предупреждение о правах из проверки подписки:', {
        raffle_id: raffle.id,
        channel_id: channelId,
        error: error.message
      });
    });
  }
}

async function recordRaffleSubscriptionCheck(raffleId, userId, channelId, isSubscribed, source = 'check') {
  const cleanRaffleId = Number(raffleId);
  const cleanUserId = String(userId || '').trim();
  const cleanChannelId = String(channelId || '').trim();
  const subscribed = Boolean(isSubscribed);

  if (!Number.isInteger(cleanRaffleId) || cleanRaffleId <= 0 || !cleanUserId || !cleanChannelId) {
    return null;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Блокируем состояние конкретного участника/канала, чтобы двойные клики не дали двойной +.
    const stateRes = await client.query(`
      SELECT is_subscribed
      FROM raffle_channel_subscription_states
      WHERE raffle_id = $1 AND channel_id = $2 AND user_id = $3
      FOR UPDATE
    `, [cleanRaffleId, cleanChannelId, cleanUserId]);

    const previous = stateRes.rows.length
      ? stateRes.rows[0].is_subscribed
      : null;

    let delta = 0;
    let eventType = 'same';

    if (previous === null && subscribed) {
      delta = 1;
      eventType = 'joined';
    } else if (previous === true && !subscribed) {
      delta = -1;
      eventType = 'left';
    } else if (previous === false && subscribed) {
      delta = 1;
      eventType = 'rejoined';
    }

    if (stateRes.rows.length) {
      await client.query(`
        UPDATE raffle_channel_subscription_states
        SET
          is_subscribed = $4,
          last_checked_at = NOW(),
          updated_at = NOW()
        WHERE raffle_id = $1 AND channel_id = $2 AND user_id = $3
      `, [cleanRaffleId, cleanChannelId, cleanUserId, subscribed]);
    } else {
      await client.query(`
        INSERT INTO raffle_channel_subscription_states (
          raffle_id,
          channel_id,
          user_id,
          is_subscribed,
          first_checked_at,
          last_checked_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW(), NOW())
      `, [cleanRaffleId, cleanChannelId, cleanUserId, subscribed]);
    }

    if (delta !== 0) {
      await client.query(`
        INSERT INTO raffle_channel_subscription_events (
          raffle_id,
          channel_id,
          user_id,
          event_type,
          delta,
          source,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [cleanRaffleId, cleanChannelId, cleanUserId, eventType, delta, safeText(source, 100)]);
    }

    await client.query('COMMIT');

    return {
      previous,
      current: subscribed,
      delta,
      eventType
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.warn('Не удалось записать статистику проверки подписки:', {
      raffleId: cleanRaffleId,
      channelId: cleanChannelId,
      userId: cleanUserId,
      subscribed,
      error: error.message
    });
    return null;
  } finally {
    client.release();
  }
}


async function recordRaffleSubscriptionLeaveFromWebhook(raffleId, userId, channelId, source = 'user_removed_webhook') {
  const cleanRaffleId = Number(raffleId);
  const cleanUserId = String(userId || '').trim();
  const cleanChannelId = String(channelId || '').trim();

  if (!Number.isInteger(cleanRaffleId) || cleanRaffleId <= 0 || !cleanUserId || !cleanChannelId) {
    return null;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const stateRes = await client.query(`
      SELECT is_subscribed
      FROM raffle_channel_subscription_states
      WHERE raffle_id = $1 AND channel_id = $2 AND user_id = $3
      FOR UPDATE
    `, [cleanRaffleId, cleanChannelId, cleanUserId]);

    const previous = stateRes.rows.length
      ? stateRes.rows[0].is_subscribed
      : null;

    // Если уже было зафиксировано, что пользователь отписан — второй минус не пишем.
    if (previous === false) {
      await client.query(`
        UPDATE raffle_channel_subscription_states
        SET last_checked_at = NOW(), updated_at = NOW()
        WHERE raffle_id = $1 AND channel_id = $2 AND user_id = $3
      `, [cleanRaffleId, cleanChannelId, cleanUserId]);

      await client.query('COMMIT');
      return { previous, current: false, delta: 0, eventType: 'same_left' };
    }

    if (stateRes.rows.length) {
      await client.query(`
        UPDATE raffle_channel_subscription_states
        SET
          is_subscribed = false,
          last_checked_at = NOW(),
          updated_at = NOW()
        WHERE raffle_id = $1 AND channel_id = $2 AND user_id = $3
      `, [cleanRaffleId, cleanChannelId, cleanUserId]);
    } else {
      await client.query(`
        INSERT INTO raffle_channel_subscription_states (
          raffle_id,
          channel_id,
          user_id,
          is_subscribed,
          first_checked_at,
          last_checked_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, false, NOW(), NOW(), NOW(), NOW())
      `, [cleanRaffleId, cleanChannelId, cleanUserId]);
    }

    await client.query(`
      INSERT INTO raffle_channel_subscription_events (
        raffle_id,
        channel_id,
        user_id,
        event_type,
        delta,
        source,
        created_at
      )
      VALUES ($1, $2, $3, 'left_webhook', -1, $4, NOW())
    `, [cleanRaffleId, cleanChannelId, cleanUserId, safeText(source, 100)]);

    await client.query('COMMIT');

    return {
      previous,
      current: false,
      delta: -1,
      eventType: 'left_webhook'
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.warn('Не удалось записать webhook-отписку в статистику розыгрыша:', {
      raffleId: cleanRaffleId,
      channelId: cleanChannelId,
      userId: cleanUserId,
      error: error.message
    });
    return null;
  } finally {
    client.release();
  }
}

async function recordRaffleSubscriptionJoinFromWebhook(raffleId, userId, channelId, source = 'user_added_webhook') {
  // Используем ту же таблицу состояний, что и обычная проверка подписки.
  // Поэтому один и тот же пользователь не даст двойной плюс: webhook user_added + последующая проверка подписки.
  return recordRaffleSubscriptionCheck(raffleId, userId, channelId, true, source);
}

async function recordRaffleMemberDeltaFromWebhook(update, target) {
  if (!isChannelTarget(target)) return { matched: 0, recordedPlus: 0, recordedMinus: 0 };

  const delta = detectChannelMemberDelta(update);
  if (!delta) return { matched: 0, recordedPlus: 0, recordedMinus: 0 };

  const userId = getActorUserIdFromUpdate(update);
  const channelId = String(target.id || '').trim();

  if (!userId || !channelId) return { matched: 0, recordedPlus: 0, recordedMinus: 0 };
  if (BOT_USER_ID && String(userId) === String(BOT_USER_ID)) return { matched: 0, recordedPlus: 0, recordedMinus: 0 };

  // Webhook может прийти от человека, который ещё не нажимал кнопку бота.
  // Создаём users заранее, чтобы внешние ключи статистики не падали.
  await pool.query(`
    INSERT INTO users (max_user_id)
    VALUES ($1)
    ON CONFLICT (max_user_id) DO NOTHING
  `, [userId]);

  // Если MAX прислал user_added/user_removed по каналу, который участвует в активном розыгрыше,
  // считаем это реальным движением аудитории именно этого канала за период розыгрыша.
  // Не требуем, чтобы пользователь уже нажимал «Участвовать»: иначе статистика канала будет занижена.
  const res = await pool.query(`
    SELECT DISTINCT r.id AS raffle_id
    FROM raffles r
    JOIN raffle_channels rc
      ON rc.raffle_id = r.id
     AND rc.channel_id::text = $1
    WHERE r.status = 'active'
      AND r.end_at > NOW()
  `, [channelId]);

  let recordedPlus = 0;
  let recordedMinus = 0;

  for (const row of res.rows) {
    const result = delta > 0
      ? await recordRaffleSubscriptionJoinFromWebhook(
          row.raffle_id,
          userId,
          channelId,
          'user_added_webhook'
        )
      : await recordRaffleSubscriptionLeaveFromWebhook(
          row.raffle_id,
          userId,
          channelId,
          'user_removed_webhook'
        );

    if (result?.delta > 0) recordedPlus += 1;
    if (result?.delta < 0) recordedMinus += 1;
  }

  if (res.rows.length) {
    console.log(delta > 0
      ? '📈 Подписка из webhook учтена для статистики розыгрыша:'
      : '📉 Отписка из webhook учтена для статистики розыгрыша:', {
      channel_id: channelId,
      user_id: String(userId),
      matched_raffles: res.rows.map(row => Number(row.raffle_id)),
      recorded_plus: recordedPlus,
      recorded_minus: recordedMinus
    });
  }

  return { matched: res.rows.length, recordedPlus, recordedMinus };
}

async function recordRafflePotentialLeaveFromUserRemoved(update, target) {
  // Старое имя оставлено как обёртка, чтобы не ломать возможные вызовы.
  return recordRaffleMemberDeltaFromWebhook(update, target);
}

async function checkUserAllSubscriptions(raffleId, userId, options = {}) {
  const channels = await getRaffleChannels(raffleId);
  const source = options.source || 'check';
  const recordStats = options.recordStats !== false;

  if (!channels.length) {
    return { ok: true, missing: [], permissionProblems: [] };
  }

  const missing = [];
  const permissionProblems = [];

  for (const ch of channels) {
    if (!ch.is_required) continue;

    const check = await checkUserSubscribedToChannelDetailed(userId, ch.channel_id);
    const subscribed = Boolean(check.subscribed);

    if (recordStats && !check.permissionProblem) {
      await recordRaffleSubscriptionCheck(raffleId, userId, ch.channel_id, subscribed, source);
    }

    if (!subscribed) {
      missing.push(ch);
    }

    if (check.permissionProblem) {
      permissionProblems.push({
        ...ch,
        permission_error: check.error || ''
      });
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    permissionProblems
  };
}

// =========================
// Розыгрыши
// =========================
function botNow() {
  // Возвращает реальный текущий UTC-момент. Для отображения МСК используется formatDateTime().
  return dayjs.utc();
}

function asBotTime(value) {
  const parsed = toUtcMoment(value);
  return parsed ? parsed.add(BOT_UTC_OFFSET_MINUTES, 'minute') : null;
}

function formatDateTime(value) {
  const parsed = asBotTime(value);
  return parsed ? `${parsed.format('DD.MM.YYYY HH:mm')} ${BOT_TIMEZONE_LABEL}` : 'не указано';
}

function displayValue(value, fallback = 'не указано') {
  if (value === undefined || value === null) return fallback;

  const text = String(value).trim();

  if (!text) return fallback;

  const lowered = text.toLowerCase();
  if (lowered === 'undefined' || lowered === 'null' || lowered === 'nan') return fallback;

  return text;
}

function formatRaffleStatus(status) {
  const value = String(status || '').trim().toLowerCase();

  const statuses = {
    draft: 'черновик',
    scheduled: 'запланирован',
    active: 'активен',
    finished: 'завершён',
    archived: 'скрыт из списка',
    cancelled: 'отменён',
    failed: 'ошибка'
  };

  return statuses[value] || displayValue(status, 'не указан');
}

function getRafflePublishAt(raffle) {
  return raffle?.publish_at || raffle?.created_at || null;
}

function getMinPublishAt() {
  // Минимальную задержку публикации убрали: можно ставить любое будущее время.
  // Быстрая кнопка «Через 30 мин» остаётся как удобный вариант, но не как ограничение.
  return dayjs.utc();
}

function getMinEndAtForPublish(publishAt) {
  const base = toUtcMoment(publishAt);
  const safeBase = base || getMinPublishAt();
  return safeBase.add(MIN_RAFFLE_DURATION_AFTER_PUBLISH_MINUTES, 'minute');
}

function parseQuickOffset(offset) {
  const text = String(offset || '').trim().toLowerCase();

  if (text.endsWith('m')) {
    return { amount: Number(text.replace('m', '')), unit: 'minute' };
  }

  if (text.endsWith('h')) {
    return { amount: Number(text.replace('h', '')), unit: 'hour' };
  }

  if (text.endsWith('d')) {
    return { amount: Number(text.replace('d', '')), unit: 'day' };
  }

  return { amount: 0, unit: 'minute' };
}

function applyQuickOffset(base, offset) {
  const parsed = parseQuickOffset(offset);
  const amount = Number.isFinite(parsed.amount) ? parsed.amount : 0;
  const start = toUtcMoment(base) || dayjs.utc();
  return start.add(amount, parsed.unit);
}

function buildDateQuickKeyboard(kind) {
  const prefix = kind === 'publish' ? 'quick_publish' : 'quick_end';
  const firstText = kind === 'publish'
    ? `Через ${MIN_RAFFLE_PUBLISH_DELAY_MINUTES} мин`
    : `Через ${MIN_RAFFLE_DURATION_AFTER_PUBLISH_MINUTES} мин`;
  const firstOffset = kind === 'publish'
    ? `${MIN_RAFFLE_PUBLISH_DELAY_MINUTES}m`
    : `${MIN_RAFFLE_DURATION_AFTER_PUBLISH_MINUTES}m`;

  if (kind === 'publish') {
    return [
      [{ text: firstText, callback_data: `${prefix}:${firstOffset}` }],
      [
        { text: '2 часа', callback_data: `${prefix}:2h` },
        { text: '5 часов', callback_data: `${prefix}:5h` },
        { text: '1 день', callback_data: `${prefix}:1d` }
      ],
      [{ text: '❌ Отмена', callback_data: 'cancel_session' }]
    ];
  }

  return [
    [{ text: firstText, callback_data: `${prefix}:${firstOffset}` }],
    [
      { text: '1 день', callback_data: `${prefix}:1d` },
      { text: '5 дней', callback_data: `${prefix}:5d` },
      { text: '10 дней', callback_data: `${prefix}:10d` }
    ],
    [{ text: '❌ Отмена', callback_data: 'cancel_session' }]
  ];
}

async function sendPublishDatePrompt(target, data = {}) {
  const minPublishAt = getMinPublishAt();

  return sendMessage(
    target,
    [
      '🕒 **Время публикации поста**',
      '',
      'Укажите, когда бот должен опубликовать пост с розыгрышем в выбранных каналах. Время указывается по МСК.',
      `Сейчас по боту: **${formatDateTime(minPublishAt)}**.`,
      '',
      'Можно нажать быструю кнопку или ввести дату вручную по МСК:',
      '`2026-06-10 20:00`',
      '`10.06.2026 20:00`'
    ].join('\n'),
    buildDateQuickKeyboard('publish')
  );
}

async function sendEndDatePrompt(target, data = {}) {
  const publishAt = data.publish_at || getMinPublishAt().toISOString();
  const minEndAt = getMinEndAtForPublish(publishAt);

  return sendMessage(
    target,
    [
      '⏰ **Время окончания розыгрыша**',
      '',
      'Время указывается по МСК.',
      `Публикация поста: **${formatDateTime(publishAt)}**.`,
      `Окончание должно быть минимум через **${MIN_RAFFLE_DURATION_AFTER_PUBLISH_MINUTES} минут** после публикации.`,
      `Ближайшее допустимое окончание: **${formatDateTime(minEndAt)}**.`,
      '',
      'Можно нажать быструю кнопку или ввести дату вручную по МСК:',
      '`2026-06-10 20:00`',
      '`10.06.2026 20:00`'
    ].join('\n'),
    buildDateQuickKeyboard('end')
  );
}

function buildSelectedChannelsText(channels = []) {
  if (!channels.length) return 'Каналы не выбраны.';

  return channels
    .map(ch => `• ${formatChannelWithLink(ch)} — ${ch.is_required ? 'обязательная подписка' : 'подписка не обязательна'}, ${ch.publish_post ? 'с размещением' : 'без размещения'}`)
    .join('\n');
}

function formatChannelOwnerLabel(channel, creatorUserId) {
  const ownerId = String(channel?.owner_user_id || '').trim();

  if (!ownerId) return 'организатор не указан';

  if (String(ownerId) === String(creatorUserId || '')) {
    return 'организатор';
  }

  const ownerUser = {
    user_id: ownerId,
    max_user_id: ownerId,
    username: channel?.owner_username,
    first_name: channel?.owner_first_name,
    last_name: channel?.owner_last_name
  };

  return `соадмин: ${buildUserDisplayName(ownerUser)}`;
}

function buildRaffleChannelsStatusText(channels = [], creatorUserId = null) {
  if (!channels.length) return 'Каналы не добавлены.';

  return channels
    .map(ch => {
      const options = `${ch.is_required ? 'обязательная подписка' : 'подписка не обязательна'}, ${ch.publish_post ? 'с размещением' : 'без размещения'}`;
      const ownerLabel = formatChannelOwnerLabel(ch, creatorUserId);
      return `• ${formatChannelWithLink(ch)} — ${options}; ${ownerLabel}`;
    })
    .join('\n');
}

function countCollabChannels(channels = [], creatorUserId = null) {
  return channels.filter(ch => {
    const ownerId = String(ch.owner_user_id || '').trim();
    return ownerId && String(ownerId) !== String(creatorUserId || '');
  }).length;
}

function buildRaffleDraftPreviewText(data = {}) {
  const prizes = data.prizes
    ? String(data.prizes)
        .split('\n')
        .filter(Boolean)
        .map((p, i) => `${i + 1}. ${p}`)
        .join('\n')
    : '1. Главный приз';

  return [
    '🧩 **Шаблон поста розыгрыша**',
    '',
    '**Проверьте текст и настройки перед созданием внимательно**🤳',
    '',
    `🎉 **${data.title || 'Без названия'}**`,
    '',
    data.description || 'Участвуйте и выигрывайте!',
    '',
    '🎁 **Призы:**',
    prizes,
    '',
    '👥 Участников: **0**',
    `🏆 Призовых мест: **${data.prize_count || 1}**`,
    `🕒 Публикация: **${formatDateTime(data.publish_at)}**`,
    `⏰ Окончание: **${formatDateTime(data.end_at)}**`,
    `🖼 Фото: **${data.photo_attachment ? 'добавлено' : 'не добавлено'}**`,
    '',
    'Чтобы участвовать, нажмите кнопку ниже.',
    '',
    buildRaffleFooter({ id: 'будет присвоен' }),
    '',
    '**Каналы:**',
    buildSelectedChannelsText(data.channels || []),
    '',
    '🤝 Соадмин подключается до публикации: сначала бот сохраняет черновик/запланированный розыгрыш, затем выдаёт ссылку. По этой ссылке другой админ добавляет свои каналы и выбирает условия. После нажатия кнопок **Создать** изменить розыгрыш нельзя❗'
  ].join('\n');
}

async function sendRaffleDraftPreview(target, userId, data = {}) {
  await setSession(userId, 'await_final_preview', data);

  const isEditingExisting = Boolean(data.editing_raffle_id);
  const keyboard = isEditingExisting
    ? [
        [{ text: '💾 Сохранить изменения', callback_data: 'raffle_confirm_update' }],
        [{ text: '↩️ Вернуться к розыгрышу', callback_data: `refresh_raffle:${data.editing_raffle_id}` }]
      ]
    : [
        [{ text: '🧍‍♂️ Создать без соадмина', callback_data: 'raffle_confirm_create' }],
        [{ text: '🤝 Создать и дать ссылку соадмину', callback_data: 'raffle_confirm_create_collab' }]
      ];

  keyboard.push(
    [
      { text: '✏️ Название', callback_data: 'draft_edit_title' },
      { text: '📝 Описание', callback_data: 'draft_edit_description' }
    ],
    [
      { text: '🎁 Призы', callback_data: 'draft_edit_prizes' },
      { text: '📢 Каналы', callback_data: 'draft_edit_channels' }
    ],
    [
      { text: '🖼 Добавить фото', callback_data: 'draft_edit_photo' },
      { text: '🚫 Убрать фото', callback_data: 'draft_remove_photo' }
    ],
    [
      { text: '🕒 Публикация', callback_data: 'draft_edit_publish_at' },
      { text: '⏰ Окончание', callback_data: 'draft_edit_end_at' }
    ],
    [{ text: '❌ Отмена', callback_data: 'cancel_session' }]
  );

  return sendMessage(
    target,
    buildRaffleDraftPreviewText(data),
    keyboard
  );
}

function buildCreatedRaffleMessage(sessionData, raffle, invite) {
  return [
    '✅ **Розыгрыш создан!**',
    '',
    `№: **${getRafflePublicNumber(raffle)}**`,
    `Название: **${displayValue(sessionData.title, 'Без названия')}**`,
    `Публикация: **${formatDateTime(sessionData.publish_at)}**`,
    `Окончание: **${formatDateTime(sessionData.end_at)}**`,
    '',
    '**Каналы организатора:**',
    buildSelectedChannelsText(sessionData.channels || []),
    '',
    '🤝 **Ссылка для совместного розыгрыша:**',
    buildCollabInviteBlock(invite),
    `Статус ссылки: **${formatRaffleInviteStatus(invite)}**`,
    '',
    'Отправьте эту ссылку соадмину. Когда он откроет ссылку, добавит бота в свой канал и выберет условия, нажмите кнопку **🔄 Обновить розыгрыш**. Бот покажет, какие каналы коллаборации уже подключены к этому розыгрышу.',
    '',
    'Когда все нужные соадмины добавлены, нажмите **🔒 Закрыть ссылку соадминов** — после этого новые каналы по старой ссылке подключить будет нельзя.',
    '',
    'Если не хотите ждать запланированное время публикации, нажмите **🚀 Запустить сейчас** — бот сразу опубликует розыгрыш в уже подключённые каналы. Каналы соадминов, добавленные позже, будут опубликованы сразу после подключения.',
    '',
    '📣 **Хотите увеличить охват?** Ниже доступны кнопки платного продвижения розыгрыша.'
  ].join('\n');
}

async function buildRefreshedRaffleMessage(raffle, invite = null) {
  const channels = await getRaffleChannelsWithOwners(raffle.id);
  const collabCount = countCollabChannels(channels, raffle.creator_user_id);
  const organizerChannelsCount = channels.length - collabCount;

  return [
    '🔄 **Розыгрыш обновлён**',
    '',
    `№: **${getRafflePublicNumber(raffle)}**`,
    `Название: **${displayValue(raffle.title, 'Без названия')}**`,
    `Статус: **${formatRaffleStatus(raffle.status)}**`,
    `Публикация: **${formatDateTime(getRafflePublishAt(raffle))}**`,
    `Окончание: **${formatDateTime(raffle.end_at)}**`,
    '',
    `Каналов организатора: **${organizerChannelsCount}**`,
    `Каналов коллаборации: **${collabCount}**`,
    '',
    '**Все каналы розыгрыша:**',
    buildRaffleChannelsStatusText(channels, raffle.creator_user_id),
    '',
    '🤝 **Ссылка для совместного розыгрыша:**',
    buildCollabInviteBlock(invite),
    `Статус ссылки: **${formatRaffleInviteStatus(invite)}**`,
    '',
    collabCount
      ? '✅ Каналы соадминов уже добавлены и будут учитываться в условиях розыгрыша.'
      : (
          isRaffleInviteActive(invite)
            ? 'Пока каналы соадминов не добавлены. Если вы уже отправили ссылку, попросите соадмина открыть её, выбрать канал и нажать «Добавить к розыгрышу».'
            : 'Ссылка закрыта. Новые соадмины уже не смогут подключить каналы к этому розыгрышу.'
        )
  ].join('\n');
}

function buildCreatedRaffleKeyboard(raffle, userId = null) {
  const isActiveRaffle = raffle && String(raffle.status || '') === 'active';

  const topRow = isActiveRaffle
    ? [{ text: '👀 Предпросмотр поста', callback_data: `preview_raffle:${raffle.id}` }]
    : [
        { text: '🔄 Обновить розыгрыш', callback_data: `refresh_raffle:${raffle.id}` },
        { text: '👀 Предпросмотр поста', callback_data: `preview_raffle:${raffle.id}` }
      ];

  const keyboard = [
    topRow,
    [{ text: '📊 Статистика', callback_data: `raffle_stats:${raffle.id}` }]
  ];

  const isOwnerOrAdmin = raffle && (
    !userId ||
    Number(raffle.creator_user_id) === Number(userId) ||
    isAdmin(userId)
  );

  const canShowStartNow = raffle && raffle.status === 'scheduled' && isOwnerOrAdmin;

  if (canShowStartNow) {
    keyboard.splice(1, 0, [
      { text: '🚀 Запустить сейчас', callback_data: `start_raffle_now:${raffle.id}` },
      { text: '✏️ Редактировать', callback_data: `edit_raffle:${raffle.id}` }
    ]);
  }

  if (raffle && ['scheduled', 'active'].includes(String(raffle.status || '')) && isOwnerOrAdmin) {
    keyboard.push([{ text: '⏹ Завершить сейчас', callback_data: `confirm_stop_raffle:${raffle.id}` }]);
  }

  if (raffle && String(raffle.status || '') === 'finished' && isOwnerOrAdmin) {
    keyboard.push([{ text: '🔁 Переиграть победителей', callback_data: `reroll_winners:${raffle.id}` }]);
  }

  if (raffle && ['scheduled', 'active'].includes(String(raffle.status || '')) && isOwnerOrAdmin) {
    keyboard.push([{ text: '🔒 Закрыть ссылку соадминов', callback_data: `close_collab_link:${raffle.id}` }]);
  }

  if (raffle && ['scheduled', 'active'].includes(String(raffle.status || '')) && isOwnerOrAdmin) {
    keyboard.push([{ text: '📣 Увеличить охват', callback_data: `promo_offer:${raffle.id}` }]);
  }

  keyboard.push([{ text: '🔎 Мои розыгрыши', callback_data: 'my_raffles' }]);

  return keyboard;
}

async function sendRaffleRefresh(target, userId, raffleId) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
  }

  if (!(await isRaffleOrganizer(raffle, userId))) {
    return sendMessage(target, '⛔ Обновлять этот розыгрыш может только организатор, соадмин подключённого канала или админ бота.');
  }

  const invite = await getRaffleInviteByRaffleId(raffle.id);

  return sendMessage(
    target,
    await buildRefreshedRaffleMessage(raffle, invite),
    buildCreatedRaffleKeyboard(raffle, userId)
  );
}


async function buildRafflePostPreviewText(raffle) {
  const channels = await getRaffleChannels(raffle.id);
  const text = buildRaffleText(raffle, 0, channels);

  return [
    '👀 **Предпросмотр поста розыгрыша**',
    '',
    'Так пользователи увидят розыгрыш в канале. Проверьте текст, призы, каналы и время перед публикацией.',
    '',
    text
  ].join('\n');
}

async function sendRafflePostPreview(target, userId, raffleId) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
  }

  if (!(await isRaffleOrganizer(raffle, userId))) {
    return sendMessage(target, '⛔ Смотреть этот розыгрыш может только организатор, соадмин подключённого канала или админ бота.');
  }

  return sendMessage(
    target,
    await buildRafflePostPreviewText(raffle),
    buildCreatedRaffleKeyboard(raffle, userId),
    getRafflePhotoAttachments(raffle)
  );
}

async function loadRaffleToEditSession(target, userId, raffleId) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
  }

  if (Number(raffle.creator_user_id) !== Number(userId) && !isAdmin(userId)) {
    return sendMessage(target, '⛔ Редактировать розыгрыш может только его организатор или админ бота.');
  }

  if (raffle.status !== 'scheduled') {
    return sendMessage(target, `Редактировать можно только запланированный розыгрыш до публикации. Сейчас статус: ${formatRaffleStatus(raffle.status)}.`);
  }

  const channels = await getRaffleChannels(raffle.id);
  const data = {
    editing_raffle_id: raffle.id,
    title: raffle.title,
    description: raffle.description,
    prizes: raffle.prizes,
    prize_count: raffle.prize_count,
    publish_at: raffle.publish_at,
    end_at: raffle.end_at,
    photo_attachment: normalizeStoredPhotoAttachment(raffle.photo_attachment),
    channels: channels.map(ch => ({
      channel_id: String(ch.channel_id),
      channel_title: ch.channel_title,
      channel_link: ch.channel_link,
      is_required: Boolean(ch.is_required),
      publish_post: Boolean(ch.publish_post),
      owner_user_id: ch.owner_user_id || userId
    }))
  };

  await sendMessage(target, '✏️ Открываю редактирование запланированного розыгрыша. После изменений нажмите **💾 Сохранить изменения**.');
  return sendRaffleDraftPreview(target, userId, data);
}

async function saveEditedRaffleFromSession(target, userId, data = {}) {
  const raffleId = Number(data.editing_raffle_id);

  if (!Number.isInteger(raffleId)) {
    return sendMessage(target, 'Не найден ID редактируемого розыгрыша. Откройте розыгрыш из раздела «Мои розыгрыши».');
  }

  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
  }

  if (Number(raffle.creator_user_id) !== Number(userId) && !isAdmin(userId)) {
    return sendMessage(target, '⛔ Сохранить изменения может только организатор розыгрыша или админ бота.');
  }

  if (raffle.status !== 'scheduled') {
    return sendMessage(target, `Изменения не сохранены: редактировать можно только запланированный розыгрыш. Сейчас статус: ${formatRaffleStatus(raffle.status)}.`);
  }

  await updateRaffle(raffle.id, {
    title: data.title,
    description: data.description,
    prizes: data.prizes,
    prize_count: data.prize_count,
    publish_at: data.publish_at,
    end_at: data.end_at,
    photo_attachment: data.photo_attachment ? JSON.stringify(data.photo_attachment) : null,
    publish_in_general: false,
    status: 'scheduled'
  });

  await pool.query('DELETE FROM raffle_channels WHERE raffle_id = $1', [raffle.id]);

  for (const ch of data.channels || []) {
    await addRaffleChannel(
      raffle.id,
      ch.channel_id,
      ch.channel_title,
      ch.is_required,
      ch.publish_post,
      ch.channel_link,
      ch.owner_user_id || userId
    );
  }

  await pool.query(`
    UPDATE raffle_queue
    SET scheduled_at = $2, status = 'pending', updated_at = NOW()
    WHERE raffle_id = $1 AND queue_type = 'raffle_start'
  `, [raffle.id, new Date(data.publish_at || Date.now())]);

  await pool.query(`
    UPDATE raffle_queue
    SET scheduled_at = $2, status = 'pending', updated_at = NOW()
    WHERE raffle_id = $1 AND queue_type = 'raffle_finish'
  `, [raffle.id, new Date(data.end_at)]);

  await clearSession(userId);

  const updated = await getRaffleById(raffle.id) || raffle;
  await sendMessage(target, '✅ Изменения сохранены. Ниже — актуальный предпросмотр поста.', buildCreatedRaffleKeyboard(updated, userId));
  return sendRafflePostPreview(target, userId, updated.id);
}

async function createRaffleAndSendCreatedMessage(target, userId, sessionData) {
  const { raffle, inviteToken } = await createRaffleFromSession(userId, sessionData);
  const createdRaffle = await getRaffleById(raffle.id) || raffle;
  await clearSession(userId);

  const invite = await getRaffleInviteByRaffleId(createdRaffle.id) || {
    token: inviteToken,
    is_active: true
  };

  await sendMessage(
    target,
    buildCreatedRaffleMessage(sessionData, createdRaffle, invite),
    buildCreatedRaffleKeyboard(createdRaffle, userId)
  );

  // Не отправляем предложение продвижения автоматически после создания.
  // Кнопка «📣 Увеличить охват» уже есть в карточке созданного розыгрыша,
  // поэтому организатор сам откроет покупку, если она нужна.

  await scheduleAdminCommunityInviteAfterRaffleCreate(createdRaffle.id, userId).catch(error => {
    console.warn('Не удалось запланировать приглашение в канал админов:', error.message);
  });

  return createdRaffle;
}

function buildRaffleText(raffle, participantsCount = 0, channels = [], sourceChannelId = null) {
  const prizes = raffle.prizes
    ? raffle.prizes
        .split('\n')
        .filter(Boolean)
        .map((p, i) => `${i + 1}. ${p}`)
        .join('\n')
    : '1. Главный приз';

  const channelsText = buildRafflePublicChannelsText(channels);

  const joinUrl = buildBotDeepLink(
    buildRaffleJoinPayload(raffle.id, sourceChannelId)
  );

  const joinLine = joinUrl
    ? `*Чтобы участвовать, нажмите кнопку ${markdownLink('🎁 Участвовать', joinUrl)}*`
    : '*Чтобы участвовать, нажмите кнопку 🎁 Участвовать*';

  return [
    `🎉 **${displayValue(raffle.title, 'Без названия')}**`,
    '',
    displayValue(raffle.description, 'Участвуйте и выигрывайте!'),
    '',
    '🎁 **Призы:**',
    prizes,
    '',
    `👥 Участников: **${participantsCount}**`,
    `🏆 Призовых мест: **${raffle.prize_count || 1}**`,
    `⏰ Окончание: **${formatDateTime(raffle.end_at)}**`,
    '',
    buildRaffleRulesLine(),
    channelsText ? '' : null,
    channelsText || null,
    '',
    joinLine,
    '',
    buildRaffleFooter(raffle)
  ].filter(line => line !== null).join('\n');
}


async function getRaffleParticipantsCount(raffleId) {
  const countRes = await pool.query(`
    SELECT COUNT(DISTINCT user_id)::int AS count
    FROM raffle_user_entry
    WHERE raffle_id = $1
  `, [raffleId]);

  return Number(countRes.rows[0]?.count || 0);
}

function buildRaffleJoinPayload(raffleId, sourceChannelId = null, ref = null) {
  const parts = [`join`, String(raffleId)];

  if (sourceChannelId !== undefined && sourceChannelId !== null && String(sourceChannelId).trim()) {
    parts.push('src', String(sourceChannelId).trim());
  }

  if (ref !== undefined && ref !== null && String(ref).trim()) {
    parts.push('ref', String(ref).trim());
  }

  return parts.join('_');
}

function parseJoinPayloadParts(value) {
  const parts = String(value || '').replace(/^join_/, '').split('_').filter(Boolean);
  const raffleId = Number(parts[0]);
  let ref = null;
  let sourceChannelId = null;

  // Старый формат: join_123_456, где 456 — реферал.
  if (parts[1] && /^\d+$/.test(parts[1])) {
    ref = Number(parts[1]);
  }

  for (let i = 1; i < parts.length; i++) {
    if (parts[i] === 'ref' && parts[i + 1]) {
      const n = Number(parts[i + 1]);
      if (Number.isInteger(n)) ref = n;
    }

    if (parts[i] === 'src' && parts[i + 1]) {
      const src = String(parts[i + 1]).trim();
      // channel_id в MAX может быть отрицательным числом.
      if (/^-?\d+$/.test(src)) sourceChannelId = src;
    }
  }

  return { raffleId, ref, sourceChannelId };
}

async function updateRafflePublishedPosts(raffleId, options = {}) {
  const raffle = await getRaffleById(raffleId);
  if (!raffle) return { updated: 0, failed: 0, skipped: 0 };

  const participantsCount = await getRaffleParticipantsCount(raffle.id);
  const channels = await getRaffleChannels(raffle.id);

  const postsRes = await pool.query(`
    SELECT *
    FROM raffle_posts
    WHERE raffle_id = $1
      AND message_id IS NOT NULL
    ORDER BY id ASC
  `, [raffle.id]);

  let updated = 0;
  let failed = 0;
  let skipped = 0;

  for (const post of postsRes.rows) {
    if (!options.force && Number(post.participants_count || 0) === participantsCount) {
      skipped += 1;
      continue;
    }

    const joinUrl = buildBotDeepLink(buildRaffleJoinPayload(raffle.id, post.channel_id));
    const text = buildRaffleText(raffle, participantsCount, channels, post.channel_id);

    const ok = await editMaxMessageText(
      { type: 'chat_id', id: post.channel_id },
      post.message_id,
      text,
      [[{ text: '🎁 Участвовать', url: joinUrl }]],
      getRafflePhotoAttachments(raffle)
    );

    if (ok) {
      updated += 1;
      await pool.query(`
        UPDATE raffle_posts
        SET participants_count = $2, updated_at = NOW()
        WHERE id = $1
      `, [post.id, participantsCount]);
    } else {
      failed += 1;
    }
  }

  return { updated, failed, skipped, participantsCount };
}

async function updateAllActiveRafflePublishedPosts() {
  const res = await pool.query(`
    SELECT DISTINCT r.id
    FROM raffles r
    JOIN raffle_posts rp ON rp.raffle_id = r.id
    WHERE r.status = 'active'
      AND r.end_at > NOW()
  `);

  for (const row of res.rows) {
    await updateRafflePublishedPosts(row.id).catch(error => {
      console.warn(`Не удалось обновить посты розыгрыша ${row.id}:`, error.message);
    });
  }
}

async function scheduleRafflePostUpdate(raffleId, options = {}) {
  const id = Number(raffleId);
  if (!Number.isInteger(id) || id <= 0) return false;

  const delaySeconds = Math.max(0, Number(
    options.delaySeconds ?? RAFFLE_POST_UPDATE_DEBOUNCE_SECONDS
  ));

  const payload = {
    reason: options.reason || 'participants_changed',
    force: Boolean(options.force)
  };

  // Дебаунс: если задача на этот розыгрыш уже ждёт, новую не плодим.
  // Просто переносим её на ближайшее допустимое время и обновляем payload.
  const existing = await pool.query(`
    SELECT id
    FROM raffle_queue
    WHERE raffle_id = $1
      AND queue_type = 'raffle_post_update'
      AND status IN ('pending', 'processing')
    ORDER BY scheduled_at ASC
    LIMIT 1
  `, [id]);

  if (existing.rows[0]) {
    await pool.query(`
      UPDATE raffle_queue
      SET
        scheduled_at = LEAST(scheduled_at, NOW() + ($2::text || ' seconds')::interval),
        payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb,
        updated_at = NOW()
      WHERE id = $1
    `, [existing.rows[0].id, delaySeconds, JSON.stringify(payload)]);

    return true;
  }

  await pool.query(`
    INSERT INTO raffle_queue (raffle_id, queue_type, scheduled_at, payload, status)
    VALUES ($1, 'raffle_post_update', NOW() + ($2::text || ' seconds')::interval, $3::jsonb, 'pending')
  `, [id, delaySeconds, JSON.stringify(payload)]);

  return true;
}

async function processRafflePostUpdateQueuedItem(item) {
  const raffleId = Number(item?.raffle_id);
  if (!Number.isInteger(raffleId) || raffleId <= 0) return;

  const payload = typeof item.payload === 'string'
    ? JSON.parse(item.payload || '{}')
    : item.payload || {};

  const result = await updateRafflePublishedPosts(raffleId, {
    force: Boolean(payload.force)
  });

  console.log('🔄 Посты розыгрыша обновлены пачкой:', {
    raffle_id: raffleId,
    updated: result.updated,
    skipped: result.skipped,
    failed: result.failed,
    participants_count: result.participantsCount
  });
}

async function publishRaffleToChannel(raffle, channelId) {
  const participantsCount = await getRaffleParticipantsCount(raffle.id);
  const channels = await getRaffleChannels(raffle.id);
  const joinUrl = buildBotDeepLink(buildRaffleJoinPayload(raffle.id, channelId));
  const text = buildRaffleText(raffle, participantsCount, channels, channelId);

  const data = await sendMessage(
    {
      type: 'chat_id',
      id: channelId
    },
    text,
    [
      [{ text: '🎁 Участвовать', url: joinUrl }]
    ],
    getRafflePhotoAttachments(raffle)
  );

  console.log('📣 MAX publish result:', JSON.stringify(data, null, 2).slice(0, 5000));

  const messageId = String(extractMaxMessageId(data) || '').trim() || null;
  const extractedPostToken = extractMaxPostToken(data);
  const extractedPostUrl = extractMaxPostUrl(data);
  const postUrl = buildRafflePostUrl(channelId, messageId, '', extractedPostUrl);

  console.log('🔗 MAX post link extraction:', JSON.stringify({
    raffle_id: raffle.id,
    channel_id: String(channelId),
    message_id: messageId,
    post_token: extractedPostToken || null,
    post_url: postUrl || null,
    has_max_post_url_base: Boolean(MAX_POST_URL_BASE)
  }));

  try {
    await pool.query(`
      INSERT INTO raffle_posts (raffle_id, channel_id, message_id, post_url, participants_count, updated_at)
      VALUES ($1, $2, $3::text, $4, $5, NOW())
    `, [raffle.id, channelId, messageId, postUrl || null, participantsCount]);
  } catch (error) {
    // Публикация уже ушла в MAX. Если сломалась только запись message_id в БД,
    // не считаем это ошибкой публикации, чтобы не запускать повторный пост и не дублировать розыгрыш.
    console.warn('Не удалось сохранить message_id опубликованного поста:', {
      raffle_id: raffle.id,
      channel_id: String(channelId),
      message_id: messageId,
      error: error.message
    });
  }

  return data;
}

async function activateRaffle(raffleId) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle || raffle.status !== 'scheduled') return;

  const channels = await getRaffleChannels(raffle.id);

  for (const ch of channels) {
    if (!ch.publish_post) continue;

    try {
      await publishRaffleToChannel(raffle, ch.channel_id);
    } catch (error) {
      console.error(`Ошибка публикации в канал ${ch.channel_id}:`, error.message);
    }
  }

  await updateRaffle(raffle.id, { status: 'active' });

  let generalQueueLine = '';

  if (raffle.publish_in_general && GENERAL_CHANNEL_ID) {
    try {
      const queueResults = await schedulePaidGeneralPublishesForRaffle(raffle.id, {
        userId: raffle.creator_user_id,
        reason: 'raffle_activated'
      });

      const queuedResults = queueResults.filter(result => ['queued', 'already_queued'].includes(String(result?.status || '')));

      if (queuedResults.length) {
        const lastResult = queuedResults[queuedResults.length - 1];
        generalQueueLine = `\n\n📣 Платных General-размещений в очереди: **${queuedResults.length}**. ${formatGeneralPromoQueueResult(lastResult)}`;
      }
    } catch (error) {
      console.error('Ошибка постановки платной публикации General в очередь:', error.message);
      generalQueueLine = '\n\n⚠️ Платная публикация в General не поставлена в очередь. Администратор проверит ошибку.';
    }
  }

  await sendMessage(
    raffle.creator_user_id,
    `✅ Розыгрыш #${raffle.id} опубликован.\nНазвание: ${raffle.title}${generalQueueLine}`
  ).catch(error => {
    console.warn('Не удалось уведомить создателя:', error.message);
  });
}

async function startRaffleNow(target, userId, raffleId) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
  }

  const canStart = Number(raffle.creator_user_id) === Number(userId) || isAdmin(userId);

  if (!canStart) {
    return sendMessage(target, '⛔ Запустить розыгрыш сейчас может только создатель розыгрыша или админ бота.');
  }

  if (raffle.status === 'active') {
    return sendMessage(
      target,
      'Розыгрыш уже опубликован и активен.',
      buildCreatedRaffleKeyboard(raffle, userId)
    );
  }

  if (raffle.status !== 'scheduled') {
    return sendMessage(target, `Этот розыгрыш нельзя запустить сейчас. Текущий статус: ${formatRaffleStatus(raffle.status)}.`);
  }

  const endAt = toUtcMoment(raffle.end_at);

  if (!endAt || !endAt.isAfter(dayjs.utc())) {
    return sendMessage(target, 'Нельзя запустить розыгрыш: время окончания уже прошло или указано неверно.');
  }

  const channels = await getRaffleChannels(raffle.id);
  const publishChannelsCount = channels.filter(ch => ch.publish_post).length;
  const hasGeneralPublish = raffle.publish_in_general && GENERAL_CHANNEL_ID;

  if (!publishChannelsCount && !hasGeneralPublish) {
    return sendMessage(
      target,
      [
        'Нельзя запустить розыгрыш сейчас: не выбран ни один канал для размещения поста.',
        '',
        'Откройте розыгрыш, добавьте канал с режимом **с размещением**, затем снова нажмите **Запустить сейчас**.'
      ].join('\n')
    );
  }

  const now = dayjs.utc();

  await updateRaffle(raffle.id, {
    publish_at: now.toISOString()
  });

  await activateRaffle(raffle.id);

  await pool.query(`
    UPDATE raffle_queue
    SET status = 'done', updated_at = NOW()
    WHERE raffle_id = $1
      AND queue_type = 'raffle_start'
      AND status IN ('pending', 'processing')
  `, [raffle.id]);

  const updated = await getRaffleById(raffle.id) || raffle;

  await sendMessage(
    target,
    [
      '🚀 **Розыгрыш запущен сейчас**',
      '',
      `№: **${getRafflePublicNumber(updated)}**`,
      `Название: **${displayValue(updated.title, 'Без названия')}**`,
      `Публикация: **${formatDateTime(getRafflePublishAt(updated))}**`,
      `Окончание: **${formatDateTime(updated.end_at)}**`,
      '',
      `Опубликовано каналов: **${publishChannelsCount}**.`,
      '',
      'Если соадмин добавит свой канал позже по ссылке коллаборации, бот сразу опубликует розыгрыш и в его канале.'
    ].join('\n'),
    buildCreatedRaffleKeyboard(updated, userId)
  );
}

async function getRaffleWinnersWithUsers(raffleId) {
  const res = await pool.query(`
    SELECT
      rw.*,
      u.max_user_id,
      u.username,
      u.first_name,
      u.last_name,
      u.profile_link
    FROM raffle_winners rw
    LEFT JOIN users u ON u.max_user_id = rw.user_id
    WHERE rw.raffle_id = $1
    ORDER BY rw.id ASC
  `, [raffleId]);

  return res.rows;
}

function buildRaffleResultsText(raffle, winnersRows = [], organizerUser = null) {
  const organizer = organizerUser || {
    user_id: raffle.creator_user_id,
    max_user_id: raffle.creator_user_id
  };

  const lines = [
    `🥳 **Итоги розыгрыша #${getRafflePublicNumber(raffle)}**`,
    `**${displayValue(raffle.title, 'Без названия')}**`,
    '',
    `🎁 Приз выдаёт: ${formatPublicUser(organizer)}`,
    ''
  ];

  if (!winnersRows.length) {
    lines.push('Победители не выбраны: участников с подтверждёнными условиями не было.');
  } else {
    lines.push('🏆 **Победители:**');
    lines.push('');

    for (let i = 0; i < winnersRows.length; i++) {
      const winner = winnersRows[i];
      const user = {
        user_id: winner.user_id,
        max_user_id: winner.max_user_id || winner.user_id,
        username: winner.username,
        first_name: winner.first_name,
        last_name: winner.last_name,
        profile_link: winner.profile_link
      };

      lines.push(`${i + 1}. ${formatPublicUser(user)} — **${winner.prize_text || `Приз ${i + 1}`}**`);
      lines.push(`   🎟 Билет: **№${winner.ticket_number}**`);
    }
  }

  lines.push('');
  lines.push('Перед объявлением победителей бот проверяет подписку на обязательные каналы. Если победитель позже отпишется или условия нужно проверить повторно, организатор может нажать **🔁 Переиграть победителей**.');
  lines.push('');
  lines.push(buildRaffleFooter(raffle));

  return lines.join('\n');
}

async function publishRaffleResults(raffle, winnersRows = []) {
  const organizerUser = await getUserByMaxId(raffle.creator_user_id);
  const resultsText = buildRaffleResultsText(raffle, winnersRows, organizerUser);
  const organizerKeyboard = winnersRows.length
    ? [[{ text: '🔁 Переиграть победителей', callback_data: `reroll_winners:${raffle.id}` }]]
    : [];

  await sendMessage(raffle.creator_user_id, resultsText, organizerKeyboard.length ? organizerKeyboard : null).catch(error => {
    console.warn('Не удалось отправить итоги создателю:', error.message);
  });

  if (RESULTS_CHANNEL_ID) {
    await sendMessage(
      {
        type: 'chat_id',
        id: RESULTS_CHANNEL_ID
      },
      resultsText
    ).catch(error => {
      console.warn(`Не удалось опубликовать итоги в канал результатов ${RESULTS_CHANNEL_ID}:`, error.message);
    });
  }
}



async function getEnteredUsersWithProfiles(raffleId) {
  const res = await pool.query(`
    SELECT DISTINCT
      rue.user_id,
      u.max_user_id,
      u.username,
      u.first_name,
      u.last_name
    FROM raffle_user_entry rue
    LEFT JOIN users u ON u.max_user_id = rue.user_id
    WHERE rue.raffle_id = $1
    ORDER BY rue.user_id ASC
  `, [raffleId]);

  return res.rows;
}

function formatMissingChannelsText(missing = []) {
  if (!missing.length) return '';

  return missing
    .map(ch => `• ${formatChannelWithLink(ch)}`)
    .join('\n');
}

async function sendSubscriptionReminderToUser(raffle, user, missing, finalNotice = false) {
  const text = finalNotice
    ? [
        `⚠️ Розыгрыш **${displayValue(raffle.title, 'Без названия')}** завершился.`,
        '',
        'Вы были участником, но перед выбором победителей бот не подтвердил подписку на все обязательные каналы.',
        'Поэтому ваши билеты не участвовали в финальном выборе.',
        '',
        '**Не хватило подписки на:**',
        formatMissingChannelsText(missing)
      ].join('\n')
    : [
        `⏰ Напоминание по розыгрышу **${displayValue(raffle.title, 'Без названия')}**`,
        '',
        'Вы участвуете в розыгрыше, но сейчас бот не видит подписку на все обязательные каналы.',
        'Подпишитесь до окончания розыгрыша, иначе билет не попадёт в выбор победителей.',
        '',
        '**Не хватает подписки на:**',
        formatMissingChannelsText(missing),
        '',
        `Окончание: **${formatDateTime(raffle.end_at)}**`
      ].join('\n');

  await sendMessage(user.user_id, text).catch(error => {
    console.warn(`Не удалось отправить напоминание пользователю ${user.user_id}:`, error.message);
  });
}

async function revalidateRaffleParticipants(raffle, options = {}) {
  const users = await getEnteredUsersWithProfiles(raffle.id);
  const invalidUsers = [];
  let validUsersCount = 0;

  for (const user of users) {
    const sub = await checkUserAllSubscriptions(raffle.id, user.user_id, { source: options.finalNotice ? 'final_recheck' : 'reminder_recheck' });

    if (sub.ok) {
      validUsersCount += 1;

      await pool.query(`
        UPDATE raffle_participants
        SET is_valid = true
        WHERE raffle_id = $1 AND user_id = $2
      `, [raffle.id, user.user_id]);

      continue;
    }

    invalidUsers.push({
      user,
      missing: sub.missing
    });

    await pool.query(`
      UPDATE raffle_participants
      SET is_valid = false
      WHERE raffle_id = $1 AND user_id = $2
    `, [raffle.id, user.user_id]);

    if (options.notifyInvalid) {
      await sendSubscriptionReminderToUser(raffle, user, sub.missing, Boolean(options.finalNotice));
    }
  }

  const participants = await getValidParticipants(raffle.id);

  return {
    participants,
    invalidUsers,
    validUsersCount
  };
}

async function sendPendingJoinRemindersForRaffle(raffle) {
  const res = await pool.query(`
    SELECT
      pj.user_id,
      pj.invited_by,
      u.max_user_id,
      u.username,
      u.first_name,
      u.last_name
    FROM raffle_pending_joins pj
    LEFT JOIN users u ON u.max_user_id = pj.user_id
    WHERE pj.raffle_id = $1
      AND pj.status = 'pending'
      AND NOT EXISTS (
        SELECT 1
        FROM raffle_user_entry rue
        WHERE rue.raffle_id = pj.raffle_id
          AND rue.user_id = pj.user_id
      )
  `, [raffle.id]);

  const channels = await getRaffleChannels(raffle.id);

  for (const row of res.rows) {
    const sub = await checkUserAllSubscriptions(raffle.id, row.user_id, { source: 'pending_reminder_check' });
    const missing = sub.ok ? [] : sub.missing;

    await sendMessage(
      row.user_id,
      [
        `⏰ Напоминание по розыгрышу **${displayValue(raffle.title, 'Без названия')}**`,
        '',
        'Вы открывали участие, но билет ещё не создан.',
        'Чтобы принять участие, подпишитесь на каналы и нажмите **Проверить подписку**.',
        '',
        missing.length
          ? '**Не хватает подписки на:**\n' + formatMissingChannelsText(missing)
          : buildRafflePublicChannelsText(channels),
        '',
        `Окончание: **${formatDateTime(raffle.end_at)}**`
      ].filter(Boolean).join('\n'),
      [[{ text: '✅ Проверить подписку', callback_data: buildJoinCheckCallback(raffle.id, row.invited_by) }]]
    ).catch(error => {
      console.warn(`Не удалось отправить напоминание ожидающему участнику ${row.user_id}:`, error.message);
    });
  }
}


async function sendOneMinutePendingJoinReminders() {
  const res = await pool.query(`
    SELECT
      pj.id,
      pj.raffle_id,
      pj.user_id,
      pj.invited_by,
      r.title,
      r.end_at,
      r.status
    FROM raffle_pending_joins pj
    JOIN raffles r ON r.id = pj.raffle_id
    WHERE pj.status = 'pending'
      AND pj.reminder_sent_at IS NULL
      AND pj.updated_at <= NOW() - ($1::text || ' seconds')::interval
      AND r.status IN ('scheduled', 'active')
      AND r.end_at > NOW()
      AND NOT EXISTS (
        SELECT 1
        FROM raffle_user_entry rue
        WHERE rue.raffle_id = pj.raffle_id
          AND rue.user_id = pj.user_id
      )
    ORDER BY pj.updated_at ASC
    LIMIT 50
  `, [PENDING_JOIN_REMINDER_DELAY_SECONDS]);

  for (const row of res.rows) {
    try {
      const sub = await checkUserAllSubscriptions(row.raffle_id, row.user_id, { source: 'one_minute_pending_reminder_check' });
      const missing = sub.ok ? [] : sub.missing;

      await sendMessage(
        row.user_id,
        [
          `🎫 **Завершите участие в розыгрыше «${displayValue(row.title, 'Без названия')}»**`,
          '',
          'Вы недавно нажали **«🎁Участвовать»**, но билет ещё не создан.',
          '',
          missing.length
            ? `Подпишитесь на оставшиеся каналы и нажмите **✅ Проверить подписку** 👇\n\n${formatMissingChannelsText(missing)}`
            : 'Нажмите **✅ Проверить подписку**, чтобы бот создал ваш билет 👇',
          '',
          `Окончание: **${formatDateTime(row.end_at)}**`
        ].filter(Boolean).join('\n'),
        [[{ text: '✅ Проверить подписку', callback_data: buildJoinCheckCallback(row.raffle_id, row.invited_by) }]]
      );

      console.log('🔔 Отправлено напоминание о незавершённом участии:', {
        raffle_id: row.raffle_id,
        user_id: String(row.user_id)
      });
    } catch (error) {
      console.warn('Не удалось отправить напоминание о незавершённом участии:', {
        raffle_id: row.raffle_id,
        user_id: String(row.user_id),
        error: error.message
      });
    } finally {
      await pool.query(`
        UPDATE raffle_pending_joins
        SET reminder_sent_at = COALESCE(reminder_sent_at, NOW()), updated_at = updated_at
        WHERE id = $1
      `, [row.id]).catch(error => {
        console.warn('Не удалось отметить pending join reminder_sent_at:', error.message);
      });
    }
  }
}

async function sendSubscriptionRemindersForRaffle(raffleId) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle || !['active', 'scheduled'].includes(raffle.status)) return;

  await revalidateRaffleParticipants(raffle, {
    notifyInvalid: true,
    finalNotice: false
  });

  await sendPendingJoinRemindersForRaffle(raffle);
}

function getRafflePrizesList(raffle) {
  return raffle.prizes
    ? raffle.prizes.split('\n').filter(Boolean)
    : ['Главный приз'];
}

function selectUniqueWinners(participants = [], neededCount = 1) {
  // Розыгрыш идёт по билетам, поэтому больше билетов = выше шанс.
  // Но приз получает уникальный человек: один user_id может выиграть максимум один приз.
  const shuffled = shuffleSecure(participants.filter(p => String(p?.user_id || '').trim()));
  const uniqueByUser = [];
  const usedUsers = new Set();
  const limit = Math.max(1, Number(neededCount || 1));

  for (const p of shuffled) {
    const userId = String(p.user_id);

    if (!usedUsers.has(userId)) {
      uniqueByUser.push(p);
      usedUsers.add(userId);
    }

    if (uniqueByUser.length >= limit) break;
  }

  return uniqueByUser;
}

async function notifyWinners(raffle, winnersRows = [], prizes = []) {
  const organizerUser = await getUserByMaxId(raffle.creator_user_id);

  for (let i = 0; i < winnersRows.length; i++) {
    const winner = winnersRows[i];
    const prize = winner.prize_text || prizes[i] || `Приз ${i + 1}`;

    await sendMessage(
      winner.user_id,
      [
        '🎉 Поздравляем!',
        `Вы выиграли в розыгрыше **${displayValue(raffle.title, 'Без названия')}**`,
        `Ваш приз: **${prize}**`,
        `Ваш билет: **№${winner.ticket_number}**`,
        `🎁 Приз выдаёт: ${formatPublicUser(organizerUser)}`,
        '',
        buildBotBrandLine()
      ].join('\n')
    ).catch(error => {
      console.warn(`Не удалось отправить победителю ${winner.user_id}:`, error.message);
    });
  }
}

async function finishRaffle(raffleId) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle || !['active', 'scheduled'].includes(raffle.status)) return;

  const prizes = getRafflePrizesList(raffle);
  const requestedCount = raffle.prize_count || prizes.length || 1;
  const validation = await revalidateRaffleParticipants(raffle, {
    notifyInvalid: true,
    finalNotice: true
  });
  const participants = validation.participants;
  const uniqueParticipantCount = new Set(participants.map(p => String(p.user_id))).size;
  const neededCount = Math.min(requestedCount, uniqueParticipantCount || requestedCount);

  if (!participants.length) {
    await updateRaffle(raffle.id, { status: 'finished' });
    await publishRaffleResults(raffle, []);
    return;
  }

  const winners = selectUniqueWinners(participants, neededCount);

  await pool.query('DELETE FROM raffle_winners WHERE raffle_id = $1', [raffle.id]);
  await saveWinners(raffle.id, winners, prizes);
  await updateRaffle(raffle.id, { status: 'finished' });

  await pool.query(`
    UPDATE raffle_queue
    SET status = 'done', updated_at = NOW()
    WHERE raffle_id = $1
      AND queue_type = 'raffle_finish'
      AND status IN ('pending', 'processing')
  `, [raffle.id]);

  const winnersRows = await getRaffleWinnersWithUsers(raffle.id);

  await notifyWinners(raffle, winnersRows, prizes);
  await publishRaffleResults(raffle, winnersRows);
}

async function rerollRaffleWinners(target, userId, raffleId) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
  }

  if (Number(raffle.creator_user_id) !== Number(userId) && !isAdmin(userId)) {
    return sendMessage(target, '⛔ Переиграть победителей может только организатор розыгрыша или админ бота.');
  }

  if (raffle.status !== 'finished') {
    return sendMessage(target, `Переиграть можно только завершённый розыгрыш. Сейчас статус: ${formatRaffleStatus(raffle.status)}.`);
  }

  const prizes = getRafflePrizesList(raffle);
  const requestedCount = raffle.prize_count || prizes.length || 1;

  await sendMessage(target, '🔁 Проверяю подписки участников и переигрываю победителей среди тех, кто точно выполнил обязательные условия...');

  const validation = await revalidateRaffleParticipants(raffle, {
    notifyInvalid: true,
    finalNotice: true
  });

  if (!validation.participants.length) {
    return sendMessage(target, 'Не удалось переиграть: нет участников с подтверждённой подпиской на обязательные каналы. Старые итоги пока не изменены.');
  }

  const uniqueParticipantCount = new Set(validation.participants.map(p => String(p.user_id))).size;
  const neededCount = Math.min(requestedCount, uniqueParticipantCount || requestedCount);
  const winners = selectUniqueWinners(validation.participants, neededCount);

  await pool.query('DELETE FROM raffle_winners WHERE raffle_id = $1', [raffle.id]);
  await saveWinners(raffle.id, winners, prizes);

  const winnersRows = await getRaffleWinnersWithUsers(raffle.id);
  await notifyWinners(raffle, winnersRows, prizes);
  await publishRaffleResults(raffle, winnersRows);

  return sendMessage(target, '✅ Победители переиграны. Новые итоги отправлены и опубликованы.', buildCreatedRaffleKeyboard(raffle, userId));
}

async function stopRaffleNow(target, userId, raffleId = null) {
  let raffle = null;

  if (raffleId) {
    raffle = await getRaffleById(raffleId);
  } else {
    const res = await pool.query(`
      SELECT *
      FROM raffles
      WHERE creator_user_id = $1
        AND status IN ('scheduled', 'active')
      ORDER BY id DESC
      LIMIT 1
    `, [userId]);

    raffle = res.rows[0] || null;
  }

  if (!raffle) {
    return sendMessage(target, 'Не найден активный или запланированный розыгрыш для досрочного завершения. Используйте `/stop ID`, например `/stop 14`.');
  }

  if (Number(raffle.creator_user_id) !== Number(userId) && !isAdmin(userId)) {
    return sendMessage(target, '⛔ Досрочно завершить розыгрыш может только организатор или админ бота.');
  }

  if (!['scheduled', 'active'].includes(raffle.status)) {
    return sendMessage(target, `Этот розыгрыш нельзя завершить через /stop. Текущий статус: ${formatRaffleStatus(raffle.status)}.`);
  }

  await sendMessage(target, `⏹ Досрочно завершаю розыгрыш #${getRafflePublicNumber(raffle)} и выбираю победителей среди участников с подтверждённой подпиской...`);
  await finishRaffle(raffle.id);
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

      if (item.queue_type === 'raffle_subscription_reminder') {
        await sendSubscriptionRemindersForRaffle(item.raffle_id);
      }

      if (item.queue_type === 'general_publish') {
        await publishPaidGeneralQueuedItem(item);
      }

      if (item.queue_type === 'admin_community_invite') {
        await sendAdminCommunityInviteQueuedItem(item);
      }

      if (item.queue_type === 'raffle_post_update') {
        await processRafflePostUpdateQueuedItem(item);
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


async function isRaffleOrganizer(raffle, userId) {
  if (!userId) return false;
  if (isAdmin(userId)) return true;
  if (Number(raffle.creator_user_id) === Number(userId)) return true;

  const res = await pool.query(`
    SELECT 1
    FROM raffle_channels
    WHERE raffle_id = $1
      AND owner_user_id = $2
    LIMIT 1
  `, [raffle.id, userId]);

  return Boolean(res.rows.length);
}

async function getChannelPeriodStats(channelId, periodStart, periodEnd) {
  const map = await getChannelPeriodStatsMap([channelId], periodStart, periodEnd);
  return map.get(String(channelId)) || { joined: 0, left: 0 };
}

async function getChannelPeriodStatsMap(channelIds = [], periodStart, periodEnd) {
  const ids = [...new Set(
    channelIds
      .map(id => String(id || '').trim())
      .filter(Boolean)
  )];

  const stats = new Map(ids.map(id => [id, { joined: 0, left: 0 }]));

  if (!ids.length) {
    return stats;
  }

  const res = await pool.query(`
    SELECT
      channel_id::text AS channel_id,
      COUNT(*) FILTER (WHERE delta > 0)::int AS joined,
      COUNT(*) FILTER (WHERE delta < 0)::int AS left_count
    FROM channel_member_events
    WHERE channel_id = ANY($1::bigint[])
      AND event_at >= $2
      AND event_at <= $3
    GROUP BY channel_id
  `, [ids, periodStart, periodEnd]);

  for (const row of res.rows) {
    stats.set(String(row.channel_id), {
      joined: Number(row.joined || 0),
      left: Number(row.left_count || 0)
    });
  }

  return stats;
}

async function getRaffleSubscriptionCheckStatsMap(raffleId, channelIds = [], periodStart, periodEnd) {
  const ids = [...new Set(
    channelIds
      .map(id => String(id || '').trim())
      .filter(Boolean)
  )];

  const stats = new Map(ids.map(id => [id, {
    joined: 0,
    left: 0,
    currentlySubscribed: 0,
    checkedUsers: 0
  }]));

  if (!ids.length) {
    return stats;
  }

  const eventsRes = await pool.query(`
    SELECT
      channel_id::text AS channel_id,
      COUNT(*) FILTER (WHERE delta > 0)::int AS joined,
      COUNT(*) FILTER (WHERE delta < 0)::int AS left_count
    FROM raffle_channel_subscription_events
    WHERE raffle_id = $1
      AND channel_id = ANY($2::bigint[])
      AND created_at >= $3
      AND created_at <= $4
    GROUP BY channel_id
  `, [raffleId, ids, periodStart, periodEnd]);

  for (const row of eventsRes.rows) {
    const current = stats.get(String(row.channel_id)) || {
      joined: 0,
      left: 0,
      currentlySubscribed: 0,
      checkedUsers: 0
    };

    current.joined = Number(row.joined || 0);
    current.left = Number(row.left_count || 0);
    stats.set(String(row.channel_id), current);
  }

  const statesRes = await pool.query(`
    SELECT
      channel_id::text AS channel_id,
      COUNT(*)::int AS checked_users,
      COUNT(*) FILTER (WHERE is_subscribed = true)::int AS currently_subscribed
    FROM raffle_channel_subscription_states
    WHERE raffle_id = $1
      AND channel_id = ANY($2::bigint[])
    GROUP BY channel_id
  `, [raffleId, ids]);

  for (const row of statesRes.rows) {
    const current = stats.get(String(row.channel_id)) || {
      joined: 0,
      left: 0,
      currentlySubscribed: 0,
      checkedUsers: 0
    };

    current.checkedUsers = Number(row.checked_users || 0);
    current.currentlySubscribed = Number(row.currently_subscribed || 0);
    stats.set(String(row.channel_id), current);
  }

  return stats;
}

// =========================
// Статистика
// =========================
async function sendRaffleStats(target, raffleId, requesterUserId = null) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
  }

  if (!(await isRaffleOrganizer(raffle, requesterUserId))) {
    return sendMessage(target, '⛔ Статистика этого розыгрыша доступна только организатору, соадминам каналов и админам бота.');
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

  const invalidTickets = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM raffle_participants
    WHERE raffle_id = $1 AND is_valid = false
  `, [raffleId]);

  const winners = await getRaffleWinnersWithUsers(raffleId);
  const channels = await getRaffleChannels(raffleId);
  const periodStart = raffle.publish_at || raffle.created_at || new Date(0);
  const periodEnd = raffle.status === 'finished'
    ? (raffle.end_at || new Date())
    : new Date();

  let text = `📊 **Статистика розыгрыша #${getRafflePublicNumber(raffle)}**\n`;
  text += `Название: ${displayValue(raffle.title, 'Без названия')}\n`;
  text += `Статус: ${formatRaffleStatus(raffle.status)}\n`;
  text += `Публикация: ${formatDateTime(getRafflePublishAt(raffle))}\n`;
  text += `Окончание: ${formatDateTime(raffle.end_at)}\n`;
  text += `Участников: ${totalUsers.rows[0].count}\n`;
  text += `Действительных билетов: ${totalTickets.rows[0].count}\n`;
  text += `Недействительных билетов после проверки подписок: ${invalidTickets.rows[0].count}\n\n`;

  text += `**Каналы за период ${formatDateTime(periodStart)} — ${formatDateTime(periodEnd)}:**\n`;

  if (!channels.length) {
    text += 'Каналы не указаны.\n';
  } else {
    const channelStatsMap = await getRaffleSubscriptionCheckStatsMap(
      raffleId,
      channels.map(ch => ch.channel_id),
      periodStart,
      periodEnd
    );

    const sourceRes = await pool.query(`
      SELECT
        COALESCE(source_channel_id::text, 'unknown') AS source_channel_id,
        COUNT(DISTINCT user_id)::int AS participants
      FROM raffle_user_entry
      WHERE raffle_id = $1
      GROUP BY COALESCE(source_channel_id::text, 'unknown')
    `, [raffleId]);

    const sourceMap = new Map(
      sourceRes.rows.map(row => [String(row.source_channel_id), Number(row.participants || 0)])
    );

    for (const ch of channels) {
      const channelStats = channelStatsMap.get(String(ch.channel_id)) || { joined: 0, left: 0 };
      const fromPost = sourceMap.get(String(ch.channel_id)) || 0;
      const net = channelStats.joined - channelStats.left;
      const conversion = channelStats.joined > 0
        ? `${((fromPost / channelStats.joined) * 100).toFixed(1)}%`
        : '—';

      text += `• ${formatChannelWithLink(ch)}\n`;
      text += `  ├ 👥 Участников из поста: **${fromPost}**\n`;
      text += `  ├ 🟢 Подписалось: **+${channelStats.joined}** / 🔴 Отписалось: **-${channelStats.left}** / Итог: **${net >= 0 ? '+' : ''}${net}**\n`;
      text += `  └ 📈 Конверсия в участника: **${conversion}**\n`;
    }

    const unknown = sourceMap.get('unknown') || 0;
    if (unknown) {
      text += `\n⚪ Участники без источника: **${unknown}** — это старые ссылки/ручной вход без channel_id.\n`;
    }

    
  }

  if (winners.length) {
    text += '\n🏆 **Победители:**\n';

    for (const w of winners) {
      const user = {
        user_id: w.user_id,
        max_user_id: w.max_user_id || w.user_id,
        username: w.username,
        first_name: w.first_name,
        last_name: w.last_name
      };

      text += `• ${formatPublicUser(user)} — ${w.prize_text}\n`;
    }
  }

  const keyboard = [
    [{ text: '⬅️ Назад к розыгрышу', callback_data: `refresh_raffle:${raffle.id}` }],
    [{ text: '🔎 Мои розыгрыши', callback_data: 'my_raffles' }]
  ];

  if (isAdmin(requesterUserId)) {
    keyboard.push([{ text: '🔥 Активные розыгрыши', callback_data: 'admin_active' }]);
  }

  return sendMessage(target, text, keyboard);
}

// =========================
// Создание розыгрыша по шагам
// =========================
async function handleSessionMessage(message) {
  const userId = message.from.id;
  const target = message.chat.id;
  const text = message.text || '';
  const session = await getSession(userId);

  if (!session) return false;

  if (['/cancel', 'отмена', 'cancel'].includes(text.trim().toLowerCase())) {
    await clearSession(userId);
    await sendMessage(target, 'Действие отменено.');
    await sendMainMenu(target, userId);
    return true;
  }

  const state = session.state;
  const data = typeof session.data === 'string'
    ? JSON.parse(session.data || '{}')
    : session.data || {};

  if (state === 'await_admin_broadcast_text') {
    return handleAdminBroadcastText(message, data);
  }

  if (state === 'await_admin_broadcast_confirm') {
    return sendAdminBroadcastPreview(target, userId, text);
  }

  if (state === 'await_promo_receipt_email') {
    return handlePromotionEmailMessage(message, data);
  }

  if (state === 'await_photo' || state === 'edit_photo') {
    const photo = extractFirstPhotoAttachmentFromMessage(message);

    if (!photo) {
      await sendMessage(
        target,
        [
          'Отправьте фото одним сообщением.',
          '',
          'Если фото не нужно, нажмите кнопку «Убрать фото» в шаблоне или отмените действие.'
        ].join('\n')
      );
      return true;
    }

    data.photo_attachment = photo;
    await sendRaffleDraftPreview(target, userId, data);
    return true;
  }

  if (state === 'await_title') {
    data.title = safeText(text, 255);

    if (!data.title) {
      await sendMessage(target, ['Название не может быть пустым.', '', buildRaffleTitlePrompt()].join('\n'));
      return true;
    }

    await setSession(userId, 'await_description', data);
    await sendMessage(target, 'Введите описание розыгрыша:');
    return true;
  }

  if (state === 'await_description') {
    data.description = safeText(text, 2000);

    await setSession(userId, 'await_prizes', data);
    await sendMessage(target, 'Введите список призов, каждый с новой строки: без запятой');
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

    await setSession(userId, 'await_publish_date', data);
    await sendPublishDatePrompt(target, data);
    return true;
  }

  if (state === 'await_publish_date' || state === 'edit_publish_date') {
    const parsed = parseEndDate(text);

    if (!parsed || !parsed.isValid()) {
      await sendMessage(target, 'Неверный формат даты публикации. Пример: `2026-06-10 20:00`');
      return true;
    }

    const minPublishAt = getMinPublishAt();

    if (parsed.isBefore(minPublishAt)) {
      await sendMessage(
        target,
        `Публикация должна быть в будущем. Текущее время бота: **${formatDateTime(minPublishAt)}**.`
      );
      return true;
    }

    data.publish_at = parsed.toISOString();

    if (state === 'edit_publish_date') {
      const minEndAt = getMinEndAtForPublish(data.publish_at);
      const currentEndAt = toUtcMoment(data.end_at);

      if (!currentEndAt || currentEndAt.isBefore(minEndAt)) {
        data.end_at = null;
        await setSession(userId, 'await_end_date', data);
        await sendMessage(target, 'После изменения публикации нужно заново выбрать время окончания.');
        await sendEndDatePrompt(target, data);
        return true;
      }

      await sendRaffleDraftPreview(target, userId, data);
      return true;
    }

    await setSession(userId, 'await_end_date', data);
    await sendEndDatePrompt(target, data);
    return true;
  }

  if (state === 'await_end_date' || state === 'edit_end_date') {
    const parsed = parseEndDate(text);

    if (!parsed || !parsed.isValid()) {
      await sendMessage(target, 'Неверный формат даты окончания. Пример: `2026-06-10 20:00`');
      return true;
    }

    const minEndAt = getMinEndAtForPublish(data.publish_at);

    if (parsed.isBefore(minEndAt)) {
      await sendMessage(
        target,
        `Окончание должно быть минимум через ${MIN_RAFFLE_DURATION_AFTER_PUBLISH_MINUTES} минут после публикации. Ближайшее допустимое время: **${formatDateTime(minEndAt)}**.`
      );
      return true;
    }

    data.end_at = parsed.toISOString();

    if (state === 'edit_end_date') {
      await sendRaffleDraftPreview(target, userId, data);
      return true;
    }

    data.channels = Array.isArray(data.channels) ? data.channels : [];

    await setSession(userId, 'await_channel_selection', data);
    await sendChannelSelectionMenu(target, userId, data, 'create');

    return true;
  }

  if (state === 'edit_title') {
    data.title = safeText(text, 255);

    if (!data.title) {
      await sendMessage(target, 'Название не может быть пустым. Введите новое название:');
      return true;
    }

    await sendRaffleDraftPreview(target, userId, data);
    return true;
  }

  if (state === 'edit_description') {
    data.description = safeText(text, 2000);
    await sendRaffleDraftPreview(target, userId, data);
    return true;
  }

  if (state === 'edit_prizes') {
    const prizes = safeText(text, 3000);
    const prizeList = prizes.split('\n').map(x => x.trim()).filter(Boolean);

    if (!prizeList.length) {
      await sendMessage(target, 'Добавьте хотя бы один приз.');
      return true;
    }

    data.prizes = prizeList.join('\n');
    data.prize_count = prizeList.length;
    await sendRaffleDraftPreview(target, userId, data);
    return true;
  }

  if (state === 'await_final_preview') {
    await sendRaffleDraftPreview(target, userId, data);
    return true;
  }

  if (state === 'await_channel_selection') {
    await sendChannelSelectionMenu(target, userId, data, 'create');
    return true;
  }

  if (state === 'collab_channel_selection') {
    await sendChannelSelectionMenu(target, userId, data, 'collab');
    return true;
  }

  return false;
}

// =========================
// Участие
// =========================
function normalizeReferralId(invitedBy, userId = null) {
  const ref = Number(invitedBy);

  if (!Number.isInteger(ref) || ref <= 0) return null;
  if (userId && Number(userId) === ref) return null;

  return ref;
}

async function recordPendingRaffleJoin(raffleId, userId, invitedBy = null, sourceChannelId = null) {
  const ref = normalizeReferralId(invitedBy, userId);

  // Старые базы могли не иметь уникального индекса (raffle_id, user_id), поэтому вместо
  // ON CONFLICT делаем безопасный UPDATE -> INSERT. При наличии индекса ловим дубль 23505.
  const updated = await pool.query(`
    UPDATE raffle_pending_joins
    SET
      invited_by = COALESCE(invited_by, $3),
      source_channel_id = COALESCE(source_channel_id, $4),
      status = CASE
        WHEN status = 'completed' THEN 'completed'
        ELSE 'pending'
      END,
      reminder_sent_at = CASE
        WHEN status = 'completed' THEN reminder_sent_at
        ELSE NULL
      END,
      updated_at = NOW()
    WHERE raffle_id = $1 AND user_id = $2
    RETURNING id
  `, [raffleId, userId, ref, sourceChannelId]);

  if (updated.rows.length) return;

  try {
    await pool.query(`
      INSERT INTO raffle_pending_joins (
        raffle_id,
        user_id,
        invited_by,
        source_channel_id,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW())
    `, [raffleId, userId, ref, sourceChannelId]);
  } catch (error) {
    if (error?.code === '23505') {
      await pool.query(`
        UPDATE raffle_pending_joins
        SET
          invited_by = COALESCE(invited_by, $3),
          source_channel_id = COALESCE(source_channel_id, $4),
          status = CASE
            WHEN status = 'completed' THEN 'completed'
            ELSE 'pending'
          END,
          reminder_sent_at = CASE
            WHEN status = 'completed' THEN reminder_sent_at
            ELSE NULL
          END,
          updated_at = NOW()
        WHERE raffle_id = $1 AND user_id = $2
      `, [raffleId, userId, ref, sourceChannelId]);
      return;
    }

    throw error;
  }
}

async function markPendingRaffleJoinCompleted(raffleId, userId) {
  await pool.query(`
    UPDATE raffle_pending_joins
    SET status = 'completed', updated_at = NOW()
    WHERE raffle_id = $1 AND user_id = $2
  `, [raffleId, userId]);
}

async function getLatestPendingJoinForUser(userId) {
  const res = await pool.query(`
    SELECT pj.*
    FROM raffle_pending_joins pj
    JOIN raffles r ON r.id = pj.raffle_id
    WHERE pj.user_id = $1
      AND pj.status = 'pending'
      AND r.status IN ('scheduled', 'active')
      AND r.end_at > NOW()
    ORDER BY pj.updated_at DESC, pj.id DESC
    LIMIT 1
  `, [userId]);

  return res.rows[0] || null;
}

function buildJoinCheckCallback(raffleId, invitedBy = null) {
  const ref = normalizeReferralId(invitedBy);
  return ref ? `check_join:${raffleId}:${ref}` : `check_join:${raffleId}`;
}

function buildJoinChannelsText(channels = []) {
  if (!channels.length) return '';

  const unique = [];
  const seen = new Set();

  for (const channel of channels) {
    const key = String(channel?.channel_id || channel?.chat_id || channel?.id || formatChannelName(channel)).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(channel);
  }

  if (!unique.length) return '';

  const lines = unique.map((channel, index) => {
    return `${index + 1}. ${formatChannelWithLink(channel)}`;
  });

  return [
    '📢 **Подпишитесь на каналы:**',
    ...lines
  ].join('\n');
}

function buildJoinIntroText(raffle, channels = []) {
  const channelsText = buildJoinChannelsText(channels);

  return [
    `🎁 **Участие в розыгрыше #${getRafflePublicNumber(raffle)}**`,
    '',
    `**${displayValue(raffle.title, 'Без названия')}**`,
    '',
    buildRaffleRulesLine(),
    '',
    channelsText
      ? 'Чтобы принять участие, подпишитесь на каналы розыгрыша:'
      : 'Для этого розыгрыша каналы для подписки не указаны.',
    channelsText || '',
    '',
    'После подписки нажмите кнопку **✅ Проверить подписку**.',
    'Билет будет создан после успешной проверки условий участия.',
    '',
    `Окончание: **${formatDateTime(raffle.end_at)}**`
  ].filter(Boolean).join('\n');
}

async function showJoinRaffleStart(target, userId, raffleId, invitedBy = null, sourceChannelId = null) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
  }

  if (!['scheduled', 'active'].includes(raffle.status)) {
    return sendMessage(target, 'Этот розыгрыш уже недоступен для участия.');
  }

  if (raffle.end_at && toUtcMoment(raffle.end_at)?.isBefore(dayjs.utc())) {
    return sendMessage(target, 'Время участия в этом розыгрыше уже закончилось.');
  }

  await recordPendingRaffleJoin(raffle.id, userId, invitedBy, sourceChannelId);

  const channels = await getRaffleChannels(raffle.id);

  return sendMessage(
    target,
    buildJoinIntroText(raffle, channels),
    [[{ text: '✅ Проверить подписку', callback_data: buildJoinCheckCallback(raffle.id, invitedBy) }]]
  );
}

async function notifyReferrerAboutBonus(referrerId, raffle, bonusTicketNumber, bonusCount) {
  if (!referrerId || !bonusTicketNumber) return;

  await sendMessage(
    referrerId,
    [
      '🎟 Вам начислен бонусный билет!',
      '',
      `Розыгрыш: **${displayValue(raffle.title, 'Без названия')}**`,
      `Бонусный билет: **№${bonusTicketNumber}**`,
      `Бонусов по этому розыгрышу: **${bonusCount}/${MAX_REFERRAL_BONUS_TICKETS}**`
    ].join('\n')
  ).catch(error => {
    console.warn(`Не удалось отправить уведомление о бонусном билете ${referrerId}:`, error.message);
  });
}

async function completeJoinRaffleAfterCheck(target, userId, raffleId, invitedBy = null, sourceChannelId = null) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
  }

  if (!['scheduled', 'active'].includes(raffle.status)) {
    return sendMessage(target, 'Этот розыгрыш уже недоступен для участия.');
  }

  if (raffle.end_at && toUtcMoment(raffle.end_at)?.isBefore(dayjs.utc())) {
    return sendMessage(target, 'Время участия в этом розыгрыше уже закончилось.');
  }

  await recordPendingRaffleJoin(raffle.id, userId, invitedBy, sourceChannelId);

  const pendingJoin = await pool.query(`
    SELECT source_channel_id
    FROM raffle_pending_joins
    WHERE raffle_id = $1 AND user_id = $2
    LIMIT 1
  `, [raffle.id, userId]);

  const savedSourceChannelId = sourceChannelId || pendingJoin.rows[0]?.source_channel_id || null;

  const sub = await checkUserAllSubscriptions(raffle.id, userId, { source: 'ticket_check' });

  if (sub.permissionProblems?.length) {
    await notifyRafflePermissionProblemsFromJoinCheck(raffle, sub.permissionProblems);
  }

  if (!sub.ok) {
    let text = '❌ Пока бот не видит подписку на все обязательные каналы.\n\n';
    text += 'Чтобы принять участие, подпишитесь на каналы розыгрыша:\n\n';
    text += formatMissingChannelsText(sub.missing) || '• список каналов временно недоступен';
    text += '\n\nПосле подписки нажмите **✅ Проверить подписку** ещё раз.';

    return sendMessage(
      target,
      text,
      [[{ text: '✅ Проверить подписку', callback_data: buildJoinCheckCallback(raffle.id, invitedBy) }]]
    );
  }

  const entry = await createParticipantEntry(raffle.id, userId, invitedBy, savedSourceChannelId);
  await markPendingRaffleJoinCompleted(raffle.id, userId);

  if (!entry.alreadyJoined) {
    await scheduleRafflePostUpdate(raffle.id, {
      reason: 'new_participant',
      delaySeconds: RAFFLE_POST_UPDATE_DEBOUNCE_SECONDS
    }).catch(error => {
      console.warn(`Не удалось поставить обновление счётчика участников розыгрыша ${raffle.id} в очередь:`, error.message);
    });
  }

  const refLink = buildJoinLink(raffle.id, userId);

  if (entry.alreadyJoined) {
    return sendMessage(
      target,
      [
        `✅ Вы уже участвуете в розыгрыше #${getRafflePublicNumber(raffle)}.`,
        '',
        '🔗 Ваша пригласительная ссылка:',
        refLink,
        '',
        `За каждого приглашённого участника можно получить +1 билет, максимум **${MAX_REFERRAL_BONUS_TICKETS}** бонусных билетов.`,
        '',
        buildRaffleWinWarningLine(),
      ].join('\n'),
      buildBotBrandKeyboard()
    );
  }

  if (entry.bonusAdded) {
    await notifyReferrerAboutBonus(entry.referrerId, raffle, entry.bonusTicketNumber, entry.referrerBonusCount);
  }

  const bonusLine = entry.bonusLimitReached
    ? `Пригласивший уже получил максимум бонусных билетов: **${MAX_REFERRAL_BONUS_TICKETS}**.`
    : '';

  return sendMessage(
    target,
    [
      `🎟 Вы участвуете в розыгрыше #${getRafflePublicNumber(raffle)}!`,
      `🎉 **${displayValue(raffle.title, 'Без названия')}**`,
      `Ваш билет: **№${entry.ticketNumber}**`,
      '',
      '🔗 Ваша пригласительная ссылка:',
      refLink,
      '',
      `За каждого приглашённого участника можно получить **+1 бонусный билет**.`,
      `Лимит бонусных билетов: **${MAX_REFERRAL_BONUS_TICKETS}**.`,
      '',
      buildRaffleWinWarningLine(),
      bonusLine
    ].filter(Boolean).join('\n'),
    buildBotBrandKeyboard()
  );
}

async function joinRaffle(target, userId, raffleId, invitedBy = null, sourceChannelId = null) {
  return showJoinRaffleStart(target, userId, raffleId, invitedBy, sourceChannelId);
}

async function sendActiveRafflesJoinMenu(target, userId) {
  const res = await pool.query(`
    SELECT id, title, end_at
    FROM raffles
    WHERE status = 'active'
      AND end_at > NOW()
    ORDER BY end_at ASC, id DESC
    LIMIT 15
  `);

  const morePrizesUrl = MORE_PRIZES_URL || BOT_PUBLIC_URL;

  if (!res.rows.length) {
    const keyboard = [];

    if (morePrizesUrl) {
      keyboard.push([{ text: `🎁 Еще больше призов ${MORE_PRIZES_LABEL}`, url: morePrizesUrl }]);
    }

    keyboard.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);

    return sendMessage(
      target,
      [
        'Сейчас нет активных розыгрышей для участия.',
        '',
        buildMorePrizesLine()
      ].join('\n'),
      keyboard
    );
  }

  const lines = [
    '🎁 **Активные розыгрыши:**',
    '',
    'Выберите розыгрыш, в котором хотите участвовать:'
  ];

  const keyboard = [];

  for (const raffle of res.rows) {
    const number = getRafflePublicNumber(raffle);
    const title = truncateButtonText(displayValue(raffle.title, 'Без названия'), 28);

    lines.push(`• № **${number}** — ${displayValue(raffle.title, 'Без названия')} | до ${formatDateTime(raffle.end_at)}`);

    keyboard.push([
      {
        text: `🎁 №${number} ${title}`,
        callback_data: `join_raffle:${raffle.id}`
      }
    ]);
  }

  lines.push('', buildMorePrizesLine());

  if (morePrizesUrl) {
    keyboard.push([{ text: `🎁 Еще больше призов ${MORE_PRIZES_LABEL}`, url: morePrizesUrl }]);
  }

  keyboard.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);

  return sendMessage(target, lines.join('\n'), keyboard);
}

async function joinLatestRaffle(target, userId) {
  // Раньше эта кнопка брала последний созданный scheduled/active розыгрыш.
  // Теперь показываем список именно активных розыгрышей, чтобы пользователь сам выбрал приз.
  return sendActiveRafflesJoinMenu(target, userId);
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
      'Управление доступно через кнопки ниже.',
      '',
      'Команда для ручной публикации активного розыгрыша в General:',
      '`/general ID_РОЗЫГРЫША`',
      '',
      'Команда для рассылки всем пользователям:',
      '`/broadcast`'
    ].join('\n'),
    [
      [{ text: '📊 Статистика', callback_data: 'admin_stats' }],
      [{ text: '🔥 Активные розыгрыши', callback_data: 'admin_active' }],
      [{ text: '📣 Рассылка всем пользователям', callback_data: 'admin_broadcast' }],
      [{ text: '⛔ Бан по ID', callback_data: 'admin_ban_help' }],
      [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
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
      `Пользователей активных для рассылки: ${stats.activeUsers}`,
      `Пользователей всего в базе: ${stats.users}`,
      `Недоступных для рассылки: ${stats.inactiveUsers}`,
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
  const keyboard = [];

  for (const r of res.rows) {
    text += `#${r.id} | ${displayValue(r.title, 'Без названия')} | ${formatRaffleStatus(r.status)} | до ${formatDateTime(r.end_at)}\n`;
    text += `Создатель: ${displayValue(r.creator_user_id, 'не указан')}\n\n`;

    const row = [
      { text: `📊 #${r.id}`, callback_data: `raffle_stats:${r.id}` }
    ];

    if (String(r.status || '') === 'active') {
      row.push({ text: `📣 General #${r.id}`, callback_data: `admin_general_publish:${r.id}` });
    }

    row.push({ text: `🏆 Завершить #${r.id}`, callback_data: `confirm_stop_raffle:${r.id}` });

    keyboard.push(row);
  }

  keyboard.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);

  return sendMessage(target, text, keyboard);
}

async function sendAdminBroadcastStart(target, userId) {
  if (!isAdmin(userId)) {
    return sendMessage(target, '⛔ Нет доступа.');
  }

  await setSession(userId, 'await_admin_broadcast_text', {});

  return sendMessage(
    target,
    [
      '📣 **Рассылка всем пользователям**',
      '',
      'Отправьте текст сообщения одним сообщением.',
      '',
      'Бот сначала покажет предпросмотр. Без подтверждения рассылка не начнётся.',
      '',
      'Внизу у пользователей будет кнопка **🏠 Меню**.',
      '',
      'Отмена: `/cancel`'
    ].join('\n')
  );
}

function buildAdminBroadcastPreviewText(text) {
  return [
    '📣 **Предпросмотр рассылки**',
    '',
    'Пользователи увидят:',
    '────────────',
    safeText(text, 3500),
    '────────────',
    '',
    'Нажмите **✅ Отправить всем**, если всё правильно.'
  ].join('\n');
}

function buildUserBroadcastKeyboard() {
  return [[{ text: '🏠 Меню', callback_data: 'main_menu' }]];
}

async function sendAdminBroadcastPreview(target, userId, text) {
  if (!isAdmin(userId)) {
    return sendMessage(target, '⛔ Нет доступа.');
  }

  const cleanText = safeText(text, 3500);

  if (!cleanText) {
    return sendMessage(target, 'Текст рассылки не может быть пустым. Отправьте текст ещё раз или `/cancel`.');
  }

  await setSession(userId, 'await_admin_broadcast_confirm', {
    text: cleanText
  });

  return sendMessage(
    target,
    buildAdminBroadcastPreviewText(cleanText),
    [
      [{ text: '✅ Отправить всем', callback_data: 'admin_broadcast_send' }],
      [{ text: '✏️ Изменить текст', callback_data: 'admin_broadcast' }],
      [{ text: '❌ Отмена', callback_data: 'admin_broadcast_cancel' }]
    ]
  );
}

async function handleAdminBroadcastText(message, data = {}) {
  const userId = message.from.id;
  const target = message.chat.id;

  if (!isAdmin(userId)) {
    await clearSession(userId);
    await sendMessage(target, '⛔ Нет доступа.');
    return true;
  }

  return sendAdminBroadcastPreview(target, userId, message.text || '');
}

async function createAdminBroadcastJob(target, adminUserId, text) {
  if (!isAdmin(adminUserId)) {
    return sendMessage(target, '⛔ Нет доступа.');
  }

  const cleanText = safeText(text, 3500);

  if (!cleanText) {
    return sendMessage(target, 'Текст рассылки пустой. Рассылка отменена.');
  }

  const client = await pool.connect();
  let job = null;
  let total = 0;

  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO users (max_user_id)
      VALUES ($1)
      ON CONFLICT (max_user_id) DO NOTHING
    `, [String(adminUserId)]);

    const jobRes = await client.query(`
      INSERT INTO admin_broadcast_jobs (admin_user_id, target_user_id, text, status, created_at, updated_at)
      VALUES ($1, $2, $3, 'pending', NOW(), NOW())
      RETURNING *
    `, [String(adminUserId), String(adminUserId), cleanText]);

    job = jobRes.rows[0];

    const recipientsRes = await client.query(`
      INSERT INTO admin_broadcast_recipients (job_id, user_id, status, created_at, updated_at)
      SELECT $1, max_user_id, 'pending', NOW(), NOW()
      FROM users
      WHERE max_user_id IS NOT NULL
        AND COALESCE(is_broadcast_available, true) = true
      ON CONFLICT (job_id, user_id) DO NOTHING
      RETURNING id
    `, [job.id]);

    total = recipientsRes.rowCount || 0;

    await client.query(`
      UPDATE admin_broadcast_jobs
      SET total_count = $2, updated_at = NOW()
      WHERE id = $1
    `, [job.id, total]);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await clearSession(adminUserId);

  await sendMessage(
    target,
    [
      '🚀 **Рассылка поставлена в очередь**',
      '',
      `ID рассылки: **${job.id}**`,
      `Получателей: **${total}**`,
      '',
      'Теперь отправкой занимается отдельный worker. Бот не будет зависать, даже если пользователей много.',
      `Пачка: **${ADMIN_BROADCAST_BATCH_SIZE}** пользователей за проход.`
    ].join('\n'),
    [[{ text: '👑 Админ-панель', callback_data: 'admin_panel' }]]
  );

  // Пытаемся сразу стартануть worker, но не ждём длинную отправку.
  processAdminBroadcastJobs().catch(error => {
    console.error('admin broadcast worker immediate error:', error.message);
  });

  return true;
}

async function refreshAdminBroadcastJobStats(jobId) {
  const res = await pool.query(`
    SELECT
      COUNT(*)::int AS total_count,
      COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_count,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
      COUNT(*) FILTER (WHERE status = 'unavailable')::int AS unavailable_count,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count
    FROM admin_broadcast_recipients
    WHERE job_id = $1
  `, [jobId]);

  const stats = res.rows[0] || {};

  await pool.query(`
    UPDATE admin_broadcast_jobs
    SET
      total_count = $2,
      sent_count = $3,
      failed_count = $4,
      unavailable_count = $5,
      updated_at = NOW()
    WHERE id = $1
  `, [
    jobId,
    Number(stats.total_count || 0),
    Number(stats.sent_count || 0),
    Number(stats.failed_count || 0),
    Number(stats.unavailable_count || 0)
  ]);

  return {
    total: Number(stats.total_count || 0),
    sent: Number(stats.sent_count || 0),
    failed: Number(stats.failed_count || 0),
    unavailable: Number(stats.unavailable_count || 0),
    pending: Number(stats.pending_count || 0)
  };
}

async function processAdminBroadcastJobs() {
  // Если сервис перезапустился посреди рассылки, возвращаем зависшие строки в очередь.
  await pool.query(`
    UPDATE admin_broadcast_recipients
    SET status = 'pending', updated_at = NOW()
    WHERE status = 'processing'
      AND updated_at < NOW() - INTERVAL '15 minutes'
  `);

  await pool.query(`
    UPDATE admin_broadcast_jobs
    SET status = 'pending', updated_at = NOW()
    WHERE status = 'processing'
      AND updated_at < NOW() - INTERVAL '15 minutes'
  `);

  const jobRes = await pool.query(`
    WITH picked AS (
      SELECT id
      FROM admin_broadcast_jobs
      WHERE status IN ('pending', 'processing')
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE admin_broadcast_jobs j
    SET
      status = 'processing',
      started_at = COALESCE(started_at, NOW()),
      updated_at = NOW()
    FROM picked
    WHERE j.id = picked.id
    RETURNING j.*
  `);

  const job = jobRes.rows[0];
  if (!job) return { processed: 0 };

  const recipientsRes = await pool.query(`
    WITH picked AS (
      SELECT id, user_id
      FROM admin_broadcast_recipients
      WHERE job_id = $1
        AND status = 'pending'
      ORDER BY id ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    UPDATE admin_broadcast_recipients r
    SET status = 'processing', updated_at = NOW()
    FROM picked
    WHERE r.id = picked.id
    RETURNING r.id, r.user_id
  `, [job.id, ADMIN_BROADCAST_BATCH_SIZE]);

  if (!recipientsRes.rows.length) {
    const stats = await refreshAdminBroadcastJobStats(job.id);

    await pool.query(`
      UPDATE admin_broadcast_jobs
      SET status = 'done', finished_at = COALESCE(finished_at, NOW()), updated_at = NOW()
      WHERE id = $1
    `, [job.id]);

    await sendMessage(
      job.target_user_id || job.admin_user_id,
      [
        '✅ **Рассылка завершена**',
        '',
        `ID: **${job.id}**`,
        `Отправлено: **${stats.sent}**`,
        `Недоступных: **${stats.unavailable}**`,
        `Ошибок: **${stats.failed}**`,
        '',
        'Пользователи с `dialog.not.found` автоматически исключены из следующих рассылок.'
      ].join('\n'),
      [[{ text: '👑 Админ-панель', callback_data: 'admin_panel' }]]
    ).catch(error => {
      console.warn('Не удалось отправить финальный отчёт рассылки админу:', error.message);
    });

    return { processed: 0, done: true };
  }

  for (const recipient of recipientsRes.rows) {
    const recipientId = String(recipient.user_id || '').trim();

    try {
      await sendMessage(recipientId, job.text, buildUserBroadcastKeyboard());
      await markUserBroadcastSuccess(recipientId).catch(() => {});

      await pool.query(`
        UPDATE admin_broadcast_recipients
        SET status = 'sent', sent_at = NOW(), error_text = NULL, updated_at = NOW()
        WHERE id = $1
      `, [recipient.id]);
    } catch (error) {
      const errorMessage = error?.message || String(error || 'unknown error');
      const unavailable = isBroadcastDialogUnavailableError(error);

      console.warn('Admin broadcast send failed:', {
        job_id: job.id,
        user_id: recipientId,
        error: errorMessage
      });

      if (unavailable) {
        await markUserBroadcastUnavailable(recipientId, errorMessage).catch(cleanupError => {
          console.warn('Failed to mark broadcast user unavailable:', {
            user_id: recipientId,
            error: cleanupError?.message || cleanupError
          });
        });
      }

      await pool.query(`
        UPDATE admin_broadcast_recipients
        SET status = $2, error_text = $3, updated_at = NOW()
        WHERE id = $1
      `, [recipient.id, unavailable ? 'unavailable' : 'failed', safeText(errorMessage, 500)]);
    }

    if (ADMIN_BROADCAST_SEND_DELAY_MS > 0) {
      await sleep(ADMIN_BROADCAST_SEND_DELAY_MS);
    }
  }

  const stats = await refreshAdminBroadcastJobStats(job.id);

  if (stats.pending <= 0) {
    await pool.query(`
      UPDATE admin_broadcast_jobs
      SET status = 'done', finished_at = COALESCE(finished_at, NOW()), updated_at = NOW()
      WHERE id = $1
    `, [job.id]);

    await sendMessage(
      job.target_user_id || job.admin_user_id,
      [
        '✅ **Рассылка завершена**',
        '',
        `ID: **${job.id}**`,
        `Отправлено: **${stats.sent}**`,
        `Недоступных: **${stats.unavailable}**`,
        `Ошибок: **${stats.failed}**`
      ].join('\n'),
      [[{ text: '👑 Админ-панель', callback_data: 'admin_panel' }]]
    ).catch(() => {});
  } else {
    console.log('📣 Рассылка: пачка отправлена', {
      job_id: job.id,
      sent: stats.sent,
      unavailable: stats.unavailable,
      failed: stats.failed,
      pending: stats.pending
    });
  }

  return { processed: recipientsRes.rows.length, done: stats.pending <= 0 };
}

async function sendAdminBroadcastToAll(target, adminUserId, text) {
  return createAdminBroadcastJob(target, adminUserId, text);
}

async function sendAdminBanHelp(target, userId) {
  if (!isAdmin(userId)) {
    return sendMessage(target, '⛔ Нет доступа.');
  }

  return sendMessage(
    target,
    [
      '⛔ **Баны пользователей**',
      '',
      'Команды:',
      '`/ban USER_ID` — бан на 60 минут',
      '`/ban USER_ID 15 причина` — бан на 15 минут с причиной',
      '`/unban USER_ID` — снять бан',
      '`/bans` — список активных банов',
      '',
      'Пример:',
      '`/ban 282278177 30 флуд кнопками`'
    ].join('\n')
  );
}

async function handleAdminBanCommand(target, adminUserId, text) {
  if (!isAdmin(adminUserId)) {
    return sendMessage(target, '⛔ Нет доступа.');
  }

  const parts = String(text || '').trim().split(/\s+/);
  const command = parts[0].toLowerCase();

  if (command === '/bans') {
    const res = await pool.query(`
      SELECT ub.*, u.username, u.first_name, u.last_name
      FROM user_bans ub
      LEFT JOIN users u ON u.max_user_id = ub.user_id
      WHERE ub.banned_until > NOW()
      ORDER BY ub.banned_until DESC
      LIMIT 30
    `);

    if (!res.rows.length) {
      return sendMessage(target, 'Активных банов нет.');
    }

    const lines = ['⛔ **Активные баны:**', ''];

    for (const row of res.rows) {
      const user = {
        user_id: row.user_id,
        max_user_id: row.user_id,
        username: row.username,
        first_name: row.first_name,
        last_name: row.last_name
      };

      lines.push(`• ${formatPublicUser(user)} — до ${formatBanUntil(row.banned_until)}`);
      lines.push(`  Причина: ${displayValue(row.reason, 'не указана')}`);
    }

    return sendMessage(target, lines.join('\n'));
  }

  if (command === '/unban') {
    const targetUserId = String(parts[1] || '').trim();

    if (!/^\d+$/.test(targetUserId)) {
      return sendMessage(target, 'Используйте: `/unban USER_ID`');
    }

    const count = await unbanUser(targetUserId);
    return sendMessage(target, count ? `✅ Бан пользователя ${targetUserId} снят.` : `Активный бан пользователя ${targetUserId} не найден.`);
  }

  if (command === '/ban') {
    const targetUserId = String(parts[1] || '').trim();

    if (!/^\d+$/.test(targetUserId)) {
      return sendMessage(target, 'Используйте: `/ban USER_ID 60 причина`');
    }

    if (isAdmin(targetUserId)) {
      return sendMessage(target, 'Нельзя забанить администратора бота.');
    }

    let minutes = 60;
    let reasonParts = parts.slice(2);

    if (parts[2] && /^\d+$/.test(parts[2])) {
      minutes = Math.max(1, Math.min(60 * 24 * 30, Number(parts[2])));
      reasonParts = parts.slice(3);
    }

    const reason = reasonParts.join(' ').trim() || 'ручной бан администратором';
    const ban = await banUser(targetUserId, minutes, reason, adminUserId);

    return sendMessage(
      target,
      [
        '✅ Пользователь заблокирован.',
        `ID: **${targetUserId}**`,
        `До: **${formatBanUntil(ban.banned_until)}**`,
        `Причина: ${reason}`
      ].join('\n')
    );
  }

  return sendAdminBanHelp(target, adminUserId);
}

// =========================
// Callback
// =========================
async function sendStopRaffleConfirmation(target, userId, raffleId) {
  const raffle = await getRaffleById(raffleId);

  if (!raffle) {
    return sendMessage(target, 'Розыгрыш не найден.');
  }

  if (Number(raffle.creator_user_id) !== Number(userId) && !isAdmin(userId)) {
    return sendMessage(target, '⛔ Завершить розыгрыш может только организатор или админ бота.');
  }

  if (!['scheduled', 'active'].includes(String(raffle.status || ''))) {
    return sendMessage(
      target,
      `Этот розыгрыш нельзя завершить сейчас. Текущий статус: ${formatRaffleStatus(raffle.status)}.`,
      buildCreatedRaffleKeyboard(raffle, userId)
    );
  }

  const text = [
    '⚠️ **Подтвердите досрочное завершение**',
    '',
    `Розыгрыш: **#${getRafflePublicNumber(raffle)} — ${displayValue(raffle.title, 'Без названия')}**`,
    `Статус: **${formatRaffleStatus(raffle.status)}**`,
    `Окончание по плану: **${formatDateTime(raffle.end_at)}**`,
    '',
    'Если нажать **Да**, бот завершит розыгрыш прямо сейчас и выберет победителей.',
    'Это действие нельзя отменить случайным повторным нажатием.'
  ].join('\n');

  return sendMessage(target, text, [
    [
      { text: '✅ Да, завершить сейчас', callback_data: `stop_raffle_confirmed:${raffle.id}` },
      { text: '❌ Нет, назад', callback_data: `refresh_raffle:${raffle.id}` }
    ],
    [{ text: '🔎 Мои розыгрыши', callback_data: 'my_raffles' }]
  ]);
}

async function sendMyRafflesMenu(target, userId) {
  await cleanupUserRafflesList(userId);

  const ownCountRes = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM raffles
    WHERE creator_user_id = $1
      AND COALESCE(is_hidden_from_my_raffles, false) = false
  `, [userId]);

  const collabCountRes = await pool.query(`
    SELECT COUNT(DISTINCT r.id)::int AS count
    FROM raffles r
    JOIN raffle_channels rc ON rc.raffle_id = r.id
    WHERE rc.owner_user_id::text = $1
      AND r.creator_user_id::text <> $1
  `, [String(userId || '').trim()]);

  const ownCount = Number(ownCountRes.rows[0]?.count || 0);
  const collabCount = Number(collabCountRes.rows[0]?.count || 0);

  return sendMessage(
    target,
    [
      '🔎 **Мои розыгрыши**',
      '',
      'Выберите раздел:',
      '',
      `• **Ваши розыгрыши:** ${ownCount}`,
      `• **Коллаборация:** ${collabCount}`,
      '',
      'В разделе **Коллаборация** показаны розыгрыши других организаторов, где ваши каналы участвуют как каналы соадмина.'
    ].join('\n'),
    [
      [{ text: '🎁 Ваши розыгрыши', callback_data: 'my_raffles_own' }],
      [{ text: '🤝 Коллаборация', callback_data: 'my_raffles_collab' }],
      [{ text: '🎉 Создать розыгрыш', callback_data: 'create_raffle' }],
      [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
    ]
  );
}

async function sendUserRaffles(target, userId) {
  const raffles = await getUserRaffles(userId);

  if (!raffles.length) {
    return sendMessage(
      target,
      'У вас пока нет своих розыгрышей.',
      [
        [{ text: '🎉 Создать розыгрыш', callback_data: 'create_raffle' }],
        [{ text: '⬅️ Назад', callback_data: 'my_raffles' }]
      ]
    );
  }

  let text = `🎁 **Ваши розыгрыши:**\n\n`;

  const keyboard = [];

  for (const r of raffles) {
    const title = displayValue(r.title, 'Без названия');
    const titleForLine = markdownLink(title, buildBotDeepLink(`myraffle_${r.id}`));

    text += `#${r.id} | ${titleForLine} | ${formatRaffleStatus(r.status)} | до ${formatDateTime(r.end_at)}\n\n`;

    const row = [
      { text: `📊 #${r.id}`, callback_data: `raffle_stats:${r.id}` }
    ];

    if (r.status === 'scheduled') {
      row.push({ text: `🚀 Сейчас #${r.id}`, callback_data: `start_raffle_now:${r.id}` });
      row.push({ text: `✏️ #${r.id}`, callback_data: `edit_raffle:${r.id}` });
      row.push({ text: `⏹ Стоп #${r.id}`, callback_data: `confirm_stop_raffle:${r.id}` });
    } else if (r.status === 'active') {
      row.push({ text: `⏹ Стоп #${r.id}`, callback_data: `confirm_stop_raffle:${r.id}` });
    } else if (r.status === 'finished') {
      row.push({ text: `🔁 Переиграть #${r.id}`, callback_data: `reroll_winners:${r.id}` });
    }

    keyboard.push(row);
  }

  keyboard.push([{ text: '🎉 Создать розыгрыш', callback_data: 'create_raffle' }]);
  keyboard.push([{ text: '⬅️ Назад к разделам', callback_data: 'my_raffles' }]);
  keyboard.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);

  return sendMessage(target, text, keyboard);
}

async function sendUserCollaborationRaffles(target, userId) {
  const raffles = await getUserCollaborationRaffles(userId);

  if (!raffles.length) {
    return sendMessage(
      target,
      [
        '🤝 **Коллаборация**',
        '',
        'Пока нет розыгрышей, где ваши каналы участвуют как каналы соадмина.',
        '',
        'Когда другой организатор даст вам ссылку соадмина, вы добавите свой канал — такой розыгрыш появится здесь.'
      ].join('\n'),
      [
        [{ text: '⬅️ Назад', callback_data: 'my_raffles' }],
        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
      ]
    );
  }

  let text = `🤝 **Коллаборация:**\n\n`;
  text += 'Здесь розыгрыши других организаторов, где участвуют ваши каналы.\n\n';

  const keyboard = [];

  for (const r of raffles) {
    const title = displayValue(r.title, 'Без названия');
    const titleForLine = markdownLink(title, buildBotDeepLink(`myraffle_${r.id}`));
    const channelsCount = Number(r.collab_channels_count || 0);
    const channelsText = displayValue(r.collab_channels_titles, 'канал не указан');

    text += `#${r.id} | ${titleForLine} | ${formatRaffleStatus(r.status)} | до ${formatDateTime(r.end_at)}\n`;
    text += `Ваших каналов в розыгрыше: **${channelsCount}** — ${channelsText}\n\n`;

    const row = [
      { text: `📊 #${r.id}`, callback_data: `raffle_stats:${r.id}` },
      { text: `🔄 #${r.id}`, callback_data: `refresh_raffle:${r.id}` }
    ];

    keyboard.push(row);
  }

  keyboard.push([{ text: '⬅️ Назад к разделам', callback_data: 'my_raffles' }]);
  keyboard.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);

  return sendMessage(target, text, keyboard);
}
async function handleCallbackQuery(cb) {
  const userId = cb.from.id;
  const target = cb.message.chat.id;
  const data = cb.data;

  if (data === 'legal_accept') {
    await acceptLegal(userId);
    await answerMaxCallback(cb.id, '✅ Условия приняты');
    await deleteMaxMessageSafe(target, cb.message.id);

    const session = await getSession(userId);
    const sessionData = typeof session?.data === 'string'
      ? JSON.parse(session.data || '{}')
      : session?.data || {};
    const pendingPayload = String(sessionData.start_payload || '').trim();

    if (session?.state === 'await_legal_acceptance') {
      await clearSession(userId);
    }

    if (pendingPayload && await handleStartPayload(target, cb.from, pendingPayload)) {
      return;
    }

    await sendWelcome(target, cb.from);
    await sendMainMenu(target, userId);
    return;
  }

  if (!(await hasAcceptedLegal(userId))) {
    await sendLegalAcceptance(target);
    return;
  }

  if (data === 'main_menu') {
    await sendMainMenu(target, userId);
    return;
  }

  if (data === 'cancel_session') {
    await clearSession(userId);
    await sendMessage(target, 'Действие отменено.');
    await sendMainMenu(target, userId);
    return;
  }

  if (await apostModule.handleCallback(cb)) {
    return;
  }

  if (data === 'add_channel') {
    const session = await getSession(userId);
    const fromChannelSelection = session && ['await_channel_selection', 'collab_channel_selection'].includes(session.state);

    await sendAddChannelInstruction(target, {
      fromChannelSelection,
      mode: session?.state === 'collab_channel_selection' ? 'collab' : 'create'
    });
    return;
  }

  if (data === 'back_to_raffle_channels' || data === 'back_to_collab_channels') {
    const session = await getSession(userId);
    const expectedState = data === 'back_to_collab_channels'
      ? 'collab_channel_selection'
      : 'await_channel_selection';

    if (!session || session.state !== expectedState) {
      await sendMessage(target, 'Сейчас выбор каналов не активен.');
      return;
    }

    await discoverUserChannelsForUser(userId).catch(error => {
      console.warn('Не удалось тихо обновить каналы при возврате к выбору:', error.message);
    });

    const sessionData = typeof session.data === 'string'
      ? JSON.parse(session.data || '{}')
      : session.data || {};

    await sendChannelSelectionMenu(
      target,
      userId,
      sessionData,
      expectedState === 'collab_channel_selection' ? 'collab' : 'create',
      { editMessageId: cb.message.id, sessionState: expectedState }
    );
    return;
  }

  if (data === 'my_channels') {
    await sendMyChannels(target, userId);
    return;
  }

  if (data === 'refresh_channels') {
    await refreshUserChannels(target, userId, { editMessageId: cb.message.id });
    return;
  }

  if (data === 'create_raffle') {
    await setSession(userId, 'await_title', {});
    await sendMessage(target, buildRaffleTitlePrompt());
    return;
  }

  if (data === 'my_raffles') {
    await sendMyRafflesMenu(target, userId);
    return;
  }

  if (data === 'my_raffles_own') {
    await sendUserRaffles(target, userId);
    return;
  }

  if (data === 'my_raffles_collab') {
    await sendUserCollaborationRaffles(target, userId);
    return;
  }

  if (data === 'admin_ban_help') {
    await sendAdminBanHelp(target, userId);
    return;
  }

  if (data.startsWith('promo_offer:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await sendPromotionOffer(target, userId, raffleId);
    return;
  }

  if (data.startsWith('promo_buy:')) {
    const [, raffleIdRaw, product] = data.split(':');
    const raffleId = Number(raffleIdRaw);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await startPromotionPaymentEmailFlow(target, userId, raffleId, product);
    return;
  }

  if (data.startsWith('refresh_raffle:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await sendRaffleRefresh(target, userId, raffleId);
    return;
  }

  if (data.startsWith('close_collab_link:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await closeCollabInviteLink(target, userId, raffleId);
    return;
  }

  if (data.startsWith('start_raffle_now:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await startRaffleNow(target, userId, raffleId);
    return;
  }

  if (data.startsWith('preview_raffle:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await sendRafflePostPreview(target, userId, raffleId);
    return;
  }

  if (data.startsWith('edit_raffle:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await loadRaffleToEditSession(target, userId, raffleId);
    return;
  }

  if (data.startsWith('confirm_stop_raffle:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await sendStopRaffleConfirmation(target, userId, raffleId);
    return;
  }

  // Старые сообщения с кнопкой stop_raffle могли остаться у пользователей.
  // Теперь даже они сначала открывают подтверждение, а не завершают розыгрыш сразу.
  if (data.startsWith('stop_raffle:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await sendStopRaffleConfirmation(target, userId, raffleId);
    return;
  }

  if (data.startsWith('stop_raffle_confirmed:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await stopRaffleNow(target, userId, raffleId);
    return;
  }

  if (data.startsWith('reroll_winners:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await rerollRaffleWinners(target, userId, raffleId);
    return;
  }

  if (data.startsWith('quick_publish:')) {
    const session = await getSession(userId);

    if (!session || !['await_publish_date', 'edit_publish_date'].includes(session.state)) {
      await sendMessage(target, 'Сейчас выбор времени публикации не активен.');
      return;
    }

    const sessionData = typeof session.data === 'string'
      ? JSON.parse(session.data || '{}')
      : session.data || {};
    const offset = data.split(':')[1] || `${MIN_RAFFLE_PUBLISH_DELAY_MINUTES}m`;
    const publishAt = applyQuickOffset(botNow(), offset);
    const minPublishAt = getMinPublishAt();
    sessionData.publish_at = (publishAt.isBefore(minPublishAt) ? minPublishAt : publishAt).toISOString();

    if (session.state === 'edit_publish_date') {
      const minEndAt = getMinEndAtForPublish(sessionData.publish_at);
      const currentEndAt = toUtcMoment(sessionData.end_at);

      if (!currentEndAt || currentEndAt.isBefore(minEndAt)) {
        sessionData.end_at = null;
        await setSession(userId, 'await_end_date', sessionData);
        await sendMessage(target, 'Публикация изменена. Теперь выберите новое время окончания.');
        await sendEndDatePrompt(target, sessionData);
        return;
      }

      await sendRaffleDraftPreview(target, userId, sessionData);
      return;
    }

    await setSession(userId, 'await_end_date', sessionData);
    await sendEndDatePrompt(target, sessionData);
    return;
  }

  if (data.startsWith('quick_end:')) {
    const session = await getSession(userId);

    if (!session || !['await_end_date', 'edit_end_date'].includes(session.state)) {
      await sendMessage(target, 'Сейчас выбор времени окончания не активен.');
      return;
    }

    const sessionData = typeof session.data === 'string'
      ? JSON.parse(session.data || '{}')
      : session.data || {};
    const offset = data.split(':')[1] || `${MIN_RAFFLE_DURATION_AFTER_PUBLISH_MINUTES}m`;
    const publishAt = sessionData.publish_at || getMinPublishAt().toISOString();
    const endAt = applyQuickOffset(publishAt, offset);
    const minEndAt = getMinEndAtForPublish(publishAt);
    sessionData.end_at = (endAt.isBefore(minEndAt) ? minEndAt : endAt).toISOString();

    if (session.state === 'edit_end_date') {
      await sendRaffleDraftPreview(target, userId, sessionData);
      return;
    }

    sessionData.channels = Array.isArray(sessionData.channels) ? sessionData.channels : [];
    await setSession(userId, 'await_channel_selection', sessionData);
    await sendChannelSelectionMenu(target, userId, sessionData, 'create');
    return;
  }

  if (data.startsWith('raffle_ch_toggle:')) {
    const channelId = unsafeCallbackPart(data.split(':')[1] || '');
    const result = await toggleSessionChannel(userId, channelId);

    if (!result || result.missing) {
      await sendMessage(target, 'Канал не найден в разделе «Мои каналы».');
      return;
    }

    await sendChannelSelectionMenu(target, userId, result.data, 'create', { editMessageId: cb.message.id });
    return;
  }

  if (data.startsWith('raffle_ch_req:')) {
    const channelId = unsafeCallbackPart(data.split(':')[1] || '');
    const result = await toggleSessionChannelFlag(userId, channelId, 'is_required');

    if (!result || result.missing) {
      await sendMessage(target, 'Сначала выберите канал.');
      return;
    }

    await sendChannelSelectionMenu(target, userId, result.data, 'create', { editMessageId: cb.message.id });
    return;
  }

  if (data.startsWith('raffle_ch_pub:')) {
    const channelId = unsafeCallbackPart(data.split(':')[1] || '');
    const result = await toggleSessionChannelFlag(userId, channelId, 'publish_post');

    if (!result || result.missing) {
      await sendMessage(target, 'Сначала выберите канал.');
      return;
    }

    await sendChannelSelectionMenu(target, userId, result.data, 'create', { editMessageId: cb.message.id });
    return;
  }

  if (data === 'raffle_channels_done') {
    const session = await getSession(userId);

    if (!session || session.state !== 'await_channel_selection') {
      await sendMessage(target, 'Сначала начните создание розыгрыша.');
      return;
    }

    const sessionData = typeof session.data === 'string'
      ? JSON.parse(session.data || '{}')
      : session.data || {};

    const pruneResult = await pruneUnavailableSessionChannels(userId, sessionData, 'await_channel_selection');
    if (pruneResult.removed > 0) {
      await sendChannelSelectionMenu(target, userId, sessionData, 'create', {
        editMessageId: cb.message.id,
        sessionState: 'await_channel_selection',
        persistPruned: false
      });
      return;
    }

    await sendRaffleDraftPreview(target, userId, sessionData);
    return;
  }

  if (data === 'raffle_confirm_update') {
    const session = await getSession(userId);

    if (!session || session.state !== 'await_final_preview') {
      await sendMessage(target, 'Сначала откройте редактирование розыгрыша.');
      return;
    }

    const sessionData = typeof session.data === 'string'
      ? JSON.parse(session.data || '{}')
      : session.data || {};

    const minPublishAt = getMinPublishAt();
    const publishAt = toUtcMoment(sessionData.publish_at);

    if (!publishAt || publishAt.isBefore(minPublishAt)) {
      await setSession(userId, 'await_publish_date', sessionData);
      await sendMessage(target, 'Время публикации устарело или указано неверно. Выберите публикацию заново.');
      await sendPublishDatePrompt(target, sessionData);
      return;
    }

    const minEndAt = getMinEndAtForPublish(sessionData.publish_at);
    const endAt = toUtcMoment(sessionData.end_at);

    if (!endAt || endAt.isBefore(minEndAt)) {
      await setSession(userId, 'await_end_date', sessionData);
      await sendMessage(target, 'Время окончания указано неверно. Выберите окончание заново.');
      await sendEndDatePrompt(target, sessionData);
      return;
    }

    await saveEditedRaffleFromSession(target, userId, sessionData);
    return;
  }

  if (data === 'raffle_confirm_create' || data === 'raffle_confirm_create_collab') {
    const session = await getSession(userId);

    if (!session || session.state !== 'await_final_preview') {
      await sendMessage(target, 'Сначала проверьте шаблон розыгрыша.');
      return;
    }

    const sessionData = typeof session.data === 'string'
      ? JSON.parse(session.data || '{}')
      : session.data || {};

    const minPublishAt = getMinPublishAt();
    const publishAt = toUtcMoment(sessionData.publish_at);

    if (!publishAt || publishAt.isBefore(minPublishAt)) {
      await setSession(userId, 'await_publish_date', sessionData);
      await sendMessage(target, 'Время публикации устарело или указано неверно. Выберите публикацию заново.');
      await sendPublishDatePrompt(target, sessionData);
      return;
    }

    const minEndAt = getMinEndAtForPublish(sessionData.publish_at);
    const endAt = toUtcMoment(sessionData.end_at);

    if (!endAt || endAt.isBefore(minEndAt)) {
      await setSession(userId, 'await_end_date', sessionData);
      await sendMessage(target, 'Время окончания указано неверно. Выберите окончание заново.');
      await sendEndDatePrompt(target, sessionData);
      return;
    }

    await createRaffleAndSendCreatedMessage(target, userId, sessionData);
    return;
  }

  if (data === 'draft_edit_title') {
    const session = await getSession(userId);
    const sessionData = typeof session?.data === 'string' ? JSON.parse(session.data || '{}') : session?.data || {};
    await setSession(userId, 'edit_title', sessionData);
    await sendMessage(target, 'Введите новое название розыгрыша:');
    return;
  }

  if (data === 'draft_edit_description') {
    const session = await getSession(userId);
    const sessionData = typeof session?.data === 'string' ? JSON.parse(session.data || '{}') : session?.data || {};
    await setSession(userId, 'edit_description', sessionData);
    await sendMessage(target, 'Введите новое описание розыгрыша:');
    return;
  }

  if (data === 'draft_edit_prizes') {
    const session = await getSession(userId);
    const sessionData = typeof session?.data === 'string' ? JSON.parse(session.data || '{}') : session?.data || {};
    await setSession(userId, 'edit_prizes', sessionData);
    await sendMessage(target, 'Введите новый список призов, каждый с новой строки:');
    return;
  }

  if (data === 'draft_edit_publish_at') {
    const session = await getSession(userId);
    const sessionData = typeof session?.data === 'string' ? JSON.parse(session.data || '{}') : session?.data || {};
    await setSession(userId, 'edit_publish_date', sessionData);
    await sendPublishDatePrompt(target, sessionData);
    return;
  }

  if (data === 'draft_edit_end_at') {
    const session = await getSession(userId);
    const sessionData = typeof session?.data === 'string' ? JSON.parse(session.data || '{}') : session?.data || {};
    await setSession(userId, 'edit_end_date', sessionData);
    await sendEndDatePrompt(target, sessionData);
    return;
  }


  if (data === 'draft_edit_photo') {
    const session = await getSession(userId);
    const sessionData = typeof session?.data === 'string' ? JSON.parse(session.data || '{}') : session?.data || {};
    await setSession(userId, 'edit_photo', sessionData);
    await sendMessage(target, 'Отправьте фото, которое нужно прикрепить к посту розыгрыша.');
    return;
  }

  if (data === 'draft_remove_photo') {
    const session = await getSession(userId);
    const sessionData = typeof session?.data === 'string' ? JSON.parse(session.data || '{}') : session?.data || {};
    delete sessionData.photo_attachment;
    await sendRaffleDraftPreview(target, userId, sessionData);
    return;
  }

  if (data === 'draft_edit_channels') {
    const session = await getSession(userId);
    const sessionData = typeof session?.data === 'string' ? JSON.parse(session.data || '{}') : session?.data || {};
    sessionData.channels = Array.isArray(sessionData.channels) ? sessionData.channels : [];
    await setSession(userId, 'await_channel_selection', sessionData);
    await sendChannelSelectionMenu(target, userId, sessionData, 'create');
    return;
  }

  if (data.startsWith('collab_ch_toggle:')) {
    const channelId = unsafeCallbackPart(data.split(':')[1] || '');
    const result = await toggleSessionChannel(userId, channelId);

    if (!result || result.missing) {
      await sendMessage(target, 'Канал не найден в разделе «Мои каналы».');
      return;
    }

    await sendChannelSelectionMenu(target, userId, result.data, 'collab', { editMessageId: cb.message.id });
    return;
  }

  if (data.startsWith('collab_ch_req:')) {
    const channelId = unsafeCallbackPart(data.split(':')[1] || '');
    const result = await toggleSessionChannelFlag(userId, channelId, 'is_required');

    if (!result || result.missing) {
      await sendMessage(target, 'Сначала выберите канал.');
      return;
    }

    await sendChannelSelectionMenu(target, userId, result.data, 'collab', { editMessageId: cb.message.id });
    return;
  }

  if (data.startsWith('collab_ch_pub:')) {
    const channelId = unsafeCallbackPart(data.split(':')[1] || '');
    const result = await toggleSessionChannelFlag(userId, channelId, 'publish_post');

    if (!result || result.missing) {
      await sendMessage(target, 'Сначала выберите канал.');
      return;
    }

    await sendChannelSelectionMenu(target, userId, result.data, 'collab', { editMessageId: cb.message.id });
    return;
  }

  if (data === 'collab_channels_done') {
    const session = await getSession(userId);

    if (!session || session.state !== 'collab_channel_selection') {
      await sendMessage(target, 'Ссылка совместного розыгрыша не активна. Откройте приглашение ещё раз.');
      return;
    }

    const sessionData = typeof session.data === 'string'
      ? JSON.parse(session.data || '{}')
      : session.data || {};

    await addCollabChannelsFromSession(target, userId, sessionData);
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

    await showJoinRaffleStart(target, userId, raffleId, null);
    return;
  }

  if (data.startsWith('check_join:')) {
    const parts = data.split(':');
    const raffleId = Number(parts[1]);
    const ref = parts[2] ? Number(parts[2]) : null;
    const realUserId = String(cb?.from?.id || userId || '').trim();
    const userTarget = realUserId ? { type: 'user_id', id: realUserId } : target;

    if (!Number.isInteger(raffleId)) {
      await answerMaxCallback(cb.id, 'Некорректный ID розыгрыша.');
      await sendMessage(userTarget, 'Некорректный ID розыгрыша.');
      return;
    }

    await answerMaxCallback(cb.id, '🔎 Проверяю подписку...');
    await sendMessage(userTarget, '🔎 Проверяю подписку на каналы розыгрыша. Это может занять несколько секунд...');
    await completeJoinRaffleAfterCheck(userTarget, realUserId || userId, raffleId, ref);
    return;
  }

  if (data.startsWith('raffle_stats:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await sendRaffleStats(target, raffleId, userId);
    return;
  }

  // Старые админские сообщения с pick_raffle тоже больше не завершают сразу.
  if (data.startsWith('pick_raffle:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await sendStopRaffleConfirmation(target, userId, raffleId);
    return;
  }

  if (data === 'stats_global') {
    // Старые сообщения с этой кнопкой могли остаться у пользователей.
    // Общую статистику больше не показываем в пользовательском меню:
    // она доступна только через админ-панель.
    if (!isAdmin(userId)) {
      await sendMessage(target, '⛔ Общая статистика доступна только в админ-панели.');
      return;
    }

    await sendAdminStats(target, userId);
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

  if (data === 'admin_broadcast') {
    await sendAdminBroadcastStart(target, userId);
    return;
  }

  if (data === 'admin_broadcast_cancel') {
    if (!isAdmin(userId)) {
      await sendMessage(target, '⛔ Нет доступа.');
      return;
    }

    await clearSession(userId);
    await sendMessage(target, 'Рассылка отменена.');
    await sendAdminPanel(target, userId);
    return;
  }

  if (data === 'admin_broadcast_send') {
    if (!isAdmin(userId)) {
      await sendMessage(target, '⛔ Нет доступа.');
      return;
    }

    const session = await getSession(userId);
    const sessionData = typeof session?.data === 'string'
      ? JSON.parse(session.data || '{}')
      : session?.data || {};

    if (session?.state !== 'await_admin_broadcast_confirm' || !sessionData.text) {
      await sendMessage(target, 'Текст рассылки не найден. Нажмите “Рассылка” ещё раз.');
      await sendAdminPanel(target, userId);
      return;
    }

    await sendAdminBroadcastToAll(target, userId, sessionData.text);
    return;
  }

  if (data.startsWith('admin_general_publish:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await adminScheduleGeneralPublish(target, userId, raffleId);
    return;
  }

  await sendMessage(target, 'Неизвестная кнопка.');
}


async function autoSaveCallbackProfileLink(update, userId) {
  // Оставлено как совместимый no-op: раньше здесь ошибочно сохранялась ссылка из callback_id.
  // По документации MAX для кликабельного имени нужна не https-ссылка, а mention:
  // [Имя Фамилия](max://user/user_id).
  return null;
}

async function handleStartPayload(target, from, payload) {
  const text = String(payload || '').trim();

  if (!text) return false;

  const normalized = text.replace(/^start[=:]/i, '').trim();

  if (normalized.startsWith('collab_')) {
    const token = normalized.replace(/^collab_/, '').trim();

    if (token) {
      await startCollabFlow(target, from.id, token);
      return true;
    }
  }

  if (normalized.startsWith('join_')) {
    const { raffleId, ref, sourceChannelId } = parseJoinPayloadParts(normalized);

    if (Number.isInteger(raffleId)) {
      await showJoinRaffleStart(target, from.id, raffleId, ref, sourceChannelId);
      return true;
    }
  }

  if (normalized.startsWith('myraffle_')) {
    const raffleId = Number(normalized.replace(/^myraffle_/, '').trim());

    if (Number.isInteger(raffleId)) {
      await sendRaffleRefresh(target, from.id, raffleId);
      return true;
    }
  }

  return false;
}


function detectChannelMemberDelta(update) {
  const updateType = String(update?.update_type || '').toLowerCase();

  if (isBotAddedOrUpdatedUpdate(update) || isBotRemovedUpdate(update)) return null;

  const plusWords = [
    'member_added',
    'member_joined',
    'user_joined',
    'subscriber_added',
    'subscriber_joined',
    'chat_member_added',
    'participant_added',
    'joined'
  ];

  const minusWords = [
    'member_removed',
    'member_left',
    'user_removed',
    'user_left',
    'subscriber_removed',
    'subscriber_left',
    'chat_member_removed',
    'participant_removed',
    'left',
    'kicked'
  ];

  if (plusWords.some(word => updateType.includes(word))) return 1;
  if (minusWords.some(word => updateType.includes(word))) return -1;

  return null;
}

function extractEventDateFromUpdate(update) {
  const ts = Number(update?.timestamp || update?.message?.timestamp || update?.callback?.timestamp || 0);

  if (Number.isFinite(ts) && ts > 0) {
    const ms = ts > 10_000_000_000 ? ts : ts * 1000;
    const date = new Date(ms);

    if (!Number.isNaN(date.getTime())) return date;
  }

  return new Date();
}

async function recordChannelMemberEventFromUpdate(update, target) {
  if (!isChannelTarget(target)) return;

  const delta = detectChannelMemberDelta(update);
  if (!delta) return;

  const userId = getActorUserIdFromUpdate(update);
  if (!userId) return;

  if (BOT_USER_ID && String(userId) === String(BOT_USER_ID)) return;

  await pool.query(`
    INSERT INTO channel_member_events (
      channel_id,
      user_id,
      event_type,
      delta,
      source_update_type,
      raw_payload,
      event_at
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
  `, [
    target.id,
    userId,
    delta > 0 ? 'join' : 'leave',
    delta,
    safeText(update?.update_type || '', 100),
    JSON.stringify(makeUpdatePreview(update)),
    extractEventDateFromUpdate(update)
  ]).catch(error => {
    console.warn('Не удалось записать событие статистики канала:', error.message);
  });
}

// =========================
// MAX update handler
// =========================
async function handleMaxUpdate(update) {
  try {
    // Полностью молчим по чужим редактируемым розыгрышам, чтобы Render logs не забивались.
    // Включить обратно: SHOW_FOREIGN_RAFFLE_EDIT_UPDATES=true
    if (shouldSkipForeignRaffleEditedUpdate(update)) {
      return;
    }

    console.log('🔎 handleMaxUpdate:', {
      update_type: update?.update_type,
      chat_id: update?.chat_id,
      text: update?.message?.body?.text,
      payload: typeof update?.payload === 'string' ? update.payload : undefined,
      callbackPayload: update?.callback?.payload,
      sender: update?.message?.sender?.user_id,
      callbackUser: update?.callback?.user?.user_id,
      user: update?.user?.user_id
    });

    if (DEBUG_MAX_FULL_UPDATES) {
      console.log('📦 FULL MAX UPDATE:', JSON.stringify(update || {}).slice(0, 12000));
    }

    await rememberSeenChatsFromUpdate(update);

    const updateType = update?.update_type;
    const target = getReplyTarget(update);
    const userId = getStableUserId(update, target);

    if (!target) {
      console.warn('MAX update without target:', JSON.stringify(update).slice(0, 3000));
      return;
    }

    await recordChannelMemberEventFromUpdate(update, target);
    await recordRaffleMemberDeltaFromWebhook(update, target);

    if (!userId && ['bot_started', 'message_created', 'message_callback'].includes(updateType)) {
      console.warn('MAX update without user:', JSON.stringify(update).slice(0, 3000));
      return;
    }

    if (isBotRemovedUpdate(update)) {
      await handleBotRemovedFromChannel(update, target);
      return;
    }

    if (updateType === 'bot_started') {
      const from = getUserFromMaxUpdate(update, target);
      const payload = getIncomingText(update);

      await ensureUser(from);
      await autoSaveCallbackProfileLink(update, from.id);

      if (!(await hasAcceptedLegal(from.id))) {
        await setSession(from.id, 'await_legal_acceptance', {
          start_payload: String(payload || '').trim()
        });
        await sendLegalAcceptance(target);
        return;
      }

      if (await handleStartPayload(target, from, payload)) {
        return;
      }

      await sendWelcome(target, from);
      await sendMainMenu(target, from.id);

      return;
    }

    if (isChatTarget(target) && !['message_created', 'message_callback'].includes(updateType)) {
      const from = getUserFromMaxUpdate(update, target);

      if (!from.id) {
        console.log('👀 Channel event saved as seen chat, but actor user is unknown. Waiting for refresh/check from user.');
        return;
      }

      await ensureUser(from);
      const autoRegister = await tryAutoRegisterChannelFromUpdate(update, target, from);

      if (autoRegister.ok) {
        await sendMessage(
          from.id,
          [
            '✅ Канал автоматически добавлен в раздел **Мои каналы**:',
            formatChannelWithLink(autoRegister.channel),
            '',
            'Бот получил событие MAX о добавлении в канал. Канал доступен для выбора при создании розыгрыша.',
            'Если при публикации MAX вернёт ошибку прав, проверьте права бота на размещение постов.'
          ].join('\n'),
          [
            [{ text: '📢 Мои каналы', callback_data: 'my_channels' }],
            [{ text: '🎉 Создать розыгрыш', callback_data: 'create_raffle' }]
          ]
        ).catch(error => {
          console.warn('Не удалось отправить авто-подтверждение пользователю:', error.message);
        });
      }

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

      await ensureUser(cb.from);

      const floodCheck = await checkFloodOrBan(cb.from.id, cb.message.chat.id, {
        action: `callback:${String(cb.data || '').split(':')[0]}`,
        callbackId
      });

      if (floodCheck.blocked) {
        return;
      }

      await autoSaveCallbackProfileLink(update, cb.from.id);
      await handleCallbackQuery(cb);

      return;
    }

    if (updateType !== 'message_created') return;

    const message = normalizeMaxMessage(update);

    if (!message) {
      console.warn('Cannot normalize MAX message:', JSON.stringify(update));
      return;
    }

    const from = message.from;
    const chatTarget = message.chat.id;
    const text = message.text || '';

    await ensureUser(from);

    const lowerText = text.trim().toLowerCase();

    if (!(await hasAcceptedLegal(from.id))) {
      if (lowerText === '/start' || lowerText === 'старт') {
        await setSession(from.id, 'await_legal_acceptance', {
          start_payload: ''
        });
      }

      await sendLegalAcceptance(chatTarget);
      return;
    }

    const floodCheck = await checkFloodOrBan(from.id, chatTarget, {
      action: lowerText.startsWith('/') ? lowerText.split(/\s+/)[0] : 'message'
    });

    if (floodCheck.blocked) {
      return;
    }

    if (isChatTarget(chatTarget)) {
      const autoRegister = await tryAutoRegisterChannelFromUpdate(update, chatTarget, from);

      if (['подключить канал', 'добавить канал', 'connect channel'].includes(lowerText)) {
        if (!autoRegister.ok) {
          const reasonText = autoRegister.reason === 'bot_cannot_publish'
            ? 'Бот видит канал, но не смог подтвердить право на публикацию постов. Проверьте права администратора.'
            : 'Не удалось подтвердить, что вы администратор канала и что бот может публиковать посты.';

          await sendMessage(chatTarget, `⚠️ ${reasonText}`).catch(() => {});
          return;
        }

        await sendMessage(
          chatTarget,
          [
            `✅ Канал **${formatChannelName(autoRegister.channel)}** подключён к боту.`,
            '',
            'Теперь его можно выбрать при создании розыгрыша: с обязательной подпиской, с размещением поста или без размещения.'
          ].join('\n')
        ).catch(error => {
          console.warn('Не удалось отправить подтверждение в канал:', error.message);
        });

        await sendMessage(
          from.id,
          [
            '✅ Канал добавлен в раздел **Мои каналы**:',
            formatChannelWithLink(autoRegister.channel)
          ].join('\n'),
          [
            [{ text: '📢 Мои каналы', callback_data: 'my_channels' }],
            [{ text: '🎉 Создать розыгрыш', callback_data: 'create_raffle' }]
          ]
        ).catch(error => {
          console.warn('Не удалось отправить подтверждение пользователю:', error.message);
        });

        return;
      }

      if (autoRegister.ok) {
        console.log('✅ Канал автоматически привязан без команды:', {
          userId: from.id,
          channelId: chatTarget.id,
          title: formatChannelName(autoRegister.channel)
        });
      }
    }

    if (!isChatTarget(chatTarget) && ['добавить канал', 'каналы', 'мои каналы'].includes(lowerText)) {
      if (lowerText === 'мои каналы' || lowerText === 'каналы') {
        await sendMyChannels(chatTarget, from.id);
      } else {
        await sendAddChannelInstruction(chatTarget);
      }

      return;
    }

    if (await apostModule.handleMessage(message)) {
      return;
    }

    const profileCommandValue = extractProfileLinkCommand(text);
    const directProfileLinkValue = normalizeMaxProfileLink(text);

    if (profileCommandValue !== null || directProfileLinkValue) {
      const link = normalizeMaxProfileLink(profileCommandValue !== null ? profileCommandValue : text);

      if (!link) {
        await sendMessage(
          chatTarget,
          [
            'Не вижу корректную ссылку профиля MAX.',
            '',
            'Пример:',
            '`/profile https://max.ru/u/f9LHodD0cOK...`'
          ].join('\n')
        );
        return;
      }

      await setUserProfileLink(from.id, link);
      await sendMessage(
        chatTarget,
        [
          '✅ Ссылка профиля сохранена.',
          '',
          `Теперь в итогах розыгрыша ваше имя будет ссылкой: ${markdownLink(buildUserDisplayName({ ...from, profile_link: link }), link)}`
        ].join('\n')
      );
      return;
    }


    if (text === '/sos' || text === '/sos❓' || text.toLowerCase() === 'sos') {
      await sendSosMessage(chatTarget);
      return;
    }

    if (text === '/channels' || text === '/mychannels') {
      await sendMyChannels(chatTarget, from.id);
      return;
    }

    if (text === '/collab' || text.startsWith('/collab ') || text.startsWith('/collab_')) {
      const token = text.startsWith('/collab_')
        ? text.replace('/collab_', '').trim()
        : text.replace('/collab', '').trim();

      if (!token) {
        await sendMessage(
          chatTarget,
          [
            'Введите код соадмина.',
            '',
            'Пример:',
            '`/collab abc123xyz`',
            '',
            'Код находится в конце ссылки после `/collab/`.'
          ].join('\n')
        );
        return;
      }

      await startCollabFlow(chatTarget, from.id, token);
      return;
    }

    const handledBySession = await handleSessionMessage(message);

    if (handledBySession) return;

    if (text === '/cancel' || text.toLowerCase() === 'отмена' || text.toLowerCase() === 'cancel') {
      await clearSession(from.id);
      await sendMessage(chatTarget, 'Действие отменено.');
      await sendMainMenu(chatTarget, from.id);
      return;
    }

    if (text === '/start' || text.toLowerCase() === 'старт') {
      await sendWelcome(chatTarget, from);
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


    if (text === '/broadcast' || text === '/рассылка' || text.startsWith('/broadcast ') || text.startsWith('/рассылка ')) {
      if (!isAdmin(from.id)) {
        await sendMessage(chatTarget, '⛔ Нет доступа.');
        return;
      }

      const rawText = text
        .replace(/^\/(?:broadcast|рассылка)\s*/i, '')
        .trim();

      if (rawText) {
        await sendAdminBroadcastPreview(chatTarget, from.id, rawText);
      } else {
        await sendAdminBroadcastStart(chatTarget, from.id);
      }

      return;
    }

    const postLinkCommand = parsePostLinkCommand(text);
    if (postLinkCommand) {
      if (!Number.isInteger(postLinkCommand.raffleId)) {
        await sendMessage(chatTarget, 'Используйте: `/postlink ID_РОЗЫГРЫША ССЫЛКА`, например `/postlink 38 https://max.ru/...`');
        return;
      }

      await saveManualRafflePostUrl(chatTarget, from.id, postLinkCommand.raffleId, postLinkCommand.url);
      return;
    }

    const deleteCollaboratorCommand = parseDeleteCollaboratorCommand(text);
    if (deleteCollaboratorCommand) {
      await removeCollaboratorChannelFromActiveRaffle(
        chatTarget,
        from.id,
        deleteCollaboratorCommand.channelId,
        deleteCollaboratorCommand.raffleId
      );
      return;
    }

    if (text.startsWith('/general ') || text.startsWith('/general_') || text.startsWith('/generalpublish ')) {
      const rawId = text.startsWith('/general_')
        ? text.replace('/general_', '').trim()
        : text.replace('/generalpublish', '').replace('/general', '').trim();
      const raffleId = Number(rawId);

      if (!Number.isInteger(raffleId)) {
        await sendMessage(chatTarget, 'Используйте: `/general ID_РОЗЫГРЫША`, например `/general 38`');
        return;
      }

      await adminScheduleGeneralPublish(chatTarget, from.id, raffleId);
      return;
    }

    if (text === '/ban' || text.startsWith('/ban ') || text === '/bans' || text.startsWith('/unban ')) {
      await handleAdminBanCommand(chatTarget, from.id, text);
      return;
    }

    if (text === '/create' || text.toLowerCase() === 'создать розыгрыш') {
      await setSession(from.id, 'await_title', {});
      await sendMessage(chatTarget, buildRaffleTitlePrompt());
      return;
    }

    if (text === '/my' || text.toLowerCase() === 'мои розыгрыши') {
      await sendMyRafflesMenu(chatTarget, from.id);
      return;
    }

    if (text === '/check_join' || text.toLowerCase() === '/проверить' || text.toLowerCase() === 'проверить') {
      const pending = await getLatestPendingJoinForUser(from.id);

      if (!pending) {
        await sendMessage(chatTarget, 'У вас нет ожидающего участия для проверки. Откройте розыгрыш и нажмите **🎁 Участвовать**.');
        return;
      }

      await sendMessage(chatTarget, '🔎 Проверяю подписку на каналы розыгрыша...');
      await completeJoinRaffleAfterCheck(chatTarget, from.id, pending.raffle_id, pending.invited_by);
      return;
    }

    if (text === '/join' || text.toLowerCase() === 'участвовать') {
      await joinLatestRaffle(chatTarget, from.id);
      return;
    }

    if (text.startsWith('/join_')) {
      const { raffleId, ref, sourceChannelId } = parseJoinPayloadParts(text.replace(/^\//, ''));

      if (!Number.isInteger(raffleId)) {
        await sendMessage(chatTarget, 'Некорректная ссылка участия. Откройте розыгрыш через кнопку участия.');
        return;
      }

      await joinRaffle(chatTarget, from.id, raffleId, ref, sourceChannelId);
      return;
    }

    if (text.startsWith('/stat_')) {
      const raffleId = Number(text.replace('/stat_', '').trim());

      if (!Number.isInteger(raffleId)) {
        await sendMessage(chatTarget, 'Некорректный ID розыгрыша.');
        return;
      }

      await sendRaffleStats(chatTarget, raffleId, from.id);
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

    if (text === '/stop' || text.toLowerCase() === 'стоп' || text.startsWith('/stop ') || text.startsWith('/stop_')) {
      const rawId = text.startsWith('/stop_')
        ? text.replace('/stop_', '').trim()
        : text.replace('/stop', '').trim();
      const raffleId = rawId ? Number(rawId) : null;

      if (rawId && !Number.isInteger(raffleId)) {
        await sendMessage(chatTarget, 'Некорректный ID розыгрыша. Используйте `/stop 14` или просто `/stop` для последнего активного розыгрыша.');
        return;
      }

      await stopRaffleNow(chatTarget, from.id, raffleId);
      return;
    }

    if (text.startsWith('/reroll_') || text.startsWith('/переиграть_')) {
      const raffleId = Number(text.replace('/reroll_', '').replace('/переиграть_', '').trim());

      if (!Number.isInteger(raffleId)) {
        await sendMessage(chatTarget, 'Некорректный ID розыгрыша.');
        return;
      }

      await rerollRaffleWinners(chatTarget, from.id, raffleId);
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
    webhook: '/webhook',
    appBaseUrl: APP_BASE_URL,
    webhookUrl: buildWebhookUrl()
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

app.get('/max-me', async (req, res) => {
  try {
    const setupSecret = process.env.SETUP_WEBHOOK_SECRET || '';

    if (setupSecret && req.query.secret !== setupSecret) {
      return res.status(403).json({
        ok: false,
        error: 'Forbidden'
      });
    }

    const result = await getMaxMe();

    res.json({
      ok: true,
      result
    });
  } catch (error) {
    console.error('/max-me error:', error.message);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get('/setup-webhook', async (req, res) => {
  try {
    const setupSecret = process.env.SETUP_WEBHOOK_SECRET || '';

    if (setupSecret && req.query.secret !== setupSecret) {
      return res.status(403).json({
        ok: false,
        error: 'Forbidden'
      });
    }

    const result = await registerMaxWebhook();

    res.json({
      ok: true,
      webhookUrl: buildWebhookUrl(),
      result
    });
  } catch (error) {
    console.error('/setup-webhook error:', error.message);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get('/subscriptions', async (req, res) => {
  try {
    const setupSecret = process.env.SETUP_WEBHOOK_SECRET || '';

    if (setupSecret && req.query.secret !== setupSecret) {
      return res.status(403).json({
        ok: false,
        error: 'Forbidden'
      });
    }

    const result = await getMaxSubscriptions();

    res.json({
      ok: true,
      result
    });
  } catch (error) {
    console.error('/subscriptions error:', error.message);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

function renderLandingPage({ title, heading, description, buttonText, buttonUrl }) {
  return `
    <!doctype html>
    <html lang="ru">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${title}</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 30px;
            line-height: 1.5;
            background: #f5f5f5;
          }

          .card {
            max-width: 560px;
            margin: 0 auto;
            background: #fff;
            padding: 24px;
            border-radius: 18px;
            box-shadow: 0 12px 30px rgba(0,0,0,.08);
          }

          .button {
            display: inline-block;
            margin-top: 16px;
            padding: 14px 18px;
            border-radius: 12px;
            background: #111;
            color: #fff;
            text-decoration: none;
            font-weight: 700;
          }

          .hint {
            margin-top: 14px;
            color: #666;
            font-size: 14px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>${heading}</h2>
          <p>${description}</p>
          <a class="button" href="${buttonUrl}">${buttonText}</a>
          <p class="hint">Если кнопка не открылась, вернитесь в MAX и откройте бота вручную.</p>
        </div>
      </body>
    </html>
  `;
}

app.get('/join/:raffleId', async (req, res) => {
  const raffleId = Number(req.params.raffleId);
  const ref = req.query.ref || '';
  const payload = ref
    ? buildRaffleJoinPayload(raffleId, null, ref)
    : buildRaffleJoinPayload(raffleId);
  const buttonUrl = buildBotDeepLink(payload);

  res.type('html').send(renderLandingPage({
    title: 'Участие в розыгрыше',
    heading: `🎉 Розыгрыш #${raffleId}`,
    description: 'Откройте бота в MAX. Бот проверит условия участия и выдаст билет.',
    buttonText: 'Открыть бота и участвовать',
    buttonUrl
  }));
});

app.get('/collab/:token', async (req, res) => {
  const token = safeText(req.params.token || '', 200);
  const invite = await getRaffleInviteByToken(token).catch(() => null);

  if (!invite || !isRaffleInviteActive(invite)) {
    res.status(410).type('html').send(renderLandingPage({
      title: 'Ссылка закрыта',
      heading: '🔒 Ссылка коллаборации закрыта',
      description: 'Организатор уже остановил добавление новых соадминов к этому розыгрышу. Новые каналы по этой ссылке подключить нельзя.',
      buttonText: 'Открыть бота',
      buttonUrl: BOT_PUBLIC_URL || APP_BASE_URL
    }));
    return;
  }

  const buttonUrl = buildBotDeepLink(`collab_${token}`);

  res.type('html').send(renderLandingPage({
    title: 'Совместный розыгрыш',
    heading: '🤝 Совместный розыгрыш',
    description: 'Откройте бота, добавьте его администратором в свой канал и выберите условия: размещать пост в канале или нет, делать подписку обязательной или нет.',
    buttonText: 'Открыть бота',
    buttonUrl
  }));
});

app.post('/yookassa-webhook', handleYooKassaWebhook);
app.post('/yookassa/webhook', handleYooKassaWebhook);

app.get('/payment/return', (req, res) => {
  res
    .status(200)
    .type('text/html; charset=utf-8')
    .send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 24px; line-height: 1.5;">
          <h2>Спасибо за оплату</h2>
          <p>Если платёж прошёл успешно, бот автоматически применит услугу и отправит уведомление в MAX.</p>
          <p>Вернитесь в чат с ботом.</p>
        </body>
      </html>
    `);
});

app.post(['/', '/webhook'], (req, res) => {
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
  const allUpdatesAreForeignRaffleEdits = updates.length > 0 && updates.every(shouldSkipForeignRaffleEditedUpdate);

  // Если пришли только чужие message_edited от розыгрышей конкурентов — полностью молчим.
  // Так в Render logs не будет ни WEBHOOK RECEIVED, ни bodyPreview, ни handleMaxUpdate с чужим текстом.
  if (!allUpdatesAreForeignRaffleEdits) {
    console.log('📩 WEBHOOK RECEIVED:', {
      path: req.path,
      time: new Date().toISOString(),
      update_type: req.body?.update_type,
      hasUpdates: Array.isArray(req.body?.updates),
      contentType: req.get('Content-Type'),
      userAgent: req.get('User-Agent'),
      hasBody: Boolean(req.body && Object.keys(req.body).length),
      bodyPreview: JSON.stringify(req.body || {}).slice(0, 1500)
    });

    console.log(`📦 Updates count: ${updates.length}`);
  }

  for (const update of updates) {
    if (shouldSkipForeignRaffleEditedUpdate(update)) {
      // В смешанном пакете updates покажем коротко, что чужой апдейт отброшен, но без текста поста.
      if (!allUpdatesAreForeignRaffleEdits) {
        console.log('⏭ Чужой message_edited розыгрыш пропущен без bodyPreview:', {
          chat_id: update?.message?.recipient?.chat_id || update?.chat_id || '',
          reason: 'foreign_raffle_post'
        });
      }
      continue;
    }

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
      profile_link TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS profile_link TEXT;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS is_broadcast_available BOOLEAN NOT NULL DEFAULT true;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS broadcast_failed_at TIMESTAMP;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS broadcast_fail_reason TEXT;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS last_broadcast_success_at TIMESTAMP;

    CREATE INDEX IF NOT EXISTS idx_users_broadcast_available
      ON users (is_broadcast_available);

    CREATE TABLE IF NOT EXISTS admin_broadcast_jobs (
      id SERIAL PRIMARY KEY,
      admin_user_id BIGINT REFERENCES users(max_user_id) ON DELETE SET NULL,
      target_user_id BIGINT,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      total_count INT NOT NULL DEFAULT 0,
      sent_count INT NOT NULL DEFAULT 0,
      failed_count INT NOT NULL DEFAULT 0,
      unavailable_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      started_at TIMESTAMP,
      finished_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admin_broadcast_recipients (
      id SERIAL PRIMARY KEY,
      job_id INT NOT NULL REFERENCES admin_broadcast_jobs(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      error_text TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      sent_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (job_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS ix_admin_broadcast_jobs_status_created
      ON admin_broadcast_jobs (status, created_at);

    CREATE INDEX IF NOT EXISTS ix_admin_broadcast_recipients_job_status
      ON admin_broadcast_recipients (job_id, status, id);

    CREATE TABLE IF NOT EXISTS user_sessions (
      user_id BIGINT PRIMARY KEY REFERENCES users(max_user_id) ON DELETE CASCADE,
      state TEXT,
      data JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_legal_acceptances (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
      legal_version TEXT NOT NULL DEFAULT '2026-06-05',
      accepted_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (user_id, legal_version)
    );

    CREATE INDEX IF NOT EXISTS idx_user_legal_acceptances_user_version
      ON user_legal_acceptances (user_id, legal_version);

    CREATE TABLE IF NOT EXISTS raffles (
      id SERIAL PRIMARY KEY,
      creator_user_id BIGINT REFERENCES users(max_user_id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT 'Без названия',
      description TEXT,
      prizes TEXT,
      prize_count INT DEFAULT 1,
      publish_at TIMESTAMP DEFAULT NOW(),
      end_at TIMESTAMP NOT NULL,
      photo_attachment JSONB,
      status TEXT NOT NULL DEFAULT 'draft',
      publish_in_general BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE raffles
      ADD COLUMN IF NOT EXISTS publish_at TIMESTAMP DEFAULT NOW();

    ALTER TABLE raffles
      ADD COLUMN IF NOT EXISTS photo_attachment JSONB;

    ALTER TABLE raffles
      ADD COLUMN IF NOT EXISTS is_hidden_from_my_raffles BOOLEAN DEFAULT false;

    CREATE TABLE IF NOT EXISTS raffle_channels (
      id SERIAL PRIMARY KEY,
      raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      channel_id BIGINT NOT NULL,
      channel_title TEXT,
      channel_link TEXT,
      owner_user_id BIGINT,
      is_required BOOLEAN DEFAULT true,
      publish_post BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE raffle_channels
      ADD COLUMN IF NOT EXISTS channel_link TEXT;

    ALTER TABLE raffle_channels
      ADD COLUMN IF NOT EXISTS owner_user_id BIGINT;

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
      source_channel_id BIGINT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (raffle_id, user_id)
    );

    ALTER TABLE raffle_user_entry
      ADD COLUMN IF NOT EXISTS source_channel_id BIGINT;

    CREATE TABLE IF NOT EXISTS raffle_participants (
      id SERIAL PRIMARY KEY,
      raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
      ticket_number BIGINT NOT NULL,
      invited_by BIGINT,
      is_valid BOOLEAN DEFAULT true,
      ticket_type TEXT DEFAULT 'main',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (raffle_id, user_id, ticket_number)
    );

    ALTER TABLE raffle_participants
      ADD COLUMN IF NOT EXISTS ticket_type TEXT DEFAULT 'main';

    CREATE TABLE IF NOT EXISTS raffle_pending_joins (
      id SERIAL PRIMARY KEY,
      raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
      invited_by BIGINT,
      source_channel_id BIGINT,
      status TEXT NOT NULL DEFAULT 'pending',
      reminder_sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (raffle_id, user_id)
    );

    ALTER TABLE raffle_pending_joins
      ADD COLUMN IF NOT EXISTS source_channel_id BIGINT;

    ALTER TABLE raffle_pending_joins
      ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMP;

    -- Миграция для старых баз: если таблицы уже были созданы без UNIQUE,
    -- CREATE TABLE IF NOT EXISTS не добавит ограничение автоматически.
    -- Поэтому сначала мягко убираем дубликаты marker-записей, затем создаём индексы.
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY raffle_id, user_id
          ORDER BY id ASC
        ) AS rn
      FROM raffle_user_entry
    )
    DELETE FROM raffle_user_entry rue
    USING ranked r
    WHERE rue.id = r.id AND r.rn > 1;

    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY raffle_id, user_id
          ORDER BY
            CASE WHEN status = 'completed' THEN 0 ELSE 1 END,
            id ASC
        ) AS rn
      FROM raffle_pending_joins
    )
    DELETE FROM raffle_pending_joins rpj
    USING ranked r
    WHERE rpj.id = r.id AND r.rn > 1;

    CREATE TABLE IF NOT EXISTS raffle_permission_alerts (
      id SERIAL PRIMARY KEY,
      raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      channel_id BIGINT NOT NULL,
      recipient_user_id BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
      alert_type TEXT NOT NULL DEFAULT 'permissions_lost',
      last_sent_at TIMESTAMP,
      send_count INT NOT NULL DEFAULT 0,
      resolved_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (raffle_id, channel_id, recipient_user_id, alert_type)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ux_raffle_user_entry_raffle_user
      ON raffle_user_entry (raffle_id, user_id);

    CREATE UNIQUE INDEX IF NOT EXISTS ux_raffle_pending_joins_raffle_user
      ON raffle_pending_joins (raffle_id, user_id);

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
      participants_count INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- В старых версиях message_id мог быть BIGINT.
    -- MAX присылает строковые mid.* идентификаторы, поэтому обязательно переводим колонку в TEXT.
    ALTER TABLE raffle_posts
      ALTER COLUMN message_id TYPE TEXT USING message_id::text;

    ALTER TABLE raffle_posts
      ADD COLUMN IF NOT EXISTS post_url TEXT;

    ALTER TABLE raffle_posts
      ADD COLUMN IF NOT EXISTS participants_count INT DEFAULT 0;

    ALTER TABLE raffle_posts
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS user_channels (
      id SERIAL PRIMARY KEY,
      owner_user_id BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
      channel_id BIGINT NOT NULL,
      channel_title TEXT,
      channel_link TEXT,
      added_by_user_id BIGINT REFERENCES users(max_user_id) ON DELETE SET NULL,
      can_publish BOOLEAN DEFAULT true,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (owner_user_id, channel_id)
    );

    ALTER TABLE user_channels
      ADD COLUMN IF NOT EXISTS channel_link TEXT;

    ALTER TABLE user_channels
      ADD COLUMN IF NOT EXISTS added_by_user_id BIGINT;

    ALTER TABLE user_channels
      ADD COLUMN IF NOT EXISTS can_publish BOOLEAN DEFAULT true;

    ALTER TABLE user_channels
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

    ALTER TABLE user_channels
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS bot_seen_chats (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT UNIQUE NOT NULL,
      chat_title TEXT,
      chat_link TEXT,
      source_update_type TEXT,
      last_actor_user_id BIGINT,
      last_payload JSONB DEFAULT '{}'::jsonb,
      seen_count INT DEFAULT 1,
      is_probably_channel BOOLEAN DEFAULT true,
      is_removed BOOLEAN DEFAULT false,
      last_removed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE bot_seen_chats
      ADD COLUMN IF NOT EXISTS chat_link TEXT;

    ALTER TABLE bot_seen_chats
      ADD COLUMN IF NOT EXISTS source_update_type TEXT;

    ALTER TABLE bot_seen_chats
      ADD COLUMN IF NOT EXISTS last_actor_user_id BIGINT;

    ALTER TABLE bot_seen_chats
      ADD COLUMN IF NOT EXISTS last_payload JSONB DEFAULT '{}'::jsonb;

    ALTER TABLE bot_seen_chats
      ADD COLUMN IF NOT EXISTS seen_count INT DEFAULT 1;

    ALTER TABLE bot_seen_chats
      ADD COLUMN IF NOT EXISTS is_probably_channel BOOLEAN DEFAULT true;

    ALTER TABLE bot_seen_chats
      ADD COLUMN IF NOT EXISTS is_removed BOOLEAN DEFAULT false;

    ALTER TABLE bot_seen_chats
      ADD COLUMN IF NOT EXISTS last_removed_at TIMESTAMP;

    ALTER TABLE bot_seen_chats
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS raffle_invites (
      id SERIAL PRIMARY KEY,
      raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      invited_by_user_id BIGINT REFERENCES users(max_user_id) ON DELETE SET NULL,
      is_active BOOLEAN DEFAULT true,
      closed_at TIMESTAMP,
      closed_by_user_id BIGINT REFERENCES users(max_user_id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE raffle_invites
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

    ALTER TABLE raffle_invites
      ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP;

    ALTER TABLE raffle_invites
      ADD COLUMN IF NOT EXISTS closed_by_user_id BIGINT REFERENCES users(max_user_id) ON DELETE SET NULL;

    CREATE TABLE IF NOT EXISTS raffle_promo_payments (
      id SERIAL PRIMARY KEY,
      payment_id TEXT UNIQUE NOT NULL,
      raffle_id INT REFERENCES raffles(id) ON DELETE SET NULL,
      user_id BIGINT REFERENCES users(max_user_id) ON DELETE SET NULL,
      product TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      amount TEXT,
      currency TEXT DEFAULT 'RUB',
      receipt_email TEXT,
      raw JSONB DEFAULT '{}'::jsonb,
      applied BOOLEAN DEFAULT false,
      paid_at TIMESTAMP,
      applied_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE raffle_promo_payments
      ADD COLUMN IF NOT EXISTS applied BOOLEAN DEFAULT false;

    ALTER TABLE raffle_promo_payments
      ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP;

    ALTER TABLE raffle_promo_payments
      ADD COLUMN IF NOT EXISTS applied_at TIMESTAMP;

    CREATE TABLE IF NOT EXISTS user_bans (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
      banned_until TIMESTAMP NOT NULL,
      reason TEXT,
      banned_by BIGINT REFERENCES users(max_user_id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE user_bans
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS channel_member_events (
      id SERIAL PRIMARY KEY,
      channel_id BIGINT NOT NULL,
      user_id BIGINT,
      event_type TEXT NOT NULL,
      delta INT NOT NULL,
      source_update_type TEXT,
      raw_payload JSONB DEFAULT '{}'::jsonb,
      event_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS raffle_channel_subscription_states (
      id SERIAL PRIMARY KEY,
      raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      channel_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
      is_subscribed BOOLEAN NOT NULL DEFAULT false,
      first_checked_at TIMESTAMP DEFAULT NOW(),
      last_checked_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (raffle_id, channel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS raffle_channel_subscription_events (
      id SERIAL PRIMARY KEY,
      raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      channel_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      delta INT NOT NULL,
      source TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS ix_user_bans_active
    ON user_bans (user_id, banned_until DESC);

    CREATE INDEX IF NOT EXISTS ix_raffle_promo_payments_raffle
    ON raffle_promo_payments (raffle_id, product, status);

    CREATE INDEX IF NOT EXISTS ix_raffle_promo_payments_user
    ON raffle_promo_payments (user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS ix_channel_member_events_channel_period
    ON channel_member_events (channel_id, event_at);

    CREATE INDEX IF NOT EXISTS ix_channel_member_events_channel_period_delta
    ON channel_member_events (channel_id, event_at, delta);

    CREATE INDEX IF NOT EXISTS ux_raffle_channel_subscription_states_unique
    ON raffle_channel_subscription_states (raffle_id, channel_id, user_id);

    CREATE INDEX IF NOT EXISTS ix_raffle_channel_subscription_states_raffle_channel
    ON raffle_channel_subscription_states (raffle_id, channel_id, is_subscribed);

    CREATE INDEX IF NOT EXISTS ix_raffle_channel_subscription_events_raffle_channel_period
    ON raffle_channel_subscription_events (raffle_id, channel_id, created_at, delta);

    CREATE INDEX IF NOT EXISTS ix_raffles_status_end_at
    ON raffles (status, end_at);

    CREATE INDEX IF NOT EXISTS ix_raffles_creator_visible
    ON raffles (creator_user_id, is_hidden_from_my_raffles, id DESC);

    CREATE INDEX IF NOT EXISTS ix_raffle_queue_status_scheduled
    ON raffle_queue (status, scheduled_at);

    CREATE INDEX IF NOT EXISTS ix_raffle_queue_general_publish
    ON raffle_queue (queue_type, status, scheduled_at);

    CREATE INDEX IF NOT EXISTS ix_raffle_queue_general_payment_id
    ON raffle_queue ((payload->>'payment_id'))
    WHERE queue_type = 'general_publish';


    CREATE INDEX IF NOT EXISTS ix_raffle_queue_post_update_pending
    ON raffle_queue (raffle_id, queue_type, status, scheduled_at)
    WHERE queue_type = 'raffle_post_update'
      AND status IN ('pending', 'processing');

    CREATE INDEX IF NOT EXISTS ix_raffle_participants_raffle_valid
    ON raffle_participants (raffle_id, is_valid);

    CREATE INDEX IF NOT EXISTS ix_raffle_participants_referral_bonus
    ON raffle_participants (raffle_id, user_id, ticket_type);

    CREATE INDEX IF NOT EXISTS ix_raffle_pending_joins_status
    ON raffle_pending_joins (raffle_id, status, updated_at);

    CREATE INDEX IF NOT EXISTS ix_raffle_pending_joins_one_minute_reminder
    ON raffle_pending_joins (status, reminder_sent_at, updated_at);

    CREATE INDEX IF NOT EXISTS ix_raffle_channels_raffle
    ON raffle_channels (raffle_id);

    CREATE INDEX IF NOT EXISTS ix_raffle_posts_raffle_created
    ON raffle_posts (raffle_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS ix_raffle_winners_raffle
    ON raffle_winners (raffle_id);

    -- Один пользователь не может быть победителем два раза в одном розыгрыше.
    -- Перед созданием уникального индекса мягко убираем только старые дубли победителей,
    -- оставляя первую запись победы по каждому пользователю.
    DELETE FROM raffle_winners rw
    USING raffle_winners keep
    WHERE rw.raffle_id = keep.raffle_id
      AND rw.user_id = keep.user_id
      AND rw.id > keep.id;

    CREATE UNIQUE INDEX IF NOT EXISTS ux_raffle_winners_raffle_user
    ON raffle_winners (raffle_id, user_id);

    CREATE INDEX IF NOT EXISTS ix_user_channels_owner
    ON user_channels (owner_user_id, is_active);

    CREATE INDEX IF NOT EXISTS ix_raffle_invites_token
    ON raffle_invites (token);

    CREATE INDEX IF NOT EXISTS ix_raffle_channels_owner
    ON raffle_channels (owner_user_id);

    CREATE INDEX IF NOT EXISTS ix_raffle_channels_raffle_channel
    ON raffle_channels (raffle_id, channel_id);

    CREATE INDEX IF NOT EXISTS ix_raffle_permission_alerts_due
    ON raffle_permission_alerts (raffle_id, channel_id, resolved_at, last_sent_at);

    CREATE INDEX IF NOT EXISTS ix_bot_seen_chats_updated
    ON bot_seen_chats (is_probably_channel, updated_at DESC);

    CREATE INDEX IF NOT EXISTS ix_bot_seen_chats_active
    ON bot_seen_chats (is_probably_channel, is_removed, updated_at DESC);

    CREATE INDEX IF NOT EXISTS ix_bot_seen_chats_actor
    ON bot_seen_chats (last_actor_user_id);
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
    await apostModule.initDb();

    await getMaxMe().catch(error => {
      console.warn('⚠️ MAX /me check failed:', error.message);
    });

    await registerBotCommandsWithMaxLibrary().catch(error => {
      console.warn('⚠️ MAX commands registration failed:', error.message);
    });

    if (String(process.env.AUTO_REGISTER_WEBHOOK || 'false').toLowerCase() === 'true') {
      await registerMaxWebhook().catch(error => {
        console.warn('⚠️ Auto webhook registration failed:', error.message);
      });
    }

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

    setInterval(() => {
      processAdminBroadcastJobs().catch(error => {
        console.error('admin broadcast worker interval error:', error.message);
      });
    }, ADMIN_BROADCAST_WORKER_INTERVAL_SECONDS * 1000).unref?.();

    setTimeout(() => {
      processAdminBroadcastJobs().catch(error => {
        console.error('admin broadcast worker warmup error:', error.message);
      });
    }, 5000).unref?.();

    setInterval(() => {
      sendOneMinutePendingJoinReminders().catch(error => {
        console.error('pending join one-minute reminder interval error:', error.message);
      });
    }, PENDING_JOIN_REMINDER_SCAN_SECONDS * 1000).unref?.();

    setTimeout(() => {
      sendOneMinutePendingJoinReminders().catch(error => {
        console.error('pending join one-minute reminder warmup error:', error.message);
      });
    }, 15000).unref?.();

    if (POST_PARTICIPANTS_UPDATE_SECONDS > 0) {
      setInterval(() => {
        updateAllActiveRafflePublishedPosts().catch(error => {
          console.error('post participants update interval error:', error.message);
        });
      }, POST_PARTICIPANTS_UPDATE_SECONDS * 1000).unref?.();
    }

    // Фоновую проверку прав выключили: она может давать ложные 403 по всем каналам
    // активного розыгрыша. Теперь предупреждение отправляется по факту реальной проблемы:
    // bot_removed или 403 по конкретному каналу в момент проверки подписки участником.

    apostModule.startWorker();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ MAX raffle bot is running on port ${PORT}`);
      console.log(`🌐 APP_BASE_URL=${APP_BASE_URL}`);
      console.log(`🔗 Webhook URL=${buildWebhookUrl()}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
