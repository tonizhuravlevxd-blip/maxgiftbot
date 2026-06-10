'use strict';

const crypto = require('crypto');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeHttpUrl(value) {
  const text = String(value || '').trim();
  if (!/^https?:\/\//i.test(text)) return '';
  try {
    const url = new URL(text);
    return url.toString();
  } catch {
    return '';
  }
}

function splitPayloadText(text) {
  return String(text || '')
    .split('|')
    .map(part => part.trim());
}

function formatChannelTitle(channel) {
  return String(channel?.channel_title || channel?.chat_title || `Канал ${channel?.channel_id || ''}`).trim();
}

function tpostResultData(kind) {
  const variants = {
    trust: {
      title: 'Доверчивая личность',
      emoji: '💛',
      text: 'Вы тип человека, который пускает почти любого в свою жизнь и сердце. Вы считаете, что лучше рискнуть и получить травму, чем закрыть себя от людей. Вы никому не показываете свои страхи и неуверенность. Вы считаете, что сами должны решать свои проблемы. Вы пытаетесь отдавать всего себя людям, даже если у самого на душе кошки скребут. Помогая другим, Вы залечиваете свои раны.'
    },
    pedant: {
      title: 'Педантичная личность',
      emoji: '📌',
      text: 'Вы тип человека, который всегда пытается произвести хорошее впечатление и поступать правильно. Вы полагаете, что Ваши поступки имеют значение в жизни других. Вы не показываете людям своё волнение и то, что Вы расстроены. Вы стараетесь быть лучше, ведь это — самое малое, что Вы можете сделать со своим временем на этой планете.'
    },
    energy: {
      title: 'Энергичная личность',
      emoji: '⚡',
      text: 'Вы тип человека, который всё время энергичен или... влюблён. Вы очень проницательны. Вы или любите, или ненавидите. У Вас есть тонна и больше мнений. На поступки Вы решаетесь быстро. В Вас много энергии, но зачастую Вы бываете нервным. Всё для Вас — очень большая ставка. Иногда Вы не можете не создавать драму у себя в голове.'
    },
    intuitive: {
      title: 'Интуитивная личность',
      emoji: '🔮',
      text: 'Вы тип человека, который очень хорошо понимает мир и других людей. Можете сказать очень многое по выражению лица или по тону голоса человека. Чувствуете, когда Вам лгут. Вы показываете миру только то, что хотите показать. Вы чувствуете, когда Вами манипулируют, и знаете, как управлять кем-то, если это нужно. Но обычно Вы не прибегаете к этому.'
    }
  };

  return variants[String(kind || '').trim()] || variants.trust;
}

function renderResultPage(kind, deps = {}) {
  const result = tpostResultData(kind);
  const botName = escapeHtml(deps.botBrandName || 'РОЗЫГРЫШ БОТ');

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Результат теста — ${escapeHtml(result.title)}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      background: radial-gradient(circle at top, #fff6d8 0%, #f7f7ff 42%, #ececff 100%);
      color: #161616;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
    }
    .card {
      width: 100%;
      max-width: 640px;
      background: rgba(255,255,255,.92);
      border: 1px solid rgba(0,0,0,.06);
      border-radius: 28px;
      padding: 28px;
      box-shadow: 0 18px 55px rgba(0,0,0,.12);
    }
    .label {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
      color: #6a5acd;
      margin-bottom: 12px;
    }
    .emoji { font-size: 52px; line-height: 1; margin-bottom: 12px; }
    h1 { margin: 0 0 16px; font-size: clamp(28px, 7vw, 44px); line-height: 1.05; }
    p { font-size: 18px; line-height: 1.65; margin: 0; }
    .footer { margin-top: 22px; font-size: 13px; color: #686868; }
    @media (prefers-color-scheme: dark) {
      body { background: radial-gradient(circle at top, #352b10 0%, #171727 50%, #0d0d16 100%); color: #f5f5f5; }
      .card { background: rgba(26,26,38,.94); border-color: rgba(255,255,255,.08); }
      .footer { color: #a9a9b8; }
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="label">Результат теста</div>
    <div class="emoji">${escapeHtml(result.emoji)}</div>
    <h1>${escapeHtml(result.title)}</h1>
    <p>${escapeHtml(result.text)}</p>
    <div class="footer">${botName}</div>
  </main>
</body>
</html>`;
}

function buildResultButtons(baseUrl) {
  const cleanBase = String(baseUrl || '').replace(/\/+$/, '');
  return [
    [
      { text: '1️⃣ Результат 1', url: `${cleanBase}/tpost/result/trust` },
      { text: '2️⃣ Результат 2', url: `${cleanBase}/tpost/result/pedant` }
    ],
    [
      { text: '3️⃣ Результат 3', url: `${cleanBase}/tpost/result/energy` },
      { text: '4️⃣ Результат 4', url: `${cleanBase}/tpost/result/intuitive` }
    ]
  ];
}

function parseLocalDateTimeToUtcIso(value, offsetMinutes = 180) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  const utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - Number(offsetMinutes || 0) * 60_000;
  const date = new Date(utcMs);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function formatDateForUser(value, offsetMinutes = 180, timezoneLabel = 'МСК') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'не указано';
  const shifted = new Date(date.getTime() + Number(offsetMinutes || 0) * 60_000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mi = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy} ${hh}:${mi} ${timezoneLabel}`;
}

async function createTables({ pool }) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tpost_autopost_jobs (
      id SERIAL PRIMARY KEY,
      admin_user_id BIGINT NOT NULL,
      channel_id BIGINT NOT NULL,
      channel_title TEXT,
      image_url TEXT,
      post_text TEXT NOT NULL,
      scheduled_at TIMESTAMP NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error_text TEXT,
      sent_message_id TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      sent_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS ix_tpost_jobs_status_scheduled
      ON tpost_autopost_jobs (status, scheduled_at, id);

    CREATE TABLE IF NOT EXISTS tpost_sessions (
      user_id BIGINT PRIMARY KEY,
      channel_id BIGINT NOT NULL,
      channel_title TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

function initTPostModule(deps) {
  const {
    app,
    pool,
    sendMessage,
    isAdmin,
    safeText,
    markdownLink,
    appBaseUrl,
    botUtcOffsetMinutes = 180,
    botTimezoneLabel = 'МСК',
    botBrandName = 'РОЗЫГРЫШ БОТ'
  } = deps;

  const baseUrl = String(appBaseUrl || '').replace(/\/+$/, '');
  const sendDelayMs = Math.max(5000, Number(process.env.TPOST_WORKER_INTERVAL_MS || 15000));

  app.get('/tpost', (_req, res) => {
    res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Тесты</title></head><body style="font-family:Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 18px;line-height:1.6"><h1>Тестовые mini web страницы</h1><p>Эта страница используется ботом для кнопок тестов.</p><ul><li><a href="/tpost/result/trust">Результат 1</a></li><li><a href="/tpost/result/pedant">Результат 2</a></li><li><a href="/tpost/result/energy">Результат 3</a></li><li><a href="/tpost/result/intuitive">Результат 4</a></li></ul></body></html>`);
  });

  app.get('/tpost/result/:kind', (req, res) => {
    res.type('html').send(renderResultPage(req.params.kind, { botBrandName }));
  });

  async function getAvailableChannels(userId) {
    const admin = isAdmin(userId);
    const res = await pool.query(
      admin
        ? `
          SELECT DISTINCT ON (channel_id) *
          FROM user_channels
          WHERE is_active = true
            AND COALESCE(can_publish, true) = true
          ORDER BY channel_id, updated_at DESC, id DESC
        `
        : `
          SELECT *
          FROM user_channels
          WHERE owner_user_id = $1
            AND is_active = true
            AND COALESCE(can_publish, true) = true
          ORDER BY updated_at DESC, id DESC
        `,
      admin ? [] : [String(userId)]
    );

    return res.rows || [];
  }

  async function getChannelForUser(userId, channelId) {
    const channels = await getAvailableChannels(userId);
    return channels.find(ch => String(ch.channel_id) === String(channelId)) || null;
  }

  async function sendTPostStart(target, userId) {
    if (!isAdmin(userId)) {
      await sendMessage(target, '⛔ Команда `/tpost` доступна только администратору бота.');
      return true;
    }

    const channels = await getAvailableChannels(userId);
    if (!channels.length) {
      await sendMessage(
        target,
        [
          '📭 Нет подключённых каналов с правом публикации.',
          '',
          'Добавьте бота администратором в канал и отправьте в канале сообщение **подключить канал**.'
        ].join('\n')
      );
      return true;
    }

    const keyboard = channels.slice(0, 20).map(ch => ([{
      text: `📢 ${String(formatChannelTitle(ch)).slice(0, 40)}`,
      callback_data: `tpost_ch:${ch.channel_id}`
    }]));

    await sendMessage(
      target,
      [
        '🧪 **Тестовый автопостинг /tpost**',
        '',
        'Выберите канал, куда нужно отправить тест-пост.',
        '',
        'После выбора отправьте одним сообщением:',
        '`сейчас | https://site.ru/photo.jpg | Текст поста`',
        '',
        'Или для публикации по времени:',
        '`2026-06-10 21:30 | https://site.ru/photo.jpg | Текст поста`',
        '',
        `Время указывайте по ${botTimezoneLabel}.`
      ].join('\n'),
      keyboard
    );

    return true;
  }

  async function handleCallback(cb) {
    const data = String(cb?.data || '');
    if (!data.startsWith('tpost_ch:')) return false;

    const userId = String(cb.from.id);
    const target = cb.message.chat.id;

    if (!isAdmin(userId)) {
      await sendMessage(target, '⛔ Нет доступа.');
      return true;
    }

    const channelId = data.split(':')[1];
    const channel = await getChannelForUser(userId, channelId);

    if (!channel) {
      await sendMessage(target, 'Канал не найден или у бота нет подтверждённого права публикации.');
      return true;
    }

    await pool.query(`
      INSERT INTO tpost_sessions (user_id, channel_id, channel_title, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET channel_id = EXCLUDED.channel_id, channel_title = EXCLUDED.channel_title, updated_at = NOW()
    `, [userId, channel.channel_id, formatChannelTitle(channel)]);

    await sendMessage(
      target,
      [
        `✅ Канал выбран: **${safeText(formatChannelTitle(channel), 120)}**`,
        '',
        'Теперь отправьте пост одним сообщением:',
        '',
        '`сейчас | https://site.ru/photo.jpg | Текст поста`',
        '',
        'Или:',
        '`2026-06-10 21:30 | https://site.ru/photo.jpg | Текст поста`',
        '',
        'Внизу поста автоматически будут 4 кнопки с mini web-результатами теста.'
      ].join('\n')
    );

    return true;
  }

  function parseDirectCommand(text) {
    const raw = String(text || '').trim();
    const direct = raw.match(/^\/tpost\s+(now|сейчас|at|время)\s+(-?\d+)\s*(.*)$/i);
    if (!direct) return null;

    const mode = direct[1].toLowerCase();
    const channelId = direct[2];
    let rest = String(direct[3] || '').trim();
    if (rest.startsWith('|')) rest = rest.slice(1).trim();
    let scheduledAt = null;

    if (mode === 'at' || mode === 'время') {
      const m = rest.match(/^(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})\s*\|\s*(.+)$/s);
      if (!m) return { error: 'Используйте: `/tpost at CHANNEL_ID 2026-06-10 21:30 | PHOTO_URL | Текст поста`' };
      scheduledAt = parseLocalDateTimeToUtcIso(m[1], botUtcOffsetMinutes);
      rest = m[2];
    }

    const parts = splitPayloadText(rest);
    if (parts.length < 2) {
      return { error: 'Используйте: `/tpost now CHANNEL_ID | PHOTO_URL | Текст поста`' };
    }

    const imageUrl = normalizeHttpUrl(parts[0]);
    const postText = parts.slice(1).join(' | ').trim();

    return { channelId, scheduledAt, imageUrl, postText };
  }

  function parseSessionPayload(text) {
    const parts = splitPayloadText(text);
    if (parts.length < 3) return null;

    const first = String(parts[0] || '').trim().toLowerCase();
    const scheduledAt = ['сейчас', 'now'].includes(first)
      ? null
      : parseLocalDateTimeToUtcIso(parts[0], botUtcOffsetMinutes);

    const imageUrl = normalizeHttpUrl(parts[1]);
    const postText = parts.slice(2).join(' | ').trim();

    return { scheduledAt, imageUrl, postText };
  }

  async function scheduleOrSend({ target, userId, channelId, channelTitle, imageUrl, postText, scheduledAt }) {
    if (!postText || postText.length < 2) {
      await sendMessage(target, 'Текст поста пустой. Добавьте текст после второго символа `|`.');
      return true;
    }

    if (!imageUrl) {
      await sendMessage(target, 'Не вижу корректный URL фото. Он должен начинаться с `http://` или `https://`.');
      return true;
    }

    const scheduleDate = scheduledAt ? new Date(scheduledAt) : new Date();
    if (Number.isNaN(scheduleDate.getTime())) {
      await sendMessage(target, `Не понял время. Формат: \`2026-06-10 21:30\` по ${botTimezoneLabel}.`);
      return true;
    }

    const channel = await getChannelForUser(userId, channelId);
    if (!channel) {
      await sendMessage(target, 'Канал не найден или у бота нет подтверждённого права публикации.');
      return true;
    }

    const shouldSendNow = scheduleDate.getTime() <= Date.now() + 5000;

    const res = await pool.query(`
      INSERT INTO tpost_autopost_jobs (
        admin_user_id, channel_id, channel_title, image_url, post_text, scheduled_at, status, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING *
    `, [
      String(userId),
      String(channel.channel_id),
      formatChannelTitle(channel),
      imageUrl,
      safeText(postText, 3500),
      scheduleDate,
      shouldSendNow ? 'processing' : 'pending'
    ]);

    const job = res.rows[0];

    if (shouldSendNow) {
      await publishJob(job);
      await sendMessage(target, `✅ Тест-пост отправлен в канал **${safeText(formatChannelTitle(channel), 120)}**.`);
    } else {
      await sendMessage(
        target,
        [
          '🕒 Тест-пост запланирован.',
          `Канал: **${safeText(formatChannelTitle(channel), 120)}**`,
          `Время: **${formatDateForUser(scheduleDate, botUtcOffsetMinutes, botTimezoneLabel)}**`,
          `ID задания: **${job.id}**`
        ].join('\n')
      );
    }

    return true;
  }

  async function handleTextMessage(message, target, from) {
    const text = String(message?.text || '').trim();
    const userId = String(from?.id || '');

    if (!text) return false;

    if (text === '/tpost' || text.startsWith('/tpost ')) {
      const direct = parseDirectCommand(text);
      if (direct?.error) {
        await sendMessage(target, direct.error);
        return true;
      }

      if (direct) {
        if (!isAdmin(userId)) {
          await sendMessage(target, '⛔ Команда `/tpost` доступна только администратору бота.');
          return true;
        }

        return scheduleOrSend({
          target,
          userId,
          channelId: direct.channelId,
          channelTitle: '',
          imageUrl: direct.imageUrl,
          postText: direct.postText,
          scheduledAt: direct.scheduledAt
        });
      }

      return sendTPostStart(target, userId);
    }

    const sessionRes = await pool.query(
      `SELECT * FROM tpost_sessions WHERE user_id = $1 AND updated_at > NOW() - INTERVAL '30 minutes' LIMIT 1`,
      [userId]
    );

    const session = sessionRes.rows[0];
    if (!session) return false;

    const parsed = parseSessionPayload(text);
    if (!parsed) return false;

    await pool.query(`DELETE FROM tpost_sessions WHERE user_id = $1`, [userId]);

    return scheduleOrSend({
      target,
      userId,
      channelId: session.channel_id,
      channelTitle: session.channel_title,
      imageUrl: parsed.imageUrl,
      postText: parsed.postText,
      scheduledAt: parsed.scheduledAt
    });
  }

  async function sendChannelPost(job, withImage = true) {
    const keyboard = buildResultButtons(baseUrl);
    const extraAttachments = [];

    if (withImage && job.image_url) {
      extraAttachments.push({
        type: 'image',
        payload: {
          url: job.image_url
        }
      });
    }

    const imageLine = withImage ? '' : `\n\n🖼 Фото: ${job.image_url}`;
    return sendMessage(
      String(job.channel_id),
      `${String(job.post_text || '').trim()}${imageLine}`,
      keyboard,
      extraAttachments
    );
  }

  async function publishJob(job) {
    const id = Number(job.id);
    if (!id) return false;

    try {
      let result = null;
      try {
        result = await sendChannelPost(job, true);
      } catch (imageError) {
        console.warn('TPOST image attachment failed, sending text fallback:', imageError.message);
        result = await sendChannelPost(job, false);
      }

      await pool.query(`
        UPDATE tpost_autopost_jobs
        SET status = 'sent', sent_at = NOW(), sent_message_id = $2, error_text = NULL, updated_at = NOW()
        WHERE id = $1
      `, [id, String(result?.message?.body?.mid || result?.message_id || result?.id || '')]);

      return true;
    } catch (error) {
      await pool.query(`
        UPDATE tpost_autopost_jobs
        SET status = 'failed', error_text = $2, updated_at = NOW()
        WHERE id = $1
      `, [id, String(error?.message || error).slice(0, 1000)]);

      throw error;
    }
  }

  async function processDueJobs() {
    const res = await pool.query(`
      UPDATE tpost_autopost_jobs
      SET status = 'processing', updated_at = NOW()
      WHERE id IN (
        SELECT id
        FROM tpost_autopost_jobs
        WHERE status = 'pending'
          AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC, id ASC
        LIMIT 5
      )
      RETURNING *
    `);

    for (const job of res.rows) {
      await publishJob(job).catch(error => {
        console.error('TPOST publish failed:', error.message);
      });
    }
  }

  const interval = setInterval(() => {
    processDueJobs().catch(error => {
      console.error('TPOST worker error:', error.message);
    });
  }, sendDelayMs);
  interval.unref?.();

  return {
    handleTextMessage,
    handleCallback,
    processDueJobs
  };
}

module.exports = {
  createTables,
  initTPostModule
};
