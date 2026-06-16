'use strict';

const crypto = require('crypto');

const HORSE_COLORS = Object.freeze([
  { code: 'red', label: 'Красная', css: '#ef4444' },
  { code: 'blue', label: 'Синяя', css: '#3b82f6' },
  { code: 'green', label: 'Зелёная', css: '#22c55e' },
  { code: 'yellow', label: 'Жёлтая', css: '#eab308' },
  { code: 'purple', label: 'Фиолетовая', css: '#a855f7' },
  { code: 'orange', label: 'Оранжевая', css: '#f97316' }
]);

const ACTIVE_RACE_STATUSES = new Set(['scheduled', 'active', 'running']);
const RACE_OPEN_BEFORE_MS = 12 * 60 * 60 * 1000;

function setupHorseRacesModule(options = {}) {
  const {
    app,
    pool,
    sendMessage,
    answerMaxCallback,
    checkUserSubscribedToChannelDetailed,
    isAdmin = () => false,
    buildBotDeepLink,
    formatDateTime,
    APP_BASE_URL = '',
    BOT_PUBLIC_URL = '',
    BOT_USERNAME = '',
    MAX_BOT_TOKEN = '',
    MAX_MINIAPP_LAUNCH_URL = '',
    MINIAPP_WEB_URL = '',
    GENERAL_CHANNEL_ID = '',
    GENERAL_CHANNEL_PUBLIC_NAME = 'РОЗЫГРЫШ ТОП',
    setSession,
    clearSession,
    parseDateTime,
    extractPhotoAttachment,
    yookassaRequest,
    buildYooKassaReceipt,
    normalizeReceiptEmail,
    isYooKassaReady,
    notifyAdmins,
    extractMaxMessageId,
    editMaxMessageText
  } = options;

  if (!app || typeof app.get !== 'function') {
    throw new Error('horse_races_module: app is required');
  }

  if (!pool || typeof pool.query !== 'function') {
    throw new Error('horse_races_module: pool is required');
  }

  if (!MAX_BOT_TOKEN) {
    throw new Error('horse_races_module: MAX_BOT_TOKEN is required');
  }

  const config = {
    authMaxAgeSeconds: Math.max(60, Number(process.env.MINIAPP_AUTH_MAX_AGE_SECONDS || 3600)),
    authFutureSkewSeconds: Math.max(0, Number(process.env.MINIAPP_AUTH_FUTURE_SKEW_SECONDS || 60)),
    apiRateLimit: Math.max(60, Number(process.env.MINIAPP_API_RATE_LIMIT_PER_MINUTE || 180)),
    topRafflesLimit: Math.min(50, Math.max(1, Number(process.env.MINIAPP_TOP_RAFFLES_LIMIT || 20))),
    racesLimit: Math.min(100, Math.max(1, Number(process.env.MINIAPP_RACES_LIMIT || 50))),
    racePriceRub: Number(process.env.HORSE_RACE_PRICE_RUB || 1999),
    workerIntervalSeconds: Math.max(5, Number(process.env.HORSE_RACE_WORKER_INTERVAL_SECONDS || 10)),
    generalChannelId: String(GENERAL_CHANNEL_ID || process.env.GENERAL_CHANNEL_ID || '').trim(),
    generalChannelName: String(GENERAL_CHANNEL_PUBLIC_NAME || 'РОЗЫГРЫШ ТОП').trim() || 'РОЗЫГРЫШ ТОП',
    productCode: 'horse_race_create',
    testMode: String(process.env.HORSE_RACE_TEST_MODE || 'false').toLowerCase() === 'true',
    minStartMinutes: Math.max(1, Number(process.env.HORSE_RACE_MIN_START_MINUTES || 5)),
    maxActivePerUser: Math.max(1, Number(process.env.HORSE_RACE_MAX_ACTIVE_PER_USER || 3)),
    replayHours: Math.min(168, Math.max(1, Number(process.env.HORSE_RACE_REPLAY_HOURS || 24))),

    morePrizesUrl: normalizePublicHttpUrl(
      process.env.MORE_PRIZES_URL ||
      process.env.BOT_MORE_PRIZES_URL ||
      BOT_PUBLIC_URL ||
      APP_BASE_URL
    ),

    morePrizesLabel:
      cleanText(process.env.MORE_PRIZES_LABEL || 'ТУТ', 40) || 'ТУТ'
  };

  const webUrl = normalizeBaseUrl(
    MINIAPP_WEB_URL || process.env.MINIAPP_WEB_URL || `${String(APP_BASE_URL || '').replace(/\/+$/, '')}/miniapp`
  );

  const launchInfo = resolveMiniAppLaunchBase({
    explicitUrl: MAX_MINIAPP_LAUNCH_URL || process.env.MAX_MINIAPP_LAUNCH_URL || '',
    botPublicUrl: BOT_PUBLIC_URL,
    botUsername: BOT_USERNAME || process.env.BOT_USERNAME || '',
    webUrl
  });
  const launchBaseUrl = launchInfo.baseUrl;

  if (launchInfo.isMaxUrl) {
    console.log(`🐎 Mini App launch base: ${launchBaseUrl} (${launchInfo.source})`);
  } else {
    console.warn(
      '⚠️ Не удалось определить MAX-ссылку Mini App. ' +
      'Задайте BOT_USERNAME=@имя_бота или MAX_MINIAPP_LAUNCH_URL=https://max.ru/имя_бота'
    );
  }

  const rateMap = new Map();
  let workerTimer = null;
  const rateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of rateMap.entries()) {
      if (now > Number(value?.resetAt || 0) + 60_000) rateMap.delete(key);
    }
  }, 5 * 60_000);
  rateCleanupTimer.unref?.();

  function getWebUrl() {
    return webUrl;
  }

  function getLaunchUrl(startParam = 'home') {
    return buildMiniAppLaunchUrl(launchBaseUrl || webUrl, startParam);
  }

  function getBotUrl(payload = '') {
    if (typeof buildBotDeepLink === 'function') {
      return buildBotDeepLink(payload);
    }

    const base = BOT_PUBLIC_URL || APP_BASE_URL;
    if (!payload) return base;
    const separator = String(base).includes('?') ? '&' : '?';
    return `${base}${separator}start=${encodeURIComponent(payload)}`;
  }

  function formatRaceDate(value) {
    if (typeof formatDateTime === 'function') {
      try {
        return formatDateTime(value);
      } catch {
        // fallback below
      }
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'не указано';

    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  async function initDb() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS horse_races (
        id SERIAL PRIMARY KEY,
        creator_user_id BIGINT REFERENCES users(max_user_id) ON DELETE SET NULL,
        title TEXT NOT NULL DEFAULT 'Скачки',
        description TEXT,
        prizes TEXT,
        prize_count INT NOT NULL DEFAULT 1,
        photo_attachment JSONB,
        photo_url TEXT,
        publish_at TIMESTAMPTZ DEFAULT NOW(),
        start_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        price_amount NUMERIC(10, 2) NOT NULL DEFAULT 1999.00,
        payment_status TEXT NOT NULL DEFAULT 'pending',
        payment_id TEXT,
        published_in_general BOOLEAN NOT NULL DEFAULT false,
        general_channel_id BIGINT,
        general_message_id TEXT,
        general_post_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ
      );

      ALTER TABLE horse_races
        ADD COLUMN IF NOT EXISTS photo_url TEXT;

      ALTER TABLE horse_races
        ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending';

      ALTER TABLE horse_races
        ADD COLUMN IF NOT EXISTS payment_id TEXT;

      ALTER TABLE horse_races
        ADD COLUMN IF NOT EXISTS published_in_general BOOLEAN NOT NULL DEFAULT false;

      ALTER TABLE horse_races
        ADD COLUMN IF NOT EXISTS general_channel_id BIGINT;

      ALTER TABLE horse_races
        ADD COLUMN IF NOT EXISTS general_message_id TEXT;

      ALTER TABLE horse_races
        ADD COLUMN IF NOT EXISTS general_post_url TEXT;

      ALTER TABLE horse_races
        ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

      ALTER TABLE horse_races
        ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS horse_race_channels (
        id SERIAL PRIMARY KEY,
        horse_race_id INT NOT NULL REFERENCES horse_races(id) ON DELETE CASCADE,
        user_channel_id INT REFERENCES user_channels(id) ON DELETE SET NULL,
        channel_id BIGINT NOT NULL,
        channel_title TEXT,
        channel_link TEXT,
        owner_user_id BIGINT REFERENCES users(max_user_id) ON DELETE SET NULL,
        is_required BOOLEAN NOT NULL DEFAULT true,
        publish_post BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (horse_race_id, channel_id)
      );

      ALTER TABLE horse_race_channels
        ADD COLUMN IF NOT EXISTS user_channel_id INT REFERENCES user_channels(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS ix_horse_race_channels_user_channel
        ON horse_race_channels (user_channel_id);

      CREATE TABLE IF NOT EXISTS horse_race_participants (
        id SERIAL PRIMARY KEY,
        horse_race_id INT NOT NULL REFERENCES horse_races(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
        ticket_number BIGINT NOT NULL,
        horse_color TEXT NOT NULL,
        is_valid BOOLEAN NOT NULL DEFAULT true,
        ticket_type TEXT NOT NULL DEFAULT 'main',
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (horse_race_id, user_id),
        UNIQUE (horse_race_id, ticket_number)
      );

      CREATE TABLE IF NOT EXISTS horse_race_pending_joins (
        id SERIAL PRIMARY KEY,
        horse_race_id INT NOT NULL REFERENCES horse_races(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (horse_race_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS horse_race_rounds (
        id SERIAL PRIMARY KEY,
        horse_race_id INT NOT NULL REFERENCES horse_races(id) ON DELETE CASCADE,
        prize_index INT NOT NULL,
        prize_text TEXT,
        starts_at TIMESTAMPTZ NOT NULL,
        duration_ms INT NOT NULL DEFAULT 20000,
        animation_seed TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'prepared',
        winner_participant_id INT REFERENCES horse_race_participants(id) ON DELETE SET NULL,
        winner_user_id BIGINT REFERENCES users(max_user_id) ON DELETE SET NULL,
        winner_ticket_number BIGINT,
        winner_color TEXT,
        result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (horse_race_id, prize_index)
      );

      CREATE TABLE IF NOT EXISTS horse_race_payments (
        id SERIAL PRIMARY KEY,
        payment_id TEXT UNIQUE NOT NULL,
        horse_race_id INT REFERENCES horse_races(id) ON DELETE SET NULL,
        user_id BIGINT REFERENCES users(max_user_id) ON DELETE SET NULL,
        product TEXT NOT NULL DEFAULT 'horse_race_create',
        status TEXT NOT NULL DEFAULT 'pending',
        amount NUMERIC(10, 2),
        currency TEXT NOT NULL DEFAULT 'RUB',
        receipt_email TEXT,
        raw JSONB NOT NULL DEFAULT '{}'::jsonb,
        applied BOOLEAN NOT NULL DEFAULT false,
        paid_at TIMESTAMPTZ,
        applied_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS horse_race_posts (
        id SERIAL PRIMARY KEY,
        horse_race_id INT NOT NULL REFERENCES horse_races(id) ON DELETE CASCADE,
        channel_id BIGINT NOT NULL,
        message_id TEXT NOT NULL,
        post_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (horse_race_id, channel_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS horse_race_collab_invites (
        id SERIAL PRIMARY KEY,
        horse_race_id INT NOT NULL UNIQUE REFERENCES horse_races(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        created_by BIGINT REFERENCES users(max_user_id) ON DELETE SET NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS ix_horse_race_collab_invites_token
        ON horse_race_collab_invites (token);

      CREATE INDEX IF NOT EXISTS ix_horse_races_status_start
        ON horse_races (status, start_at);

      CREATE INDEX IF NOT EXISTS ix_horse_races_creator_created
        ON horse_races (creator_user_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS ix_horse_race_channels_race_required
        ON horse_race_channels (horse_race_id, is_required);

      CREATE INDEX IF NOT EXISTS ix_horse_race_participants_race_valid
        ON horse_race_participants (horse_race_id, is_valid);

      CREATE INDEX IF NOT EXISTS ix_horse_race_participants_user
        ON horse_race_participants (user_id, joined_at DESC);

      CREATE INDEX IF NOT EXISTS ix_horse_race_rounds_race_start
        ON horse_race_rounds (horse_race_id, starts_at);

      CREATE INDEX IF NOT EXISTS ix_horse_race_payments_race_status
        ON horse_race_payments (horse_race_id, status);

      ALTER TABLE horse_race_posts
        ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';

      ALTER TABLE horse_race_posts
        ADD COLUMN IF NOT EXISTS error_text TEXT;

      ALTER TABLE horse_race_posts
        ADD COLUMN IF NOT EXISTS publishing_started_at TIMESTAMPTZ;

      ALTER TABLE horse_race_posts
        ADD COLUMN IF NOT EXISTS participants_count INT NOT NULL DEFAULT 0;

      ALTER TABLE horse_race_posts
        ALTER COLUMN message_id DROP NOT NULL;

      ALTER TABLE horse_race_rounds
        ADD COLUMN IF NOT EXISTS winner_notified_at TIMESTAMPTZ;

      ALTER TABLE horse_races
        ADD COLUMN IF NOT EXISTS results_notified_at TIMESTAMPTZ;

      DELETE FROM horse_race_posts older
      USING horse_race_posts newer
      WHERE older.horse_race_id = newer.horse_race_id
        AND older.channel_id = newer.channel_id
        AND older.id < newer.id;

      CREATE INDEX IF NOT EXISTS ix_horse_race_posts_race
        ON horse_race_posts (horse_race_id, created_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS ux_horse_race_posts_race_channel
        ON horse_race_posts (horse_race_id, channel_id);
    `);

    console.log('✅ Horse races tables are ready');
  }

  async function upsertValidatedUser(user) {
    const userId = String(user?.id || '').trim();
    if (!/^\d+$/.test(userId)) {
      throw new Error('MAX user id is invalid');
    }

    await pool.query(`
      INSERT INTO users (max_user_id, username, first_name, last_name, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (max_user_id)
      DO UPDATE SET
        username = COALESCE(EXCLUDED.username, users.username),
        first_name = COALESCE(EXCLUDED.first_name, users.first_name),
        last_name = COALESCE(EXCLUDED.last_name, users.last_name),
        updated_at = NOW()
    `, [
      userId,
      cleanNullableText(user.username, 200),
      cleanNullableText(user.first_name, 200),
      cleanNullableText(user.last_name, 200)
    ]);

    return userId;
  }

  function rateLimit(req, res, next) {
    const identity = String(req.maxAuth?.user?.id || req.ip || 'unknown');
    const now = Date.now();
    const windowMs = 60_000;
    const current = rateMap.get(identity) || { count: 0, resetAt: now + windowMs };

    if (now >= current.resetAt) {
      current.count = 0;
      current.resetAt = now + windowMs;
    }

    current.count += 1;
    rateMap.set(identity, current);

    if (current.count > config.apiRateLimit) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
      return res.status(429).json({ ok: false, error: 'Слишком много запросов. Попробуйте ещё раз позже.' });
    }

    return next();
  }

  async function requireMaxAuth(req, res, next) {
    try {
      const initData = String(req.get('X-Max-Init-Data') || '').trim();
      const validation = validateMaxInitData(initData, MAX_BOT_TOKEN, {
        maxAgeSeconds: config.authMaxAgeSeconds,
        futureSkewSeconds: config.authFutureSkewSeconds
      });

      if (!validation.ok) {
        return res.status(401).json({
          ok: false,
          error: 'Откройте Mini App внутри MAX.',
          code: validation.code
        });
      }

      await upsertValidatedUser(validation.data.user);
      req.maxAuth = validation.data;
      res.set('Cache-Control', 'no-store');
      return next();
    } catch (error) {
      console.error('Mini App auth error:', error.message);
      return res.status(401).json({ ok: false, error: 'Не удалось проверить пользователя MAX.' });
    }
  }

  async function getTopRaffles(userId) {
    const result = await pool.query(`
      SELECT
        r.id,
        r.title,
        r.description,
        r.prizes,
        r.prize_count,
        r.photo_attachment,
        r.end_at,
        r.created_at,
        COALESCE(pc.participants_count, 0)::int AS participants_count,
        tb.boosted_at
      FROM raffles r
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS participants_count
        FROM raffle_user_entry rue
        WHERE rue.raffle_id = r.id
      ) pc ON true
      LEFT JOIN LATERAL (
        SELECT created_at AS boosted_at
        FROM raffle_top_boosts
        WHERE raffle_id = r.id
        ORDER BY created_at DESC
        LIMIT 1
      ) tb ON true
      WHERE r.status = 'active'
        AND r.end_at > NOW()
      ORDER BY
        CASE WHEN tb.boosted_at IS NULL THEN 1 ELSE 0 END,
        tb.boosted_at DESC NULLS LAST,
        r.end_at ASC,
        r.id DESC
      LIMIT $1
    `, [config.topRafflesLimit]);

    return result.rows.map(row => ({
      id: Number(row.id),
      title: cleanText(row.title, 180) || 'Без названия',
      description: cleanText(row.description, 500),
      prizes: splitNonEmptyLines(row.prizes).slice(0, 10),
      prizeCount: Number(row.prize_count || 1),
      participantsCount: Number(row.participants_count || 0),
      photoUrl: extractPublicPhotoUrl(row.photo_attachment),
      endsAt: toIso(row.end_at),
      boostedAt: toIso(row.boosted_at),
      isTop1: Boolean(row.boosted_at),
      joinUrl: getBotUrl(`join_${Number(row.id)}`),
      top1BuyUrl: getBotUrl('top1_buy')
    }));
  }

  async function getAvailableRaces(userId) {
    const result = await pool.query(`
      SELECT
        hr.*,
        COALESCE(pc.participants_count, 0)::int AS participants_count,
        p.ticket_number AS own_ticket_number,
        p.horse_color AS own_horse_color
      FROM horse_races hr
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS participants_count
        FROM horse_race_participants hp
        WHERE hp.horse_race_id = hr.id
          AND hp.is_valid = true
      ) pc ON true
      LEFT JOIN horse_race_participants p
        ON p.horse_race_id = hr.id
       AND p.user_id = $1
       AND p.is_valid = true
      WHERE (
          hr.status IN ('scheduled', 'active', 'running')
        ) OR (
          hr.status = 'finished'
          AND COALESCE(hr.finished_at, hr.updated_at) > NOW() - ($2::int * INTERVAL '1 hour')
        )
      ORDER BY
        CASE
          WHEN hr.status = 'running' THEN 0
          WHEN hr.status IN ('scheduled', 'active') THEN 1
          WHEN hr.status = 'finished' THEN 2
          ELSE 3
        END,
        CASE WHEN hr.status IN ('scheduled', 'active') THEN hr.created_at END DESC NULLS LAST,
        CASE WHEN hr.status = 'running' THEN hr.start_at END DESC NULLS LAST,
        hr.finished_at DESC NULLS LAST,
        hr.id DESC
      LIMIT $3
    `, [String(userId), config.replayHours, config.racesLimit]);

    const now = Date.now();

    return result.rows.map(row => serializeRaceListRow(row, now));
  }

  function serializeRaceListRow(row, now = Date.now()) {
    const startMs = new Date(row.start_at).getTime();
    const openAtMs = startMs - RACE_OPEN_BEFORE_MS;
    const status = String(row.status || 'draft');
    const canOpen = now >= openAtMs || ['running', 'finished'].includes(status);
    const raceId = Number(row.id);
    const isFinished = status === 'finished';
    const isRunning = status === 'running';
    const canJoin = ACTIVE_RACE_STATUSES.has(status) && startMs > now;

    return {
      id: raceId,
      title: cleanText(row.title, 180) || 'Скачки',
      description: cleanText(row.description, 500),
      prizes: splitNonEmptyLines(row.prizes).slice(0, 20),
      prizeCount: Number(row.prize_count || 1),
      photoUrl: normalizePublicPhotoUrl(row.photo_url) || extractPublicPhotoUrl(row.photo_attachment),
      startsAt: toIso(row.start_at),
      openAt: Number.isFinite(openAtMs) ? new Date(openAtMs).toISOString() : null,
      status,
      statusLabel: isFinished ? 'Завершено' : (isRunning ? 'Идёт сейчас' : 'Ожидает старта'),
      isFinished,
      isRunning,
      canJoin,
      replayAvailable: isFinished,
      canOpen,
      participantsCount: Number(row.participants_count || 0),
      ownTicketNumber: row.own_ticket_number ? String(row.own_ticket_number) : null,
      ownHorseColor: serializeHorseColor(row.own_horse_color),
      joinUrl: getBotUrl(`horse_join_${raceId}`),
      watchUrl: getLaunchUrl(`race_${raceId}`)
    };
  }

  async function getRaceById(raceId, userId = null) {
    const id = normalizePositiveInt(raceId);
    if (!id) return null;

    const result = await pool.query(`
      SELECT
        hr.*,
        COALESCE(pc.participants_count, 0)::int AS participants_count,
        p.ticket_number AS own_ticket_number,
        p.horse_color AS own_horse_color
      FROM horse_races hr
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS participants_count
        FROM horse_race_participants hp
        WHERE hp.horse_race_id = hr.id
          AND hp.is_valid = true
      ) pc ON true
      LEFT JOIN horse_race_participants p
        ON p.horse_race_id = hr.id
       AND p.user_id = $2
       AND p.is_valid = true
      WHERE hr.id = $1
      LIMIT 1
    `, [id, userId ? String(userId) : null]);

    return result.rows[0] || null;
  }

  async function getRaceChannels(raceId) {
    const result = await pool.query(`
      SELECT user_channel_id, channel_id, channel_title, channel_link, owner_user_id, is_required, publish_post
      FROM horse_race_channels
      WHERE horse_race_id = $1
      ORDER BY id ASC
    `, [normalizePositiveInt(raceId)]);

    return result.rows.map(row => ({
      userChannelId: row.user_channel_id ? Number(row.user_channel_id) : null,
      channelId: String(row.channel_id),
      title: cleanText(row.channel_title, 200) || 'Канал',
      link: normalizePublicHttpUrl(row.channel_link),
      ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
      isRequired: Boolean(row.is_required),
      publishPost: Boolean(row.publish_post)
    }));
  }

  async function getRaceDetails(raceId, userId) {
    const row = await getRaceById(raceId, userId);
    if (!row) return null;

    const now = Date.now();
    const basic = serializeRaceListRow(row, now);
    const channels = await getRaceChannels(row.id);

    return {
      ...basic,
      description: cleanText(row.description, 2000),
      channels,
      colors: HORSE_COLORS.map(color => ({ ...color })),
      priceAmount: Number(row.price_amount || config.racePriceRub),
      paymentStatus: String(row.payment_status || 'pending'),
      publishedInGeneral: Boolean(row.published_in_general),
      generalChannelName: config.generalChannelName
    };
  }


  function buildRaceCollabInviteLink(token) {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) return '';

    // Ссылка сразу открывает нужный сценарий внутри бота.
    // Так пользователь не попадает на промежуточную страницу Render.
    return getBotUrl(`horse_collab_${cleanToken}`);
  }

  function isRaceCollabInviteActive(invite) {
    if (!invite || invite.is_active === false || invite.closed_at) return false;
    if (!ACTIVE_RACE_STATUSES.has(String(invite.race_status || ''))) return false;
    return new Date(invite.start_at).getTime() > Date.now();
  }

  async function getRaceCollabInviteByToken(token) {
    const cleanToken = String(token || '').trim();
    if (!/^[A-Za-z0-9_-]{20,160}$/.test(cleanToken)) return null;

    const res = await pool.query(`
      SELECT
        hci.*,
        hr.title AS race_title,
        hr.creator_user_id,
        hr.status AS race_status,
        hr.start_at
      FROM horse_race_collab_invites hci
      JOIN horse_races hr ON hr.id = hci.horse_race_id
      WHERE hci.token = $1
      LIMIT 1
    `, [cleanToken]);

    return res.rows[0] || null;
  }

  async function getOrCreateRaceCollabInvite(raceId, userId) {
    const id = normalizePositiveInt(raceId);
    const cleanUserId = String(userId || '').trim();
    const race = await getRaceById(id);

    if (!race) throw new Error('Скачки не найдены');
    if (!isAdmin(cleanUserId) && String(race.creator_user_id) !== cleanUserId) {
      throw new Error('Создать ссылку может только организатор скачек');
    }
    if (!ACTIVE_RACE_STATUSES.has(String(race.status || '')) || new Date(race.start_at).getTime() <= Date.now()) {
      throw new Error('К завершённым или начавшимся скачкам уже нельзя добавлять каналы');
    }

    const existing = await pool.query(`
      SELECT *
      FROM horse_race_collab_invites
      WHERE horse_race_id = $1
      LIMIT 1
    `, [id]);

    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (!row.is_active || row.closed_at) {
        const reopened = await pool.query(`
          UPDATE horse_race_collab_invites
          SET is_active = true, closed_at = NULL, updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `, [row.id]);
        return reopened.rows[0];
      }
      return row;
    }

    const token = crypto.randomBytes(24).toString('base64url');
    const created = await pool.query(`
      INSERT INTO horse_race_collab_invites (
        horse_race_id,
        token,
        created_by,
        is_active,
        updated_at
      )
      VALUES ($1, $2, $3, true, NOW())
      RETURNING *
    `, [id, token, cleanUserId || null]);

    return created.rows[0];
  }

  async function sendRaceCollabInvite(target, userId, raceId) {
    const invite = await getOrCreateRaceCollabInvite(raceId, userId);
    const race = await getRaceById(raceId);
    const link = buildRaceCollabInviteLink(invite.token);

    return sendMessage?.(
      target,
      [
        '🤝 **Приглашение каналов в скачки**',
        '',
        `🐎 Скачки: **${cleanText(race?.title, 180) || `#${raceId}`}**`,
        '',
        'По этой ссылке владелец канала сможет подключить свой канал и выбрать только один режим:',
        '📣 **с размещением** поста или 🙈 **без размещения**.',
        'Подписка на добавленный канал всегда будет обязательной.',
        '',
        link
      ].join('\n'),
      [[{ text: '🤝 Открыть приглашение', url: link }]]
    );
  }

  async function getRaceCollabSelectableChannels(userId) {
    const res = await pool.query(`
      SELECT id, channel_id, channel_title, channel_link, owner_user_id, can_publish
      FROM user_channels
      WHERE owner_user_id = $1
        AND is_active = true
      ORDER BY updated_at DESC, id DESC
      LIMIT 50
    `, [String(userId)]);

    return res.rows;
  }

  async function sendRaceCollabChannelSelection(target, userId, data = {}) {
    const invite = await getRaceCollabInviteByToken(data.token);
    if (!isRaceCollabInviteActive(invite)) {
      await clearSession?.(userId);
      return sendMessage?.(target, '🔒 Ссылка приглашения закрыта или скачки уже начались.');
    }

    const channels = await getRaceCollabSelectableChannels(userId);
    const selected = Array.isArray(data.channels) ? data.channels : [];
    const selectedMap = new Map(selected.map(item => [Number(item.user_channel_id), item]));

    data.race_id = Number(invite.horse_race_id);
    data.channels = selected;
    await setSession?.(userId, 'horse_collab_channels', data);

    const text = [
      '🤝 **Добавить канал в скачки**',
      '',
      `🐎 ${cleanText(invite.race_title, 180) || `Скачки #${invite.horse_race_id}`}`,
      '',
      'Выберите канал. Подписка на него будет обязательной.',
      'Для выбранного канала можно переключить только:',
      '📣 **с размещением** или 🙈 **без размещения**.'
    ];

    if (!channels.length) {
      text.push('', 'У вас нет подключённых активных каналов. Добавьте бота в канал, затем снова откройте ссылку приглашения.');
    } else if (selected.length) {
      text.push('', '**Выбрано:**');
      for (const item of selected) {
        text.push(`• ${cleanText(item.title, 120) || item.channel_id} — ${item.publish_post ? 'с размещением📣' : 'без размещения🙈'}`);
      }
    }

    const keyboard = [];
    for (const channel of channels) {
      const channelId = Number(channel.id);
      const item = selectedMap.get(channelId);
      keyboard.push([{
        text: `${item ? '✅' : '⬜'} ${cleanText(channel.channel_title, 32) || `Канал ${channel.channel_id}`}`,
        callback_data: `horse_collab_toggle:${channelId}`
      }]);

      if (item) {
        keyboard.push([{
          text: item.publish_post ? '🙈 Выбрать без размещения' : '📣 Выбрать с размещением',
          callback_data: `horse_collab_publish:${channelId}`
        }]);
      }
    }

    if (selected.length) {
      keyboard.push([{ text: `✅ Добавить каналы (${selected.length})`, callback_data: 'horse_collab_done' }]);
    }
    keyboard.push([{ text: '❌ Отмена', callback_data: 'horse_collab_cancel' }]);

    return sendMessage?.(target, text.join('\n'), keyboard);
  }

  async function addRaceCollabChannelsFromSession(target, userId, data = {}) {
    const invite = await getRaceCollabInviteByToken(data.token);
    if (!isRaceCollabInviteActive(invite)) {
      await clearSession?.(userId);
      return sendMessage?.(target, '🔒 Ссылка приглашения закрыта или скачки уже начались.');
    }

    const selected = Array.isArray(data.channels) ? data.channels : [];
    if (!selected.length) {
      return sendMessage?.(target, 'Выберите хотя бы один канал.');
    }

    const available = await getRaceCollabSelectableChannels(userId);
    const availableMap = new Map(available.map(channel => [Number(channel.id), channel]));
    const valid = [];

    for (const selectedItem of selected) {
      const channel = availableMap.get(Number(selectedItem.user_channel_id));
      if (!channel) continue;

      const publishPost = Boolean(selectedItem.publish_post);
      if (publishPost && !channel.can_publish) {
        throw new Error(`Для канала «${cleanText(channel.channel_title, 100) || channel.channel_id}» нет права публикации`);
      }

      valid.push({
        userChannelId: Number(channel.id),
        channelId: String(channel.channel_id),
        title: cleanText(channel.channel_title, 250) || 'Канал',
        link: normalizePublicHttpUrl(channel.channel_link),
        ownerUserId: String(userId),
        isRequired: true,
        publishPost
      });
    }

    if (!valid.length) {
      return sendMessage?.(target, 'Выбранные каналы больше недоступны. Откройте приглашение ещё раз.');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const channel of valid) {
        await client.query(`
          INSERT INTO horse_race_channels (
            horse_race_id,
            user_channel_id,
            channel_id,
            channel_title,
            channel_link,
            owner_user_id,
            is_required,
            publish_post,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, true, $7, NOW())
          ON CONFLICT (horse_race_id, channel_id)
          DO UPDATE SET
            user_channel_id = EXCLUDED.user_channel_id,
            channel_title = EXCLUDED.channel_title,
            channel_link = EXCLUDED.channel_link,
            owner_user_id = EXCLUDED.owner_user_id,
            is_required = true,
            publish_post = EXCLUDED.publish_post,
            updated_at = NOW()
        `, [
          Number(invite.horse_race_id),
          channel.userChannelId,
          channel.channelId,
          channel.title,
          channel.link,
          channel.ownerUserId,
          channel.publishPost
        ]);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const publishResults = [];
    for (const channel of valid.filter(item => item.publishPost)) {
      try {
        publishResults.push(await publishRaceToChannel(invite.horse_race_id, channel.channelId));
      } catch (error) {
        publishResults.push({ error: cleanText(error.message, 300), channelId: channel.channelId });
      }
    }

    await updateRacePublishedPosts(invite.horse_race_id).catch(() => {});
    await clearSession?.(userId);

    const publishedCount = publishResults.filter(item => item?.published || item?.skipped).length;
    const noPublishCount = valid.filter(item => !item.publishPost).length;

    await sendMessage?.(
      target,
      [
        '✅ **Каналы добавлены в скачки.**',
        '',
        `📣 С размещением: **${publishedCount}**`,
        `🙈 Без размещения: **${noPublishCount}**`,
        '',
        'Подписка на все добавленные каналы включена как обязательная.'
      ].join('\n'),
      [[{ text: '🐎 Смотреть скачки', url: getLaunchUrl(`race_${invite.horse_race_id}`) }]]
    );

    await sendMessage?.(
      String(invite.creator_user_id),
      [
        '🤝 **К скачкам подключены новые каналы**',
        '',
        `🐎 ${cleanText(invite.race_title, 180) || `Скачки #${invite.horse_race_id}`}`,
        ...valid.map(item => `• ${item.title} — ${item.publishPost ? 'с размещением📣' : 'без размещения🙈'}`)
      ].join('\n')
    ).catch(() => {});

    return true;
  }

  async function startRaceCollabFlow(target, userId, token) {
    const invite = await getRaceCollabInviteByToken(token);
    if (!isRaceCollabInviteActive(invite)) {
      return sendMessage?.(target, '🔒 Ссылка приглашения закрыта или скачки уже начались.');
    }

    const data = {
      token: invite.token,
      race_id: Number(invite.horse_race_id),
      channels: []
    };

    await setSession?.(userId, 'horse_collab_channels', data);
    return sendRaceCollabChannelSelection(target, userId, data);
  }

  async function createRaceDraft(input = {}) {
    const creatorUserId = String(input.creatorUserId || '').trim();
    if (!/^\d+$/.test(creatorUserId)) throw new Error('creatorUserId is invalid');

    const title = cleanText(input.title, 180) || 'Скачки';
    const description = cleanText(input.description, 4000);
    const prizes = splitNonEmptyLines(input.prizes).join('\n') || 'Главный приз';
    const prizeCount = Math.max(1, Math.min(50, splitNonEmptyLines(prizes).length || Number(input.prizeCount || 1)));
    const startAt = new Date(input.startAt);

    if (Number.isNaN(startAt.getTime()) || startAt.getTime() <= Date.now() + config.minStartMinutes * 60_000) {
      throw new Error(`Время старта скачек должно быть минимум через ${config.minStartMinutes} минут`);
    }

    const result = await pool.query(`
      INSERT INTO horse_races (
        creator_user_id,
        title,
        description,
        prizes,
        prize_count,
        photo_attachment,
        photo_url,
        publish_at,
        start_at,
        status,
        price_amount,
        payment_status,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'draft', $10, $11, NOW())
      RETURNING *
    `, [
      creatorUserId,
      title,
      description || null,
      prizes,
      prizeCount,
      input.photoAttachment ? JSON.stringify(input.photoAttachment) : null,
      normalizePublicPhotoUrl(input.photoUrl) || extractPublicPhotoUrl(input.photoAttachment),
      input.publishAt ? new Date(input.publishAt) : new Date(),
      startAt,
      Number(input.priceAmount || config.racePriceRub),
      input.paymentStatus || (isAdmin(creatorUserId) ? 'admin_free' : 'pending')
    ]);

    return result.rows[0];
  }

  async function setRaceChannels(raceId, channels = []) {
    const id = normalizePositiveInt(raceId);
    if (!id) throw new Error('horse race id is invalid');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM horse_race_channels WHERE horse_race_id = $1', [id]);

      for (const channel of Array.isArray(channels) ? channels : []) {
        const channelId = String(channel.channelId || channel.channel_id || '').trim();
        if (!/^-?\d+$/.test(channelId)) continue;

        await client.query(`
          INSERT INTO horse_race_channels (
            horse_race_id,
            user_channel_id,
            channel_id,
            channel_title,
            channel_link,
            owner_user_id,
            is_required,
            publish_post,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          ON CONFLICT (horse_race_id, channel_id)
          DO UPDATE SET
            user_channel_id = EXCLUDED.user_channel_id,
            channel_title = EXCLUDED.channel_title,
            channel_link = EXCLUDED.channel_link,
            owner_user_id = EXCLUDED.owner_user_id,
            is_required = EXCLUDED.is_required,
            publish_post = EXCLUDED.publish_post,
            updated_at = NOW()
        `, [
          id,
          normalizePositiveInt(channel.userChannelId || channel.user_channel_id),
          channelId,
          cleanNullableText(channel.title || channel.channel_title, 250),
          normalizePublicHttpUrl(channel.link || channel.channel_link),
          channel.ownerUserId || channel.owner_user_id || null,
          channel.isRequired !== false && channel.is_required !== false,
          channel.publishPost !== false && channel.publish_post !== false
        ]);
      }

      await client.query('COMMIT');
      return getRaceChannels(id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function activateRace(raceId, options = {}) {
    const id = normalizePositiveInt(raceId);
    if (!id) throw new Error('horse race id is invalid');

    const row = await getRaceById(id);
    if (!row) throw new Error('Скачки не найдены');

    const adminFree = Boolean(options.adminFree || isAdmin(options.userId || row.creator_user_id));
    const paymentStatus = adminFree ? 'admin_free' : String(options.paymentStatus || 'succeeded');

    if (!adminFree && paymentStatus !== 'succeeded') {
      throw new Error('Скачки можно активировать только после успешной оплаты');
    }

    const result = await pool.query(`
      UPDATE horse_races
      SET
        status = CASE WHEN start_at <= NOW() THEN 'running' ELSE 'active' END,
        payment_status = $2,
        payment_id = COALESCE($3, payment_id),
        published_in_general = COALESCE($4, published_in_general),
        general_channel_id = COALESCE($5, general_channel_id),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [
      id,
      paymentStatus,
      options.paymentId || null,
      options.publishedInGeneral === undefined ? null : Boolean(options.publishedInGeneral),
      options.generalChannelId || config.generalChannelId || null
    ]);

    return result.rows[0];
  }

  async function addParticipant(raceId, userId) {
    const id = normalizePositiveInt(raceId);
    const cleanUserId = String(userId || '').trim();
    if (!id || !/^\d+$/.test(cleanUserId)) throw new Error('Некорректные данные участия');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const raceRes = await client.query(`
        SELECT *
        FROM horse_races
        WHERE id = $1
        FOR UPDATE
      `, [id]);

      const race = raceRes.rows[0];
      if (!race || !ACTIVE_RACE_STATUSES.has(String(race.status || '')) || new Date(race.start_at).getTime() <= Date.now()) {
        throw new Error('Участие в этих скачках уже закрыто');
      }

      const existingRes = await client.query(`
        SELECT *
        FROM horse_race_participants
        WHERE horse_race_id = $1
          AND user_id = $2
        LIMIT 1
      `, [id, cleanUserId]);

      if (existingRes.rows[0]) {
        await client.query('COMMIT');
        return { participant: existingRes.rows[0], created: false };
      }

      const countsRes = await client.query(`
        SELECT horse_color, COUNT(*)::int AS count
        FROM horse_race_participants
        WHERE horse_race_id = $1
          AND is_valid = true
        GROUP BY horse_color
      `, [id]);

      const counts = new Map(HORSE_COLORS.map(color => [color.code, 0]));
      for (const row of countsRes.rows) {
        if (counts.has(row.horse_color)) counts.set(row.horse_color, Number(row.count || 0));
      }

      const minCount = Math.min(...counts.values());
      const leastUsed = HORSE_COLORS.filter(color => counts.get(color.code) === minCount);
      const selectedColor = leastUsed[crypto.randomInt(0, leastUsed.length)].code;

      let participant = null;
      for (let attempt = 0; attempt < 8 && !participant; attempt += 1) {
        const ticket = generateTicketNumber();
        try {
          const insertRes = await client.query(`
            INSERT INTO horse_race_participants (
              horse_race_id,
              user_id,
              ticket_number,
              horse_color,
              is_valid,
              ticket_type,
              updated_at
            )
            VALUES ($1, $2, $3, $4, true, 'main', NOW())
            RETURNING *
          `, [id, cleanUserId, ticket, selectedColor]);
          participant = insertRes.rows[0];
        } catch (error) {
          if (error?.code !== '23505') throw error;
        }
      }

      if (!participant) throw new Error('Не удалось создать уникальный билет');

      await client.query(`
        INSERT INTO horse_race_pending_joins (horse_race_id, user_id, status, updated_at)
        VALUES ($1, $2, 'completed', NOW())
        ON CONFLICT (horse_race_id, user_id)
        DO UPDATE SET status = 'completed', updated_at = NOW()
      `, [id, cleanUserId]);

      await client.query('COMMIT');
      await updateRacePublishedPosts(id).catch(error => {
        console.warn(`Не удалось обновить посты скачек ${id}:`, error.message);
      });
      return { participant, created: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function prepareRaceRounds(raceId) {
    const id = normalizePositiveInt(raceId);
    if (!id) return [];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const raceRes = await client.query(`
        SELECT *
        FROM horse_races
        WHERE id = $1
        FOR UPDATE
      `, [id]);

      const race = raceRes.rows[0];
      if (!race) {
        await client.query('ROLLBACK');
        return [];
      }

      const existingRes = await client.query(`
        SELECT *
        FROM horse_race_rounds
        WHERE horse_race_id = $1
        ORDER BY prize_index ASC
      `, [id]);

      if (existingRes.rows.length >= Math.max(1, Number(race.prize_count || 1))) {
        await client.query('COMMIT');
        return existingRes.rows;
      }

      // На этом этапе создаём только расписание и seed анимации.
      // Победителей нельзя выбирать заранее: участие открыто до самого старта.
      const prizes = splitNonEmptyLines(race.prizes);
      const prizeCount = Math.max(1, Number(race.prize_count || prizes.length || 1));
      const startBase = new Date(race.start_at).getTime();
      let offsetMs = 0;

      for (let index = 0; index < prizeCount; index += 1) {
        if (existingRes.rows.some(row => Number(row.prize_index) === index + 1)) continue;

        const durationMs = 18_000 + crypto.randomInt(0, 7_001);
        const startsAt = new Date(startBase + offsetMs);
        const seed = crypto.randomBytes(18).toString('hex');

        await client.query(`
          INSERT INTO horse_race_rounds (
            horse_race_id,
            prize_index,
            prize_text,
            starts_at,
            duration_ms,
            animation_seed,
            status,
            winner_participant_id,
            winner_user_id,
            winner_ticket_number,
            winner_color,
            result_json,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'prepared', NULL, NULL, NULL, NULL, $7::jsonb, NOW())
          ON CONFLICT (horse_race_id, prize_index) DO NOTHING
        `, [
          id,
          index + 1,
          prizes[index] || `Приз ${index + 1}`,
          startsAt,
          durationMs,
          seed,
          JSON.stringify({ algorithm: 'server_ticket_first_v1', winner_selected: false })
        ]);

        offsetMs += durationMs + 4_000;
      }

      await client.query(`
        UPDATE horse_races
        SET
          status = CASE WHEN start_at <= NOW() THEN 'running' ELSE 'active' END,
          updated_at = NOW()
        WHERE id = $1
          AND status IN ('scheduled', 'active', 'running')
      `, [id]);

      const roundsRes = await client.query(`
        SELECT *
        FROM horse_race_rounds
        WHERE horse_race_id = $1
        ORDER BY prize_index ASC
      `, [id]);

      await client.query('COMMIT');
      return roundsRes.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function finalizeRaceWinners(raceId) {
    const id = normalizePositiveInt(raceId);
    if (!id) return [];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const raceRes = await client.query(`
        SELECT *
        FROM horse_races
        WHERE id = $1
        FOR UPDATE
      `, [id]);

      const race = raceRes.rows[0];
      if (!race || new Date(race.start_at).getTime() > Date.now()) {
        await client.query('COMMIT');
        return [];
      }

      const roundsRes = await client.query(`
        SELECT *
        FROM horse_race_rounds
        WHERE horse_race_id = $1
        ORDER BY prize_index ASC
        FOR UPDATE
      `, [id]);

      if (!roundsRes.rows.length) {
        await client.query('COMMIT');
        return [];
      }

      const participantsRes = await client.query(`
        SELECT *
        FROM horse_race_participants
        WHERE horse_race_id = $1
          AND is_valid = true
        ORDER BY id ASC
      `, [id]);

      const allParticipants = participantsRes.rows;
      let remaining = secureShuffle(allParticipants);
      let lastWinnerId = null;

      for (const round of roundsRes.rows) {
        if (round.winner_participant_id || round.result_json?.winner_selected === true) {
          lastWinnerId = round.winner_participant_id || lastWinnerId;
          continue;
        }

        if (!remaining.length && allParticipants.length) {
          remaining = secureShuffle(allParticipants);
          if (remaining.length > 1 && String(remaining[0]?.id) === String(lastWinnerId)) {
            [remaining[0], remaining[1]] = [remaining[1], remaining[0]];
          }
        }

        const winner = remaining.length ? remaining.shift() : null;
        if (winner) lastWinnerId = winner.id;
        await client.query(`
          UPDATE horse_race_rounds
          SET
            winner_participant_id = $2,
            winner_user_id = $3,
            winner_ticket_number = $4,
            winner_color = $5,
            result_json = $6::jsonb,
            updated_at = NOW()
          WHERE id = $1
        `, [
          round.id,
          winner?.id || null,
          winner?.user_id || null,
          winner?.ticket_number || null,
          winner?.horse_color || null,
          JSON.stringify({
            algorithm: 'server_ticket_first_v1',
            winner_selected: true,
            selected_at: new Date().toISOString(),
            no_participants: !winner
          })
        ]);
      }

      await client.query(`
        UPDATE horse_races
        SET status = 'running', updated_at = NOW()
        WHERE id = $1
          AND status IN ('scheduled', 'active', 'running')
      `, [id]);

      const finalRes = await client.query(`
        SELECT *
        FROM horse_race_rounds
        WHERE horse_race_id = $1
        ORDER BY prize_index ASC
      `, [id]);

      await client.query('COMMIT');
      return finalRes.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function refreshRaceLifecycle(raceId = null) {
    await pool.query(`
      UPDATE horse_races
      SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, NOW()), updated_at = NOW()
      WHERE status = 'draft'
        AND payment_status = 'pending'
        AND created_at < NOW() - INTERVAL '24 hours'
        AND ($1::int IS NULL OR id = $1)
    `, [raceId ? normalizePositiveInt(raceId) : null]);

    const params = [];
    const where = raceId ? 'AND hr.id = $1' : '';
    if (raceId) params.push(normalizePositiveInt(raceId));

    const racesRes = await pool.query(`
      SELECT hr.id
      FROM horse_races hr
      WHERE hr.status IN ('scheduled', 'active', 'running')
        ${where}
        AND hr.start_at <= NOW() + INTERVAL '12 hours'
      ORDER BY hr.start_at ASC
      LIMIT 100
    `, params);

    for (const row of racesRes.rows) {
      await prepareRaceRounds(row.id);
      const race = await getRaceById(row.id);
      if (race && new Date(race.start_at).getTime() <= Date.now()) {
        await finalizeRaceWinners(row.id);
      }
    }

    await pool.query(`
      UPDATE horse_race_rounds
      SET
        status = CASE
          WHEN NOW() >= starts_at + (duration_ms::text || ' milliseconds')::interval THEN 'finished'
          WHEN NOW() >= starts_at THEN 'running'
          ELSE 'prepared'
        END,
        updated_at = NOW()
      WHERE status IN ('prepared', 'running')
        AND ($1::int IS NULL OR horse_race_id = $1)
    `, [raceId ? normalizePositiveInt(raceId) : null]);

    await pool.query(`
      UPDATE horse_races hr
      SET
        status = CASE
          WHEN EXISTS (
            SELECT 1
            FROM horse_race_rounds hrr
            WHERE hrr.horse_race_id = hr.id
              AND hrr.status IN ('prepared', 'running')
          ) AND hr.start_at <= NOW() THEN 'running'
          WHEN NOT EXISTS (
            SELECT 1
            FROM horse_race_rounds hrr
            WHERE hrr.horse_race_id = hr.id
              AND hrr.status IN ('prepared', 'running')
          ) AND EXISTS (
            SELECT 1 FROM horse_race_rounds hrr WHERE hrr.horse_race_id = hr.id
          ) THEN 'finished'
          ELSE hr.status
        END,
        finished_at = CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM horse_race_rounds hrr
            WHERE hrr.horse_race_id = hr.id
              AND hrr.status IN ('prepared', 'running')
          ) AND EXISTS (
            SELECT 1 FROM horse_race_rounds hrr WHERE hrr.horse_race_id = hr.id
          ) THEN COALESCE(hr.finished_at, NOW())
          ELSE hr.finished_at
        END,
        updated_at = NOW()
      WHERE hr.status IN ('scheduled', 'active', 'running')
        AND ($1::int IS NULL OR hr.id = $1)
    `, [raceId ? normalizePositiveInt(raceId) : null]);
  }

  async function getRaceLiveState(raceId, userId) {
    const race = await getRaceById(raceId, userId);
    if (!race) return null;

    const startMs = new Date(race.start_at).getTime();
    const canOpen = Date.now() >= startMs - RACE_OPEN_BEFORE_MS || ['running', 'finished'].includes(String(race.status));
    if (!canOpen) {
      return {
        locked: true,
        opensAt: new Date(startMs - RACE_OPEN_BEFORE_MS).toISOString(),
        startsAt: toIso(race.start_at),
        serverNow: new Date().toISOString()
      };
    }

    await prepareRaceRounds(race.id);
    if (Date.now() >= startMs) {
      await finalizeRaceWinners(race.id);
    }
    await refreshRaceLifecycle(race.id);

    const roundsRes = await pool.query(`
      SELECT *
      FROM horse_race_rounds
      WHERE horse_race_id = $1
      ORDER BY prize_index ASC
    `, [race.id]);

    const now = Date.now();
    const rounds = roundsRes.rows.map(row => {
      const startsAtMs = new Date(row.starts_at).getTime();
      const endsAtMs = startsAtMs + Number(row.duration_ms || 20_000);
      const state = now < startsAtMs ? 'upcoming' : now < endsAtMs ? 'running' : 'finished';

      return {
        id: Number(row.id),
        prizeIndex: Number(row.prize_index),
        prizeText: cleanText(row.prize_text, 500),
        startsAt: new Date(startsAtMs).toISOString(),
        endsAt: new Date(endsAtMs).toISOString(),
        durationMs: Number(row.duration_ms || 20_000),
        status: state,
        animationSeed: state === 'upcoming' ? null : String(row.animation_seed || ''),
        winnerColor: state === 'upcoming' ? null : serializeHorseColor(row.winner_color),
        winnerTicketNumber: state === 'finished' && row.winner_ticket_number
          ? String(row.winner_ticket_number)
          : null
      };
    });

    const currentRound = rounds.find(round => round.status === 'running')
      || rounds.find(round => round.status === 'upcoming')
      || rounds[rounds.length - 1]
      || null;

    return {
      locked: false,
      raceId: Number(race.id),
      raceStatus: String((await getRaceById(race.id, userId))?.status || race.status),
      serverNow: new Date().toISOString(),
      startsAt: toIso(race.start_at),
      ownTicketNumber: race.own_ticket_number ? String(race.own_ticket_number) : null,
      ownHorseColor: serializeHorseColor(race.own_horse_color),
      colors: HORSE_COLORS.map(color => ({ ...color })),
      rounds,
      currentRound,
      replayAvailable: String(race.status || '') === 'finished' && rounds.some(round => round.animationSeed && round.winnerColor)
    };
  }

  async function showRaceJoinStart(target, userId, raceId) {
    const race = await getRaceById(raceId, userId);
    if (!race) {
      await sendMessage?.(target, 'Скачки не найдены.');
      return true;
    }

    if (!ACTIVE_RACE_STATUSES.has(String(race.status || '')) || new Date(race.start_at).getTime() <= Date.now()) {
      await sendMessage?.(target, 'Участие в этих скачках уже закрыто.');
      return true;
    }

    if (race.own_ticket_number) {
      const color = serializeHorseColor(race.own_horse_color);
      await sendMessage?.(
        target,
        [
          `🐎 **${cleanText(race.title, 180) || 'Скачки'}**`,
          '',
          `Вы уже участвуете. Ваш билет: **№${race.own_ticket_number}**`,
          `Цвет вашей лошади: **${color?.label || race.own_horse_color}**`,
          `Старт: **${formatRaceDate(race.start_at)}**`
        ].join('\n'),
        [[{ text: '🐎 Смотреть скачки', url: getLaunchUrl(`race_${race.id}`) }]]
      );
      return true;
    }

    const channels = await getRaceChannels(race.id);
    const requiredChannels = channels.filter(channel => channel.isRequired);

    await pool.query(`
      INSERT INTO horse_race_pending_joins (horse_race_id, user_id, status, updated_at)
      VALUES ($1, $2, 'pending', NOW())
      ON CONFLICT (horse_race_id, user_id)
      DO UPDATE SET status = 'pending', updated_at = NOW()
    `, [race.id, String(userId)]);

    const lines = [
      `🐎 **${cleanText(race.title, 180) || 'Скачки'}**`,
      '',
      cleanText(race.description, 1200) || 'Подпишитесь на каналы и получите билет с цветом лошади.',
      '',
      `🎁 Призы: **${Math.max(1, Number(race.prize_count || 1))}**`,
      `⏰ Старт: **${formatRaceDate(race.start_at)}**`
    ];

    if (requiredChannels.length) {
      lines.push('', '📢 **Подпишитесь на каналы:**');
      requiredChannels.forEach((channel, index) => {
        lines.push(`${index + 1}. ${channel.link ? `[${escapeMarkdownText(channel.title)}](${channel.link})` : channel.title}`);
      });
    }

    lines.push('', 'После подписки нажмите кнопку проверки. Билет и цвет лошади сохранятся до конца скачек.');

    await sendMessage?.(
      target,
      lines.join('\n'),
      [
        [{ text: '✅ Проверить подписку', callback_data: `horse_join_check:${race.id}` }],
        [{ text: '🐎 Смотреть скачки', url: getLaunchUrl(`race_${race.id}`) }]
      ]
    );

    return true;
  }


  function buildHorseMenuText(userId) {
    return [
      '🐎 **Скачки**',
      '',
      `Создание скачек стоит **${config.racePriceRub} ₽**. После успешной оплаты скачки автоматически публикуются в **${config.generalChannelName}** и появляются в Mini App.`,
      '',
      isAdmin(userId)
        ? '👑 Для администратора создание бесплатное.'
        : 'Участие для зрителей и участников бесплатное.'
    ].join('\n');
  }

  async function sendHorseMenu(target, userId) {
    const keyboard = [
      [{ text: isAdmin(userId) ? '➕ Создать скачки бесплатно' : `➕ Создать скачки — ${config.racePriceRub} ₽`, callback_data: 'horse_create_start' }],
      [{ text: '🎟 Участвовать', callback_data: 'horse_join_menu' }],
      [{ text: '🤝 Пригласить каналы', callback_data: 'horse_collab_my_races' }],
      [{ text: '📱 Смотреть скачки в Mini App', url: getLaunchUrl('races') }]
    ];

    if (isAdmin(userId)) {
      keyboard.push([{ text: '👑 Активные скачки', callback_data: 'horse_admin_active' }]);
    }

    keyboard.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);
    return sendMessage?.(target, buildHorseMenuText(userId), keyboard);
  }

  async function getCreatorActiveRaceCount(userId) {
    const res = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM horse_races
      WHERE creator_user_id = $1
        AND status IN ('draft', 'scheduled', 'active', 'running')
        AND created_at > NOW() - INTERVAL '30 days'
    `, [String(userId)]);
    return Number(res.rows[0]?.count || 0);
  }

  function horseStepText(step, title, lines = []) {
    const body = Array.isArray(lines) ? lines : [lines];
    return [`🐎 **Шаг ${step}/6 — ${title}**`, '', ...body].join('\n');
  }

  async function startRaceCreation(target, userId) {
    const activeCount = await getCreatorActiveRaceCount(userId);
    if (!isAdmin(userId) && activeCount >= config.maxActivePerUser) {
      return sendMessage?.(target, `⚠️ У вас уже есть ${activeCount} незавершённых или активных скачек. Максимум: ${config.maxActivePerUser}.`);
    }

    await setSession?.(userId, 'horse_create_title', {});
    return sendMessage?.(
      target,
      horseStepText(1, 'Название', ['Введите название скачек:', 'Пример: **Большие летние скачки**']),
      [[{ text: '❌ Отмена', callback_data: 'horse_cancel' }]]
    );
  }

  async function sendRacePhotoPrompt(target, userId, data = {}) {
    await setSession?.(userId, 'horse_create_photo', data);
    const keyboard = [];
    if (data.photo_attachment) keyboard.push([{ text: '✅ Оставить фото', callback_data: 'horse_photo_keep' }]);
    keyboard.push([{ text: '⏭ Без фото', callback_data: 'horse_photo_skip' }]);
    keyboard.push([{ text: '⬅️ Назад', callback_data: 'horse_back:prizes' }]);
    keyboard.push([{ text: '❌ Отмена', callback_data: 'horse_cancel' }]);
    return sendMessage?.(target, horseStepText(4, 'Фото', [
      data.photo_attachment ? 'Фото уже добавлено. Можно отправить другое.' : 'Отправьте фото одним сообщением.',
      'Фото необязательно.'
    ]), keyboard);
  }

  function parseRaceStartInput(text) {
    if (typeof parseDateTime === 'function') {
      const parsed = parseDateTime(text);
      if (parsed && typeof parsed.isValid === 'function' && parsed.isValid()) {
        return new Date(parsed.toISOString());
      }
    }
    const fallback = new Date(String(text || '').trim());
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  async function sendRaceStartPrompt(target, userId, data = {}) {
    await setSession?.(userId, 'horse_create_start_at', data);
    return sendMessage?.(target, horseStepText(5, 'Время старта', [
      'Введите дату и время старта по МСК:',
      '`2026-06-18 20:00`',
      '`18.06.2026 20:00`',
      '',
      `Старт должен быть минимум через **${config.minStartMinutes} минут**.`
    ]), [
      [{ text: '⬅️ Назад к фото', callback_data: 'horse_back:photo' }],
      [{ text: '❌ Отмена', callback_data: 'horse_cancel' }]
    ]);
  }

  async function getSelectableChannels(userId) {
    const res = await pool.query(`
      SELECT id, channel_id, channel_title, channel_link, owner_user_id, can_publish
      FROM user_channels
      WHERE owner_user_id = $1
        AND is_active = true
        AND can_publish = true
      ORDER BY updated_at DESC, id DESC
      LIMIT 50
    `, [String(userId)]);
    return res.rows;
  }

  async function sendRaceChannelSelection(target, userId, data = {}) {
    const channels = await getSelectableChannels(userId);
    const selected = new Set((Array.isArray(data.channel_ids) ? data.channel_ids : []).map(Number));
    await setSession?.(userId, 'horse_create_channels', { ...data, channel_ids: [...selected] });

    const lines = [
      horseStepText(6, 'Каналы', [
        'Выберите каналы, на которые участники должны быть подписаны.',
        'Пост будет опубликован в выбранных каналах и автоматически в General.'
      ])
    ];
    const keyboard = channels.map(channel => [{
      text: `${selected.has(Number(channel.id)) ? '✅' : '⬜'} ${cleanText(channel.channel_title, 32) || `Канал ${channel.channel_id}`}`,
      callback_data: `horse_channel_toggle:${channel.id}`
    }]);

    if (!channels.length) {
      lines.push('', 'У вас нет активных каналов с правом публикации. Сначала добавьте канал в главном меню.');
      keyboard.push([{ text: '➕ Добавить канал', callback_data: 'add_channel' }]);
    } else {
      keyboard.push([{ text: `✅ Готово (${selected.size})`, callback_data: 'horse_channels_done' }]);
    }
    keyboard.push([{ text: '⬅️ Назад ко времени', callback_data: 'horse_back:start_at' }]);
    keyboard.push([{ text: '❌ Отмена', callback_data: 'horse_cancel' }]);
    return sendMessage?.(target, lines.join('\n'), keyboard);
  }

  async function resolveSelectedChannels(userId, channelIds = []) {
    const ids = [...new Set((Array.isArray(channelIds) ? channelIds : []).map(normalizePositiveInt).filter(Boolean))];
    if (!ids.length) return [];
    const res = await pool.query(`
      SELECT id, channel_id, channel_title, channel_link, owner_user_id, can_publish
      FROM user_channels
      WHERE owner_user_id = $1
        AND id = ANY($2::int[])
        AND is_active = true
        AND can_publish = true
      ORDER BY id ASC
    `, [String(userId), ids]);
    return res.rows;
  }

  async function sendRacePreview(target, userId, data = {}) {
    const channels = await resolveSelectedChannels(userId, data.channel_ids);
    await setSession?.(userId, 'horse_create_preview', data);
    const previewRace = {
      title: data.title,
      description: data.description,
      prizes: data.prizes,
      start_at: data.start_at
    };
    const text = [
      '👀 **Предпросмотр скачек**',
      '',
      buildRacePostText(previewRace, 0, channels.map(ch => ({
        title: ch.channel_title,
        link: ch.channel_link
      }))),
      '',
      `💳 Стоимость создания: **${isAdmin(userId) ? '0' : config.racePriceRub} ₽**`,
      isAdmin(userId) ? '👑 Администратор будет опубликован без оплаты.' : 'После подтверждения бот попросит email для чека.'
    ].join('\n');
    return sendMessage?.(target, text, [
      [{ text: isAdmin(userId) ? '✅ Создать бесплатно' : `💳 Перейти к оплате ${config.racePriceRub} ₽`, callback_data: 'horse_preview_confirm' }],
      [{ text: '🔄 Начать заново', callback_data: 'horse_create_start' }],
      [{ text: '❌ Отмена', callback_data: 'horse_cancel' }]
    ]);
  }

  async function createDraftFromSession(userId, data = {}) {
    if (data.race_id) {
      const existing = await getRaceById(data.race_id);
      if (existing && String(existing.creator_user_id) === String(userId)) return existing;
    }
    const channels = await resolveSelectedChannels(userId, data.channel_ids);
    if (!channels.length) throw new Error('Выберите хотя бы один канал');
    const race = await createRaceDraft({
      creatorUserId: userId,
      title: data.title,
      description: data.description,
      prizes: data.prizes,
      prizeCount: data.prize_count,
      photoAttachment: data.photo_attachment,
      startAt: data.start_at,
      publishAt: new Date(),
      paymentStatus: isAdmin(userId) ? 'admin_free' : 'pending'
    });
    await setRaceChannels(race.id, channels.map(ch => ({
      userChannelId: ch.id,
      channelId: ch.channel_id,
      title: ch.channel_title,
      link: ch.channel_link,
      ownerUserId: ch.owner_user_id,
      isRequired: true,
      publishPost: true
    })));
    return race;
  }

  function getRacePhotoAttachments(race = {}) {
    const value = normalizeJsonValue(race.photo_attachment);
    return value && typeof value === 'object' ? [value] : [];
  }

  async function getRaceParticipantsCount(raceId) {
    const res = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM horse_race_participants
      WHERE horse_race_id = $1 AND is_valid = true
    `, [normalizePositiveInt(raceId)]);
    return Number(res.rows[0]?.count || 0);
  }


  async function updateRacePublishedPosts(raceId) {
    if (typeof editMaxMessageText !== 'function') return { updated: 0, skipped: 0, failed: 0 };
    const id = normalizePositiveInt(raceId);
    if (!id) return { updated: 0, skipped: 0, failed: 0 };
    const race = await getRaceById(id);
    if (!race) return { updated: 0, skipped: 0, failed: 0 };
    const channels = await getRaceChannels(id);
    const count = await getRaceParticipantsCount(id);
    const posts = await pool.query(`
      SELECT * FROM horse_race_posts
      WHERE horse_race_id = $1 AND status = 'published' AND message_id IS NOT NULL
      ORDER BY id ASC
    `, [id]);
    let updated = 0, skipped = 0, failed = 0;
    for (const post of posts.rows) {
      if (Number(post.participants_count || 0) === count) {
        skipped += 1;
        continue;
      }
      const ok = await editMaxMessageText(
        { type: 'chat_id', id: String(post.channel_id) },
        post.message_id,
        buildRacePostText(race, count, channels),
        buildRacePostKeyboard(id),
        getRacePhotoAttachments(race)
      );
      if (ok) {
        updated += 1;
        await pool.query(`UPDATE horse_race_posts SET participants_count = $2, updated_at = NOW() WHERE id = $1`, [post.id, count]);
      } else {
        failed += 1;
      }
    }
    return { updated, skipped, failed, participantsCount: count };
  }

  async function publishRaceToChannel(raceId, channelId, options = {}) {
    const id = normalizePositiveInt(raceId);
    const cleanChannelId = String(channelId || '').trim();
    if (!id || !/^-?\d+$/.test(cleanChannelId)) throw new Error('Некорректный канал публикации');

    const race = await getRaceById(id);
    if (!race) throw new Error('Скачки не найдены');

    const existing = await pool.query(`
      SELECT * FROM horse_race_posts
      WHERE horse_race_id = $1 AND channel_id = $2
      LIMIT 1
    `, [id, cleanChannelId]);
    if (existing.rows[0]?.status === 'published') return { skipped: true, row: existing.rows[0], isGeneral: Boolean(options.isGeneral) };
    if (existing.rows[0]?.status === 'publishing' && existing.rows[0]?.publishing_started_at &&
        Date.now() - new Date(existing.rows[0].publishing_started_at).getTime() < 10 * 60_000) {
      return { skipped: true, row: existing.rows[0], reason: 'publishing_in_progress', isGeneral: Boolean(options.isGeneral) };
    }

    await pool.query(`
      INSERT INTO horse_race_posts (horse_race_id, channel_id, message_id, status, publishing_started_at, participants_count, updated_at)
      VALUES ($1, $2, NULL, 'publishing', NOW(), 0, NOW())
      ON CONFLICT (horse_race_id, channel_id)
      DO UPDATE SET status = 'publishing', error_text = NULL, publishing_started_at = NOW(), updated_at = NOW()
    `, [id, cleanChannelId]);

    try {
      const channels = await getRaceChannels(id);
      const count = await getRaceParticipantsCount(id);
      const result = await sendMessage?.(
        { type: 'chat_id', id: cleanChannelId },
        buildRacePostText(race, count, channels),
        buildRacePostKeyboard(id),
        getRacePhotoAttachments(race)
      );
      const messageId = typeof extractMaxMessageId === 'function'
        ? String(extractMaxMessageId(result) || '').trim() || null
        : null;
      await pool.query(`
        UPDATE horse_race_posts
        SET message_id = $3, status = 'published', error_text = NULL, participants_count = $4, updated_at = NOW()
        WHERE horse_race_id = $1 AND channel_id = $2
      `, [id, cleanChannelId, messageId, count]);

      if (String(cleanChannelId) === String(config.generalChannelId)) {
        await pool.query(`
          UPDATE horse_races
          SET published_in_general = true,
              general_channel_id = $2,
              general_message_id = $3,
              updated_at = NOW()
          WHERE id = $1
        `, [id, cleanChannelId, messageId]);
      }
      return { published: true, messageId, result, isGeneral: Boolean(options.isGeneral) };
    } catch (error) {
      await pool.query(`
        UPDATE horse_race_posts
        SET status = 'failed', error_text = $3, updated_at = NOW()
        WHERE horse_race_id = $1 AND channel_id = $2
      `, [id, cleanChannelId, cleanText(error.message, 1000)]).catch(() => {});
      throw error;
    }
  }

  async function publishRaceEverywhere(raceId) {
    const race = await getRaceById(raceId);
    if (!race) throw new Error('Скачки не найдены');
    if (!config.generalChannelId) throw new Error('GENERAL_CHANNEL_ID не задан');

    const channels = await getRaceChannels(raceId);
    const targets = new Map();
    targets.set(String(config.generalChannelId), { isGeneral: true });
    for (const channel of channels) {
      if (channel.publishPost) targets.set(String(channel.channelId), { isGeneral: String(channel.channelId) === String(config.generalChannelId) });
    }

    const results = [];
    for (const [channelId, meta] of targets.entries()) {
      try {
        results.push({ channelId, ...(await publishRaceToChannel(raceId, channelId, meta)) });
      } catch (error) {
        results.push({ channelId, error: cleanText(error.message, 500) });
      }
    }
    return results;
  }

  async function activateAndPublishRace(raceId, options = {}) {
    if (!config.generalChannelId) throw new Error('GENERAL_CHANNEL_ID не задан');
    const race = await activateRace(raceId, options);
    const results = await publishRaceEverywhere(race.id);
    const generalResult = results.find(item => String(item.channelId) === String(config.generalChannelId));
    const generalOk = Boolean(generalResult?.published || generalResult?.row?.status === 'published');
    if (!generalOk) {
      const detail = generalResult?.error || generalResult?.reason || 'публикация не подтверждена';
      await notifyAdmins?.(`⚠️ Скачки #${race.id} активированы, но публикация в General не подтверждена: ${detail}`);
      throw new Error(`Публикация в General не завершена: ${detail}`);
    }
    return { race: await getRaceById(race.id), results };
  }

  async function createRacePayment({ userId, raceId, receiptEmail }) {
    if (typeof isYooKassaReady === 'function' && !isYooKassaReady()) {
      throw new Error('YooKassa не настроена');
    }
    if (typeof yookassaRequest !== 'function' || typeof buildYooKassaReceipt !== 'function') {
      throw new Error('Функции YooKassa не переданы в модуль');
    }

    const race = await getRaceById(raceId);
    if (!race || String(race.creator_user_id) !== String(userId)) throw new Error('Скачки не найдены');
    const email = typeof normalizeReceiptEmail === 'function'
      ? normalizeReceiptEmail(receiptEmail)
      : String(receiptEmail || '').trim();
    const amount = Number(race.price_amount || config.racePriceRub).toFixed(2);
    const description = `Создание скачек #${race.id}`.slice(0, 128);
    const metadata = {
      product: config.productCode,
      type: 'horse_race',
      user_id: String(userId),
      horse_race_id: String(race.id),
      receipt_email: email
    };
    const returnUrl = new URL(`${String(APP_BASE_URL).replace(/\/+$/, '')}/payment/return`);
    returnUrl.searchParams.set('horse_race_id', String(race.id));
    returnUrl.searchParams.set('product', config.productCode);

    const payment = await yookassaRequest('/payments', {
      method: 'POST',
      idempotenceKey: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
      body: {
        amount: { value: amount, currency: 'RUB' },
        confirmation: { type: 'redirect', return_url: returnUrl.toString() },
        capture: true,
        description,
        metadata,
        receipt: buildYooKassaReceipt(description, amount, email)
      }
    });

    await pool.query(`
      INSERT INTO horse_race_payments (
        payment_id, horse_race_id, user_id, product, status, amount, currency,
        receipt_email, raw, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
      ON CONFLICT (payment_id)
      DO UPDATE SET status = EXCLUDED.status, raw = EXCLUDED.raw, updated_at = NOW()
    `, [
      String(payment.id), race.id, String(userId), config.productCode,
      String(payment.status || 'pending'), amount, 'RUB', email, JSON.stringify(payment)
    ]);
    await pool.query(`UPDATE horse_races SET payment_id = $2, updated_at = NOW() WHERE id = $1`, [race.id, String(payment.id)]);
    return payment;
  }

  async function applyYooKassaPayment(payment) {
    const metadata = payment?.metadata || {};
    if (String(metadata.product || '') !== config.productCode) return false;
    const paymentId = String(payment?.id || '').trim();
    const raceId = normalizePositiveInt(metadata.horse_race_id);
    const userId = String(metadata.user_id || '').trim();
    if (!paymentId || !raceId || !userId) return true;

    await pool.query(`
      INSERT INTO horse_race_payments (
        payment_id, horse_race_id, user_id, product, status, amount, currency,
        receipt_email, raw, paid_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
        CASE WHEN $5 = 'succeeded' THEN NOW() ELSE NULL END, NOW())
      ON CONFLICT (payment_id)
      DO UPDATE SET status = EXCLUDED.status, raw = EXCLUDED.raw,
        paid_at = CASE WHEN EXCLUDED.status = 'succeeded' THEN COALESCE(horse_race_payments.paid_at, NOW()) ELSE horse_race_payments.paid_at END,
        updated_at = NOW()
    `, [
      paymentId, raceId, userId, config.productCode, String(payment.status || 'pending'),
      String(payment?.amount?.value || config.racePriceRub), String(payment?.amount?.currency || 'RUB'),
      metadata.receipt_email || null, JSON.stringify(payment)
    ]);

    if (String(payment.status) !== 'succeeded') return true;

    const claimed = await pool.query(`
      UPDATE horse_race_payments
      SET applied = true, applied_at = NOW(), updated_at = NOW()
      WHERE payment_id = $1 AND applied = false
      RETURNING *
    `, [paymentId]);
    if (!claimed.rows[0]) return true;

    try {
      const applied = await activateAndPublishRace(raceId, {
        userId,
        paymentStatus: 'succeeded',
        paymentId,
        generalChannelId: config.generalChannelId
      });
      const generalResult = applied.results.find(item => String(item.channelId) === String(config.generalChannelId));
      await clearSession?.(userId).catch?.(() => {});
      await sendMessage?.(userId, [
        '✅ **Оплата прошла. Скачки созданы.**',
        '',
        `🐎 Название: **${cleanText(applied.race.title, 180)}**`,
        `🏁 Старт: **${formatRaceDate(applied.race.start_at)}**`,
        generalResult?.error
          ? '⚠️ Скачки активированы, но публикацию в General проверит администратор.'
          : `📣 Пост опубликован в **${config.generalChannelName}**.`,
        '',
        'Скачки уже доступны в Mini App.'
      ].join('\n'), [
        [{ text: '🐎 Открыть скачки', url: getLaunchUrl(`race_${raceId}`) }],
        [{ text: '🤝 Пригласить каналы', callback_data: `horse_collab_link:${raceId}` }]
      ]).catch(() => {});
    } catch (error) {
      await pool.query(`UPDATE horse_race_payments SET applied = false, applied_at = NULL, updated_at = NOW() WHERE payment_id = $1`, [paymentId]).catch(() => {});
      await notifyAdmins?.(`⚠️ Ошибка применения оплаты скачек #${raceId}, payment ${paymentId}: ${cleanText(error.message, 800)}`);
      await sendMessage?.(userId, '✅ Оплата прошла, но автоматическая публикация не завершилась. Администратор уже получил уведомление.').catch(() => {});
      throw error;
    }
    return true;
  }

  async function handleSessionMessage(message, session = null) {
    const state = String(session?.state || '');
    if (!state.startsWith('horse_')) return false;
    const userId = String(message.from.id);
    const target = message.chat.id;
    const text = String(message.text || '').trim();
    const data = typeof session.data === 'string' ? JSON.parse(session.data || '{}') : (session.data || {});

    if (['/cancel', 'отмена', 'cancel'].includes(text.toLowerCase())) {
      await clearSession?.(userId);
      await sendMessage?.(target, 'Создание скачек отменено.');
      await sendHorseMenu(target, userId);
      return true;
    }

    if (state === 'horse_create_title') {
      const title = cleanText(text, 180);
      if (!title) return sendMessage?.(target, 'Введите непустое название.').then(() => true);
      data.title = title;
      await setSession?.(userId, 'horse_create_description', data);
      await sendMessage?.(target, horseStepText(2, 'Описание', ['Введите описание скачек:']), [
        [{ text: '⬅️ Назад', callback_data: 'horse_back:title' }],
        [{ text: '❌ Отмена', callback_data: 'horse_cancel' }]
      ]);
      return true;
    }

    if (state === 'horse_create_description') {
      data.description = cleanText(text, 3000);
      await setSession?.(userId, 'horse_create_prizes', data);
      await sendMessage?.(target, horseStepText(3, 'Призы', ['Введите каждый приз с новой строки:']), [
        [{ text: '⬅️ Назад', callback_data: 'horse_back:description' }],
        [{ text: '❌ Отмена', callback_data: 'horse_cancel' }]
      ]);
      return true;
    }

    if (state === 'horse_create_prizes') {
      const prizes = splitNonEmptyLines(text).slice(0, 50);
      if (!prizes.length) return sendMessage?.(target, 'Добавьте хотя бы один приз.').then(() => true);
      data.prizes = prizes.join('\n');
      data.prize_count = prizes.length;
      await sendRacePhotoPrompt(target, userId, data);
      return true;
    }

    if (state === 'horse_create_photo') {
      const photo = typeof extractPhotoAttachment === 'function' ? extractPhotoAttachment(message) : null;
      if (!photo) {
        await sendRacePhotoPrompt(target, userId, data);
        return true;
      }
      data.photo_attachment = photo;
      await sendRaceStartPrompt(target, userId, data);
      return true;
    }

    if (state === 'horse_create_start_at') {
      const startAt = parseRaceStartInput(text);
      if (!startAt || startAt.getTime() <= Date.now() + config.minStartMinutes * 60_000) {
        await sendMessage?.(target, `Неверное время. Старт должен быть минимум через ${config.minStartMinutes} минут.`);
        return true;
      }
      data.start_at = startAt.toISOString();
      data.channel_ids = Array.isArray(data.channel_ids) ? data.channel_ids : [];
      await sendRaceChannelSelection(target, userId, data);
      return true;
    }

    if (state === 'horse_create_channels') {
      await sendRaceChannelSelection(target, userId, data);
      return true;
    }

    if (state === 'horse_create_preview') {
      await sendRacePreview(target, userId, data);
      return true;
    }

    if (state === 'horse_create_email') {
      try {
        const email = typeof normalizeReceiptEmail === 'function' ? normalizeReceiptEmail(text) : text;
        const payment = await createRacePayment({ userId, raceId: data.race_id, receiptEmail: email });
        const url = payment?.confirmation?.confirmation_url;
        if (!url) throw new Error('YooKassa не вернула ссылку оплаты');
        await clearSession?.(userId);
        await sendMessage?.(target, [
          '✅ **Счёт создан**',
          '',
          `Сумма: **${config.racePriceRub} ₽**`,
          `Email для чека: **${email}**`,
          '',
          'После успешной оплаты скачки автоматически активируются и публикуются.'
        ].join('\n'), [[{ text: '💳 Оплатить', url }]]);
      } catch (error) {
        await sendMessage?.(target, `⚠️ Не удалось создать оплату: ${cleanText(error.message, 500)}`);
      }
      return true;
    }

    if (state === 'horse_collab_channels') {
      await sendRaceCollabChannelSelection(target, userId, data);
      return true;
    }

    return false;
  }

  async function sendRaceJoinMenu(target, userId) {
    const races = await getAvailableRaces(userId);
    if (!races.length) return sendMessage?.(target, 'Сейчас нет доступных скачек.', [[{ text: '🐎 В меню скачек', callback_data: 'horse_menu' }]]);
    const lines = ['🎟 **Доступные скачки:**', ''];
    const keyboard = [];
    for (const race of races.slice(0, 20)) {
      lines.push(`• №${race.id} — **${race.title}** | старт ${formatRaceDate(race.startsAt)}`);
      keyboard.push([{ text: `🐎 №${race.id} ${cleanText(race.title, 28)}`, callback_data: `horse_join_open:${race.id}` }]);
    }
    keyboard.push([{ text: '📱 Mini App', url: getLaunchUrl('races') }]);
    keyboard.push([{ text: '⬅️ Назад', callback_data: 'horse_menu' }]);
    return sendMessage?.(target, lines.join('\n'), keyboard);
  }

  async function sendCreatorRaceCollabList(target, userId) {
    const res = await pool.query(`
      SELECT id, title, start_at
      FROM horse_races
      WHERE creator_user_id = $1
        AND status IN ('scheduled', 'active')
        AND start_at > NOW()
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    `, [String(userId)]);

    if (!res.rows.length) {
      return sendMessage?.(
        target,
        'У вас нет активных скачек, к которым ещё можно пригласить каналы.',
        [[{ text: '🐎 В меню скачек', callback_data: 'horse_menu' }]]
      );
    }

    const lines = ['🤝 **Выберите скачки для приглашения каналов:**', ''];
    const keyboard = [];

    for (const race of res.rows) {
      lines.push(`• #${race.id} — **${cleanText(race.title, 120) || 'Скачки'}** | ${formatRaceDate(race.start_at)}`);
      keyboard.push([{
        text: `🤝 #${race.id} ${cleanText(race.title, 28) || 'Скачки'}`,
        callback_data: `horse_collab_link:${race.id}`
      }]);
    }

    keyboard.push([{ text: '⬅️ Назад', callback_data: 'horse_menu' }]);
    return sendMessage?.(target, lines.join('\n'), keyboard);
  }

  async function sendAdminRaces(target, userId) {
    if (!isAdmin(userId)) return sendMessage?.(target, '⛔ Нет доступа.');
    const res = await pool.query(`
      SELECT hr.*, COALESCE(pc.count, 0)::int AS participants_count
      FROM horse_races hr
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS count FROM horse_race_participants p
        WHERE p.horse_race_id = hr.id AND p.is_valid = true
      ) pc ON true
      WHERE hr.status IN ('draft', 'scheduled', 'active', 'running')
      ORDER BY hr.start_at ASC, hr.id DESC
      LIMIT 30
    `);
    if (!res.rows.length) return sendMessage?.(target, 'Активных скачек нет.', [
      [{ text: '➕ Создать бесплатно', callback_data: 'horse_create_start' }],
      [{ text: '👑 Админ-панель', callback_data: 'admin_panel' }]
    ]);
    const lines = ['👑 **Активные скачки:**', ''];
    const keyboard = [];
    for (const race of res.rows) {
      lines.push(`#${race.id} | ${cleanText(race.title, 100)} | ${race.status} | 👥 ${race.participants_count} | ${formatRaceDate(race.start_at)}`);
      const row = [{ text: `👀 #${race.id}`, url: getLaunchUrl(`race_${race.id}`) }];
      if (!race.published_in_general) row.push({ text: `📣 General #${race.id}`, callback_data: `horse_admin_publish:${race.id}` });
      if (config.testMode && String(race.payment_status) === 'pending') {
        row.push({ text: `🧪 Оплата #${race.id}`, callback_data: `horse_admin_testpay:${race.id}` });
      }
      row.push({ text: `❌ #${race.id}`, callback_data: `horse_admin_cancel:${race.id}` });
      keyboard.push(row);
    }
    keyboard.push([{ text: '➕ Создать бесплатно', callback_data: 'horse_create_start' }]);
    keyboard.push([{ text: '👑 Админ-панель', callback_data: 'admin_panel' }]);
    return sendMessage?.(target, lines.join('\n'), keyboard);
  }

  async function handleStartPayload({ target, from, payload }) {
    const normalized = String(payload || '').replace(/^start[=:]/i, '').trim();

    if (normalized === 'top1_buy') {
      return false;
    }

    if (normalized === 'horse_menu') {
      await sendHorseMenu(target, from.id);
      return true;
    }

    if (normalized.startsWith('horse_collab_')) {
      const token = normalized.replace(/^horse_collab_/, '').trim();
      if (!token) return false;
      await startRaceCollabFlow(target, from.id, token);
      return true;
    }

    if (normalized.startsWith('horse_join_')) {
      const raceId = normalizePositiveInt(normalized.replace(/^horse_join_/, ''));
      if (!raceId) return false;
      await showRaceJoinStart(target, from.id, raceId);
      return true;
    }

    if (normalized.startsWith('horse_watch_')) {
      const raceId = normalizePositiveInt(normalized.replace(/^horse_watch_/, ''));
      if (!raceId) return false;
      await sendMessage?.(
        target,
        'Откройте скачки в Mini App.',
        [[{ text: '🐎 Смотреть скачки', url: getLaunchUrl(`race_${raceId}`) }]]
      );
      return true;
    }

    return false;
  }

  async function handleCallback(cb) {
    const data = String(cb?.data || '');
    if (!data.startsWith('horse_')) return false;

    const userId = String(cb.from.id);
    const target = cb.message.chat.id;

    if (data === 'horse_menu') {
      await sendHorseMenu(target, userId);
      return true;
    }

    if (data === 'horse_create_start') {
      await startRaceCreation(target, userId);
      return true;
    }

    if (data === 'horse_join_menu') {
      await sendRaceJoinMenu(target, userId);
      return true;
    }

    if (data === 'horse_collab_my_races') {
      await sendCreatorRaceCollabList(target, userId);
      return true;
    }

    if (data.startsWith('horse_join_open:')) {
      const raceId = normalizePositiveInt(data.split(':')[1]);
      await showRaceJoinStart(target, userId, raceId);
      return true;
    }

    if (data.startsWith('horse_collab_link:')) {
      const raceId = normalizePositiveInt(data.split(':')[1]);
      try {
        await sendRaceCollabInvite(target, userId, raceId);
      } catch (error) {
        await answerMaxCallback?.(cb.id, cleanText(error.message, 160));
      }
      return true;
    }

    if (data.startsWith('horse_collab_toggle:')) {
      const channelId = normalizePositiveInt(data.split(':')[1]);
      const sessionRes = await pool.query(`SELECT data FROM user_sessions WHERE user_id = $1 LIMIT 1`, [userId]);
      const draft = typeof sessionRes.rows[0]?.data === 'string'
        ? JSON.parse(sessionRes.rows[0].data || '{}')
        : (sessionRes.rows[0]?.data || {});
      const channels = Array.isArray(draft.channels) ? draft.channels : [];
      const index = channels.findIndex(item => Number(item.user_channel_id) === channelId);

      if (index >= 0) {
        channels.splice(index, 1);
      } else {
        const available = await getRaceCollabSelectableChannels(userId);
        const channel = available.find(item => Number(item.id) === channelId);
        if (!channel) {
          await answerMaxCallback?.(cb.id, 'Канал не найден');
          return true;
        }
        channels.push({
          user_channel_id: Number(channel.id),
          channel_id: String(channel.channel_id),
          title: cleanText(channel.channel_title, 250) || 'Канал',
          publish_post: false
        });
      }

      draft.channels = channels;
      await sendRaceCollabChannelSelection(target, userId, draft);
      return true;
    }

    if (data.startsWith('horse_collab_publish:')) {
      const channelId = normalizePositiveInt(data.split(':')[1]);
      const sessionRes = await pool.query(`SELECT data FROM user_sessions WHERE user_id = $1 LIMIT 1`, [userId]);
      const draft = typeof sessionRes.rows[0]?.data === 'string'
        ? JSON.parse(sessionRes.rows[0].data || '{}')
        : (sessionRes.rows[0]?.data || {});
      const channels = Array.isArray(draft.channels) ? draft.channels : [];
      const item = channels.find(value => Number(value.user_channel_id) === channelId);

      if (!item) {
        await answerMaxCallback?.(cb.id, 'Сначала выберите канал');
        return true;
      }

      if (!item.publish_post) {
        const available = await getRaceCollabSelectableChannels(userId);
        const channel = available.find(value => Number(value.id) === channelId);
        if (!channel?.can_publish) {
          await answerMaxCallback?.(cb.id, 'У бота нет права публикации в этом канале');
          return true;
        }
      }

      item.publish_post = !item.publish_post;
      draft.channels = channels;
      await sendRaceCollabChannelSelection(target, userId, draft);
      return true;
    }

    if (data === 'horse_collab_done') {
      const sessionRes = await pool.query(`SELECT data FROM user_sessions WHERE user_id = $1 LIMIT 1`, [userId]);
      const draft = typeof sessionRes.rows[0]?.data === 'string'
        ? JSON.parse(sessionRes.rows[0].data || '{}')
        : (sessionRes.rows[0]?.data || {});
      try {
        await addRaceCollabChannelsFromSession(target, userId, draft);
      } catch (error) {
        await sendMessage?.(target, `⚠️ Не удалось добавить каналы: ${cleanText(error.message, 500)}`);
      }
      return true;
    }

    if (data === 'horse_collab_cancel') {
      await clearSession?.(userId);
      await answerMaxCallback?.(cb.id, 'Отменено');
      await sendHorseMenu(target, userId);
      return true;
    }

    if (data === 'horse_cancel') {
      await clearSession?.(userId);
      await answerMaxCallback?.(cb.id, 'Отменено');
      await sendHorseMenu(target, userId);
      return true;
    }

    if (data.startsWith('horse_back:')) {
      const step = data.split(':')[1];
      const sessionRes = await pool.query(`SELECT state, data FROM user_sessions WHERE user_id = $1 LIMIT 1`, [userId]);
      const session = sessionRes.rows[0];
      const draft = typeof session?.data === 'string' ? JSON.parse(session.data || '{}') : (session?.data || {});
      if (step === 'title') {
        await setSession?.(userId, 'horse_create_title', draft);
        await sendMessage?.(target, horseStepText(1, 'Название', ['Введите название скачек:']));
      } else if (step === 'description') {
        await setSession?.(userId, 'horse_create_description', draft);
        await sendMessage?.(target, horseStepText(2, 'Описание', ['Введите описание скачек:']));
      } else if (step === 'prizes') {
        await setSession?.(userId, 'horse_create_prizes', draft);
        await sendMessage?.(target, horseStepText(3, 'Призы', ['Введите каждый приз с новой строки:']));
      } else if (step === 'photo') {
        await sendRacePhotoPrompt(target, userId, draft);
      } else if (step === 'start_at') {
        await sendRaceStartPrompt(target, userId, draft);
      }
      return true;
    }

    if (data === 'horse_photo_skip' || data === 'horse_photo_keep') {
      const sessionRes = await pool.query(`SELECT data FROM user_sessions WHERE user_id = $1 LIMIT 1`, [userId]);
      const draft = typeof sessionRes.rows[0]?.data === 'string' ? JSON.parse(sessionRes.rows[0].data || '{}') : (sessionRes.rows[0]?.data || {});
      if (data === 'horse_photo_skip') delete draft.photo_attachment;
      await sendRaceStartPrompt(target, userId, draft);
      return true;
    }

    if (data.startsWith('horse_channel_toggle:')) {
      const channelId = normalizePositiveInt(data.split(':')[1]);
      const sessionRes = await pool.query(`SELECT data FROM user_sessions WHERE user_id = $1 LIMIT 1`, [userId]);
      const draft = typeof sessionRes.rows[0]?.data === 'string' ? JSON.parse(sessionRes.rows[0].data || '{}') : (sessionRes.rows[0]?.data || {});
      const selected = new Set((Array.isArray(draft.channel_ids) ? draft.channel_ids : []).map(Number));
      if (selected.has(channelId)) selected.delete(channelId); else selected.add(channelId);
      draft.channel_ids = [...selected];
      await sendRaceChannelSelection(target, userId, draft);
      return true;
    }

    if (data === 'horse_channels_done') {
      const sessionRes = await pool.query(`SELECT data FROM user_sessions WHERE user_id = $1 LIMIT 1`, [userId]);
      const draft = typeof sessionRes.rows[0]?.data === 'string' ? JSON.parse(sessionRes.rows[0].data || '{}') : (sessionRes.rows[0]?.data || {});
      if (!Array.isArray(draft.channel_ids) || !draft.channel_ids.length) {
        await answerMaxCallback?.(cb.id, 'Выберите хотя бы один канал.');
        return true;
      }
      await sendRacePreview(target, userId, draft);
      return true;
    }

    if (data === 'horse_preview_confirm') {
      const sessionRes = await pool.query(`SELECT data FROM user_sessions WHERE user_id = $1 LIMIT 1`, [userId]);
      const draft = typeof sessionRes.rows[0]?.data === 'string' ? JSON.parse(sessionRes.rows[0].data || '{}') : (sessionRes.rows[0]?.data || {});
      try {
        const race = await createDraftFromSession(userId, draft);
        draft.race_id = race.id;
        if (isAdmin(userId)) {
          const applied = await activateAndPublishRace(race.id, { userId, adminFree: true, paymentStatus: 'admin_free', generalChannelId: config.generalChannelId });
          await clearSession?.(userId);
          const generalError = applied.results.find(item => String(item.channelId) === String(config.generalChannelId))?.error;
          await sendMessage?.(target, [
            '✅ **Скачки созданы бесплатно.**',
            '',
            `Номер: **#${race.id}**`,
            `Старт: **${formatRaceDate(race.start_at)}**`,
            generalError ? `⚠️ General: ${generalError}` : `📣 Опубликовано в **${config.generalChannelName}**.`
          ].join('\n'), [
            [{ text: '🐎 Смотреть', url: getLaunchUrl(`race_${race.id}`) }],
            [{ text: '🤝 Пригласить каналы', callback_data: `horse_collab_link:${race.id}` }]
          ]);
        } else {
          if (!config.generalChannelId) throw new Error('GENERAL_CHANNEL_ID не настроен, оплату создавать нельзя');
          await setSession?.(userId, 'horse_create_email', draft);
          await sendMessage?.(target, [
            '🧾 **Email для чека**',
            '',
            `Стоимость: **${config.racePriceRub} ₽**`,
            'Введите email одним сообщением.'
          ].join('\n'));
        }
      } catch (error) {
        await sendMessage?.(target, `⚠️ Не удалось подготовить скачки: ${cleanText(error.message, 500)}`);
      }
      return true;
    }

    if (data === 'horse_admin_active') {
      await sendAdminRaces(target, userId);
      return true;
    }

    if (data.startsWith('horse_admin_publish:')) {
      if (!isAdmin(userId)) return true;
      const raceId = normalizePositiveInt(data.split(':')[1]);
      try {
        await publishRaceToChannel(raceId, config.generalChannelId, { isGeneral: true });
        await answerMaxCallback?.(cb.id, '✅ Опубликовано в General');
      } catch (error) {
        await answerMaxCallback?.(cb.id, cleanText(error.message, 160));
      }
      await sendAdminRaces(target, userId);
      return true;
    }

    if (data.startsWith('horse_admin_testpay:')) {
      if (!isAdmin(userId) || !config.testMode) return true;
      const raceId = normalizePositiveInt(data.split(':')[1]);
      const race = await getRaceById(raceId);
      if (!race) {
        await answerMaxCallback?.(cb.id, 'Скачки не найдены');
        return true;
      }
      try {
        const testPayment = {
          id: `horse-test-${raceId}-${Date.now()}`,
          status: 'succeeded',
          amount: { value: Number(race.price_amount || config.racePriceRub).toFixed(2), currency: 'RUB' },
          metadata: {
            product: config.productCode,
            type: 'horse_race_test',
            user_id: String(race.creator_user_id),
            horse_race_id: String(race.id),
            receipt_email: 'test@example.com'
          }
        };
        await applyYooKassaPayment(testPayment);
        await answerMaxCallback?.(cb.id, '🧪 Тестовая оплата применена');
      } catch (error) {
        await answerMaxCallback?.(cb.id, cleanText(error.message, 160));
      }
      await sendAdminRaces(target, userId);
      return true;
    }

    if (data.startsWith('horse_admin_cancel:')) {
      if (!isAdmin(userId)) return true;
      const raceId = normalizePositiveInt(data.split(':')[1]);
      await pool.query(`UPDATE horse_races SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1`, [raceId]);
      await answerMaxCallback?.(cb.id, 'Скачки отменены');
      await sendAdminRaces(target, userId);
      return true;
    }

    if (data.startsWith('horse_join_check:')) {
      const raceId = normalizePositiveInt(data.split(':')[1]);
      if (!raceId) {
        await answerMaxCallback?.(cb.id, 'Некорректный ID скачек.');
        return true;
      }

      const race = await getRaceById(raceId, userId);
      if (!race) {
        await answerMaxCallback?.(cb.id, 'Скачки не найдены.');
        return true;
      }

      const channels = (await getRaceChannels(raceId)).filter(channel => channel.isRequired);
      const missing = [];

      if (typeof checkUserSubscribedToChannelDetailed === 'function') {
        for (const channel of channels) {
          const check = await checkUserSubscribedToChannelDetailed(userId, channel.channelId);
          if (!check?.subscribed) missing.push(channel);
        }
      }

      if (missing.length) {
        await answerMaxCallback?.(cb.id, 'Сначала подпишитесь на все каналы.');
        await sendMessage?.(
          target,
          [
            '❗ **Подписка подтверждена не на все каналы:**',
            '',
            ...missing.map((channel, index) => `${index + 1}. ${channel.link ? `[${escapeMarkdownText(channel.title)}](${channel.link})` : channel.title}`),
            '',
            'Подпишитесь и нажмите проверку ещё раз.'
          ].join('\n'),
          [[{ text: '✅ Проверить ещё раз', callback_data: `horse_join_check:${raceId}` }]]
        );
        return true;
      }

      try {
        const entry = await addParticipant(raceId, userId);
        const participant = entry.participant;
        const color = serializeHorseColor(participant.horse_color);

        await answerMaxCallback?.(cb.id, entry.created ? '✅ Билет выдан' : 'Билет уже был выдан');
        await sendMessage?.(
          target,
          [
            `🐎 **Вы участвуете в скачках «${cleanText(race.title, 180) || 'Скачки'}»!**`,
            '',
            `🎟 Ваш билет: **№${participant.ticket_number}**`,
            `🐎 Ваша лошадь: **${color?.label || participant.horse_color}**`,
            `⏰ Старт: **${formatRaceDate(race.start_at)}**`,
            '',
            'Когда начнутся скачки, откройте Mini App и смотрите забег вживую.'
          ].join('\n'),
          [[{ text: '🐎 Смотреть скачки', url: getLaunchUrl(`race_${raceId}`) }]]
        );
      } catch (error) {
        await answerMaxCallback?.(cb.id, cleanText(error.message, 160) || 'Не удалось выдать билет.');
      }

      return true;
    }

    return false;
  }

  function buildRacePostText(race, participantsCount = 0, channels = []) {
    const prizes = splitNonEmptyLines(race?.prizes);
    const lines = [
      '🐎 **СКАЧКИ**',
      '',
      `**${cleanText(race?.title, 180) || 'Скачки'}**`,
      '',
      cleanText(race?.description, 3000) || 'Участвуйте и следите за забегом в Mini App!',
      '',
      '🎁 **Призы:**',
      ...(prizes.length ? prizes.map((prize, index) => `${index + 1}. ${prize}`) : ['1. Главный приз']),
      '',
      `👥 Участников: **${Number(participantsCount || 0)}**`,
      `🏁 Старт: **${formatRaceDate(race?.start_at)}**`
    ];

    const visibleChannels = Array.isArray(channels) ? channels : [];
    if (visibleChannels.length) {
      lines.push('', '📢 **Подписаться на каналы:**');
      visibleChannels.forEach((channel, index) => {
        const title = cleanText(channel.title || channel.channel_title, 200) || 'Канал';
        const link = normalizePublicHttpUrl(channel.link || channel.channel_link);
        lines.push(`${index + 1}. ${link ? `[${escapeMarkdownText(title)}](${link})` : title}`);
      });
    }

    const morePrizesTarget =
      config.morePrizesUrl ||
      BOT_PUBLIC_URL ||
      APP_BASE_URL;

    const morePrizesLine = morePrizesTarget
      ? `Еще больше призов 🥳 [${escapeMarkdownText(config.morePrizesLabel)}](${morePrizesTarget})`
      : `Еще больше призов 🥳 ${escapeMarkdownText(config.morePrizesLabel)}`;

const raceId = normalizePositiveInt(race?.id);

const participateUrl = raceId
  ? getBotUrl(`horse_join_${raceId}`)
  : '';

const participateLine = participateUrl
  ? `*Чтобы участвовать, нажмите кнопку 🏇 [Участвовать](${participateUrl})*`
  : `*Чтобы участвовать, нажмите кнопку 🏇 Участвовать*`;

lines.push(
  '',
  participateLine,
  '',
  `Скачки созданы с помощью ${BOT_PUBLIC_URL ? `[РОЗЫГРЫШ БОТ](${BOT_PUBLIC_URL})` : 'РОЗЫГРЫШ БОТ'}`,
  morePrizesLine
);

    return lines.join('\n');
  }

  function buildRacePostKeyboard(raceId) {
    const id = normalizePositiveInt(raceId);
    return [
      [{ text: '🐎 Участвовать', url: getBotUrl(`horse_join_${id}`) }],
      [{ text: '🏇 Смотреть скачки', url: getLaunchUrl(`race_${id}`) }]
    ];
  }

  async function notifyRaceResults() {
    const roundsRes = await pool.query(`
      SELECT
        hrr.*,
        hr.title,
        hr.creator_user_id,
        organizer.first_name AS organizer_first_name,
        organizer.last_name AS organizer_last_name,
        organizer.username AS organizer_username
      FROM horse_race_rounds hrr
      JOIN horse_races hr
        ON hr.id = hrr.horse_race_id
      LEFT JOIN users organizer
        ON organizer.max_user_id = hr.creator_user_id
      WHERE hrr.status = 'finished'
        AND hrr.winner_user_id IS NOT NULL
        AND hrr.winner_notified_at IS NULL
      ORDER BY hrr.id ASC
      LIMIT 100
    `);

    for (const round of roundsRes.rows) {
      const color = serializeHorseColor(round.winner_color);

      const organizerFirstName =
        cleanText(round.organizer_first_name, 100);

      const organizerLastName =
        cleanText(round.organizer_last_name, 100);

      const organizerUsername =
        cleanText(round.organizer_username, 100).replace(/^@/, '');

      const organizerName =
        [organizerFirstName, organizerLastName]
          .filter(Boolean)
          .join(' ') ||
        (organizerUsername
          ? `@${organizerUsername}`
          : `ID ${round.creator_user_id}`);

      try {
        await sendMessage?.(String(round.winner_user_id), [
          '🏆 **Ваша лошадь победила!**',
          '',
          `🏇 Скачки: **${cleanText(round.title, 180)}**`,
          `🎁 Приз: **${cleanText(round.prize_text, 500) || `Приз ${round.prize_index}`}**`,
          `👤 Приз выдаёт: **${escapeMarkdownText(organizerName)}**`,
          `🎟 Билет: **№${round.winner_ticket_number}**`,
          `🎨 Лошадь: **${color?.label || round.winner_color}**`
        ].join('\n'), [[{ text: '🐎 Посмотреть результат', url: getLaunchUrl(`race_${round.horse_race_id}`) }]]);
        await pool.query(`UPDATE horse_race_rounds SET winner_notified_at = NOW(), updated_at = NOW() WHERE id = $1`, [round.id]);
      } catch (error) {
        console.warn(`Не удалось уведомить победителя скачек ${round.horse_race_id}/${round.prize_index}:`, error.message);
      }
    }

    const finishedRes = await pool.query(`
      SELECT hr.*
      FROM horse_races hr
      WHERE hr.status = 'finished'
        AND hr.results_notified_at IS NULL
      ORDER BY hr.id ASC
      LIMIT 50
    `);
    for (const race of finishedRes.rows) {
      const winners = await pool.query(`
        SELECT prize_index, prize_text, winner_user_id, winner_ticket_number, winner_color
        FROM horse_race_rounds
        WHERE horse_race_id = $1
        ORDER BY prize_index ASC
      `, [race.id]);
      const lines = [
        `🏁 **Скачки «${cleanText(race.title, 180)}» завершены**`,
        '',
        ...winners.rows.map(row => row.winner_user_id
          ? `${row.prize_index}. ${cleanText(row.prize_text, 300)} — билет №${row.winner_ticket_number}, ${serializeHorseColor(row.winner_color)?.label || row.winner_color}`
          : `${row.prize_index}. ${cleanText(row.prize_text, 300)} — нет участников`)
      ];
      try {
        await sendMessage?.(String(race.creator_user_id), lines.join('\n'), [[{ text: '🐎 Открыть результаты', url: getLaunchUrl(`race_${race.id}`) }]]);
        await pool.query(`UPDATE horse_races SET results_notified_at = NOW(), updated_at = NOW() WHERE id = $1`, [race.id]);
      } catch (error) {
        console.warn(`Не удалось уведомить организатора скачек ${race.id}:`, error.message);
      }
    }
  }

  async function recoverSucceededPayments() {
    const res = await pool.query(`
      SELECT raw
      FROM horse_race_payments
      WHERE product = $1
        AND status = 'succeeded'
        AND applied = false
      ORDER BY paid_at ASC NULLS FIRST, id ASC
      LIMIT 20
    `, [config.productCode]);
    for (const row of res.rows) {
      const payment = normalizeJsonValue(row.raw);
      if (!payment?.id) continue;
      await applyYooKassaPayment(payment).catch(error => {
        console.warn('Повторное применение оплаты скачек не удалось:', error.message);
      });
    }
  }

  function startWorker() {
    if (workerTimer) return workerTimer;

    const run = async () => {
      try {
        await recoverSucceededPayments();
        await refreshRaceLifecycle();
        await notifyRaceResults();
      } catch (error) {
        console.error('horse race lifecycle worker error:', error.message);
      }
    };

    workerTimer = setInterval(run, config.workerIntervalSeconds * 1000);
    workerTimer.unref?.();
    setTimeout(run, 4000).unref?.();
    return workerTimer;
  }

  function stopWorker() {
    if (workerTimer) clearInterval(workerTimer);
    clearInterval(rateCleanupTimer);
    workerTimer = null;
  }

  registerRoutes();

  function registerRoutes() {
    app.get('/miniapp', (req, res) => {
      const nonce = crypto.randomBytes(18).toString('base64');
      res.set({
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Content-Security-Policy': [
          "default-src 'self'",
          `script-src 'self' https://st.max.ru 'nonce-${nonce}'`,
          `style-src 'self' 'nonce-${nonce}'`,
          "style-src-attr 'unsafe-inline'",
          "img-src 'self' https: data:",
          "media-src 'self' https: data:",
          "connect-src 'self'",
          "font-src 'self' data:",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'self'",
          "frame-ancestors https://max.ru https://*.max.ru"
        ].join('; ')
      });
      res.type('html').send(renderMiniAppHtml(nonce));
    });

    // Совместимость со ссылками, которые уже были выданы в старом формате:
    // https://service.onrender.com/horse-collab/<token>
    // Вместо HTML-файла сразу перенаправляем пользователя в бота MAX.
    app.get('/horse-collab/:token', async (req, res) => {
      const token = String(req.params.token || '').trim();
      const invite = await getRaceCollabInviteByToken(token).catch(() => null);

      if (!isRaceCollabInviteActive(invite)) {
        return res.redirect(302, getBotUrl('horse_menu') || BOT_PUBLIC_URL || APP_BASE_URL || '/');
      }

      return res.redirect(302, getBotUrl(`horse_collab_${invite.token}`));
    });

    const api = [requireMaxAuth, rateLimit];

    app.get('/api/miniapp/me', ...api, async (req, res) => {
      res.json({
        ok: true,
        serverNow: new Date().toISOString(),
        user: {
          id: String(req.maxAuth.user.id),
          firstName: cleanText(req.maxAuth.user.first_name, 200),
          lastName: cleanText(req.maxAuth.user.last_name, 200),
          username: cleanText(req.maxAuth.user.username, 200),
          photoUrl: normalizePublicPhotoUrl(req.maxAuth.user.photo_url)
        }
      });
    });

    app.get('/api/miniapp/top-raffles', ...api, async (req, res) => {
      try {
        const items = await getTopRaffles(req.maxAuth.user.id);
        res.json({
          ok: true,
          serverNow: new Date().toISOString(),
          top1BuyUrl: getBotUrl('top1_buy'),
          items
        });
      } catch (error) {
        console.error('GET /api/miniapp/top-raffles error:', error.message);
        res.status(500).json({ ok: false, error: 'Не удалось загрузить розыгрыши.' });
      }
    });

    app.get('/api/miniapp/races', ...api, async (req, res) => {
      try {
        const items = await getAvailableRaces(req.maxAuth.user.id);
        res.json({ ok: true, serverNow: new Date().toISOString(), items });
      } catch (error) {
        console.error('GET /api/miniapp/races error:', error.message);
        res.status(500).json({ ok: false, error: 'Не удалось загрузить скачки.' });
      }
    });

    app.get('/api/miniapp/races/:id', ...api, async (req, res) => {
      try {
        const race = await getRaceDetails(req.params.id, req.maxAuth.user.id);
        if (!race) return res.status(404).json({ ok: false, error: 'Скачки не найдены.' });
        return res.json({ ok: true, serverNow: new Date().toISOString(), race });
      } catch (error) {
        console.error('GET /api/miniapp/races/:id error:', error.message);
        return res.status(500).json({ ok: false, error: 'Не удалось открыть скачки.' });
      }
    });

    app.get('/api/miniapp/races/:id/live', ...api, async (req, res) => {
      try {
        const live = await getRaceLiveState(req.params.id, req.maxAuth.user.id);
        if (!live) return res.status(404).json({ ok: false, error: 'Скачки не найдены.' });
        return res.json({ ok: true, live });
      } catch (error) {
        console.error('GET /api/miniapp/races/:id/live error:', error.message);
        return res.status(500).json({ ok: false, error: 'Не удалось синхронизировать забег.' });
      }
    });
  }

  return {
    initDb,
    startWorker,
    stopWorker,
    getWebUrl,
    getLaunchUrl,
    getBotUrl,
    getTopRaffles,
    getAvailableRaces,
    getRaceById,
    getRaceDetails,
    getRaceChannels,
    getOrCreateRaceCollabInvite,
    getRaceCollabInviteByToken,
    sendRaceCollabInvite,
    createRaceDraft,
    setRaceChannels,
    activateRace,
    addParticipant,
    prepareRaceRounds,
    finalizeRaceWinners,
    refreshRaceLifecycle,
    getRaceLiveState,
    handleStartPayload,
    handleCallback,
    handleSessionMessage,
    applyYooKassaPayment,
    publishRaceToChannel,
    publishRaceEverywhere,
    updateRacePublishedPosts,
    activateAndPublishRace,
    sendHorseMenu,
    sendCreatorRaceCollabList,
    sendAdminRaces,
    buildRacePostText,
    buildRacePostKeyboard,
    extractPublicPhotoUrl,
    validateMaxInitData,
    HORSE_COLORS
  };
}

function validateMaxInitData(initData, botToken, options = {}) {
  const raw = String(initData || '').trim();
  if (!raw) return { ok: false, code: 'missing_init_data' };
  if (!botToken) return { ok: false, code: 'missing_bot_token' };
  if (raw.length > 32_768) return { ok: false, code: 'init_data_too_large' };

  const parsed = parseInitDataStrict(raw);
  if (!parsed.ok) return parsed;

  const originalHash = parsed.values.get('hash');
  if (!/^[a-f0-9]{64}$/i.test(originalHash || '')) {
    return { ok: false, code: 'invalid_hash_format' };
  }

  const launchParams = [...parsed.values.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', Buffer.from('WebAppData', 'utf8'))
    .update(Buffer.from(String(botToken), 'utf8'))
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(Buffer.from(launchParams, 'utf8'))
    .digest('hex');

  const expectedBuffer = Buffer.from(calculatedHash, 'hex');
  const actualBuffer = Buffer.from(originalHash, 'hex');

  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { ok: false, code: 'signature_mismatch' };
  }

  const authDate = Number(parsed.values.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, code: 'invalid_auth_date' };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const maxAgeSeconds = Math.max(60, Number(options.maxAgeSeconds || 3600));
  const futureSkewSeconds = Math.max(0, Number(options.futureSkewSeconds || 60));

  if (authDate > nowSeconds + futureSkewSeconds) {
    return { ok: false, code: 'auth_date_in_future' };
  }

  if (nowSeconds - authDate > maxAgeSeconds) {
    return { ok: false, code: 'init_data_expired' };
  }

  let user;
  let chat = null;
  try {
    user = JSON.parse(parsed.values.get('user') || 'null');
    if (parsed.values.has('chat')) chat = JSON.parse(parsed.values.get('chat') || 'null');
  } catch {
    return { ok: false, code: 'invalid_json' };
  }

  if (!user || !/^\d+$/.test(String(user.id || ''))) {
    return { ok: false, code: 'invalid_user' };
  }

  return {
    ok: true,
    data: {
      queryId: parsed.values.get('query_id') || '',
      authDate,
      hash: originalHash,
      user,
      chat,
      startParam: parsed.values.get('start_param') || '',
      raw
    }
  };
}

function parseInitDataStrict(raw) {
  const values = new Map();
  const parts = String(raw).split('&');

  for (const part of parts) {
    if (!part) return { ok: false, code: 'empty_parameter' };
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) return { ok: false, code: 'invalid_parameter' };

    const rawKey = part.slice(0, separatorIndex);
    const rawValue = part.slice(separatorIndex + 1);
    let key;
    let value;

    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      return { ok: false, code: 'decode_failed' };
    }

    if (!key || values.has(key)) {
      return { ok: false, code: values.has(key) ? 'duplicate_parameter' : 'empty_key' };
    }

    values.set(key, value);
  }

  if (!values.has('hash')) return { ok: false, code: 'missing_hash' };
  if (!values.has('user')) return { ok: false, code: 'missing_user' };
  if (!values.has('auth_date')) return { ok: false, code: 'missing_auth_date' };

  return { ok: true, values };
}

function renderMiniAppHtml(nonce) {
  const colorsJson = JSON.stringify(HORSE_COLORS).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#101827">
  <title>РОЗЫГРЫШ ТОП</title>
  <script src="https://st.max.ru/js/max-web-app.js"></script>
  <style nonce="${nonce}">
    :root{color-scheme:dark;--bg:#09111f;--panel:#111c2e;--panel2:#17243a;--text:#f8fafc;--muted:#9fb0c7;--line:#2a3a55;--accent:#ffd166;--danger:#ef4444;--ok:#22c55e}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#1c3154 0,#09111f 42%,#050a12 100%);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif;min-height:100vh}
    button,a{font:inherit}.app{max-width:760px;margin:0 auto;padding:18px 14px 34px}.header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.brand{font-weight:900;letter-spacing:.5px}.user{color:var(--muted);font-size:13px;text-align:right}
    .tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;background:rgba(17,28,46,.82);padding:6px;border:1px solid var(--line);border-radius:16px;position:sticky;top:8px;z-index:10;backdrop-filter:blur(12px)}.tab{border:0;border-radius:12px;padding:12px 8px;background:transparent;color:var(--muted);font-weight:800}.tab.active{background:#fff;color:#101827}
    .toolbar{display:flex;gap:9px;margin:14px 0}.primary,.secondary{border:0;border-radius:14px;padding:12px 15px;font-weight:900;cursor:pointer}.primary{background:var(--accent);color:#241a00}.secondary{background:var(--panel2);color:var(--text);border:1px solid var(--line)}
    .list{display:grid;gap:12px}.card{display:grid;grid-template-columns:100px 1fr;gap:13px;background:linear-gradient(150deg,rgba(23,36,58,.98),rgba(12,22,38,.98));border:1px solid var(--line);border-radius:20px;padding:11px;box-shadow:0 14px 30px rgba(0,0,0,.2)}.image{width:100px;height:100px;border-radius:15px;object-fit:cover;background:linear-gradient(135deg,#2d4264,#101827);display:block}.placeholder{width:100px;height:100px;border-radius:15px;background:linear-gradient(135deg,#28405f,#8b5e00);display:grid;place-items:center;font-size:38px}
    .card h3{margin:2px 0 7px;font-size:17px}.meta{display:flex;flex-wrap:wrap;gap:6px;color:var(--muted);font-size:12px}.badge{display:inline-flex;padding:4px 7px;border-radius:999px;background:#22324c;color:#dbeafe}.badge.top{background:#5b4300;color:#ffe59b}.countdown{font-variant-numeric:tabular-nums;color:#ffe59b;font-weight:800;margin-top:8px}.actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.small{border:0;border-radius:11px;padding:9px 11px;background:#fff;color:#111827;font-weight:900}.small.alt{background:#22324c;color:#fff;border:1px solid #344967}.small[disabled]{opacity:.45}
    .empty,.error,.loading{padding:28px 18px;text-align:center;color:var(--muted);background:rgba(17,28,46,.75);border:1px solid var(--line);border-radius:18px}.error{color:#fecaca;border-color:#7f1d1d}.hidden{display:none!important}
    .race-view{margin-top:14px}.race-head{background:rgba(17,28,46,.92);border:1px solid var(--line);border-radius:20px;padding:16px}.race-head h2{margin:0 0 8px}.back{background:transparent;border:1px solid var(--line);color:#fff;border-radius:11px;padding:8px 11px;margin-bottom:10px}.own{margin:10px 0;padding:10px 12px;background:#132b22;border:1px solid #1f6a4b;border-radius:13px;color:#bbf7d0}
    .track-wrap{margin-top:12px;background:linear-gradient(#1f7a45 0 15%,#b97b43 15% 88%,#2e8b57 88%);border:4px solid #e6e0cf;border-radius:20px;overflow:hidden;box-shadow:inset 0 0 30px rgba(0,0,0,.35)}.crowd{height:55px;background:repeating-linear-gradient(90deg,#26364e 0 8px,#d1d5db 8px 11px,#7c3aed 11px 15px,#26364e 15px 21px);position:relative}.crowd:after{content:'🏁  🎺  🏟️  🎺  🏁';position:absolute;inset:13px 0;text-align:center;font-size:23px;letter-spacing:12px}.lane{height:58px;position:relative;border-top:2px dashed rgba(255,255,255,.55)}.lane:first-of-type{border-top:3px solid rgba(255,255,255,.8)}.lane:after{content:'';position:absolute;right:34px;top:0;bottom:0;width:8px;background:repeating-linear-gradient(#fff 0 8px,#111 8px 16px)}.horse{position:absolute;left:4px;top:7px;width:48px;height:44px;display:grid;place-items:center;border-radius:50%;font-size:28px;filter:drop-shadow(0 4px 3px rgba(0,0,0,.35));will-change:transform}.horse-glyph{display:inline-block;font-style:normal;line-height:1;transform:scaleX(-1);transform-origin:center}.horse span{position:absolute;right:-7px;top:-6px;background:#0b1220;color:#fff;border:2px solid currentColor;border-radius:999px;width:24px;height:24px;font-size:11px;display:grid;place-items:center;font-weight:900}.lane-label{position:absolute;left:6px;bottom:2px;font-size:10px;color:rgba(255,255,255,.8)}
    .race-status{padding:13px;text-align:center;font-weight:900;background:#101827;border-top:1px solid var(--line)}.rounds{display:grid;gap:8px;margin-top:12px}.round{padding:11px 12px;background:var(--panel);border:1px solid var(--line);border-radius:13px}.round.active{border-color:#f1c75b}.winner{color:#fde68a;font-weight:900}.sound{width:100%;margin-top:11px}
    @media(max-width:520px){.card{grid-template-columns:82px 1fr}.image,.placeholder{width:82px;height:82px}.app{padding-left:10px;padding-right:10px}.horse{width:42px}.lane{height:54px}}
  </style>
</head>
<body>
<div class="app">
  <div class="header"><div class="brand">🏆 РОЗЫГРЫШ ТОП</div><div id="user" class="user">MAX Mini App</div></div>
  <div class="tabs"><button class="tab active" data-tab="raffles">🥇 Розыгрыши ТОП‑1</button><button class="tab" data-tab="races">🏇 Скачки</button></div>
  <main>
    <section id="raffles-section">
      <div class="toolbar"><button id="buy-top1" class="primary">🥇 Купить ТОП‑1</button><button class="secondary" data-refresh="raffles">Обновить</button></div>
      <div id="raffles" class="list"><div class="loading">Загрузка розыгрышей…</div></div>
    </section>
    <section id="races-section" class="hidden">
      <div class="toolbar"><button class="secondary" data-refresh="races">Обновить список</button></div>
      <div id="races" class="list"><div class="loading">Загрузка скачек…</div></div>
    </section>
    <section id="race-view" class="race-view hidden"></section>
  </main>
</div>
<script nonce="${nonce}">
(() => {
  'use strict';
  const COLORS=${colorsJson};
  const WebApp=window.WebApp||null;
  const initData=String(WebApp?.initData||'');
  const state={tab:'raffles',timers:[],serverOffset:0,currentRaceId:null,liveTimer:null,animationFrame:null,audio:null,soundEnabled:false,playedRounds:new Set(),replayMode:false,replayToken:0,lastLive:null};
  const $=s=>document.querySelector(s); const $$=s=>[...document.querySelectorAll(s)];
  const escapeHtml=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const isoMs=v=>{const n=new Date(v).getTime();return Number.isFinite(n)?n:0};
  const now=()=>Date.now()+state.serverOffset;
  const fmtDate=v=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(v));
  const fmtCountdown=ms=>{if(ms<=0)return'уже началось';const s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),sec=s%60;return d?d+'д '+h+'ч '+m+'м':h?h+'ч '+m+'м '+sec+'с':m+'м '+sec+'с'};
  function api(path){if(!initData)return Promise.reject(new Error('Откройте Mini App внутри MAX'));return fetch(path,{headers:{'X-Max-Init-Data':initData,'Accept':'application/json'},cache:'no-store'}).then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok||!j.ok)throw new Error(j.error||'Ошибка сервера');return j})}
  function syncServerTime(value){const t=isoMs(value);if(t)state.serverOffset=t-Date.now()}
  function openMax(url){if(!url)return;try{WebApp?.HapticFeedback?.impactOccurred('light').catch(()=>{})}catch{};if(WebApp?.openMaxLink&&String(url).toLowerCase().startsWith('https://max.ru/')){WebApp.openMaxLink(url);return}if(WebApp?.openLink){WebApp.openLink(url);return}location.href=url}
  function imageHtml(url,emoji){return url?'<img class="image" loading="lazy" referrerpolicy="no-referrer" src="'+escapeHtml(url)+'" alt="">':'<div class="placeholder">'+emoji+'</div>'}
  function clearTimers(){state.timers.forEach(clearInterval);state.timers=[]}
  function attachCountdowns(){clearTimers();$$('[data-countdown]').forEach(el=>{const target=isoMs(el.dataset.countdown);const render=()=>el.textContent=fmtCountdown(target-now());render();state.timers.push(setInterval(render,1000))})}
  async function loadMe(){try{const j=await api('/api/miniapp/me');syncServerTime(j.serverNow);const name=[j.user.firstName,j.user.lastName].filter(Boolean).join(' ')||'Пользователь MAX';$('#user').textContent=name}catch(e){showGlobalError(e.message)}}
  async function loadRaffles(){const box=$('#raffles');box.innerHTML='<div class="loading">Загрузка розыгрышей…</div>';try{const j=await api('/api/miniapp/top-raffles');syncServerTime(j.serverNow);$('#buy-top1').onclick=()=>openMax(j.top1BuyUrl);box.innerHTML=j.items.length?j.items.map(r=>'<article class="card">'+imageHtml(r.photoUrl,'🎁')+'<div><h3>'+escapeHtml(r.title)+'</h3><div class="meta"><span class="badge">№'+r.id+'</span>'+(r.isTop1?'<span class="badge top">🥇 ТОП‑1</span>':'')+'<span class="badge">👥 '+r.participantsCount+'</span><span class="badge">🎁 '+r.prizeCount+'</span></div><div class="countdown">До окончания: <span data-countdown="'+escapeHtml(r.endsAt)+'"></span></div><div class="actions"><button class="small" data-open="'+escapeHtml(r.joinUrl)+'">🎁 Участвовать</button></div></div></article>').join(''):'<div class="empty">Сейчас нет активных розыгрышей.</div>';box.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openMax(b.dataset.open));attachCountdowns()}catch(e){box.innerHTML='<div class="error">'+escapeHtml(e.message)+'</div>'}}
  function raceCard(r){
    const finished=r.status==='finished';
    const running=r.status==='running';
    const badge=finished?'<span class="badge">✅ Завершено</span>':running?'<span class="badge">🔴 LIVE</span>':'<span class="badge">🕒 Ожидает старта</span>';
    const timeLine=finished
      ? '<div class="countdown">✅ Скачки завершены</div>'
      : running
        ? '<div class="countdown">🔴 Забег идёт сейчас</div>'
        : '<div class="countdown">Старт: '+escapeHtml(fmtDate(r.startsAt))+' · <span data-countdown="'+escapeHtml(r.startsAt)+'"></span></div>';
    const joinButton=r.canJoin?'<button class="small alt" data-join="'+escapeHtml(r.joinUrl)+'">🐎 Участвовать</button>':'';
    const watchText=finished?'🔁 Пересмотреть скачки':running?'Смотреть LIVE':'Смотреть скачки';
    const watchButton='<button class="small" data-race="'+r.id+'" '+(r.canOpen?'':'disabled')+'>'+(r.canOpen?watchText:'Откроется за 12 часов')+'</button>';
    return '<article class="card">'+imageHtml(r.photoUrl,'🐎')+'<div><h3>'+escapeHtml(r.title)+'</h3><div class="meta"><span class="badge">№'+r.id+'</span>'+badge+'<span class="badge">👥 '+r.participantsCount+'</span><span class="badge">🏆 '+r.prizeCount+'</span>'+(r.ownHorseColor?'<span class="badge">Ваша: '+escapeHtml(r.ownHorseColor.label)+'</span>':'')+'</div>'+timeLine+'<div class="actions">'+joinButton+watchButton+'</div></div></article>';
  }
  async function loadRaces(){
    const box=$('#races');
    box.innerHTML='<div class="loading">Загрузка скачек…</div>';
    try{
      const j=await api('/api/miniapp/races');
      syncServerTime(j.serverNow);
      box.innerHTML=j.items.length?j.items.map(raceCard).join(''):'<div class="empty">Доступных скачек пока нет.</div>';
      box.querySelectorAll('[data-join]').forEach(b=>b.onclick=()=>openMax(b.dataset.join));
      box.querySelectorAll('[data-race]:not([disabled])').forEach(b=>b.onclick=()=>openRace(Number(b.dataset.race)));
      attachCountdowns();
    }catch(e){
      box.innerHTML='<div class="error">'+escapeHtml(e.message)+'</div>';
    }
  }
  function setTab(tab){state.tab=tab;state.replayMode=false;state.replayToken+=1;$$('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));$('#raffles-section').classList.toggle('hidden',tab!=='raffles');$('#races-section').classList.toggle('hidden',tab!=='races');$('#race-view').classList.add('hidden');if(state.liveTimer)clearInterval(state.liveTimer);state.liveTimer=null;if(state.animationFrame)cancelAnimationFrame(state.animationFrame);state.animationFrame=null;tab==='raffles'?loadRaffles():loadRaces()}
  async function openRace(id){
    state.currentRaceId=id;
    state.replayMode=false;
    state.replayToken+=1;
    $('#raffles-section').classList.add('hidden');
    $('#races-section').classList.add('hidden');
    const view=$('#race-view');
    view.classList.remove('hidden');
    view.innerHTML='<div class="loading">Открываем ипподром…</div>';
    try{
      const j=await api('/api/miniapp/races/'+id);
      syncServerTime(j.serverNow);
      const r=j.race;
      if(!r.canOpen){
        view.innerHTML='<button class="back">← Назад</button><div class="empty">Ипподром откроется '+escapeHtml(fmtDate(r.openAt))+'.</div>';
        view.querySelector('.back').onclick=()=>setTab('races');
        return;
      }
      const finished=r.status==='finished';
      const statusLine=finished
        ? '<div class="countdown">✅ Скачки завершены</div>'
        : '<div class="countdown">Старт: '+escapeHtml(fmtDate(r.startsAt))+' · <span data-countdown="'+escapeHtml(r.startsAt)+'"></span></div>';
      const joinBlock=r.canJoin
        ? (r.ownHorseColor
          ? '<div class="own">🎟 Ваш билет: <b>№'+escapeHtml(r.ownTicketNumber)+'</b><br>🐎 Ваша лошадь: <b>'+escapeHtml(r.ownHorseColor.label)+'</b></div>'
          : '<div class="actions"><button class="small alt" data-join="'+escapeHtml(r.joinUrl)+'">🐎 Получить билет</button></div>')
        : (r.ownHorseColor
          ? '<div class="own">🎟 Ваш билет: <b>№'+escapeHtml(r.ownTicketNumber)+'</b><br>🐎 Ваша лошадь: <b>'+escapeHtml(r.ownHorseColor.label)+'</b></div>'
          : '');
      view.innerHTML='<button class="back">← К списку</button><div class="race-head"><h2>🐎 '+escapeHtml(r.title)+'</h2><div>'+escapeHtml(r.description||'Смотрите забег вживую.')+'</div>'+statusLine+joinBlock+'<button id="sound" class="secondary sound">🔊 Включить звук</button><button id="replay" class="primary sound hidden">🔁 Пересмотреть скачки</button></div><div class="track-wrap"><div class="crowd"></div><div id="lanes"></div><div id="race-status" class="race-status">'+(finished?'✅ Завершено':'Подготовка…')+'</div></div><div id="rounds" class="rounds"></div>';
      view.querySelector('.back').onclick=()=>setTab('races');
      view.querySelector('[data-join]')?.addEventListener('click',e=>openMax(e.currentTarget.dataset.join));
      $('#sound').onclick=enableSound;
      renderLanes();
      attachCountdowns();
      await pollLive();
      state.liveTimer=setInterval(pollLive,1000);
    }catch(e){
      view.innerHTML='<button class="back">← Назад</button><div class="error">'+escapeHtml(e.message)+'</div>';
      view.querySelector('.back').onclick=()=>setTab('races');
    }
  }
  function renderLanes(){const lanes=$('#lanes');if(!lanes)return;lanes.innerHTML=COLORS.map((c,i)=>'<div class="lane"><div class="horse" id="horse-'+c.code+'" style="color:'+c.css+';background:'+c.css+'33;border:2px solid '+c.css+'"><i class="horse-glyph">🐎</i><span style="color:'+c.css+'">'+(i+1)+'</span></div><div class="lane-label">'+escapeHtml(c.label)+'</div></div>').join('')}
  async function pollLive(){
    if(!state.currentRaceId||state.replayMode)return;
    try{
      const j=await api('/api/miniapp/races/'+state.currentRaceId+'/live');
      const l=j.live;
      state.lastLive=l;
      syncServerTime(l.serverNow);
      if(l.locked){
        $('#race-status').textContent='Ипподром откроется '+fmtDate(l.opensAt);
        return;
      }
      const replay=$('#replay');
      if(replay){
        replay.classList.toggle('hidden',!l.replayAvailable);
        replay.onclick=l.replayAvailable?()=>startReplay(l.rounds):null;
      }
      renderRounds(l.rounds,l.currentRound);
      animateRound(l.currentRound);
    }catch(e){
      const s=$('#race-status');
      if(s)s.textContent=e.message;
    }
  }
  function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
  async function startReplay(rounds){
    const replayRounds=(Array.isArray(rounds)?rounds:[]).filter(r=>r.animationSeed&&r.winnerColor);
    if(!replayRounds.length)return;
    const token=++state.replayToken;
    state.replayMode=true;
    if(state.liveTimer)clearInterval(state.liveTimer);
    state.liveTimer=null;
    const button=$('#replay');
    if(button){button.disabled=true;button.textContent='🏇 Идёт повтор…'}
    state.playedRounds.clear();
    for(const round of replayRounds){
      if(token!==state.replayToken)return;
      renderRounds(rounds,round);
      await replayRound(round,token);
      if(token!==state.replayToken)return;
      await wait(900);
    }
    if(token!==state.replayToken)return;
    state.replayMode=false;
    if(button){button.disabled=false;button.textContent='🔁 Пересмотреть скачки'}
    await pollLive();
    state.liveTimer=setInterval(pollLive,1000);
  }
  function replayRound(round,token){
    return new Promise(resolve=>{
      resetHorses();
      playStartSound();
      const started=performance.now();
      const duration=Math.max(3000,Number(round.durationMs||20000));
      const winner=round.winnerColor.code;
      const seed=round.animationSeed;
      const frame=()=>{
        if(token!==state.replayToken){resolve();return}
        const p=Math.max(0,Math.min(1,(performance.now()-started)/duration));
        COLORS.forEach((c,i)=>{
          const horse=$('#horse-'+c.code);
          if(!horse)return;
          const pos=positionFor(c.code,i,p,seed,winner);
          const lane=horse.parentElement;
          const max=Math.max(0,lane.clientWidth-horse.offsetWidth-38);
          horse.style.transform='translateX('+(max*pos)+'px) translateY('+(Math.sin(p*35+i)*2)+'px)';
        });
        const status=$('#race-status');
        if(status)status.textContent='🔁 Повтор забега '+round.prizeIndex+' · '+(round.prizeText||'Приз');
        if(p<1){
          state.animationFrame=requestAnimationFrame(frame);
        }else{
          setFinalPositions(round);
          if(status)status.innerHTML='🏆 Победила <span style="color:'+round.winnerColor.css+'">'+escapeHtml(round.winnerColor.label)+'</span> · билет №'+escapeHtml(round.winnerTicketNumber||'—');
          resolve();
        }
      };
      if(state.animationFrame)cancelAnimationFrame(state.animationFrame);
      frame();
    });
  }
  function renderRounds(rounds,current){const box=$('#rounds');if(!box)return;box.innerHTML=rounds.map(r=>'<div class="round '+(current&&current.id===r.id?'active':'')+'"><b>Забег '+r.prizeIndex+': '+escapeHtml(r.prizeText||'Приз')+'</b><div class="meta">'+(r.status==='upcoming'?'Старт '+fmtDate(r.startsAt):r.status==='running'?'🏇 Идёт сейчас':r.winnerColor?'<span class="winner">🏆 '+escapeHtml(r.winnerColor.label)+' · билет №'+escapeHtml(r.winnerTicketNumber||'—')+'</span>':'Завершён без участника')+'</div></div>').join('')}
  function animateRound(round){if(!round){$('#race-status').textContent='Ожидаем забеги';return}if(round.status==='upcoming'){resetHorses();$('#race-status').textContent='До забега «'+(round.prizeText||'Приз')+'»: '+fmtCountdown(isoMs(round.startsAt)-now());return}if(round.status==='finished'){setFinalPositions(round);$('#race-status').innerHTML=round.winnerColor?'🏆 Победила <span style="color:'+round.winnerColor.css+'">'+escapeHtml(round.winnerColor.label)+'</span> · билет №'+escapeHtml(round.winnerTicketNumber||'—'):'Забег завершён без победителя';return}if(!round.animationSeed||!round.winnerColor)return;if(!state.playedRounds.has(round.id)){state.playedRounds.add(round.id);playStartSound()}const started=isoMs(round.startsAt),duration=Number(round.durationMs||20000),winner=round.winnerColor.code,seed=round.animationSeed;const frame=()=>{if(!state.currentRaceId)return;const p=Math.max(0,Math.min(1,(now()-started)/duration));COLORS.forEach((c,i)=>{const horse=$('#horse-'+c.code);if(!horse)return;const pos=positionFor(c.code,i,p,seed,winner);const lane=horse.parentElement;const max=Math.max(0,lane.clientWidth-horse.offsetWidth-38);horse.style.transform='translateX('+(max*pos)+'px) translateY('+(Math.sin(p*35+i)*2)+'px)'});$('#race-status').textContent='🏇 Забег '+round.prizeIndex+' · '+escapeHtml(round.prizeText||'Приз');if(p<1)state.animationFrame=requestAnimationFrame(frame)};if(state.animationFrame)cancelAnimationFrame(state.animationFrame);frame()}
  function hash32(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}
  function positionFor(code,index,p,seed,winner){const h=hash32(seed+code),phase=(h%628)/100,amp=.025+((h>>>8)%20)/1000;let raw=p*.91+Math.sin(p*(15+(h%7))+phase)*amp+Math.sin(p*41+index)*.012;raw=Math.max(0,raw);if(p>.72){const t=(p-.72)/.28;const target=code===winner?1:.88+((h>>>16)%7)/100;raw=raw*(1-t)+target*t}return Math.max(0,Math.min(1,raw))}
  function resetHorses(){COLORS.forEach(c=>{const h=$('#horse-'+c.code);if(h)h.style.transform='translateX(0)'})}
  function setFinalPositions(round){COLORS.forEach((c,i)=>{const h=$('#horse-'+c.code);if(!h)return;const lane=h.parentElement,max=Math.max(0,lane.clientWidth-h.offsetWidth-38),isWinner=round.winnerColor&&c.code===round.winnerColor.code;h.style.transform='translateX('+(max*(isWinner?1:.86-i*.012))+'px)'})}
  async function enableSound(){state.soundEnabled=true;try{state.audio=state.audio||new(window.AudioContext||window.webkitAudioContext)();await state.audio.resume();$('#sound').textContent='🔊 Звук включён';playClick()}catch{$('#sound').textContent='Звук недоступен'}}
  function playClick(){if(!state.soundEnabled||!state.audio)return;const o=state.audio.createOscillator(),g=state.audio.createGain();o.frequency.value=520;g.gain.setValueAtTime(.08,state.audio.currentTime);g.gain.exponentialRampToValueAtTime(.001,state.audio.currentTime+.12);o.connect(g).connect(state.audio.destination);o.start();o.stop(state.audio.currentTime+.12)}
  function playStartSound(){if(!state.soundEnabled||!state.audio)return;const t=state.audio.currentTime;[392,523,659].forEach((f,i)=>{const o=state.audio.createOscillator(),g=state.audio.createGain();o.type='sawtooth';o.frequency.setValueAtTime(f,t+i*.14);g.gain.setValueAtTime(.0001,t+i*.14);g.gain.exponentialRampToValueAtTime(.12,t+i*.14+.02);g.gain.exponentialRampToValueAtTime(.001,t+i*.14+.22);o.connect(g).connect(state.audio.destination);o.start(t+i*.14);o.stop(t+i*.14+.24)});try{WebApp?.HapticFeedback?.notificationOccurred('success').catch(()=>{})}catch{}}
  function showGlobalError(message){$('#raffles').innerHTML='<div class="error">'+escapeHtml(message)+'</div>';$('#races').innerHTML='<div class="error">'+escapeHtml(message)+'</div>'}
  $$('.tab').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));$$('[data-refresh]').forEach(b=>b.onclick=()=>b.dataset.refresh==='raffles'?loadRaffles():loadRaces());
  try{WebApp?.BackButton?.show();WebApp?.BackButton?.onClick(()=>{if(!$('#race-view').classList.contains('hidden'))setTab('races');else history.back()})}catch{}
  const startParam=String(WebApp?.initDataUnsafe?.start_param||'');
  loadMe().then(()=>{const m=startParam.match(/^race_(\d+)$/);if(m){state.tab='races';$$('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab==='races'));openRace(Number(m[1]))}else if(startParam==='races'){setTab('races')}else loadRaffles()});
})();
</script>
</body>
</html>`;
}

function renderHorseCollabLandingPage(options = {}) {
  const escape = value => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  const buttonUrl = normalizePublicHttpUrl(options.buttonUrl) || '#';

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escape(options.title || 'Совместные скачки')}</title>
</head>
<body style="margin:0;background:#09111f;color:#f8fafc;font-family:Arial,sans-serif;min-height:100vh;display:grid;place-items:center;padding:20px;box-sizing:border-box">
  <main style="width:min(520px,100%);background:#111c2e;border:1px solid #2a3a55;border-radius:22px;padding:24px;box-sizing:border-box;text-align:center">
    <div style="font-size:48px">🐎</div>
    <h1 style="font-size:24px">${escape(options.heading || 'Совместные скачки')}</h1>
    <p style="line-height:1.55;color:#cbd5e1">${escape(options.description || '')}</p>
    <a href="${escape(buttonUrl)}" style="display:inline-block;margin-top:12px;padding:14px 18px;background:#ffd166;color:#241a00;text-decoration:none;border-radius:14px;font-weight:700">${escape(options.buttonText || 'Открыть бота')}</a>
  </main>
</body>
</html>`;
}

function extractPublicPhotoUrl(value) {
  const parsed = normalizeJsonValue(value);
  if (!parsed) return null;

  const priorityKeys = [
    'photo_url', 'photoUrl', 'image_url', 'imageUrl', 'preview_url', 'previewUrl',
    'download_url', 'downloadUrl', 'original_url', 'originalUrl', 'src', 'url'
  ];

  const seen = new Set();

  function walk(node, depth = 0) {
    if (depth > 7 || node === null || node === undefined) return null;

    if (typeof node === 'string') {
      return normalizePublicPhotoUrl(node);
    }

    if (typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);

    for (const key of priorityKeys) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        const direct = normalizePublicPhotoUrl(node[key]);
        if (direct) return direct;
      }
    }

    const likelyContainers = ['payload', 'photo', 'image', 'media', 'preview', 'sizes', 'photos', 'images', 'attachments'];
    for (const key of likelyContainers) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        const found = walk(node[key], depth + 1);
        if (found) return found;
      }
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
    } else {
      for (const child of Object.values(node)) {
        const found = walk(child, depth + 1);
        if (found) return found;
      }
    }

    return null;
  }

  return walk(parsed);
}

function normalizePublicPhotoUrl(value) {
  const url = normalizePublicHttpUrl(value);
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return null;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return null;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
    if (host === '::1' || host === '[::1]') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizePublicHttpUrl(value) {
  const text = String(value || '').trim();
  if (!/^https:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function isPlaceholderMiniAppUrl(value) {
  const text = String(value || '').trim();
  if (!text) return true;

  return /(?:<|>|ваш|ссылка|пример|your|example|awesome|bot[_-]?link|имя[_ -]?бота)/i.test(text);
}

function normalizeMaxBotUsername(value) {
  const clean = String(value || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/^https?:\/\/max\.ru\//i, '')
    .split(/[?#/]/)[0]
    .trim();

  return /^[A-Za-z0-9_-]{3,120}$/.test(clean) ? clean : '';
}

function normalizeMaxMiniAppBase(value) {
  const text = String(value || '').trim();
  if (!text || isPlaceholderMiniAppUrl(text)) return '';

  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || (host !== 'max.ru' && !host.endsWith('.max.ru'))) return '';

    const path = url.pathname.replace(/\/+$/, '');
    if (!path || path === '/') return '';

    url.pathname = path;
    url.hash = '';
    url.searchParams.delete('start');
    url.searchParams.delete('startapp');
    return url.toString().replace(/\?$/, '');
  } catch {
    return '';
  }
}

function resolveMiniAppLaunchBase(options = {}) {
  const explicit = normalizeMaxMiniAppBase(options.explicitUrl);
  if (explicit) return { baseUrl: explicit, source: 'MAX_MINIAPP_LAUNCH_URL', isMaxUrl: true };

  const username = normalizeMaxBotUsername(options.botUsername);
  if (username) {
    return {
      baseUrl: `https://max.ru/${username}`,
      source: 'BOT_USERNAME',
      isMaxUrl: true
    };
  }

  const publicUrl = normalizeMaxMiniAppBase(options.botPublicUrl);
  if (publicUrl) return { baseUrl: publicUrl, source: 'BOT_PUBLIC_URL', isMaxUrl: true };

  return {
    baseUrl: normalizeBaseUrl(options.webUrl),
    source: 'MINIAPP_WEB_URL fallback',
    isMaxUrl: false
  };
}

function buildMiniAppLaunchUrl(baseUrl, startParam = 'home') {
  const base = normalizeBaseUrl(baseUrl);
  const cleanParam = sanitizeStartParam(startParam);
  if (!base) return '';

  try {
    const url = new URL(base);
    url.hash = '';
    url.searchParams.delete('start');
    url.searchParams.delete('startapp');
    if (cleanParam) url.searchParams.set('startapp', cleanParam);
    return url.toString();
  } catch {
    const separator = base.includes('?') ? '&' : '?';
    return cleanParam
      ? `${base}${separator}startapp=${encodeURIComponent(cleanParam)}`
      : base;
  }
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  return text;
}

function normalizeJsonValue(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeHorseColor(code) {
  const clean = String(code || '').trim();
  const color = HORSE_COLORS.find(item => item.code === clean);
  return color ? { ...color } : null;
}

function sanitizeStartParam(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 512);
}

function cleanText(value, max = 4000) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, max);
}

function cleanNullableText(value, max = 4000) {
  const text = cleanText(value, max);
  return text || null;
}

function splitNonEmptyLines(value) {
  if (Array.isArray(value)) {
    return value.map(item => cleanText(item, 500)).filter(Boolean);
  }

  return String(value || '')
    .split(/\r?\n/)
    .map(item => cleanText(item, 500))
    .filter(Boolean);
}

function normalizePositiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function generateTicketNumber() {
  // BIGINT передаём строкой, чтобы JavaScript не округлял 17-значный номер.
  return `${Date.now()}${crypto.randomInt(1000, 10_000)}`;
}

function secureShuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function escapeMarkdownText(value) {
  return String(value || '').replace(/[\[\]\n\r]/g, ' ').trim();
}

module.exports = {
  setupHorseRacesModule,
  validateMaxInitData,
  extractPublicPhotoUrl,
  resolveMiniAppLaunchBase,
  buildMiniAppLaunchUrl,
  HORSE_COLORS
};
