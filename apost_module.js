'use strict';

function setupApostModule(options) {
  const {
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
  } = options;

  const SESSION_TTL_MS = Number(process.env.APOST_SESSION_TTL_MS || 30 * 60 * 1000);
  const WORKER_INTERVAL_SECONDS = Math.max(10, Number(process.env.APOST_WORKER_INTERVAL_SECONDS || 30));
  const MAX_SCHEDULE_HOURS = Math.min(48, Math.max(1, Number(process.env.APOST_MAX_SCHEDULE_HOURS || 48)));
  const MORE_TESTS_URL = String(process.env.APOST_MORE_TESTS_URL || BOT_PUBLIC_URL || APP_BASE_URL || '').replace(/\/+$/, '');
  const MORE_TESTS_LABEL = String(process.env.APOST_MORE_TESTS_LABEL || 'тут').trim() || 'тут';
  const RESULT_BASE_URL = String(process.env.APOST_RESULT_BASE_URL || APP_BASE_URL || '').replace(/\/+$/, '');

  const DEFAULT_TESTS = [
    {
      id: 'personality_4',
      title: 'Тест: какая вы личность?',
      image_url: process.env.APOST_PERSONALITY_TEST_IMAGE_URL || 'https://dummyimage.com/1200x800/f5e8d6/333333.jpg&text=TEST',
      description: [
        '🧠 **Тест личности**',
        '',
        'Выберите один из 4 вариантов под постом и откройте свой результат.',
        'Тест лёгкий, развлекательный и хорошо подходит для вовлечения аудитории канала.'
      ].join('\n'),
      post_text: [
        '🧠 **Быстрый тест личности**',
        '',
        'Выберите вариант, который больше всего откликается, и нажмите кнопку ниже, чтобы открыть результат.',
        '',
        `Еще больше тестов ${MORE_TESTS_URL ? markdownLink(MORE_TESTS_LABEL, MORE_TESTS_URL) : MORE_TESTS_LABEL}`
      ].join('\n')
    }
  ];

  function parseConfiguredTests() {
    const raw = String(process.env.APOST_TESTS_JSON || '').trim();
    if (!raw) return DEFAULT_TESTS;

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.length) return DEFAULT_TESTS;

      return parsed
        .map((item, index) => ({
          id: String(item.id || `test_${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60),
          title: String(item.title || `Тест ${index + 1}`).trim().slice(0, 120),
          image_url: normalizeHttpLink(item.image_url || item.imageUrl || ''),
          description: String(item.description || item.desc || '').trim().slice(0, 2500),
          post_text: String(item.post_text || item.postText || item.description || '').trim().slice(0, 3500)
        }))
        .filter(item => item.id && item.title && item.post_text);
    } catch (error) {
      console.warn('APOST_TESTS_JSON parse failed:', error.message);
      return DEFAULT_TESTS;
    }
  }

  const TESTS = parseConfiguredTests();

  const TEST_RESULTS = {
    trust: {
      title: 'Доверчивая личность',
      text: 'Вы тип человека, который пускает почти любого в свою жизнь и сердце. Вы считаете, что лучше рискнуть и получить травму, чем закрыть себя от людей. Вы никому не показываете свои страхи и неуверенность. Вы считаете, что сами должны решать свои проблемы. Вы пытаетесь отдавать всего себя людям, даже если у самого на Душе кошки скребут. Помогая другим, Вы залечиваете свои раны.'
    },
    pedant: {
      title: 'Педантичная личность',
      text: 'Вы тип человека, который всегда пытается произвести хорошее впечатление и поступать правильно. Вы полагаете, что Ваши поступки имеют значение в жизни других. Вы не показываете людям своё волнение и то, что Вы расстроены. Вы стараетесь быть лучше, ведь это — самое малое, что Вы можете сделать со своим временем на этой планете.'
    },
    energy: {
      title: 'Энергичная личность',
      text: 'Вы тип человека, который всё время энергичен или... влюблён. Вы очень проницательны. Вы или любите или ненавидите. У Вас есть тонна и больше мнений... И на поступки Вы решаетесь быстро. В Вас много энергии, но зачастую Вы бываете нервным. Всё — для Вас очень большая ставка. Иногда Вы не можете не создавать драму у себя в голове.'
    },
    intuitive: {
      title: 'Интуитивная личность',
      text: 'Вы тип человека, который очень хорошо понимает мир и других людей. Можете сказать очень многое по выражению лица или по тону голоса человека. Чувствуете, когда Вам лгут. Вы показываете миру только то, что хотите показать. Вы чувствуете, когда Вами манипулируют, и знаете, как управлять кем-то, если это нужно. Но обычно Вы не прибегаете к этому.'
    }
  };

  function htmlEscape(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function moscowNow() {
    return new Date(Date.now() + Number(BOT_UTC_OFFSET_MINUTES || 180) * 60_000);
  }

  function formatMsk(date) {
    const d = new Date(date);
    const shifted = new Date(d.getTime() + Number(BOT_UTC_OFFSET_MINUTES || 180) * 60_000);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(shifted.getUTCDate())}.${pad(shifted.getUTCMonth() + 1)}.${shifted.getUTCFullYear()} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} МСК`;
  }

  function parseMskDate(text) {
    const clean = String(text || '').trim();
    const match = clean.match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?\s+(\d{1,2})[:.](\d{2})$/) ||
      clean.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2})[:.](\d{2})$/);

    if (!match) return null;

    let year; let month; let day; let hour; let minute;

    if (match[1].length === 4) {
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
      hour = Number(match[4]);
      minute = Number(match[5]);
    } else {
      day = Number(match[1]);
      month = Number(match[2]);
      const now = moscowNow();
      year = match[3] ? Number(match[3]) : now.getUTCFullYear();
      if (year < 100) year += 2000;
      hour = Number(match[4]);
      minute = Number(match[5]);
    }

    if (year < 2020 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }

    // Пользователь вводит МСК. Переводим в абсолютный UTC-момент.
    const utcMs = Date.UTC(year, month - 1, day, hour, minute, 0) - Number(BOT_UTC_OFFSET_MINUTES || 180) * 60_000;
    const date = new Date(utcMs);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function validateScheduleDate(date) {
    const now = new Date();
    const max = new Date(now.getTime() + MAX_SCHEDULE_HOURS * 60 * 60 * 1000);

    if (!date || Number.isNaN(date.getTime())) {
      return { ok: false, error: 'Не понял дату. Используйте формат `ДД.ММ ЧЧ:ММ` или `ДД.ММ.ГГГГ ЧЧ:ММ`.' };
    }

    if (date.getTime() < now.getTime() - 60_000) {
      return { ok: false, error: 'Нельзя поставить автопост в прошлое.' };
    }

    if (date.getTime() > max.getTime()) {
      return { ok: false, error: `Планировать можно максимум на ${MAX_SCHEDULE_HOURS} часов вперёд, чтобы посты не копились в базе.` };
    }

    return { ok: true };
  }

  function buildImageAttachment(imageUrl) {
    const url = normalizeHttpLink(imageUrl);
    if (!url) return null;
    return {
      type: 'image',
      url,
      payload: { url }
    };
  }

  function isPhotoLikeAttachment(attachment) {
    if (!attachment || typeof attachment !== 'object') return false;

    const type = String(attachment.type || attachment.attachment_type || '').toLowerCase();
    const payloadType = String(attachment.payload?.type || attachment.payload?.media_type || '').toLowerCase();
    const mime = String(attachment.payload?.mime_type || attachment.mime_type || '').toLowerCase();

    return type.includes('image') ||
      type.includes('photo') ||
      payloadType.includes('image') ||
      payloadType.includes('photo') ||
      mime.startsWith('image/');
  }

  function normalizePhotoAttachmentForReuse(attachment) {
    if (!attachment || typeof attachment !== 'object') return null;

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

  function extractMessageAttachments(message) {
    const candidates = [
      message?.attachments,
      message?.body?.attachments,
      message?.message?.attachments,
      message?.message?.body?.attachments,
      message?.payload?.attachments
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
    }

    return [];
  }

  function extractPhotoAttachmentFromMessage(message) {
    const attachments = extractMessageAttachments(message);
    const photo = attachments.find(isPhotoLikeAttachment);
    return normalizePhotoAttachmentForReuse(photo);
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

    return typeof value === 'object' ? value : null;
  }

  function buildPostAttachment(data = {}) {
    const uploadedPhoto = normalizeStoredPhotoAttachment(data.photo_attachment || data.photoAttachment);
    if (uploadedPhoto) return uploadedPhoto;

    return buildImageAttachment(data.image_url);
  }

  function testResultUrl(key) {
    const base = RESULT_BASE_URL || APP_BASE_URL;
    return `${base}/apost/test/${encodeURIComponent(key)}`;
  }

  function buildTestButtons() {
    return [
      [
        { text: '1️⃣ Вариант 1', url: testResultUrl('trust') },
        { text: '2️⃣ Вариант 2', url: testResultUrl('pedant') }
      ],
      [
        { text: '3️⃣ Вариант 3', url: testResultUrl('energy') },
        { text: '4️⃣ Вариант 4', url: testResultUrl('intuitive') }
      ]
    ];
  }

  function buildAutopostMenuKeyboard() {
    return [
      [{ text: '📝 Автопост', callback_data: 'apost_autopost' }],
      [{ text: '🧠 ТЕСТЫ', callback_data: 'apost_tests' }],
      [{ text: '📅 Мои посты запланированные', callback_data: 'apost_my_posts' }],
      [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
    ];
  }

  async function initDb() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS apost_sessions (
        user_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS apost_jobs (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_title TEXT,
        post_type TEXT NOT NULL DEFAULT 'post',
        title TEXT,
        text TEXT NOT NULL,
        image_url TEXT,
        photo_attachment JSONB,
        buttons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        scheduled_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled',
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS ix_apost_jobs_due
      ON apost_jobs (status, scheduled_at);

      CREATE INDEX IF NOT EXISTS ix_apost_jobs_user
      ON apost_jobs (user_id, status, scheduled_at);
    `);

    // Для уже существующей базы аккуратно добавляем колонку под фото,
    // отправленное с телефона. Если колонка уже есть — ничего не ломаем.
    await pool.query(`ALTER TABLE apost_jobs ADD COLUMN IF NOT EXISTS photo_attachment JSONB`);
  }

  async function cleanupDb() {
    await pool.query(`DELETE FROM apost_sessions WHERE updated_at < NOW() - INTERVAL '2 hours'`);
    await pool.query(`DELETE FROM apost_jobs WHERE status IN ('published', 'cancelled') AND COALESCE(published_at, created_at) < NOW() - INTERVAL '10 minutes'`);
    await pool.query(`DELETE FROM apost_jobs WHERE scheduled_at < NOW() - INTERVAL '2 hours' AND status <> 'scheduled'`);
  }

  async function setApostSession(userId, state, data = {}) {
    await pool.query(`
      INSERT INTO apost_sessions (user_id, state, data, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET state = EXCLUDED.state, data = EXCLUDED.data, updated_at = NOW()
    `, [String(userId), state, JSON.stringify(data || {})]);
  }

  async function getApostSession(userId) {
    const res = await pool.query(`SELECT * FROM apost_sessions WHERE user_id = $1`, [String(userId)]);
    const row = res.rows[0] || null;
    if (!row) return null;

    const updatedAt = new Date(row.updated_at).getTime();
    if (Date.now() - updatedAt > SESSION_TTL_MS) {
      await clearApostSession(userId);
      return null;
    }

    return {
      state: row.state,
      data: typeof row.data === 'string' ? JSON.parse(row.data || '{}') : row.data || {}
    };
  }

  async function clearApostSession(userId) {
    await pool.query(`DELETE FROM apost_sessions WHERE user_id = $1`, [String(userId)]);
  }

  async function getUserPublishChannels(userId) {
    const res = await pool.query(`
      SELECT channel_id, channel_title, channel_link, can_publish, is_active
      FROM user_channels
      WHERE owner_user_id = $1
        AND COALESCE(is_active, true) = true
        AND COALESCE(can_publish, true) = true
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT 30
    `, [String(userId)]);

    return res.rows || [];
  }

  function selectedChannels(data) {
    return Array.isArray(data.channels) ? data.channels.map(String).filter(Boolean) : [];
  }

  async function sendApostMenu(target) {
    return sendMessage(target, [
      '📌 **Автопостинг**',
      '',
      'Выберите раздел:',
      '',
      '📝 **Автопост** — создать свой пост: фото с телефона + текст Markdown, предпросмотр, время и канал.',
      '🧠 **ТЕСТЫ** — выбрать готовый тест и запланировать публикацию в свой канал.',
      '',
      `Планирование доступно максимум на **${MAX_SCHEDULE_HOURS} часов** вперёд. После публикации запись очищается из базы.`
    ].join('\n'), buildAutopostMenuKeyboard());
  }

  async function startAutopost(target, userId) {
    await setApostSession(userId, 'apost_wait_photo', {});
    return sendMessage(target, [
      '📝 **Новый автопост**',
      '',
      'Отправьте **фото с телефона** одним сообщением — так же, как при создании розыгрыша.',
      '',
      'После фото бот попросит текст поста. Можно использовать Markdown.',
      '',
      'Если отправите фото с подписью, бот сразу возьмёт подпись как текст поста и покажет предпросмотр.'
    ].join('\n'), [[{ text: '⬅️ Назад', callback_data: 'apost_menu' }]]);
  }

  function buildAutopostDataFromPhoto(photoAttachment, text) {
    const postText = safeText(String(text || '').trim(), 3500);

    if (!photoAttachment || !postText) return null;

    return {
      type: 'post',
      title: 'Автопост',
      text: postText,
      image_url: '',
      photo_attachment: photoAttachment
    };
  }

  async function sendPostPreview(target, userId, data, type = 'post') {
    const keyboard = type === 'test'
      ? [
          ...buildTestButtons(),
          [{ text: '✅ Выбрать этот тест', callback_data: 'apost_preview_ok' }],
          [{ text: '❌ Нет, назад', callback_data: 'apost_tests' }]
        ]
      : [
          [{ text: '✅ Подтвердить пост', callback_data: 'apost_preview_ok' }],
          [{ text: '✏️ Изменить', callback_data: 'apost_autopost' }],
          [{ text: '❌ Отмена', callback_data: 'apost_cancel' }]
        ];

    const attachment = buildPostAttachment(data);
    const previewText = [
      type === 'test' ? '👀 **Предпросмотр теста**' : '👀 **Предпросмотр поста**',
      '',
      data.text || data.post_text || ''
    ].join('\n');

    return sendMessage(target, previewText, keyboard, attachment ? [attachment] : []);
  }

  async function sendTimeMenu(target, userId) {
    return sendMessage(target, [
      '🕒 **Выберите время публикации**',
      '',
      'Можно опубликовать сразу или выбрать время максимум на 2 дня вперёд.',
      '',
      'Также можно написать время текстом:',
      '`ДД.ММ ЧЧ:ММ`',
      'например: `12.06 18:30`'
    ].join('\n'), [
      [{ text: '🚀 Сейчас', callback_data: 'apost_time:now' }],
      [
        { text: '+1 час', callback_data: 'apost_time:1h' },
        { text: '+3 часа', callback_data: 'apost_time:3h' }
      ],
      [
        { text: '+12 часов', callback_data: 'apost_time:12h' },
        { text: '+1 день', callback_data: 'apost_time:24h' }
      ],
      [{ text: '✍️ Ввести время текстом', callback_data: 'apost_time_custom' }],
      [{ text: '⬅️ Назад к предпросмотру', callback_data: 'apost_back_preview' }]
    ]);
  }

  async function sendChannelSelect(target, userId, data) {
    const channels = await getUserPublishChannels(userId);

    if (!channels.length) {
      return sendMessage(target, [
        '📢 **Каналы не найдены**',
        '',
        'Сначала добавьте бота администратором в канал и нажмите **Добавить канал / Обновить** в главном меню.',
        'Для автопоста нужны права на публикацию.'
      ].join('\n'), [
        [{ text: '📢 Мои каналы', callback_data: 'my_channels' }],
        [{ text: '⬅️ Назад', callback_data: 'apost_menu' }]
      ]);
    }

    const selected = new Set(selectedChannels(data));
    const keyboard = channels.map(channel => {
      const id = String(channel.channel_id);
      const mark = selected.has(id) ? '✅' : '⬜';
      const title = String(channel.channel_title || channel.channel_id).slice(0, 38);
      return [{ text: `${mark} ${title}`, callback_data: `apost_ch:${encodeURIComponent(id)}` }];
    });

    keyboard.push([{ text: '✅ Готово', callback_data: 'apost_channels_done' }]);
    keyboard.push([{ text: '⬅️ Назад ко времени', callback_data: 'apost_back_time' }]);

    return sendMessage(target, [
      '📢 **Выберите канал или несколько каналов**',
      '',
      'Нажимайте на каналы, чтобы выбрать/снять выбор.',
      '',
      selected.size ? `Выбрано: **${selected.size}**` : 'Пока ничего не выбрано.'
    ].join('\n'), keyboard);
  }

  async function sendFinalConfirm(target, userId, data) {
    const channels = await getUserPublishChannels(userId);
    const selected = selectedChannels(data);
    const selectedRows = channels.filter(ch => selected.includes(String(ch.channel_id)));

    if (!selectedRows.length) {
      return sendChannelSelect(target, userId, data);
    }

    const lines = selectedRows.map((ch, i) => `${i + 1}. ${formatChannelWithLink(ch)}`);

    return sendMessage(target, [
      '✅ **Подтвердите автопост**',
      '',
      `Тип: **${data.type === 'test' ? 'Тест' : 'Обычный пост'}**`,
      `Время: **${formatMsk(data.scheduled_at)}**`,
      '',
      '**Каналы:**',
      ...lines,
      '',
      'После подтверждения пост появится в разделе **Мои посты запланированные**.'
    ].join('\n'), [
      [{ text: '✅ Подтвердить автопост', callback_data: 'apost_confirm' }],
      [{ text: '⬅️ Назад к каналам', callback_data: 'apost_back_channels' }],
      [{ text: '❌ Отмена', callback_data: 'apost_cancel' }]
    ]);
  }

  async function createJobs(userId, data) {
    const channels = await getUserPublishChannels(userId);
    const selected = selectedChannels(data);
    const selectedRows = channels.filter(ch => selected.includes(String(ch.channel_id)));

    if (!selectedRows.length) {
      throw new Error('Не выбран канал для публикации.');
    }

    const buttons = data.type === 'test' ? buildTestButtons() : [];
    const values = [];
    const params = [];
    let p = 1;

    for (const ch of selectedRows) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++}::jsonb, $${p++})`);
      params.push(
        String(userId),
        String(ch.channel_id),
        String(ch.channel_title || ''),
        data.type === 'test' ? 'test' : 'post',
        String(data.title || (data.type === 'test' ? 'Тест' : 'Автопост')).slice(0, 200),
        String(data.text || '').slice(0, 3500),
        normalizeHttpLink(data.image_url || ''),
        data.photo_attachment ? JSON.stringify(data.photo_attachment) : null,
        JSON.stringify(buttons),
        new Date(data.scheduled_at).toISOString()
      );
    }

    const res = await pool.query(`
      INSERT INTO apost_jobs (user_id, channel_id, channel_title, post_type, title, text, image_url, photo_attachment, buttons_json, scheduled_at)
      VALUES ${values.join(', ')}
      RETURNING id
    `, params);

    return res.rows.map(r => r.id);
  }

  async function sendMyPosts(target, userId) {
    const res = await pool.query(`
      SELECT *
      FROM apost_jobs
      WHERE user_id = $1
        AND status = 'scheduled'
        AND scheduled_at >= NOW() - INTERVAL '5 minutes'
      ORDER BY scheduled_at ASC, id ASC
      LIMIT 20
    `, [String(userId)]);

    if (!res.rows.length) {
      return sendMessage(target, [
        '📅 **Мои посты запланированные**',
        '',
        'Запланированных постов пока нет.'
      ].join('\n'), [
        [{ text: '📝 Создать автопост', callback_data: 'apost_autopost' }],
        [{ text: '🧠 Выбрать тест', callback_data: 'apost_tests' }],
        [{ text: '⬅️ Назад', callback_data: 'apost_menu' }]
      ]);
    }

    const lines = res.rows.map(row => [
      `#${row.id} | **${row.post_type === 'test' ? 'Тест' : 'Пост'}**`,
      `Канал: **${row.channel_title || row.channel_id}**`,
      `Время: **${formatMsk(row.scheduled_at)}**`
    ].join('\n'));

    const keyboard = res.rows.map(row => [{ text: `❌ Отменить #${row.id}`, callback_data: `apost_cancel_job:${row.id}` }]);
    keyboard.push([{ text: '⬅️ Назад', callback_data: 'apost_menu' }]);

    return sendMessage(target, ['📅 **Мои посты запланированные**', '', ...lines].join('\n\n'), keyboard);
  }

  async function sendTestsList(target) {
    const keyboard = TESTS.map(test => [{ text: `🧠 ${test.title}`.slice(0, 42), callback_data: `apost_test:${encodeURIComponent(test.id)}` }]);
    keyboard.push([{ text: '⬅️ Назад', callback_data: 'apost_menu' }]);

    return sendMessage(target, [
      '🧠 **Готовые тесты**',
      '',
      'Выберите тест. Бот покажет фото и описание, после этого можно будет выбрать канал и время публикации.',
      '',
      'Посты тестов уже подготовлены заранее, владельцу канала не нужно загружать фото самому.'
    ].join('\n'), keyboard);
  }

  async function selectTest(target, userId, testId) {
    const test = TESTS.find(item => item.id === testId);
    if (!test) {
      return sendMessage(target, 'Тест не найден.', [[{ text: '⬅️ Назад', callback_data: 'apost_tests' }]]);
    }

    const data = {
      type: 'test',
      title: test.title,
      image_url: test.image_url,
      text: test.post_text,
      description: test.description || test.post_text
    };

    await setApostSession(userId, 'apost_preview', data);

    const attachment = buildImageAttachment(data.image_url);
    return sendMessage(target, [
      `🧠 **${test.title}**`,
      '',
      data.description || data.text,
      '',
      'Если тест подходит — нажмите **Выбрать этот тест**.'
    ].join('\n'), [
      [{ text: '✅ Выбрать этот тест', callback_data: 'apost_preview_ok' }],
      [{ text: '❌ Нет, назад', callback_data: 'apost_tests' }]
    ], attachment ? [attachment] : []);
  }

  function scheduleFromCallback(value) {
    const now = new Date();
    if (value === 'now') return now;
    const match = String(value || '').match(/^(\d+)h$/);
    if (match) return new Date(now.getTime() + Number(match[1]) * 60 * 60 * 1000);
    return null;
  }

  async function handleCallback(cb) {
    const data = String(cb.data || '');
    const userId = cb.from.id;
    const target = cb.message.chat.id;

    if (data === 'apost_menu') {
      await sendApostMenu(target);
      return true;
    }

    if (data === 'apost_autopost') {
      await startAutopost(target, userId);
      return true;
    }

    if (data === 'apost_tests') {
      await sendTestsList(target);
      return true;
    }

    if (data === 'apost_my_posts') {
      await sendMyPosts(target, userId);
      return true;
    }

    if (data === 'apost_cancel') {
      await clearApostSession(userId);
      await sendMessage(target, 'Действие отменено.', [[{ text: '📌 Автопостинг', callback_data: 'apost_menu' }]]);
      return true;
    }

    if (data.startsWith('apost_test:')) {
      await selectTest(target, userId, decodeURIComponent(data.split(':')[1] || ''));
      return true;
    }

    if (data === 'apost_preview_ok') {
      const session = await getApostSession(userId);
      if (!session || session.state !== 'apost_preview') {
        await sendMessage(target, 'Предпросмотр устарел. Начните заново через /apost.');
        return true;
      }
      await setApostSession(userId, 'apost_time', session.data);
      await sendTimeMenu(target, userId);
      return true;
    }

    if (data === 'apost_back_preview') {
      const session = await getApostSession(userId);
      if (!session) return sendApostMenu(target).then(() => true);
      await setApostSession(userId, 'apost_preview', session.data);
      await sendPostPreview(target, userId, session.data, session.data.type === 'test' ? 'test' : 'post');
      return true;
    }

    if (data === 'apost_time_custom') {
      const session = await getApostSession(userId);
      if (!session || session.state !== 'apost_time') {
        await sendMessage(target, 'Сначала подтвердите предпросмотр поста.');
        return true;
      }
      await setApostSession(userId, 'apost_wait_time', session.data);
      await sendMessage(target, [
        '✍️ Напишите время публикации по МСК.',
        '',
        'Формат:',
        '`ДД.ММ ЧЧ:ММ`',
        '',
        'Например:',
        '`12.06 18:30`',
        '',
        `Максимум на ${MAX_SCHEDULE_HOURS} часов вперёд.`
      ].join('\n'), [[{ text: '⬅️ Назад ко времени', callback_data: 'apost_back_time' }]]);
      return true;
    }

    if (data === 'apost_back_time') {
      const session = await getApostSession(userId);
      if (!session) return sendApostMenu(target).then(() => true);
      await setApostSession(userId, 'apost_time', session.data);
      await sendTimeMenu(target, userId);
      return true;
    }

    if (data.startsWith('apost_time:')) {
      const session = await getApostSession(userId);
      if (!session || session.state !== 'apost_time') {
        await sendMessage(target, 'Сначала подтвердите предпросмотр поста.');
        return true;
      }

      const date = scheduleFromCallback(data.split(':')[1]);
      const validation = validateScheduleDate(date);
      if (!validation.ok) {
        await sendMessage(target, validation.error);
        return true;
      }

      const next = { ...session.data, scheduled_at: date.toISOString() };
      await setApostSession(userId, 'apost_channels', next);
      await sendChannelSelect(target, userId, next);
      return true;
    }

    if (data.startsWith('apost_ch:')) {
      const session = await getApostSession(userId);
      if (!session || session.state !== 'apost_channels') {
        await sendMessage(target, 'Выбор каналов сейчас не активен.');
        return true;
      }

      const channelId = decodeURIComponent(data.split(':')[1] || '');
      const selected = new Set(selectedChannels(session.data));
      if (selected.has(channelId)) selected.delete(channelId);
      else selected.add(channelId);

      const next = { ...session.data, channels: [...selected] };
      await setApostSession(userId, 'apost_channels', next);
      await sendChannelSelect(target, userId, next);
      return true;
    }

    if (data === 'apost_channels_done') {
      const session = await getApostSession(userId);
      if (!session || session.state !== 'apost_channels') {
        await sendMessage(target, 'Выбор каналов сейчас не активен.');
        return true;
      }

      if (!selectedChannels(session.data).length) {
        await sendMessage(target, 'Выберите хотя бы один канал.');
        return true;
      }

      await setApostSession(userId, 'apost_confirm', session.data);
      await sendFinalConfirm(target, userId, session.data);
      return true;
    }

    if (data === 'apost_back_channels') {
      const session = await getApostSession(userId);
      if (!session) return sendApostMenu(target).then(() => true);
      await setApostSession(userId, 'apost_channels', session.data);
      await sendChannelSelect(target, userId, session.data);
      return true;
    }

    if (data === 'apost_confirm') {
      const session = await getApostSession(userId);
      if (!session || session.state !== 'apost_confirm') {
        await sendMessage(target, 'Подтверждение устарело. Начните заново через /apost.');
        return true;
      }

      try {
        const ids = await createJobs(userId, session.data);
        await clearApostSession(userId);
        await sendMessage(target, [
          '✅ **Автопост запланирован**',
          '',
          `Создано задач: **${ids.length}**`,
          `Время: **${formatMsk(session.data.scheduled_at)}**`,
          '',
          'После публикации записи автоматически очистятся из базы.'
        ].join('\n'), [
          [{ text: '📅 Мои посты запланированные', callback_data: 'apost_my_posts' }],
          [{ text: '📌 Автопостинг', callback_data: 'apost_menu' }]
        ]);
      } catch (error) {
        await sendMessage(target, `⚠️ Не удалось создать автопост: ${safeText(error.message, 700)}`);
      }
      return true;
    }

    if (data.startsWith('apost_cancel_job:')) {
      const jobId = Number(data.split(':')[1]);
      if (!Number.isInteger(jobId)) {
        await sendMessage(target, 'Некорректный ID поста.');
        return true;
      }

      const res = await pool.query(`
        UPDATE apost_jobs
        SET status = 'cancelled', published_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status = 'scheduled'
        RETURNING id
      `, [jobId, String(userId)]);

      await sendMessage(target, res.rowCount ? `✅ Пост #${jobId} отменён.` : 'Пост не найден или уже опубликован.');
      await sendMyPosts(target, userId);
      return true;
    }

    return false;
  }

  async function handleMessage(message) {
    const text = String(message.text || '').trim();
    const userId = message.from.id;
    const target = message.chat.id;

    if (text === '/apost' || text.toLowerCase() === 'автопост') {
      await sendApostMenu(target);
      return true;
    }

    const session = await getApostSession(userId);
    if (!session) return false;

    if (session.state === 'apost_wait_photo') {
      const photoAttachment = extractPhotoAttachmentFromMessage(message);

      if (!photoAttachment) {
        await sendMessage(target, [
          '📷 Я жду фото.',
          '',
          'Отправьте изображение с телефона одним сообщением, как при создании розыгрыша.',
          'После этого бот попросит текст поста.'
        ].join('\n'), [[{ text: '⬅️ Назад', callback_data: 'apost_menu' }]]);
        return true;
      }

      const caption = safeText(text, 3500);

      if (caption) {
        const data = buildAutopostDataFromPhoto(photoAttachment, caption);
        await setApostSession(userId, 'apost_preview', data);
        await sendPostPreview(target, userId, data, 'post');
        return true;
      }

      await setApostSession(userId, 'apost_wait_text', {
        type: 'post',
        title: 'Автопост',
        image_url: '',
        photo_attachment: photoAttachment
      });

      await sendMessage(target, [
        '✅ Фото принято.',
        '',
        'Теперь отправьте текст поста одним сообщением.',
        'Можно использовать Markdown: **жирный**, списки, ссылки.'
      ].join('\n'), [[{ text: '⬅️ Отмена', callback_data: 'apost_cancel' }]]);
      return true;
    }

    if (session.state === 'apost_wait_text') {
      if (!text) {
        await sendMessage(target, 'Напишите текст поста одним сообщением. Можно использовать Markdown.');
        return true;
      }

      const data = buildAutopostDataFromPhoto(session.data.photo_attachment, text);
      if (!data) {
        await sendMessage(target, 'Не удалось собрать пост. Нажмите /apost и начните заново.');
        await clearApostSession(userId);
        return true;
      }

      await setApostSession(userId, 'apost_preview', data);
      await sendPostPreview(target, userId, data, 'post');
      return true;
    }

    if (session.state === 'apost_wait_time') {
      const date = parseMskDate(text);
      const validation = validateScheduleDate(date);
      if (!validation.ok) {
        await sendMessage(target, validation.error, [[{ text: '⬅️ Назад ко времени', callback_data: 'apost_back_time' }]]);
        return true;
      }

      const next = { ...session.data, scheduled_at: date.toISOString() };
      await setApostSession(userId, 'apost_channels', next);
      await sendChannelSelect(target, userId, next);
      return true;
    }

    return false;
  }

  async function publishJob(row) {
    const buttons = Array.isArray(row.buttons_json)
      ? row.buttons_json
      : (typeof row.buttons_json === 'string' ? JSON.parse(row.buttons_json || '[]') : row.buttons_json || []);
    const attachment = buildPostAttachment(row);

    try {
      await sendMessage(row.channel_id, row.text, buttons, attachment ? [attachment] : []);
      await pool.query(`
        UPDATE apost_jobs
        SET status = 'published', published_at = NOW(), error = NULL
        WHERE id = $1
      `, [row.id]);

      // Почистим опубликованную запись сразу, как пользователь просил, чтобы база не копилась.
      await pool.query(`DELETE FROM apost_jobs WHERE id = $1 AND status = 'published'`, [row.id]);

      await sendMessage(row.user_id, [
        '✅ **Автопост опубликован**',
        '',
        `Канал: **${row.channel_title || row.channel_id}**`,
        `Тип: **${row.post_type === 'test' ? 'Тест' : 'Пост'}**`
      ].join('\n')).catch(() => {});
    } catch (error) {
      await pool.query(`
        UPDATE apost_jobs
        SET status = 'failed', published_at = NOW(), error = $2
        WHERE id = $1
      `, [row.id, safeText(error.message, 1000)]);

      await sendMessage(row.user_id, [
        '⚠️ **Автопост не опубликован**',
        '',
        `Канал: **${row.channel_title || row.channel_id}**`,
        `Ошибка: ${safeText(error.message, 700)}`,
        '',
        'Проверьте, что бот всё ещё администратор канала и имеет право публиковать посты.'
      ].join('\n')).catch(() => {});
    }
  }

  async function processDueJobs() {
    await cleanupDb().catch(() => {});

    const res = await pool.query(`
      SELECT *
      FROM apost_jobs
      WHERE status = 'scheduled'
        AND scheduled_at <= NOW()
      ORDER BY scheduled_at ASC, id ASC
      LIMIT 10
    `);

    for (const row of res.rows) {
      const locked = await pool.query(`
        UPDATE apost_jobs
        SET status = 'publishing'
        WHERE id = $1 AND status = 'scheduled'
        RETURNING *
      `, [row.id]);

      if (!locked.rows[0]) continue;
      await publishJob(locked.rows[0]);
    }
  }

  function renderResultPage(key) {
    const result = TEST_RESULTS[key] || TEST_RESULTS.trust;
    const more = MORE_TESTS_URL
      ? `<p class="more">Еще больше тестов <a href="${htmlEscape(MORE_TESTS_URL)}">${htmlEscape(MORE_TESTS_LABEL)}</a></p>`
      : '';

    return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Результат теста — ${htmlEscape(result.title)}</title>
  <style>
    body{margin:0;font-family:Arial,system-ui,sans-serif;background:linear-gradient(135deg,#f8efe4,#fff);color:#222;}
    .wrap{max-width:760px;margin:0 auto;padding:28px 18px 44px;}
    .card{background:#fff;border-radius:22px;padding:28px;box-shadow:0 10px 30px rgba(0,0,0,.08);}
    .badge{display:inline-block;padding:8px 12px;border-radius:999px;background:#f2e2ca;font-size:14px;margin-bottom:14px;}
    h1{font-size:30px;line-height:1.15;margin:0 0 16px;}
    p{font-size:18px;line-height:1.65;margin:0 0 14px;}
    .more{margin-bottom:18px;font-size:16px;}
    a{color:#8a4b00;font-weight:700;}
  </style>
</head>
<body>
  <div class="wrap">
    ${more}
    <div class="card">
      <div class="badge">Результат теста</div>
      <h1>${htmlEscape(result.title)}</h1>
      <p>${htmlEscape(result.text)}</p>
    </div>
  </div>
</body>
</html>`;
  }

  app.get('/apost/test/:key', (req, res) => {
    res.status(200).type('html').send(renderResultPage(String(req.params.key || 'trust')));
  });

  app.get('/apost', (req, res) => {
    const list = TESTS.map(test => `<li>${htmlEscape(test.title)}</li>`).join('');
    res.status(200).type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Автопостинг</title><style>body{font-family:Arial,sans-serif;padding:24px;line-height:1.5;max-width:800px;margin:auto}</style></head><body><h1>Автопостинг</h1><p>Этот раздел работает через команду <b>/apost</b> в MAX-боте.</p><h2>Доступные тесты</h2><ul>${list}</ul></body></html>`);
  });

  let started = false;
  function startWorker() {
    if (started) return;
    started = true;

    setInterval(() => {
      processDueJobs().catch(error => console.error('apost worker error:', error.message));
    }, WORKER_INTERVAL_SECONDS * 1000).unref?.();

    setTimeout(() => {
      processDueJobs().catch(error => console.error('apost worker warmup error:', error.message));
    }, 4000).unref?.();
  }

  return {
    initDb,
    startWorker,
    handleCallback,
    handleMessage,
    processDueJobs
  };
}

module.exports = { setupApostModule };
