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
      ].join('\n'),
      result_keys: ['trust', 'pedant', 'energy', 'intuitive'],
      button_prefix: 'Вариант'
    },
    {
      id: 'summer_butterfly',
      title: 'Лето: выберите бабочку',
      image_url: process.env.APOST_SUMMER_TEST_IMAGE_URL || process.env.APOST_LETO_TEST_IMAGE_URL || 'https://dummyimage.com/1200x800/f7e7ff/333333.jpg&text=SUMMER+TEST',
      description: [
        '🦋 **Летний тест**',
        '',
        'Выберите бабочку на картинке и узнайте, как вы проведёте это лето.',
        'Лёгкий развлекательный тест для вовлечения аудитории канала.'
      ].join('\n'),
      post_text: [
        '🦋 **Как вы проведёте это лето?**',
        '',
        'Посмотрите на картинку и выберите бабочку, которая первой привлекла ваше внимание.',
        '',
        'Нажмите кнопку ниже и узнайте свой результат.',
        '',
        `Еще больше тестов ${MORE_TESTS_URL ? markdownLink(MORE_TESTS_LABEL, MORE_TESTS_URL) : MORE_TESTS_LABEL}`
      ].join('\n'),
      result_keys: ['summer_1', 'summer_2', 'summer_3', 'summer_4'],
      button_prefix: 'Бабочка'
    },
    {
      id: 'door_choice',
      title: 'Тест: в какую дверь вы бы вошли?',
      image_url: process.env.APOST_DOOR_TEST_IMAGE_URL || process.env.APOST_DVER_TEST_IMAGE_URL || 'https://dummyimage.com/1200x800/e8f0ff/333333.jpg&text=DOOR+TEST',
      description: [
        '🚪 **В какую дверь вы бы вошли?**',
        '',
        'Простой и точный психологический тест.',
        'Выберите дверь на картинке и откройте свой результат.'
      ].join('\n'),
      post_text: [
        '🚪 **В какую дверь вы бы вошли?**',
        '',
        'Посмотрите на картинку и выберите дверь, которая вас больше всего притягивает.',
        '',
        'Нажмите кнопку ниже и прочитайте результат.',
        '',
        `Еще больше тестов ${MORE_TESTS_URL ? markdownLink(MORE_TESTS_LABEL, MORE_TESTS_URL) : MORE_TESTS_LABEL}`
      ].join('\n'),
      result_keys: ['door_1', 'door_2', 'door_3', 'door_4'],
      button_prefix: 'Дверь'
    }
  ];

  function parseConfiguredTests() {
    const raw = String(process.env.APOST_TESTS_JSON || '').trim();
    if (!raw) return DEFAULT_TESTS;

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.length) return DEFAULT_TESTS;

      return parsed
        .map((item, index) => {
          const resultKeysRaw = Array.isArray(item.result_keys)
            ? item.result_keys
            : (Array.isArray(item.resultKeys) ? item.resultKeys : []);
          const buttonLabelsRaw = Array.isArray(item.button_labels)
            ? item.button_labels
            : (Array.isArray(item.buttonLabels) ? item.buttonLabels : []);

          return {
            id: String(item.id || `test_${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60),
            title: String(item.title || `Тест ${index + 1}`).trim().slice(0, 120),
            image_url: normalizeHttpLink(item.image_url || item.imageUrl || ''),
            description: String(item.description || item.desc || '').trim().slice(0, 2500),
            post_text: String(item.post_text || item.postText || item.description || '').trim().slice(0, 3500),
            result_keys: resultKeysRaw.map(key => String(key || '').trim()).filter(Boolean).slice(0, 4),
            button_prefix: String(item.button_prefix || item.buttonPrefix || 'Вариант').trim().slice(0, 30) || 'Вариант',
            button_labels: buttonLabelsRaw.map(label => String(label || '').trim()).filter(Boolean).slice(0, 4)
          };
        })
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
    },
    summer_1: {
      title: 'Лето приключений',
      text: 'Вас ждёт немало приключений и ярких впечатлений. Лето может начаться неожиданно, но именно эти события помогут вам лучше понять, чего вы хотите дальше. В итоге всё сложится удачно, а настроение станет гораздо светлее.'
    },
    summer_2: {
      title: 'Лето уюта и семьи',
      text: 'Вас ждут домашние дела, заботы и много маленьких важных задач. Но не спешите расстраиваться: именно через порядок, уют и внимание к близким это лето принесёт вам спокойствие. В семье и личной жизни всё может сложиться особенно хорошо.'
    },
    summer_3: {
      title: 'Лето ближе к природе',
      text: 'Это лето лучше всего проведёте ближе к природе. Дача, поле, огород, прогулки, свежий воздух и простые радости помогут вам восстановить силы. Вдохновение придёт именно там, где меньше шума и больше зелени.'
    },
    summer_4: {
      title: 'Лето поездок и впечатлений',
      text: 'Вас ждут интересные события, поездки и новые впечатления. Это могут быть курсы, отпуск, путешествие за границу или просто неожиданная дорога, которая подарит много эмоций. Главное — не отказываться от возможностей, которые подкинет судьба.'
    },
    door_1: {
      title: 'Дверь 1',
      text: 'Вы веселый человек, которому нравится поддерживать атмосферу легкости. Вы умеете радоваться простым вещам: любимому блюду, предмету интерьера и хорошей погоде. Скорее всего, вы любитель путешествовать. Вы дружелюбны и отзывчивы. Но не забывайте, что если и вам когда-нибудь будет нелегко, то не нужно стесняться и попросить о помощи.'
    },
    door_2: {
      title: 'Дверь 2',
      text: 'Вы практически полностью сосредоточены на своей карьере и очень гордитесь своими достижениями. Вы действительно можете добиться успехов, к которым стремитесь, но задумайтесь, действительно ли это всё, чего вы хотите от жизни.'
    },
    door_3: {
      title: 'Дверь 3',
      text: 'Вы неординарный человек и весьма интересны окружающим. Вы артистичны, и у вас хорошо получаются многие вещи. Из ничего вы можете сделать что-то. Не удивительно, что вам не скучно и дома, в одиночестве, но не забывайте иногда возвращаться из мира идей и фантазий на землю.'
    },
    door_4: {
      title: 'Дверь 4',
      text: 'Вы артистичны и слегка драматичны. Вам нравится самовыражаться в творчестве. С одной стороны, вы дружелюбны и открыты, но с другой — замкнуты и неохотно делитесь своими переживаниями и размышлениями. Возможно, вы считаете, что никто не способен вполне понять вас, но если вы всё же начнете делиться своими чувствами с другими, то увидите, что так намного легче, и они готовы в ответ делиться своими переживаниями с вами.'
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


  function extractMessageMarkup(message) {
    const candidates = [
      message?.markup,
      message?.body?.markup,
      message?.message?.markup,
      message?.message?.body?.markup,
      message?.payload?.markup,
      message?.raw?.markup,
      message?.raw?.body?.markup
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length) return candidate;
    }

    return [];
  }

  function getMarkupUrl(entity = {}) {
    return normalizeHttpLink(
      entity.url ||
      entity.href ||
      entity.link ||
      entity.payload?.url ||
      entity.payload?.href ||
      entity.payload?.link ||
      entity.data?.url ||
      entity.data?.href ||
      ''
    );
  }

  function wrapMarkdownByEntity(value, entity = {}) {
    const text = String(value || '');
    const type = String(entity.type || entity.markup_type || entity.kind || '').toLowerCase();

    if (!text) return text;

    if (['strong', 'bold', 'b'].includes(type)) return `**${text}**`;
    if (['emphasis', 'italic', 'em', 'i'].includes(type)) return `*${text}*`;
    if (['strikethrough', 'strike', 's', 'del'].includes(type)) return `~~${text}~~`;
    if (['underline', 'u'].includes(type)) return `__${text}__`;
    if (['code', 'monospace'].includes(type)) return `\`${text.replace(/`/g, '\\`')}\``;
    if (['pre', 'preformatted'].includes(type)) return `\`\`\`\n${text.replace(/```/g, '\`\`\`')}\n\`\`\``;

    if (['link', 'text_link', 'url'].includes(type)) {
      const url = getMarkupUrl(entity);
      return url ? `[${text.replace(/[\[\]\n\r]/g, ' ').trim() || 'ссылка'}](${url})` : text;
    }

    return text;
  }

  function textWithMaxMarkupToMarkdown(text, markup = []) {
    let result = String(text || '');

    const entities = (Array.isArray(markup) ? markup : [])
      .map(entity => ({
        ...entity,
        from: Number(entity.from ?? entity.offset ?? entity.start ?? 0),
        length: Number(entity.length ?? entity.len ?? 0)
      }))
      .filter(entity => Number.isInteger(entity.from) && Number.isInteger(entity.length) && entity.length > 0)
      .sort((a, b) => (b.from + b.length) - (a.from + a.length) || b.from - a.from);

    for (const entity of entities) {
      if (entity.from < 0 || entity.from + entity.length > result.length) continue;

      const before = result.slice(0, entity.from);
      const middle = result.slice(entity.from, entity.from + entity.length);
      const after = result.slice(entity.from + entity.length);
      result = `${before}${wrapMarkdownByEntity(middle, entity)}${after}`;
    }

    return result;
  }

  function extractMarkdownTextFromMessage(message) {
    const rawText = String(message?.text || message?.body?.text || message?.message?.body?.text || '').trim();
    const markup = extractMessageMarkup(message);

    if (!rawText || !markup.length) return rawText;

    return safeText(textWithMaxMarkupToMarkdown(rawText, markup).trim(), 3500);
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

    // MAX сам скачивает картинку по URL. Важно передавать только payload.url,
    // без лишнего верхнего поля url, иначе на некоторых сборках API бывает proto.payload.
    return {
      type: 'image',
      payload: { url }
    };
  }

  function isImageUploadError(error) {
    const text = String(error?.message || error || '').toLowerCase();
    return text.includes('failed to upload image') ||
      text.includes('proto.payload') ||
      text.includes('upload image');
  }

  function getPostImageUrl(data = {}) {
    return normalizeHttpLink(data.image_url || data.imageUrl || data.photo_url || data.photoUrl || '');
  }

  async function sendMessageWithImageFallback(target, text, inlineKeyboard = null, data = {}, extraLines = []) {
    const attachment = buildPostAttachment(data);
    const keyboard = hasInlineKeyboard(inlineKeyboard) ? inlineKeyboard : null;

    if (!attachment) {
      return sendMessage(target, text, keyboard);
    }

    try {
      return await sendMessage(target, text, keyboard, [attachment]);
    } catch (error) {
      if (!isImageUploadError(error)) {
        throw error;
      }

      const imageUrl = getPostImageUrl(data);
      const fallbackText = [
        text,
        '',
        '⚠️ Фото не удалось загрузить через MAX API.',
        imageUrl ? `Фото: ${imageUrl}` : '',
        ...extraLines
      ].filter(Boolean).join('\n');

      return sendMessage(target, fallbackText, keyboard);
    }
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

  function getTestResultKeys(data = {}) {
    const keys = Array.isArray(data.result_keys)
      ? data.result_keys
      : (Array.isArray(data.resultKeys) ? data.resultKeys : []);

    const clean = keys.map(key => String(key || '').trim()).filter(Boolean).slice(0, 4);

    return clean.length === 4
      ? clean
      : ['trust', 'pedant', 'energy', 'intuitive'];
  }

  function buildTestButtons(data = {}) {
    const keys = getTestResultKeys(data);
    const labels = Array.isArray(data.button_labels)
      ? data.button_labels.map(label => String(label || '').trim()).filter(Boolean).slice(0, 4)
      : [];
    const prefix = String(data.button_prefix || data.buttonPrefix || 'Вариант').trim() || 'Вариант';
    const nums = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
    const button = index => ({
      text: labels[index] || `${nums[index]} ${prefix} ${index + 1}`,
      url: testResultUrl(keys[index])
    });

    return [
      [button(0), button(1)],
      [button(2), button(3)]
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

  function hasInlineKeyboard(keyboard) {
    return Array.isArray(keyboard) && keyboard.some(row => Array.isArray(row) && row.length > 0);
  }

  function normalizeButtonUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return normalizeHttpLink(withProtocol);
  }

  function normalizeApostButtons(value) {
    const raw = Array.isArray(value) ? value : [];
    const buttons = [];

    for (const item of raw) {
      const text = safeText(item?.text || item?.title || item?.name || '', 40);
      const url = normalizeButtonUrl(item?.url || item?.link || '');

      if (!text || !url) continue;
      buttons.push([{ text: text.slice(0, 40), url }]);
      if (buttons.length >= 2) break;
    }

    return buttons;
  }

  function formatApostButtonsLines(data = {}) {
    const buttons = normalizeApostButtons(data.buttons);

    if (!buttons.length) {
      return ['Кнопки: **не добавлены**'];
    }

    return [
      `Кнопки: **${buttons.length} из 2**`,
      ...buttons.map((row, index) => {
        const button = row[0];
        return `${index + 1}. ${button.text} — ${button.url}`;
      })
    ];
  }

  function parseApostButtonText(text) {
    const clean = String(text || '').trim();
    if (!clean) return null;

    let title = '';
    let url = '';

    const titleMatch = clean.match(/(?:^|\n)\s*(?:Кнопка|Название)\s*:\s*(.+)/i);
    const urlMatch = clean.match(/(?:^|\n)\s*(?:Ссылка|URL|Link)\s*:\s*(.+)/i);

    if (titleMatch && urlMatch) {
      title = titleMatch[1].split('\n')[0].trim();
      url = urlMatch[1].split('\n')[0].trim();
    } else if (clean.includes('|')) {
      const parts = clean.split('|').map(part => part.trim()).filter(Boolean);
      title = parts[0] || '';
      url = parts[1] || '';
    }

    title = safeText(title, 40);
    url = normalizeButtonUrl(url);

    if (!title || !url) return null;

    return { text: title.slice(0, 40), url };
  }

  async function sendAutopostButtonsMenu(target, userId, data = {}) {
    const buttons = normalizeApostButtons(data.buttons);
    const keyboard = [];

    if (buttons.length < 2) {
      keyboard.push([{ text: '➕ Добавить кнопку', callback_data: 'apost_add_button' }]);
    }

    buttons.forEach((row, index) => {
      keyboard.push([{ text: `🗑 Удалить: ${row[0].text}`.slice(0, 42), callback_data: `apost_remove_button:${index}` }]);
    });

    keyboard.push([{ text: buttons.length ? '✅ Продолжить с кнопками' : '➡️ Продолжить без кнопок', callback_data: 'apost_buttons_done' }]);
    keyboard.push([{ text: '⬅️ Назад к предпросмотру', callback_data: 'apost_back_preview' }]);

    return sendMessage(target, [
      '🔘 **Кнопки под автопостом**',
      '',
      'Можно добавить до **2 кнопок** под обычным автопостом.',
      '',
      ...formatApostButtonsLines({ buttons }),
      '',
      'Формат для добавления:',
      '`Кнопка: Название`',
      '`Ссылка: gdgdgdg.ru`',
      '',
      'Или коротко:',
      '`Название | gdgdgdg.ru`'
    ].join('\n'), keyboard);
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
      photo_attachment: photoAttachment,
      buttons: []
    };
  }

  async function sendPostPreview(target, userId, data, type = 'post') {
    const keyboard = type === 'test'
      ? [
          ...buildTestButtons(data),
          [{ text: '✅ Выбрать этот тест', callback_data: 'apost_preview_ok' }],
          [{ text: '❌ Нет, назад', callback_data: 'apost_tests' }]
        ]
      : [
          [{ text: '✅ Подтвердить пост', callback_data: 'apost_preview_ok' }],
          [{ text: '✏️ Изменить', callback_data: 'apost_autopost' }],
          [{ text: '❌ Отмена', callback_data: 'apost_cancel' }]
        ];

    const previewText = [
      type === 'test' ? '👀 **Предпросмотр теста**' : '👀 **Предпросмотр поста**',
      '',
      data.text || data.post_text || ''
    ].join('\n');

    return sendMessageWithImageFallback(target, previewText, keyboard, data, [
      type === 'test'
        ? 'Можно всё равно выбрать тест: при публикации бот отправит текст и кнопки, а ссылку на фото добавит в пост.'
        : 'Можно всё равно продолжить: пост будет опубликован без вложения, но со ссылкой на фото, если она есть.'
    ]);
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
    const buttonLines = data.type === 'test'
      ? ['Кнопки: **4 кнопки результата теста**']
      : formatApostButtonsLines(data);

    return sendMessage(target, [
      '✅ **Подтвердите автопост**',
      '',
      `Тип: **${data.type === 'test' ? 'Тест' : 'Обычный пост'}**`,
      `Время: **${formatMsk(data.scheduled_at)}**`,
      '',
      '**Каналы:**',
      ...lines,
      '',
      '**Кнопки:**',
      ...buttonLines,
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

    const buttons = data.type === 'test' ? buildTestButtons(data) : normalizeApostButtons(data.buttons);
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
    const keyboard = TESTS.map(test => [{ text: `👁️‍🗨️ ${test.title}`.slice(0, 42), callback_data: `apost_test:${encodeURIComponent(test.id)}` }]);
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
      description: test.description || test.post_text,
      result_keys: getTestResultKeys(test),
      button_prefix: test.button_prefix || 'Вариант',
      button_labels: Array.isArray(test.button_labels) ? test.button_labels : []
    };

    await setApostSession(userId, 'apost_preview', data);

    return sendMessageWithImageFallback(target, [
      `🧠 **${test.title}**`,
      '',
      data.description || data.text,
      '',
      'Если тест подходит — нажмите **Выбрать этот тест**.'
    ].join('\n'), [
      [{ text: '✅ Выбрать этот тест', callback_data: 'apost_preview_ok' }],
      [{ text: '❌ Нет, назад', callback_data: 'apost_tests' }]
    ], data, [
      'Тест можно выбрать даже без предпросмотра фото. При публикации бот добавит ссылку на фото, если MAX не сможет загрузить изображение.'
    ]);
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
      if (session.data.type === 'test') {
        await setApostSession(userId, 'apost_time', session.data);
        await sendTimeMenu(target, userId);
        return true;
      }

      const next = { ...session.data, buttons: normalizeApostButtons(session.data.buttons) };
      await setApostSession(userId, 'apost_buttons', next);
      await sendAutopostButtonsMenu(target, userId, next);
      return true;
    }

    if (data === 'apost_back_preview') {
      const session = await getApostSession(userId);
      if (!session) return sendApostMenu(target).then(() => true);
      await setApostSession(userId, 'apost_preview', session.data);
      await sendPostPreview(target, userId, session.data, session.data.type === 'test' ? 'test' : 'post');
      return true;
    }

    if (data === 'apost_add_button') {
      const session = await getApostSession(userId);
      if (!session || session.state !== 'apost_buttons') {
        await sendMessage(target, 'Сначала подтвердите предпросмотр поста.');
        return true;
      }

      const buttons = normalizeApostButtons(session.data.buttons);
      if (buttons.length >= 2) {
        await sendMessage(target, 'Можно добавить максимум 2 кнопки.');
        await sendAutopostButtonsMenu(target, userId, session.data);
        return true;
      }

      await setApostSession(userId, 'apost_wait_button', session.data);
      await sendMessage(target, [
        '➕ **Добавьте кнопку**',
        '',
        'Отправьте одним сообщением:',
        '`Кнопка: Название`',
        '`Ссылка: gdgdgdg.ru`',
        '',
        'Или коротко:',
        '`Название | gdgdgdg.ru`'
      ].join('\n'), [[{ text: '⬅️ Назад к кнопкам', callback_data: 'apost_buttons_back' }]]);
      return true;
    }

    if (data === 'apost_buttons_back') {
      const session = await getApostSession(userId);
      if (!session) return sendApostMenu(target).then(() => true);
      await setApostSession(userId, 'apost_buttons', session.data);
      await sendAutopostButtonsMenu(target, userId, session.data);
      return true;
    }

    if (data.startsWith('apost_remove_button:')) {
      const session = await getApostSession(userId);
      if (!session || session.state !== 'apost_buttons') {
        await sendMessage(target, 'Сейчас нельзя удалить кнопку.');
        return true;
      }

      const index = Number(data.split(':')[1]);
      const buttons = normalizeApostButtons(session.data.buttons);
      if (Number.isInteger(index) && index >= 0 && index < buttons.length) {
        buttons.splice(index, 1);
      }

      const next = { ...session.data, buttons };
      await setApostSession(userId, 'apost_buttons', next);
      await sendAutopostButtonsMenu(target, userId, next);
      return true;
    }

    if (data === 'apost_buttons_done') {
      const session = await getApostSession(userId);
      if (!session || session.state !== 'apost_buttons') {
        await sendMessage(target, 'Сначала подтвердите предпросмотр поста.');
        return true;
      }

      const next = { ...session.data, buttons: normalizeApostButtons(session.data.buttons) };
      await setApostSession(userId, 'apost_time', next);
      await sendTimeMenu(target, userId);
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
    const markdownText = extractMarkdownTextFromMessage(message);
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

      const caption = safeText(markdownText || text, 3500);

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
        photo_attachment: photoAttachment,
        buttons: []
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

      const data = buildAutopostDataFromPhoto(session.data.photo_attachment, markdownText || text);
      if (!data) {
        await sendMessage(target, 'Не удалось собрать пост. Нажмите /apost и начните заново.');
        await clearApostSession(userId);
        return true;
      }

      await setApostSession(userId, 'apost_preview', data);
      await sendPostPreview(target, userId, data, 'post');
      return true;
    }

    if (session.state === 'apost_wait_button') {
      const parsed = parseApostButtonText(text);

      if (!parsed) {
        await sendMessage(target, [
          'Не понял кнопку. Отправьте в формате:',
          '',
          '`Кнопка: Название`',
          '`Ссылка: gdgdgdg.ru`',
          '',
          'Или:',
          '`Название | gdgdgdg.ru`'
        ].join('\n'), [[{ text: '⬅️ Назад к кнопкам', callback_data: 'apost_buttons_back' }]]);
        return true;
      }

      const buttons = normalizeApostButtons([...(session.data.buttons || []), parsed]);
      const next = { ...session.data, buttons };
      await setApostSession(userId, 'apost_buttons', next);
      await sendAutopostButtonsMenu(target, userId, next);
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
    const keyboard = hasInlineKeyboard(buttons) ? buttons : null;
    try {
      await sendMessageWithImageFallback(row.channel_id, row.text, keyboard, row, [
        row.post_type === 'test' ? 'Кнопки теста ниже работают, результат можно открыть без фото.' : ''
      ].filter(Boolean));
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
