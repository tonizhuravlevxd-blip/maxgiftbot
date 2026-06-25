'use strict';

const crypto = require('crypto');

function setupPlayModule(options = {}) {
  const {
    app,
    pool,
    sendMessage,
    APP_BASE_URL = '',
    BOT_PUBLIC_URL = ''
  } = options;

  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('play_module: app is required');
  }

  if (!pool || typeof pool.query !== 'function') {
    throw new Error('play_module: pool is required');
  }

  if (typeof sendMessage !== 'function') {
    throw new Error('play_module: sendMessage is required');
  }

  function safeText(value, max = 4000) {
    return String(value || '')
      .replace(/\u0000/g, '')
      .trim()
      .slice(0, max);
  }

  function normalizeHttpUrl(value) {
    const text = String(value || '').trim();
    if (!text || !/^https?:\/\//i.test(text)) return '';

    try {
      const url = new URL(text);
      url.hash = '';
      return url.toString();
    } catch {
      return '';
    }
  }

  const playBackgroundImageUrl = normalizeHttpUrl(process.env.PLAY_BACKGROUND_IMAGE_URL || '');

  function buildPlayGameUrl() {
    const base = String(APP_BASE_URL || BOT_PUBLIC_URL || '').replace(/\/+$/, '');
    return `${base}/play`;
  }

  async function sendPlayGameMessage(target) {
    const playUrl = buildPlayGameUrl();

    if (!playUrl || !/^https?:\/\//i.test(playUrl)) {
      return sendMessage(target, '⚠️ Ссылка на игру пока недоступна: проверьте APP_BASE_URL в Render.');
    }

    return sendMessage(
      target,
      [
        '🎮 **Мини-игра от РОЗЫГРЫШ БОТ**',
        '',
        'Нажмите кнопку ниже и помогите собаке перепрыгивать препятствия.',
        'Скорость постепенно увеличивается, а очки растут, пока вы держитесь в игре.'
      ].join('\n'),
      [
        [{ text: '🎮 Играть', url: playUrl }],
        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
      ]
    );
  }

  function buildPlayGameHtml() {
    return `<!doctype html>
  <html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title>РОЗЫГРЫШ БОТ — игра</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
      html, body { margin: 0; width: 100%; height: 100%; background: #0f172a; font-family: Arial, Helvetica, sans-serif; color: #fff; overflow: hidden; }
      body { padding: max(6px, env(safe-area-inset-top)) max(6px, env(safe-area-inset-right)) max(6px, env(safe-area-inset-bottom)) max(6px, env(safe-area-inset-left)); }
      .wrap { width: 100%; height: 100%; }
      .card {
        width: 100%;
        height: 100%;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        gap: 8px;
        background: radial-gradient(circle at 20% 0%, rgba(250,204,21,.14), transparent 34%), linear-gradient(180deg, #1f2937, #0f172a);
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 20px;
        padding: 10px;
        box-shadow: 0 24px 70px rgba(0,0,0,.35);
        overflow: hidden;
        position: relative;
      }
      .top { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 34px; }
      .brand { font-weight: 900; letter-spacing: .08em; font-size: clamp(15px, 2.4vw, 25px); white-space: nowrap; }
      .score { font-weight: 900; font-size: clamp(15px, 2.4vw, 24px); white-space: nowrap; }
      .game-shell { min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 10px; }
      .canvas-box { min-width: 0; min-height: 0; height: 100%; }
      canvas { width: 100%; height: 100%; display: block; border-radius: 18px; background: linear-gradient(#7dd3fc 0%, #fde68a 62%, #d6a24d 63%, #9a6b2f 100%); touch-action: manipulation; }
      .side-panel { display: grid; align-content: start; gap: 10px; }
      .stat-card { border-radius: 18px; padding: 14px; background: rgba(15,23,42,.72); border: 1px solid rgba(255,255,255,.12); box-shadow: inset 0 1px 0 rgba(255,255,255,.06); }
      .stat-label { opacity: .76; font-size: 13px; line-height: 1.2; }
      .stat-value { margin-top: 4px; font-weight: 900; font-size: clamp(24px, 5vw, 38px); color: #facc15; }
      .stat-small { margin-top: 4px; opacity: .72; font-size: 12px; line-height: 1.25; }
      .bottom { display: grid; grid-template-columns: minmax(0, 1fr) 230px; gap: 10px; align-items: center; }
      .hint { margin: 0; opacity: .84; line-height: 1.3; font-size: clamp(12px, 2vw, 14px); text-align: left; }
      .button { width: 100%; border: 0; border-radius: 16px; padding: 13px 16px; font-size: 16px; font-weight: 900; color: #111827; background: #facc15; cursor: pointer; }
      .button:active { transform: translateY(1px); }
      @media (max-width: 800px) {
        body { padding: 4px; }
        .card { border-radius: 16px; padding: 7px; gap: 6px; }
        .top { min-height: 28px; }
        .game-shell { display: block; position: relative; }
        .canvas-box { width: 100%; height: 100%; }
        .side-panel { position: absolute; right: 8px; top: 8px; width: 138px; gap: 6px; z-index: 2; }
        .stat-card { padding: 8px 10px; border-radius: 13px; background: rgba(15,23,42,.62); backdrop-filter: blur(6px); }
        .stat-label { font-size: 10px; }
        .stat-value { font-size: 21px; margin-top: 2px; }
        .stat-small { display: none; }
        .bottom { grid-template-columns: 1fr; gap: 6px; }
        .hint { text-align: center; font-size: 11px; }
        .button { padding: 10px 12px; font-size: 14px; }
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="card">
        <div class="top">
          <div class="brand">РОЗЫГРЫШ БОТ</div>
          <div class="score">Очки: <span id="score">0</span></div>
        </div>

        <div class="game-shell">
          <div class="canvas-box">
            <canvas id="game" width="1600" height="900" aria-label="Игра: мультяшная собака бежит по Египту и перепрыгивает препятствия"></canvas>
          </div>
          <aside class="side-panel" aria-label="Статистика игры">
            <div class="stat-card">
              <div class="stat-label">Онлайн сейчас</div>
              <div class="stat-value" id="onlineNow">—</div>
              <div class="stat-small">людей на странице игры</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Всего игроков</div>
              <div class="stat-value" id="totalPlayers">—</div>
              <div class="stat-small">пользователей, которых видел бот</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Ваш рекорд</div>
              <div class="stat-value" id="bestScore">0</div>
              <div class="stat-small">сохраняется на этом устройстве</div>
            </div>
          </aside>
        </div>

        <div class="bottom">
          <p class="hint">Нажмите кнопку, экран или пробел. Бегите по пустыне, перепрыгивайте камни и пирамиды. Скорость постепенно растёт.</p>
          <button class="button" id="jumpBtn">Прыгнуть / Начать заново</button>
        </div>
      </section>
    </main>

  <script>
  (function () {
    'use strict';

    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const scoreEl = document.getElementById('score');
    const jumpBtn = document.getElementById('jumpBtn');
    const onlineNowEl = document.getElementById('onlineNow');
    const totalPlayersEl = document.getElementById('totalPlayers');
    const bestScoreEl = document.getElementById('bestScore');

    const customBackgroundUrl = ${JSON.stringify(playBackgroundImageUrl)};
    const customBackgroundImage = new Image();
    let customBackgroundReady = false;

    if (customBackgroundUrl) {
      customBackgroundImage.onload = function () { customBackgroundReady = true; };
      customBackgroundImage.onerror = function () { customBackgroundReady = false; };
      customBackgroundImage.src = customBackgroundUrl;
    }

    const groundY = canvas.height - 150;
    const dog = { x: 135, y: groundY - 108, w: 132, h: 108, vy: 0, onGround: true, frame: 0 };
    const gravity = 0.92;
    const jumpPower = -20.5;
    let obstacles = [];
    let speed = 8.2;
    let nextObstacle = 0;
    let score = 0;
    let best = Number(localStorage.getItem('raffleBotDogBest') || 0) || 0;
    let running = true;
    let gameOver = false;
    let lastTime = performance.now();
    let worldOffset = 0;
    bestScoreEl.textContent = String(best);

    function getVisitorId() {
      let id = localStorage.getItem('raffleBotPlayVisitorId');
      if (!id) {
        id = 'v_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
        localStorage.setItem('raffleBotPlayVisitorId', id);
      }
      return id;
    }

    async function updateOnlineStats() {
      try {
        const response = await fetch('/play/ping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visitor_id: getVisitorId() })
        });
        const data = await response.json();
        if (data && data.ok) {
          onlineNowEl.textContent = String(data.online || 0);
          totalPlayersEl.textContent = String(data.total_players || 0);
        }
      } catch (e) {
        onlineNowEl.textContent = '—';
        totalPlayersEl.textContent = '—';
      }
    }

    function reset() {
      dog.y = groundY - dog.h;
      dog.vy = 0;
      dog.onGround = true;
      dog.frame = 0;
      obstacles = [];
      speed = 8.2;
      nextObstacle = 34;
      score = 0;
      worldOffset = 0;
      running = true;
      gameOver = false;
      lastTime = performance.now();
      scoreEl.textContent = '0';
    }

    function jump() {
      if (gameOver) {
        reset();
        return;
      }
      if (dog.onGround) {
        dog.vy = jumpPower;
        dog.onGround = false;
      }
    }

    function addObstacle() {
      const type = Math.random() < 0.48 ? 'stone' : 'smallPyramid';
      const h = type === 'stone' ? 42 + Math.random() * 34 : 58 + Math.random() * 34;
      const w = type === 'stone' ? 42 + Math.random() * 24 : 56 + Math.random() * 32;
      obstacles.push({ type: type, x: canvas.width + 40, y: groundY - h, w: w, h: h });
      nextObstacle = 50 + Math.random() * 68;
    }

    function collides(a, b) {
      const pad = 18;
      return a.x + pad < b.x + b.w && a.x + a.w - pad > b.x && a.y + pad < b.y + b.h && a.y + a.h - 10 > b.y;
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function drawSun() {
      const gradient = ctx.createRadialGradient(1320, 128, 18, 1320, 128, 110);
      gradient.addColorStop(0, 'rgba(255,255,255,.95)');
      gradient.addColorStop(.35, 'rgba(253,224,71,.95)');
      gradient.addColorStop(1, 'rgba(253,224,71,0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(1320, 128, 112, 0, Math.PI * 2);
      ctx.fill();
    }

    function drawPyramid(x, baseY, w, h, shade) {
      const left = x;
      const right = x + w;
      const apexX = x + w * 0.5;
      const apexY = baseY - h;
      const splitX = x + w * 0.57;

      ctx.save();

      ctx.fillStyle = 'rgba(92, 54, 20, .18)';
      ctx.beginPath();
      ctx.ellipse(x + w * .52, baseY + 10, w * .56, 14, 0, 0, Math.PI * 2);
      ctx.fill();

      // Левая грань
      ctx.fillStyle = shade || '#d7a246';
      ctx.beginPath();
      ctx.moveTo(left, baseY);
      ctx.lineTo(apexX, apexY);
      ctx.lineTo(splitX, baseY);
      ctx.closePath();
      ctx.fill();

      // Правая грань — темнее, чтобы пирамида выглядела объёмнее
      ctx.fillStyle = '#b77a2e';
      ctx.beginPath();
      ctx.moveTo(apexX, apexY);
      ctx.lineTo(right, baseY);
      ctx.lineTo(splitX, baseY);
      ctx.closePath();
      ctx.fill();

      // Светлая верхушка, как у настоящих известняковых пирамид
      ctx.fillStyle = 'rgba(255, 235, 170, .42)';
      ctx.beginPath();
      ctx.moveTo(apexX, apexY);
      ctx.lineTo(apexX - w * .075, apexY + h * .16);
      ctx.lineTo(apexX + w * .085, apexY + h * .16);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = 'rgba(91, 58, 25, .24)';
      ctx.lineWidth = Math.max(1.5, w / 160);

      for (let i = 1; i < 11; i++) {
        const yy = baseY - (h / 11) * i;
        const inset = (baseY - yy) / h * w / 2;
        ctx.beginPath();
        ctx.moveTo(left + inset, yy);
        ctx.lineTo(right - inset, yy);
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(91, 58, 25, .15)';
      ctx.lineWidth = Math.max(1, w / 230);

      for (let i = 1; i < 7; i++) {
        const offset = (i / 7) * w * .5;
        ctx.beginPath();
        ctx.moveTo(left + offset, baseY);
        ctx.lineTo(apexX, apexY);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(right - offset, baseY);
        ctx.lineTo(apexX, apexY);
        ctx.stroke();
      }

      ctx.fillStyle = 'rgba(255,255,255,.10)';
      ctx.beginPath();
      ctx.moveTo(left + w * .08, baseY - h * .02);
      ctx.lineTo(apexX, apexY);
      ctx.lineTo(left + w * .20, baseY - h * .02);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    }

    function drawCoverImage(image, x, y, w, h) {
      const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
      const sw = w / scale;
      const sh = h / scale;
      const sx = (image.naturalWidth - sw) / 2;
      const sy = (image.naturalHeight - sh) / 2;
      ctx.drawImage(image, sx, sy, sw, sh, x, y, w, h);
    }

    function drawDesertGround(alpha) {
      ctx.save();
      ctx.globalAlpha = alpha === undefined ? 1 : alpha;

      const sand = ctx.createLinearGradient(0, groundY - 28, 0, canvas.height);
      sand.addColorStop(0, '#f3c56a');
      sand.addColorStop(.45, '#d89b44');
      sand.addColorStop(1, '#966028');
      ctx.fillStyle = sand;
      ctx.fillRect(0, groundY - 28, canvas.width, canvas.height - groundY + 28);

      ctx.strokeStyle = 'rgba(120,78,31,.32)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(0, groundY);
      ctx.lineTo(canvas.width, groundY);
      ctx.stroke();

      const dune = -((worldOffset * .8) % 260);
      ctx.strokeStyle = 'rgba(255,255,255,.16)';
      ctx.lineWidth = 2;
      for (let i = -1; i < 9; i++) {
        ctx.beginPath();
        ctx.moveTo(dune + i * 260, groundY + 64);
        ctx.quadraticCurveTo(dune + i * 260 + 120, groundY + 34, dune + i * 260 + 260, groundY + 62);
        ctx.stroke();
      }

      ctx.restore();
    }

    function drawEgyptBackground() {
      if (customBackgroundReady) {
        drawCoverImage(customBackgroundImage, 0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(245, 158, 11, .10)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        drawDesertGround(.72);
        return;
      }

      const sky = ctx.createLinearGradient(0, 0, 0, groundY);
      sky.addColorStop(0, '#38bdf8');
      sky.addColorStop(.48, '#fef3c7');
      sky.addColorStop(1, '#f6c56d');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, canvas.width, groundY);

      drawSun();

      // Дальние большие пирамиды. Ближние маленькие пирамиды убраны, чтобы фон не перегружался.
      const far = -((worldOffset * .10) % 1040);
      for (let i = -1; i < 4; i++) {
        drawPyramid(far + i * 720 + 90, groundY - 42, 390, 235, '#d4a04a');
        drawPyramid(far + i * 720 + 430, groundY - 36, 275, 165, '#c98f35');
      }

      drawDesertGround(1);
    }

    function drawDog() {
      ctx.save();
      ctx.translate(dog.x, dog.y);
      ctx.scale(1.35, 1.35);

      ctx.fillStyle = '#8b4a20';
      roundRect(8, 36, 72, 40, 20); ctx.fill();

      ctx.fillStyle = '#c5864b';
      roundRect(22, 46, 32, 22, 11); ctx.fill();

      ctx.fillStyle = '#8b4a20';
      roundRect(68, 16, 42, 40, 19); ctx.fill();
      ctx.fillStyle = '#b86f35';
      roundRect(86, 36, 39, 20, 10); ctx.fill();

      ctx.fillStyle = '#5f3218';
      roundRect(68, 14, 18, 38, 10); ctx.fill();
      roundRect(54, 18, 16, 40, 10); ctx.fill();

      ctx.fillStyle = '#29b6f6';
      ctx.fillRect(68, 55, 26, 8);
      ctx.fillStyle = '#ffd54f';
      ctx.beginPath(); ctx.arc(82, 68, 5.5, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(94, 29, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#111';
      ctx.beginPath(); ctx.arc(97, 31, 3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(123, 43, 5.5, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = '#3f2415';
      ctx.beginPath(); ctx.ellipse(32, 46, 12, 7, .2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(58, 65, 10, 6, -.2, 0, Math.PI * 2); ctx.fill();

      const lift = dog.onGround ? Math.sin(dog.frame) * 6 : 2;
      ctx.fillStyle = '#6f3b1b';
      roundRect(22, 72, 12, 25 + lift, 6); ctx.fill();
      roundRect(66, 72, 12, 25 - lift, 6); ctx.fill();

      ctx.strokeStyle = '#6f3b1b';
      ctx.lineWidth = 9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(10, 45);
      ctx.quadraticCurveTo(-14, 24, -23, 38);
      ctx.stroke();

      ctx.restore();
    }

    function drawObstacle(o) {
      if (o.type === 'smallPyramid') {
        drawPyramid(o.x, groundY, o.w, o.h, '#c9822c');
        return;
      }

      ctx.fillStyle = '#7c4a23';
      roundRect(o.x, o.y, o.w, o.h, 10);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.16)';
      roundRect(o.x + 8, o.y + 9, o.w * .45, 8, 4);
      ctx.fill();
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawEgyptBackground();

      for (const o of obstacles) drawObstacle(o);
      drawDog();

      if (gameOver) {
        ctx.fillStyle = 'rgba(15, 23, 42, .72)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.font = '900 58px Arial';
        ctx.fillText('Игра окончена', canvas.width / 2, canvas.height / 2 - 60);
        ctx.font = '800 34px Arial';
        ctx.fillText('Ваш счёт: ' + Math.floor(score) + '  •  Рекорд: ' + best, canvas.width / 2, canvas.height / 2);
        ctx.font = '700 25px Arial';
        ctx.fillText('Нажмите, чтобы начать заново', canvas.width / 2, canvas.height / 2 + 54);
        ctx.textAlign = 'left';
      }
    }

    function update(dt) {
      if (!running || gameOver) return;

      dog.frame += dt * .018 * speed;
      dog.vy += gravity;
      dog.y += dog.vy;
      if (dog.y >= groundY - dog.h) {
        dog.y = groundY - dog.h;
        dog.vy = 0;
        dog.onGround = true;
      }

      nextObstacle -= dt * 0.072;
      if (nextObstacle <= 0) addObstacle();

      const move = speed * dt * 0.076;
      worldOffset += move;
      for (const o of obstacles) o.x -= move;
      obstacles = obstacles.filter(o => o.x + o.w > -40);

      speed += dt * 0.00075;
      score += dt * 0.022;
      scoreEl.textContent = String(Math.floor(score));

      for (const o of obstacles) {
        if (collides(dog, o)) {
          gameOver = true;
          best = Math.max(best, Math.floor(score));
          localStorage.setItem('raffleBotDogBest', String(best));
          bestScoreEl.textContent = String(best);
          break;
        }
      }
    }

    function loop(now) {
      const dt = Math.min(34, now - lastTime);
      lastTime = now;
      update(dt);
      draw();
      requestAnimationFrame(loop);
    }

    jumpBtn.addEventListener('click', jump);
    canvas.addEventListener('pointerdown', jump);
    window.addEventListener('keydown', function (e) {
      if (e.code === 'Space' || e.code === 'ArrowUp') {
        e.preventDefault();
        jump();
      }
    });

    updateOnlineStats();
    setInterval(updateOnlineStats, 15000);
    reset();
    requestAnimationFrame(loop);
  })();
  </script>
  </body>
  </html>`;
  }

  const playOnlineVisitors = new Map();

  function prunePlayOnlineVisitors() {
    const now = Date.now();
    for (const [visitorId, lastSeenAt] of playOnlineVisitors.entries()) {
      if (now - Number(lastSeenAt || 0) > 70_000) {
        playOnlineVisitors.delete(visitorId);
      }
    }
  }

  async function getPlayStats() {
    prunePlayOnlineVisitors();

    let totalPlayers = 0;
    try {
      const res = await pool.query('SELECT COUNT(*)::int AS count FROM users');
      totalPlayers = Number(res.rows?.[0]?.count || 0);
    } catch (error) {
      console.warn('Не удалось получить статистику игроков:', error.message);
    }

    return {
      online: playOnlineVisitors.size,
      total_players: totalPlayers
    };
  }

  app.get('/play/stats', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...(await getPlayStats()) });
  });

  app.post('/play/ping', async (req, res) => {
    const visitorId = safeText(req.body?.visitor_id || req.ip || crypto.randomUUID?.() || crypto.randomBytes(12).toString('hex'), 120);

    if (visitorId) {
      playOnlineVisitors.set(visitorId, Date.now());
    }

    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...(await getPlayStats()) });
  });

  app.get('/play', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(buildPlayGameHtml());
  });

  function isPlayCommand(text) {
    const value = String(text || '').trim().toLowerCase();
    return value === '/play' || value === 'play' || value === 'играть';
  }

  return {
    buildPlayGameUrl,
    sendPlayGameMessage,
    getPlayStats,
    isPlayCommand
  };
}

module.exports = {
  setupPlayModule
};
