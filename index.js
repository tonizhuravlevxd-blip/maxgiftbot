require('dotenv').config();
process.env.TZ = process.env.TZ || 'UTC';

const express = require('express');
const { Pool } = require('pg');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const utc = require('dayjs/plugin/utc');
const crypto = require('crypto');

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

const BOT_PUBLIC_URL = String(
  process.env.BOT_PUBLIC_URL ||
  process.env.MAX_BOT_LINK ||
  process.env.BOT_LINK ||
  APP_BASE_URL
).replace(/\/+$/, '');

const BOT_BRAND_NAME = process.env.BOT_BRAND_NAME || 'РОЗЫГРЫШ БОТ';
const BOT_USERNAME = process.env.BOT_USERNAME || '@id231711659887_bot';
const BOT_SEARCH_NAME = process.env.BOT_SEARCH_NAME || 'Бот розыгрыш';
const BOT_TIMEZONE_LABEL = process.env.BOT_TIMEZONE_LABEL || 'МСК';
const BOT_UTC_OFFSET_MINUTES = Number(process.env.BOT_UTC_OFFSET_MINUTES || 180);
const MAX_CHANNEL_LINK_TEMPLATE = String(process.env.MAX_CHANNEL_LINK_TEMPLATE || '').trim();
const USER_RAFFLES_VISIBLE_LIMIT = Math.max(
  1,
  Number(process.env.USER_RAFFLES_VISIBLE_LIMIT || 5)
);
const MAX_REFERRAL_BONUS_TICKETS = Math.max(
  0,
  Number(process.env.MAX_REFERRAL_BONUS_TICKETS || 5)
);

