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
const CHECK_INTERVAL_SECONDS = Number(process.env.CHECK_INTERVAL_SECONDS || 30);

const BOT_PUBLIC_URL = String(
  process.env.BOT_PUBLIC_URL ||
  process.env.MAX_BOT_LINK ||
  process.env.BOT_LINK ||
  APP_BASE_URL
).replace(/\/+$/, '');

const BOT_BRAND_NAME = process.env.BOT_BRAND_NAME || 'РОЗЫГРЫШ БОТ';

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

function formatChannelWithLink(channel) {
  const title = formatChannelName(channel);
  const link = String(channel?.channel_link || channel?.link || '').trim();

  return link ? markdownLink(title, link) : title;
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

    const info = await getChatInfoSafe(channelId) || candidate;
    const canUserManage = await isUserAdminInChannel(userId, channelId);

    if (!canUserManage) {
      skipped.push({ channelId, reason: 'user_not_admin' });
      continue;
    }

    const canPublish = await checkBotCanPublishInChannel(channelId, info);

    if (!canPublish) {
      skipped.push({ channelId, reason: 'bot_cannot_publish' });
      continue;
    }

    const meta = {
      title: extractTitleFromChatInfo(info) || candidate.chat_title || `Канал ${channelId}`,
      link: extractChatLinkFromObject(info) || candidate.chat_link || ''
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
        '1. бот добавлен в канал;',
        '2. у бота есть права администратора на размещение постов;',
        '3. вы сами являетесь администратором этого канала.',
        '',
        `Проверено активных увиденных каналов: ${result.checked}.`,
        '',
        'Бот больше не использует /me/chats. Кнопка **Обновить** проверяет только активные каналы, которые бот уже увидел через webhook-события MAX.',
        'Если вы только что удалили бота из канала, такой канал теперь исключается из проверки.',
        'Если канал не появился, добавьте бота обратно администратором и пришлите лог события добавления, если MAX его отправит.'
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
  const info = await getChatInfoSafe(channelId);
  const canUserManage = await isUserAdminInChannel(from.id, channelId);

  if (!canUserManage) return { ok: false, reason: 'user_not_admin' };

  const canPublish = await checkBotCanPublishInChannel(channelId, info);

  if (!canPublish) return { ok: false, reason: 'bot_cannot_publish' };

  const meta = await resolveChannelMeta(channelId, update);
  const channel = await upsertUserChannel(from.id, channelId, meta.title, meta.link, from.id, true);

  return { ok: true, channel };
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
      '1. Добавьте бота в канал.',
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
  keyboard.push([{ text: mode === 'collab' ? '✅ Добавить к розыгрышу' : '➡️ Создать розыгрыш', callback_data: mode === 'collab' ? 'collab_channels_done' : 'raffle_channels_done' }]);
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
    end_at: data.end_at,
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

  await addQueue(raffle.id, 'raffle_start', new Date());
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
      `Розыгрыш: **${raffle.title}**`,
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
    update?.message?.sender?.user_id ||
    update?.user?.user_id ||
    update?.user_id ||
    (target?.type === 'user_id' ? target.id : '') ||
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
    ? '\n\n👑 Вам доступна админ-панель в главном меню.'
    : '';

  return sendMessage(
    target,
    [
      '👋 **Привет! Я бот для честных розыгрышей в MAX.**',
      '',
      'Через меню можно создать розыгрыш, подключить свои каналы, включить обязательную подписку, разместить пост в канале и смотреть статистику.',
      '',
      'Чтобы публиковать розыгрыши в канале, сначала добавьте бота в подписчики канала и выдайте ему права администратора на размещение постов.',
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

      const query = { count: pageSize };
      if (marker) query.marker = marker;

      const result = await maxRequest(path, {
        method: 'GET',
        query
      });

      if (responseContainsActiveUser(result, expectedUserId)) {
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
    'Чтобы участвовать, нажмите кнопку ниже.',
    '',
    `Розыгрыш создан с помощью **${BOT_BRAND_NAME}**`
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
    buildBotBrandKeyboard([
      [{ text: '🎁 Участвовать', callback_data: `join_raffle:${raffle.id}` }]
    ])
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
    `✅ Розыгрыш #${raffle.id} запущен.\nНазвание: ${raffle.title}`
  ).catch(error => {
    console.warn('Не удалось уведомить создателя:', error.message);
  });
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

    if (uniqueByUser.length >= neededCount) break;
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
      text += `• ${formatChannelWithLink(ch)}\n`;
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
    data.channels = [];

    await setSession(userId, 'await_channel_selection', data);
    await sendChannelSelectionMenu(target, userId, data, 'create');

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
      text += `• ${formatChannelWithLink(ch)}\n`;
    }

    text += '\nПосле подписки снова нажмите кнопку участия.';

    return sendMessage(
      target,
      text,
      [[{ text: '✅ Я подписался, участвовать', callback_data: `join_raffle:${raffle.id}` }]]
    );
  }

  const entry = await createParticipantEntry(raffle.id, userId, invitedBy);

  if (entry.alreadyJoined) {
    return sendMessage(target, `✅ Вы уже участвуете в розыгрыше #${raffle.id}.`);
  }

  const refLink = buildJoinLink(raffle.id, userId);

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
    ].join('\n'),
    buildBotBrandKeyboard()
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
    text += `#${r.id} | ${r.title} | ${r.status} | до ${dayjs(r.end_at).format('DD.MM.YYYY HH:mm')}\n`;
    text += `Создатель: ${r.creator_user_id}\n\n`;

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

  let text = '🔎 **Ваши розыгрыши:**\n\n';
  const keyboard = [];

  for (const r of raffles) {
    text += `#${r.id} | ${r.title} | ${r.status} | до ${dayjs(r.end_at).format('DD.MM.YYYY HH:mm')}\n\n`;

    const row = [
      { text: `📊 #${r.id}`, callback_data: `raffle_stats:${r.id}` }
    ];

    if (['scheduled', 'active'].includes(r.status)) {
      row.push({ text: `🏆 Завершить`, callback_data: `pick_raffle:${r.id}` });
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

    const { raffle, inviteToken } = await createRaffleFromSession(userId, sessionData);
    await clearSession(userId);

    const inviteLink = buildRaffleInviteLink(inviteToken);
    const selected = sessionData.channels || [];
    const channelsText = selected.length
      ? selected.map(ch => `• ${formatChannelWithLink(ch)} — ${ch.is_required ? 'обязательная подписка' : 'подписка не обязательна'}, ${ch.publish_post ? 'с размещением' : 'без размещения'}`).join('\n')
      : 'Каналы не выбраны.';

    await sendMessage(
      target,
      [
        '✅ **Розыгрыш создан!**',
        '',
        `Название: **${sessionData.title}**`,
        `Окончание: **${dayjs(sessionData.end_at).format('DD.MM.YYYY HH:mm')}**`,
        '',
        '**Каналы:**',
        channelsText,
        '',
        '🤝 **Ссылка для совместного розыгрыша:**',
        inviteLink,
        '',
        'Отправьте её другому администратору. Он откроет бота, добавит своего бота-администратора в канал и выберет: публиковать пост в его канале или нет, делать подписку обязательной или нет.'
      ].join('\n'),
      [
        [{ text: '🤝 Пригласить соадмина', url: inviteLink }],
        [{ text: '📊 Статистика', callback_data: `raffle_stats:${raffle.id}` }],
        [{ text: '🔎 Мои розыгрыши', callback_data: 'my_raffles' }]
      ]
    );

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

    await joinRaffle(target, userId, raffleId, null);
    return;
  }

  if (data.startsWith('raffle_stats:')) {
    const raffleId = Number(data.split(':')[1]);

    if (!Number.isInteger(raffleId)) {
      await sendMessage(target, 'Некорректный ID розыгрыша.');
      return;
    }

    await sendRaffleStats(target, raffleId);
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
      await joinRaffle(target, from.id, raffleId, ref);
      return true;
    }
  }

  return false;
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

      if (await handleStartPayload(target, from, payload)) {
        return;
      }

      await sendWelcome(target, from.id);
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
            'Бот подтвердил, что видит канал и может публиковать посты.'
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

    const handledBySession = await handleSessionMessage(message);

    if (handledBySession) return;

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
      await sendUserRaffles(chatTarget, from.id);
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