const MAX_UPDATE_TYPES = String(process.env.MAX_UPDATE_TYPES || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const DEBUG_MAX_FULL_UPDATES = String(
  process.env.DEBUG_MAX_FULL_UPDATES || 'true'
).toLowerCase() !== 'false';

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
    const mark = channel.is_required ? 'обязательно' : 'дополнительно';
    return `${index + 1}. ${formatChannelWithLink(channel)} — ${mark}`;
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
  // callback_id в MAX — это ID конкретного нажатия кнопки, а не публичный token профиля.
  // Из него нельзя делать https://max.ru/u/..., такая ссылка ведёт на «не найдено».
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

function pickMaxUserObjectFromMember(member) {
  if (!member || typeof member !== 'object') return null;

  const candidates = [
    member.user,
    member.profile,
    member.member?.user,
    member.membership?.user,
    member.participant,
    member.account,
    member
  ].filter(Boolean);

  return candidates.find(candidate => {
    if (!candidate || typeof candidate !== 'object') return false;

    return Boolean(
      candidate.user_id ||
      candidate.userId ||
      candidate.max_user_id ||
      candidate.id ||
      candidate.username ||
      candidate.login ||
      candidate.first_name ||
      candidate.firstName ||
      candidate.name ||
      extractUserProfileLinkFromObject(candidate)
    );
  }) || null;
}

function findMemberObjectForUser(body, userId) {
  const expectedUserId = String(userId || '').trim();
  if (!expectedUserId) return null;

  if (getMemberUserId(body) === expectedUserId) return body;

  const members = extractMembersFromMaxResponse(body);
  return members.find(member => getMemberUserId(member) === expectedUserId) || null;
}

function extractUserFieldsFromMaxObject(userId, obj) {
  const expectedUserId = String(userId || '').trim();
  const source = pickMaxUserObjectFromMember(obj) || obj || {};
  const directUserId = String(
    source?.user_id ||
    source?.userId ||
    source?.max_user_id ||
    source?.id ||
    expectedUserId ||
    ''
  ).trim();

  const username = normalizeUsername(source?.username || source?.login || source?.screen_name || source?.screenName || '');
  const firstName = String(source?.first_name || source?.firstName || source?.name || source?.full_name || '').trim() || null;
  const lastName = String(source?.last_name || source?.lastName || '').trim() || null;
  const profileLink = extractUserProfileLinkFromObject(source) || extractUserProfileLinkFromObject(obj);

  return {
    id: directUserId || expectedUserId,
    username: username || null,
    first_name: firstName,
    last_name: lastName,
    profile_link: profileLink || null
  };
}

async function saveUserProfileFromMaxObject(userId, obj, sourceLabel = 'max_api') {
  const expectedUserId = String(userId || '').trim();
  if (!expectedUserId || !obj || typeof obj !== 'object') return null;

  const fields = extractUserFieldsFromMaxObject(expectedUserId, obj);
  const id = String(fields.id || expectedUserId).trim();

  if (!id || id !== expectedUserId) return null;

  const hasUsefulProfileData = Boolean(
    fields.username ||
    fields.first_name ||
    fields.last_name ||
    fields.profile_link
  );

  if (!hasUsefulProfileData) return null;

  try {
    const res = await pool.query(`
      INSERT INTO users (max_user_id, username, first_name, last_name, profile_link)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (max_user_id)
      DO UPDATE SET
        username = COALESCE(EXCLUDED.username, users.username),
        first_name = COALESCE(EXCLUDED.first_name, users.first_name),
        last_name = COALESCE(EXCLUDED.last_name, users.last_name),
        profile_link = COALESCE(NULLIF(EXCLUDED.profile_link, ''), users.profile_link),
        updated_at = NOW()
      RETURNING max_user_id, username, first_name, last_name, profile_link
    `, [
      id,
      fields.username,
      fields.first_name,
      fields.last_name,
      fields.profile_link
    ]);

    if (fields.profile_link) {
      console.log('🔗 MAX profile link saved from API object:', {
        userId: id,
        source: sourceLabel,
        profile_link: fields.profile_link
      });
    } else if (fields.username) {
      console.log('🔗 MAX username saved from API object:', {
        userId: id,
        source: sourceLabel,
        username: fields.username
      });
    }

    return res.rows[0] || null;
  } catch (error) {
    console.warn('Не удалось сохранить профиль пользователя из MAX API:', error.message);
    return null;
  }
}

function logProfileLinkDebug(userId, obj, sourceLabel = 'max_api') {
  if (String(process.env.MAX_PROFILE_LINK_DEBUG || 'false').toLowerCase() !== 'true') return;

  try {
    const member = findMemberObjectForUser(obj, userId) || obj;
    const userObj = pickMaxUserObjectFromMember(member) || member || {};

    console.log('🔎 MAX profile debug:', JSON.stringify({
      userId: String(userId || ''),
      source: sourceLabel,
      memberKeys: member && typeof member === 'object' ? Object.keys(member).slice(0, 40) : [],
      userKeys: userObj && typeof userObj === 'object' ? Object.keys(userObj).slice(0, 40) : [],
      foundProfileLink: extractUserProfileLinkFromObject(member) || extractUserProfileLinkFromObject(userObj) || '',
      username: userObj?.username || userObj?.login || ''
    }).slice(0, 3000));
  } catch (error) {
    console.warn('MAX profile debug failed:', error.message);
  }
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
  const link = buildUserProfileLink(user);
  const userId = String(user?.user_id || user?.max_user_id || '').trim();

  if (link) return markdownLink(name, link);
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

function isChatTarget(target) {
  return target && target.type === 'chat_id' && String(target.id || '').trim();
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
  if (!expectedUserId) return null;

  const encodedChannelId = encodeURIComponent(String(chatId).trim());
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
  if (!id) return null;

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
    if (!channelId) continue;

    const trustedByWebhook = isSeenChatLinkedByUser(candidate, userId);

    if (!trustedByWebhook) {
      // Для каналов, которые бот увидел не через событие bot_added/bot_updated от этого пользователя,
      // оставляем старую осторожную проверку. Но для MAX она часто недоступна по правам.
      const canUserManage = await isUserAdminInChannel(userId, channelId);

      if (!canUserManage) {
        skipped.push({ channelId, reason: 'user_not_admin_or_not_linked_by_webhook' });
        continue;
      }
    }

    // MAX может запрещать боту читать список участников/права канала даже после назначения админом.
    // Поэтому для bot_added/bot_updated доверяем webhook-событию: если пользователь добавил бота в канал,
    // значит бот уже получил chat_id от MAX, а пользователь был актором этого подключения.
    // Реальная возможность публикации всё равно окончательно проверится при отправке поста.
    let info = null;
    let canPublish = true;

    if (!trustedByWebhook) {
      info = await getChatInfoSafe(channelId) || candidate;
      canPublish = await checkBotCanPublishInChannel(channelId, info);

      if (!canPublish) {
        skipped.push({ channelId, reason: 'bot_cannot_publish_or_permissions_hidden' });
        continue;
      }
    } else {
      info = await getChatInfoSafe(channelId) || candidate;
    }

    const meta = {
      title: extractTitleFromChatInfo(info) || candidate.chat_title || `Канал ${channelId}`,
      link: extractChatLinkFromObject(info) || candidate.chat_link || ''
    };

    const channel = await upsertUserChannel(userId, channelId, meta.title, meta.link, userId, canPublish);
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
  if (!isChatTarget(target)) return;

  const channelId = String(target.id || '').trim();
  await markSeenChatRemoved(channelId, update?.update_type || 'bot_removed');
  const deactivated = await deactivateUserChannelsByChannelId(channelId);

  console.log('🗑️ Bot removed from channel. Channel disabled for raffles:', {
    channel_id: channelId,
    deactivated_user_channels: deactivated
  });
}

async function refreshUserChannels(target, userId) {
  const result = await discoverUserChannelsForUser(userId);

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
        '3. после добавления MAX прислал событие **bot_added** с ID канала.',
        '',
        `Проверено активных увиденных каналов: ${result.checked}.`,
        '',
        'Бот больше не использует /me/chats. Кнопка **Обновить** берёт каналы из webhook-событий MAX.',
        'Для события **bot_added** бот больше не пытается читать участников канала через /members, потому что MAX может возвращать 403 даже при выданных правах.'
      ].join('\n')
    );
  }

  const session = await getSession(userId);

  if (session && ['await_channel_selection', 'collab_channel_selection'].includes(session.state)) {
    const sessionData = typeof session.data === 'string'
      ? JSON.parse(session.data || '{}')
      : session.data || {};

    return sendChannelSelectionMenu(target, userId, sessionData, session.state === 'collab_channel_selection' ? 'collab' : 'create');
  }

  return sendMyChannels(target, userId);
}

async function tryAutoRegisterChannelFromUpdate(update, target, from) {
  if (!isChatTarget(target) || !from?.id) {
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

async function sendAddChannelInstruction(target) {
  return sendMessage(
    target,
    [
      '➕ **Добавить канал**',
      '',
      'Чтобы бот мог публиковать розыгрыш в вашем канале:',
      '',
      `1. Добавьте бота ${BOT_USERNAME} в канал или найдите его по имени **${BOT_SEARCH_NAME}**.`,
      '2. Выдайте боту права администратора на размещение постов.',
      '3. Вернитесь сюда и нажмите **🔄 Обновить**.',
      '',
      'Писать сообщение в канале больше не нужно. Бот попробует сам проверить, что права выданы, и добавит канал в раздел **Мои каналы**.',
      '',
      'Важно: бот не использует /me/chats. Канал появится после webhook-события MAX о канале; кнопка **🔄 Обновить** проверит уже увиденные ботом каналы.'
    ].join('\n'),
    [
      [{ text: '🔄 Обновить', callback_data: 'refresh_channels' }],
      [{ text: '📢 Мои каналы', callback_data: 'my_channels' }],
      [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
    ]
  );
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

async function sendChannelSelectionMenu(target, userId, data, mode = 'create') {
  const userChannels = await getUserChannels(userId);
  const selected = getSelectedChannelsFromSession(data);

  let text = mode === 'collab'
    ? '🤝 **Каналы для совместного розыгрыша**\n\n'
    : '📢 **Каналы для розыгрыша**\n\n';

  text += 'Выберите каналы из списка ниже. Для каждого канала можно отдельно включить:\n';
  text += '✅ обязательную подписку;\n';
  text += '📣 размещение поста с розыгрышем.\n\n';

  if (!userChannels.length) {
    text += 'У вас пока нет подключённых каналов.\n';
    text += 'Сначала добавьте бота в канал, дайте права администратора на публикацию и нажмите **🔄 Обновить**.';
  } else if (!selected.length) {
    text += 'Каналы пока не выбраны. Можно продолжить без каналов или выбрать канал ниже.';
  } else {
    text += '**Выбрано:**\n';

    for (const ch of selected) {
      text += `• ${formatChannelWithLink(ch)} — `;
      text += `${ch.is_required ? 'обязательная подписка' : 'подписка не обязательна'}, `;
      text += `${ch.publish_post ? 'с размещением' : 'без размещения'}\n`;
    }
  }

  const keyboard = [];

  for (const ch of userChannels) {
    const stored = findSelectedChannel(data, ch.channel_id);
    const id = safeCallbackPart(ch.channel_id);
    const title = truncateButtonText(formatChannelName(ch), 34);

    keyboard.push([
      {
        text: `${stored ? '✅' : '➕'} ${title}`,
        callback_data: `${mode === 'collab' ? 'collab_ch_toggle' : 'raffle_ch_toggle'}:${id}`
      }
    ]);

    if (stored) {
      keyboard.push([
        {
          text: stored.is_required ? '✅ Обязательная подписка' : '☑️ Подписка не обязательна',
          callback_data: `${mode === 'collab' ? 'collab_ch_req' : 'raffle_ch_req'}:${id}`
        },
        {
          text: stored.publish_post ? '📣 С размещением' : '🙈 Без размещения',
          callback_data: `${mode === 'collab' ? 'collab_ch_pub' : 'raffle_ch_pub'}:${id}`
        }
      ]);
    }
  }

  keyboard.push([{ text: '🔄 Обновить каналы', callback_data: 'refresh_channels' }]);
  keyboard.push([{ text: '➕ Добавить канал', callback_data: 'add_channel' }]);
  keyboard.push([{ text: mode === 'collab' ? '✅ Добавить к розыгрышу' : '➡️ Далее к шаблону', callback_data: mode === 'collab' ? 'collab_channels_done' : 'raffle_channels_done' }]);
  keyboard.push([{ text: '❌ Отмена', callback_data: 'cancel_session' }]);

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
    INSERT INTO raffle_invites (raffle_id, token, invited_by_user_id)
    VALUES ($1, $2, $3)
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

  if (update?.chat_id) {
    return {
      type: 'chat_id',
      id: update.chat_id
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

  if (!target || !from.id) {
    return null;
  }

  return {
    from,
    chat: {
      id: target
    },
    text: getIncomingText(update),
    attachments: extractMessageAttachments(update)
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
async function sendWelcome(target, userOrId) {
  const userId = typeof userOrId === 'object' ? userOrId.id : userOrId;
  const firstName = typeof userOrId === 'object'
    ? String(userOrId.first_name || userOrId.firstName || userOrId.name || '').trim()
    : '';
  const helloName = firstName || 'друг';
  const adminLine = isAdmin(userId)
    ? '\n\n👑 Вам доступна админ-панель в главном меню.'
    : '';

  return sendMessage(
    target,
    [
      `👋 **Привет, ${helloName}!**`,
      '',
      'Я бот для честных розыгрышей в MAX.',
      '',
      `Сначала добавьте бота ${BOT_USERNAME} в канал или найдите его по имени **${BOT_SEARCH_NAME}**.`,
      'Затем выдайте боту права администратора на размещение постов и нажмите **Добавить канал** / **Обновить** в меню.',
      '',
      'Через меню можно создать розыгрыш, подключить каналы, добавить фото к посту, включить обязательную подписку, пригласить соадмина и смотреть статистику.',
      adminLine
    ].join('\n')
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
  const profileLink = normalizeMaxProfileLink(from.profile_link || from.profileLink || from.profile_url || from.profileUrl || from.link || from.url || '');

  await pool.query(`
    INSERT INTO users (max_user_id, username, first_name, last_name, profile_link)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (max_user_id)
    DO UPDATE SET
      username = COALESCE(EXCLUDED.username, users.username),
      first_name = COALESCE(EXCLUDED.first_name, users.first_name),
      last_name = COALESCE(EXCLUDED.last_name, users.last_name),
      profile_link = COALESCE(NULLIF(EXCLUDED.profile_link, ''), users.profile_link),
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
    'Ссылку можно скопировать в приложении MAX из профиля. Также бот теперь пробует автоматически сохранить ссылку из callback_id, когда пользователь нажимает кнопки. Если ссылка окажется неверной, её можно заменить вручную командой /profile https://max.ru/u/...'
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

  const res = await pool.query(`
    SELECT *
    FROM raffles
    WHERE creator_user_id = $1
      AND COALESCE(is_hidden_from_my_raffles, false) = false
    ORDER BY id DESC
    LIMIT $2
  `, [userId, USER_RAFFLES_VISIBLE_LIMIT]);

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

async function createParticipantEntry(raffleId, userId, invitedBy = null) {
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
      SELECT id
      FROM raffle_user_entry
      WHERE raffle_id = $1 AND user_id = $2
      LIMIT 1
    `, [raffleId, userId]);

    if (existingEntry.rows.length) {
      await client.query('ROLLBACK');
      return { alreadyJoined: true };
    }

    try {
      await client.query(`
        INSERT INTO raffle_user_entry (raffle_id, user_id)
        VALUES ($1, $2)
      `, [raffleId, userId]);
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
        console.log('Outgoing DIRECT raffle subscription check:', JSON.stringify({
          method: 'GET',
          path,
          query,
          expectedUserId,
          channelId
        }));

        const directResult = await maxRequest(path, {
          method: 'GET',
          query
        });

        const directMembers = extractMembersFromMaxResponse(directResult);
        console.log('DIRECT raffle subscription check response:', JSON.stringify({
          channelId,
          expectedUserId,
          membersCount: directMembers.length,
          sampleIds: directMembers.slice(0, 10).map(member => String(getMemberUserId(member) || ''))
        }));

        if (responseContainsActiveUser(directResult, expectedUserId)) {
          const member = findMemberObjectForUser(directResult, expectedUserId);
          if (member) {
            await saveUserProfileFromMaxObject(expectedUserId, member, 'members_direct');
            logProfileLinkDebug(expectedUserId, member, 'members_direct');
          }
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

      const query = { count: pageSize };
      if (marker) query.marker = marker;

      console.log('Outgoing raffle subscription check page:', JSON.stringify({
        method: 'GET',
        path,
        query,
        expectedUserId,
        channelId,
        page
      }));

      const result = await maxRequest(path, {
        method: 'GET',
        query
      });

      const pageMembers = extractMembersFromMaxResponse(result);
      console.log('Raffle subscription check page response:', JSON.stringify({
        page,
        channelId,
        expectedUserId,
        membersCount: pageMembers.length,
        sampleIds: pageMembers.slice(0, 10).map(member => String(getMemberUserId(member) || ''))
      }));

      if (responseContainsActiveUser(result, expectedUserId)) {
        const member = findMemberObjectForUser(result, expectedUserId);
        if (member) {
          await saveUserProfileFromMaxObject(expectedUserId, member, 'members_page');
          logProfileLinkDebug(expectedUserId, member, 'members_page');
        }
        return true;
      }

      const nextMarker = getNextMembersMarker(result);

      if (!nextMarker || nextMarker === marker || seenMarkers.has(nextMarker)) break;

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
      'Минимальной задержки больше нет: можно указать любое будущее время.',
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
    'Так пост будет выглядеть после публикации. Проверьте текст и настройки перед созданием.',
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
    '🤝 Соадмин подключается до публикации: сначала бот сохраняет черновик/запланированный розыгрыш, затем выдаёт ссылку. По этой ссылке другой админ добавляет свои каналы и выбирает условия. Посты выйдут только во время публикации.'
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
        [{ text: '✅ Создать без соадмина', callback_data: 'raffle_confirm_create' }],
        [{ text: '🤝 Создать и дать ссылку соадмину', callback_data: 'raffle_confirm_create_collab' }]
      ];

  keyboard.push(
    [
      { text: '✏️ Название', callback_data: 'draft_edit_title' },
      { text: '✏️ Описание', callback_data: 'draft_edit_description' }
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

function buildCreatedRaffleMessage(sessionData, raffle, inviteLink) {
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
    inviteLink,
    '',
    'Отправьте эту ссылку соадмину. Когда он откроет ссылку, добавит бота в свой канал и выберет условия, нажмите кнопку **🔄 Обновить розыгрыш**. Бот покажет, какие каналы коллаборации уже подключены к этому розыгрышу.',
    '',
    'Если не хотите ждать запланированное время публикации, нажмите **🚀 Запустить сейчас** — бот сразу опубликует розыгрыш в уже подключённые каналы. Каналы соадминов, добавленные позже, будут опубликованы сразу после подключения.'
  ].join('\n');
}

async function buildRefreshedRaffleMessage(raffle, inviteLink = '') {
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
    inviteLink || 'Ссылка не найдена.',
    '',
    collabCount
      ? '✅ Каналы соадминов уже добавлены и будут учитываться в условиях розыгрыша.'
      : 'Пока каналы соадминов не добавлены. Если вы уже отправили ссылку, попросите соадмина открыть её, выбрать канал и нажать «Добавить к розыгрышу».'
  ].join('\n');
}

function buildCreatedRaffleKeyboard(raffle, userId = null) {
  const keyboard = [
    [
      { text: '🔄 Обновить розыгрыш', callback_data: `refresh_raffle:${raffle.id}` },
      { text: '👀 Предпросмотр поста', callback_data: `preview_raffle:${raffle.id}` }
    ],
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
    keyboard.push([{ text: '⏹ Завершить сейчас', callback_data: `stop_raffle:${raffle.id}` }]);
  }

  if (raffle && String(raffle.status || '') === 'finished' && isOwnerOrAdmin) {
    keyboard.push([{ text: '🔁 Переиграть победителей', callback_data: `reroll_winners:${raffle.id}` }]);
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
  const inviteLink = invite?.token ? buildRaffleInviteLink(invite.token) : '';

  return sendMessage(
    target,
    await buildRefreshedRaffleMessage(raffle, inviteLink),
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

  const inviteLink = buildRaffleInviteLink(inviteToken);

  await sendMessage(
    target,
    buildCreatedRaffleMessage(sessionData, createdRaffle, inviteLink),
    buildCreatedRaffleKeyboard(createdRaffle, userId)
  );

  await sendRafflePostPreview(target, userId, createdRaffle.id);

  return createdRaffle;
}

function buildRaffleText(raffle, participantsCount = 0, channels = []) {
  const prizes = raffle.prizes
    ? raffle.prizes
        .split('\n')
        .filter(Boolean)
        .map((p, i) => `${i + 1}. ${p}`)
        .join('\n')
    : '1. Главный приз';

  const channelsText = buildRafflePublicChannelsText(channels);

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
    `🕒 Публикация: **${formatDateTime(getRafflePublishAt(raffle))}**`,
    `⏰ Окончание: **${formatDateTime(raffle.end_at)}**`,
    channelsText ? '' : null,
    channelsText || null,
    '',
    'Чтобы участвовать, подпишитесь на каналы из списка выше и нажмите кнопку ниже.',
    '',
    buildRaffleFooter(raffle)
  ].filter(line => line !== null).join('\n');
}

async function publishRaffleToChannel(raffle, channelId) {
  const countRes = await pool.query(`
    SELECT COUNT(DISTINCT user_id)::int AS count
    FROM raffle_user_entry
    WHERE raffle_id = $1
  `, [raffle.id]);

  const participantsCount = countRes.rows[0].count || 0;
  const channels = await getRaffleChannels(raffle.id);
  const text = buildRaffleText(raffle, participantsCount, channels);

  const data = await sendMessage(
    {
      type: 'chat_id',
      id: channelId
    },
    text,
    [
      [{ text: '🎁 Участвовать', url: buildBotDeepLink(`join_${raffle.id}`) }]
    ],
    getRafflePhotoAttachments(raffle)
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
    `✅ Розыгрыш #${raffle.id} опубликован.\nНазвание: ${raffle.title}`
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
    const sub = await checkUserAllSubscriptions(raffle.id, user.user_id);

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
    const sub = await checkUserAllSubscriptions(raffle.id, row.user_id);
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
  const res = await pool.query(`
    SELECT
      COALESCE(SUM(CASE WHEN delta > 0 THEN 1 ELSE 0 END), 0)::int AS joined,
      COALESCE(SUM(CASE WHEN delta < 0 THEN 1 ELSE 0 END), 0)::int AS left_count
    FROM channel_member_events
    WHERE channel_id = $1
      AND event_at >= $2
      AND event_at <= $3
  `, [channelId, periodStart, periodEnd]);

  return {
    joined: res.rows[0]?.joined || 0,
    left: res.rows[0]?.left_count || 0
  };
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
    for (const ch of channels) {
      const channelStats = await getChannelPeriodStats(ch.channel_id, periodStart, periodEnd);
      text += `• ${formatChannelWithLink(ch)} — +${channelStats.joined} / -${channelStats.left}\n`;
    }

    text += '\n+ и - считаются по webhook-событиям MAX о вступлениях/выходах, если MAX их присылает боту.\n';
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

async function recordPendingRaffleJoin(raffleId, userId, invitedBy = null) {
  const ref = normalizeReferralId(invitedBy, userId);

  // Старые базы могли не иметь уникального индекса (raffle_id, user_id), поэтому вместо
  // ON CONFLICT делаем безопасный UPDATE -> INSERT. При наличии индекса ловим дубль 23505.
  const updated = await pool.query(`
    UPDATE raffle_pending_joins
    SET
      invited_by = COALESCE(invited_by, $3),
      status = CASE
        WHEN status = 'completed' THEN 'completed'
        ELSE 'pending'
      END,
      updated_at = NOW()
    WHERE raffle_id = $1 AND user_id = $2
    RETURNING id
  `, [raffleId, userId, ref]);

  if (updated.rows.length) return;

  try {
    await pool.query(`
      INSERT INTO raffle_pending_joins (
        raffle_id,
        user_id,
        invited_by,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'pending', NOW(), NOW())
    `, [raffleId, userId, ref]);
  } catch (error) {
    if (error?.code === '23505') {
      await pool.query(`
        UPDATE raffle_pending_joins
        SET
          invited_by = COALESCE(invited_by, $3),
          status = CASE
            WHEN status = 'completed' THEN 'completed'
            ELSE 'pending'
          END,
          updated_at = NOW()
        WHERE raffle_id = $1 AND user_id = $2
      `, [raffleId, userId, ref]);
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

function buildJoinIntroText(raffle, channels = []) {
  const requiredChannels = channels.filter(ch => ch.is_required);
  const channelsText = buildRafflePublicChannelsText(requiredChannels.length ? requiredChannels : channels);

  return [
    `🎁 **Участие в розыгрыше #${getRafflePublicNumber(raffle)}**`,
    '',
    `**${displayValue(raffle.title, 'Без названия')}**`,
    '',
    requiredChannels.length
      ? 'Чтобы принять участие, подпишитесь на каналы розыгрыша:'
      : 'В этом розыгрыше нет обязательных каналов для подписки.',
    channelsText || '',
    '',
    'После подписки нажмите кнопку **✅ Проверить подписку**.',
    'Билет будет создан только после успешной проверки.',
    '',
    `Окончание: **${formatDateTime(raffle.end_at)}**`
  ].filter(Boolean).join('\n');
}

async function showJoinRaffleStart(target, userId, raffleId, invitedBy = null) {
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

  await recordPendingRaffleJoin(raffle.id, userId, invitedBy);

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

async function completeJoinRaffleAfterCheck(target, userId, raffleId, invitedBy = null) {
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

  await recordPendingRaffleJoin(raffle.id, userId, invitedBy);

  const sub = await checkUserAllSubscriptions(raffle.id, userId);

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

  const entry = await createParticipantEntry(raffle.id, userId, invitedBy);
  await markPendingRaffleJoinCompleted(raffle.id, userId);

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
        buildProfileLinkInstruction()
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
      bonusLine,
      '',
      buildProfileLinkInstruction()
    ].filter(Boolean).join('\n'),
    buildBotBrandKeyboard()
  );
}

async function joinRaffle(target, userId, raffleId, invitedBy = null) {
  return showJoinRaffleStart(target, userId, raffleId, invitedBy);
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
      'Управление доступно через кнопки ниже.'
    ].join('\n'),
    [
      [{ text: '📊 Статистика', callback_data: 'admin_stats' }],
      [{ text: '🔥 Активные розыгрыши', callback_data: 'admin_active' }],
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
  const keyboard = [];

  for (const r of res.rows) {
    text += `#${r.id} | ${displayValue(r.title, 'Без названия')} | ${formatRaffleStatus(r.status)} | до ${formatDateTime(r.end_at)}\n`;
    text += `Создатель: ${displayValue(r.creator_user_id, 'не указан')}\n\n`;

    keyboard.push([
      { text: `📊 #${r.id}`, callback_data: `raffle_stats:${r.id}` },
      { text: `🏆 Завершить #${r.id}`, callback_data: `pick_raffle:${r.id}` }
    ]);
  }

  keyboard.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);

  return sendMessage(target, text, keyboard);
}

// =========================
// Callback
// =========================
async function sendUserRaffles(target, userId) {
  const raffles = await getUserRaffles(userId);

  if (!raffles.length) {
    return sendMessage(
      target,
      'У вас пока нет розыгрышей.',
      [[{ text: '🎉 Создать розыгрыш', callback_data: 'create_raffle' }]]
    );
  }

  let text = `🔎 **Ваши последние ${USER_RAFFLES_VISIBLE_LIMIT} розыгрышей:**\n\nСтарые завершённые/черновые розыгрыши скрываются из списка, чтобы не создавать мусор. Активные и запланированные розыгрыши не удаляются, статистика и данные сохраняются.\n\n`;
  const keyboard = [];

  for (const r of raffles) {
    text += `#${r.id} | ${displayValue(r.title, 'Без названия')} | ${formatRaffleStatus(r.status)} | публикация ${formatDateTime(getRafflePublishAt(r))} | до ${formatDateTime(r.end_at)}\n\n`;

    const row = [
      { text: `🔄 #${r.id}`, callback_data: `refresh_raffle:${r.id}` },
      { text: `📊 #${r.id}`, callback_data: `raffle_stats:${r.id}` }
    ];

    if (r.status === 'scheduled') {
      row.push({ text: '🚀 Сейчас', callback_data: `start_raffle_now:${r.id}` });
      row.push({ text: '✏️', callback_data: `edit_raffle:${r.id}` });
    }

    if (['scheduled', 'active'].includes(r.status)) {
      row.push({ text: `⏹ Стоп`, callback_data: `stop_raffle:${r.id}` });
    }

    if (r.status === 'finished') {
      row.push({ text: '🔁 Переиграть', callback_data: `reroll_winners:${r.id}` });
    }

    keyboard.push(row);
  }

  keyboard.push([{ text: '🎉 Создать розыгрыш', callback_data: 'create_raffle' }]);
  keyboard.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);

  return sendMessage(target, text, keyboard);
}

async function handleCallbackQuery(cb) {
  const userId = cb.from.id;
  const target = cb.message.chat.id;
  const data = cb.data;

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

  if (data === 'add_channel') {
    await sendAddChannelInstruction(target);
    return;
  }

  if (data === 'my_channels') {
    await sendMyChannels(target, userId);
    return;
  }

  if (data === 'refresh_channels') {
    await refreshUserChannels(target, userId);
    return;
  }

  if (data === 'create_raffle') {
    await setSession(userId, 'await_title', {});
    await sendMessage(target, 'Введите название розыгрыша:');
    return;
  }

  if (data === 'my_raffles') {
    await sendUserRaffles(target, userId);
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

  if (data.startsWith('stop_raffle:')) {
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

    await sendChannelSelectionMenu(target, userId, result.data, 'create');
    return;
  }

  if (data.startsWith('raffle_ch_req:')) {
    const channelId = unsafeCallbackPart(data.split(':')[1] || '');
    const result = await toggleSessionChannelFlag(userId, channelId, 'is_required');

    if (!result || result.missing) {
      await sendMessage(target, 'Сначала выберите канал.');
      return;
    }

    await sendChannelSelectionMenu(target, userId, result.data, 'create');
    return;
  }

  if (data.startsWith('raffle_ch_pub:')) {
    const channelId = unsafeCallbackPart(data.split(':')[1] || '');
    const result = await toggleSessionChannelFlag(userId, channelId, 'publish_post');

    if (!result || result.missing) {
      await sendMessage(target, 'Сначала выберите канал.');
      return;
    }

    await sendChannelSelectionMenu(target, userId, result.data, 'create');
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

    await sendChannelSelectionMenu(target, userId, result.data, 'collab');
    return;
  }

  if (data.startsWith('collab_ch_req:')) {
    const channelId = unsafeCallbackPart(data.split(':')[1] || '');
    const result = await toggleSessionChannelFlag(userId, channelId, 'is_required');

    if (!result || result.missing) {
      await sendMessage(target, 'Сначала выберите канал.');
      return;
    }

    await sendChannelSelectionMenu(target, userId, result.data, 'collab');
    return;
  }

  if (data.startsWith('collab_ch_pub:')) {
    const channelId = unsafeCallbackPart(data.split(':')[1] || '');
    const result = await toggleSessionChannelFlag(userId, channelId, 'publish_post');

    if (!result || result.missing) {
      await sendMessage(target, 'Сначала выберите канал.');
      return;
    }

    await sendChannelSelectionMenu(target, userId, result.data, 'collab');
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

  if (data.startsWith('pick_raffle:')) {
    const raffleId = Number(data.split(':')[1]);
    const raffle = await getRaffleById(raffleId);

    if (!raffle) {
      await sendMessage(target, 'Розыгрыш не найден.');
      return;
    }

    const canPick =
      Number(raffle.creator_user_id) === Number(userId) ||
      isAdmin(userId);

    if (!canPick) {
      await sendMessage(target, 'Только создатель или админ может выбрать победителей.');
      return;
    }

    await finishRaffle(raffleId);
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


async function autoSaveCallbackProfileLink(update, userId) {
  // callback_id в MAX — это ID конкретного нажатия кнопки, а не token профиля.
  // Автоматически сохраняем только те ссылки/username, которые MAX реально прислал
  // в webhook-объекте пользователя. Дополнительно профиль может сохраниться из
  // ответа /chats/{channelId}/members во время проверки подписки.
  const id = String(userId || '').trim();
  if (!id) return null;

  const candidates = [
    update?.callback?.user,
    update?.user,
    update?.message?.sender,
    update?.callback?.message?.recipient,
    update
  ].filter(Boolean);

  for (const candidate of candidates) {
    const saved = await saveUserProfileFromMaxObject(id, candidate, 'webhook_user_object');
    if (saved?.profile_link || saved?.username) return saved;
  }

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
    const parts = normalized.replace(/^join_/, '').split('_');
    const raffleId = Number(parts[0]);
    const ref = parts[1] ? Number(parts[1]) : null;

    if (Number.isInteger(raffleId)) {
      await showJoinRaffleStart(target, from.id, raffleId, ref);
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
  if (!isChatTarget(target)) return;

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

      if (isRateLimited(cb.from.id)) {
        await answerMaxCallback(callbackId, '⏳ Слишком часто. Попробуйте позже.');
        return;
      }


      await ensureUser(cb.from);
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

    if (isRateLimited(from.id)) {
      await sendMessage(chatTarget, '⏳ Слишком много запросов. Попробуйте чуть позже.');
      return;
    }

    const lowerText = text.trim().toLowerCase();

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

    const handledBySession = await handleSessionMessage(message);

    if (handledBySession) return;

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

    if (text === '/create' || text.toLowerCase() === 'создать розыгрыш') {
      await setSession(from.id, 'await_title', {});
      await sendMessage(chatTarget, 'Введите название розыгрыша:');
      return;
    }

    if (text === '/my' || text.toLowerCase() === 'мои розыгрыши') {
      await sendUserRaffles(chatTarget, from.id);
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
      const parts = text.replace('/join_', '').split('_');
      const raffleId = Number(parts[0]);
      const ref = parts[1] ? Number(parts[1]) : null;

      if (!Number.isInteger(raffleId)) {
        await sendMessage(chatTarget, 'Некорректная ссылка участия. Откройте розыгрыш через кнопку участия.');
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
    ? `join_${raffleId}_${ref}`
    : `join_${raffleId}`;
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
  const buttonUrl = buildBotDeepLink(`collab_${token}`);

  res.type('html').send(renderLandingPage({
    title: 'Совместный розыгрыш',
    heading: '🤝 Совместный розыгрыш',
    description: 'Откройте бота, добавьте его администратором в свой канал и выберите условия: размещать пост в канале или нет, делать подписку обязательной или нет.',
    buttonText: 'Открыть бота',
    buttonUrl
  }));
});

app.post(['/', '/webhook'], (req, res) => {
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
      profile_link TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS profile_link TEXT;

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
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (raffle_id, user_id)
    );

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
      created_at TIMESTAMP DEFAULT NOW()
    );

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
      created_at TIMESTAMP DEFAULT NOW()
    );

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

    CREATE INDEX IF NOT EXISTS ix_channel_member_events_channel_period
    ON channel_member_events (channel_id, event_at);

    CREATE INDEX IF NOT EXISTS ix_raffles_status_end_at
    ON raffles (status, end_at);

    CREATE INDEX IF NOT EXISTS ix_raffles_creator_visible
    ON raffles (creator_user_id, is_hidden_from_my_raffles, id DESC);

    CREATE INDEX IF NOT EXISTS ix_raffle_queue_status_scheduled
    ON raffle_queue (status, scheduled_at);

    CREATE INDEX IF NOT EXISTS ix_raffle_participants_raffle_valid
    ON raffle_participants (raffle_id, is_valid);

    CREATE INDEX IF NOT EXISTS ix_raffle_participants_referral_bonus
    ON raffle_participants (raffle_id, user_id, ticket_type);

    CREATE INDEX IF NOT EXISTS ix_raffle_pending_joins_status
    ON raffle_pending_joins (raffle_id, status, updated_at);

    CREATE INDEX IF NOT EXISTS ix_raffle_channels_raffle
    ON raffle_channels (raffle_id);

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

    await getMaxMe().catch(error => {
      console.warn('⚠️ MAX /me check failed:', error.message);
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