import express from "express";
import pg from "pg";
import crypto from "crypto";
import { fal } from "@fal-ai/client";
import { buildHoroscopeFromEngine } from "./horoscopeEngine.js";

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false }));

// Браузеры автоматически запрашивают /favicon.ico.
// Возвращаем 204, чтобы в логах Render не было лишней 404-ошибки.
app.get("/favicon.ico", (_req, res) => res.status(204).end());

const PORT = process.env.PORT || 10000;
const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEBUG_LOGS =
  String(process.env.DEBUG_LOGS || "false").toLowerCase() === "true";

function debugLog(...args) {
  if (DEBUG_LOGS) {
    console.log(...args);
  }
}

const IMAGE_REQUEST_LIMIT = 4; 
const CHATGPT_REQUEST_LIMIT = 8;
const VIDEO_REQUEST_LIMIT = Number(process.env.VIDEO_REQUEST_LIMIT || 5);
const VIDEO_REQUESTS_BEFORE_SUBSCRIPTION = Number(
  process.env.VIDEO_REQUESTS_BEFORE_SUBSCRIPTION || 1
);

// Больше не используем один общий email для всех чеков.
// Email для чека пользователь вводит на странице перед оплатой.
const YOOKASSA_RECEIPT_EMAIL =
  String(process.env.YOOKASSA_RECEIPT_EMAIL || "").trim();

const YOOKASSA_VAT_CODE = Number(process.env.YOOKASSA_VAT_CODE || 1);
const YOOKASSA_TAX_SYSTEM_CODE = process.env.YOOKASSA_TAX_SYSTEM_CODE
  ? Number(process.env.YOOKASSA_TAX_SYSTEM_CODE)
  : undefined;

const PREMIUM_IMAGE_REQUEST_LIMIT = Number(process.env.PREMIUM_IMAGE_REQUEST_LIMIT || 15);
const PREMIUM_CHATGPT_REQUEST_LIMIT = Number(process.env.PREMIUM_CHATGPT_REQUEST_LIMIT || 20);
// Ежедневный Premium-лимит для «оживить фото / видео по фото».
// Это НЕ бонусный накопительный кредит: лимит обновляется каждый день.
const PREMIUM_VIDEO_REQUEST_LIMIT = Number(process.env.PREMIUM_VIDEO_REQUEST_LIMIT || 1);
const PREMIUM_DURATION_DAYS = Number(process.env.PREMIUM_DURATION_DAYS || 30);
const PREMIUM_PRICE_RUB = process.env.PREMIUM_PRICE_RUB || "299.00";
const PREMIUM_RAFFLE_ENABLED =
  String(process.env.PREMIUM_RAFFLE_ENABLED || "true").toLowerCase() !== "false";
const PREMIUM_RAFFLE_START_AT =
  process.env.PREMIUM_RAFFLE_START_AT || "2026-06-10T00:00:00+03:00";
const PREMIUM_RAFFLE_END_AT =
  process.env.PREMIUM_RAFFLE_END_AT || "2026-09-10T23:59:59+03:00";
const PREMIUM_RAFFLE_RULES_URL =
  String(process.env.PREMIUM_RAFFLE_RULES_URL || "").trim();


const PREMIUM_BONUS_VIDEO_CREDITS = 0; // Premium больше не дает бонусы на «оживить фото / видео по фото».
const PREMIUM_BONUS_PROMPT_VIDEO_CREDITS = Number(process.env.PREMIUM_BONUS_PROMPT_VIDEO_CREDITS || 1);
const PREMIUM_BONUS_PRODUCT_CARD_CREDITS = Number(process.env.PREMIUM_BONUS_PRODUCT_CARD_CREDITS || 1);
const PREMIUM_BONUS_MUSIC_CREDITS = Number(process.env.PREMIUM_BONUS_MUSIC_CREDITS || 1);
const PRODUCT_CARD_PRICE_RUB = process.env.PRODUCT_CARD_PRICE_RUB || "79.00";
const PRODUCT_CARD_PRODUCT_CODE = "product_card";
const PRODUCT_CARD_IMAGES_COUNT = Number(process.env.PRODUCT_CARD_IMAGES_COUNT || 3);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_API_BASE =
  process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta";

const GEMINI_LYRIA_MODEL =
  process.env.GEMINI_LYRIA_MODEL || "lyria-3-clip-preview";

const MUSIC_PRICE_RUB = process.env.MUSIC_PRICE_RUB || "69.00";
const MUSIC_PRODUCT_CODE = "music_track";

const MENU_CREATE_MUSIC_PAYLOAD = "menu_create_music";
const IMAGE_MODE_MUSIC = "music";


const FAL_KEY = process.env.FAL_KEY || "";

fal.config({
  credentials: FAL_KEY
});

const FAL_SEEDANCE_IMAGE_TO_VIDEO_URL =
  process.env.FAL_SEEDANCE_IMAGE_TO_VIDEO_URL ||
  "https://queue.fal.run/fal-ai/bytedance/seedance/v1/lite/image-to-video";

const FAL_SEEDANCE_TEXT_TO_VIDEO_URL =
  process.env.FAL_SEEDANCE_TEXT_TO_VIDEO_URL ||
  "https://queue.fal.run/fal-ai/bytedance/seedance/v1/lite/text-to-video";

const CREATE_VIDEO_MODEL =
  process.env.CREATE_VIDEO_MODEL ||
  "https://queue.fal.run/fal-ai/kling-video/v2.5-turbo/standard/image-to-video";

const CREATE_VIDEO_URL =
  process.env.CREATE_VIDEO_URL ||
  `https://queue.fal.run/${CREATE_VIDEO_MODEL}`;

const FAL_QUEUE_TIMEOUT_MS = Number(process.env.FAL_QUEUE_TIMEOUT_MS || 8 * 60_000);
const FAL_QUEUE_POLL_INTERVAL_MS = Number(process.env.FAL_QUEUE_POLL_INTERVAL_MS || 2500);

const VIDEO_PRICE_RUB = process.env.VIDEO_PRICE_RUB || "59.00";
const VIDEO_PRODUCT_CODE = "photo_animation_video";

const PROMPT_VIDEO_PRICE_RUB = process.env.PROMPT_VIDEO_PRICE_RUB || "69.00";
const PROMPT_VIDEO_PRODUCT_CODE = "prompt_video";

const FAMILY_VIDEO_PRICE_RUB =
  process.env.FAMILY_VIDEO_PRICE_RUB || "99.00";

const FAMILY_VIDEO_PRODUCT_CODE = "family_photo_animation_video";
const VIDEO_EXAMPLE_URL =
  process.env.VIDEO_EXAMPLE_URL ||
  "https://v3b.fal.media/files/b/0a99ceed/sKwSVXJ_V6BPPPlDOLfNH_output.mp4";

const VIDEO_EXAMPLE_MAX_TOKEN = process.env.VIDEO_EXAMPLE_MAX_TOKEN || "";

const FAMILY_VIDEO_EXAMPLE_URL =
  process.env.FAMILY_VIDEO_EXAMPLE_URL ||
  "https://v3b.fal.media/files/b/0a99ceed/sKwSVXJ_V6BPPPlDOLfNH_output.mp4";

const FAMILY_VIDEO_EXAMPLE_MAX_TOKEN =
  process.env.FAMILY_VIDEO_EXAMPLE_MAX_TOKEN || "";

const PROMPT_VIDEO_EXAMPLE_URL =
  process.env.PROMPT_VIDEO_EXAMPLE_URL ||
  "https://v3b.fal.media/files/b/0a99ceed/sKwSVXJ_V6BPPPlDOLfNH_output.mp4";

const PROMPT_VIDEO_EXAMPLE_MAX_TOKEN =
  process.env.PROMPT_VIDEO_EXAMPLE_MAX_TOKEN || "";

let cachedVideoExampleToken = VIDEO_EXAMPLE_MAX_TOKEN;
let videoExampleTokenPromise = null;

let cachedFamilyVideoExampleToken = FAMILY_VIDEO_EXAMPLE_MAX_TOKEN;
let familyVideoExampleTokenPromise = null;

let cachedPromptVideoExampleToken = PROMPT_VIDEO_EXAMPLE_MAX_TOKEN;
let promptVideoExampleTokenPromise = null;

const IMAGE_MODE_VIDEO = "video_animation";
const IMAGE_MODE_PROMPT_VIDEO = "prompt_video";
const IMAGE_MODE_FAMILY_VIDEO = "family_video_animation";
const VIDEO_MODE_FAMILY_PAYMENT = "family";

const VIDEO_ANIMATE_PHOTO_PROMPT = `Animate this photo into a realistic video with strict identity preservation.

Keep every visible person exactly the same as in the original photo:
same face, same skin texture, same age, same proportions, same unique facial details.
No beautification, no stylization, no face alteration.

Motion:
natural blinking, gentle breathing, very slight head movement, and a very subtle natural smile.
The person should look directly at the viewer/camera.
If there are visible people in the photo, they should gently and naturally wave toward the viewer/camera, as if greeting us.
The hand wave must be small, smooth, realistic, and anatomically correct.
Facial expression should remain calm, warm, and natural.

Style:
ultra-realistic, natural skin texture, realistic motion, portrait realism.

Camera:
fixed camera, no camera shake, shallow depth of field.

Avoid:
any facial changes, makeup, skin smoothing, exaggerated motion, strong expressions, distorted hands, distorted body proportions, looking away from the camera, AI artifacts.

The final result must look like real footage of the same person from the original image, maintaining direct eye contact with the viewer, a soft natural smile, and subtle realistic waving.`;

const FAMILY_VIDEO_PROMPT = `Создай реалистичное видео по загруженному фото. Я сижу на стадионе среди зрителей, в той же позе и в той же обстановке, как на фото. Камера неподвижна, стоит на месте, без поворотов, без приближений, без тряски и без движения. Никакого slow motion — движение только в обычной естественной скорости. Сохрани моё лицо максимально точно, 1 в 1 как на оригинальном фото. Не изменяй надписи, табло, логотипы и весь текст, который уже есть в кадре. Сохрани атмосферу стадиона, синие сиденья, зрителей вокруг и общий ракурс как на фото. Я спокойно сижу с обьектом как на фото, а в кадре ощущение, будто меня снимает стадионная камера во время матча. Видео должно быть реалистичным, естественным и максимально похожим на оригинальный кадр.я немного трогаю свои волосы`;

const TREND_MONTH_VIDEO_PROMPT = `Создай реалистичное видео по загруженному фото. Я сижу на стадионе среди зрителей, в той же позе и в той же обстановке, как на фото. Камера неподвижна, стоит на месте, без поворотов, без приближений, без тряски и без движения. Никакого slow motion — движение только в обычной естественной скорости. Сохрани моё лицо максимально точно, 1 в 1 как на оригинальном фото. Не изменяй надписи, табло, логотипы и весь текст, который уже есть в кадре. Сохрани атмосферу стадиона, синие сиденья, зрителей вокруг и общий ракурс как на фото. Я спокойно сижу с обьектом как на фото, а в кадре ощущение, будто меня снимает стадионная камера во время матча. Видео должно быть реалистичным, естественным и максимально похожим на оригинальный кадр.`;

const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || "";
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || "";
const YOOKASSA_API_BASE = process.env.YOOKASSA_API_BASE || "https://api.yookassa.ru/v3";

const APP_PUBLIC_URL = String(
  process.env.APP_PUBLIC_URL || process.env.PUBLIC_URL || ""
).replace(/\/+$/, "");

const APP_PUBLIC_ORIGIN = APP_PUBLIC_URL || "";

function getPremiumRaffleRulesUrl() {
  if (PREMIUM_RAFFLE_RULES_URL) return PREMIUM_RAFFLE_RULES_URL;
  if (APP_PUBLIC_ORIGIN) return `${APP_PUBLIC_ORIGIN}/promo`;
  return "/promo";
}

const WORKER_MAKE_VIDEO_URL = process.env.WORKER_MAKE_VIDEO_URL || "";

const ALICE_AI_FREE_URL =
  process.env.ALICE_AI_FREE_URL ||
  "https://redirect.appmetrica.yandex.com/serve/750435175153844646?clid=15053682&appmetrica_js_redirect=0";

const PHOTO_READY_LINK_URL =
  process.env.PHOTO_READY_LINK_URL || "https://max.ru/id236700415542_bot";
const PHOTO_READY_LINK_TEXT = `[Готово.](${PHOTO_READY_LINK_URL})`;

// После этих значений нужна подписка
const IMAGE_REQUESTS_BEFORE_SUBSCRIPTION = Number(
  process.env.IMAGE_REQUESTS_BEFORE_SUBSCRIPTION || 1
);

const CHATGPT_REQUESTS_BEFORE_SUBSCRIPTION = Number(
  process.env.CHATGPT_REQUESTS_BEFORE_SUBSCRIPTION || 2
);

// Каналы MAX, на которые нужна обязательная подписка
const REQUIRED_CHANNELS = [
  {
    id: process.env.REQUIRED_CHANNEL_ID || "-73970192098593",
    url: process.env.REQUIRED_CHANNEL_URL || "https://max.ru/id503501079307_1_bot?startapp=TLb08ea5db5d65",
    title: "Наш Канал"
  },
  {
    id: process.env.REQUIRED_CHANNEL_ID_2 || "-72952296540698",
    url: process.env.REQUIRED_CHANNEL_URL_2 || "https://max.ru/id503501079307_1_bot?startapp=TL933fea837501",
    title: "Канал 2"
  },
  {
    id: process.env.REQUIRED_CHANNEL_ID_3 || "-74290803017086",
    url: process.env.REQUIRED_CHANNEL_URL_3 || "https://max.ru/id503501079307_1_bot?startapp=TL35c6e5db6065",
    title: "Канал 3"
  }
].filter((channel) => channel.id);

// Payload кнопки "Проверить"
const SUBSCRIPTION_CHECK_PAYLOAD = "check_subscription";

// Пейлоады для основного меню
const MENU_CREATE_PHOTO_PAYLOAD = "menu_create_photo";
const MENU_PHOTO_STYLES_PAYLOAD = "menu_photo_styles";
const PHOTO_STYLE_PAYLOAD_PREFIX = "photo_style:";
const IMAGE_MODE_PHOTO_STYLE = "photo_style";
const PHOTO_FORMAT_PAYLOAD_PREFIX = "photo_format:";
const DEFAULT_PHOTO_FORMAT = "square";

const PHOTO_FORMATS = {
  square: {
    button: "⬜ 1:1",
    title: "1:1",
    size: "1024x1536",
    promptSuffix:
      "Composition format: square 1:1 image. Centered framing, balanced composition, keep the main subject fully visible, avoid cropping faces, hands, text, logos or important objects."
  },
  phone: {
    button: "📱",
    title: "Телефон",
    size: "1024x1536",
    promptSuffix:
      "Composition format: vertical portrait smartphone image. Full-height composition, keep the main subject fully visible, avoid cropping head, legs, hands, clothing, text, logos or important objects. Suitable for phone screen, stories and vertical posts."
  },
  desktop: {
    button: "💻",
    title: "Компьютер 16:9",
    size: "1536x1024",
    promptSuffix:
      "Composition format: wide horizontal desktop image. Cinematic landscape framing, keep the main subject and important details fully visible, avoid cropping faces, hands, text, logos or key objects. Suitable for desktop screen and wide posts."
  }
};

const MENU_CREATE_VIDEO_PAYLOAD = "menu_create_video";
const MENU_CREATE_PROMPT_VIDEO_PAYLOAD = "menu_create_prompt_video";
const MENU_CREATE_FAMILY_VIDEO_PAYLOAD = "menu_create_family_video";
const MENU_RESTORE_PHOTO_PAYLOAD = "menu_restore_photo";
const MENU_PREMIUM_PAYLOAD = "menu_premium";
const MENU_SPONSORS_PAYLOAD = "menu_sponsors";
const MENU_BACK_PAYLOAD = "menu_back";
const MENU_PRODUCT_CARD_PAYLOAD = "menu_product_card";
const MENU_HOROSCOPE_PAYLOAD = "menu_horoscope";
const MENU_EARN_PAYLOAD = "menu_earn";
const EARN_WITHDRAW_PAYLOAD = "earn_withdraw";
const REFERRAL_START_PREFIX = "ref_";
const REFERRAL_REWARD_KOPECKS = Number(process.env.REFERRAL_REWARD_KOPECKS || 200); // 2 рубля
const REFERRAL_MIN_WITHDRAW_KOPECKS = Number(process.env.REFERRAL_MIN_WITHDRAW_KOPECKS || 50000); // 500 рублей
const REFERRAL_BASE_URL = String(
  process.env.REFERRAL_BASE_URL ||
    process.env.MAX_BOT_REFERRAL_URL ||
    process.env.MAX_BOT_PUBLIC_URL ||
    ""
).replace(/\/+$/, "");
const HOROSCOPE_PROFILE_PAYLOAD = "horoscope_profile";
const HOROSCOPE_START_PAYLOAD = "horoscope_start";
const HOROSCOPE_YES_NO_PAYLOAD = "horoscope_yes_no";
const IMAGE_MODE_HOROSCOPE_YES_NO = "horoscope_yes_no";

const PAYMENT_EMAIL_PAYLOAD_PREFIX = "payment_email:";
const PAYMENT_PRODUCT_PREMIUM = "premium";
const PAYMENT_PRODUCT_PRODUCT_CARD = "product_card";
const PAYMENT_PRODUCT_MUSIC = "music";
const PAYMENT_PRODUCT_PROMPT_VIDEO = "prompt_video";
const PAYMENT_PRODUCT_VIDEO = "video";
const PAYMENT_PRODUCT_FAMILY_VIDEO = "family_video";
const PAYMENT_EMAIL_STATE_TTL_MS = Number(
  process.env.PAYMENT_EMAIL_STATE_TTL_MS || 10 * 60_000
);

// Сюда вставишь свои ссылки на картинки
const HOROSCOPE_YES_NO_START_IMAGE_URL =
  process.env.HOROSCOPE_YES_NO_START_IMAGE_URL || "https://v3b.fal.media/files/b/0a9bab2a/f4Rr83z7xmVK23xbHWM2Z_pBaBitRH.jpg";

const HOROSCOPE_YES_IMAGE_URL =
  process.env.HOROSCOPE_YES_IMAGE_URL || "https://v3b.fal.media/files/b/0a9bab38/1Isll4-t3K6nko9IV2JtI_dmtNLaKy.jpg";

const HOROSCOPE_NO_IMAGE_URL =
  process.env.HOROSCOPE_NO_IMAGE_URL || "https://v3b.fal.media/files/b/0a9bab40/xuiMhQk22zOFO8hMk54L7_VnDLF22m.jpg";
const HOROSCOPE_TODAY_PAYLOAD = "horoscope_today";
const HOROSCOPE_TOMORROW_PAYLOAD = "horoscope_tomorrow";
const HOROSCOPE_DAILY_ENABLE_PAYLOAD = "horoscope_daily_enable";
const HOROSCOPE_DAILY_DISABLE_PAYLOAD = "horoscope_daily_disable";
const HOROSCOPE_TIME_PAYLOAD_PREFIX = "horoscope_time:";


const IMAGE_MODE_RESTORATION = "restoration";
const IMAGE_MODE_PRODUCT_CARD = "product_card";

const RESTORATION_PROMPT = `Реставрируй старую фотографию максимально аккуратно и реалистично.

Главная задача: улучшить качество изображения, сохранив оригинал без изменений личности людей, черт лица, пропорций, возраста, формы глаз, носа, губ, мимики, причёски, одежды, поз, композиции и фона.

Сохрани все лица 1:1. Не изменяй выражения лиц, не омолаживай, не делай людей красивее, не добавляй новые черты, не меняй форму головы, глаз, носа, рта, ушей и подбородка.

Сохрани все надписи, буквы, цифры, документы, вывески и текст на фото без искажений. Не переписывай текст заново, не заменяй буквы, не добавляй новые символы, не исправляй надписи творчески. Если текст плохо читается, оставь его максимально близким к оригиналу.

Убери пыль, царапины, пятна, заломы, трещины, шум, следы старения бумаги и мелкие повреждения. Восстанови потерянные участки только там, где это очевидно по соседним деталям. Не придумывай новые объекты.

Улучши резкость, контраст, детализацию и тональный баланс мягко, без чрезмерной обработки. Сохрани естественную текстуру старой фотографии, зерно плёнки и исторический характер снимка. Не делай фото пластиковым, глянцевым или похожим на современную AI-фотографию.

Если фотография чёрно-белая — оставь её чёрно-белой, если не указано иное. Если фотография цветная — восстанови естественные приглушённые цвета без перенасыщения.

Финальный результат: реалистичная реставрация архивного фото, чистое изображение, сохранённые лица и надписи, без изменения оригинальной сцены.`;

const PHOTO_STYLES = {
  lego: {
    button: "🧱 ЛЕГО",
    title: "ЛЕГО",
    prompt:
      "Turn the person in the photo into a block-toy minifigure version of the same character, keep the face clearly recognizable and close to the original, with toy-style hair and toy-style clothing, smooth plastic texture, simple minifigure proportions, playful colorful block background, clean toy photography look, no text, no logos."
  },
  cartoon: {
    button: "🈳 ОРИГАМИ",
    title: "Стань Оригами🈳",
    prompt:
      "1×1 square, ultra-detailed render of a box-shaped papertoy version of [person at the photo]. Made from folded and cut matte cardstock with visible paper texture, crisp edges, and clean folds. Cubic head and body, blocky limbs, simplified facial features, flat printed colors, and subtle shading for depth. Clothing and accessories faithfully mimic [CHARACTER NAME]’s iconic look in a minimal geometric papercraft style, keeping proportions compact and chibi-like. Neutral studio lighting, soft shadows, plain background, photorealistic product photography, 4K, no text or logos."
  },
  summer: {
    button: "☀️ ЛЕТНЕЕ",
    title: "ЛЕТО И ШАШЛЫК",
    prompt:
      "Transform this photo into a realistic outdoor summer cookout scene with a warm sunset atmosphere. The person is casually dressed and cooking skewers on a charcoal grill in a cozy backyard setting. Natural lighting, photorealistic style, realistic anatomy, detailed textures, cinematic color grading, high-quality photography, 1:1 aspect ratio."
  },
lemonade: {
  button: "🎎 ЗАМЕНА",
  title: "🎎ЗАМЕНА ЧЕЛОВЕКА",
  prompt:
    "Заменить человека на изображении (Фото 1) на человека с Фото 2. Полностью сохранить исходную сцену, фон, освещение, перспективу, позу и композицию кадра. Лицо человека с Фото 2 перенести без изменений, без искажений черт лица, без изменения формы головы и мимики. Сохранить естественные пропорции тела. Адаптировать цвет кожи, освещение и тени так, чтобы человек выглядел гармонично и реалистично в сцене. Не изменять стиль изображения. Без артефактов, без деформаций, без эффекта «пластика», максимально фотореалистично."
},
  queen: {
    button: "👑 ЦАРИЦА",
    title: "ЦАРИЦА",
    prompt:
      "Transform the person into a royal queen portrait, elegant crown, luxurious royal dress, palace-inspired background, cinematic lighting, noble posture, keep the same face and identity."
  },
  space: {
    button: "🚀 ДЖЕДАЙ",
    title: "ДЖЕДАЙ",
    prompt:
      "Edit my photo into a realistic cinematic Star Wars portrait. Preserve my face and identity exactly 1:1 with maximum fidelity: same facial features, same skin tone, same hairstyle, same likeness, no changes to identity. Dress me in detailed Jedi-style Star Wars clothing and place a glowing lightsaber in my hand, any color. Make it ultra-realistic, cinematic, dramatic lighting, premium sci-fi atmosphere, realistic hands, realistic face, sharp detail, epic movie still. Square 1:1 composition, centered framing, clean galactic background. Do not distort the face, hands, or body."
  },
  suit: {
    button: "🤵 В КОСТЮМЕ",
    title: "В КОСТЮМЕ",
    prompt:
      "Edit the photo into a stylish formal portrait: dress the person in a modern tailored suit, create a clean studio or office-like background with soft professional lighting, confident natural pose, and preserve the same face, hairstyle, and identity with high accuracy."
  },
  cyberpunk: {
    button: "🧸 МОИ СТИКЕРЫ",
    title: "НАБОР СТИКЕРОВ",
    prompt:
      "Create a 4x4 cute cartoon sticker sheet using the uploaded photo as the only identity reference. Keep the same face, eyes, hairstyle, age and overall appearance in all 16 stickers. Style: modern kawaii Telegram stickers, soft pastel colors, clean rounded outlines, glossy eyes, subtle blush, white sticker border, soft shadow, warm off-white background, centered bust portraits, neat spacing. Only one text element: Russian header «МОИ СТИКЕРЫ» at the top. No captions, no English text, no watermark. Emotions from top-left to bottom-right: happy smile, shy, sleepy, excited, laughing, confused, blushing, proud, crying, cute angry pout, shocked, dramatic, chaotic panic, silly, overreacting, fully unhinged crazy smile."
  },
  fantasy: {
    button: "🎮 ROBLOX",
    title: "ROBLOX",
    prompt:
      "Transform the uploaded photo into a high-quality ROBLOX-style 3D avatar. Preserve the person’s main facial features, hairstyle, outfit, skin tone, and expression, but recreate them as a polished blocky ROBLOX character. Full-body view, clean studio background, premium game-avatar render, smooth plastic-like materials, sharp details, soft lighting, 4K quality. Avoid realism, anime, Pixar style, distorted face, bad proportions, or cropped body."
  },
  restoration: {
    button: "🛠️ Реставрация",
    title: "Реставрация",
    prompt: RESTORATION_PROMPT
  }

};



// Пользователи, которые уже прошли проверку подписки
const subscriptionVerifiedUsers = new Set();

// Сообщение с кнопкой "Я подписан(а)" для каждого пользователя
// key: userId(string) -> messageId(string)
const userSubscriptionMessages = new Map();

const userRequestCounts = {};
const registeredUserCache = new Map();
const REGISTER_USER_CACHE_TTL_MS = Number(
  process.env.REGISTER_USER_CACHE_TTL_MS || 6 * 60 * 60 * 1000
);

function shouldRegisterBotUser(userId) {
  const key = String(userId || "").trim();

  if (!isValidUserIdForBroadcast(key)) {
    return false;
  }

  const now = Date.now();
  const lastRegisteredAt = registeredUserCache.get(key) || 0;

  if (now - lastRegisteredAt < REGISTER_USER_CACHE_TTL_MS) {
    return false;
  }

  registeredUserCache.set(key, now);
  return true;
}

const userImageModes = new Map();
const userPhotoStyles = new Map();
const userPhotoFormats = new Map();

const userReplacementDrafts = new Map();

const REPLACEMENT_DRAFT_TTL_MS = Number(
  process.env.REPLACEMENT_DRAFT_TTL_MS || 10 * 60_000
);

function getReplacementDraft(userId) {
  const key = String(userId || "unknown");
  const draft = userReplacementDrafts.get(key);

  if (!draft) {
    return {
      images: [],
      userText: "",
      createdAt: Date.now()
    };
  }

  if (Date.now() - Number(draft.createdAt || 0) > REPLACEMENT_DRAFT_TTL_MS) {
    userReplacementDrafts.delete(key);

    return {
      images: [],
      userText: "",
      createdAt: Date.now()
    };
  }

  return {
    images: Array.isArray(draft.images) ? draft.images.filter(Boolean) : [],
    userText: String(draft.userText || ""),
    createdAt: Number(draft.createdAt || Date.now())
  };
}

function setReplacementDraft(userId, images, userText = "") {
  const key = String(userId || "unknown");

  userReplacementDrafts.set(key, {
    images: Array.isArray(images) ? images.filter(Boolean).slice(0, 2) : [],
    userText: String(userText || "").trim(),
    createdAt: Date.now()
  });
}

function clearReplacementDraft(userId) {
  userReplacementDrafts.delete(String(userId || "unknown"));
}

function setUserPhotoFormat(userId, formatKey) {
  const key = String(userId || "unknown");
  const cleanFormatKey = String(formatKey || "").trim();

  if (!PHOTO_FORMATS[cleanFormatKey]) {
    userPhotoFormats.set(key, DEFAULT_PHOTO_FORMAT);
    return DEFAULT_PHOTO_FORMAT;
  }

  userPhotoFormats.set(key, cleanFormatKey);
  return cleanFormatKey;
}

function getUserPhotoFormat(userId) {
  const key = String(userId || "unknown");
  const formatKey = userPhotoFormats.get(key) || DEFAULT_PHOTO_FORMAT;

  return PHOTO_FORMATS[formatKey] ? formatKey : DEFAULT_PHOTO_FORMAT;
}

function clearUserPhotoFormat(userId) {
  userPhotoFormats.delete(String(userId || "unknown"));
}

function buildPromptWithPhotoFormat(userText, userId) {
  const cleanText = String(userText || "").trim();

  if (!cleanText) {
    return "";
  }

  const formatKey = getUserPhotoFormat(userId);
  const format = PHOTO_FORMATS[formatKey];

  if (!format?.promptSuffix) {
    return cleanText;
  }

  return [
    cleanText,
    "",
    "Selected image format instruction:",
    format.promptSuffix
  ].join("\n");
}

function getPhotoFormatImageOptions(userId) {
  const formatKey = getUserPhotoFormat(userId);
  const format = PHOTO_FORMATS[formatKey];

  if (!format?.size) {
    return {};
  }

  return {
    size: format.size
  };
}

function setUserPhotoStyle(userId, styleKey) {
  const key = String(userId || "unknown");

  if (!PHOTO_STYLES[styleKey]) {
    userPhotoStyles.delete(key);
    return;
  }

  userPhotoStyles.set(key, styleKey);
  clearUserPhotoFormat(userId);
  setUserImageMode(userId, IMAGE_MODE_PHOTO_STYLE);
}

function getUserPhotoStyle(userId) {
  return userPhotoStyles.get(String(userId || "unknown")) || "";
}

function clearUserPhotoStyle(userId) {
  userPhotoStyles.delete(String(userId || "unknown"));
}

function isPhotoStyleMode(userId) {
  return getUserImageMode(userId) === IMAGE_MODE_PHOTO_STYLE;
}

function buildPhotoStylePrompt(styleKey, userText = "") {
  const style = PHOTO_STYLES[styleKey];

  if (!style) {
    return "";
  }

  const extraUserText = String(userText || "").trim();

  if (styleKey === "lemonade") {
    return `
Use the uploaded images as references.

Selected mode:
${style.prompt}

User extra wishes:
${extraUserText || "No extra wishes."}

Strict requirements for person replacement:
- Photo 1 is the source scene: keep the original background, lighting, perspective, pose, composition, camera angle and image style;
- Photo 2 is the identity reference: replace the person in Photo 1 with the person from Photo 2;
- preserve the face from Photo 2 exactly, without changing facial features, head shape, expression, age or identity;
- keep natural body proportions and realistic anatomy;
- adapt skin tone, shadows, lighting and color grading so the new person fits naturally into the original scene;
- do not change the background or overall style of Photo 1;
- no artifacts, no deformations, no plastic skin, no face morphing, no extra fingers, no broken hands;
- final result must be maximally photorealistic.
`.trim();
  }

  return `
Use the input photo as the main reference.

Apply selected style:
${style.prompt}

User extra wishes:
${extraUserText || "No extra wishes."}

Strict requirements:
- preserve the same person from the input photo;
- keep face identity recognizable;
- keep age, facial structure, skin tone, hairstyle and key details close to the original;
- do not change the person into someone else;
- do not add random text, logos or watermarks;
- final result must be a polished square 1:1 image.
`.trim();
}

const userFamilyVideoDrafts = new Map();
const userEarnWithdrawStates = new Map();
const paymentEmailStates = new Map();
const FAMILY_VIDEO_DRAFT_TTL_MS = Number(
  process.env.FAMILY_VIDEO_DRAFT_TTL_MS || 20 * 60_000
);

function getFamilyVideoDraft(userId) {
  const key = String(userId || "unknown");
  const draft = userFamilyVideoDrafts.get(key);

  if (!draft) return null;

  if (Date.now() - draft.createdAt > FAMILY_VIDEO_DRAFT_TTL_MS) {
    userFamilyVideoDrafts.delete(key);
    return null;
  }

  return draft;
}

function setFamilyVideoDraft(userId, startImage) {
  const key = String(userId || "unknown");

  userFamilyVideoDrafts.set(key, {
    startImage,
    createdAt: Date.now()
  });
}

function clearFamilyVideoDraft(userId) {
  userFamilyVideoDrafts.delete(String(userId || "unknown"));
}

setInterval(() => {
  const now = Date.now();

  for (const [userId, draft] of userFamilyVideoDrafts.entries()) {
    if (now - draft.createdAt > FAMILY_VIDEO_DRAFT_TTL_MS) {
      userFamilyVideoDrafts.delete(userId);
    }
  }
}, 10 * 60_000).unref?.();

function setUserImageMode(userId, mode) {
  userImageModes.set(String(userId || "unknown"), mode);
}

function getUserImageMode(userId) {
  return userImageModes.get(String(userId || "unknown")) || "";
}

function clearUserImageMode(userId) {
  const key = String(userId || "unknown");

  userImageModes.delete(key);
  userPhotoStyles.delete(key);
  userReplacementDrafts.delete(key);
  userPhotoFormats.delete(key);
  clearPaymentEmailState(userId);
}

function isRestorationMode(userId) {
  return getUserImageMode(userId) === IMAGE_MODE_RESTORATION;
}


function isProductCardMode(userId) {
  return getUserImageMode(userId) === IMAGE_MODE_PRODUCT_CARD;
}

function isHoroscopeYesNoMode(userId) {
  return getUserImageMode(userId) === IMAGE_MODE_HOROSCOPE_YES_NO;
}

function buildHoroscopeBackButtonKeyboard() {
  return [
    [
      {
        type: "callback",
        text: "⬅️ Назад к гороскопу",
        payload: MENU_HOROSCOPE_PAYLOAD
      }
    ]
  ];
}

const HOROSCOPE_DEFAULT_PUBLISH_TIME_MSK = String(
  process.env.HOROSCOPE_DEFAULT_PUBLISH_TIME_MSK || "08:00"
).trim();

const HOROSCOPE_FREE_BUTTON_LIMIT_PER_DAY = Number(
  process.env.HOROSCOPE_FREE_BUTTON_LIMIT_PER_DAY || 1
);

const HOROSCOPE_PREMIUM_BUTTON_LIMIT_PER_DAY = Number(
  process.env.HOROSCOPE_PREMIUM_BUTTON_LIMIT_PER_DAY || 2
);

// Fallback, если БД недоступна
const horoscopeButtonUsageMemory = new Map();

const HOROSCOPE_BUTTON_USAGE_KEY = "horoscope_forecast";
const HOROSCOPE_DAILY_POLL_MS = Number(
  process.env.HOROSCOPE_DAILY_POLL_MS || 60_000
);
const HOROSCOPE_DB_CLEANUP_MS = Number(
  process.env.HOROSCOPE_DB_CLEANUP_MS || 6 * 60 * 60 * 1000
);
const HOROSCOPE_FETCH_TIMEOUT_MS = Number(
  process.env.HOROSCOPE_FETCH_TIMEOUT_MS || 12_000
);
const HOROSCOPE_SOURCE_URL =
  process.env.HOROSCOPE_SOURCE_URL || "https://aztro.sameerkumar.website/";

const HOROSCOPE_SIGNS = {
  aries: {
    ru: "Овен",
    dateRange: "21 марта — 19 апреля"
  },
  taurus: {
    ru: "Телец",
    dateRange: "20 апреля — 20 мая"
  },
  gemini: {
    ru: "Близнецы",
    dateRange: "21 мая — 20 июня"
  },
  cancer: {
    ru: "Рак",
    dateRange: "21 июня — 22 июля"
  },
  leo: {
    ru: "Лев",
    dateRange: "23 июля — 22 августа"
  },
  virgo: {
    ru: "Дева",
    dateRange: "23 августа — 22 сентября"
  },
  libra: {
    ru: "Весы",
    dateRange: "23 сентября — 22 октября"
  },
  scorpio: {
    ru: "Скорпион",
    dateRange: "23 октября — 21 ноября"
  },
  sagittarius: {
    ru: "Стрелец",
    dateRange: "22 ноября — 21 декабря"
  },
  capricorn: {
    ru: "Козерог",
    dateRange: "22 декабря — 19 января"
  },
  aquarius: {
    ru: "Водолей",
    dateRange: "20 января — 18 февраля"
  },
  pisces: {
    ru: "Рыбы",
    dateRange: "19 февраля — 20 марта"
  }
};

const horoscopeSetupStates = new Map();
// Бесплатные профили гороскопа НЕ пишем в БД: держим только во временной памяти.
const horoscopeProfilesMemory = new Map();
const HOROSCOPE_FREE_PROFILE_TTL_MS = Number(
  process.env.HOROSCOPE_FREE_PROFILE_TTL_MS || 24 * 60 * 60 * 1000
);
let horoscopeDailyPublisherStarted = false;
let horoscopeDailyPublisherRunning = false;

function getHoroscopeMemoryProfile(userId) {
  const key = getUserRequestKey(userId);
  const entry = horoscopeProfilesMemory.get(key);

  if (!entry) return null;

  const expiresAt = Number(entry.expiresAt || 0);

  if (expiresAt && Date.now() > expiresAt) {
    horoscopeProfilesMemory.delete(key);
    return null;
  }

  return normalizeHoroscopeProfile(entry.profile || entry);
}

function setHoroscopeMemoryProfile(userId, profile) {
  const key = getUserRequestKey(userId);
  const normalizedProfile = normalizeHoroscopeProfile({
    ...profile,
    user_id: key,
    bot_key: BOT_KEY,
    daily_enabled: false,
    last_sent_date: null
  });

  horoscopeProfilesMemory.set(key, {
    profile: normalizedProfile,
    expiresAt: Date.now() + HOROSCOPE_FREE_PROFILE_TTL_MS
  });

  return normalizedProfile;
}

function deleteHoroscopeMemoryProfile(userId) {
  horoscopeProfilesMemory.delete(getUserRequestKey(userId));
}

setInterval(() => {
  const now = Date.now();

  for (const [userId, entry] of horoscopeProfilesMemory.entries()) {
    if (Number(entry?.expiresAt || 0) <= now) {
      horoscopeProfilesMemory.delete(userId);
    }
  }
}, 60 * 60_000).unref?.();

function getHoroscopeStateKey(userId) {
  return String(userId || "unknown");
}

function setHoroscopeSetupState(userId, state) {
  horoscopeSetupStates.set(getHoroscopeStateKey(userId), {
    ...state,
    updatedAt: Date.now()
  });
}

function getHoroscopeSetupState(userId) {
  const key = getHoroscopeStateKey(userId);
  const state = horoscopeSetupStates.get(key);

  if (!state) return null;

  const ttlMs = Number(process.env.HOROSCOPE_SETUP_TTL_MS || 20 * 60_000);

  if (Date.now() - Number(state.updatedAt || 0) > ttlMs) {
    horoscopeSetupStates.delete(key);
    return null;
  }

  return state;
}

function clearHoroscopeSetupState(userId) {
  horoscopeSetupStates.delete(getHoroscopeStateKey(userId));
}

function sanitizeHoroscopeName(value) {
  return String(value || "")
    .replace(/[\r\n*_`[\]()~>#+\-=|{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function normalizeHoroscopeDateValue(value) {
  if (!value) return "";

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

function parseBirthDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})[.\-/\s](\d{1,2})[.\-/\s](\d{4})$/);

  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const currentYear = new Date().getUTCFullYear();

  if (year < 1900 || year > currentYear || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    iso: date.toISOString().slice(0, 10),
    day,
    month,
    year
  };
}

function getZodiacSignByDate(day, month) {
  const mmdd = month * 100 + day;

  if (mmdd >= 321 && mmdd <= 419) return "aries";
  if (mmdd >= 420 && mmdd <= 520) return "taurus";
  if (mmdd >= 521 && mmdd <= 620) return "gemini";
  if (mmdd >= 621 && mmdd <= 722) return "cancer";
  if (mmdd >= 723 && mmdd <= 822) return "leo";
  if (mmdd >= 823 && mmdd <= 922) return "virgo";
  if (mmdd >= 923 && mmdd <= 1022) return "libra";
  if (mmdd >= 1023 && mmdd <= 1121) return "scorpio";
  if (mmdd >= 1122 && mmdd <= 1221) return "sagittarius";
  if (mmdd >= 1222 || mmdd <= 119) return "capricorn";
  if (mmdd >= 120 && mmdd <= 218) return "aquarius";
  return "pisces";
}

function getHoroscopeSignRu(sign) {
  return HOROSCOPE_SIGNS[String(sign || "")]?.ru || "не указан";
}

function getHoroscopeSignRange(sign) {
  return HOROSCOPE_SIGNS[String(sign || "")]?.dateRange || "";
}

function formatBirthDateForUser(value) {
  const iso = normalizeHoroscopeDateValue(value);
  if (!iso) return "не указана";

  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

function getMoscowDateYmd(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function getMoscowTimeHHMM(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.hour}:${value.minute}`;
}

function formatYmdRu(ymd) {
  const clean = String(ymd || "").slice(0, 10);
  const match = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) return clean;

  return `${match[3]}.${match[2]}.${match[1]}`;
}

function parsePublishTimeMsk(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})(?::|\.)(\d{2})$/) || text.match(/^(\d{1,2})$/);

  if (!match) return null;

  const hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeHoroscopeProfile(row) {
  if (!row) return null;

  return {
    user_id: String(row.user_id || ""),
    bot_key: String(row.bot_key || BOT_KEY),
    name: sanitizeHoroscopeName(row.name || ""),
    birth_date: normalizeHoroscopeDateValue(row.birth_date),
    zodiac_sign: String(row.zodiac_sign || ""),
    publish_time_msk: parsePublishTimeMsk(row.publish_time_msk) || HOROSCOPE_DEFAULT_PUBLISH_TIME_MSK,
    daily_enabled: Boolean(row.daily_enabled),
    last_sent_date: normalizeHoroscopeDateValue(row.last_sent_date),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

function isHoroscopeProfileComplete(profile) {
  return Boolean(
    profile &&
    sanitizeHoroscopeName(profile.name) &&
    normalizeHoroscopeDateValue(profile.birth_date) &&
    HOROSCOPE_SIGNS[String(profile.zodiac_sign || "")]
  );
}

async function initHoroscopeDb() {
  if (!dbPool) return;

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS max_bot_horoscope_profiles (
      user_id TEXT NOT NULL,
      bot_key TEXT NOT NULL,
      name TEXT,
      birth_date DATE,
      zodiac_sign TEXT,
      publish_time_msk TEXT NOT NULL DEFAULT '08:00',
      daily_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      last_sent_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, bot_key)
    )
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_horoscope_daily
    ON max_bot_horoscope_profiles (bot_key, daily_enabled, publish_time_msk, last_sent_date)
  `);

  await cleanupNonPremiumHoroscopeProfilesFromDb();

  console.log("Horoscope DB initialized: only active Premium horoscope profiles are persisted");
}

async function cleanupNonPremiumHoroscopeProfilesFromDb() {
  if (!dbPool) return 0;

  const result = await dbPool.query(
    `
      DELETE FROM max_bot_horoscope_profiles h
      WHERE h.bot_key = $1
        AND NOT EXISTS (
          SELECT 1
          FROM max_bot_premium_users p
          WHERE p.user_id = h.user_id
            AND p.bot_key = h.bot_key
            AND p.premium_until > NOW()
        )
    `,
    [BOT_KEY]
  );

  return Number(result.rowCount || 0);
}

async function getPersistedPremiumHoroscopeProfile(userId) {
  if (!dbPool) return null;

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      SELECT h.user_id, h.bot_key, h.name, h.birth_date, h.zodiac_sign, h.publish_time_msk,
             h.daily_enabled, h.last_sent_date, h.created_at, h.updated_at
      FROM max_bot_horoscope_profiles h
      INNER JOIN max_bot_premium_users p
        ON p.user_id = h.user_id
       AND p.bot_key = h.bot_key
       AND p.premium_until > NOW()
      WHERE h.user_id = $1 AND h.bot_key = $2
      LIMIT 1
    `,
    [key, BOT_KEY]
  );

  return normalizeHoroscopeProfile(result.rows[0]);
}

async function getHoroscopeProfile(userId) {
  const persistedProfile = await getPersistedPremiumHoroscopeProfile(userId);

  if (persistedProfile) {
    return persistedProfile;
  }

  return getHoroscopeMemoryProfile(userId);
}

async function upsertPersistedPremiumHoroscopeProfile(userId, profileData) {
  if (!dbPool) {
    return setHoroscopeMemoryProfile(userId, profileData);
  }

  const key = getUserRequestKey(userId);
  const profile = normalizeHoroscopeProfile({
    ...profileData,
    user_id: key,
    bot_key: BOT_KEY
  });

  const result = await dbPool.query(
    `
      INSERT INTO max_bot_horoscope_profiles (
        user_id, bot_key, name, birth_date, zodiac_sign, publish_time_msk,
        daily_enabled, last_sent_date
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, $8
      WHERE EXISTS (
        SELECT 1
        FROM max_bot_premium_users p
        WHERE p.user_id = $1
          AND p.bot_key = $2
          AND p.premium_until > NOW()
      )
      ON CONFLICT (user_id, bot_key)
      DO UPDATE SET
        name = EXCLUDED.name,
        birth_date = EXCLUDED.birth_date,
        zodiac_sign = EXCLUDED.zodiac_sign,
        publish_time_msk = EXCLUDED.publish_time_msk,
        daily_enabled = EXCLUDED.daily_enabled,
        last_sent_date = EXCLUDED.last_sent_date,
        updated_at = NOW()
      RETURNING user_id, bot_key, name, birth_date, zodiac_sign, publish_time_msk,
                daily_enabled, last_sent_date, created_at, updated_at
    `,
    [
      key,
      BOT_KEY,
      profile.name || null,
      profile.birth_date || null,
      profile.zodiac_sign || null,
      profile.publish_time_msk || HOROSCOPE_DEFAULT_PUBLISH_TIME_MSK,
      Boolean(profile.daily_enabled),
      profile.last_sent_date || null
    ]
  );

  return normalizeHoroscopeProfile(result.rows[0]);
}

async function upsertHoroscopeProfile(userId, data) {
  const current = (await getHoroscopeProfile(userId)) || {};
  const profile = normalizeHoroscopeProfile({
    ...current,
    user_id: getUserRequestKey(userId),
    bot_key: BOT_KEY,
    ...data
  });

  if (await isPremiumUser(userId)) {
    const persistedProfile = await upsertPersistedPremiumHoroscopeProfile(userId, profile);

    if (persistedProfile) {
      deleteHoroscopeMemoryProfile(userId);
      return persistedProfile;
    }
  }

  // Бесплатных пользователей не сохраняем в БД: профиль живет только 24 часа в памяти процесса.
  return setHoroscopeMemoryProfile(userId, {
    ...profile,
    daily_enabled: false,
    last_sent_date: null
  });
}

async function persistTemporaryHoroscopeProfileForPremiumUser(userId) {
  if (!dbPool) return null;

  const temporaryProfile = getHoroscopeMemoryProfile(userId);

  if (!isHoroscopeProfileComplete(temporaryProfile)) {
    return null;
  }

  const persistedProfile = await upsertPersistedPremiumHoroscopeProfile(userId, {
    ...temporaryProfile,
    daily_enabled: false,
    last_sent_date: null
  });

  if (persistedProfile) {
    deleteHoroscopeMemoryProfile(userId);
  }

  return persistedProfile;
}

async function setHoroscopeDailyEnabled(userId, enabled) {
  const current = (await getHoroscopeProfile(userId)) || {};

  if (enabled && !(await isPremiumUser(userId))) {
    return setHoroscopeMemoryProfile(userId, {
      ...current,
      daily_enabled: false,
      last_sent_date: null
    });
  }

  if (await isPremiumUser(userId)) {
    const persistedProfile = await upsertPersistedPremiumHoroscopeProfile(userId, {
      ...current,
      daily_enabled: Boolean(enabled)
    });

    if (persistedProfile) {
      deleteHoroscopeMemoryProfile(userId);
      return persistedProfile;
    }
  }

  return setHoroscopeMemoryProfile(userId, {
    ...current,
    daily_enabled: false,
    last_sent_date: null
  });
}

function buildHoroscopeMenuButtons(profile, premium) {
  const complete = isHoroscopeProfileComplete(profile);
  const buttons = [
    [
      {
        type: "callback",
        text: "👤 Профиль",
        payload: HOROSCOPE_PROFILE_PAYLOAD
      },
      {
        type: "callback",
        text: complete ? "✏️ Изменить" : "▶️ Начать",
        payload: HOROSCOPE_START_PAYLOAD
      }
    ]
  ];

  buttons.push([
  {
    type: "callback",
    text: "🎱 ДА/НЕТ",
    payload: HOROSCOPE_YES_NO_PAYLOAD
  }
]);

  if (complete) {
    buttons.push([
      {
        type: "callback",
        text: "🔮 Гороскоп на сегодня",
        payload: HOROSCOPE_TODAY_PAYLOAD
      }
    ]);

    // Кнопка "на завтра" видна только Premium-пользователям
    if (premium) {
      buttons.push([
        {
          type: "callback",
          text: "🌙 Гороскоп на завтра",
          payload: HOROSCOPE_TOMORROW_PAYLOAD
        }
      ]);
    }

    buttons.push([
      {
        type: "callback",
        text: profile.daily_enabled
          ? `🔕 Отключить ежедневный прогноз ${profile.publish_time_msk} МСК`
          : `⏰ Ежедневный прогноз ${profile.publish_time_msk} МСК`,
        payload: profile.daily_enabled
          ? HOROSCOPE_DAILY_DISABLE_PAYLOAD
          : HOROSCOPE_DAILY_ENABLE_PAYLOAD
      }
    ]);
  }

  if (!premium) {
    const buyUrl = buildPremiumBuyUrl(profile?.user_id || "");

    if (buyUrl && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY) {
      buttons.push([
        {
          type: "link",
          text: `💳 Купить Premium — ${Number(PREMIUM_PRICE_RUB).toFixed(0)} ₽`,
          url: buyUrl
        }
      ]);

      buttons.push(buildPaymentEmailFallbackRow(PAYMENT_PRODUCT_PREMIUM));
    } else {
      buttons.push([
        {
          type: "callback",
          text: "💵 КУПИТЬ ПРЕМИУМ",
          payload: MENU_PREMIUM_PAYLOAD
        }
      ]);
    }
  }

  buttons.push([
    {
      type: "callback",
      text: "⬅️ Назад к меню",
      payload: MENU_BACK_PAYLOAD
    }
  ]);

  return buttons;
}

async function sendHoroscopeMenu(target, userId) {
  const profile = await getHoroscopeProfile(userId);
  const premium = await isPremiumUser(userId);
  const complete = isHoroscopeProfileComplete(profile);

  let text = [
    "🌙 **Премиум Гороскоп**",
    "",
    "Здесь можно бесплатно заполнить профиль и получить гороскоп на сегодня.",
    "Ежедневная автоматическая отправка прогноза доступна по Premium."
  ].join("\n");

  if (complete) {
    text += [
      "",
      "**Ваш профиль:**",
      `• имя: **${profile.name}**;`,
      `• дата рождения: **${formatBirthDateForUser(profile.birth_date)}**;`,
      `• знак зодиака: **${getHoroscopeSignRu(profile.zodiac_sign)}**;`,
      `• время публикации: **${profile.publish_time_msk} МСК**;`,
      `• ежедневный прогноз: **${profile.daily_enabled ? "включён" : "выключен"}**.`
    ].join("\n");
  } else {
    text += "\n\nПрофиль пока не заполнен. Нажмите **Начать**.";
  }

  return sendMaxMessageWithAttachments(target, text, [
    {
      type: "inline_keyboard",
      payload: {
        buttons: buildHoroscopeMenuButtons(profile || { user_id: userId }, premium)
      }
    }
  ]);
}

async function sendHoroscopeYesNoStart(target, userId) {
  clearHoroscopeSetupState(userId);
  clearFamilyVideoDraft(userId);

  setUserImageMode(userId, IMAGE_MODE_HOROSCOPE_YES_NO);

  const text = [
    "🎱 **ДА / НЕТ**",
    "",
    "Быстрый ответ на твой вопрос.",
    "Хорошо подумай и задай вопрос.",
    "",
    "Важно: в конце вопроса должен быть знак **?**",
    "",
    "Пример:",
    "`Стоит ли мне сегодня начинать новое дело?`"
  ].join("\n");

  return sendMaxImageUrlWithAttachments(
    target,
    text,
    HOROSCOPE_YES_NO_START_IMAGE_URL,
    [
      {
        type: "inline_keyboard",
        payload: {
          buttons: buildHoroscopeBackButtonKeyboard()
        }
      }
    ]
  );
}

async function handleHoroscopeYesNoQuestion(target, userId, userText) {
  if (!isHoroscopeYesNoMode(userId)) {
    return false;
  }

  const text = String(userText || "").trim();

  if (!text) {
    await sendMaxMessageWithAttachments(
      target,
      [
        "⚖️ **ДА / НЕТ**",
        "",
        "Напишите вопрос текстом.",
        "В конце вопроса должен быть знак **?**"
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: buildHoroscopeBackButtonKeyboard()
          }
        }
      ]
    );

    return true;
  }

  if (!text.includes("?")) {
    await sendMaxMessageWithAttachments(
      target,
      [
        "⚖️ **Я жду вопрос**",
        "",
        "Хорошо подумай и задай вопрос со знаком **?**.",
        "",
        "Например:",
        "`Получится ли у меня задуманное?`"
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: buildHoroscopeBackButtonKeyboard()
          }
        }
      ]
    );

    return true;
  }

  const isYes = Math.random() < 0.5;
  const answer = isYes ? "ДА" : "НЕТ";
  const answerImageUrl = isYes ? HOROSCOPE_YES_IMAGE_URL : HOROSCOPE_NO_IMAGE_URL;

  const answerText = [
    `📿 **${answer}**`,
    "",
    "Ответ получен,но точнее скажет личный **гороскоп**",
    "**Можешь попробовать еще или вернуться в гороскоп.**"
  ].join("\n");

  await sendMaxImageUrlWithAttachments(
    target,
    answerText,
    answerImageUrl,
    [
      {
        type: "inline_keyboard",
        payload: {
          buttons: buildHoroscopeBackButtonKeyboard()
        }
      }
    ]
  );

  return true;
}

async function sendHoroscopeProfile(target, userId) {
  const profile = await getHoroscopeProfile(userId);

  if (!isHoroscopeProfileComplete(profile)) {
    return sendMaxMessageWithAttachments(
      target,
      [
        "👤 **Профиль гороскопа**",
        "",
        "Профиль пока не заполнен.",
        "Нажмите **Начать**, укажите дату рождения, имя и время ежедневной публикации по МСК."
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: [
              [
                {
                  type: "callback",
                  text: "▶️ Начать",
                  payload: HOROSCOPE_START_PAYLOAD
                }
              ],
              ...buildBackButtonKeyboard()
            ]
          }
        }
      ]
    );
  }

  const text = [
    "👤 **Профиль гороскопа**",
    "",
    `Имя: **${profile.name}**`,
    `Дата рождения: **${formatBirthDateForUser(profile.birth_date)}**`,
    `Знак зодиака: **${getHoroscopeSignRu(profile.zodiac_sign)}**`,
    `Диапазон знака: ${getHoroscopeSignRange(profile.zodiac_sign)}`,
    `Время публикации: **${profile.publish_time_msk} МСК**`,
    `Ежедневный прогноз: **${profile.daily_enabled ? "включён" : "выключен"}**`,
    "",
    "Гороскоп на сегодня доступен бесплатно. Автоматическая ежедневная отправка работает только при активном Premium."
  ].join("\n");

 const premium = await isPremiumUser(userId);

return sendMaxMessageWithAttachments(target, text, [
  {
    type: "inline_keyboard",
    payload: {
      buttons: buildHoroscopeMenuButtons(profile, premium)
    }
  }
]);
}

async function startHoroscopeSetup(target, userId) {
  clearUserImageMode(userId);
  clearHoroscopeSetupState(userId);

  setHoroscopeSetupState(userId, {
    step: "birth_date",
    draft: {}
  });

  return sendMaxMessageWithAttachments(
    target,
    [
      "🌙 **Настроим гороскоп под вас**",
      "",
      "Сначала напишите полную дату рождения в формате **ДД.ММ.ГГГГ**.",
      "",
      "Пример: `14.08.2001`"
    ].join("\n"),
    [
      {
        type: "inline_keyboard",
        payload: {
          buttons: buildBackButtonKeyboard()
        }
      }
    ]
  );
}

async function finishHoroscopeSetup(target, userId, draft, publishTimeMsk) {
  const profile = await upsertHoroscopeProfile(userId, {
    name: draft.name,
    birth_date: draft.birth_date,
    zodiac_sign: draft.zodiac_sign,
    publish_time_msk: publishTimeMsk,
    daily_enabled: false,
    last_sent_date: null
  });

  clearHoroscopeSetupState(userId);

  const text = [
    "✅ **Профиль гороскопа заполнен**",
    "",
    `Имя: **${profile.name}**`,
    `Дата рождения: **${formatBirthDateForUser(profile.birth_date)}**`,
    `Знак зодиака: **${getHoroscopeSignRu(profile.zodiac_sign)}**`,
    `Время публикации: **${profile.publish_time_msk} МСК**`,
    "",
    "Теперь можно бесплатно получить **гороскоп на сегодня**.",
    "Чтобы прогноз автоматически приходил каждый день в выбранное время, нужен **Premium**."
  ].join("\n");

  return sendMaxMessageWithAttachments(target, text, [
    {
      type: "inline_keyboard",
      payload: {
        buttons: [
          [
            {
              type: "callback",
              text: "🔮 Гороскоп на сегодня",
              payload: HOROSCOPE_TODAY_PAYLOAD
            }
          ],
          [
            {
              type: "callback",
              text: "⏰ Включить ежедневный прогноз",
              payload: HOROSCOPE_DAILY_ENABLE_PAYLOAD
            }
          ],
          ...buildBackButtonKeyboard()
        ]
      }
    }
  ]);
}

async function handleHoroscopeTimeButton(target, userId, payload) {
  const state = getHoroscopeSetupState(userId);
  const publishTimeMsk = parsePublishTimeMsk(
    String(payload || "").slice(HOROSCOPE_TIME_PAYLOAD_PREFIX.length)
  );

  if (!state || state.step !== "publish_time" || !publishTimeMsk) {
    await sendMaxMessage(target, "Эта кнопка настройки устарела. Нажмите «Премиум Гороскоп» → «Начать» ещё раз.");
    return true;
  }

  await finishHoroscopeSetup(target, userId, state.draft || {}, publishTimeMsk);
  return true;
}

async function handleHoroscopeTextInput(target, userId, userText) {
  const state = getHoroscopeSetupState(userId);

  if (!state) return false;

  const text = String(userText || "").trim();

  if (!text) {
    await sendMaxMessage(target, "Напишите текстом ответ для настройки профиля гороскопа.");
    return true;
  }

  if (state.step === "birth_date") {
    const parsed = parseBirthDate(text);

    if (!parsed) {
      await sendMaxMessage(
        target,
        "Не понял дату. Напишите полную дату рождения в формате **ДД.ММ.ГГГГ**. Например: `14.08.2001`."
      );
      return true;
    }

    const zodiacSign = getZodiacSignByDate(parsed.day, parsed.month);

    setHoroscopeSetupState(userId, {
      step: "name",
      draft: {
        birth_date: parsed.iso,
        zodiac_sign: zodiacSign
      }
    });

    await sendMaxMessage(
      target,
      [
        `Дата принята: **${formatBirthDateForUser(parsed.iso)}**.`,
        `Ваш знак зодиака: **${getHoroscopeSignRu(zodiacSign)}**.`,
        "",
        "Теперь напишите имя. Оно будет использоваться в профиле, чтобы прогноз выглядел точнее и был настроен под вас."
      ].join("\n")
    );

    return true;
  }

  if (state.step === "name") {
    const name = sanitizeHoroscopeName(text);

    if (name.length < 2) {
      await sendMaxMessage(target, "Имя слишком короткое. Напишите имя ещё раз.");
      return true;
    }

    setHoroscopeSetupState(userId, {
      step: "publish_time",
      draft: {
        ...(state.draft || {}),
        name
      }
    });

    await sendMaxMessageWithAttachments(
      target,
      [
        `Принято, **${name}**.`,
        "",
        "Теперь укажите время ежедневной публикации гороскопа по МСК.",
        "",
        "Например: `08:00`"
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: [
              [
                {
                  type: "callback",
                  text: "⏰ 08:00 МСК",
                  payload: `${HOROSCOPE_TIME_PAYLOAD_PREFIX}08:00`
                }
              ],
              [
                {
                  type: "callback",
                  text: "⏰ 09:00 МСК",
                  payload: `${HOROSCOPE_TIME_PAYLOAD_PREFIX}09:00`
                },
                {
                  type: "callback",
                  text: "⏰ 10:00 МСК",
                  payload: `${HOROSCOPE_TIME_PAYLOAD_PREFIX}10:00`
                }
              ],
              ...buildBackButtonKeyboard()
            ]
          }
        }
      ]
    );

    return true;
  }

  if (state.step === "publish_time") {
    const publishTimeMsk = parsePublishTimeMsk(text);

    if (!publishTimeMsk) {
      await sendMaxMessage(target, "Не понял время. Напишите в формате **08:00** или просто **8**.");
      return true;
    }

    await finishHoroscopeSetup(target, userId, state.draft || {}, publishTimeMsk);
    return true;
  }

  clearHoroscopeSetupState(userId);
  return false;
}

async function fetchDailyHoroscope(sign) {
  const cleanSign = String(sign || "").trim().toLowerCase();

  if (!HOROSCOPE_SIGNS[cleanSign]) {
    throw new Error("Неизвестный знак зодиака для гороскопа.");
  }

  const url = new URL(HOROSCOPE_SOURCE_URL);
  url.searchParams.set("sign", cleanSign);
  url.searchParams.set("day", "today");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOROSCOPE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data) {
      throw new Error(`Horoscope API ${response.status}: ${JSON.stringify(data)}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function rewriteHoroscopeToRussian(profile, sourceData, dateLabel) {
  if (!OPENAI_API_KEY) return "";

  const signRu = getHoroscopeSignRu(profile.zodiac_sign);
  const prompt = [
    "Составь короткий ежедневный гороскоп на русском языке для пользователя бота.",
    "Используй только данные источника ниже, не обещай гарантированных событий и не давай медицинских/финансовых инструкций.",
    "Тон: дружелюбный, живой, 5-7 предложений, без длинных списков.",
    "Обязательно упомяни, что это развлекательный прогноз.",
    "",
    `Имя: ${profile.name}`,
    `Знак: ${signRu}`,
    `Дата прогноза: ${dateLabel}`,
    `Источник: ${JSON.stringify(sourceData)}`
  ].join("\n");

  const response = await fetch(`${OPENAI_API_BASE}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: "Ты редактор коротких гороскопов для мессенджера. Пиши по-русски, аккуратно и без мистических гарантий."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    console.warn("OpenAI horoscope rewrite failed:", response.status, JSON.stringify(data));
    return "";
  }

  return extractOpenAIText(data).trim();
}

function buildFallbackHoroscopeText(profile, sourceData, dateLabel) {
  const signRu = getHoroscopeSignRu(profile.zodiac_sign);
  const sourceDescription = String(sourceData?.description || "").trim();
  const luckyNumber = String(sourceData?.lucky_number || "").trim();
  const luckyTime = String(sourceData?.lucky_time || "").trim();
  const mood = String(sourceData?.mood || "").trim();
  const color = String(sourceData?.color || "").trim();

  return [
    `🔮 **Гороскоп на ${dateLabel}**`,
    "",
    `${profile.name}, ваш знак — **${signRu}**.`,
    sourceDescription
      ? `Прогноз источника: ${sourceDescription}`
      : "Сегодня лучше действовать спокойно, не спешить с выводами и внимательно выбирать слова.",
    "",
    luckyNumber ? `Счастливое число: **${luckyNumber}**` : "",
    luckyTime ? `Удачное время: **${luckyTime}**` : "",
    mood ? `Настроение дня: **${mood}**` : "",
    color ? `Цвет дня: **${color}**` : "",
    "",
    "Это развлекательный прогноз, а не точное предсказание."
  ].filter(Boolean).join("\n");
}

function getHoroscopeButtonLimitForUser(premium) {
  return premium
    ? HOROSCOPE_PREMIUM_BUTTON_LIMIT_PER_DAY
    : HOROSCOPE_FREE_BUTTON_LIMIT_PER_DAY;
}

function getHoroscopeButtonUsageMemoryKey(userId) {
  const usageDate = getMoscowDateYmd();

  return [
    getUserRequestKey(userId),
    BOT_KEY,
    usageDate
  ].join(":");
}

function consumeHoroscopeButtonUsageMemory(userId, premium) {
  const limit = getHoroscopeButtonLimitForUser(premium);
  const key = getHoroscopeButtonUsageMemoryKey(userId);
  const current = Number(horoscopeButtonUsageMemory.get(key) || 0);

  if (current >= limit) {
    return {
      allowed: false,
      used: current,
      limit
    };
  }

  const next = current + 1;
  horoscopeButtonUsageMemory.set(key, next);

  return {
    allowed: true,
    used: next,
    limit
  };
}

async function sendHoroscopeLimitReached(target, userId, profile, premium) {
  const limit = getHoroscopeButtonLimitForUser(premium);

  const text = premium
    ? [
        "🔮 **Прогноз уже выдан**",
        "",
        `Сегодня вы уже использовали лимит гороскопов: **${limit}/${limit}**.`,
        "Чтобы не создавать лишние повторные генерации, новый прогноз сегодня больше не запускаю.",
        "",
        "Загляните завтра — лимит обновится."
      ].join("\n")
    : [
        "🔮 **Я уже дал вам прогноз на сегодня**",
        "",
        "Для бесплатного доступа гороскоп можно получить **1 раз в день**.",
        "Повторно запускать генерацию сегодня не буду, чтобы не было флуда.",
        "",
        "С Premium доступно **2 прогноза в день**."
      ].join("\n");

  return sendMaxMessageWithAttachments(target, text, [
    {
      type: "inline_keyboard",
      payload: {
        buttons: buildHoroscopeMenuButtons(profile || { user_id: userId }, premium)
      }
    }
  ]);
}

async function buildHoroscopeText(profile, dayOffset = 0) {
  const date = new Date(Date.now() + Number(dayOffset || 0) * 24 * 60 * 60 * 1000);
  const dateYmd = getMoscowDateYmd(date);
  const dateLabel = formatYmdRu(dateYmd);

  return buildHoroscopeFromEngine(profile, {
    dateLabel,
    openaiApiKey: OPENAI_API_KEY,
    openaiApiBase: OPENAI_API_BASE,
    openaiModel: OPENAI_MODEL,
    timeoutMs: 15000
  });
}

async function sendHoroscopeToday(target, userId) {
  const profile = await getHoroscopeProfile(userId);

  if (!isHoroscopeProfileComplete(profile)) {
    await sendMaxMessageWithAttachments(
      target,
      "Сначала заполните профиль гороскопа: дата рождения, имя и время публикации.",
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: [
              [
                {
                  type: "callback",
                  text: "▶️ Начать",
                  payload: HOROSCOPE_START_PAYLOAD
                }
              ],
              ...buildBackButtonKeyboard()
            ]
          }
        }
      ]
    );
    return;
  }

  const premium = await isPremiumUser(userId);
  const usage = consumeHoroscopeButtonUsageMemory(userId, premium);

  if (!usage.allowed) {
    return sendHoroscopeLimitReached(target, userId, profile, premium);
  }

  let status = null;

  try {
    status = await startDynamicStatus(target, "🌠Вселенная думает");

    const horoscopeText = await buildHoroscopeText(profile, 0);

    return sendMaxMessageWithAttachments(target, horoscopeText, [
      {
        type: "inline_keyboard",
        payload: {
          buttons: buildHoroscopeMenuButtons(profile, premium)
        }
      }
    ]);
  } finally {
    if (status) {
      await status.stop().catch((error) => {
        console.warn("Horoscope today status stop failed:", error?.message || error);
      });
    }
  }
}

async function sendHoroscopeTomorrow(target, userId) {
  const profile = await getHoroscopeProfile(userId);

  if (!isHoroscopeProfileComplete(profile)) {
    await sendMaxMessageWithAttachments(
      target,
      "Сначала заполните профиль гороскопа: дата рождения, имя и время публикации.",
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: [
              [
                {
                  type: "callback",
                  text: "▶️ Начать",
                  payload: HOROSCOPE_START_PAYLOAD
                }
              ],
              ...buildBackButtonKeyboard()
            ]
          }
        }
      ]
    );
    return;
  }

  const premium = await isPremiumUser(userId);

  if (!premium) {
    const buyUrl = buildPremiumBuyUrl(userId);
    const buttons = [];

    if (buyUrl && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY) {
      buttons.push([
        {
          type: "link",
          text: `💳 Купить Premium — ${Number(PREMIUM_PRICE_RUB).toFixed(0)} ₽`,
          url: buyUrl
        }
      ]);

      buttons.push(buildPaymentEmailFallbackRow(PAYMENT_PRODUCT_PREMIUM));
    }

    buttons.push([
      {
        type: "callback",
        text: "⬅️ Назад к гороскопу",
        payload: MENU_HOROSCOPE_PAYLOAD
      }
    ]);

    await sendMaxMessageWithAttachments(
      target,
      [
        "🌙 **Гороскоп на завтра — Premium-функция**",
        "",
        "Гороскоп на сегодня доступен бесплатно.",
        "Прогноз на завтра открывается только при активном Premium."
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: { buttons }
        }
      ]
    );
    return;
  }

  const usage = consumeHoroscopeButtonUsageMemory(userId, true);

  if (!usage.allowed) {
    return sendHoroscopeLimitReached(target, userId, profile, true);
  }

  let status = null;

  try {
    status = await startDynamicStatus(target, "🌙Вселенная заглядывает в завтра");

    const horoscopeText = await buildHoroscopeText(profile, 1);

    return sendMaxMessageWithAttachments(target, horoscopeText, [
      {
        type: "inline_keyboard",
        payload: {
          buttons: buildHoroscopeMenuButtons(profile, true)
        }
      }
    ]);
  } finally {
    if (status) {
      await status.stop().catch((error) => {
        console.warn("Horoscope tomorrow status stop failed:", error?.message || error);
      });
    }
  }
}

async function enableHoroscopeDaily(target, userId) {
  const profile = await getHoroscopeProfile(userId);

  if (!isHoroscopeProfileComplete(profile)) {
    await sendMaxMessage(target, "Сначала заполните профиль гороскопа.");
    await startHoroscopeSetup(target, userId);
    return;
  }

  const premium = await isPremiumUser(userId);

  if (!premium) {
    const buyUrl = buildPremiumBuyUrl(userId);
    const buttons = [];

    if (buyUrl && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY) {
      buttons.push([
        {
          type: "link",
          text: `💳 Купить Premium — ${Number(PREMIUM_PRICE_RUB).toFixed(0)} ₽`,
          url: buyUrl
        }
      ]);

      buttons.push(buildPaymentEmailFallbackRow(PAYMENT_PRODUCT_PREMIUM));
    }

    buttons.push([
      {
        type: "callback",
        text: "⬅️ Назад к гороскопу",
        payload: MENU_HOROSCOPE_PAYLOAD
      }
    ]);

    await sendMaxMessageWithAttachments(
      target,
      [
        "⏰ **Ежедневный гороскоп — Premium-функция**",
        "",
        "Профиль и гороскоп на сегодня доступны бесплатно.",
        `Автоматическая отправка каждый день в **${profile.publish_time_msk} МСК** включается после покупки Premium.`
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: { buttons }
        }
      ]
    );
    return;
  }

  const updatedProfile = await setHoroscopeDailyEnabled(userId, true);

  await sendMaxMessageWithAttachments(
    target,
    [
      "✅ **Ежедневный гороскоп включён**",
      "",
      `Теперь прогноз будет приходить каждый день примерно в **${updatedProfile.publish_time_msk} МСК**, пока активен Premium.`
    ].join("\n"),
    [
      {
        type: "inline_keyboard",
        payload: {
          buttons: buildHoroscopeMenuButtons(updatedProfile, true)
        }
      }
    ]
  );
}

async function disableHoroscopeDaily(target, userId) {
  const profile = await setHoroscopeDailyEnabled(userId, false);

  await sendMaxMessageWithAttachments(
    target,
    "🔕 Ежедневная отправка гороскопа отключена.",
    [
      {
        type: "inline_keyboard",
        payload: {
          buttons: buildHoroscopeMenuButtons(profile, await isPremiumUser(userId))
        }
      }
    ]
  );
}

async function processHoroscopeDailyPublications() {
  if (!dbPool || horoscopeDailyPublisherRunning) return;

  horoscopeDailyPublisherRunning = true;

  try {
    const now = new Date();
    const currentTimeMsk = getMoscowTimeHHMM(now);
    const todayMsk = getMoscowDateYmd(now);

    const result = await dbPool.query(
      `
        SELECT h.user_id, h.bot_key, h.name, h.birth_date, h.zodiac_sign,
               h.publish_time_msk, h.daily_enabled, h.last_sent_date
        FROM max_bot_horoscope_profiles h
        INNER JOIN max_bot_premium_users p
          ON p.user_id = h.user_id
         AND p.bot_key = h.bot_key
         AND p.premium_until > NOW()
        WHERE h.bot_key = $1
          AND h.daily_enabled = TRUE
          AND h.publish_time_msk = $2
          AND (h.last_sent_date IS NULL OR h.last_sent_date < $3::date)
        LIMIT 100
      `,
      [BOT_KEY, currentTimeMsk, todayMsk]
    );

    for (const row of result.rows) {
      const profile = normalizeHoroscopeProfile(row);

      if (!isHoroscopeProfileComplete(profile)) continue;

      try {
        const horoscopeText = await buildHoroscopeText(profile);

        await sendMaxMessage(
          {
            type: "user_id",
            id: profile.user_id
          },
          horoscopeText
        );

        await dbPool.query(
          `
            UPDATE max_bot_horoscope_profiles
            SET last_sent_date = $3::date,
                updated_at = NOW()
            WHERE user_id = $1 AND bot_key = $2
          `,
          [profile.user_id, BOT_KEY, todayMsk]
        );
      } catch (error) {
        console.warn(
          `Daily horoscope failed for user ${profile.user_id}:`,
          error?.message || error
        );
      }
    }
  } catch (error) {
    console.warn("Daily horoscope publisher failed:", error?.message || error);
  } finally {
    horoscopeDailyPublisherRunning = false;
  }
}

function startHoroscopeDailyPublisher() {
  if (horoscopeDailyPublisherStarted || !dbPool) return;

  horoscopeDailyPublisherStarted = true;

  setInterval(
    () => {
      processHoroscopeDailyPublications().catch((error) => {
        console.warn("Daily horoscope interval failed:", error?.message || error);
      });
    },
    HOROSCOPE_DAILY_POLL_MS
  ).unref?.();

  setInterval(
    () => {
      cleanupNonPremiumHoroscopeProfilesFromDb().catch((error) => {
        console.warn("Horoscope DB cleanup failed:", error?.message || error);
      });
    },
    HOROSCOPE_DB_CLEANUP_MS
  ).unref?.();

  setTimeout(() => {
    processHoroscopeDailyPublications().catch((error) => {
      console.warn("Daily horoscope warmup failed:", error?.message || error);
    });
  }, 5000).unref?.();

  console.log("Daily horoscope publisher started");
}

const FLOOD_WINDOW_MS = Number(process.env.FLOOD_WINDOW_MS || 10_000);
const FLOOD_MAX_MESSAGES = Number(process.env.FLOOD_MAX_MESSAGES || 5);
const FLOOD_BLOCK_MS = Number(process.env.FLOOD_BLOCK_MS || 20_000);
const FLOOD_WARNING_COOLDOWN_MS = Number(process.env.FLOOD_WARNING_COOLDOWN_MS || 12_000);

const SAME_MESSAGE_WINDOW_MS = Number(process.env.SAME_MESSAGE_WINDOW_MS || 20_000);
const SAME_MESSAGE_MAX = Number(process.env.SAME_MESSAGE_MAX || 3);

const USER_BUSY_TTL_MS = Number(process.env.USER_BUSY_TTL_MS || 5 * 60_000);
const USER_BUSY_WARNING_COOLDOWN_MS = Number(process.env.USER_BUSY_WARNING_COOLDOWN_MS || 10_000);

const userFloodStates = new Map();
const userBusyUntil = new Map();
const userBusyWarningAt = new Map();

function getStableUserId(update, target) {
  // Для callback всегда главный источник — пользователь, который нажал кнопку
  if (update?.callback?.user?.user_id) {
    return update.callback.user.user_id;
  }

  return (
    update?.message?.sender?.user_id ||
    update?.user?.user_id ||
    update?.user_id ||
    target?.id ||
    "unknown"
  );
}

function getUserFirstName(update) {
  const candidates = [
    update?.message?.sender?.first_name,
    update?.message?.sender?.firstName,
    update?.message?.sender?.name,
    update?.message?.sender?.full_name,
    update?.callback?.user?.first_name,
    update?.callback?.user?.firstName,
    update?.callback?.user?.name,
    update?.callback?.user?.full_name,
    update?.user?.first_name,
    update?.user?.firstName,
    update?.user?.name,
    update?.user?.full_name
  ];

  for (const value of candidates) {
    const text = String(value || "").trim();

    if (text) {
      return text.split(/\s+/)[0].slice(0, 50);
    }
  }

  return "";
}

async function uploadImageToFalCdn(inputImage) {
  if (!FAL_KEY) {
    throw new Error("FAL_KEY is not set");
  }

  const file = new File(
    [inputImage.buffer],
    inputImage.filename || "input.png",
    { type: inputImage.mime || "image/png" }
  );

  return fal.storage.upload(file);
}

function formatChatGptAnswerWithName(firstName, answer) {
  const cleanAnswer = String(answer || "").trim();

  const cleanName = String(firstName || "")
    .replace(/[\r\n,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);

  if (!cleanName) {
    return cleanAnswer;
  }

  return `${cleanName}, ${cleanAnswer}`;
}

function normalizeFloodText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function getRealUserIdForBroadcast(update, target) {
  return (
    update?.message?.sender?.user_id ||
    update?.callback?.user?.user_id ||
    update?.user?.user_id ||
    update?.user_id ||
    (target?.type === "user_id" ? target.id : "") ||
    ""
  );
}

function isValidUserIdForBroadcast(userId) {
  const value = String(userId || "").trim();

  return (
    value &&
    value !== "unknown" &&
    value !== "undefined" &&
    value !== "null"
  );
}

function isAdminUser(userId) {
  return ADMIN_USER_IDS.has(String(userId));
}

async function initBroadcastUsersDb() {
  if (!dbPool) return;

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS max_bot_broadcast_users (
      user_id TEXT NOT NULL,
      bot_key TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, bot_key)
    )
  `);

  await dbPool.query(`
  ALTER TABLE max_bot_broadcast_users
  ADD COLUMN IF NOT EXISTS first_name TEXT
`);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_broadcast_users_user_id
    ON max_bot_broadcast_users (user_id)
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_broadcast_users_bot_key
    ON max_bot_broadcast_users (bot_key)
  `);

  console.log("Broadcast users DB initialized");
}

async function initHipeDb() {
  if (!dbPool) return;

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS max_bot_hipe_campaigns (
      id BIGSERIAL PRIMARY KEY,
      bot_key TEXT NOT NULL,
      admin_user_id TEXT NOT NULL,
      text TEXT,
      button_text TEXT NOT NULL,
      button_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      stopped_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_hipe_campaigns_bot_created
    ON max_bot_hipe_campaigns (bot_key, created_at DESC)
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_hipe_campaigns_status
    ON max_bot_hipe_campaigns (bot_key, status)
  `);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS max_bot_hipe_clicks (
      id BIGSERIAL PRIMARY KEY,
      campaign_id BIGINT NOT NULL REFERENCES max_bot_hipe_campaigns(id) ON DELETE CASCADE,
      bot_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_agent TEXT,
      ip TEXT
    )
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_hipe_clicks_campaign_time
    ON max_bot_hipe_clicks (campaign_id, clicked_at DESC)
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_hipe_clicks_bot_time
    ON max_bot_hipe_clicks (bot_key, clicked_at DESC)
  `);

  console.log("Hipe DB initialized");
}

async function registerBotUserInDb(userId, firstName = "") {
  if (!dbPool) return false;
  if (!isValidUserIdForBroadcast(userId)) return false;

  const key = String(userId);
  const cleanFirstName = String(firstName || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  await dbPool.query(
    `
      INSERT INTO max_bot_broadcast_users (user_id, bot_key, first_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, bot_key)
      DO UPDATE SET
        last_seen_at = NOW(),
        first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), max_bot_broadcast_users.first_name)
    `,
    [key, BOT_KEY, cleanFirstName]
  );

  return true;
}

async function initLimitsDb() {
  if (!dbPool) return;

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS max_bot_limits (
      user_id TEXT NOT NULL,
      bot_key TEXT NOT NULL,
      date DATE NOT NULL,
      images INTEGER NOT NULL DEFAULT 0,
      chatgpt INTEGER NOT NULL DEFAULT 0,
      videos INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, bot_key, date)
    )
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_limits_user_date
    ON max_bot_limits (user_id, date)
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_limits_bot_key
    ON max_bot_limits (bot_key)
  `);

  console.log("Limits DB initialized");
}

async function initPremiumDb() {
  if (!dbPool) return;

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS max_bot_premium_users (
      user_id TEXT NOT NULL,
      bot_key TEXT NOT NULL,
      premium_until TIMESTAMPTZ NOT NULL,
      last_payment_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, bot_key)
    )
  `);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS max_bot_premium_payments (
      payment_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      bot_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      amount TEXT NOT NULL DEFAULT '299.00',
      currency TEXT NOT NULL DEFAULT 'RUB',
      raw JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS max_bot_premium_raffle_tickets (
      id BIGSERIAL PRIMARY KEY,
      bot_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      payment_id TEXT NOT NULL,
      token TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (bot_key, payment_id),
      UNIQUE (bot_key, token)
    )
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_premium_raffle_tickets_bot_created
    ON max_bot_premium_raffle_tickets (bot_key, created_at DESC)
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_premium_raffle_tickets_user
    ON max_bot_premium_raffle_tickets (bot_key, user_id)
  `);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS max_bot_premium_raffle_runs (
      id BIGSERIAL PRIMARY KEY,
      bot_key TEXT NOT NULL,
      admin_user_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'test',
      prize_count INTEGER NOT NULL DEFAULT 1,
      prizes JSONB NOT NULL DEFAULT '[]'::jsonb,
      winners JSONB NOT NULL DEFAULT '[]'::jsonb,
      tickets_count INTEGER NOT NULL DEFAULT 0,
      unique_users_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_premium_raffle_runs_bot_created
    ON max_bot_premium_raffle_runs (bot_key, created_at DESC)
  `);

  await dbPool.query(`
  CREATE TABLE IF NOT EXISTS max_bot_product_card_credits (
    user_id TEXT NOT NULL,
    bot_key TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, bot_key)
  )
`);

await dbPool.query(`
  CREATE INDEX IF NOT EXISTS idx_max_bot_product_card_credits_user_bot
  ON max_bot_product_card_credits (user_id, bot_key)
`);

  await dbPool.query(`
  CREATE TABLE IF NOT EXISTS max_bot_music_credits (
    user_id TEXT NOT NULL,
    bot_key TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, bot_key)
  )
`);

await dbPool.query(`
  CREATE INDEX IF NOT EXISTS idx_max_bot_music_credits_user_bot
  ON max_bot_music_credits (user_id, bot_key)
`);

 await dbPool.query(`
  CREATE TABLE IF NOT EXISTS max_bot_video_credits (
    user_id TEXT NOT NULL,
    bot_key TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, bot_key)
  )
`);

await dbPool.query(`
  CREATE INDEX IF NOT EXISTS idx_max_bot_video_credits_user_bot
  ON max_bot_video_credits (user_id, bot_key)
`); 

await dbPool.query(`
  CREATE TABLE IF NOT EXISTS max_bot_prompt_video_credits (
    user_id TEXT NOT NULL,
    bot_key TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, bot_key)
  )
`);

await dbPool.query(`
  CREATE INDEX IF NOT EXISTS idx_max_bot_prompt_video_credits_user_bot
  ON max_bot_prompt_video_credits (user_id, bot_key)
`);
  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_premium_users_active
    ON max_bot_premium_users (user_id, bot_key, premium_until)
  `);

  await dbPool.query(`
  CREATE TABLE IF NOT EXISTS max_bot_family_video_credits (
    user_id TEXT NOT NULL,
    bot_key TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, bot_key)
  )
`);

await dbPool.query(`
  CREATE INDEX IF NOT EXISTS idx_max_bot_family_video_credits_user_bot
  ON max_bot_family_video_credits (user_id, bot_key)
`);

  console.log("Premium DB initialized");
}

async function getBroadcastRecipientsFromDb() {
  if (!dbPool) return [];

  const result = BROADCAST_USE_ALL_BOTS
    ? await dbPool.query(`
        SELECT DISTINCT user_id
        FROM max_bot_broadcast_users
        ORDER BY user_id
      `)
    : await dbPool.query(
        `
          SELECT DISTINCT user_id
          FROM max_bot_broadcast_users
          WHERE bot_key = $1
          ORDER BY user_id
        `,
        [BOT_KEY]
      );

  return result.rows
    .map((row) => String(row.user_id || "").trim())
    .filter(isValidUserIdForBroadcast);
}

function parseBroadcastCommand(text) {
  const value = String(text || "");

  const match = value.match(
    /^\s*\/(?:post|пост|broadcast|sendall|рассылка)(?:@\S+)?(?:\s+([\s\S]*))?$/iu
  );

  if (!match) return null;

  return String(match[1] || "").trim();
}

function isBroadcastCommand(text) {
  return parseBroadcastCommand(text) !== null;
}

function parseHipeCommand(text) {
  const value = String(text || "");
  const match = value.match(/^\s*\/(?:hipe|хайп)(?:@\S+)?(?:\s+([\s\S]*))?$/iu);
  if (!match) return null;
  return String(match[1] || "").trim();
}

function isHipeCommand(text) {
  return parseHipeCommand(text) !== null;
}

function isHipeStopCommand(text) {
  return /^\s*\/(?:hipestop|хайпстоп)(?:@\S+)?\s*$/iu.test(String(text || ""));
}

function isHipeStatsCommand(text) {
  return /^\s*\/(?:hipestats|hipe_stats|хайпстат|хайпстаты)(?:@\S+)?\s*$/iu.test(String(text || ""));
}

function parseGiveGptCommand(text) {
  const value = String(text || "").trim();
  const match = value.match(/^\/givegpt(?:@\S+)?(?:\s+([^\s]+))?(?:\s+(\d+))?\s*$/i);

  if (!match) return null;

  const targetUserId = String(match[1] || "").trim();
  const days = match[2] ? Number(match[2]) : PREMIUM_DURATION_DAYS;

  return {
    targetUserId,
    days
  };
}

function isGiveGptCommand(text) {
  return /^\s*\/givegpt(?:@\S+)?(?:\s|$)/i.test(String(text || ""));
}

function parsePremiumRaffleCommand(text) {
  const value = String(text || "").trim();
  const match = value.match(
    /^\/(?:gptpromo|gptaction|premiumdraw|акция)(?:@\S+)?(?:\s+(stats|stat|стат|test|тест|draw|run|real|старт))?(?:\s+(\d+))?(?:\s+([\s\S]+))?$/iu
  );

  if (!match) return null;

  const action = String(match[1] || "test").toLowerCase();
  const prizeCount = Math.max(1, Math.min(50, Number(match[2]) || 1));
  const prizesText = String(match[3] || "").trim();
  const prizes = prizesText
    ? prizesText
        .split(/[;\n]+/)
        .map((item) => item.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, prizeCount)
    : [];

  return {
    action,
    prizeCount,
    prizes
  };
}

function isPremiumRaffleCommand(text) {
  return /^\s*\/(?:gptpromo|gptaction|premiumdraw|акция)(?:@\S+)?(?:\s|$)/iu.test(String(text || ""));
}

const HIPE_CONFIRM_PAYLOAD_PREFIX = "hipe_confirm:";
const HIPE_CANCEL_PAYLOAD_PREFIX = "hipe_cancel:";
const HIPE_DRAFT_TTL_MS = Number(process.env.HIPE_DRAFT_TTL_MS || 30 * 60_000);
const hipeDrafts = new Map();

function makeHipeDraftId() {
  return crypto.randomBytes(8).toString("hex");
}

function getHipeDraftKey(adminUserId, draftId) {
  return `${String(adminUserId || "")}:${String(draftId || "")}`;
}

function setHipeDraft(adminUserId, draftId, draft) {
  hipeDrafts.set(getHipeDraftKey(adminUserId, draftId), {
    ...draft,
    adminUserId: String(adminUserId || ""),
    draftId: String(draftId || ""),
    createdAt: Date.now()
  });
}

function getHipeDraft(adminUserId, draftId) {
  const key = getHipeDraftKey(adminUserId, draftId);
  const draft = hipeDrafts.get(key);

  if (!draft) return null;

  if (Date.now() - Number(draft.createdAt || 0) > HIPE_DRAFT_TTL_MS) {
    hipeDrafts.delete(key);
    return null;
  }

  return draft;
}

function deleteHipeDraft(adminUserId, draftId) {
  hipeDrafts.delete(getHipeDraftKey(adminUserId, draftId));
}

function cleanupHipeDrafts() {
  const now = Date.now();

  for (const [key, draft] of hipeDrafts.entries()) {
    if (now - Number(draft?.createdAt || 0) > HIPE_DRAFT_TTL_MS) {
      hipeDrafts.delete(key);
    }
  }
}

setInterval(cleanupHipeDrafts, 10 * 60_000).unref?.();

function normalizeHipeUrl(value) {
  const raw = String(value || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "";

  try {
    const url = new URL(raw);
    return url.toString();
  } catch {
    return "";
  }
}

function parseHipePayload(rawText) {
  const raw = String(rawText || "").trim();
  const lines = raw.split(/\r?\n/);
  let buttonText = "";
  let buttonUrl = "";
  const textLines = [];

  for (const line of lines) {
    const buttonMatch = line.match(/^\s*(?:кнопка|button)\s*:\s*(.+?)\s*$/iu);
    if (buttonMatch) {
      buttonText = buttonMatch[1].trim();
      continue;
    }

    const urlMatch = line.match(/^\s*(?:ссылка|url|link)\s*:\s*(https?:\/\/\S+)\s*$/iu);
    if (urlMatch) {
      buttonUrl = normalizeHipeUrl(urlMatch[1]);
      continue;
    }

    textLines.push(line);
  }

  const broadcastText = textLines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();

  return {
    text: broadcastText,
    buttonText: buttonText.slice(0, 80),
    buttonUrl
  };
}

function buildHipeHelpText() {
  return [
    "✍️ Команда **/hipe** делает рассылку как `/post`, но с вашей кнопкой под постом.",
    "",
    "Сначала бот отправит вам **предпросмотр** готового поста с кнопкой.",
    "Рассылка начнётся только после нажатия **✅ Отправить**.",
    "",
    "Формат:",
    "`/hipe Текст поста`",
    "`Кнопка: Название кнопки`",
    "`Ссылка: https://example.com`",
    "",
    "Можно отправить **фото** и в подписи к фото написать так же:",
    "`/hipe **Заголовок**`",
    "`Описание и [ссылка](https://example.com)`",
    "",
    "`Кнопка: Открыть`",
    "`Ссылка: https://example.com`",
    "",
    "Остановить текущую рассылку: `/hipestop`",
    "Статистика отправок: `/hipestats`"
  ].join("\n");
}
async function createHipeCampaign(adminUserId, parsed) {
  const result = await dbPool.query(
    `
      INSERT INTO max_bot_hipe_campaigns (
        bot_key, admin_user_id, text, button_text, button_url, status
      )
      VALUES ($1, $2, $3, $4, $5, 'running')
      RETURNING *
    `,
    [BOT_KEY, String(adminUserId), parsed.text || null, parsed.buttonText, parsed.buttonUrl]
  );

  return result.rows[0];
}

async function updateHipeCampaignCounts(campaignId, sentCount, failedCount, status = null) {
  if (!dbPool) return;

  if (status) {
    await dbPool.query(
      `
        UPDATE max_bot_hipe_campaigns
        SET sent_count = $2,
            failed_count = $3,
            status = $4,
            finished_at = CASE WHEN $4 IN ('finished', 'stopped') THEN COALESCE(finished_at, NOW()) ELSE finished_at END,
            stopped_at = CASE WHEN $4 = 'stopped' THEN COALESCE(stopped_at, NOW()) ELSE stopped_at END
        WHERE id = $1 AND bot_key = $5
      `,
      [campaignId, sentCount, failedCount, status, BOT_KEY]
    );
    return;
  }

  await dbPool.query(
    `
      UPDATE max_bot_hipe_campaigns
      SET sent_count = $2,
          failed_count = $3
      WHERE id = $1 AND bot_key = $4
    `,
    [campaignId, sentCount, failedCount, BOT_KEY]
  );
}

async function isHipeCampaignStopped(campaignId) {
  if (!dbPool) return false;

  const result = await dbPool.query(
    `SELECT status FROM max_bot_hipe_campaigns WHERE id = $1 AND bot_key = $2 LIMIT 1`,
    [campaignId, BOT_KEY]
  );

  return String(result.rows[0]?.status || "") === "stopped";
}

function buildHipeKeyboard(buttonText, buttonUrl) {
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        [
          {
            type: "link",
            text: String(buttonText || "Открыть").slice(0, 80),
            url: buttonUrl
          }
        ]
      ]
    }
  };
}

function buildHipePreviewControlKeyboard(draftId) {
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        [
          {
            type: "callback",
            text: "✅ Отправить",
            payload: `${HIPE_CONFIRM_PAYLOAD_PREFIX}${draftId}`
          },
          {
            type: "callback",
            text: "❌ Отмена",
            payload: `${HIPE_CANCEL_PAYLOAD_PREFIX}${draftId}`
          }
        ]
      ]
    }
  };
}
async function handleHipeStopCommand(target, adminUserId) {
  if (!isAdminUser(adminUserId)) {
    await sendMaxMessage(target, "⛔ Эта команда доступна только администратору.");
    return true;
  }

  if (!dbPool) {
    await sendMaxMessage(target, "⚠️ DATABASE_URL не задан.");
    return true;
  }

  const result = await dbPool.query(
    `
      UPDATE max_bot_hipe_campaigns
      SET status = 'stopped', stopped_at = NOW(), finished_at = COALESCE(finished_at, NOW())
      WHERE bot_key = $1 AND status = 'running'
      RETURNING id, sent_count, failed_count
    `,
    [BOT_KEY]
  );

  if (!result.rowCount) {
    await sendMaxMessage(target, "ℹ️ Сейчас нет активной `/hipe` рассылки.");
    return true;
  }

  await sendMaxMessage(
    target,
    [
      "⏹ **/hipe остановлена.**",
      "",
      ...result.rows.map((row) => `• Кампания #${row.id}: отправлено ${row.sent_count}, ошибок ${row.failed_count}`)
    ].join("\n")
  );

  return true;
}

async function handleHipeStatsCommand(target, adminUserId) {
  if (!isAdminUser(adminUserId)) {
    await sendMaxMessage(target, "⛔ Эта команда доступна только администратору.");
    return true;
  }

  if (!dbPool) {
    await sendMaxMessage(target, "⚠️ DATABASE_URL не задан.");
    return true;
  }

  const result = await dbPool.query(
    `
      SELECT
        id,
        created_at,
        button_text,
        button_url,
        status,
        sent_count,
        failed_count
      FROM max_bot_hipe_campaigns
      WHERE bot_key = $1
      ORDER BY created_at DESC
      LIMIT 10
    `,
    [BOT_KEY]
  );

  if (!result.rows.length) {
    await sendMaxMessage(target, "ℹ️ `/hipe` рассылок ещё не было.");
    return true;
  }

  const lines = ["📊 **Статистика /hipe**", "", "Клики не считаются: кнопка ведёт напрямую на указанный сайт/канал.", ""];

  for (const row of result.rows) {
    lines.push(
      `#${row.id} | ${row.status} | ${new Date(row.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC`,
      `Кнопка: **${row.button_text}**`,
      `Ссылка: ${row.button_url}`,
      `Отправлено: **${row.sent_count}**, ошибок: **${row.failed_count}**`,
      ""
    );
  }

  await sendMaxMessage(target, lines.join("\n"));
  return true;
}
async function sendHipePreview(target, parsed, imagePayload = null) {
  const keyboard = buildHipeKeyboard(parsed.buttonText, parsed.buttonUrl);
  const chunks = splitForMax(parsed.text || "");

  await sendMaxMessage(target, "👀 **Предпросмотр /hipe**\n\nНиже бот отправит пост именно в таком виде, как его увидят пользователи.");

  if (imagePayload) {
    if (chunks.length <= 1) {
      await sendMaxBroadcastImagePost(target, chunks[0] || null, imagePayload, [keyboard]);
    } else {
      await sendMaxBroadcastImagePost(target, chunks[0] || null, imagePayload);

      for (const extraChunk of chunks.slice(1, -1)) {
        await sendMaxMessage(target, extraChunk);
      }

      await sendMaxMessageWithAttachments(target, chunks[chunks.length - 1], [keyboard]);
    }
  } else {
    if (chunks.length <= 1) {
      await sendMaxMessageWithAttachments(target, parsed.text || null, [keyboard]);
    } else {
      for (const chunk of chunks.slice(0, -1)) {
        await sendMaxMessage(target, chunk);
      }

      await sendMaxMessageWithAttachments(target, chunks[chunks.length - 1], [keyboard]);
    }
  }
}

async function executeHipeBroadcast(target, adminUserId, draft) {
  if (!dbPool) {
    await sendMaxMessage(target, "⚠️ DATABASE_URL не задан. /hipe недоступна.");
    return true;
  }

  const parsed = draft.parsed;
  const imagePayload = draft.imagePayload || null;
  const recipients = await getBroadcastRecipientsFromDb();

  if (!recipients.length) {
    await sendMaxMessage(target, "⚠️ В базе пока нет пользователей для рассылки.");
    return true;
  }

  const campaign = await createHipeCampaign(adminUserId, parsed);

  await sendMaxMessage(
    target,
    [
      `🚀 Начинаю /hipe рассылку #${campaign.id} для ${recipients.length} пользователей...`,
      imagePayload ? "🖼️ Режим: текст + фото." : "📝 Режим: только текст.",
      `🔘 Кнопка: **${parsed.buttonText}**`,
      `🔗 Ссылка кнопки: ${parsed.buttonUrl}`,
      "",
      "Остановить: `/hipestop`",
      "Статистика отправок: `/hipestats`"
    ].join("\n")
  );

  let sentCount = 0;
  let failedCount = 0;
  let stopped = false;
  const chunks = splitForMax(parsed.text || "");

  for (const recipientUserId of recipients) {
    if (await isHipeCampaignStopped(campaign.id)) {
      stopped = true;
      break;
    }

    try {
      const recipientTarget = {
        type: "user_id",
        id: recipientUserId
      };

      const hipeKeyboard = buildHipeKeyboard(parsed.buttonText, parsed.buttonUrl);

      if (imagePayload) {
        if (chunks.length <= 1) {
          await sendMaxBroadcastImagePost(
            recipientTarget,
            chunks[0] || null,
            imagePayload,
            [hipeKeyboard]
          );
        } else {
          await sendMaxBroadcastImagePost(recipientTarget, chunks[0] || null, imagePayload);

          for (const extraChunk of chunks.slice(1, -1)) {
            await sendMaxMessage(recipientTarget, extraChunk);
          }

          await sendMaxMessageWithAttachments(
            recipientTarget,
            chunks[chunks.length - 1],
            [hipeKeyboard]
          );
        }
      } else {
        if (chunks.length <= 1) {
          await sendMaxMessageWithAttachments(
            recipientTarget,
            parsed.text,
            [hipeKeyboard]
          );
        } else {
          for (const chunk of chunks.slice(0, -1)) {
            await sendMaxMessage(recipientTarget, chunk);
          }

          await sendMaxMessageWithAttachments(
            recipientTarget,
            chunks[chunks.length - 1],
            [hipeKeyboard]
          );
        }
      }

      sentCount += 1;
    } catch (error) {
      failedCount += 1;
      console.warn(`Hipe failed for user ${recipientUserId}:`, error?.message || error);

      if (isMaxChatDeniedError(error)) {
        await removeBroadcastUserFromDb(recipientUserId).catch((cleanupError) => {
          console.warn(`Failed to remove suspended hipe user ${recipientUserId}:`, cleanupError?.message || cleanupError);
        });
      }
    }

    if ((sentCount + failedCount) % 25 === 0) {
      await updateHipeCampaignCounts(campaign.id, sentCount, failedCount).catch(() => {});
    }

    if (BROADCAST_DELAY_MS > 0) {
      await sleep(BROADCAST_DELAY_MS);
    }
  }

  const finalStatus = stopped ? "stopped" : "finished";
  await updateHipeCampaignCounts(campaign.id, sentCount, failedCount, finalStatus);

  await sendMaxMessage(
    target,
    [
      stopped ? "⏹ **/hipe остановлена.**" : "✅ **/hipe рассылка завершена.**",
      "",
      `Кампания: **#${campaign.id}**`,
      `📨 Успешно отправлено: **${sentCount}**`,
      `⚠️ Ошибок: **${failedCount}**`,
      `👥 Получателей в выборке: **${recipients.length}**`,
      "",
      "Статистика отправок: `/hipestats`"
    ].join("\n")
  );

  return true;
}

async function handleHipeConfirmCallback(target, adminUserId, payload, callbackId = "") {
  if (!isAdminUser(adminUserId)) {
    if (callbackId) await answerMaxCallback(callbackId, "⛔ Только администратор.");
    return true;
  }

  const draftId = String(payload || "").slice(HIPE_CONFIRM_PAYLOAD_PREFIX.length);
  const draft = getHipeDraft(adminUserId, draftId);

  if (!draft) {
    if (callbackId) await answerMaxCallback(callbackId, "Черновик устарел. Отправьте /hipe заново.");
    await sendMaxMessage(target, "⚠️ Черновик `/hipe` устарел или уже отправлен. Создайте рассылку заново.");
    return true;
  }

  deleteHipeDraft(adminUserId, draftId);

  if (callbackId) await answerMaxCallback(callbackId, "Запускаю /hipe рассылку.");
  return executeHipeBroadcast(target, adminUserId, draft);
}

async function handleHipeCancelCallback(target, adminUserId, payload, callbackId = "") {
  if (!isAdminUser(adminUserId)) {
    if (callbackId) await answerMaxCallback(callbackId, "⛔ Только администратор.");
    return true;
  }

  const draftId = String(payload || "").slice(HIPE_CANCEL_PAYLOAD_PREFIX.length);
  deleteHipeDraft(adminUserId, draftId);

  if (callbackId) await answerMaxCallback(callbackId, "Рассылка отменена.");
  await sendMaxMessage(target, "❌ `/hipe` рассылка отменена. Ничего не отправлено.");
  return true;
}

async function handleHipeCommand(target, adminUserId, userText, incomingImageUrl = "") {
  const rawPayload = parseHipeCommand(userText);
  const hasImage = Boolean(incomingImageUrl);

  if (rawPayload === null) return false;

  if (!isAdminUser(adminUserId)) {
    console.warn(`User ${adminUserId} tried to use hipe command`);
    await sendMaxMessage(target, "⛔ Эта команда доступна только администратору.");
    return true;
  }

  if (!dbPool) {
    await sendMaxMessage(target, "⚠️ DATABASE_URL не задан. /hipe недоступна.");
    return true;
  }

  const parsed = parseHipePayload(rawPayload);

  if ((!parsed.text && !hasImage) || !parsed.buttonText || !parsed.buttonUrl) {
    await sendMaxMessage(target, buildHipeHelpText());
    return true;
  }

  let imagePayload = null;

  if (hasImage) {
    try {
      const inputImage = await downloadIncomingImage(incomingImageUrl);
      imagePayload = await uploadImageBufferToMax(
        inputImage.buffer,
        inputImage.mime,
        inputImage.filename || `hipe.${extensionFromMime(inputImage.mime)}`
      );
    } catch (error) {
      console.warn("Hipe image upload failed:", error?.message || error);
      await sendMaxMessage(target, "⚠️ Не получилось загрузить фото для /hipe. Проверьте изображение и попробуйте ещё раз.");
      return true;
    }
  }

  const recipients = await getBroadcastRecipientsFromDb();

  if (!recipients.length) {
    await sendMaxMessage(target, "⚠️ В базе пока нет пользователей для рассылки.");
    return true;
  }

  const draftId = makeHipeDraftId();

  setHipeDraft(adminUserId, draftId, {
    parsed,
    imagePayload
  });

  await sendHipePreview(target, parsed, imagePayload);

  await sendMaxMessageWithAttachments(
    target,
    [
      "✅ **Отправлять этот /hipe?**",
      "",
      `Получателей в базе: **${recipients.length}**`,
      `Кнопка: **${parsed.buttonText}**`,
      `Ссылка: ${parsed.buttonUrl}`,
      "",
      "Нажмите **✅ Отправить**, чтобы запустить рассылку."
    ].join("\n"),
    [buildHipePreviewControlKeyboard(draftId)]
  );

  return true;
}
function isMaxChatDeniedError(error) {
  const message = String(error?.message || "");

  return (
    message.includes("MAX API 403") &&
    (
      message.includes("chat.denied") ||
      message.includes("error.dialog.suspended") ||
      message.includes("dialog.suspended")
    )
  );
}

async function removeBroadcastUserFromDb(userId) {
  if (!dbPool) return;

  await dbPool.query(
    `
      DELETE FROM max_bot_broadcast_users
      WHERE user_id = $1
        AND bot_key = $2
    `,
    [String(userId), BOT_KEY]
  );
}

async function handleBroadcastCommand(target, adminUserId, userText, incomingImageUrl = "") {
  const broadcastText = parseBroadcastCommand(userText);
  const hasImage = Boolean(incomingImageUrl);

  if (broadcastText === null) {
    return false;
  }

  if (!isAdminUser(adminUserId)) {
    console.warn(`User ${adminUserId} tried to use broadcast command`);

    await sendMaxMessage(
      target,
      "⛔ Эта команда доступна только администратору."
    );

    return true;
  }

  if (!dbPool) {
    await sendMaxMessage(
      target,
      "⚠️ DATABASE_URL не задан. Рассылка через базу недоступна."
    );

    return true;
  }

  if (!broadcastText && !hasImage) {
    await sendMaxMessage(
      target,
      [
        "✍️ Напишите текст рассылки после команды или отправьте фото с подписью.",
        "",
        "Примеры:",
        "`/post Всем привет! Это сообщение от бота.`",
        "`/post **Жирный текст** и [ссылка](https://example.com)`",
        "",
        "Можно отправить **фото** и в подписи к фото написать:",
        "`/post **Новый пост**\n\nОписание и [ссылка](https://example.com)`"
      ].join("\n")
    );

    return true;
  }

  const recipients = await getBroadcastRecipientsFromDb();

  if (!recipients.length) {
    await sendMaxMessage(
      target,
      "⚠️ В базе пока нет пользователей для рассылки."
    );

    return true;
  }

  let imagePayload = null;

  if (hasImage) {
    try {
      const inputImage = await downloadIncomingImage(incomingImageUrl);

      imagePayload = await uploadImageBufferToMax(
        inputImage.buffer,
        inputImage.mime,
        inputImage.filename || `broadcast.${extensionFromMime(inputImage.mime)}`
      );
    } catch (error) {
      console.warn("Broadcast image upload failed:", error?.message || error);

      await sendMaxMessage(
        target,
        "⚠️ Не получилось загрузить фото для рассылки. Проверьте изображение и попробуйте ещё раз."
      );

      return true;
    }
  }

  await sendMaxMessage(
    target,
    [
      `📣 Начинаю рассылку для ${recipients.length} пользователей...`,
      imagePayload ? "🖼️ Режим: текст + фото." : "📝 Режим: только текст.",
      "Формат текста: MAX Markdown."
    ].join("\n")
  );

  let sentCount = 0;
  let failedCount = 0;

  const chunks = splitForMax(broadcastText || "");

  for (const recipientUserId of recipients) {
    try {
      const recipientTarget = {
        type: "user_id",
        id: recipientUserId
      };

const postKeyboard = buildBroadcastPostKeyboard(recipientUserId);

if (imagePayload) {
  // Если текст короткий — отправляем фото + текст + кнопки одним сообщением.
  if (chunks.length <= 1) {
    await sendMaxBroadcastImagePost(
      recipientTarget,
      chunks[0] || null,
      imagePayload,
      [postKeyboard]
    );
  } else {
    // Если текст длинный — фото отправляем с первым куском,
    // а кнопки ставим под последним текстовым сообщением.
    await sendMaxBroadcastImagePost(
      recipientTarget,
      chunks[0] || null,
      imagePayload
    );

    for (const extraChunk of chunks.slice(1, -1)) {
      await sendMaxMessage(recipientTarget, extraChunk);
    }

    await sendMaxMessageWithAttachments(
      recipientTarget,
      chunks[chunks.length - 1],
      [postKeyboard]
    );
  }
} else {
  // Если текст короткий — отправляем текст + кнопки.
  if (chunks.length <= 1) {
    await sendMaxMessageWithAttachments(
      recipientTarget,
      broadcastText,
      [postKeyboard]
    );
  } else {
    // Если текст длинный — режем на части, кнопку ставим под последней частью.
    for (const chunk of chunks.slice(0, -1)) {
      await sendMaxMessage(recipientTarget, chunk);
    }

    await sendMaxMessageWithAttachments(
      recipientTarget,
      chunks[chunks.length - 1],
      [postKeyboard]
    );
  }
}

      sentCount += 1;
} catch (error) {
  failedCount += 1;

  console.warn(
    `Broadcast failed for user ${recipientUserId}:`,
    error?.message || error
  );

  if (isMaxChatDeniedError(error)) {
    await removeBroadcastUserFromDb(recipientUserId).catch((cleanupError) => {
      console.warn(
        `Failed to remove suspended broadcast user ${recipientUserId}:`,
        cleanupError?.message || cleanupError
      );
    });
  }
}
    if (BROADCAST_DELAY_MS > 0) {
      await sleep(BROADCAST_DELAY_MS);
    }
  }

  await sendMaxMessage(
    target,
    [
      "✅ Рассылка завершена.",
      "",
      `📨 Успешно отправлено: ${sentCount}`,
      `⚠️ Ошибок: ${failedCount}`,
      `👥 Получателей в выборке: ${recipients.length}`,
      imagePayload ? "🖼️ Отправлено с фото." : "📝 Отправлено без фото.",
      "",
      BROADCAST_USE_ALL_BOTS
        ? "Режим: пользователи всех ботов из общей таблицы."
        : `Режим: только пользователи BOT_KEY=${BOT_KEY}.`
    ].join("\n")
  );

  return true;
}

function checkAntiFlood(userId, textForCheck = "") {
  const now = Date.now();

  let state = userFloodStates.get(userId);

  if (!state) {
    state = {
      windowStart: now,
      count: 0,
      blockedUntil: 0,
      lastWarningAt: 0,
      lastText: "",
      lastTextAt: 0,
      sameTextCount: 0
    };

    userFloodStates.set(userId, state);
  }

  if (state.blockedUntil > now) {
    const canWarn = now - state.lastWarningAt >= FLOOD_WARNING_COOLDOWN_MS;

    if (canWarn) {
      state.lastWarningAt = now;
    }

    return {
      blocked: true,
      reason: "blocked",
      retryAfterMs: state.blockedUntil - now,
      shouldWarn: canWarn
    };
  }

  if (now - state.windowStart > FLOOD_WINDOW_MS) {
    state.windowStart = now;
    state.count = 0;
  }

  state.count += 1;

  const normalizedText = normalizeFloodText(textForCheck);

  if (
    normalizedText &&
    normalizedText === state.lastText &&
    now - state.lastTextAt <= SAME_MESSAGE_WINDOW_MS
  ) {
    state.sameTextCount += 1;
  } else {
    state.lastText = normalizedText;
    state.lastTextAt = now;
    state.sameTextCount = normalizedText ? 1 : 0;
  }

  const tooManyMessages = state.count > FLOOD_MAX_MESSAGES;
  const tooManySameMessages = state.sameTextCount > SAME_MESSAGE_MAX;

  if (tooManyMessages || tooManySameMessages) {
    state.blockedUntil = now + FLOOD_BLOCK_MS;
    state.windowStart = now;
    state.count = 0;

    const canWarn = now - state.lastWarningAt >= FLOOD_WARNING_COOLDOWN_MS;

    if (canWarn) {
      state.lastWarningAt = now;
    }

    return {
      blocked: true,
      reason: tooManySameMessages ? "same_message" : "too_many_messages",
      retryAfterMs: FLOOD_BLOCK_MS,
      shouldWarn: canWarn
    };
  }

  return {
    blocked: false
  };
}

async function sendFloodWarningIfNeeded(target, userId, floodResult) {
  if (!floodResult?.shouldWarn) return;

  const seconds = Math.ceil((floodResult.retryAfterMs || FLOOD_BLOCK_MS) / 1000);

  console.warn(`Flood detected: user ${userId}, reason: ${floodResult.reason}`);

  await sendMaxMessage(
    target,
    `📛 **Вы отправляете сообщения слишком часто.** Подождите примерно ${seconds} сек.`
  ).catch((error) => {
    console.error("Failed to send flood warning:", error);
  });
}

function isUserBusy(userId) {
  const now = Date.now();
  const busyUntil = userBusyUntil.get(userId) || 0;

  if (busyUntil <= now) {
    userBusyUntil.delete(userId);
    return false;
  }

  return true;
}

function lockUserProcessing(userId) {
  userBusyUntil.set(userId, Date.now() + USER_BUSY_TTL_MS);
}

function unlockUserProcessing(userId) {
  userBusyUntil.delete(userId);
}

async function sendBusyWarningIfNeeded(target, userId, firstName = "") {
  const now = Date.now();
  const lastWarningAt = userBusyWarningAt.get(userId) || 0;

  if (now - lastWarningAt < USER_BUSY_WARNING_COOLDOWN_MS) return;

  userBusyWarningAt.set(userId, now);

  const namePrefix = firstName ? `${firstName}, ` : "";

  await sendMaxMessage(
    target,
    `😅 ${namePrefix}Может хватит спамить? Пожалуйста, дождитесь ответа.`
  ).catch((error) => {
    console.error("Failed to send busy warning:", error);
  });
}

setInterval(() => {
  const now = Date.now();

  for (const [userId, state] of userFloodStates.entries()) {
    const inactiveTooLong =
      now - state.windowStart > 60 * 60_000 &&
      state.blockedUntil <= now;

    if (inactiveTooLong) {
      userFloodStates.delete(userId);
    }
  }

  for (const [userId, busyUntil] of userBusyUntil.entries()) {
    if (busyUntil <= now) {
      userBusyUntil.delete(userId);
    }
  }

  for (const [userId, lastWarningAt] of userBusyWarningAt.entries()) {
    if (now - lastWarningAt > 60 * 60_000) {
      userBusyWarningAt.delete(userId);
    }
  }
}, 10 * 60_000).unref?.();

setInterval(() => {
  const now = Date.now();

  for (const [userId, lastRegisteredAt] of registeredUserCache.entries()) {
    if (now - lastRegisteredAt > REGISTER_USER_CACHE_TTL_MS * 2) {
      registeredUserCache.delete(userId);
    }
  }
}, 60 * 60 * 1000).unref?.();


const CONTEXT_MAX_REQUESTS = Number(process.env.CONTEXT_MAX_REQUESTS || 3);
const CONTEXT_MAX_TEXT_CHARS = Number(process.env.CONTEXT_MAX_TEXT_CHARS || 3000);
const CONTEXT_TTL_MS = Number(process.env.CONTEXT_TTL_MS || 30 * 60_000);

const userChatContexts = new Map();

// Рандомные сообщения после 1–2 успешных генераций/ответов
const RANDOM_NUDGE_ENABLED =
  String(process.env.RANDOM_NUDGE_ENABLED || "true").toLowerCase() !== "false";

const RANDOM_NUDGE_MIN_GENERATIONS = Number(
  process.env.RANDOM_NUDGE_MIN_GENERATIONS || 1
);

const RANDOM_NUDGE_MAX_GENERATIONS = Number(
  process.env.RANDOM_NUDGE_MAX_GENERATIONS || 4
);

// Сюда можешь добавлять свои фразы
const RANDOM_NUDGE_MESSAGES = [
  "💡 **Совет дня:** если ты сейчас отвлечёшься от телефона на 4 секунды — это может немного успокоить и расслабить. Отвлёкся? Молодец 😌",

  "🎁 Спасибо, что пользуешься ботом. Вот **[СТИКЕРЫ](https://max.ru/stickerset/H-ZRhj8Ho-gSEXFkiTwVJqOpforgF83w7wyGrDq47VI)**",


  "🚀 **Хочешь больше продаж на Wildberries и Ozon?** 📈 **MarketAI24** покажет, где ты теряешь *деньги* и как увеличить прибыль с помощью AI-аналитики. 🔥 Попробуй **[БЕСПЛАТНО](https://marketai24.ru/?ref=5ZFAWMVO)**",

  "🧠 Маленький совет: иногда лучший промт получается, если описать не только объект, но и стиль, свет, фон и настроение.",

  "✨ Хочешь результат лучше? Проси прямо в **ЧАТ** чтобы написали промт за тебя и **создавай фото**",

  "🧸 Спасибо, что создаёшь вместе с ботом. Ты теперь нам как **семья**👨‍👨‍👦‍👦",

  "🤸‍♂️**Кстати вы знали что в Алисе от Яндекса можно оживлять фото и спросить что хочешь?**[БЕСПЛАТНО](https://redirect.appmetrica.yandex.com/serve/750435175153844646?clid=15053682&appmetrica_js_redirect=0)",

  "⏳ **Твои лимиты обновляются каждый день,всегда тебя ждем**",

  "❗ *Если есть проблемы с ботом или хотите стать **спонсором/реклама**, пишите в* **[Поддержку](https://max.ru/u/f9LHodD0cOK-A0lZdI24jE547UNSp4Gdn57gyHn8TJVc5hh-0NCZiBCjktg)**."
].filter(Boolean);

// userId -> состояние рандомных подсказок
const userRandomNudgeStates = new Map();

function randomInt(min, max) {
  const safeMin = Math.max(1, Math.floor(Number(min) || 1));
  const safeMax = Math.max(safeMin, Math.floor(Number(max) || safeMin));

  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function getNextRandomNudgeAfter() {
  return randomInt(
    RANDOM_NUDGE_MIN_GENERATIONS,
    RANDOM_NUDGE_MAX_GENERATIONS
  );
}

function getRandomNudgeState(userId) {
  const key = String(userId || "unknown");

  let state = userRandomNudgeStates.get(key);

  if (!state) {
    state = {
      generatedSinceLastNudge: 0,
      nextAfter: getNextRandomNudgeAfter(),
      lastMessageIndex: -1
    };

    userRandomNudgeStates.set(key, state);
  }

  return state;
}

function pickRandomNudgeMessage(state) {
  if (!RANDOM_NUDGE_MESSAGES.length) return "";

  if (RANDOM_NUDGE_MESSAGES.length === 1) {
    state.lastMessageIndex = 0;
    return RANDOM_NUDGE_MESSAGES[0];
  }

  let index = randomInt(0, RANDOM_NUDGE_MESSAGES.length - 1);

  // Чтобы одно и то же сообщение не повторялось два раза подряд
  if (index === state.lastMessageIndex) {
    index = (index + 1) % RANDOM_NUDGE_MESSAGES.length;
  }

  state.lastMessageIndex = index;

  return RANDOM_NUDGE_MESSAGES[index];
}

async function maybeSendRandomNudgeAfterGeneration(target, userId) {
  if (!RANDOM_NUDGE_ENABLED) return false;
  if (!target) return false;
  if (!RANDOM_NUDGE_MESSAGES.length) return false;

  const state = getRandomNudgeState(userId);

  state.generatedSinceLastNudge += 1;

  if (state.generatedSinceLastNudge < state.nextAfter) {
    return false;
  }

  state.generatedSinceLastNudge = 0;
  state.nextAfter = getNextRandomNudgeAfter();

  const message = pickRandomNudgeMessage(state);

  if (!message) return false;

  try {
    await sendMaxMessage(target, message);
    return true;
  } catch (error) {
    console.warn(
      "Failed to send random nudge message:",
      error?.message || error
    );

    return false;
  }
}

function clipForContext(text) {
  return String(text || "").slice(0, CONTEXT_MAX_TEXT_CHARS);
}

function getChatContext(userId) {
  const key = String(userId || "unknown");
  const context = userChatContexts.get(key);

  if (!context) return [];

  const now = Date.now();

  if (now - context.updatedAt > CONTEXT_TTL_MS) {
    userChatContexts.delete(key);
    return [];
  }

  return context.messages || [];
}

function rememberChatTurn(userId, userText, assistantText) {
  const key = String(userId || "unknown");

  let context = userChatContexts.get(key);

  if (!context) {
    context = {
      requestCount: 0,
      messages: [],
      updatedAt: Date.now()
    };
  }

  context.requestCount += 1;
  context.updatedAt = Date.now();

  context.messages.push({
    role: "user",
    content: clipForContext(userText)
  });

  context.messages.push({
    role: "assistant",
    content: clipForContext(assistantText)
  });

  // После 3 запросов контекст полностью забывается
  if (context.requestCount >= CONTEXT_MAX_REQUESTS) {
    userChatContexts.delete(key);
    return;
  }

  userChatContexts.set(key, context);
}

function clearChatContext(userId) {
  const key = String(userId || "unknown");
  userChatContexts.delete(key);
}

setInterval(() => {
  const now = Date.now();

  for (const [userId, context] of userChatContexts.entries()) {
    if (now - context.updatedAt > CONTEXT_TTL_MS) {
      userChatContexts.delete(userId);
    }
  }
}, 10 * 60_000).unref?.();

function getUserRequestKey(userId) {
  return String(userId || "unknown");
}

function getTodayDate() {
  // Формат YYYY-MM-DD
  return new Date().toISOString().slice(0, 10);
}

// Асинхронно получаем лимиты пользователя на сегодня
async function getUserRequestCounts(userId) {
  const key = getUserRequestKey(userId);

  // Fallback на память, если нет БД
  if (!dbPool) {
    if (!userRequestCounts[key]) {
      userRequestCounts[key] = { images: 0, chatgpt: 0, videos: 0 };
    }
    return userRequestCounts[key];
  }

  const today = getTodayDate();

  const result = await dbPool.query(
    `
      SELECT images, chatgpt, videos
      FROM ${LIMITS_TABLE}
      WHERE user_id = $1 AND bot_key = $2 AND date = $3
    `,
    [key, BOT_KEY, today]
  );

  if (!result.rows.length) {
    return { images: 0, chatgpt: 0, videos: 0 };
  }

  const row = result.rows[0];

  return {
    images: Number(row.images) || 0,
    chatgpt: Number(row.chatgpt) || 0,
    videos: Number(row.videos) || 0
  };
}

// Увеличиваем счётчик нужного типа
async function incrementRequestCount(userId, type) {
  const key = getUserRequestKey(userId);

  const allowedTypes = ["images", "chatgpt", "videos"];
  if (!allowedTypes.includes(type)) {
    throw new Error(`Unknown request type for limits: ${type}`);
  }

  // Fallback на память
  if (!dbPool) {
    if (!userRequestCounts[key]) {
      userRequestCounts[key] = { images: 0, chatgpt: 0, videos: 0 };
    }
    if (!Number.isFinite(userRequestCounts[key][type])) {
      userRequestCounts[key][type] = 0;
    }
    userRequestCounts[key][type] += 1;
    return;
  }

  const today = getTodayDate();

  // Динамически подставляем нужную колонку (images/chatgpt/videos)
  const col = type;

  await dbPool.query(
    `
      INSERT INTO ${LIMITS_TABLE} (user_id, bot_key, date, ${col})
      VALUES ($1, $2, $3, 1)
      ON CONFLICT (user_id, bot_key, date)
      DO UPDATE SET ${col} = ${LIMITS_TABLE}.${col} + 1
    `,
    [key, BOT_KEY, today]
  );
}

async function getUserPremiumUntil(userId) {
  if (!dbPool) return null;

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      SELECT premium_until
      FROM max_bot_premium_users
      WHERE user_id = $1
        AND bot_key = $2
        AND premium_until > NOW()
      LIMIT 1
    `,
    [key, BOT_KEY]
  );

  return result.rows[0]?.premium_until || null;
}

async function isPremiumUser(userId) {
  return Boolean(await getUserPremiumUntil(userId));
}

async function grantPremiumByAdmin(targetUserId, days = PREMIUM_DURATION_DAYS) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for /givegpt");
  }

  const userId = getUserRequestKey(targetUserId).trim();
  const durationDays = Math.max(1, Math.min(3650, Number(days) || PREMIUM_DURATION_DAYS));
  const manualPaymentId = `admin_givegpt_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  const result = await dbPool.query(
    `
      INSERT INTO max_bot_premium_users (
        user_id,
        bot_key,
        premium_until,
        last_payment_id
      )
      VALUES (
        $1,
        $2,
        NOW() + ($3::int * INTERVAL '1 day'),
        $4
      )
      ON CONFLICT (user_id, bot_key)
      DO UPDATE SET
        premium_until = GREATEST(NOW(), max_bot_premium_users.premium_until) + ($3::int * INTERVAL '1 day'),
        last_payment_id = $4,
        updated_at = NOW()
      RETURNING premium_until
    `,
    [userId, BOT_KEY, durationDays, manualPaymentId]
  );

  await persistTemporaryHoroscopeProfileForPremiumUser(userId).catch((error) => {
    console.warn("Failed to persist horoscope profile after /givegpt:", error?.message || error);
  });

  return {
    userId,
    days: durationDays,
    premiumUntil: result.rows[0]?.premium_until || null
  };
}

function formatPremiumUntilRu(value) {
  if (!value) return "неизвестно";

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function isPremiumRaffleActive(date = new Date()) {
  if (!PREMIUM_RAFFLE_ENABLED) return false;

  const current = date instanceof Date ? date : new Date(date);
  const start = new Date(PREMIUM_RAFFLE_START_AT);
  const end = new Date(PREMIUM_RAFFLE_END_AT);

  if (Number.isNaN(current.getTime()) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return false;
  }

  return current >= start && current <= end;
}

function makePremiumRaffleToken() {
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}

async function createPremiumRaffleTicket(client, userId, paymentId) {
  if (!client || !isPremiumRaffleActive()) {
    return null;
  }

  const key = getUserRequestKey(userId);
  const cleanPaymentId = String(paymentId || "").trim();

  if (!isValidUserIdForBroadcast(key) || !cleanPaymentId) {
    return null;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = makePremiumRaffleToken();

    try {
      const result = await client.query(
        `
          INSERT INTO max_bot_premium_raffle_tickets (
            bot_key, user_id, payment_id, token
          )
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (bot_key, payment_id)
          DO UPDATE SET user_id = EXCLUDED.user_id
          RETURNING token, created_at
        `,
        [BOT_KEY, key, cleanPaymentId, token]
      );

      return {
        token: result.rows[0]?.token || token,
        createdAt: result.rows[0]?.created_at || null
      };
    } catch (error) {
      if (String(error?.code || "") === "23505") {
        continue;
      }

      throw error;
    }
  }

  return null;
}

async function backfillPremiumRaffleTicketsFromPayments() {
  if (!dbPool) return 0;

  const missingResult = await dbPool.query(
    `
      SELECT p.payment_id, p.user_id, p.updated_at
      FROM max_bot_premium_payments p
      LEFT JOIN max_bot_premium_raffle_tickets t
        ON t.bot_key = p.bot_key
       AND t.payment_id = p.payment_id
      WHERE p.bot_key = $1
        AND p.status = 'succeeded'
        AND COALESCE(p.raw->'metadata'->>'product', '') = 'premium_month'
        AND p.updated_at >= $2::timestamptz
        AND p.updated_at <= $3::timestamptz
        AND t.id IS NULL
      ORDER BY p.updated_at ASC
      LIMIT 1000
    `,
    [BOT_KEY, PREMIUM_RAFFLE_START_AT, PREMIUM_RAFFLE_END_AT]
  );

  let created = 0;

  for (const row of missingResult.rows) {
    const userId = getUserRequestKey(row.user_id);
    const paymentId = String(row.payment_id || "").trim();

    if (!isValidUserIdForBroadcast(userId) || !paymentId) continue;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = makePremiumRaffleToken();

      try {
        const insertResult = await dbPool.query(
          `
            INSERT INTO max_bot_premium_raffle_tickets (
              bot_key, user_id, payment_id, token, created_at
            )
            VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))
            ON CONFLICT (bot_key, payment_id) DO NOTHING
            RETURNING id
          `,
          [BOT_KEY, userId, paymentId, token, row.updated_at || null]
        );

        if (insertResult.rowCount > 0) {
          created += 1;
        }

        break;
      } catch (error) {
        if (String(error?.code || "") === "23505") {
          continue;
        }

        throw error;
      }
    }
  }

  return created;
}

function buildPremiumRaffleSuccessLines(raffleTicket) {
  if (!raffleTicket?.token) return [];

  return [
    "",
    `🎁 Ваш токен участника акции: **${raffleTicket.token}**`,
    `Участвуйте в [акции](${getPremiumRaffleRulesUrl()}) с розыгрышем призов.`,
    "Каждая новая покупка Premium добавляет ещё один токен и повышает шанс на победу."
  ];
}

function formatPremiumRafflePeriodRu() {
  return "10.06.2026 — 10.09.2026";
}

async function getPremiumRaffleStats() {
  if (!dbPool) return null;

  await backfillPremiumRaffleTicketsFromPayments();

  const result = await dbPool.query(
    `
      SELECT
        COUNT(*)::int AS tickets_count,
        COUNT(DISTINCT user_id)::int AS unique_users_count
      FROM max_bot_premium_raffle_tickets
      WHERE bot_key = $1
        AND created_at >= $2::timestamptz
        AND created_at <= $3::timestamptz
    `,
    [BOT_KEY, PREMIUM_RAFFLE_START_AT, PREMIUM_RAFFLE_END_AT]
  );

  return {
    ticketsCount: Number(result.rows[0]?.tickets_count || 0),
    uniqueUsersCount: Number(result.rows[0]?.unique_users_count || 0)
  };
}

function pickPremiumRaffleWinners(tickets, prizeCount, prizes) {
  const pool = Array.isArray(tickets) ? [...tickets] : [];
  const winners = [];
  const maxWinners = Math.max(1, Math.min(Number(prizeCount) || 1, pool.length));

  while (pool.length && winners.length < maxWinners) {
    const index = crypto.randomInt(pool.length);
    const selected = pool[index];
    const prize = prizes[winners.length] || `Приз ${winners.length + 1}`;

    winners.push({
      place: winners.length + 1,
      prize,
      user_id: selected.user_id,
      token: selected.token,
      first_name: selected.first_name || ""
    });

    // Один пользователь не забирает сразу несколько призов, но каждый его токен повышает шанс на первый выигрыш.
    for (let i = pool.length - 1; i >= 0; i -= 1) {
      if (String(pool[i].user_id) === String(selected.user_id)) {
        pool.splice(i, 1);
      }
    }
  }

  return winners;
}

async function runPremiumRaffle({ adminUserId, mode = "test", prizeCount = 1, prizes = [] }) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for premium raffle");
  }

  await backfillPremiumRaffleTicketsFromPayments();

  const normalizedMode = ["draw", "run", "real", "старт"].includes(String(mode || "").toLowerCase())
    ? "draw"
    : "test";

  const ticketsResult = await dbPool.query(
    `
      SELECT
        t.user_id,
        t.token,
        t.created_at,
        COALESCE(NULLIF(b.first_name, ''), '') AS first_name
      FROM max_bot_premium_raffle_tickets t
      LEFT JOIN max_bot_broadcast_users b
        ON b.user_id = t.user_id
       AND b.bot_key = t.bot_key
      WHERE t.bot_key = $1
        AND t.created_at >= $2::timestamptz
        AND t.created_at <= $3::timestamptz
      ORDER BY t.created_at ASC
    `,
    [BOT_KEY, PREMIUM_RAFFLE_START_AT, PREMIUM_RAFFLE_END_AT]
  );

  const tickets = ticketsResult.rows.map((row) => ({
    user_id: String(row.user_id || ""),
    token: String(row.token || ""),
    first_name: String(row.first_name || "").replace(/[\r\n]+/g, " ").trim().slice(0, 80)
  })).filter((row) => row.user_id && row.token);

  const uniqueUsersCount = new Set(tickets.map((ticket) => ticket.user_id)).size;
  const finalPrizes = Array.isArray(prizes) && prizes.length
    ? prizes.slice(0, prizeCount)
    : Array.from({ length: prizeCount }, (_, index) => `Приз ${index + 1}`);
  const winners = pickPremiumRaffleWinners(tickets, prizeCount, finalPrizes);

  const runResult = await dbPool.query(
    `
      INSERT INTO max_bot_premium_raffle_runs (
        bot_key, admin_user_id, mode, prize_count, prizes, winners, tickets_count, unique_users_count
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
      RETURNING id, created_at
    `,
    [
      BOT_KEY,
      String(adminUserId || ""),
      normalizedMode,
      Number(prizeCount) || 1,
      JSON.stringify(finalPrizes),
      JSON.stringify(winners),
      tickets.length,
      uniqueUsersCount
    ]
  );

  return {
    id: runResult.rows[0]?.id || null,
    mode: normalizedMode,
    prizes: finalPrizes,
    winners,
    ticketsCount: tickets.length,
    uniqueUsersCount
  };
}

async function handlePremiumRaffleCommand(target, adminUserId, userText) {
  if (!isPremiumRaffleCommand(userText)) return false;

  if (!isAdminUser(adminUserId)) {
    console.warn(`User ${adminUserId} tried to use premium raffle command`);
    await sendMaxMessage(target, "⛔ Эта команда доступна только администратору.");
    return true;
  }

  if (!dbPool) {
    await sendMaxMessage(target, "⚠️ DATABASE_URL не задан. Акция Premium недоступна.");
    return true;
  }

  const parsed = parsePremiumRaffleCommand(userText);

  if (!parsed) return false;

  if (["stats", "stat", "стат"].includes(parsed.action)) {
    const stats = await getPremiumRaffleStats();

    await sendMaxMessage(
      target,
      [
        "🎁 **Статистика акции Premium**",
        "",
        `Период: **${formatPremiumRafflePeriodRu()}**`,
        `Токенов: **${stats?.ticketsCount || 0}**`,
        `Участников: **${stats?.uniqueUsersCount || 0}**`,
        "",
        `Правила: [акция](${getPremiumRaffleRulesUrl()})`
      ].join("\n")
    );

    return true;
  }

  try {
    const result = await runPremiumRaffle({
      adminUserId,
      mode: parsed.action,
      prizeCount: parsed.prizeCount,
      prizes: parsed.prizes
    });

    const winnersText = result.winners.length
      ? result.winners.map((winner) => {
          const name = winner.first_name ? ` / ${winner.first_name}` : "";
          return `${winner.place}. ${winner.prize} — user_id **${winner.user_id}**${name}, токен **${winner.token}**`;
        }).join("\n")
      : "Победителей нет: пока нет токенов в акции.";

    await sendMaxMessage(
      target,
      [
        result.mode === "draw"
          ? "🏆 **Розыгрыш акции Premium запущен**"
          : "🧪 **Тестовый розыгрыш акции Premium**",
        "",
        `ID запуска: **${result.id || "-"}**`,
        `Период акции: **${formatPremiumRafflePeriodRu()}**`,
        `Всего токенов: **${result.ticketsCount}**`,
        `Уникальных участников: **${result.uniqueUsersCount}**`,
        `Призов выбрано: **${result.prizes.length}**`,
        "",
        winnersText,
        "",
        result.mode === "test"
          ? "Это тест: можно запускать несколько раз для проверки. Реальный запуск: `/gptpromo draw 3 Приз 1; Приз 2; Приз 3`."
          : "Результат сохранён в базе. Перед публикацией проверьте правила акции и выдачу призов."
      ].join("\n")
    );
  } catch (error) {
    console.error("Premium raffle command failed:", error);
    await sendMaxMessage(target, "⚠️ Не получилось запустить акцию. Проверьте DATABASE_URL и таблицы акции.");
  }

  return true;
}

async function handleGiveGptCommand(target, adminUserId, userText) {
  if (!isGiveGptCommand(userText)) return false;

  if (!isAdminUser(adminUserId)) {
    console.warn(`User ${adminUserId} tried to use /givegpt command`);
    await sendMaxMessage(target, "⛔ Эта команда доступна только администратору.");
    return true;
  }

  if (!dbPool) {
    await sendMaxMessage(target, "⚠️ DATABASE_URL не задан. /givegpt недоступна.");
    return true;
  }

  const parsed = parseGiveGptCommand(userText);

  if (!parsed || !isValidUserIdForBroadcast(parsed.targetUserId)) {
    await sendMaxMessage(
      target,
      [
        "✍️ **Формат команды:**",
        "`/givegpt USER_ID`",
        "",
        "Можно указать количество дней:",
        "`/givegpt USER_ID 30`",
        "",
        `Если дни не указаны, будет выдано **${PREMIUM_DURATION_DAYS} дней** Premium.`
      ].join("\n")
    );
    return true;
  }

  try {
    const granted = await grantPremiumByAdmin(parsed.targetUserId, parsed.days);

    await sendMaxMessage(
      target,
      [
        "✅ **Premium выдан вручную**",
        "",
        `Пользователь: **${granted.userId}**`,
        `Срок: **${granted.days} дн.**`,
        `Premium до: **${formatPremiumUntilRu(granted.premiumUntil)} МСК**`,
        "",
        "Команда не создаёт платёж в YooKassa, только обновляет доступ Premium в базе."
      ].join("\n")
    );
  } catch (error) {
    console.error("/givegpt failed:", error);
    await sendMaxMessage(target, "⚠️ Не получилось выдать Premium. Проверьте DATABASE_URL и таблицу Premium.");
  }

  return true;
}

async function getUserDailyLimits(userId) {
  const premium = await isPremiumUser(userId);

  return {
    premium,
    images: premium ? PREMIUM_IMAGE_REQUEST_LIMIT : IMAGE_REQUEST_LIMIT,
    chatgpt: premium ? PREMIUM_CHATGPT_REQUEST_LIMIT : CHATGPT_REQUEST_LIMIT,
    videos: premium ? PREMIUM_VIDEO_REQUEST_LIMIT : VIDEO_REQUEST_LIMIT
  };
}
async function getVideoAccessForUser(userId) {
  const counts = await getUserRequestCounts(userId);
  const limits = await getUserDailyLimits(userId);

  const usedPremiumVideos = Number(counts.videos || 0);
  const premiumVideoLimit = Number(limits.videos || 0);

  // Premium оставляет старую логику: 1 «оживить фото / видео по фото» в день.
  // Это дневной лимит, а не накопительный бонусный кредит.
  if (limits.premium && usedPremiumVideos < premiumVideoLimit) {
    return {
      allowed: true,
      source: "premium",
      premium: true,
      usedPremiumVideos,
      premiumVideoLimit,
      premiumVideosLeft: premiumVideoLimit - usedPremiumVideos
    };
  }

  const credits = await getVideoCredits(userId);

  if (credits > 0) {
    return {
      allowed: true,
      source: "credit",
      premium: limits.premium,
      credits
    };
  }

  return {
    allowed: false,
    source: "none",
    premium: limits.premium,
    usedPremiumVideos,
    premiumVideoLimit,
    credits: 0
  };
}

async function getProductCardCredits(userId) {
  if (!dbPool) return 0;

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      SELECT credits
      FROM max_bot_product_card_credits
      WHERE user_id = $1 AND bot_key = $2
      LIMIT 1
    `,
    [key, BOT_KEY]
  );

  return Number(result.rows[0]?.credits || 0);
}

async function addProductCardCredit(userId, credits = 1) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for product card credits");
  }

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      INSERT INTO max_bot_product_card_credits (user_id, bot_key, credits)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, bot_key)
      DO UPDATE SET
        credits = max_bot_product_card_credits.credits + EXCLUDED.credits,
        updated_at = NOW()
      RETURNING credits
    `,
    [key, BOT_KEY, credits]
  );

  return Number(result.rows[0]?.credits || 0);
}

async function consumeProductCardCredit(userId) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for product card credits");
  }

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      UPDATE max_bot_product_card_credits
      SET credits = credits - 1,
          updated_at = NOW()
      WHERE user_id = $1
        AND bot_key = $2
        AND credits > 0
      RETURNING credits
    `,
    [key, BOT_KEY]
  );

  return {
    consumed: Boolean(result.rows.length),
    creditsLeft: Number(result.rows[0]?.credits || 0)
  };
}

async function getMusicCredits(userId) {
  if (!dbPool) return 0;

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      SELECT credits
      FROM max_bot_music_credits
      WHERE user_id = $1 AND bot_key = $2
      LIMIT 1
    `,
    [key, BOT_KEY]
  );

  return Number(result.rows[0]?.credits || 0);
}

async function addMusicCredit(userId, credits = 1) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for music credits");
  }

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      INSERT INTO max_bot_music_credits (user_id, bot_key, credits)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, bot_key)
      DO UPDATE SET
        credits = max_bot_music_credits.credits + EXCLUDED.credits,
        updated_at = NOW()
      RETURNING credits
    `,
    [key, BOT_KEY, credits]
  );

  return Number(result.rows[0]?.credits || 0);
}

async function consumeMusicCredit(userId) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for music credits");
  }

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      UPDATE max_bot_music_credits
      SET credits = credits - 1,
          updated_at = NOW()
      WHERE user_id = $1
        AND bot_key = $2
        AND credits > 0
      RETURNING credits
    `,
    [key, BOT_KEY]
  );

  return {
    consumed: Boolean(result.rows.length),
    creditsLeft: Number(result.rows[0]?.credits || 0)
  };
}

async function getVideoCredits(userId) {
  if (!dbPool) return 0;

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      SELECT credits
      FROM max_bot_video_credits
      WHERE user_id = $1 AND bot_key = $2
      LIMIT 1
    `,
    [key, BOT_KEY]
  );

  return Number(result.rows[0]?.credits || 0);
}

async function addVideoCredit(userId, credits = 1) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for video credits");
  }

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      INSERT INTO max_bot_video_credits (user_id, bot_key, credits)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, bot_key)
      DO UPDATE SET
        credits = max_bot_video_credits.credits + EXCLUDED.credits,
        updated_at = NOW()
      RETURNING credits
    `,
    [key, BOT_KEY, credits]
  );

  return Number(result.rows[0]?.credits || 0);
}

async function consumeVideoCredit(userId) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for video credits");
  }

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      UPDATE max_bot_video_credits
      SET credits = credits - 1,
          updated_at = NOW()
      WHERE user_id = $1
        AND bot_key = $2
        AND credits > 0
      RETURNING credits
    `,
    [key, BOT_KEY]
  );

  return {
    consumed: Boolean(result.rows.length),
    creditsLeft: Number(result.rows[0]?.credits || 0)
  };
}

async function getPromptVideoCredits(userId) {
  if (!dbPool) return 0;

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      SELECT credits
      FROM max_bot_prompt_video_credits
      WHERE user_id = $1 AND bot_key = $2
      LIMIT 1
    `,
    [key, BOT_KEY]
  );

  return Number(result.rows[0]?.credits || 0);
}

async function addPromptVideoCredit(userId, credits = 1) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for prompt video credits");
  }

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      INSERT INTO max_bot_prompt_video_credits (user_id, bot_key, credits)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, bot_key)
      DO UPDATE SET
        credits = max_bot_prompt_video_credits.credits + EXCLUDED.credits,
        updated_at = NOW()
      RETURNING credits
    `,
    [key, BOT_KEY, credits]
  );

  return Number(result.rows[0]?.credits || 0);
}

async function consumePromptVideoCredit(userId) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for prompt video credits");
  }

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      UPDATE max_bot_prompt_video_credits
      SET credits = credits - 1,
          updated_at = NOW()
      WHERE user_id = $1
        AND bot_key = $2
        AND credits > 0
      RETURNING credits
    `,
    [key, BOT_KEY]
  );

  return {
    consumed: Boolean(result.rows.length),
    creditsLeft: Number(result.rows[0]?.credits || 0)
  };
}

async function getPromptVideoAccessForUser(userId) {
  const credits = await getPromptVideoCredits(userId);

  if (credits > 0) {
    return {
      allowed: true,
      source: "prompt_video_credit",
      credits
    };
  }

  return {
    allowed: false,
    source: "none",
    credits: 0
  };
}

async function getFamilyVideoCredits(userId) {
  if (!dbPool) return 0;

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      SELECT credits
      FROM max_bot_family_video_credits
      WHERE user_id = $1 AND bot_key = $2
      LIMIT 1
    `,
    [key, BOT_KEY]
  );

  return Number(result.rows[0]?.credits || 0);
}

async function consumeFamilyVideoCredit(userId) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for family video credits");
  }

  const key = getUserRequestKey(userId);

  const result = await dbPool.query(
    `
      UPDATE max_bot_family_video_credits
      SET credits = credits - 1,
          updated_at = NOW()
      WHERE user_id = $1
        AND bot_key = $2
        AND credits > 0
      RETURNING credits
    `,
    [key, BOT_KEY]
  );

  return {
    consumed: Boolean(result.rows.length),
    creditsLeft: Number(result.rows[0]?.credits || 0)
  };
}

async function getFamilyVideoAccessForUser(userId) {
  const credits = await getFamilyVideoCredits(userId);

  if (credits > 0) {
    return {
      allowed: true,
      source: "family_credit",
      credits
    };
  }

  return {
    allowed: false,
    source: "none",
    credits: 0
  };
}

// Проверяем, достигнут ли лимит по типу
async function isRequestLimitReached(userId, type, limit) {
  const counts = await getUserRequestCounts(userId);
  return (counts[type] || 0) >= limit;
}

function isSubscriptionVerified(userId) {
  return subscriptionVerifiedUsers.has(String(userId));
}

function markSubscriptionVerified(userId) {
  subscriptionVerifiedUsers.add(String(userId));
}

// Проверяем, нужна ли подписка для текущего запроса
async function isSubscriptionRequiredForRequest(userId, type) {
  if (await isPremiumUser(userId)) return false;
  if (isSubscriptionVerified(userId)) return false;

  const counts = await getUserRequestCounts(userId);

  if (type === "images") {
    return counts.images >= IMAGE_REQUESTS_BEFORE_SUBSCRIPTION;
  }

  if (type === "chatgpt") {
    return counts.chatgpt >= CHATGPT_REQUESTS_BEFORE_SUBSCRIPTION;
  }

  if (type === "videos") {
    return counts.videos >= VIDEO_REQUESTS_BEFORE_SUBSCRIPTION;
  }

  return false;
}

// Сбрасываем лимиты только для in-memory варианта (когда нет БД)
function resetDailyLimits() {
  setInterval(() => {
    if (!dbPool) {
      Object.keys(userRequestCounts).forEach((key) => {
        userRequestCounts[key] = { images: 0, chatgpt: 0, videos: 0 };
      });
    }
  }, 86400000); // каждый день
}

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Базовая модель для обычной генерации фото
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5";
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || "1024x1536";
const OPENAI_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "low";
const OPENAI_IMAGE_OUTPUT_FORMAT = process.env.OPENAI_IMAGE_OUTPUT_FORMAT || "png";

const FIRST_IMAGE_MODEL = process.env.FIRST_IMAGE_MODEL || "gpt-image-1.5";
const FIRST_IMAGE_SIZE = process.env.FIRST_IMAGE_SIZE || "1024x1536";
const FIRST_IMAGE_QUALITY = process.env.FIRST_IMAGE_QUALITY || "low";

const PREMIUM_IMAGE_MODEL = process.env.PREMIUM_IMAGE_MODEL || "gpt-image-2";
const PREMIUM_IMAGE_SIZE = process.env.PREMIUM_IMAGE_SIZE || "1024x1024";
const PREMIUM_IMAGE_QUALITY = process.env.PREMIUM_IMAGE_QUALITY || "low";

const PRODUCT_CARD_IMAGE_MODEL =
  process.env.PRODUCT_CARD_IMAGE_MODEL || PREMIUM_IMAGE_MODEL;

const PRODUCT_CARD_IMAGE_SIZE =
  process.env.PRODUCT_CARD_IMAGE_SIZE || OPENAI_IMAGE_SIZE;

const PRODUCT_CARD_IMAGE_QUALITY =
  process.env.PRODUCT_CARD_IMAGE_QUALITY || "high";

const STADIUM_STYLE_IMAGE_MODEL =
  process.env.STADIUM_STYLE_IMAGE_MODEL || "gpt-image-2";

const STADIUM_STYLE_IMAGE_SIZE =
  process.env.STADIUM_STYLE_IMAGE_SIZE || OPENAI_IMAGE_SIZE;

const STADIUM_STYLE_IMAGE_QUALITY =
  process.env.STADIUM_STYLE_IMAGE_QUALITY || "high";

function getPhotoStyleImageOptions(styleKey) {
  const key = String(styleKey || "").trim();

  if (key === "lemonade") {
    return {
      model: STADIUM_STYLE_IMAGE_MODEL,
      size: STADIUM_STYLE_IMAGE_SIZE,
      quality: STADIUM_STYLE_IMAGE_QUALITY
    };
  }

  return null;
}

const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const MAX_API_BASE = process.env.MAX_API_BASE || "https://platform-api.max.ru";
const MAX_WEBHOOK_SECRET = process.env.MAX_WEBHOOK_SECRET || "";
const MAX_ATTACHMENT_RETRIES = Number(process.env.MAX_ATTACHMENT_RETRIES || 5);
const MAX_INPUT_IMAGE_BYTES = Number(process.env.MAX_INPUT_IMAGE_BYTES || 20 * 1024 * 1024);
const STATUS_UPDATE_INTERVAL_MS = Number(process.env.STATUS_UPDATE_INTERVAL_MS || 1500);

if (!MAX_BOT_TOKEN) console.warn("MAX_BOT_TOKEN is not set");
if (!OPENAI_API_KEY) console.warn("OPENAI_API_KEY is not set");
if (!GEMINI_API_KEY) console.warn("GEMINI_API_KEY is not set");
if (!FAL_KEY) console.warn("FAL_KEY is not set");

const IMAGE_COMMAND_RE =
  /^\s*\/(?:img|image|photo|фото|картинка|изображение)(?=$|[\s:—-])/iu;

const IMAGE_VERB_RE =
  /(?:^|[^\p{L}\p{N}_])(?:Нарисуй|нарисовать|сгенерируй|сгенерировать|создай|создать|сделай|сделать|генерируй|generate|make|create)(?=$|[^\p{L}\p{N}_])/iu;

const IMAGE_OBJECT_RE =
  /(?:^|[^\p{L}\p{N}_])(?:фото|фотографи[яюе]|фотку|картинк[ауие]|изображени[еяю]|рисунок|арт|логотип|аватар|постер|баннер|image|photo|picture|drawing|art|logo|avatar|poster|banner)(?=$|[^\p{L}\p{N}_])/iu;

const STATUS_DOT_FRAMES = [".", "..", "..."];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const OPENAI_TEXT_CONCURRENCY = Number(process.env.OPENAI_TEXT_CONCURRENCY || 10);
const OPENAI_IMAGE_CONCURRENCY = Number(process.env.OPENAI_IMAGE_CONCURRENCY || 2);

function createConcurrencyLimiter(maxConcurrent) {
  let activeCount = 0;
  const queue = [];

  async function runNext() {
    if (activeCount >= maxConcurrent) return;

    const item = queue.shift();
    if (!item) return;

    activeCount += 1;

    try {
      const result = await item.task();
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      activeCount -= 1;
      runNext();
    }
  }

  return function limit(task) {
    return new Promise((resolve, reject) => {
      queue.push({
        task,
        resolve,
        reject
      });

      runNext();
    });
  };
}

const runTextOpenAI = createConcurrencyLimiter(OPENAI_TEXT_CONCURRENCY);
const runImageOpenAI = createConcurrencyLimiter(OPENAI_IMAGE_CONCURRENCY);
const GEMINI_MUSIC_CONCURRENCY = Number(process.env.GEMINI_MUSIC_CONCURRENCY || 1);
const runMusicGemini = createConcurrencyLimiter(GEMINI_MUSIC_CONCURRENCY);

function getIncomingText(update) {
  return update?.message?.body?.text?.trim() || update?.payload?.trim() || "";
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

    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }

    if (typeof value === "object") {
      const nested =
        value.payload ||
        value.data ||
        value.value ||
        value.text;

      if (nested !== undefined && nested !== null) {
        const text = String(nested).trim();
        if (text) return text;
      }
    }
  }

  return "";
}

function getCallbackId(update) {
  return String(
    update?.callback?.callback_id ||
    update?.callback?.id ||
    update?.callback_id ||
    update?.message_callback?.callback_id ||
    ""
  ).trim();
}

function isSubscriptionCheckPayload(payload) {
  const value = String(payload || "").trim();

  return (
    value === SUBSCRIPTION_CHECK_PAYLOAD ||
    value.startsWith(`${SUBSCRIPTION_CHECK_PAYLOAD}:`)
  );
}

function getUserIdFromSubscriptionPayload(payload) {
  const value = String(payload || "").trim();

  if (!value.startsWith(`${SUBSCRIPTION_CHECK_PAYLOAD}:`)) {
    return "";
  }

  return value.slice(`${SUBSCRIPTION_CHECK_PAYLOAD}:`.length).trim();
}

function getReplyTarget(update) {
  const callback = update?.callback;
  const callbackMessage = callback?.message;
  const callbackRecipient = callbackMessage?.recipient;

  // Для callback сначала пытаемся ответить туда, где была нажата кнопка
  if (callbackRecipient?.chat_id) {
    return { type: "chat_id", id: callbackRecipient.chat_id };
  }

  if (callbackRecipient?.user_id) {
    return { type: "user_id", id: callbackRecipient.user_id };
  }

  const message = update?.message;
  const recipient = message?.recipient;

  if (recipient?.chat_id) {
    return { type: "chat_id", id: recipient.chat_id };
  }

  if (recipient?.user_id) {
    return { type: "user_id", id: recipient.user_id };
  }

  if (message?.sender?.user_id) {
    return { type: "user_id", id: message.sender.user_id };
  }

  const callbackUserId = callback?.user?.user_id;

  if (callbackUserId) {
    return { type: "user_id", id: callbackUserId };
  }

  if (callbackMessage?.sender?.user_id) {
    return { type: "user_id", id: callbackMessage.sender.user_id };
  }

  if (update?.chat_id) {
    return { type: "chat_id", id: update.chat_id };
  }

  if (update?.user?.user_id) {
    return { type: "user_id", id: update.user.user_id };
  }

  if (update?.user_id) {
    return { type: "user_id", id: update.user_id };
  }

  return null;
}

function splitForMax(text, maxLength = 3900) {
  const clean = String(text || "").trim();
  if (!clean) return ["Не получилось сформировать ответ."];

  const chunks = [];
  for (let i = 0; i < clean.length; i += maxLength) {
    chunks.push(clean.slice(i, i + maxLength));
  }

  return chunks;
}

function isImageRequest(userText, hasIncomingImage) {
  if (hasIncomingImage) return true;

  const text = String(userText || "").trim();
  if (!text) return false;

  if (IMAGE_COMMAND_RE.test(text)) return true;

  return IMAGE_VERB_RE.test(text) && IMAGE_OBJECT_RE.test(text);
}

const VIDEO_PROMPT_RE_1 =
  /(?:^|[^\p{L}\p{N}_])(?:создай|создать|сделай|сгенерируй|generate|make|create)\s+видео(?:\b|$)/iu;

const VIDEO_PROMPT_RE_2 =
  /(?:^|[^\p{L}\p{N}_])(?:оживи|оживить)\s+(?:фото|картинку|изображение)(?:\b|$)/iu;

const VIDEO_PROMPT_RE_3 =
  /(?:^|[^\p{L}\p{N}_])(?:оживи|оживить)\s+видео(?:\b|$)/iu;

function isVideoRequest(userText, hasIncomingImage) {
  if (!hasIncomingImage) return false;

  const t = String(userText || "").toLowerCase();

  // ВАЖНО: сюда добавляем "оживи фото ..." чтобы оно всегда запускало ВИДЕО
  return (
    /созда(й|ть)\s*видео/.test(t) ||
    /оживи(ть)?\s*видео/.test(t) ||
    /оживи(ть)?\s*фото/.test(t)
  );
}

function isPromptVideoRequest(userText) {
  const text = String(userText || "").trim();
  if (!text) return false;

  return VIDEO_PROMPT_RE_1.test(text);
}

async function maxRequest(path, options = {}) {
  const url = new URL(`${MAX_API_BASE}${path}`);

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers = {
    Authorization: MAX_BOT_TOKEN
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method: options.method || "GET",
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
    const details = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`MAX API ${response.status}: ${details}`);
  }

  return body;
}

async function yookassaRequest(path, options = {}) {
  if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
    throw new Error("YOOKASSA_SHOP_ID or YOOKASSA_SECRET_KEY is not set");
  }

  const url = `${YOOKASSA_API_BASE}${path}`;

  const headers = {
    Authorization: `Basic ${Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString("base64")}`
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (options.idempotenceKey) {
    headers["Idempotence-Key"] = options.idempotenceKey;
  }

  const response = await fetch(url, {
    method: options.method || "GET",
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
    const details = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`YooKassa API ${response.status}: ${details}`);
  }

  return body;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// --------------------------------------------------
// Мягкая нормализация e-mail с резервным e-mail
// --------------------------------------------------

function normalizeReceiptEmail(value) {
  const email = String(value || "").trim();

  // Если поле пустое — вернём пустую строку, чтобы показать пользователю ошибку "Введите e-mail"
  if (!email) return "";

  // Если в тексте есть символ @ — используем его напрямую
  if (email.includes("@")) return email;

  // Если нет @ — используем резервный e-mail
  return YOOKASSA_RECEIPT_EMAIL;
}

function getPaymentUserIdFromRequest(req) {
  return String(req.body?.user_id || req.query?.user_id || "").trim();
}

function getPaymentModeFromRequest(req) {
  return String(req.body?.mode || req.query?.mode || "").trim();
}

function getPaymentReceiptEmailFromRequest(req) {
  return normalizeReceiptEmail(req.body?.receipt_email || req.query?.receipt_email || "");
}

function buildYooKassaReceipt(description, priceValue, receiptEmail) {
  const email = normalizeReceiptEmail(receiptEmail);

  if (!email) {
    throw new Error("Valid receipt email is required");
  }

  const receipt = {
    customer: {
      email
    },
    items: [
      {
        description,
        quantity: "1.00",
        amount: {
          value: priceValue,
          currency: "RUB"
        },
        vat_code: YOOKASSA_VAT_CODE,
        payment_mode: "full_payment",
        payment_subject: "service"
      }
    ]
  };

  if (YOOKASSA_TAX_SYSTEM_CODE) {
    receipt.tax_system_code = YOOKASSA_TAX_SYSTEM_CODE;
  }

  return receipt;
}

function renderReceiptEmailForm(res, {
  title,
  priceRub,
  userId,
  mode = "",
  errorText = ""
}) {
  const safeTitle = escapeHtml(title || "Оплата");
  const safePrice = Number(priceRub || 0).toFixed(0);
  const safeUserId = escapeHtml(userId);
  const safeMode = escapeHtml(mode);
  const safeError = escapeHtml(errorText);

  res
    .status(errorText ? 400 : 200)
    .type("text/html; charset=utf-8")
    .send(`
      <!doctype html>
      <html lang="ru">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${safeTitle}</title>
          <style>
            * {
              box-sizing: border-box;
            }

            body {
              margin: 0;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 24px;
              font-family: Arial, sans-serif;
              background: #f4f5f7;
              color: #111827;
            }

            .card {
              width: 100%;
              max-width: 430px;
              background: #ffffff;
              border-radius: 18px;
              padding: 26px;
              box-shadow: 0 18px 45px rgba(15, 23, 42, 0.12);
            }

            h1 {
              margin: 0 0 10px;
              font-size: 24px;
              line-height: 1.2;
            }

            .price {
              margin: 0 0 18px;
              font-size: 18px;
              font-weight: 700;
            }

            .hint {
              margin: 0 0 18px;
              color: #4b5563;
              line-height: 1.45;
              font-size: 14px;
            }

            .error {
              margin: 0 0 14px;
              padding: 10px 12px;
              border-radius: 10px;
              background: #fee2e2;
              color: #991b1b;
              font-size: 14px;
            }

            label {
              display: block;
              margin-bottom: 8px;
              font-weight: 700;
              font-size: 14px;
            }

            input[type="email"] {
              width: 100%;
              padding: 14px 15px;
              border: 1px solid #d1d5db;
              border-radius: 12px;
              font-size: 16px;
              outline: none;
            }

            input[type="email"]:focus {
              border-color: #2563eb;
              box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
            }

            button {
              width: 100%;
              margin-top: 18px;
              padding: 14px 16px;
              border: 0;
              border-radius: 12px;
              background: #2563eb;
              color: #ffffff;
              font-size: 16px;
              font-weight: 700;
              cursor: pointer;
            }

            button:hover {
              background: #1d4ed8;
            }

            .small {
              margin-top: 14px;
              font-size: 12px;
              color: #6b7280;
              line-height: 1.4;
            }
          </style>
        </head>
        <body>
          <main class="card">
            <h1>${safeTitle}</h1>
            <p class="price">Стоимость: ${safePrice} ₽</p>
            <p class="hint">
              Введите email, на который должен прийти чек. После этого откроется страница оплаты YooKassa.
            </p>

            ${safeError ? `<div class="error">${safeError}</div>` : ""}

            <form method="post">
              <input type="hidden" name="user_id" value="${safeUserId}">
              ${safeMode ? `<input type="hidden" name="mode" value="${safeMode}">` : ""}

              <label for="receipt_email">Email для чека</label>
              <input
                id="receipt_email"
                name="receipt_email"
                type="email"
                placeholder="example@mail.ru"
                autocomplete="email"
                required
              >

              <button type="submit">Перейти к оплате</button>
            </form>

            <p class="small">
              Чек будет сформирован на указанный email при успешной оплате.
            </p>
          </main>
        </body>
      </html>
    `);
}

function buildYooKassaBuyRouteHandler({
  title,
  priceRub,
  createPayment,
  failMessage
}) {
  return async function handleBuyRoute(req, res) {
    try {
      const userId = getPaymentUserIdFromRequest(req);
      const mode = getPaymentModeFromRequest(req);

      if (!isValidUserIdForBroadcast(userId)) {
        res.status(400).type("text/plain").send("Некорректный user_id.");
        return;
      }

      if (req.method !== "POST") {
        renderReceiptEmailForm(res, {
          title,
          priceRub,
          userId,
          mode
        });
        return;
      }

      const receiptEmail = getPaymentReceiptEmailFromRequest(req);

      if (!receiptEmail) {
        renderReceiptEmailForm(res, {
          title,
          priceRub,
          userId,
          mode,
          errorText: "Введите корректный email для получения чека."
        });
        return;
      }

      const payment = await createPayment(userId, receiptEmail, mode);
      const confirmationUrl = payment?.confirmation?.confirmation_url;

      if (!confirmationUrl) {
        throw new Error(`YooKassa confirmation_url is missing: ${JSON.stringify(payment)}`);
      }

      res.redirect(302, confirmationUrl);
    } catch (error) {
      console.error(`${title} payment create failed:`, error);
      res
        .status(500)
        .type("text/plain")
        .send(failMessage || "Не удалось создать платеж. Вернитесь в бота и попробуйте позже.");
    }
  };
}

async function createYooKassaServicePayment({
  userId,
  receiptEmail,
  priceRub,
  description,
  product,
  type,
  returnPath,
  returnParams = {},
  extraMetadata = {}
}) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for payments");
  }

  if (!APP_PUBLIC_URL) {
    throw new Error("APP_PUBLIC_URL is not set");
  }

  const key = getUserRequestKey(userId);
  const email = normalizeReceiptEmail(receiptEmail);

  if (!email) {
    throw new Error("Valid receipt email is required");
  }

  const price = Number(priceRub || 0);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid YooKassa price for ${product}: ${priceRub}`);
  }

  const priceValue = price.toFixed(2);

  const returnUrl = new URL(`${APP_PUBLIC_URL}${returnPath}`);
  returnUrl.searchParams.set("user_id", key);

  for (const [paramKey, paramValue] of Object.entries(returnParams || {})) {
    if (paramValue !== undefined && paramValue !== null && String(paramValue).trim()) {
      returnUrl.searchParams.set(paramKey, String(paramValue));
    }
  }

  const payment = await yookassaRequest("/payments", {
    method: "POST",
    idempotenceKey: crypto.randomUUID(),
    body: {
      amount: {
        value: priceValue,
        currency: "RUB"
      },
      confirmation: {
        type: "redirect",
        return_url: returnUrl.toString()
      },
      capture: true,
      description: `${description} для user ${key}`,
      metadata: {
        user_id: key,
        bot_key: BOT_KEY,
        product,
        type,
        receipt_email: email,
        ...extraMetadata
      },
      receipt: buildYooKassaReceipt(description, priceValue, email)
    }
  });

  if (!payment?.id) {
    throw new Error(`YooKassa payment id is missing: ${JSON.stringify(payment)}`);
  }

  await dbPool.query(
    `
      INSERT INTO max_bot_premium_payments (
        payment_id,
        user_id,
        bot_key,
        status,
        amount,
        currency,
        raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (payment_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        amount = EXCLUDED.amount,
        currency = EXCLUDED.currency,
        raw = EXCLUDED.raw,
        updated_at = NOW()
    `,
    [
      String(payment.id),
      key,
      BOT_KEY,
      String(payment.status || "pending"),
      String(payment.amount?.value || priceValue),
      String(payment.amount?.currency || "RUB"),
      JSON.stringify(payment)
    ]
  );

  return payment;
}

async function createYooKassaPremiumPayment(userId, receiptEmail) {
  return createYooKassaServicePayment({
    userId,
    receiptEmail,
    priceRub: PREMIUM_PRICE_RUB,
    description: "Премиум на месяц",
    product: "premium_month",
    type: "premium",
    returnPath: "/premium/return"
  });
}

async function createYooKassaProductCardPayment(userId, receiptEmail) {
  return createYooKassaServicePayment({
    userId,
    receiptEmail,
    priceRub: PRODUCT_CARD_PRICE_RUB,
    description: "Создание карточки товара",
    product: PRODUCT_CARD_PRODUCT_CODE,
    type: PRODUCT_CARD_PRODUCT_CODE,
    returnPath: "/product-card/return"
  });
}

async function createYooKassaMusicPayment(userId, receiptEmail) {
  return createYooKassaServicePayment({
    userId,
    receiptEmail,
    priceRub: MUSIC_PRICE_RUB,
    description: "Создание музыки AI",
    product: MUSIC_PRODUCT_CODE,
    type: MUSIC_PRODUCT_CODE,
    returnPath: "/music/return"
  });
}

async function createYooKassaPromptVideoPayment(userId, receiptEmail) {
  return createYooKassaServicePayment({
    userId,
    receiptEmail,
    priceRub: PROMPT_VIDEO_PRICE_RUB,
    description: "Создание видео AI",
    product: PROMPT_VIDEO_PRODUCT_CODE,
    type: PROMPT_VIDEO_PRODUCT_CODE,
    returnPath: "/prompt-video/return"
  });
}

async function createYooKassaVideoPayment(userId, receiptEmail, mode = "") {
  const cleanMode = String(mode || "").trim();

  return createYooKassaServicePayment({
    userId,
    receiptEmail,
    priceRub: VIDEO_PRICE_RUB,
    description: "Оживление фото AI",
    product: VIDEO_PRODUCT_CODE,
    type: VIDEO_PRODUCT_CODE,
    returnPath: "/video/return",
    returnParams: cleanMode ? { mode: cleanMode } : {},
    extraMetadata: {
      mode: cleanMode
    }
  });
}

async function createYooKassaFamilyVideoPayment(userId, receiptEmail) {
  return createYooKassaServicePayment({
    userId,
    receiptEmail,
    priceRub: FAMILY_VIDEO_PRICE_RUB,
    description: "ТРЕНД МЕСЯЦА",
    product: FAMILY_VIDEO_PRODUCT_CODE,
    type: FAMILY_VIDEO_PRODUCT_CODE,
    returnPath: "/family-video/return"
  });
}

function buildPaymentEmailPayload(product, mode = "") {
  const cleanProduct = String(product || "").trim();
  const cleanMode = String(mode || "").trim();

  return `${PAYMENT_EMAIL_PAYLOAD_PREFIX}${cleanProduct}${cleanMode ? `:${cleanMode}` : ""}`;
}

function parsePaymentEmailPayload(payload) {
  const text = String(payload || "").trim();

  if (!text.startsWith(PAYMENT_EMAIL_PAYLOAD_PREFIX)) {
    return null;
  }

  const [product = "", mode = ""] = text
    .slice(PAYMENT_EMAIL_PAYLOAD_PREFIX.length)
    .split(":");

  if (!product) return null;

  return {
    product,
    mode
  };
}

function buildPaymentEmailFallbackRow(product, label = "✉️ Кнопка КУПИТЬ не открылась", mode = "") {
  return [
    {
      type: "callback",
      text: label,
      payload: buildPaymentEmailPayload(product, mode)
    }
  ];
}

function normalizeUserPaymentEmail(value) {
  const email = String(value || "").trim().toLowerCase();

  if (!email || email.length > 254) return "";

  // Простая проверка для чека: не пропускаем текст без @, пробелы и явно битый домен.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return "";
  }

  return email;
}

function getPaymentEmailStateKey(userId) {
  return String(userId || "unknown");
}

function setPaymentEmailState(userId, state) {
  paymentEmailStates.set(getPaymentEmailStateKey(userId), {
    ...state,
    updatedAt: Date.now()
  });
}

function getPaymentEmailState(userId) {
  const key = getPaymentEmailStateKey(userId);
  const state = paymentEmailStates.get(key);

  if (!state) return null;

  if (Date.now() - Number(state.updatedAt || 0) > PAYMENT_EMAIL_STATE_TTL_MS) {
    paymentEmailStates.delete(key);
    return null;
  }

  return state;
}

function clearPaymentEmailState(userId) {
  paymentEmailStates.delete(getPaymentEmailStateKey(userId));
}

const PAYMENT_PRODUCT_CONFIGS = {
  [PAYMENT_PRODUCT_PREMIUM]: {
    title: "Премиум на месяц",
    priceRub: PREMIUM_PRICE_RUB,
    buttonText: `💳 Оплатить Premium — ${Number(PREMIUM_PRICE_RUB).toFixed(0)} ₽`,
    createPayment: (userId, email) => createYooKassaPremiumPayment(userId, email),
    isConfigured: () => Boolean(APP_PUBLIC_URL && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY)
  },
  [PAYMENT_PRODUCT_PRODUCT_CARD]: {
    title: "Создание карточки товара",
    priceRub: PRODUCT_CARD_PRICE_RUB,
    buttonText: `💳 Оплатить карточку — ${Number(PRODUCT_CARD_PRICE_RUB).toFixed(0)} ₽`,
    createPayment: (userId, email) => createYooKassaProductCardPayment(userId, email),
    isConfigured: () => Boolean(APP_PUBLIC_URL && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY)
  },
  [PAYMENT_PRODUCT_MUSIC]: {
    title: "Создание музыки AI",
    priceRub: MUSIC_PRICE_RUB,
    buttonText: `💳 Оплатить музыку — ${Number(MUSIC_PRICE_RUB).toFixed(0)} ₽`,
    createPayment: (userId, email) => createYooKassaMusicPayment(userId, email),
    isConfigured: () => Boolean(APP_PUBLIC_URL && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY && GEMINI_API_KEY)
  },
  [PAYMENT_PRODUCT_PROMPT_VIDEO]: {
    title: "Создание видео AI",
    priceRub: PROMPT_VIDEO_PRICE_RUB,
    buttonText: `💳 Оплатить видео — ${Number(PROMPT_VIDEO_PRICE_RUB).toFixed(0)} ₽`,
    createPayment: (userId, email) => createYooKassaPromptVideoPayment(userId, email),
    isConfigured: () => Boolean(APP_PUBLIC_URL && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY && FAL_KEY)
  },
  [PAYMENT_PRODUCT_VIDEO]: {
    title: "Оживление фото AI",
    priceRub: VIDEO_PRICE_RUB,
    buttonText: `💳 Оплатить видео — ${Number(VIDEO_PRICE_RUB).toFixed(0)} ₽`,
    createPayment: (userId, email, mode = "") => createYooKassaVideoPayment(userId, email, mode),
    isConfigured: () => Boolean(APP_PUBLIC_URL && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY && FAL_KEY)
  },
  [PAYMENT_PRODUCT_FAMILY_VIDEO]: {
    title: "ТРЕНД МЕСЯЦА",
    priceRub: FAMILY_VIDEO_PRICE_RUB,
    buttonText: `💳 Оплатить тренд — ${Number(FAMILY_VIDEO_PRICE_RUB).toFixed(0)} ₽`,
    createPayment: (userId, email) => createYooKassaFamilyVideoPayment(userId, email),
    isConfigured: () => Boolean(APP_PUBLIC_URL && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY && FAL_KEY)
  }
};

function getPaymentProductConfig(product, mode = "") {
  let cleanProduct = String(product || "").trim();
  const cleanMode = String(mode || "").trim();

  if (cleanProduct === PAYMENT_PRODUCT_VIDEO && cleanMode === VIDEO_MODE_FAMILY_PAYMENT) {
    cleanProduct = PAYMENT_PRODUCT_FAMILY_VIDEO;
  }

  return PAYMENT_PRODUCT_CONFIGS[cleanProduct] || null;
}

async function startPaymentEmailFlow(target, userId, payload, callbackId = "") {
  const parsed = parsePaymentEmailPayload(payload);

  if (!parsed) {
    if (callbackId) {
      await answerMaxCallback(callbackId, "Кнопка оплаты устарела.");
    }

    return sendMaxMessage(target, "⚠️ Кнопка оплаты устарела. Откройте нужный раздел и нажмите покупку ещё раз.");
  }

  const config = getPaymentProductConfig(parsed.product, parsed.mode);

  if (!config || !config.isConfigured()) {
    clearPaymentEmailState(userId);

    if (callbackId) {
      await answerMaxCallback(callbackId, "Оплата пока не настроена.");
    }

    return sendMaxMessage(
      target,
      "⚠️ Оплата пока не настроена. Проверьте APP_PUBLIC_URL, YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY и ключи нужной модели."
    );
  }

  setPaymentEmailState(userId, {
    product: parsed.product,
    mode: parsed.mode,
    title: config.title
  });

  if (callbackId) {
    await answerMaxCallback(callbackId, "Введите email для чека.");
  }

  return sendMaxMessageWithAttachments(
    target,
    [
      `✉️ **${config.title}**`,
      "",
      "Введите email для чека одним сообщением.",
      "После этого я создам отдельную кнопку покупки.",
      "",
      "Пример: `name@mail.ru`"
    ].join("\n"),
    [
      {
        type: "inline_keyboard",
        payload: {
          buttons: buildBackButtonKeyboard()
        }
      }
    ]
  );
}

async function handlePaymentEmailText(target, userId, userText) {
  const state = getPaymentEmailState(userId);

  if (!state) return false;

  const email = normalizeUserPaymentEmail(userText);

  if (!email) {
    await sendMaxMessageWithAttachments(
      target,
      [
        "⚠️ **Введите корректный email для чека.**",
        "",
        "Например: `name@mail.ru`",
        "",
        "После email я создам кнопку покупки."
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: buildBackButtonKeyboard()
          }
        }
      ]
    );

    return true;
  }

  const config = getPaymentProductConfig(state.product, state.mode);

  if (!config || !config.isConfigured()) {
    clearPaymentEmailState(userId);

    await sendMaxMessage(
      target,
      "⚠️ Оплата пока не настроена. Проверьте APP_PUBLIC_URL, YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY и ключи нужной модели."
    );

    return true;
  }

  try {
    const payment = await config.createPayment(userId, email, state.mode);
    const confirmationUrl = payment?.confirmation?.confirmation_url;

    if (!confirmationUrl) {
      throw new Error(`YooKassa confirmation_url is missing: ${JSON.stringify(payment)}`);
    }

    clearPaymentEmailState(userId);

    await sendMaxMessageWithAttachments(
      target,
      [
        "✅ **Кнопка покупки создана.**",
        "",
        `Email для чека: **${email}**`,
        "",
        "Нажмите кнопку ниже и завершите оплату."
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: [
              [
                {
                  type: "link",
                  text: config.buttonText,
                  url: confirmationUrl
                }
              ],
              ...buildBackButtonKeyboard()
            ]
          }
        }
      ]
    );

    return true;
  } catch (error) {
    console.error(`${state.title || "Payment"} chat payment create failed:`, error);

    await sendMaxMessageWithAttachments(
      target,
      [
        "⚠️ Не удалось создать платеж.",
        "",
        "Проверьте email или попробуйте ещё раз чуть позже.",
        "Если проблема повторится — вернитесь в меню и нажмите покупку заново."
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: buildBackButtonKeyboard()
          }
        }
      ]
    );

    return true;
  }
}

async function getYooKassaPayment(paymentId) {
  return yookassaRequest(`/payments/${encodeURIComponent(paymentId)}`, {
    method: "GET"
  });
}

async function grantPremiumBonusCredits(client, userId) {
  const grants = {
    videoCredits: {
      table: "max_bot_video_credits",
      amount: Math.max(0, Number(PREMIUM_BONUS_VIDEO_CREDITS) || 0)
    },
    promptVideoCredits: {
      table: "max_bot_prompt_video_credits",
      amount: Math.max(0, Number(PREMIUM_BONUS_PROMPT_VIDEO_CREDITS) || 0)
    },
    productCardCredits: {
      table: "max_bot_product_card_credits",
      amount: Math.max(0, Number(PREMIUM_BONUS_PRODUCT_CARD_CREDITS) || 0)
    },
    musicCredits: {
      table: "max_bot_music_credits",
      amount: Math.max(0, Number(PREMIUM_BONUS_MUSIC_CREDITS) || 0)
    }
  };

  const result = {};

  for (const [key, grant] of Object.entries(grants)) {
    if (grant.amount <= 0) {
      result[key] = 0;
      continue;
    }

    const creditResult = await client.query(
      `
        INSERT INTO ${grant.table} (user_id, bot_key, credits)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, bot_key)
        DO UPDATE SET
          credits = ${grant.table}.credits + EXCLUDED.credits,
          updated_at = NOW()
        RETURNING credits
      `,
      [userId, BOT_KEY, grant.amount]
    );

    result[key] = Number(creditResult.rows[0]?.credits || 0);
  }

  return result;
}

async function applyPremiumPayment(payment) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for premium payments");
  }

  const paymentId = String(payment?.id || "").trim();
  const status = String(payment?.status || "").trim();
  const paid = payment?.paid === true;
  const amountValue = String(payment?.amount?.value || "");
  const currency = String(payment?.amount?.currency || "");
  const metadata = payment?.metadata || {};

  const userId = String(metadata.user_id || "").trim();
  const botKey = String(metadata.bot_key || "").trim();
  const product = String(metadata.product || "").trim();

  if (!paymentId || status !== "succeeded" || !paid) {
    return { granted: false, reason: "payment_not_succeeded" };
  }

  if (!userId || botKey !== BOT_KEY || product !== "premium_month") {
    return { granted: false, reason: "metadata_mismatch" };
  }

  if (currency !== "RUB" || Number(amountValue) < Number(PREMIUM_PRICE_RUB)) {
    return { granted: false, reason: "amount_mismatch" };
  }

  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    const existingPayment = await client.query(
      `
        SELECT status
        FROM max_bot_premium_payments
        WHERE payment_id = $1
        FOR UPDATE
      `,
      [paymentId]
    );

    const previousStatus = String(existingPayment.rows[0]?.status || "");

    await client.query(
      `
        INSERT INTO max_bot_premium_payments (
          payment_id,
          user_id,
          bot_key,
          status,
          amount,
          currency,
          raw
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (payment_id)
        DO UPDATE SET
          status = EXCLUDED.status,
          amount = EXCLUDED.amount,
          currency = EXCLUDED.currency,
          raw = EXCLUDED.raw,
          updated_at = NOW()
      `,
      [
        paymentId,
        userId,
        BOT_KEY,
        status,
        amountValue,
        currency,
        JSON.stringify(payment)
      ]
    );

    if (previousStatus === "succeeded") {
      await client.query("COMMIT");
      return { granted: false, reason: "already_granted", userId };
    }

    const premiumResult = await client.query(
      `
        INSERT INTO max_bot_premium_users (
          user_id,
          bot_key,
          premium_until,
          last_payment_id
        )
        VALUES (
          $1,
          $2,
          NOW() + ($3::int * INTERVAL '1 day'),
          $4
        )
        ON CONFLICT (user_id, bot_key)
        DO UPDATE SET
          premium_until = GREATEST(NOW(), max_bot_premium_users.premium_until) + ($3::int * INTERVAL '1 day'),
          last_payment_id = $4,
          updated_at = NOW()
        RETURNING premium_until
      `,
      [userId, BOT_KEY, PREMIUM_DURATION_DAYS, paymentId]
    );

    const bonusCredits = await grantPremiumBonusCredits(client, userId);
    const raffleTicket = await createPremiumRaffleTicket(client, userId, paymentId);

    await client.query("COMMIT");

    return {
      granted: true,
      userId,
      premiumUntil: premiumResult.rows[0]?.premium_until,
      bonusCredits,
      raffleTicket
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function applyProductCardPayment(payment) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for product card payments");
  }

  const paymentId = String(payment?.id || "").trim();
  const status = String(payment?.status || "").trim();
  const paid = payment?.paid === true;
  const amountValue = String(payment?.amount?.value || "");
  const currency = String(payment?.amount?.currency || "");
  const metadata = payment?.metadata || {};

  const userId = String(metadata.user_id || "").trim();
  const botKey = String(metadata.bot_key || "").trim();
  const product = String(metadata.product || "").trim();

  if (!paymentId || status !== "succeeded" || !paid) {
    return { granted: false, reason: "payment_not_succeeded" };
  }

  if (!userId || botKey !== BOT_KEY || product !== PRODUCT_CARD_PRODUCT_CODE) {
    return { granted: false, reason: "metadata_mismatch" };
  }

  if (currency !== "RUB" || Number(amountValue) < Number(PRODUCT_CARD_PRICE_RUB)) {
    return { granted: false, reason: "amount_mismatch" };
  }

  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    const existingPayment = await client.query(
      `
        SELECT status
        FROM max_bot_premium_payments
        WHERE payment_id = $1
        FOR UPDATE
      `,
      [paymentId]
    );

    const previousStatus = String(existingPayment.rows[0]?.status || "");

    await client.query(
      `
        INSERT INTO max_bot_premium_payments (
          payment_id,
          user_id,
          bot_key,
          status,
          amount,
          currency,
          raw
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (payment_id)
        DO UPDATE SET
          status = EXCLUDED.status,
          amount = EXCLUDED.amount,
          currency = EXCLUDED.currency,
          raw = EXCLUDED.raw,
          updated_at = NOW()
      `,
      [
        paymentId,
        userId,
        BOT_KEY,
        status,
        amountValue,
        currency,
        JSON.stringify(payment)
      ]
    );

    if (previousStatus === "succeeded") {
      await client.query("COMMIT");
      return { granted: false, reason: "already_granted", userId };
    }

    const creditResult = await client.query(
      `
        INSERT INTO max_bot_product_card_credits (user_id, bot_key, credits)
        VALUES ($1, $2, 1)
        ON CONFLICT (user_id, bot_key)
        DO UPDATE SET
          credits = max_bot_product_card_credits.credits + 1,
          updated_at = NOW()
        RETURNING credits
      `,
      [userId, BOT_KEY]
    );

    await client.query("COMMIT");

    return {
      granted: true,
      userId,
      credits: Number(creditResult.rows[0]?.credits || 0)
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function applyMusicPayment(payment) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for music payments");
  }

  const paymentId = String(payment?.id || "").trim();
  const status = String(payment?.status || "").trim();
  const paid = payment?.paid === true;
  const amountValue = String(payment?.amount?.value || "");
  const currency = String(payment?.amount?.currency || "");
  const metadata = payment?.metadata || {};

  const userId = String(metadata.user_id || "").trim();
  const botKey = String(metadata.bot_key || "").trim();
  const product = String(metadata.product || "").trim();

  if (!paymentId || status !== "succeeded" || !paid) {
    return { granted: false, reason: "payment_not_succeeded" };
  }

  if (!userId || botKey !== BOT_KEY || product !== MUSIC_PRODUCT_CODE) {
    return { granted: false, reason: "metadata_mismatch" };
  }

  if (currency !== "RUB" || Number(amountValue) < Number(MUSIC_PRICE_RUB)) {
    return { granted: false, reason: "amount_mismatch" };
  }

  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    const existingPayment = await client.query(
      `
        SELECT status
        FROM max_bot_premium_payments
        WHERE payment_id = $1
        FOR UPDATE
      `,
      [paymentId]
    );

    const previousStatus = String(existingPayment.rows[0]?.status || "");

    await client.query(
      `
        INSERT INTO max_bot_premium_payments (
          payment_id,
          user_id,
          bot_key,
          status,
          amount,
          currency,
          raw
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (payment_id)
        DO UPDATE SET
          status = EXCLUDED.status,
          amount = EXCLUDED.amount,
          currency = EXCLUDED.currency,
          raw = EXCLUDED.raw,
          updated_at = NOW()
      `,
      [
        paymentId,
        userId,
        BOT_KEY,
        status,
        amountValue,
        currency,
        JSON.stringify(payment)
      ]
    );

    if (previousStatus === "succeeded") {
      await client.query("COMMIT");
      return { granted: false, reason: "already_granted", userId };
    }

    const creditResult = await client.query(
      `
        INSERT INTO max_bot_music_credits (user_id, bot_key, credits)
        VALUES ($1, $2, 1)
        ON CONFLICT (user_id, bot_key)
        DO UPDATE SET
          credits = max_bot_music_credits.credits + 1,
          updated_at = NOW()
        RETURNING credits
      `,
      [userId, BOT_KEY]
    );

    await client.query("COMMIT");

    return {
      granted: true,
      userId,
      credits: Number(creditResult.rows[0]?.credits || 0)
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function applyPromptVideoPayment(payment) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for prompt video payments");
  }

  const paymentId = String(payment?.id || "").trim();
  const status = String(payment?.status || "").trim();
  const paid = payment?.paid === true;
  const amountValue = String(payment?.amount?.value || "");
  const currency = String(payment?.amount?.currency || "");
  const metadata = payment?.metadata || {};

  const userId = String(metadata.user_id || "").trim();
  const botKey = String(metadata.bot_key || "").trim();
  const product = String(metadata.product || "").trim();

  if (!paymentId || status !== "succeeded" || !paid) {
    return { granted: false, reason: "payment_not_succeeded" };
  }

  if (!userId || botKey !== BOT_KEY || product !== PROMPT_VIDEO_PRODUCT_CODE) {
    return { granted: false, reason: "metadata_mismatch" };
  }

  if (currency !== "RUB" || Number(amountValue) < Number(PROMPT_VIDEO_PRICE_RUB)) {
    return { granted: false, reason: "amount_mismatch" };
  }

  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    const existingPayment = await client.query(
      `
        SELECT status
        FROM max_bot_premium_payments
        WHERE payment_id = $1
        FOR UPDATE
      `,
      [paymentId]
    );

    const previousStatus = String(existingPayment.rows[0]?.status || "");

    await client.query(
      `
        INSERT INTO max_bot_premium_payments (
          payment_id,
          user_id,
          bot_key,
          status,
          amount,
          currency,
          raw
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (payment_id)
        DO UPDATE SET
          status = EXCLUDED.status,
          amount = EXCLUDED.amount,
          currency = EXCLUDED.currency,
          raw = EXCLUDED.raw,
          updated_at = NOW()
      `,
      [
        paymentId,
        userId,
        BOT_KEY,
        status,
        amountValue,
        currency,
        JSON.stringify(payment)
      ]
    );

    if (previousStatus === "succeeded") {
      await client.query("COMMIT");
      return { granted: false, reason: "already_granted", userId };
    }

    const creditResult = await client.query(
      `
        INSERT INTO max_bot_prompt_video_credits (user_id, bot_key, credits)
        VALUES ($1, $2, 1)
        ON CONFLICT (user_id, bot_key)
        DO UPDATE SET
          credits = max_bot_prompt_video_credits.credits + 1,
          updated_at = NOW()
        RETURNING credits
      `,
      [userId, BOT_KEY]
    );

    await client.query("COMMIT");

    return {
      granted: true,
      userId,
      credits: Number(creditResult.rows[0]?.credits || 0)
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function applyVideoPayment(payment) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for video payments");
  }

  const paymentId = String(payment?.id || "").trim();
  const status = String(payment?.status || "").trim();
  const paid = payment?.paid === true;
  const amountValue = String(payment?.amount?.value || "");
  const currency = String(payment?.amount?.currency || "");
  const metadata = payment?.metadata || {};

  const userId = String(metadata.user_id || "").trim();
  const botKey = String(metadata.bot_key || "").trim();
  const product = String(metadata.product || "").trim();

  if (!paymentId || status !== "succeeded" || !paid) {
    return { granted: false, reason: "payment_not_succeeded" };
  }

  if (!userId || botKey !== BOT_KEY || product !== VIDEO_PRODUCT_CODE) {
    return { granted: false, reason: "metadata_mismatch" };
  }

  if (currency !== "RUB" || Number(amountValue) < Number(VIDEO_PRICE_RUB)) {
    return { granted: false, reason: "amount_mismatch" };
  }

  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    const existingPayment = await client.query(
      `
        SELECT status
        FROM max_bot_premium_payments
        WHERE payment_id = $1
        FOR UPDATE
      `,
      [paymentId]
    );

    const previousStatus = String(existingPayment.rows[0]?.status || "");

    await client.query(
      `
        INSERT INTO max_bot_premium_payments (
          payment_id,
          user_id,
          bot_key,
          status,
          amount,
          currency,
          raw
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (payment_id)
        DO UPDATE SET
          status = EXCLUDED.status,
          amount = EXCLUDED.amount,
          currency = EXCLUDED.currency,
          raw = EXCLUDED.raw,
          updated_at = NOW()
      `,
      [
        paymentId,
        userId,
        BOT_KEY,
        status,
        amountValue,
        currency,
        JSON.stringify(payment)
      ]
    );

    if (previousStatus === "succeeded") {
      await client.query("COMMIT");
      return { granted: false, reason: "already_granted", userId };
    }

    const creditResult = await client.query(
      `
        INSERT INTO max_bot_video_credits (user_id, bot_key, credits)
        VALUES ($1, $2, 1)
        ON CONFLICT (user_id, bot_key)
        DO UPDATE SET
          credits = max_bot_video_credits.credits + 1,
          updated_at = NOW()
        RETURNING credits
      `,
      [userId, BOT_KEY]
    );

    await client.query("COMMIT");

    return {
      granted: true,
      userId,
      credits: Number(creditResult.rows[0]?.credits || 0)
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function applyFamilyVideoPayment(payment) {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for family video payments");
  }

  const paymentId = String(payment?.id || "").trim();
  const status = String(payment?.status || "").trim();
  const paid = payment?.paid === true;
  const amountValue = String(payment?.amount?.value || "");
  const currency = String(payment?.amount?.currency || "");
  const metadata = payment?.metadata || {};

  const userId = String(metadata.user_id || "").trim();
  const botKey = String(metadata.bot_key || "").trim();
  const product = String(metadata.product || "").trim();

  if (!paymentId || status !== "succeeded" || !paid) {
    return { granted: false, reason: "payment_not_succeeded" };
  }

  if (!userId || botKey !== BOT_KEY || product !== FAMILY_VIDEO_PRODUCT_CODE) {
    return { granted: false, reason: "metadata_mismatch" };
  }

  if (currency !== "RUB" || Number(amountValue) < Number(FAMILY_VIDEO_PRICE_RUB)) {
    return { granted: false, reason: "amount_mismatch" };
  }

  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    const existingPayment = await client.query(
      `
        SELECT status
        FROM max_bot_premium_payments
        WHERE payment_id = $1
        FOR UPDATE
      `,
      [paymentId]
    );

    const previousStatus = String(existingPayment.rows[0]?.status || "");

    await client.query(
      `
        INSERT INTO max_bot_premium_payments (
          payment_id,
          user_id,
          bot_key,
          status,
          amount,
          currency,
          raw
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (payment_id)
        DO UPDATE SET
          status = EXCLUDED.status,
          amount = EXCLUDED.amount,
          currency = EXCLUDED.currency,
          raw = EXCLUDED.raw,
          updated_at = NOW()
      `,
      [
        paymentId,
        userId,
        BOT_KEY,
        status,
        amountValue,
        currency,
        JSON.stringify(payment)
      ]
    );

    if (previousStatus === "succeeded") {
      await client.query("COMMIT");
      return { granted: false, reason: "already_granted", userId };
    }

    const creditResult = await client.query(
      `
        INSERT INTO max_bot_family_video_credits (user_id, bot_key, credits)
        VALUES ($1, $2, 1)
        ON CONFLICT (user_id, bot_key)
        DO UPDATE SET
          credits = max_bot_family_video_credits.credits + 1,
          updated_at = NOW()
        RETURNING credits
      `,
      [userId, BOT_KEY]
    );

    await client.query("COMMIT");

    return {
      granted: true,
      userId,
      credits: Number(creditResult.rows[0]?.credits || 0)
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function answerMaxCallback(callbackId, notification = "") {
  if (!callbackId) return false;

  const text = String(notification || "").trim();

  // ВАЖНО: пустой callback больше не отправляем.
  // MAX показывает пустой notification как пустое сообщение.
  if (!text) return false;

  try {
    await maxRequest("/answers", {
      method: "POST",
      query: {
        callback_id: callbackId
      },
      body: {
        notification: text
      }
    });

    return true;
  } catch (firstError) {
    console.warn(
      "MAX callback answer with notification failed:",
      firstError?.message || firstError
    );
  }

  try {
    await maxRequest("/answers", {
      method: "POST",
      query: {
        callback_id: callbackId
      },
      body: {
        message: text
      }
    });

    return true;
  } catch (secondError) {
    console.warn(
      "MAX callback answer with message failed:",
      secondError?.message || secondError
    );
    return false;
  }
}

async function sendMaxSingleMessage(target, text, notify = true) {
  return maxRequest("/messages", {
    method: "POST",
    query: { [target.type]: target.id },
    body: {
      text,
      notify,
      format: "markdown" // Указание формата для Markdown
    }
  });
}

async function sendMaxMessage(target, text) {
  const chunks = splitForMax(text);
  const results = [];

  for (const chunk of chunks) {
    const result = await sendMaxSingleMessage(target, chunk, true);
    results.push(result);
  }

  return results;
}

async function sendMaxMessageWithAttachments(target, text, attachments) {
  return maxRequest("/messages", {
    method: "POST",
    query: { [target.type]: target.id },
    body: {
      text: text || null,
      attachments,
      notify: true,
      format: "markdown"
    }
  });
}

async function answerMaxCallbackWithMessage(callbackId, target, text, attachments) {
  if (!callbackId) {
    return sendMaxMessageWithAttachments(target, text, attachments);
  }

  try {
    return await maxRequest("/answers", {
      method: "POST",
      query: {
        callback_id: callbackId
      },
      body: {
        message: {
          text: text || null,
          attachments,
          notify: false,
          format: "markdown"
        }
      }
    });
  } catch (error) {
    console.warn(
      "answerMaxCallbackWithMessage failed, fallback to /messages:",
      error?.message || error
    );

    return sendMaxMessageWithAttachments(target, text, attachments);
  }
}

function runCallbackTaskInBackground(target, taskName, task) {
  task().catch((error) => {
    console.error(`${taskName} failed:`, error);

    sendMaxMessage(target, safeUserError(error)).catch((sendError) => {
      console.error(`Failed to send ${taskName} error to MAX:`, sendError);
    });
  });
}

async function getVideoExampleMaxToken({ force = false } = {}) {
  if (!VIDEO_EXAMPLE_URL && !cachedVideoExampleToken) {
    return "";
  }

  if (!force && cachedVideoExampleToken) {
    return cachedVideoExampleToken;
  }

  if (!force && videoExampleTokenPromise) {
    return videoExampleTokenPromise;
  }

  videoExampleTokenPromise = (async () => {
    const videoBuffer = await downloadBufferFromUrl(VIDEO_EXAMPLE_URL, "video/");
    const token = await uploadVideoToMaxAndGetToken(videoBuffer);

    cachedVideoExampleToken = token;

    console.log(`VIDEO_EXAMPLE_MAX_TOKEN=${token}`);

    return token;
  })();

  try {
    return await videoExampleTokenPromise;
  } finally {
    videoExampleTokenPromise = null;
  }
}

async function getFamilyVideoExampleMaxToken({ force = false } = {}) {
  if (!FAMILY_VIDEO_EXAMPLE_URL && !cachedFamilyVideoExampleToken) {
    return "";
  }

  if (!force && cachedFamilyVideoExampleToken) {
    return cachedFamilyVideoExampleToken;
  }

  if (!force && familyVideoExampleTokenPromise) {
    return familyVideoExampleTokenPromise;
  }

  familyVideoExampleTokenPromise = (async () => {
    const videoBuffer = await downloadBufferFromUrl(
      FAMILY_VIDEO_EXAMPLE_URL,
      "video/"
    );

    const token = await uploadVideoToMaxAndGetToken(videoBuffer);

    cachedFamilyVideoExampleToken = token;

    console.log(`FAMILY_VIDEO_EXAMPLE_MAX_TOKEN=${token}`);

    return token;
  })();

  try {
    return await familyVideoExampleTokenPromise;
  } finally {
    familyVideoExampleTokenPromise = null;
  }
}

async function getPromptVideoExampleMaxToken({ force = false } = {}) {
  if (!PROMPT_VIDEO_EXAMPLE_URL && !cachedPromptVideoExampleToken) {
    return "";
  }

  if (!force && cachedPromptVideoExampleToken) {
    return cachedPromptVideoExampleToken;
  }

  if (!force && promptVideoExampleTokenPromise) {
    return promptVideoExampleTokenPromise;
  }

  promptVideoExampleTokenPromise = (async () => {
    const videoBuffer = await downloadBufferFromUrl(
      PROMPT_VIDEO_EXAMPLE_URL,
      "video/"
    );

    const token = await uploadVideoToMaxAndGetToken(videoBuffer);

    cachedPromptVideoExampleToken = token;

    console.log(`PROMPT_VIDEO_EXAMPLE_MAX_TOKEN=${token}`);

    return token;
  })();

  try {
    return await promptVideoExampleTokenPromise;
  } finally {
    promptVideoExampleTokenPromise = null;
  }
}

async function sendMaxVideoToken(target, text, token) {
  const attachments = [
    {
      type: "video",
      payload: { token }
    }
  ];

  const retries = Number(process.env.VIDEO_EXAMPLE_SEND_RETRIES || 4);
  const baseDelayMs = Number(process.env.VIDEO_EXAMPLE_SEND_RETRY_DELAY_MS || 200);

  let lastError;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await sleep(baseDelayMs * (attempt + 1));
      await sendMaxMessageWithAttachments(target, text || null, attachments);
      return true;
    } catch (error) {
      lastError = error;

      const message = String(error?.message || "");

      if (!/attachment\.not\.ready|not\.processed|not ready/i.test(message)) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function sendMaxVideoTokenWithAttachments(target, text, token, extraAttachments = []) {
  const attachments = [
    {
      type: "video",
      payload: { token }
    },
    ...extraAttachments
  ];

  const retries = Number(process.env.VIDEO_EXAMPLE_SEND_RETRIES || 4);
  const baseDelayMs = Number(process.env.VIDEO_EXAMPLE_SEND_RETRY_DELAY_MS || 200);

  let lastError;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      if (attempt > 0) {
        await sleep(baseDelayMs * attempt);
      }

      await sendMaxMessageWithAttachments(target, text || null, attachments);
      return true;
    } catch (error) {
      lastError = error;

      const message = String(error?.message || "");

      if (!/attachment\.not\.ready|not\.processed|not ready/i.test(message)) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function sendVideoExampleToMax(target) {
  try {
    let token = await getVideoExampleMaxToken();

    if (!token) {
      return false;
    }

    try {
      await sendMaxVideoToken(target, "🎞️ **Пример результата**", token);
      return true;
    } catch (error) {
      console.warn(
        "Cached video example token failed, trying fresh upload:",
        error?.message || error
      );

      if (!VIDEO_EXAMPLE_URL) {
        throw error;
      }

      cachedVideoExampleToken = "";
      token = await getVideoExampleMaxToken({ force: true });

      await sendMaxVideoToken(target, "🎞️ **Пример результата**", token);
      return true;
    }
  } catch (error) {
    console.warn("Failed to send video example:", error?.message || error);
    return false;
  }
}

function buildMainMenuButtons() {
  return [
    [
      {
        type: "callback",
        text: "📸 Создать фото",
        payload: MENU_CREATE_PHOTO_PAYLOAD
      }
    ],

    [
      {
        type: "callback",
        text: "📹 Создать видео",
        payload: MENU_CREATE_PROMPT_VIDEO_PAYLOAD
      }
    ],
    [
      {
        type: "callback",
        text: "🎞️ Оживить фото",
        payload: MENU_CREATE_VIDEO_PAYLOAD
      }
    ],
    [
      {
        type: "callback",
        text: "🎵 Создать музыку",
        payload: MENU_CREATE_MUSIC_PAYLOAD
      }
    ],
    [
      {
        type: "callback",
        text: "🛍️ Создать карточку товара WB/Ozon",
        payload: MENU_PRODUCT_CARD_PAYLOAD
      }
    ],
    [
      {
        type: "callback",
        text: "🌙 Гороскоп",
        payload: MENU_HOROSCOPE_PAYLOAD
      }
    ],
    [
      {
        type: "callback",
        text: "💰Заработать",
        payload: MENU_EARN_PAYLOAD
      }
    ],
    [
      {
        type: "callback",
        text: "💵 ВСЕ В ОДНОМ ЗА 299₽",
        payload: MENU_PREMIUM_PAYLOAD
      }
    ]
  ];
}

async function sendMainMenu(target, prefixText = "") {
  const text =
    prefixText ||
    "Выбери, что хочешь сделать, или пиши прямо в чат✏️.\n\n**🗣️ Совет:** *Попроси в чате написать тебе точный промт для модели Image GPT + опиши свой запрос, а потом создавай фото🔮*";

  const attachments = [
    {
      type: "inline_keyboard",
      payload: {
        buttons: buildMainMenuButtons()
      }
    }
  ];

  return sendMaxMessageWithAttachments(target, text, attachments);
}

function buildBackButtonKeyboard() {
  return [
    [
      {
        type: "callback",
        text: "⬅️ Назад",
        payload: MENU_BACK_PAYLOAD
      }
    ]
  ];
}

function buildBroadcastPostKeyboard(userId) {
  const buttons = [];

  const buyUrl = buildPremiumBuyUrl(userId);

  if (buyUrl && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY) {
    buttons.push([
      {
        type: "link",
        text: `💳 Купить всё в одном — ${Number(PREMIUM_PRICE_RUB).toFixed(0)} ₽`,
        url: buyUrl
      }
    ]);

    buttons.push(buildPaymentEmailFallbackRow(PAYMENT_PRODUCT_PREMIUM));
  }

  buttons.push([
    {
      type: "callback",
      text: "🏠 МЕНЮ",
      payload: MENU_BACK_PAYLOAD
    }
  ]);

  return {
    type: "inline_keyboard",
    payload: {
      buttons
    }
  };
}


function formatKopecksRub(kopecks) {
  return (Number(kopecks || 0) / 100).toFixed(2).replace(/\.00$/, "");
}

function getReferralMonthKey(date = new Date()) {
  return getMoscowDateYmd(date).slice(0, 7);
}

function getReferralBaseUrl() {
  if (REFERRAL_BASE_URL) return REFERRAL_BASE_URL;

  return "";
}

function buildReferralLink(userId) {
  const baseUrl = getReferralBaseUrl();
  const key = encodeURIComponent(getUserRequestKey(userId));

  if (!baseUrl || !key || key === "unknown") {
    return "";
  }

  return `${baseUrl}?start=${encodeURIComponent(`${REFERRAL_START_PREFIX}${key}`)}`;
}

function getStartPayload(update) {
  const candidates = [
    update?.payload,
    update?.start_payload,
    update?.startPayload,
    update?.message?.payload,
    update?.message?.start_payload,
    update?.message?.body?.payload,
    update?.message?.body?.start_payload,
    update?.message?.body?.text
  ];

  for (const value of candidates) {
    const text = String(value || "").trim();

    if (!text) continue;

    const startMatch = text.match(/^\/start(?:@\S+)?\s+(.+)$/i);
    if (startMatch) return startMatch[1].trim();

    return text;
  }

  return "";
}

function parseReferralStartPayload(payload) {
  const text = String(payload || "").trim();

  if (!text.startsWith(REFERRAL_START_PREFIX)) {
    return "";
  }

  return decodeURIComponent(text.slice(REFERRAL_START_PREFIX.length)).trim();
}

function buildEarnKeyboard(balanceKopecks) {
  const buttons = [
    [
      {
        type: "callback",
        text: "📨 Обновить",
        payload: MENU_EARN_PAYLOAD
      }
    ]
  ];

  buttons.push([
    {
      type: "callback",
      text:
        Number(balanceKopecks || 0) >= REFERRAL_MIN_WITHDRAW_KOPECKS
          ? "💳 Вывести"
          : `💳 Вывести от ${formatKopecksRub(REFERRAL_MIN_WITHDRAW_KOPECKS)}₽`,
      payload: EARN_WITHDRAW_PAYLOAD
    }
  ]);

  buttons.push([
    {
      type: "callback",
      text: "⬅️ Назад к меню",
      payload: MENU_BACK_PAYLOAD
    }
  ]);

  return buttons;
}

async function initReferralDb() {
  if (!dbPool) return;

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS max_bot_referrals (
      referred_user_id TEXT NOT NULL,
      bot_key TEXT NOT NULL,
      referrer_user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_activity_at TIMESTAMPTZ,
      PRIMARY KEY (referred_user_id, bot_key)
    )
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_referrals_referrer
    ON max_bot_referrals (referrer_user_id, bot_key)
  `);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS max_bot_referral_monthly_rewards (
      referrer_user_id TEXT NOT NULL,
      referred_user_id TEXT NOT NULL,
      bot_key TEXT NOT NULL,
      month_key TEXT NOT NULL,
      amount_kopecks INTEGER NOT NULL DEFAULT 100,
      action_count INTEGER NOT NULL DEFAULT 1,
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      withdrawn_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (referrer_user_id, referred_user_id, bot_key, month_key)
    )
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_referral_rewards_balance
    ON max_bot_referral_monthly_rewards (referrer_user_id, bot_key, month_key, withdrawn_at)
  `);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS max_bot_referral_withdraw_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      bot_key TEXT NOT NULL,
      month_key TEXT NOT NULL,
      amount_kopecks INTEGER NOT NULL,
      phone TEXT NOT NULL,
      payout_details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_max_bot_referral_withdraw_status
    ON max_bot_referral_withdraw_requests (bot_key, status, created_at)
  `);

  console.log("Referral DB initialized");
}

async function handleReferralStart(userId, payload) {
  if (!dbPool) return false;

  const referredUserId = getUserRequestKey(userId);
  const referrerUserId = parseReferralStartPayload(payload);

  if (
    !isValidUserIdForBroadcast(referredUserId) ||
    !isValidUserIdForBroadcast(referrerUserId) ||
    referredUserId === referrerUserId
  ) {
    return false;
  }

  await dbPool.query(
    `
      INSERT INTO max_bot_referrals (referred_user_id, bot_key, referrer_user_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (referred_user_id, bot_key) DO NOTHING
    `,
    [referredUserId, BOT_KEY, referrerUserId]
  );

  return true;
}

async function markReferralActivity(userId, actionType = "activity") {
  if (!dbPool) return false;

  const referredUserId = getUserRequestKey(userId);

  if (!isValidUserIdForBroadcast(referredUserId)) return false;

  const monthKey = getReferralMonthKey();

  const referralResult = await dbPool.query(
    `
      SELECT referrer_user_id
      FROM max_bot_referrals
      WHERE referred_user_id = $1 AND bot_key = $2
      LIMIT 1
    `,
    [referredUserId, BOT_KEY]
  );

  const referrerUserId = String(referralResult.rows[0]?.referrer_user_id || "").trim();

  if (
    !isValidUserIdForBroadcast(referrerUserId) ||
    referrerUserId === referredUserId
  ) {
    return false;
  }

  await dbPool.query(
    `
      UPDATE max_bot_referrals
      SET last_activity_at = NOW()
      WHERE referred_user_id = $1 AND bot_key = $2
    `,
    [referredUserId, BOT_KEY]
  );

  await dbPool.query(
    `
      INSERT INTO max_bot_referral_monthly_rewards (
        referrer_user_id, referred_user_id, bot_key, month_key,
        amount_kopecks, action_count, last_activity_at
      )
      VALUES ($1, $2, $3, $4, $5, 1, NOW())
      ON CONFLICT (referrer_user_id, referred_user_id, bot_key, month_key)
      DO UPDATE SET
        action_count = max_bot_referral_monthly_rewards.action_count + 1,
        last_activity_at = NOW()
    `,
    [referrerUserId, referredUserId, BOT_KEY, monthKey, REFERRAL_REWARD_KOPECKS]
  );

  return true;
}

async function getReferralStats(userId) {
  const key = getUserRequestKey(userId);
  const monthKey = getReferralMonthKey();

  if (!dbPool) {
    return {
      balanceKopecks: 0,
      invitedTotal: 0,
      activeThisMonth: 0,
      monthKey
    };
  }

  const statsResult = await dbPool.query(
    `
      SELECT
        COALESCE(SUM(r.amount_kopecks) FILTER (WHERE r.withdrawn_at IS NULL), 0)::int AS balance_kopecks,
        COUNT(DISTINCT r.referred_user_id)::int AS active_this_month,
        (
          SELECT COUNT(*)::int
          FROM max_bot_referrals ref
          WHERE ref.referrer_user_id = $1 AND ref.bot_key = $2
        ) AS invited_total
      FROM max_bot_referral_monthly_rewards r
      WHERE r.referrer_user_id = $1
        AND r.bot_key = $2
        AND r.month_key = $3
    `,
    [key, BOT_KEY, monthKey]
  );

  const row = statsResult.rows[0] || {};

  return {
    balanceKopecks: Number(row.balance_kopecks || 0),
    invitedTotal: Number(row.invited_total || 0),
    activeThisMonth: Number(row.active_this_month || 0),
    monthKey
  };
}

async function sendEarnMenu(target, userId) {
  const stats = await getReferralStats(userId);
  const referralLink = buildReferralLink(userId);
  const monthLabel = stats.monthKey ? `${stats.monthKey}` : "текущий месяц";

  const text = [
    "💰 **Заработать на приглашениях**",
    "",
    "🧸Приглашайте людей по своей реферальной ссылке.",
    `За каждого приглашённого пользователя, который в течение месяца реально пользуется ботом, начисляется **${formatKopecksRub(REFERRAL_REWARD_KOPECKS)}₽**.`,
    "",
    "**Что считается активностью:**",
    "• человек пишет боту;",
    "• нажимает кнопки;",
    "• создаёт фото, видео, музыку, карточки или пользуется другими функциями.",
    "",
    `**💷Баланс за ${monthLabel}:** ${formatKopecksRub(stats.balanceKopecks)}₽`,
    `**🤾‍♀️Активных приглашённых:** ${stats.activeThisMonth}`,
    `**🗂️Всего пришло по ссылке:** ${stats.invitedTotal}`,
    "",
    `**Вывод:** от ${formatKopecksRub(REFERRAL_MIN_WITHDRAW_KOPECKS)}₽ по СБП на любой номер.`,
    "",
    "*🧾Важно: подсчёт идёт только по активным пользователям. Совет: Кидайте ссылку в чат с друзьями или группы*",
    "",
    referralLink
      ? `**Ваша ссылка:**\n${referralLink}`
      : "⚠️ Реферальная ссылка не настроена. Добавьте переменную REFERRAL_BASE_URL, например: https://max.ru/имя_вашего_бота"
  ].join("\n");

  return sendMaxMessageWithAttachments(target, text, [
    {
      type: "inline_keyboard",
      payload: {
        buttons: buildEarnKeyboard(stats.balanceKopecks)
      }
    }
  ]);
}

function sanitizePayoutDetails(text) {
  return String(text || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function extractPhoneFromText(text) {
  const digits = String(text || "").replace(/\D/g, "");

  if (digits.length < 10 || digits.length > 15) {
    return "";
  }

  return digits;
}

async function startReferralWithdraw(target, userId) {
  const stats = await getReferralStats(userId);

  if (stats.balanceKopecks < REFERRAL_MIN_WITHDRAW_KOPECKS) {
    return sendMaxMessageWithAttachments(
      target,
      [
        "💳 **Вывод пока недоступен**",
        "",
        `Ваш баланс: **${formatKopecksRub(stats.balanceKopecks)}₽**.`,
        `Минимальная сумма вывода: **${formatKopecksRub(REFERRAL_MIN_WITHDRAW_KOPECKS)}₽**.`,
        "",
        "Продолжайте приглашать людей по своей ссылке."
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: buildEarnKeyboard(stats.balanceKopecks)
          }
        }
      ]
    );
  }

  userEarnWithdrawStates.set(getUserRequestKey(userId), {
    createdAt: Date.now()
  });

  return sendMaxMessageWithAttachments(
    target,
    [
      "💳 **Заявка на вывод**",
      "",
      `Доступно к выводу: **${formatKopecksRub(stats.balanceKopecks)}₽**.`,
      "",
      "Напишите одним сообщением:",
      "1. номер телефона для СБП;",
      "2. банк, если нужно;",
      "3. ФИО или имя получателя.",
      "",
      "Пример:",
      "`+79990000000, Сбер, Иван Иванов`"
    ].join("\n"),
    [
      {
        type: "inline_keyboard",
        payload: {
          buttons: buildBackButtonKeyboard()
        }
      }
    ]
  );
}

async function handleReferralWithdrawText(target, userId, userText) {
  const key = getUserRequestKey(userId);
  const state = userEarnWithdrawStates.get(key);

  if (!state) return false;

  const ttlMs = Number(process.env.REFERRAL_WITHDRAW_STATE_TTL_MS || 15 * 60_000);

  if (Date.now() - Number(state.createdAt || 0) > ttlMs) {
    userEarnWithdrawStates.delete(key);
    await sendMaxMessage(target, "Заявка устарела. Нажмите «💰Заработать» → «Вывести» ещё раз.");
    return true;
  }

  const payoutDetails = sanitizePayoutDetails(userText);
  const phone = extractPhoneFromText(payoutDetails);

  if (!phone) {
    await sendMaxMessage(
      target,
      "Не вижу корректный номер телефона. Напишите номер для СБП и данные получателя одним сообщением."
    );
    return true;
  }

  const request = await createReferralWithdrawRequest(userId, phone, payoutDetails);

  userEarnWithdrawStates.delete(key);

  if (!request) {
    await sendMaxMessage(
      target,
      "Не получилось создать заявку: баланс уже меньше минимальной суммы или база временно недоступна."
    );
    return true;
  }

  await sendMaxMessage(
    target,
    [
      "✅ **Заявка на вывод создана**",
      "",
      `Номер заявки: **#${request.id}**`,
      `Сумма: **${formatKopecksRub(request.amountKopecks)}₽**`,
      "",
      "Администратор увидит её в команде `/cash`."
    ].join("\n")
  );

  return true;
}

async function createReferralWithdrawRequest(userId, phone, payoutDetails) {
  if (!dbPool) return null;

  const key = getUserRequestKey(userId);
  const monthKey = getReferralMonthKey();

  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    const statsResult = await client.query(
      `
        SELECT COALESCE(SUM(amount_kopecks), 0)::int AS amount_kopecks
        FROM max_bot_referral_monthly_rewards
        WHERE referrer_user_id = $1
          AND bot_key = $2
          AND month_key = $3
          AND withdrawn_at IS NULL
        FOR UPDATE
      `,
      [key, BOT_KEY, monthKey]
    );

    const amountKopecks = Number(statsResult.rows[0]?.amount_kopecks || 0);

    if (amountKopecks < REFERRAL_MIN_WITHDRAW_KOPECKS) {
      await client.query("ROLLBACK");
      return null;
    }

    const requestResult = await client.query(
      `
        INSERT INTO max_bot_referral_withdraw_requests (
          user_id, bot_key, month_key, amount_kopecks, phone, payout_details
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, amount_kopecks
      `,
      [key, BOT_KEY, monthKey, amountKopecks, phone, payoutDetails]
    );

    await client.query(
      `
        UPDATE max_bot_referral_monthly_rewards
        SET withdrawn_at = NOW()
        WHERE referrer_user_id = $1
          AND bot_key = $2
          AND month_key = $3
          AND withdrawn_at IS NULL
      `,
      [key, BOT_KEY, monthKey]
    );

    await client.query("COMMIT");

    return {
      id: requestResult.rows[0].id,
      amountKopecks: Number(requestResult.rows[0].amount_kopecks || 0)
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function sendCashAdminReport(target, adminUserId) {
  if (!isAdminUser(adminUserId)) {
    await sendMaxMessage(target, "⛔ Эта команда доступна только администратору.");
    return true;
  }

  if (!dbPool) {
    await sendMaxMessage(target, "⚠️ DATABASE_URL не задан. Раздел выплат недоступен.");
    return true;
  }

  const monthKey = getReferralMonthKey();

  const requests = await dbPool.query(
    `
      SELECT id, user_id, amount_kopecks, phone, payout_details, status, created_at
      FROM max_bot_referral_withdraw_requests
      WHERE bot_key = $1
        AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 30
    `,
    [BOT_KEY]
  );

  const readyUsers = await dbPool.query(
    `
      SELECT referrer_user_id AS user_id,
             COALESCE(SUM(amount_kopecks), 0)::int AS balance_kopecks,
             COUNT(DISTINCT referred_user_id)::int AS active_refs
      FROM max_bot_referral_monthly_rewards
      WHERE bot_key = $1
        AND month_key = $2
        AND withdrawn_at IS NULL
      GROUP BY referrer_user_id
      HAVING COALESCE(SUM(amount_kopecks), 0) >= $3
      ORDER BY balance_kopecks DESC
      LIMIT 30
    `,
    [BOT_KEY, monthKey, REFERRAL_MIN_WITHDRAW_KOPECKS]
  );

  const lines = [
    "💵 **/cash — реферальные выплаты**",
    "",
    `Месяц: **${monthKey}**`,
    "",
    "**Заявки на вывод:**"
  ];

  if (!requests.rows.length) {
    lines.push("Заявок пока нет.");
  } else {
    for (const row of requests.rows) {
      lines.push(
        `#${row.id} — user_id: ${row.user_id}, сумма: ${formatKopecksRub(row.amount_kopecks)}₽, телефон: ${row.phone}, данные: ${row.payout_details}`
      );
    }
  }

  lines.push("", "**Пользователи, у кого уже есть 1000₽+, но заявки ещё нет:**");

  if (!readyUsers.rows.length) {
    lines.push("Пока никого.");
  } else {
    for (const row of readyUsers.rows) {
      lines.push(
        `user_id: ${row.user_id}, баланс: ${formatKopecksRub(row.balance_kopecks)}₽, активных приглашённых: ${row.active_refs}`
      );
    }
  }

  await sendMaxMessage(target, lines.join("\n"));
  return true;
}


function buildCreatePhotoKeyboard(userId = null) {
  const selectedFormat = getUserPhotoFormat(userId);

  const formatButton = (formatKey) => ({
    type: "callback",
    text: `${selectedFormat === formatKey ? "✅ " : ""}${PHOTO_FORMATS[formatKey].button}`,
    payload: `${PHOTO_FORMAT_PAYLOAD_PREFIX}${formatKey}`
  });

  return [
    [
      {
        type: "callback",
        text: "🌌 СТИЛИ",
        payload: MENU_PHOTO_STYLES_PAYLOAD
      }
    ],
    [
      formatButton("square"),
      formatButton("phone"),
      formatButton("desktop")  // теперь все три кнопки в одной линии
    ],
    [
      {
        type: "callback",
        text: "⬅️ Назад",
        payload: MENU_BACK_PAYLOAD
      }
    ]
  ];
}

function buildPhotoStylesKeyboard() {
  const rows = [];
  const entries = Object.entries(PHOTO_STYLES);

  for (let i = 0; i < entries.length; i += 2) {
    const row = entries.slice(i, i + 2).map(([key, style]) => ({
      type: "callback",
      text: style.button,
      payload: `${PHOTO_STYLE_PAYLOAD_PREFIX}${key}`
    }));

    rows.push(row);
  }

  rows.push([
    {
      type: "callback",
      text: "⬅️ Назад",
      payload: MENU_CREATE_PHOTO_PAYLOAD
    }
  ]);

  return rows;
}

async function answerMainMenu(callbackId, target, prefixText = "") {
  if (callbackId) {
    await answerMaxCallback(callbackId, "Меню открыто.").catch((error) => {
      console.warn("answerMainMenu callback ack failed:", error?.message || error);
    });
  }

  return sendMainMenu(target, prefixText);
}

async function sendCreatePhotoHelp(target, userId = target.id) {
  const text =
    "📸 **Создать фото Бесплатно**\n\n" +
    "Отправь:\n" +
    "• фото + промт (что изменить/добавить)\n" +
    "или\n" +
    "• просто промт с текстом вида: `создай фото/картинку .`";

  const attachments = [
    {
      type: "inline_keyboard",
      payload: {
        buttons: buildCreatePhotoKeyboard(userId)
      }
    }
  ];

  return sendMaxMessageWithAttachments(target, text, attachments);
}

async function answerCreatePhotoHelp(callbackId, target, userId = target.id) {
const text =
  "📸 **Создать фото Бесплатно**\n\n" +
  "Отправь:\n" +
  "• фото + промт — если хочешь изменить фото;\n" +
  "• просто промт — если хочешь создать картинку с нуля;\n" +
  "• или нажми **🌌 СТИЛИ**, выбери стиль и просто отправь фото.";

  const attachments = [
    {
      type: "inline_keyboard",
      payload: {
        buttons: buildCreatePhotoKeyboard(userId)
      }
    }
  ];

  return answerMaxCallbackWithMessage(callbackId, target, text, attachments);
}

async function answerPhotoFormatSelected(callbackId, target, userId, formatKey) {
  const selectedFormatKey = setUserPhotoFormat(userId, formatKey);
  const format = PHOTO_FORMATS[selectedFormatKey];

  const text =
    "📸 **Создать фото Бесплатно**\n\n" +
    `Выбран формат: **${format.title}**\n\n` +
    "Теперь отправь промт или фото + промт.";

  const attachments = [
    {
      type: "inline_keyboard",
      payload: {
        buttons: buildCreatePhotoKeyboard(userId)
      }
    }
  ];

  return answerMaxCallbackWithMessage(callbackId, target, text, attachments);
}

async function answerPhotoStylesMenu(callbackId, target) {
  const text =
    "🎨 **Выберите стиль для фото**\n\n" +
    "После выбора стиля просто отправьте фото. Текст писать не обязательно.\n\n" +
    "Если хотите добавить пожелание — отправьте фото вместе с коротким текстом.";

  const attachments = [
    {
      type: "inline_keyboard",
      payload: {
        buttons: buildPhotoStylesKeyboard()
      }
    }
  ];

  return answerMaxCallbackWithMessage(callbackId, target, text, attachments);
}

async function answerPhotoStyleActivated(callbackId, target, style) {
const text =
  `🎨 **Стиль активирован: ${style.title}**\n\n` +
  (style.title === "🎎ЗАМЕНА ЧЕЛОВЕКА"
    ? "Отправьте 2 фото:\n\nФото 1 — кого заменяем.\nФото 2 — кем заменяем.\n\nЖелательно отправлять фото четкие, с хорошо видимым лицом."
    : "Теперь просто отправьте фото.\n\nЕсли добавите текст к фото, он будет учтён как дополнительное пожелание.");

  const attachments = [
    {
      type: "inline_keyboard",
      payload: {
        buttons: buildBackButtonKeyboard()
      }
    }
  ];

  return answerMaxCallbackWithMessage(callbackId, target, text, attachments);
}

async function sendMusicInfo(target, userId) {
  const credits = await getMusicCredits(userId);
  const buyUrl = buildMusicBuyUrl(userId);

  if (credits > 0) {
    setUserImageMode(userId, IMAGE_MODE_MUSIC);

    return sendMaxMessageWithAttachments(
      target,
      [
        "🎵 **Режим создания музыки включён.**",
        "",
        `У вас доступно оплаченных треков: **${credits}**.`,
        "",
        "Теперь отправьте описание музыки.",
        "",
        "Пример:",
        "`Создай 30-секундный энергичный поп-трек для рекламы замороженного йогурта, летнее настроение, мягкий женский вокал, припев, современный бит`",
        "",
        "Лучше писать: жанр, настроение, инструменты, вокал или без вокала, где будет использоваться трек."
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: buildBackButtonKeyboard()
          }
        }
      ]
    );
  }

  let text =
    "🎵 **Создать музыку AI**\n\n" +
    `Стоимость: **${Number(MUSIC_PRICE_RUB).toFixed(0)} ₽** за один трек.\n\n` +
    "После оплаты вы получите **1 кредит** и сможете создать **MP3-трек на 30 секунд** через Lyria 3 Clip.\n\n" +
    "Можно сделать:\n" +
    "• музыку для рекламы;\n" +
    "• джингл;\n" +
    "• фон для Reels / Shorts;\n" +
    "• инструментал;\n" +
    "• трек с вокалом и текстом.";

  if (!buyUrl || !YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY || !GEMINI_API_KEY) {
    text += "\n\n⚠️ Оплата или Gemini API пока не настроены. Проверьте APP_PUBLIC_URL, YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY и GEMINI_API_KEY.";
  }

  const buttons = [];

  if (buyUrl && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY && GEMINI_API_KEY) {
    buttons.push([
      {
        type: "link",
        text: `💳 Купить музыку — ${Number(MUSIC_PRICE_RUB).toFixed(0)} ₽`,
        url: buyUrl
      }
    ]);

    buttons.push(buildPaymentEmailFallbackRow(PAYMENT_PRODUCT_MUSIC));
  }

  buttons.push([
    {
      type: "callback",
      text: "⬅️ Назад к меню",
      payload: MENU_BACK_PAYLOAD
    }
  ]);

  return sendMaxMessageWithAttachments(target, text, [
    {
      type: "inline_keyboard",
      payload: {
        buttons
      }
    }
  ]);
}

async function sendRestorationPhotoHelp(target) {
  const text =
    "🛠️ **Реставрация фото**\n\n" +
    "Режим реставрации включён✅\n\n" +
    "*Теперь просто отправьте старую фотографию.* Можно отправить фото без текста или фото с любым текстом — текст будет проигнорирован.\n\n" +
    "Бот использует только встроенный промт аккуратной реалистичной реставрации.";

  const attachments = [
    {
      type: "inline_keyboard",
      payload: {
        buttons: buildBackButtonKeyboard()
      }
    }
  ];

  return sendMaxMessageWithAttachments(target, text, attachments);
}

async function sendCreatePromptVideoHelp(target, userId) {
  const videoAccess = await getPromptVideoAccessForUser(userId);
  const buyUrl = buildPromptVideoBuyUrl(userId);

  if (videoAccess.allowed) {
    setUserImageMode(userId, IMAGE_MODE_PROMPT_VIDEO);

    return sendMaxMessageWithAttachments(
      target,
      [
        "📹 **Режим создания видео включён.**",
        "",
        `У вас доступно оплаченных видео: **${videoAccess.credits}**.`,
        "",
        "Теперь отправьте:",
        "• **просто промт** — бот создаст видео с нуля;",
        "• **фото + промт** — бот оживит/продолжит фото по вашему описанию.",
        "",
        "Видео будет создано на **5 секунд**, качество **720p**, модель **KLING**.",
        "",
        "Пример:",
        "`девушка в красном платье идёт по ночному городу, неоновый свет, плавная камера, реалистично`"
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: buildBackButtonKeyboard()
          }
        }
      ]
    );
  }

  let text =
    "📹 **Создать видео KLING**\n\n" +
    `Стоимость: **${Number(PROMPT_VIDEO_PRICE_RUB).toFixed(0)} ₽** за одно видео.\n\n` +
    "Что можно отправить:\n" +
    "• **просто промт** — создание видео с нуля;\n" +
    "• **фото + промт** — фото используется как исходный кадр/референс.\n" +
    " **Чем лучше фото-референс, тем лучше результат.** ✳️[ЛАЙФХАК](https://max.ru/c/-74096616285473/AZ4mEQYFWjA)\n\n" +
    "Параметры: **5 секунд**, качество **720p**, модель **KLING**.\n\n" +
    "После оплаты вы получите **1 видео-кредит**.";

  if (!buyUrl || !YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY || !FAL_KEY) {
    text += "\n\n⚠️ Оплата или FAL пока не настроены. Проверьте APP_PUBLIC_URL, YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY и FAL_KEY.";
  }

  const buttons = [];

  if (buyUrl && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY && FAL_KEY) {
    buttons.push([
      {
        type: "link",
        text: `💳 Купить видео — ${Number(PROMPT_VIDEO_PRICE_RUB).toFixed(0)} ₽`,
        url: buyUrl
      }
    ]);

    buttons.push(buildPaymentEmailFallbackRow(PAYMENT_PRODUCT_PROMPT_VIDEO));
  }

  buttons.push([
    {
      type: "callback",
      text: "⬅️ Назад к меню",
      payload: MENU_BACK_PAYLOAD
    }
  ]);

const keyboardAttachment = {
  type: "inline_keyboard",
  payload: {
    buttons
  }
};

const token = await getPromptVideoExampleMaxToken().catch((error) => {
  console.warn("Prompt video example token failed:", error?.message || error);
  return "";
});

if (token) {
  return sendMaxVideoTokenWithAttachments(target, text, token, [
    keyboardAttachment
  ]);
}

return sendMaxMessageWithAttachments(target, text, [
  keyboardAttachment
]);
  }

async function sendCreateVideoHelp(target, userId) {
  const videoAccess = await getVideoAccessForUser(userId);
  const buyUrl = buildVideoBuyUrl(userId);

  if (videoAccess.allowed) {
    setUserImageMode(userId, IMAGE_MODE_VIDEO);

    const accessText = `У вас доступно оплаченных видео: **${videoAccess.credits}**.`;

    return sendMaxMessageWithAttachments(
      target,
      [
        "🎬 **Режим оживления фото✅**",
        "",
        accessText,
        "",
        "Теперь просто отправьте **фото человека**.",
        "",
        "Любой текст в сообщении будет проигнорирован — бот использует встроенный промт:",
        "человек слегка улыбается, смотрит в камеру и мягко машет рукой.",
        "",
        "Видео будет создано через **Seedance Lite**, длительность **5 секунд**, качество **720p**."
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: buildBackButtonKeyboard()
          }
        }
      ]
    );
  }

  let text =
    "🎬 **Оживить фото**\n\n" +
    `Стоимость: **${Number(VIDEO_PRICE_RUB).toFixed(0)} ₽** за одно видео.\n\n` +
    "Что получится:\n" +
    "• человек сохранит лицо и внешность;\n" +
    "• слегка улыбнётся;\n" +
    "• будет смотреть в камеру;\n" +
    "• мягко помашет рукой, если это возможно по фото.\n\n" +
`**🥎Или создай бесплатно с [Алисой AI](${ALICE_AI_FREE_URL})**\n\n`;

  if (videoAccess.premium) {
    text +=
      "Ваши видео-кредиты Premium закончились.\n" +
      "Чтобы сделать ещё видео, купите Premium ещё раз или отдельный видео-кредит.\n\n";
  } else {
    text +=
      "После оплаты вы получите **1 видео-кредит**. Затем просто отправьте фото — текст будет проигнорирован.\n\n";
  }

  if (!buyUrl || !YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY || !FAL_KEY) {
    text += "⚠️ Оплата или FAL пока не настроены. Проверьте APP_PUBLIC_URL, YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY и FAL_KEY.";
  }

  const buttons = [];

  if (buyUrl && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY && FAL_KEY) {
    buttons.push([
      {
        type: "link",
        text: `💳 Купить видео — ${Number(VIDEO_PRICE_RUB).toFixed(0)} ₽`,
        url: buyUrl
      }
    ]);

    buttons.push(buildPaymentEmailFallbackRow(PAYMENT_PRODUCT_VIDEO));
  }

  buttons.push([
    {
      type: "callback",
      text: "⬅️ Назад к меню",
      payload: MENU_BACK_PAYLOAD
    }
  ]);

  const keyboardAttachment = {
    type: "inline_keyboard",
    payload: {
      buttons
    }
  };

  const token = await getVideoExampleMaxToken().catch((error) => {
    console.warn("Video example token failed:", error?.message || error);
    return "";
  });

  if (token) {
    return sendMaxVideoTokenWithAttachments(target, text, token, [
      keyboardAttachment
    ]);
  }

  return sendMaxMessageWithAttachments(target, text, [
    keyboardAttachment
  ]);
}

async function sendFamilyVideoHelp(target, userId) {
  const videoAccess = await getFamilyVideoAccessForUser(userId);
  const buyUrl = buildFamilyVideoBuyUrl(userId);

  const freePhotoButton = [
    {
      type: "callback",
      text: "📸 Создать фото бесплатно",
      payload: MENU_CREATE_PHOTO_PAYLOAD
    }
  ];

  if (videoAccess.allowed) {
    setUserImageMode(userId, IMAGE_MODE_FAMILY_VIDEO);
    clearFamilyVideoDraft(userId);

    const accessText =
      videoAccess.source === "premium"
        ? `У вас доступно Premium-видео сегодня: **${videoAccess.premiumVideosLeft}**.`
        : `У вас доступно оплаченных тренд-видео: **${videoAccess.credits}**.`;

    return sendMaxMessageWithAttachments(
      target,
      [
        "🔥 **Режим «ТРЕНД МЕСЯЦА» включён.**",
        "",
        accessText,
        "",
        "Подсказка:",
        "Вам нужно отправить **готовое фото для тренда**.",
        "Нажмите **«Создать фото бесплатно»**, выберите **«СТИЛИ»** и там выберите стиль **«⚾ ТРЕНД»**.",
        "Когда фото будет готово — просто отправьте его сюда, и бот создаст для вас тренд-видео.",
        "",
        "Видео будет создано через **KLING**, длительность **5 секунд**, вертикальный формат **9:16**."
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: [
              freePhotoButton,
              [
                {
                  type: "callback",
                  text: "⬅️ Назад",
                  payload: MENU_BACK_PAYLOAD
                }
              ]
            ]
          }
        }
      ]
    );
  }

  let text = [
    "🔥 **ТРЕНД МЕСЯЦА**",
    "",
    `Стоимость: **${Number(FAMILY_VIDEO_PRICE_RUB).toFixed(0)} ₽** за одно тренд-видео.`,
    "",
    "Подсказка:",
    "Вам нужно отправить **готовое фото для тренда**.",
    "Нажмите **«Создать фото бесплатно»**, выберите **«СТИЛИ»** и там выберите стиль **«⚾ ТРЕНД»**.",
    "Когда фото будет готово — просто отправьте его сюда, и бот создаст для вас тренд-видео.",
    "",
    "Видео будет создано через **KLING**, длительность **5 секунд**, вертикальный формат **9:16**.",
    ""
  ].join("\n");

  if (videoAccess.premium) {
    text += [
      "Ваше **Premium-видео на сегодня уже использовано**.",
      "Чтобы сделать ещё одно видео сегодня, можно купить отдельный тренд-видео-кредит.",
      ""
    ].join("\n");
  } else {
    text += [
      "После оплаты вы получите **1 тренд-видео-кредит**.",
      ""
    ].join("\n");
  }

  if (!buyUrl || !YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY || !FAL_KEY) {
    text += "⚠️ Оплата или FAL пока не настроены. Проверьте APP_PUBLIC_URL, YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY и FAL_KEY.";
  }

  const buttons = [];

  if (buyUrl && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY && FAL_KEY) {
    buttons.push([
      {
        type: "link",
        text: `💳 Купить тренд — ${Number(FAMILY_VIDEO_PRICE_RUB).toFixed(0)} ₽`,
        url: buyUrl
      }
    ]);

    buttons.push(buildPaymentEmailFallbackRow(PAYMENT_PRODUCT_FAMILY_VIDEO));
  }

  buttons.push(freePhotoButton);

  buttons.push([
    {
      type: "callback",
      text: "⬅️ Назад к меню",
      payload: MENU_BACK_PAYLOAD
    }
  ]);

  const keyboardAttachment = {
    type: "inline_keyboard",
    payload: {
      buttons
    }
  };

  const token = await getFamilyVideoExampleMaxToken().catch((error) => {
    console.warn("Trend month example token failed:", error?.message || error);
    return "";
  });

  if (token) {
    return sendMaxVideoTokenWithAttachments(target, text, token, [
      keyboardAttachment
    ]);
  }

  return sendMaxMessageWithAttachments(target, text, [
    keyboardAttachment
  ]);
}

function isMusicMode(userId) {
  return getUserImageMode(userId) === IMAGE_MODE_MUSIC;
}

function buildPremiumBuyUrl(userId) {
  if (!APP_PUBLIC_URL) return "";

  const url = new URL(`${APP_PUBLIC_URL}/premium/buy`);
  url.searchParams.set("user_id", String(userId || ""));

  return url.toString();
}

function buildProductCardBuyUrl(userId) {
  if (!APP_PUBLIC_URL) return "";

  const url = new URL(`${APP_PUBLIC_URL}/product-card/buy`);
  url.searchParams.set("user_id", String(userId || ""));

  return url.toString();
}

function buildMusicBuyUrl(userId) {
  if (!APP_PUBLIC_URL) return "";

  const url = new URL(`${APP_PUBLIC_URL}/music/buy`);
  url.searchParams.set("user_id", String(userId || ""));

  return url.toString();
}



function sanitizeSponsorPublicName(value) {
  return String(value || "")
    .replace(/[\r\n*_`[\]()~>#+\-=|{}.!]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

async function getLastPremiumSponsors(limit = 5) {
  if (!dbPool) return null;

  const safeLimit = Math.min(10, Math.max(1, Number(limit) || 5));

  const result = await dbPool.query(
    `
      SELECT first_name, paid_at
      FROM (
        SELECT DISTINCT ON (p.user_id)
          sanitize.first_name AS first_name,
          p.updated_at AS paid_at
        FROM max_bot_premium_payments p
        LEFT JOIN LATERAL (
          SELECT COALESCE(NULLIF(b.first_name, ''), '') AS first_name
          FROM max_bot_broadcast_users b
          WHERE b.user_id = p.user_id
            AND b.bot_key = p.bot_key
          LIMIT 1
        ) sanitize ON true
        WHERE p.bot_key = $1
          AND p.status = 'succeeded'
          AND COALESCE(p.raw->'metadata'->>'product', '') = 'premium_month'
          AND COALESCE(sanitize.first_name, '') <> ''
        ORDER BY p.user_id, p.updated_at DESC
      ) latest
      ORDER BY paid_at DESC
      LIMIT $2
    `,
    [BOT_KEY, safeLimit]
  );

  return result.rows.map((row) => ({
    first_name: sanitizeSponsorPublicName(row.first_name)
  })).filter((row) => row.first_name);
}

async function answerSponsorsList(callbackId, target) {
  const sponsors = await getLastPremiumSponsors(5);

  let sponsorsText = "";

  if (sponsors === null) {
    sponsorsText = "⚠️ DATABASE_URL не задан, поэтому список спонсоров недоступен.";
  } else if (!sponsors.length) {
    sponsorsText = "Пока список пуст. Первый спонсор появится здесь после оплаты Premium.";
  } else {
    sponsorsText = sponsors
      .map((sponsor, index) => `${index + 1}. ${sponsor.first_name}`)
      .join("\n");
  }

  const text = [
    "❤️ **Спонсоры**",
    "",
    "**🐣Спасибо этим людям, которые внесли огромный вклад в развитие нашего бота.**",
    "",
    sponsorsText
  ].join("\n");

  const attachments = [
    {
      type: "inline_keyboard",
      payload: {
        buttons: [
          [
            {
              type: "callback",
              text: "💵 Купить Премиум",
              payload: MENU_PREMIUM_PAYLOAD
            }
          ],
          [
            {
              type: "callback",
              text: "⬅️ Назад к меню",
              payload: MENU_BACK_PAYLOAD
            }
          ]
        ]
      }
    }
  ];

  return answerMaxCallbackWithMessage(callbackId, target, text, attachments);
}

async function sendPremiumInfo(target, userId) {
  const premiumUntil = await getUserPremiumUntil(userId);
  const buyUrl = buildPremiumBuyUrl(userId);

  const [
    promptVideoCredits,
    productCardCredits,
    musicCredits
  ] = await Promise.all([
    getPromptVideoCredits(userId),
    getProductCardCredits(userId),
    getMusicCredits(userId)
  ]);

  let text =
    "💵 **Купить Премиум**\n\n" +
    "*Что дает Премиум?*\n\n" +
    `**1️⃣ ${PREMIUM_IMAGE_REQUEST_LIMIT} фото в день с лучшей моделью.**\n` +
    `**2️⃣ ChatGPT ${PREMIUM_CHATGPT_REQUEST_LIMIT} запросов в день.**\n` +
    `**3️⃣ Оживить фото: ${PREMIUM_VIDEO_REQUEST_LIMIT} раз в день.**\n` +
    "**4️⃣ Ежедневный персональный гороскоп по выбранному времени.**\n" +
    "**5️⃣ Уйдет обязательная подписка на каналы.**\n" +
    "**6️⃣ Бонусные кредиты при каждой покупке Premium:**\n" +
    `•🎥создать видео: **+${PREMIUM_BONUS_PROMPT_VIDEO_CREDITS}**;\n` +
    `•🛍️создать карточку товара: **+${PREMIUM_BONUS_PRODUCT_CARD_CREDITS}**;\n` +
    `•🎶создать музыку: **+${PREMIUM_BONUS_MUSIC_CREDITS}**.\n\n` +
    "Кредиты за 🎥🎶🛍️ **суммируются** при повторной покупке Premium.\n\n" +
    "**Ваши текущие кредиты:**\n" +
    `• создать видео: **${promptVideoCredits}**;\n` +
    `• карточка товара: **${productCardCredits}**;\n` +
    `• музыка: **${musicCredits}**.\n\n` +
    "Вы становитесь **Спонсором Бота** и членом нашей семьи.🌟\n" +
    "**👌ВЫ ПОКУПАЕТЕ ПРЕМИУМ СЕТ (БЕЗ АВТОПРОДЛЕНИЯ)**\n\n" +
    `💳 Стоимость: *${Number(PREMIUM_PRICE_RUB).toFixed(0)} ₽ за ${PREMIUM_DURATION_DAYS} дней*.`;

  if (premiumUntil) {
    text += `\n\n✅ Premium уже активен до: ${new Date(premiumUntil).toLocaleString("ru-RU")}`;
  }

  if (!buyUrl || !YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
    text += "\n\n⚠️ Оплата пока не настроена. Проверьте APP_PUBLIC_URL, YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY.";
  }

  const buttons = [];

if (buyUrl && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY) {
  buttons.push([
    {
      type: "link",
      text: `💳 Купить Премиум — ${Number(PREMIUM_PRICE_RUB).toFixed(0)} ₽`,
      url: buyUrl
    }
  ]);

  buttons.push(buildPaymentEmailFallbackRow(PAYMENT_PRODUCT_PREMIUM));
}

buttons.push([
  {
    type: "callback",
    text: "🌠 Спонсоры",
    payload: MENU_SPONSORS_PAYLOAD
  }
]);

buttons.push([
  {
    type: "callback",
    text: "⬅️ Назад к меню",
    payload: MENU_BACK_PAYLOAD
  }
]);

  return sendMaxMessageWithAttachments(target, text, [
    {
      type: "inline_keyboard",
      payload: {
        buttons
      }
    }
  ]);
}

async function sendProductCardInfo(target, userId) {
  const credits = await getProductCardCredits(userId);
  const buyUrl = buildProductCardBuyUrl(userId);

  if (credits > 0) {
    setUserImageMode(userId, IMAGE_MODE_PRODUCT_CARD);

    return sendMaxMessageWithAttachments(
      target,
      [
        "🛒 **Режим карточки товара включён.**",
        "",
        `У вас доступно оплаченных пакетов: **${credits}**.`,
        "",
        "Теперь отправьте:",
        "• **фото товара + промт** — лучший вариант для точности;",
        "или",
        "• **просто промт товара** — если фото нет.",
        "",
        "Бот создаст **3 красивые карточки товара с разных ракурсов**.",
        "",
        "Пример промта:",
        "`Банка крема Nuvelora, премиальный бело-золотой дизайн, для маркетплейса, чистый фон, дорогой свет, надпись Nuvelora Anti-Age Cream`"
      ].join("\n"),
      [
        {
          type: "inline_keyboard",
          payload: {
            buttons: buildBackButtonKeyboard()
          }
        }
      ]
    );
  }

  let text =
    "🛒 **Создать карточку товара**\n\n" +
    "Стоимость: **79 ₽** за один пакет.\n\n" +
    "После оплаты вы сможете отправить **фото товара + промт** или просто **описание товара**.\n\n" +
    "Бот создаст **3 изображения товара**:\n" +
    "• фронтальная карточка;\n" +
    "• ракурс 3/4;\n" +
    "• lifestyle / премиальная витрина.\n\n" +
    "Для максимально точных надписей лучше отправлять фото товара, где текст уже есть на упаковке.";

  if (!buyUrl || !YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
    text += "\n\n⚠️ Оплата пока не настроена. Проверьте APP_PUBLIC_URL, YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY.";
  }

  const buttons = [];

  if (buyUrl && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY) {
    buttons.push([
      {
        type: "link",
        text: "💳 Купить за 79 ₽",
        url: buyUrl
      }
    ]);

    buttons.push(buildPaymentEmailFallbackRow(PAYMENT_PRODUCT_PRODUCT_CARD));
  }

  buttons.push([
    {
      type: "callback",
      text: "⬅️ Назад к меню",
      payload: MENU_BACK_PAYLOAD
    }
  ]);

  return sendMaxMessageWithAttachments(target, text, [
    {
      type: "inline_keyboard",
      payload: {
        buttons
      }
    }
  ]);
}

async function sendSubscriptionPrompt(target, userId, prefixText = "") {
  const text =
    `${prefixText ? `${prefixText}\n\n` : ""}` +
    "🔒 **Чтобы продолжить пользоваться ботом бесплатно, подпишитесь на каналы ниже и нажмите кнопку Я подписан(а)**.";

  const checkPayload = `${SUBSCRIPTION_CHECK_PAYLOAD}:${userId}`;

  // Просто показываем каналы, без индикатора подписки
  const subscribeButtons = REQUIRED_CHANNELS.map((channel, index) => [
    {
      type: "link",
      text: `📢 Подписаться на ${channel.title || `канал ${index + 1}`}`,
      url: channel.url
    }
  ]);

  const buttons = [
    ...subscribeButtons,
    [
      {
        type: "callback",
        text: "✅ Я подписан(а)",
        payload: checkPayload
      }
    ]
  ];

  await sendMaxMessageWithAttachments(target, text, [
    { type: "inline_keyboard", payload: { buttons } }
  ]);
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
    body.result?.memberships,

    body.payload?.members,
    body.payload?.items,
    body.payload?.users,
    body.payload?.subscribers,
    body.payload?.memberships,

    body.response?.members,
    body.response?.items,
    body.response?.users,
    body.response?.subscribers,
    body.response?.memberships
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    if (Array.isArray(candidate)) {
      return candidate;
    }

    if (typeof candidate === "object") {
      // Если это одиночный участник
      if (getMemberUserId(candidate)) {
        return [candidate];
      }

      const values = Object.values(candidate);

      if (values.some((v) => getMemberUserId(v))) {
        return values;
      }

      const firstArray = values.find(Array.isArray);
      if (firstArray) return firstArray;
    }
  }

  if (typeof body === "object") {
    if (getMemberUserId(body)) {
      return [body];
    }

    for (const value of Object.values(body)) {
      if (Array.isArray(value)) {
        return value;
      }

      if (value && typeof value === "object" && getMemberUserId(value)) {
        return [value];
      }
    }
  }

  return [];
}

function getMemberUserId(member) {
  // Если элемент — просто число или строка, считаем, что это user_id
  if (typeof member === "string" || typeof member === "number") {
    return String(member);
  }

  return (
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
    ""
  );
}

function isMemberActive(member) {
  if (!member) return false;

  // Если это примитив (строка/число) — считаем, что это активный user_id
  if (typeof member === "string" || typeof member === "number") {
    return true;
  }

  const status = String(
    member?.status ||
    member?.membership?.status ||
    member?.member?.status ||
    member?.role ||
    ""
  ).toLowerCase();

  const negativeStatuses = [
    "left",
    "leave",
    "kicked",
    "banned",
    "blocked",
    "not_member",
    "not_found",
    "none",
    "deleted"
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

  // В ответе MAX из Postman у участников нет status, но есть user_id.
  // Поэтому если user_id есть и нет отрицательного статуса — считаем участником/подписчиком.
  return Boolean(getMemberUserId(member));
}

function responseContainsActiveUser(body, userId) {
  const expectedUserId = String(userId);

  // Если API вернул сразу одного участника
  const rootUserId = String(getMemberUserId(body) || "");
  if (rootUserId === expectedUserId && isMemberActive(body)) {
    return true;
  }

  const members = extractMembersFromMaxResponse(body);

  for (const member of members) {
    const memberUserId = String(getMemberUserId(member) || "");

    if (memberUserId === expectedUserId && isMemberActive(member)) {
      return true;
    }
  }

  return false;
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
    ""
  ).trim();
}

async function checkSingleRequiredChannelSubscription(userId, requiredChannel) {
  if (!requiredChannel?.id) {
    console.warn("Required channel ID is not set. Cannot check subscription.");
    return false;
  }

  const channelId = encodeURIComponent(requiredChannel.id);
  const expectedUserId = String(userId).trim();

  const path = `/chats/${channelId}/members`;

  try {
    // 1. Сначала пробуем проверить конкретного пользователя.
    // Если MAX поддерживает фильтр user_ids/user_id — это самый правильный вариант.
    const directQueries = [
      { user_ids: expectedUserId },
      { user_id: expectedUserId },
      { count: 100, user_ids: expectedUserId },
      { count: 100, user_id: expectedUserId }
    ];

    for (const query of directQueries) {
      try {
        console.log(
          "Outgoing DIRECT subscription check:",
          JSON.stringify({
            method: "GET",
            path,
            query,
            expectedUserId,
            requiredChannelId: requiredChannel.id
          })
        );

        const directResult = await maxRequest(path, {
          method: "GET",
          query
        });

        const members = extractMembersFromMaxResponse(directResult);

        console.log(
          "DIRECT subscription check response:",
          JSON.stringify({
            channelId: requiredChannel.id,
            expectedUserId,
            membersCount: members.length,
            sampleIds: members.slice(0, 10).map((m) => String(getMemberUserId(m) || ""))
          })
        );

        if (responseContainsActiveUser(directResult, expectedUserId)) {
          console.log(
            `Subscription check result for user ${expectedUserId}, channel ${requiredChannel.id}: true by direct query`
          );
          return true;
        }
      } catch (directError) {
        console.warn(
          `Direct subscription query failed for user ${expectedUserId}, channel ${requiredChannel.id}:`,
          directError?.message || directError
        );
      }
    }

    // 2. Fallback: листаем участников.
    // ВАЖНО: 20 страниц мало. Увеличиваем.
    let marker = "";
    let page = 0;

    const maxPages = Number(process.env.SUBSCRIPTION_MAX_PAGES || 500);
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

      console.log(
        "Outgoing subscription check:",
        JSON.stringify({
          method: "GET",
          path,
          query,
          expectedUserId,
          requiredChannelId: requiredChannel.id,
          page
        })
      );

      const result = await maxRequest(path, {
        method: "GET",
        query
      });

      const members = extractMembersFromMaxResponse(result);

      console.log(
        "Subscription check page response:",
        JSON.stringify({
          page,
          channelId: requiredChannel.id,
          expectedUserId,
          membersCount: members.length,
          sampleIds: members.slice(0, 10).map((m) => String(getMemberUserId(m) || ""))
        })
      );

      if (responseContainsActiveUser(result, expectedUserId)) {
        console.log(
          `Subscription check result for user ${expectedUserId}, channel ${requiredChannel.id}: true`
        );
        return true;
      }

      const nextMarker = getNextMembersMarker(result);

      if (!nextMarker) {
        break;
      }

      if (nextMarker === marker || seenMarkers.has(nextMarker)) {
        console.warn(
          `Subscription pagination loop detected for channel ${requiredChannel.id}, marker=${nextMarker}`
        );
        break;
      }

      seenMarkers.add(nextMarker);
      marker = nextMarker;
    }

    console.log(
      `Subscription check result for user ${expectedUserId}, channel ${requiredChannel.id}: false after ${page} pages`
    );

    return false;
  } catch (error) {
    const message = String(error?.message || error);

    console.warn(
      `Subscription check failed for user ${expectedUserId}, channel ${requiredChannel.id}:`,
      message
    );

    if (/method\.not\.found/i.test(message)) {
      console.warn(
        "MAX endpoint не найден. Проверь, что используется GET /chats/{channelId}/members."
      );
    }

    if (/Method is not available for dialogs/i.test(message)) {
      console.warn(
        `MAX считает ID диалогом. Проверь ID канала: ${requiredChannel.id}`
      );
    }

    return false;
  }
}

async function checkRequiredChannelSubscription(userId) {
  if (isSubscriptionVerified(userId)) return true;

  if (!REQUIRED_CHANNELS.length) {
    console.warn("REQUIRED_CHANNELS is empty. Cannot check subscription.");
    return false;
  }

  for (const requiredChannel of REQUIRED_CHANNELS) {
    const subscribed = await checkSingleRequiredChannelSubscription(
      userId,
      requiredChannel
    );

    if (!subscribed) {
      console.log(
        `User ${userId} is not subscribed to required channel ${requiredChannel.id}`
      );

      return false;
    }
  }

  console.log(`User ${userId} is subscribed to all required channels`);
  return true;
}

async function handleSubscriptionCheck(target, userId, callbackId = "") {
  const subscribed = await checkRequiredChannelSubscription(userId);

  if (subscribed) {
    markSubscriptionVerified(userId);

    if (callbackId) {
      await answerMaxCallback(
        callbackId,
        "✅ Подписка найдена. Доступ открыт."
      );
    }

    await sendMaxMessage(
      target,
      "✅ Подписка проверена. Доступ открыт, можете продолжать пользоваться ботом."
    );

    return true;
  }

  if (callbackId) {
    await answerMaxCallback(
      callbackId,
      "❌ Пока не вижу подписку. Подпишитесь и нажмите «Проверить» ещё раз."
    );
  }

  await sendSubscriptionPrompt(
    target,
    userId,
    "❌ Пока не вижу подписку на канал."
  );

  return false;
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

  const found = candidates.find((value) => value !== undefined && value !== null && String(value).trim());
  return found ? String(found) : "";
}

async function editMaxMessage(messageId, text) {
  if (!messageId) return null;

  return maxRequest("/messages", {
    method: "PUT",
    query: { message_id: messageId },
    body: {
      text,
      notify: false
    }
  });
}

const { Pool } = pg;

// Общая база данных PostgreSQL.
// Можно использовать DATABASE_URL от другого бота.
const DATABASE_URL = process.env.DATABASE_URL || "";

// Уникальное имя этого бота в общей базе.
// Если хочешь отделять пользователей разных ботов — оставь уникальным.
const BOT_KEY = process.env.BOT_KEY || "max_openai_bot";
const LIMITS_TABLE = "max_bot_limits";
const BROADCAST_USE_ALL_BOTS = false;

// ID админов, которым разрешена рассылка.
// Пример:
// ADMIN_USER_IDS=282278177,282278177
const ADMIN_USER_IDS = new Set(
  String(process.env.ADMIN_USER_IDS || process.env.ADMIN_USER_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

// Пауза между сообщениями рассылки
const BROADCAST_DELAY_MS = Number(process.env.BROADCAST_DELAY_MS || 350);

const dbPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl:
        String(process.env.DATABASE_SSL || "true").toLowerCase() === "false"
          ? false
          : { rejectUnauthorized: false }
    })
  : null;

if (!DATABASE_URL) {
  console.warn("DATABASE_URL is not set. Broadcast users DB will be unavailable.");
}

if (!ADMIN_USER_IDS.size) {
  console.warn("ADMIN_USER_IDS is not set. Broadcast command will be unavailable.");
}

async function deleteMaxMessage(messageId) {
  if (!messageId) return;

  try {
    await maxRequest("/messages", {
      method: "DELETE",
      query: { message_id: messageId }
    });
    return;
  } catch (error) {
    console.warn("MAX message delete failed, fallback to clearing status:", error?.message || error);
  }

  try {
    await editMaxMessage(messageId, "⠀");
  } catch (error) {
    console.warn("MAX status clear fallback failed:", error?.message || error);
  }
}

async function startDynamicStatus(target, baseText) {
  let frameIndex = 0;
  let stopped = false;
  let editInProgress = false;

  const sent = await sendMaxSingleMessage(target, `${baseText}${STATUS_DOT_FRAMES[frameIndex]}`, false).catch(
    (error) => {
      console.warn("Failed to send dynamic status:", error?.message || error);
      return null;
    }
  );

  const messageId = extractMaxMessageId(sent);

  if (!messageId) {
    return {
      stop: async () => {}
    };
  }

  const timer = setInterval(async () => {
    if (stopped || editInProgress) return;

    editInProgress = true;
    frameIndex = (frameIndex + 1) % STATUS_DOT_FRAMES.length;

    try {
      await editMaxMessage(messageId, `${baseText}${STATUS_DOT_FRAMES[frameIndex]}`);
    } catch (error) {
      console.warn("Failed to edit dynamic status:", error?.message || error);
    } finally {
      editInProgress = false;
    }
  }, STATUS_UPDATE_INTERVAL_MS);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await deleteMaxMessage(messageId);
    }
  };
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];

  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") parts.push(content.text);
      if (typeof content?.output_text === "string") parts.push(content.output_text);
    }
  }

  return parts.join("\n").trim();
}

async function askOpenAI(userId, userText) {
  const history = getChatContext(userId);

  const response = await fetch(`${OPENAI_API_BASE}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content:
            "Ты полезный ассистент внутри мессенджера MAX. Отвечай кратко, ясно и по делу. Если вопрос требует пошагового ответа, структурируй ответ простыми абзацами. Используй смайлики в ответах. Если пользователь просит промт, промпт, prompt или promt — верни только сам готовый промт без объяснений, без вступления, без заголовков и без фразы «вот промт». Сам промт должен быть внутри двойных кавычек. Пример формата: \"cinematic portrait, soft light, realistic details\". Твой создатель Бот SOSai."
        },
        ...history,
        {
          role: "user",
          content: userText
        }
      ]
    })
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`OpenAI API ${response.status}: ${JSON.stringify(data)}`);
  }

  const answer =
    extractOpenAIText(data) ||
    "Я получил сообщение, но не смог сформировать ответ.";

  rememberChatTurn(userId, userText, answer);

  return answer;
}

function extractImageBase64(data) {
  const fromImagesApi = data?.data?.[0]?.b64_json;
  if (typeof fromImagesApi === "string" && fromImagesApi.trim()) {
    return fromImagesApi.trim();
  }

  const fromResponsesApi = [];

  for (const item of data?.output || []) {
    if (item?.type === "image_generation_call" && typeof item?.result === "string") {
      fromResponsesApi.push(item.result);
    }
  }

  return fromResponsesApi[0] || "";
}

function buildImageJsonBody(prompt, options = {}) {
  const model = options.model || OPENAI_IMAGE_MODEL;
  const size = options.size || OPENAI_IMAGE_SIZE;
  const quality = options.quality || OPENAI_IMAGE_QUALITY;
  const outputFormat = options.output_format || OPENAI_IMAGE_OUTPUT_FORMAT;

  const body = {
    model,
    prompt,
    n: 1,
    size,
    quality,
    output_format: outputFormat
  };

  if (model.startsWith("dall-e")) {
    body.response_format = "b64_json";
  }

  return body;
}

const SOFT_IMAGE_PROMPT_REPLACEMENTS = [
  // базовые сексуальные триггеры
  [/без\s+лифчика/giu, "без видимых бретелей"],
  [/без\s+бюстгальтера/giu, "без видимых бретелей"],
  [/\bлифчик\b/giu, "топ"],
  [/\bбюстгальтер\b/giu, "топ"],
  [/прозрачн\w*\s+(топ|одежд\w*)/giu, "легкая ткань без откровенности"],
  [/\bсоски\b/giu, "детали одежды"],
  [/\bгол(ая|ый|ое|ые)\b/giu, "в одежде"],
  [/обнаж(енн|ённ)\w*/giu, "в одежде"],
  [/\bню\b/giu, "портрет"],
  [/\bэротич\w*\b/giu, "стильный"],
  [/\bэротик\w*\b/giu, "стильный"],
  [/\bсексуальн\w*\b/giu, "элегантный"],
  [/\bsex(y)?\b/giu, "stylish"],
  [/нижн\w+\s+бель[её]/giu, "домашняя одежда"],
  [/\bв белье\b/giu, "в домашнем образе"],
  
  // дополнения для vintage, collage, portrait и модных промтов
  [/tight white cropped t-shirt/giu, "светлый топ с мягкой тканью"],
  [/lifting the shirt/giu, "слегка поправляет одежду"],
  [/arms raised above the head/giu, "руки подняты в расслабленной позе"],
  [/glamorous woman/giu, "женщина в стильном образе"],
  [/candid poses/giu, "естественные позы"],
  [/confident feminine energy/giu, "уверенная поза и выражение"],
  [/long voluminous hair/giu, "длинные мягкие волосы"],
  [/full makeup/giu, "аккуратный макияж"],
  [/nude lips/giu, "естественные губы"],
  [/defined eyes/giu, "выразительные глаза"],
  [/contour/giu, "легкая контурировка"],
  [/glowing skin/giu, "естественная кожа"],
  [/soft flash photography/giu, "мягкая студийная вспышка"],
  [/faded analog texture/giu, "легкая винтажная текстура"],
  [/dusty vintage effect/giu, "пыльный ретро-эффект"],
  [/early 2000s aesthetic/giu, "стиль начала 2000-х"],
  [/realistic body proportions/giu, "естественные пропорции тела"],
  [/visible pores/giu, "видимая текстура кожи"],
  [/natural skin texture/giu, "естественная текстура кожи"],
  [/cinematic direct flash lighting/giu, "кинематографичное освещение"],
  [/authentic retro photo booth vibe/giu, "аутентичный ретро-стиль"],
  [/shot on iPhone \d+/giu, "съемка на смартфон"],
  [/film effect overlay/giu, "эффект пленки"],
  [/tight\s*tank top/giu, "топ из мягкой ткани"],
  [/form-fitting/giu, "естественно сидящая одежда"],
  [/slightly lifting shirt/giu, "слегка поправляет одежду"],
  [/exposed midriff/giu, "с естественным силуэтом"],
  [/reveal(ing)?/giu, "показывает одежду"],
  [/lingerie/giu, "домашний топ"],
  [/underwear/giu, "топ"],
  [/panties/giu, "нижняя часть одежды без откровенности"],
  [/bra/giu, "топ"],
  [/bare shoulders/giu, "с открытыми плечами, но в одежде"],
  [/bare legs/giu, "естественные ноги в одежде или колготках"],
  [/thong/giu, "нижняя часть одежды"],
  [/cleavage/giu, "декоративный вырез топа"],
  [/revealing outfit/giu, "легкий образ одежды"],
  [/exposed skin/giu, "естественная кожа, закрытая одеждой"],
  [/erotic pose/giu, "стильная поза"],
  [/seductive/giu, "элегантная"],
  [/sexually suggestive/giu, "стильный образ"],
  [/explicit/giu, "нейтральный стиль"],
  [/nsfw/giu, "suitable for work"],
  [/porn/giu, "без откровенности"],
  [/nude/giu, "в одежде"],
  [/nipples?/giu, "детали одежды"],
  [/cleavage/giu, "топ с вырезом"]
];

const HARD_BLOCK_IMAGE_PATTERNS = [
  /\b(porn|porno|порно|nsfw|xxx)\b/iu,
  /\b(секс|минет|орал\w*|анальн\w*|мастурб\w*|фетиш\w*)\b/iu,
  /\b(реб[её]нок|дети|детский|школьниц\w*|несовершеннолет\w*|teen)\b.*\b(гол\w*|обнаж\w*|эрот\w*|сексу\w*)\b/iu
];

function normalizePromptText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isOpenAIImageModerationError(error) {
  const message = String(error?.message || error || "");
  return /moderation_blocked|safety_violations|rejected by the safety system|content_policy|blocked by safety/i.test(message);
}

function createSoftModerationBlockedError() {
  const error = new Error("image_prompt_soft_blocked");
  error.userMessage = [
    "📲 **Не получилось создать фото:** запрос слишком откровенный или содержит спорные формулировки.",
    "",
    "Попробуйте описать задачу нейтрально:",
    "• вместо откровенности — стиль, ткань, фасон;",
    "• вместо белья — топ, платье, образ;",
    "• без сексуального акцента."
  ].join("\n");
  return error;
}

function softenImagePrompt(rawPrompt, { strict = false } = {}) {
  const original = normalizePromptText(rawPrompt);

  if (!original) {
    return {
      prompt: "",
      changed: false,
      blocked: false
    };
  }

  // Сначала проверяем жёстко запрещённые случаи
  const blocked = HARD_BLOCK_IMAGE_PATTERNS.some((pattern) => pattern.test(original));

  let softened = original;
  let changed = false;

  for (const [pattern, replacement] of SOFT_IMAGE_PROMPT_REPLACEMENTS) {
    const next = softened.replace(pattern, replacement);
    if (next !== softened) {
      changed = true;
      softened = next;
    }
  }

  softened = normalizePromptText(softened);

  const safetySuffix = strict
    ? "Important safety requirements: keep the result safe-for-work, non-explicit, fully clothed, no nudity, no underwear focus, no erotic posing, no fetish elements."
    : "Safety requirements: keep the result safe-for-work, non-explicit and without nudity or erotic emphasis.";

  const finalPrompt = `${softened}\n\n${safetySuffix}`.trim();

  debugLog("softenImagePrompt:", {
    strict,
    changed,
    original,
    finalPrompt
  });

  return {
    prompt: finalPrompt,
    changed,
    blocked
  };
}

async function generateImageWithSoftModeration({
  rawPrompt,
  inputImage = null,
  inputImages = null,
  imageOptions = {}
}) {
  const firstAttempt = softenImagePrompt(rawPrompt, { strict: false });

  if (firstAttempt.blocked) {
    throw createSoftModerationBlockedError();
  }

  try {
    if (Array.isArray(inputImages) && inputImages.length > 0) {
      return await runImageOpenAI(() =>
        editOpenAIImageMultiple(firstAttempt.prompt, inputImages, imageOptions)
      );
    }

    if (inputImage) {
      return await runImageOpenAI(() =>
        editOpenAIImage(firstAttempt.prompt, inputImage, imageOptions)
      );
    }

    return await runImageOpenAI(() =>
      generateOpenAIImage(firstAttempt.prompt, imageOptions)
    );
  } catch (error) {
    if (!isOpenAIImageModerationError(error)) {
      throw error;
    }

    // Если OpenAI всё равно заблокировал — пробуем ещё раз с более строгим смягчением
    const secondAttempt = softenImagePrompt(rawPrompt, { strict: true });

    if (secondAttempt.blocked || secondAttempt.prompt === firstAttempt.prompt) {
      throw error;
    }

    debugLog("Retrying image generation with stricter softened prompt");

    if (Array.isArray(inputImages) && inputImages.length > 0) {
      return await runImageOpenAI(() =>
        editOpenAIImageMultiple(secondAttempt.prompt, inputImages, imageOptions)
      );
    }

    if (inputImage) {
      return await runImageOpenAI(() =>
        editOpenAIImage(secondAttempt.prompt, inputImage, imageOptions)
      );
    }

    return await runImageOpenAI(() =>
      generateOpenAIImage(secondAttempt.prompt, imageOptions)
    );
  }
}



async function generateOpenAIImage(prompt, options = {}) {
  const response = await fetch(`${OPENAI_API_BASE}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(buildImageJsonBody(prompt, options))
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`OpenAI image API ${response.status}: ${JSON.stringify(data)}`);
  }

  const imageBase64 = extractImageBase64(data);
  if (!imageBase64) {
    throw new Error("OpenAI image API did not return b64_json");
  }

  return Buffer.from(imageBase64, "base64");
}


async function editOpenAIImage(prompt, inputImage, options = {}) {
  const form = new FormData();

  const model = options.model || OPENAI_IMAGE_MODEL;
  const size = options.size || OPENAI_IMAGE_SIZE;
  const quality = options.quality || OPENAI_IMAGE_QUALITY;
  const outputFormat = options.output_format || OPENAI_IMAGE_OUTPUT_FORMAT;

  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", quality);
  form.append("output_format", outputFormat);

  if (model.startsWith("dall-e")) {
    form.append("response_format", "b64_json");
  }

  form.append(
    "image",
    new Blob([inputImage.buffer], { type: inputImage.mime || "image/png" }),
    inputImage.filename || "input.png"
  );

  const response = await fetch(`${OPENAI_API_BASE}/images/edits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: form
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`OpenAI image edit API ${response.status}: ${JSON.stringify(data)}`);
  }

  const imageBase64 = extractImageBase64(data);
  if (!imageBase64) {
    throw new Error("OpenAI image edit API did not return b64_json");
  }

  return Buffer.from(imageBase64, "base64");
}

async function editOpenAIImageMultiple(prompt, inputImages, options = {}) {
  const form = new FormData();

  const model = options.model || OPENAI_IMAGE_MODEL;
  const size = options.size || OPENAI_IMAGE_SIZE;
  const quality = options.quality || OPENAI_IMAGE_QUALITY;
  const outputFormat = options.output_format || OPENAI_IMAGE_OUTPUT_FORMAT;

  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", quality);
  form.append("output_format", outputFormat);

  if (model.startsWith("dall-e")) {
    form.append("response_format", "b64_json");
  }

  for (let index = 0; index < inputImages.length; index += 1) {
    const inputImage = inputImages[index];

    form.append(
      "image[]",
      new Blob([inputImage.buffer], { type: inputImage.mime || "image/png" }),
      inputImage.filename || `input_${index + 1}.png`
    );
  }

  const response = await fetch(`${OPENAI_API_BASE}/images/edits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: form
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`OpenAI multi image edit API ${response.status}: ${JSON.stringify(data)}`);
  }

  const imageBase64 = extractImageBase64(data);

  if (!imageBase64) {
    throw new Error("OpenAI multi image edit API did not return b64_json");
  }

  return Buffer.from(imageBase64, "base64");
}

function collectUrls(value, urls = []) {
  if (!value) return urls;

  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) urls.push(value);
    return urls;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, urls);
    return urls;
  }

  if (typeof value === "object") {
    for (const item of Object.values(value)) collectUrls(item, urls);
  }

  return urls;
}

function extractIncomingImageUrls(update) {
  const attachments = update?.message?.body?.attachments || [];
  const imageUrls = [];

  for (const attachment of attachments) {
    const type = String(attachment?.type || "").toLowerCase();

    if (type && !["image", "photo", "file"].includes(type)) continue;

    const urls = collectUrls(attachment);

    const imageUrl =
      urls.find((url) => /\.(png|jpe?g|webp|gif|bmp|tiff?|heic)(\?|#|$)/i.test(url)) ||
      urls[0];

    if (imageUrl) imageUrls.push(imageUrl);
  }

  return imageUrls;
}

function extractIncomingImageUrl(update) {
  return extractIncomingImageUrls(update)[0] || "";
}

function guessMimeFromUrl(url) {
  const cleanUrl = url.split("?")[0].split("#")[0].toLowerCase();

  if (cleanUrl.endsWith(".jpg") || cleanUrl.endsWith(".jpeg")) return "image/jpeg";
  if (cleanUrl.endsWith(".webp")) return "image/webp";
  if (cleanUrl.endsWith(".gif")) return "image/gif";
  if (cleanUrl.endsWith(".bmp")) return "image/bmp";
  if (cleanUrl.endsWith(".tif") || cleanUrl.endsWith(".tiff")) return "image/tiff";
  if (cleanUrl.endsWith(".heic")) return "image/heic";

  return "image/png";
}

function extensionFromMime(mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "image/bmp") return "bmp";
  if (mime === "image/tiff") return "tiff";
  if (mime === "image/heic") return "heic";

  return "png";
}

async function fetchImageBuffer(url, withAuth = false) {
  const headers = withAuth && MAX_BOT_TOKEN ? { Authorization: MAX_BOT_TOKEN } : undefined;

  const response = await fetch(url, {
    method: "GET",
    headers
  });

  if (!response.ok) {
    throw new Error(`Image download ${response.status}: ${await response.text().catch(() => "")}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);

  if (contentLength > MAX_INPUT_IMAGE_BYTES) {
    throw new Error(`Image is too large: ${contentLength} bytes`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length > MAX_INPUT_IMAGE_BYTES) {
    throw new Error(`Image is too large: ${buffer.length} bytes`);
  }

  const mime = (response.headers.get("content-type") || guessMimeFromUrl(url))
    .split(";")[0]
    .trim();

  if (!mime.startsWith("image/")) {
    throw new Error(`Downloaded file is not an image: ${mime}`);
  }

  return {
    buffer,
    mime,
    filename: `input.${extensionFromMime(mime)}`
  };
}

async function downloadIncomingImage(url) {
  try {
    return await fetchImageBuffer(url, false);
  } catch (error) {
    if (!/\b(401|403)\b/.test(String(error?.message || ""))) throw error;
    return fetchImageBuffer(url, true);
  }
}



async function uploadImageBufferToMax(
  imageBuffer,
  mime = "image/png",
  filename = "image.png"
) {
  if (!imageBuffer || !imageBuffer.length) {
    throw new Error("Image buffer is empty");
  }

  const uploadInfo = await maxRequest("/uploads", {
    method: "POST",
    query: { type: "image" }
  });

  const uploadUrl = uploadInfo?.url || uploadInfo?.upload_url;

  if (!uploadUrl) {
    throw new Error(`MAX upload URL is missing: ${JSON.stringify(uploadInfo)}`);
  }

  let token = uploadInfo?.token;

  const cleanMime = String(mime || "image/png").split(";")[0].trim();
  const cleanFilename = String(filename || `image.${extensionFromMime(cleanMime)}`);

  const form = new FormData();

  form.append(
    "data",
    new Blob([imageBuffer], { type: cleanMime }),
    cleanFilename
  );

  const response = await fetch(uploadUrl, {
    method: "POST",
    body: form
  });

  const bodyText = await response.text();

  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = bodyText;
  }

  if (!response.ok) {
    const details = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`MAX upload ${response.status}: ${details}`);
  }

  if (!token) {
    if (body?.token) token = body.token;
    if (body?.retval && typeof body.retval === "string") token = body.retval;
    if (body?.payload?.token) token = body.payload.token;
  }

  if (body?.payload && typeof body.payload === "object") return body.payload;
  if (body?.retval && typeof body.retval === "object") return body.retval;
  if (token) return { token };

  if (typeof body === "object" && body) return body;

  throw new Error(`MAX upload returned unexpected body: ${JSON.stringify(body)}`);
}

async function uploadImageToMax(imageBuffer) {
  return uploadImageBufferToMax(
    imageBuffer,
    `image/${OPENAI_IMAGE_OUTPUT_FORMAT}`,
    `openai-image.${OPENAI_IMAGE_OUTPUT_FORMAT}`
  );
}

async function sendMaxImage(target, text, imageBuffer) {
  const payload = await uploadImageToMax(imageBuffer);

  const attachments = [
    { type: "image", payload },
    {
      type: "inline_keyboard",
      payload: {
        buttons: buildBackButtonKeyboard()
      }
    }
  ];

  let lastError;

  for (let attempt = 0; attempt < MAX_ATTACHMENT_RETRIES; attempt += 1) {
    try {
      await sendMaxMessageWithAttachments(target, text, attachments);
      return;
    } catch (error) {
      lastError = error;

      const message = String(error?.message || "");

      if (!/attachment\.not\.ready|not\.processed|not ready/i.test(message)) {
        throw error;
      }

      await sleep(700 * (attempt + 1));
    }
  }

  throw lastError;
}

async function sendMaxImageUrlWithAttachments(
  target,
  text,
  imageUrl,
  extraAttachments = []
) {
  const cleanImageUrl = String(imageUrl || "").trim();

  if (!cleanImageUrl || cleanImageUrl.startsWith("ССЫЛКА_")) {
    return sendMaxMessageWithAttachments(target, text, extraAttachments);
  }

  const inputImage = await fetchImageBuffer(cleanImageUrl, false);

  const imagePayload = await uploadImageBufferToMax(
    inputImage.buffer,
    inputImage.mime,
    inputImage.filename
  );

  const attachments = [
    {
      type: "image",
      payload: imagePayload
    },
    ...extraAttachments
  ];

  let lastError;

  for (let attempt = 0; attempt < MAX_ATTACHMENT_RETRIES; attempt += 1) {
    try {
      await sendMaxMessageWithAttachments(target, text || null, attachments);
      return;
    } catch (error) {
      lastError = error;

      const message = String(error?.message || "");

      if (!/attachment\.not\.ready|not\.processed|not ready/i.test(message)) {
        throw error;
      }

      await sleep(700 * (attempt + 1));
    }
  }

  throw lastError;
}

async function sendMaxBroadcastImagePost(
  target,
  text,
  imagePayload,
  extraAttachments = []
) {
  const attachments = [
    {
      type: "image",
      payload: imagePayload
    },
    ...extraAttachments
  ];

  let lastError;

  for (let attempt = 0; attempt < MAX_ATTACHMENT_RETRIES; attempt += 1) {
    try {
      await sendMaxMessageWithAttachments(target, text || null, attachments);
      return;
    } catch (error) {
      lastError = error;

      const message = String(error?.message || "");

      if (!/attachment\.not\.ready|not\.processed|not ready/i.test(message)) {
        throw error;
      }

      await sleep(700 * (attempt + 1));
    }
  }

  throw lastError;
}

function getGeminiBlockReason(data) {
  return String(
    data?.promptFeedback?.blockReason ||
    data?.prompt_feedback?.block_reason ||
    ""
  ).trim();
}

class GeminiPromptBlockedError extends Error {
  constructor(blockReason, data) {
    super(`Gemini prompt blocked: ${blockReason}`);
    this.name = "GeminiPromptBlockedError";
    this.code = "GEMINI_PROMPT_BLOCKED";
    this.blockReason = blockReason;
    this.data = data;
    this.userMessage = [
      "⚠️ **Lyria не смогла создать музыку по этому описанию.**",
      "",
      `Причина: промт заблокирован фильтром Gemini: **${blockReason}**.`,
      "",
      "Кредит не списан. Отправьте описание заново.",
      "",
      "Лучше писать так:",
      "• жанр: поп, электроника, рок, джаз, lo-fi;",
      "• настроение: энергично, спокойно, премиально, летне;",
      "• инструменты: гитара, пианино, синтезатор, барабаны;",
      "• вокал: без вокала / мягкий женский вокал / мужской вокал;",
      "• не просите стиль конкретного артиста, существующую песню или узнаваемую мелодию.",
      "",
      "Пример:",
      "`30-секундный энергичный поп-трек для рекламы кафе, летнее настроение, гитара, лёгкий вокал, современный бит`"
    ].join("\n");
  }
}

function extractGeminiMusicResult(data) {
  const blockReason = getGeminiBlockReason(data);

  if (blockReason) {
    throw new GeminiPromptBlockedError(blockReason, data);
  }

  const candidate = data?.candidates?.[0];

  if (!candidate) {
    throw new Error(
      `Gemini Lyria returned no candidates: ${JSON.stringify(data).slice(0, 1200)}`
    );
  }

  const finishReason = String(
    candidate?.finishReason ||
    candidate?.finish_reason ||
    ""
  ).trim();

  if (/SAFETY|PROHIBITED_CONTENT|BLOCKLIST|IMAGE_SAFETY/i.test(finishReason)) {
    throw new GeminiPromptBlockedError(finishReason, data);
  }

  const parts = candidate?.content?.parts || [];

  let audioBase64 = "";
  let mimeType = "audio/mpeg";
  const textParts = [];

  for (const part of parts) {
    if (typeof part?.text === "string" && part.text.trim()) {
      textParts.push(part.text.trim());
    }

    const inlineData = part?.inlineData || part?.inline_data;

    if (inlineData?.data) {
      audioBase64 = String(inlineData.data);
      mimeType = String(
        inlineData.mimeType ||
        inlineData.mime_type ||
        "audio/mpeg"
      );
    }
  }

  if (!audioBase64) {
    throw new Error(
      [
        "Gemini Lyria returned candidates but no audio.",
        `finishReason=${finishReason || "none"}`,
        `text=${textParts.join("\n").slice(0, 500)}`,
        `response=${JSON.stringify(data).slice(0, 1200)}`
      ].join(" ")
    );
  }

  return {
    audioBuffer: Buffer.from(audioBase64, "base64"),
    mimeType,
    text: textParts.join("\n").trim()
  };
}

async function generateGeminiMusic(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const cleanPrompt = String(prompt || "").trim();

  if (!cleanPrompt) {
    throw new Error("Music prompt is empty");
  }

  const finalPrompt = [
    "Create a 30-second original music track.",
    "The result must be original AI-generated music.",
    "Do not imitate any specific real artist, band, copyrighted song, soundtrack, jingle, or recognizable melody.",
    "Do not include hateful, explicit, dangerous, or illegal themes.",
    "Use generic musical descriptors only: genre, mood, tempo, instruments, vocals, arrangement, and intended use.",
    "",
    "User music brief:",
    cleanPrompt
  ].join("\n");

  const response = await fetch(
    `${GEMINI_API_BASE}/models/${encodeURIComponent(GEMINI_LYRIA_MODEL)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: finalPrompt
              }
            ]
          }
        ]
      })
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`Gemini Lyria API ${response.status}: ${JSON.stringify(data)}`);
  }

  return extractGeminiMusicResult(data);
}

function makeDataUriFromImage(inputImage) {
  const mime = inputImage?.mime || "image/png";
  const base64 = inputImage?.buffer?.toString("base64");

  if (!base64) {
    throw new Error("Input image buffer is empty");
  }

  return `data:${mime};base64,${base64}`;
}

async function falRequest(url, options = {}) {
  if (!FAL_KEY) {
    throw new Error("FAL_KEY is not set");
  }

  const headers = {
    Authorization: `Key ${FAL_KEY}`
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method: options.method || "GET",
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
    const details = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`FAL API ${response.status}: ${details}`);
  }

  return body;
}

function extractFalVideoUrl(data) {
  return String(
    data?.video?.url ||
    data?.data?.video?.url ||
    data?.result?.video?.url ||
    ""
  ).trim();
}

async function downloadBufferFromUrl(url, expectedPrefix = "") {
  const response = await fetch(url, {
    method: "GET"
  });

  if (!response.ok) {
    throw new Error(`File download failed ${response.status}: ${await response.text().catch(() => "")}`);
  }

  const mime = String(response.headers.get("content-type") || "").toLowerCase();

  if (expectedPrefix && mime && !mime.startsWith(expectedPrefix)) {
    console.warn(`Downloaded file has unexpected mime type: ${mime}`);
  }

  const arrayBuffer = await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

function buildPromptVideoPrompt(userText, hasInputImage) {
  const cleanPrompt = String(userText || "").trim();

  return `
Create a short realistic video based on the user's prompt.

User prompt:
${cleanPrompt}

${hasInputImage ? "Use the input image as the visual reference and starting frame. Preserve the main subject, face, product, clothing, colors, composition, and overall identity as much as possible. Animate it according to the user prompt." : "Create the video from the text prompt only."}

Technical requirements:
- duration: 5 seconds;
- resolution: 480p;
- smooth natural motion;
- realistic camera movement only if useful for the prompt;
- no random text, logos, watermarks, subtitles, distorted hands or faces;
- keep the result clean and suitable for social media.
`.trim();
}

async function waitFalVideoResult(submitResult, timeoutMessage = "FAL video generation timeout") {
  let videoUrl = extractFalVideoUrl(submitResult);

  if (!videoUrl) {
    const statusUrl = String(submitResult?.status_url || "").trim();
    const responseUrl = String(submitResult?.response_url || "").trim();

    if (!statusUrl || !responseUrl) {
      throw new Error(`FAL queue response missing status_url/response_url: ${JSON.stringify(submitResult)}`);
    }

    const startedAt = Date.now();

    while (Date.now() - startedAt < FAL_QUEUE_TIMEOUT_MS) {
      await sleep(FAL_QUEUE_POLL_INTERVAL_MS);

      const statusResult = await falRequest(statusUrl, {
        method: "GET"
      });

      const status = String(statusResult?.status || "").toUpperCase();

      if (["COMPLETED", "COMPLETE", "DONE", "SUCCEEDED"].includes(status)) {
        const result = await falRequest(responseUrl, {
          method: "GET"
        });

        videoUrl = extractFalVideoUrl(result);

        if (!videoUrl) {
          throw new Error(`FAL result has no video.url: ${JSON.stringify(result).slice(0, 1200)}`);
        }

        break;
      }

      if (["FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(status)) {
        throw new Error(`FAL generation failed: ${JSON.stringify(statusResult).slice(0, 1200)}`);
      }
    }
  }

  if (!videoUrl) {
    throw new Error(timeoutMessage);
  }

  return downloadBufferFromUrl(videoUrl, "video/");
}

async function makePromptVideoFromFalSeedance({ prompt, inputImage = null }) {
  const hasInputImage = Boolean(inputImage?.buffer?.length);
  const finalPrompt = buildPromptVideoPrompt(prompt, hasInputImage);

  let body = {
    prompt: finalPrompt,
    duration: "5",
    resolution: "480p",
    aspect_ratio: "9:16",
    enable_safety_checker: true
  };

  let endpoint = FAL_SEEDANCE_TEXT_TO_VIDEO_URL;

  if (hasInputImage) {
    const imageUrl = await uploadImageToFalCdn(inputImage);
    endpoint = CREATE_VIDEO_MODEL;
    body = {
      ...body,
      image_url: imageUrl
    };
  }

  const submitResult = await falRequest(endpoint, {
    method: "POST",
    body
  });

  return waitFalVideoResult(submitResult, "FAL prompt video generation timeout");
}

async function makeVideoFromFalSeedance({ inputImage }) {
  const imageUrl = await uploadImageToFalCdn(inputImage);

  const submitResult = await falRequest(FAL_SEEDANCE_IMAGE_TO_VIDEO_URL, {
    method: "POST",
    body: {
      prompt: VIDEO_ANIMATE_PHOTO_PROMPT,
      image_url: imageUrl,
      duration: "5",
      resolution: "480p",
      aspect_ratio: "auto",
      camera_fixed: true,
      enable_safety_checker: true
    }
  });

  let videoUrl = extractFalVideoUrl(submitResult);

  if (!videoUrl) {
    const statusUrl = String(submitResult?.status_url || "").trim();
    const responseUrl = String(submitResult?.response_url || "").trim();

    if (!statusUrl || !responseUrl) {
      throw new Error(`FAL queue response missing status_url/response_url: ${JSON.stringify(submitResult)}`);
    }

    const startedAt = Date.now();

    while (Date.now() - startedAt < FAL_QUEUE_TIMEOUT_MS) {
      await sleep(FAL_QUEUE_POLL_INTERVAL_MS);

      const statusResult = await falRequest(statusUrl, {
        method: "GET"
      });

      const status = String(statusResult?.status || "").toUpperCase();

      if (["COMPLETED", "COMPLETE", "DONE", "SUCCEEDED"].includes(status)) {
        const result = await falRequest(responseUrl, {
          method: "GET"
        });

        videoUrl = extractFalVideoUrl(result);

        if (!videoUrl) {
          throw new Error(`FAL result has no video.url: ${JSON.stringify(result).slice(0, 1200)}`);
        }

        break;
      }

      if (["FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(status)) {
        throw new Error(`FAL generation failed: ${JSON.stringify(statusResult).slice(0, 1200)}`);
      }
    }
  }

  if (!videoUrl) {
    throw new Error("FAL video generation timeout");
  }

  return downloadBufferFromUrl(videoUrl, "video/");
}

async function makeTrendMonthVideoFromFalKling({ inputImage }) {
  const imageUrl = await uploadImageToFalCdn(inputImage);

  const submitResult = await falRequest(CREATE_VIDEO_MODEL, {
    method: "POST",
    body: {
      prompt: TREND_MONTH_VIDEO_PROMPT,
      image_url: imageUrl,
      duration: "5",
      resolution: "480p",
      aspect_ratio: "9:16",
      enable_safety_checker: true
    }
  });

  return waitFalVideoResult(submitResult, "FAL trend month video generation timeout");
}

async function makeFamilyVideoFromFalSeedance({ startImage, endImage }) {
  const [startImageUrl, endImageUrl] = await Promise.all([
    uploadImageToFalCdn(startImage),
    uploadImageToFalCdn(endImage)
  ]);

  const submitResult = await falRequest(FAL_SEEDANCE_IMAGE_TO_VIDEO_URL, {
    method: "POST",
    body: {
      prompt: FAMILY_VIDEO_PROMPT,
      image_url: startImageUrl,
      end_image_url: endImageUrl,
      duration: "6",
      resolution: "480p",
      aspect_ratio: "9:16",
      camera_fixed: false,
      enable_safety_checker: true
    }
  });

  let videoUrl = extractFalVideoUrl(submitResult);

  if (!videoUrl) {
    const statusUrl = String(submitResult?.status_url || "").trim();
    const responseUrl = String(submitResult?.response_url || "").trim();

    if (!statusUrl || !responseUrl) {
      throw new Error(`FAL queue response missing status_url/response_url: ${JSON.stringify(submitResult)}`);
    }

    const startedAt = Date.now();

    while (Date.now() - startedAt < FAL_QUEUE_TIMEOUT_MS) {
      await sleep(FAL_QUEUE_POLL_INTERVAL_MS);

      const statusResult = await falRequest(statusUrl, {
        method: "GET"
      });

      const status = String(statusResult?.status || "").toUpperCase();

      if (["COMPLETED", "COMPLETE", "DONE", "SUCCEEDED"].includes(status)) {
        const result = await falRequest(responseUrl, {
          method: "GET"
        });

        videoUrl = extractFalVideoUrl(result);

        if (!videoUrl) {
          throw new Error(`FAL result has no video.url: ${JSON.stringify(result).slice(0, 1200)}`);
        }

        break;
      }

      if (["FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(status)) {
        throw new Error(`FAL generation failed: ${JSON.stringify(statusResult).slice(0, 1200)}`);
      }
    }
  }

  if (!videoUrl) {
    throw new Error("FAL family video generation timeout");
  }

  return downloadBufferFromUrl(videoUrl, "video/");
}

async function uploadVideoToMaxAndGetToken(videoBuffer) {
  if (!videoBuffer || !videoBuffer.length) throw new Error("Video buffer is empty");

  // step 1: получить uploadUrl и token (token часто приходит здесь)
  const uploadInfo = await maxRequest("/uploads", {
    method: "POST",
    query: { type: "video" }
  });

  const uploadUrl = uploadInfo?.url || uploadInfo?.upload_url;
  if (!uploadUrl) {
    throw new Error(`MAX /uploads(type=video) returned no url: ${JSON.stringify(uploadInfo)}`);
  }

  // token чаще всего тут
  let token = uploadInfo?.token;

  const form = new FormData();
  form.append("data", new Blob([videoBuffer], { type: "video/mp4" }), "openai-video.mp4");

  // step 2: загрузка по uploadUrl (обычно возвращает retval, а не token)
  const resp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: MAX_BOT_TOKEN
    },
    body: form
  });

  const bodyText = await resp.text();
  if (!resp.ok) {
    throw new Error(`MAX video upload step2 failed ${resp.status}: ${bodyText?.slice(0, 500)}`);
  }

  // Fallback: если token не пришёл на step1 — попробуем вытащить из step2
  if (!token) {
    // вариант 1: JSON
    try {
      const json = JSON.parse(bodyText);
      token = json?.token;
    } catch {}

    // вариант 2: <retval>TOKEN</retval>
    if (!token) {
      const m = String(bodyText || "").match(/<retval>\s*([\s\S]*?)\s*<\/retval>/i);
      if (m?.[1]) token = m[1];
    }
  }

  if (!token) {
    throw new Error(
      `MAX video upload no token. step1=${JSON.stringify(uploadInfo)} step2=${bodyText}`
    );
  }

  return String(token).trim();
}

function isVideoMode(userId) {
  return getUserImageMode(userId) === IMAGE_MODE_VIDEO;
}

function isFamilyVideoMode(userId) {
  return getUserImageMode(userId) === IMAGE_MODE_FAMILY_VIDEO;
}

function buildVideoBuyUrl(userId, mode = "") {
  if (!APP_PUBLIC_URL) return "";

  const url = new URL(`${APP_PUBLIC_URL}/video/buy`);
  url.searchParams.set("user_id", String(userId || ""));

  const cleanMode = String(mode || "").trim();
  if (cleanMode) {
    url.searchParams.set("mode", cleanMode);
  }

  return url.toString();
}

function isPromptVideoMode(userId) {
  return getUserImageMode(userId) === IMAGE_MODE_PROMPT_VIDEO;
}

function buildPromptVideoBuyUrl(userId) {
  if (!APP_PUBLIC_URL) return "";

  const url = new URL(`${APP_PUBLIC_URL}/prompt-video/buy`);
  url.searchParams.set("user_id", String(userId || ""));

  return url.toString();
}

function buildFamilyVideoBuyUrl(userId) {
  if (!APP_PUBLIC_URL) return "";

  const url = new URL(`${APP_PUBLIC_URL}/family-video/buy`);
  url.searchParams.set("user_id", String(userId || ""));

  return url.toString();
}

async function sendMaxVideo(target, text, videoBuffer) {
  const token = await uploadVideoToMaxAndGetToken(videoBuffer);

  const attachments = [
    { type: "video", payload: { token } },
    {
      type: "inline_keyboard",
      payload: {
        buttons: buildBackButtonKeyboard()
      }
    }
  ];

  const retries = Number(process.env.VIDEO_SEND_RETRIES || 4);
  const baseDelayMs = Number(process.env.VIDEO_SEND_RETRY_DELAY_MS || 1200);

  let lastError;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      // по докам: делаем паузу перед отправкой/повтором
      await sleep(baseDelayMs * (attempt + 1));
      await sendMaxMessageWithAttachments(target, text || null, attachments);
      return;
    } catch (e) {
      lastError = e;
      const message = String(e?.message || "");
      if (!/attachment\.not\.ready|not\.processed|not ready/i.test(message)) throw e;
    }
  }

  throw lastError;
}

function extensionFromAudioMime(mime) {
  const value = String(mime || "").toLowerCase();

  if (value.includes("wav")) return "wav";
  if (value.includes("m4a")) return "m4a";
  if (value.includes("ogg")) return "ogg";

  return "mp3";
}

async function uploadAudioToMaxAndGetToken(audioBuffer, mime = "audio/mpeg") {
  if (!audioBuffer || !audioBuffer.length) {
    throw new Error("Audio buffer is empty");
  }

  const uploadInfo = await maxRequest("/uploads", {
    method: "POST",
    query: { type: "audio" }
  });

  const uploadUrl = uploadInfo?.url || uploadInfo?.upload_url;

  if (!uploadUrl) {
    throw new Error(`MAX /uploads(type=audio) returned no url: ${JSON.stringify(uploadInfo)}`);
  }

  let token = uploadInfo?.token;

  const ext = extensionFromAudioMime(mime);
  const form = new FormData();

  form.append(
    "data",
    new Blob([audioBuffer], { type: mime || "audio/mpeg" }),
    `lyria-music.${ext}`
  );

  const resp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: MAX_BOT_TOKEN
    },
    body: form
  });

  const bodyText = await resp.text();

  if (!resp.ok) {
    throw new Error(`MAX audio upload step2 failed ${resp.status}: ${bodyText?.slice(0, 500)}`);
  }

  if (!token) {
    try {
      const json = JSON.parse(bodyText);
      token = json?.token || json?.retval;
    } catch {}

    if (!token) {
      const m = String(bodyText || "").match(/<retval>\s*([\s\S]*?)\s*<\/retval>/i);
      if (m?.[1]) token = m[1];
    }
  }

  if (!token) {
    throw new Error(
      `MAX audio upload no token. step1=${JSON.stringify(uploadInfo)} step2=${bodyText}`
    );
  }

  return String(token).trim();
}

async function sendMaxAudio(target, text, audioBuffer, mime = "audio/mpeg") {
  const token = await uploadAudioToMaxAndGetToken(audioBuffer, mime);

  const attachments = [
    {
      type: "audio",
      payload: { token }
    },
    {
      type: "inline_keyboard",
      payload: {
        buttons: buildBackButtonKeyboard()
      }
    }
  ];

  const retries = Number(process.env.AUDIO_SEND_RETRIES || 5);
  const baseDelayMs = Number(process.env.AUDIO_SEND_RETRY_DELAY_MS || 1200);

  let lastError;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await sleep(baseDelayMs * (attempt + 1));
      await sendMaxMessageWithAttachments(target, text || null, attachments);
      return;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");

      if (!/attachment\.not\.ready|not\.processed|not ready/i.test(message)) {
        throw error;
      }
    }
  }

  throw lastError;
}

function makeImageCaption(prompt, edited) {
  const safePrompt = String(prompt || "").slice(0, 1000);

  return edited
    ? `${PHOTO_READY_LINK_TEXT} Отредактировал фото по запросу:
${safePrompt}`
    : `${PHOTO_READY_LINK_TEXT} Промт:
${safePrompt}`;
}

function safeUserError(error) {
  if (error?.userMessage) {
    return error.userMessage;
  }

  const message = String(error?.message || error || "Unknown error");

  // Сначала FAL / Seedance, чтобы ошибки видео не попадали в блок Gemini
  if (/FAL|fal|Seedance|queue\.fal|safety_checker|video\.url|FAL API|fal\.ai/i.test(message)) {
    return [
      "🎬 Не получилось создать видео через FAL Seedance.",
      "",
      "Возможные причины:",
      "• не задан или неверный FAL_KEY;",
      "• закончился баланс FAL;",
      "• нет доступа к модели Seedance;",
      "• фото или промт не подошли для генерации видео;",
      "• модель заблокировала запрос фильтром безопасности;",
      "• временная ошибка очереди FAL.",
      "",
      "Кредит лучше проверить вручную в базе, потому что он списывается только после успешной отправки видео."
    ].join("\n");
  }

  // Фото / OpenAI image moderation — до Gemini/Lyria, чтобы IMAGE_SAFETY не показывался как Lyria.
  if (/content_policy|moderation|IMAGE_SAFETY|safety_system|ResponsibleAIPolicyViolation|policy_violation|blocked by safety|rejected by.*safety/i.test(message)) {
    return [
      "📲 **Не получилось создать фото:** запрос или изображение не прошли проверку безопасности.",
      "",
      "Попробуйте заменить фото или смягчить описание: без спорных тем, откровенности, насилия, персональных документов и запрещённых деталей."
    ].join("\n");
  }

  // Отдельно Gemini / Lyria safety
  if (/Gemini|Lyria|generativelanguage|PROHIBITED_CONTENT|promptFeedback|blockReason|prompt blocked|SAFETY|BLOCKLIST/i.test(message)) {
    return [
      "⚠️ Запрос был заблокирован фильтром безопасности Gemini/Lyria.",
      "",
      "Кредит не списан. Попробуйте переформулировать описание без реальных артистов, существующих песен, узнаваемых мелодий и спорных тем.",
      "",
      "Пример:",
      "`30-секундный энергичный поп-трек, летнее настроение, гитара, лёгкий вокал, современный рекламный бит`"
    ].join("\n");
  }

  if (/OpenAI/i.test(message)) {
    return "Не получилось получить ответ от OpenAI. Проверьте модель, ключ API и лимиты аккаунта.";
  }

  if (/MAX/i.test(message)) {
    return "Не получилось отправить ответ в MAX. Проверьте токен, webhook и права бота.";
  }

  return "Произошла ошибка при обработке запроса.";
}

const PRODUCT_CARD_ANGLES = [
  {
    title: "Главная карточка",
    instruction:
      "exact same product from the reference image, front-facing packshot, centered, pure clean marketplace background, premium studio lighting, preserve packaging exactly"
  },
  {
    title: "Карточка 3/4",
    instruction:
      "exact same product from the reference image, slight three-quarter view if possible, clean premium background, preserve packaging exactly, commercial product photography"
  },
  {
    title: "Премиальная подача",
    instruction:
      "exact same product from the reference image, elegant commercial composition, minimal premium props, preserve packaging exactly, luxury advertising look"
  }
];

function buildProductCardPrompt(userText, angleIndex, hasInputImage) {
  const angle = PRODUCT_CARD_ANGLES[angleIndex] || PRODUCT_CARD_ANGLES[0];

  if (hasInputImage) {
    return `
Создай профессиональную карточку товара для маркетплейса.

ВАЖНО: используй входное фото как точный исходник товара.
Нужно сохранить именно тот товар, который изображён на фото.
Не заменяй его другим товаром.

Тип карточки:
${angle.title}

Пожелания пользователя:
${String(userText || "").trim()}

Обязательные требования:
- сохранить товар максимально точно;
- сохранить форму упаковки;
- сохранить цвет упаковки;
- сохранить крышку, банку, флакон или тюбик без замены;
- сохранить логотип;
- сохранить название бренда;
- сохранить весь читаемый текст максимально близко к оригиналу;
- сохранить расположение надписей и элементов дизайна;
- не создавать новый продукт;
- не менять бренд;
- не выдумывать новый текст;
- не делать другую банку вместо исходной.

Можно менять только:
- фон;
- свет;
- композицию;
- тени;
- общую рекламную подачу.

Техническое направление:
${angle.instruction}

Результат:
- дорогая, чистая, продающая карточка товара;
- товар в центре внимания;
- профессиональная коммерческая подача;
- без интерфейса;
- без коллажей;
- без посторонних объектов, если они не нужны.
`.trim();
  }

  return `
Создай профессиональную карточку товара для маркетплейса.

Описание товара:
${String(userText || "").trim()}

Тип карточки:
${angle.title}

Техническое направление:
${angle.instruction}

Требования:
- дорогой коммерческий вид;
- чистая композиция;
- профессиональный студийный свет;
- товар главный объект;
- без лишних брендов и водяных знаков.

Результат:
одно готовое изображение карточки товара.
`.trim();
}

async function handleImageRequest(update, target, userText, incomingImageUrl, userId = target.id, captionOverride = "", imageOptionsOverride = null) {
  const rawPrompt = String(userText || "").trim();

  if (!rawPrompt) {
    await sendMaxMessage(
      target,
      "Пришлите описание изображения. Например: создай фото кота в космосе, кинематографичный стиль."
    );
    return;
  }

  const shouldApplyPhotoFormat =
    !getUserImageMode(userId) &&
    !captionOverride &&
    !imageOptionsOverride;

const prompt = shouldApplyPhotoFormat
    ? buildPromptWithPhotoFormat(rawPrompt, userId)
    : rawPrompt;

  const selectedPhotoFormatOptions = shouldApplyPhotoFormat
    ? getPhotoFormatImageOptions(userId)
    : {};

  // Берём текущие лимиты пользователя из БД (или памяти)
  const currentCounts = await getUserRequestCounts(userId);
  const userLimits = await getUserDailyLimits(userId);
  

  // Проверка дневного лимита по картинкам
  if (await isRequestLimitReached(userId, "images", userLimits.images)) {
    await sendMaxMessage(
      target,
      userLimits.premium
        ? "🥱Вы достигли **Premium-лимита** на сегодня: 20 фото. Приходите позже и продолжайте."
        : "🥱Вы достигли лимита на создание **Шедевров** сегодня, приходите позже и продолжайте"
    );
    return;
  }

  // Проверка необходимости подписки
  if (await isSubscriptionRequiredForRequest(userId, "images")) {
    await sendSubscriptionPrompt(
      target,
      userId,
      `Вы уже создали ${IMAGE_REQUESTS_BEFORE_SUBSCRIPTION} фото бесплатно.`
    );
    return;
  }

  // Определяем, что это ПЕРВОЕ изображение пользователя (до инкремента)
  const isFirstImageEver = (currentCounts.images || 0) === 0;

  // Сначала инкрементируем счётчик в БД
  await incrementRequestCount(userId, "images");

  // Скачиваем входное изображение (если есть)
  const inputImage = incomingImageUrl ? await downloadIncomingImage(incomingImageUrl) : null;

  // Для первой картинки — другая модель/качество/размер
  const baseImageOptions = userLimits.premium
    ? {
        model: PREMIUM_IMAGE_MODEL,
        size: PREMIUM_IMAGE_SIZE,
        quality: PREMIUM_IMAGE_QUALITY
      }
    : isFirstImageEver
      ? {
          model: FIRST_IMAGE_MODEL,
          size: FIRST_IMAGE_SIZE,
          quality: FIRST_IMAGE_QUALITY
        }
      : {};

const imageOptions = {
  ...baseImageOptions,
  ...selectedPhotoFormatOptions,
  ...(imageOptionsOverride && typeof imageOptionsOverride === "object"
    ? imageOptionsOverride
    : {})
};

const imageBuffer = await generateImageWithSoftModeration({
  rawPrompt: prompt,
  inputImage,
  imageOptions
});
  await sendMaxImage(
  target,
  captionOverride || makeImageCaption(rawPrompt, Boolean(inputImage)),
  imageBuffer
);

await maybeSendRandomNudgeAfterGeneration(target, userId);

}

async function handleReplacementImageRequest(
  update,
  target,
  userText,
  sourceImageUrl,
  identityImageUrl,
  userId = target.id,
  captionOverride = "",
  imageOptionsOverride = null
) {
  const prompt = String(userText || "").trim();

  if (!prompt) {
    await sendMaxMessage(
      target,
      "Пришлите 2 фото для замены человека.\n\nФото 1 — кого заменяем.\nФото 2 — кем заменяем."
    );
    return;
  }

  if (!sourceImageUrl || !identityImageUrl) {
    await sendMaxMessage(
      target,
      "Для режима **ЗАМЕНА ЧЕЛОВЕКА** нужно 2 фото.\n\nФото 1 — кого заменяем.\nФото 2 — кем заменяем."
    );
    return;
  }

  const currentCounts = await getUserRequestCounts(userId);
  const userLimits = await getUserDailyLimits(userId);

  if (await isRequestLimitReached(userId, "images", userLimits.images)) {
    await sendMaxMessage(
      target,
      userLimits.premium
        ? "🥱Вы достигли **Premium-лимита** на сегодня: 20 фото. Приходите позже и продолжайте."
        : "🥱Вы достигли лимита на создание **Шедевров** сегодня, приходите позже и продолжайте"
    );
    return;
  }

  if (await isSubscriptionRequiredForRequest(userId, "images")) {
    await sendSubscriptionPrompt(
      target,
      userId,
      `Вы уже создали ${IMAGE_REQUESTS_BEFORE_SUBSCRIPTION} фото бесплатно.`
    );
    return;
  }

  const isFirstImageEver = (currentCounts.images || 0) === 0;

  await incrementRequestCount(userId, "images");

  const sourceImage = await downloadIncomingImage(sourceImageUrl);
  const identityImage = await downloadIncomingImage(identityImageUrl);

  const baseImageOptions = userLimits.premium
    ? {
        model: PREMIUM_IMAGE_MODEL,
        size: PREMIUM_IMAGE_SIZE,
        quality: PREMIUM_IMAGE_QUALITY
      }
    : isFirstImageEver
      ? {
          model: FIRST_IMAGE_MODEL,
          size: FIRST_IMAGE_SIZE,
          quality: FIRST_IMAGE_QUALITY
        }
      : {};

  const imageOptions =
    imageOptionsOverride && typeof imageOptionsOverride === "object"
      ? {
          ...baseImageOptions,
          ...imageOptionsOverride
        }
      : baseImageOptions;

const imageBuffer = await generateImageWithSoftModeration({
  rawPrompt: prompt,
  inputImages: [sourceImage, identityImage],
  imageOptions
});

  await sendMaxImage(
    target,
    captionOverride || makeImageCaption(prompt, true),
    imageBuffer
  );

  await maybeSendRandomNudgeAfterGeneration(target, userId);
}

async function handleProductCardRequest(update, target, userText, incomingImageUrl, userId = target.id) {
  const prompt = String(userText || "").trim();

  if (!prompt) {
    await sendMaxMessage(
      target,
      "🛒 Отправьте описание товара. Лучше всего: **фото товара + промт**.\n\nПример: `Крем для лица Nuvelora, бело-золотая упаковка, премиальная карточка для маркетплейса, чистый фон, четкая надпись Nuvelora`"
    );
    return;
  }

  const credits = await getProductCardCredits(userId);

  if (credits <= 0) {
    clearUserImageMode(userId);
    await sendProductCardInfo(target, userId);
    return;
  }

  const inputImage = incomingImageUrl ? await downloadIncomingImage(incomingImageUrl) : null;

  const imageOptions = {
    model: PRODUCT_CARD_IMAGE_MODEL,
    size: PRODUCT_CARD_IMAGE_SIZE,
    quality: PRODUCT_CARD_IMAGE_QUALITY
  };

  const imageBuffers = [];

  for (let i = 0; i < PRODUCT_CARD_IMAGES_COUNT; i += 1) {
    const productPrompt = buildProductCardPrompt(prompt, i, Boolean(inputImage));

    console.log("Product card generation:", {
      userId,
      index: i + 1,
      model: imageOptions.model,
      size: imageOptions.size,
      quality: imageOptions.quality
    });

    const imageBuffer = await runImageOpenAI(() =>
      inputImage
        ? editOpenAIImage(productPrompt, inputImage, imageOptions)
        : generateOpenAIImage(productPrompt, imageOptions)
    );

    imageBuffers.push(imageBuffer);
  }

  for (let i = 0; i < imageBuffers.length; i += 1) {
    await sendMaxImage(
      target,
      `🛒 Карточка товара ${i + 1}/${imageBuffers.length}`,
      imageBuffers[i]
    );
  }

  const consumeResult = await consumeProductCardCredit(userId);

  clearUserImageMode(userId);

  if (!consumeResult.consumed) {
    console.warn(`Product card credit was not consumed for user ${userId}`);
  }

  await sendMaxMessage(
    target,
    [
      `✅ **${PHOTO_READY_LINK_TEXT}** Создал 3 карточки товара.`,
      "",
      `Осталось оплаченных пакетов: **${consumeResult.creditsLeft || 0}**.`,
      "",
      "Если нужна ещё одна карточка товара — нажмите кнопку в меню и купите новый пакет."
    ].join("\n")
  );
}

async function handleMusicRequest(update, target, userText, userId = target.id) {
  const prompt = String(userText || "").trim();

  if (!prompt) {
    await sendMaxMessage(
      target,
      [
        "🎵 Отправьте описание музыки.",
        "",
        "Пример:",
        "`Создай 30-секундный современный рекламный трек для бренда косметики, премиальный вайб, мягкий женский вокал, поп-электроника, чистый припев`"
      ].join("\n")
    );
    return;
  }

  const credits = await getMusicCredits(userId);

  if (credits <= 0) {
    clearUserImageMode(userId);
    await sendMusicInfo(target, userId);
    return;
  }

  let result;

  try {
    result = await runMusicGemini(() => generateGeminiMusic(prompt));
  } catch (error) {
    if (error?.code === "GEMINI_PROMPT_BLOCKED") {
      console.warn("Gemini/Lyria prompt blocked:", {
        userId,
        blockReason: error.blockReason,
        prompt: prompt.slice(0, 500)
      });

      await sendMaxMessage(target, error.userMessage);
      return;
    }

    throw error;
  }

  await sendMaxAudio(
    target,
    [
      "🎵 **Готово. Создал музыку на 30 секунд.**",
      "",
      `Промт: ${prompt.slice(0, 700)}`,
      result.text ? `\n\nОписание от Lyria:\n${result.text.slice(0, 1000)}` : ""
    ].join("\n"),
    result.audioBuffer,
    result.mimeType
  );

  const consumeResult = await consumeMusicCredit(userId);

  clearUserImageMode(userId);

  if (!consumeResult.consumed) {
    console.warn(`Music credit was not consumed for user ${userId}`);
  }

  await sendMaxMessage(
    target,
    [
      "✅ **Трек создан.**",
      "",
      `Осталось оплаченных треков: **${consumeResult.creditsLeft || 0}**.`,
      "",
      "Для нового трека нажмите кнопку «Создать музыку» в меню и купите ещё один кредит."
    ].join("\n")
  );
}

async function handlePromptVideoRequest(update, target, userText, incomingImageUrl, userId = target.id) {
  const cleanPrompt = String(userText || "").trim();

  if (!cleanPrompt) {
    await sendMaxMessage(
      target,
      "🎞️ Режим создания видео включён. Отправьте **промт** или **фото + промт**."
    );
    return;
  }

  const videoAccess = await getPromptVideoAccessForUser(userId);

  if (!videoAccess.allowed) {
    clearUserImageMode(userId);
    await sendCreatePromptVideoHelp(target, userId);
    return;
  }

  const inputImage = incomingImageUrl
    ? await downloadIncomingImage(incomingImageUrl)
    : null;

  const videoBuffer = await makePromptVideoFromFalSeedance({
    prompt: cleanPrompt,
    inputImage
  });

  await sendMaxVideo(
    target,
    [
      "🎞️ **Готово. Видео создано.**",
      "",
      "Видео создано на **5 секунд**, качество **720p**, модель **KLING**.",
      "",
      inputImage
        ? "Использованы фото и промт пользователя."
        : "Использован промт пользователя."
    ].join("\n"),
    videoBuffer
  );

  clearUserImageMode(userId);

  const consumeResult = await consumePromptVideoCredit(userId);

  if (!consumeResult.consumed) {
    console.warn(`Prompt video credit was not consumed for user ${userId}`);
  }

  await sendMaxMessage(
    target,
    [
      "✅ **Видео создано.**",
      "",
      `Осталось оплаченных видео: **${consumeResult.creditsLeft || 0}**.`,
      "",
      "Для нового видео нажмите «🎞️ Создать видео» в меню и купите ещё один кредит."
    ].join("\n")
  );

  await maybeSendRandomNudgeAfterGeneration(target, userId);
}

async function handleVideoRequest(update, target, userText, incomingImageUrl, userId = target.id) {
  if (!incomingImageUrl) {
    await sendMaxMessage(
      target,
      "🎬 Режим оживления фото включён. Отправьте **фото человека**. Текст писать не нужно."
    );
    return;
  }

  const videoAccess = await getVideoAccessForUser(userId);

  if (!videoAccess.allowed) {
    clearUserImageMode(userId);
    await sendCreateVideoHelp(target, userId);
    return;
  }

  const inputImage = await downloadIncomingImage(incomingImageUrl);

  const videoBuffer = await makeVideoFromFalSeedance({
    inputImage
  });

  await sendMaxVideo(
    target,
    [
      "🎬 **Готово. Фото оживлено.**",
      "",
      "Видео создано на 5 секунд через Seedance Lite.",
      "",
      "Текст пользователя не использовался — применён встроенный промт оживления фото."
    ].join("\n"),
    videoBuffer
  );

  clearUserImageMode(userId);

  if (videoAccess.source === "premium") {
    await incrementRequestCount(userId, "videos");

    const countsAfter = await getUserRequestCounts(userId);
    const limitsAfter = await getUserDailyLimits(userId);

    const premiumVideosLeft = Math.max(
      0,
      Number(limitsAfter.videos || 0) - Number(countsAfter.videos || 0)
    );

    await sendMaxMessage(
      target,
      [
        "✅ **Видео создано за счёт Premium.**",
        "",
        `Premium-видео на сегодня осталось: **${premiumVideosLeft}**.`,
        "",
        premiumVideosLeft > 0
          ? "Можете создать ещё одно Premium-видео сегодня."
          : "Если нужно ещё видео сегодня — купите отдельный видео-кредит."
      ].join("\n")
    );

    await maybeSendRandomNudgeAfterGeneration(target, userId);
    return;
  }

  const consumeResult = await consumeVideoCredit(userId);

  if (!consumeResult.consumed) {
    console.warn(`Video credit was not consumed for user ${userId}`);
  }

  await sendMaxMessage(
    target,
    [
      "✅ **Видео создано.**",
      "",
      `Осталось оплаченных видео: **${consumeResult.creditsLeft || 0}**.`,
      "",
      "Для нового видео нажмите «🎬 Оживить фото» в меню и купите ещё один кредит."
    ].join("\n")
  );

  await maybeSendRandomNudgeAfterGeneration(target, userId);
}

async function finishVideoBillingAfterSuccess(target, userId, videoAccess, family = false) {
  if (videoAccess.source === "premium") {
    await incrementRequestCount(userId, "videos");

    const countsAfter = await getUserRequestCounts(userId);
    const limitsAfter = await getUserDailyLimits(userId);

    const premiumVideosLeft = Math.max(
      0,
      Number(limitsAfter.videos || 0) - Number(countsAfter.videos || 0)
    );

    await sendMaxMessage(
      target,
      [
        family
          ? "✅ **Тренд-видео создано за счёт Premium.**"
          : "✅ **Видео создано за счёт Premium.**",
        "",
        `Premium-видео на сегодня осталось: **${premiumVideosLeft}**.`,
        "",
        premiumVideosLeft > 0
          ? "Можете создать ещё одно Premium-видео сегодня."
          : "Если нужно ещё видео сегодня — купите отдельный видео-кредит."
      ].join("\n")
    );

    await maybeSendRandomNudgeAfterGeneration(target, userId);
    return;
  }

  const consumeResult = await consumeVideoCredit(userId);

  if (!consumeResult.consumed) {
    console.warn(`Video credit was not consumed for user ${userId}`);
  }

  await sendMaxMessage(
    target,
    [
      family
        ? "✅ **Тренд-видео создано.**"
        : "✅ **Видео создано.**",
      "",
      `Осталось оплаченных видео: **${consumeResult.creditsLeft || 0}**.`,
      "",
      family
        ? "Функция тренд-видео временно скрыта из меню."
        : "Для нового видео нажмите «🎬 Оживить фото» в меню и купите ещё один кредит."
    ].join("\n")
  );

  await maybeSendRandomNudgeAfterGeneration(target, userId);
}

async function finishFamilyVideoBillingAfterSuccess(target, userId) {
  const consumeResult = await consumeFamilyVideoCredit(userId);

  if (!consumeResult.consumed) {
    console.warn(`Family video credit was not consumed for user ${userId}`);
  }

  await sendMaxMessage(
    target,
    [
      "✅ **Тренд-видео создано.**",
      "",
      `Осталось оплаченных тренд-видео: **${consumeResult.creditsLeft || 0}**.`,
      "",
      "Функция тренд-видео временно скрыта из меню."
    ].join("\n")
  );

  await maybeSendRandomNudgeAfterGeneration(target, userId);
}

async function handleFamilyVideoRequest(update, target, incomingImageUrls, userId = target.id) {
  const imageUrls = Array.isArray(incomingImageUrls) ? incomingImageUrls.filter(Boolean) : [];

  if (!imageUrls.length) {
    await sendMaxMessage(
      target,
      [
        "🔥 Режим **«ТРЕНД МЕСЯЦА»** включён.",
        "",
        "Отправьте **готовое фото для тренда**.",
        "",
        "Подсказка: нажмите **«Создать фото бесплатно»**, выберите **«СТИЛИ»** и там выберите стиль **«⚾ ТРЕНД»**. Когда фото будет готово — отправьте его сюда."
      ].join("\n")
    );
    return;
  }

  const videoAccess = await getFamilyVideoAccessForUser(userId);

  if (!videoAccess.allowed) {
    clearFamilyVideoDraft(userId);
    clearUserImageMode(userId);
    await sendFamilyVideoHelp(target, userId);
    return;
  }

  const inputImage = await downloadIncomingImage(imageUrls[0]);

  const status = await startDynamicStatus(target, "🔥 Тренд месяца создаётся через KLING");

  try {
    const videoBuffer = await makeTrendMonthVideoFromFalKling({
      inputImage
    });

    await sendMaxVideo(
      target,
      [
        "🔥 **Готово. Тренд-видео создано.**",
        "",
        "Видео создано через **KLING** на основе вашего готового фото.",
        "",
        "Если нужен новый тренд — нажмите **ТРЕНД МЕСЯЦА** в меню ещё раз."
      ].join("\n"),
      videoBuffer
    );

    clearFamilyVideoDraft(userId);
    clearUserImageMode(userId);

    await finishFamilyVideoBillingAfterSuccess(target, userId);
  } finally {
    await status.stop().catch((error) => {
      console.warn("Failed to stop trend month video status:", error?.message || error);
    });
  }
}

async function handleUpdate(update) {
  const updateType = update?.update_type;
  const target = getReplyTarget(update);
  let status = null;
  let processingLocked = false;

  debugLog("Incoming update type:", updateType);

  if (!target) {
    console.log("No reply target in update:", JSON.stringify(update));
    return;
  }

  const userId = getStableUserId(update, target);
  const firstName = getUserFirstName(update);

const broadcastUserId = getRealUserIdForBroadcast(update, target);

if (shouldRegisterBotUser(broadcastUserId)) {
  registerBotUserInDb(broadcastUserId, firstName).catch((error) => {
    console.warn("Failed to register bot user in DB:", error?.message || error);
  });
}

  try {
    if (updateType === "bot_started") {
      const firstName = getUserFirstName(update);
      const namePrefix = firstName ? `, ${firstName}!` : "!";

      const startPayload = getStartPayload(update);
      await handleReferralStart(userId, startPayload).catch((error) => {
        console.warn("Failed to save referral start:", error?.message || error);
      });

      const text =
        `🙋🏻‍♂️ **Привет${namePrefix}**\n\n` +
        "Осуществляя работу с сервисом с помощью **Max-бота**, вы подтверждаете, что ознакомлены и согласны с [Офертой](https://disk.yandex.ru/i/8Z6BsYfupgMq1Q) и [Политикой персональных данных](https://disk.yandex.ru/i/LHakrABNtGiVMw).\n\n" +
        "Напишите вопрос прямо в **ЧАТ**✍ или выберите, что хотите сделать ниже:";

      await sendMainMenu(target, text);

      return;
    }
    const userText = getIncomingText(update);
    const callbackPayload = getCallbackPayload(update);
    const callbackId = getCallbackId(update);
    const incomingImageUrls = extractIncomingImageUrls(update);
const incomingImageUrl = incomingImageUrls[0] || "";

    const isCallbackUpdate =
      updateType === "message_callback" ||
      Boolean(callbackId) ||
      Boolean(callbackPayload);

    if (updateType === "message_created" || isCallbackUpdate) {
      markReferralActivity(
        userId,
        updateType === "message_created" ? "message" : "callback"
      ).catch((error) => {
        console.warn("Failed to mark referral activity:", error?.message || error);
      });
    }

    // Отдельная обработка callback-кнопок
if (isCallbackUpdate) {
  debugLog("Callback received:", {
    callbackPayload,
    userId,
    target
  });

      if (String(callbackPayload || "").startsWith(HIPE_CONFIRM_PAYLOAD_PREFIX)) {
        await handleHipeConfirmCallback(target, userId, callbackPayload, callbackId);
        return;
      }

      if (String(callbackPayload || "").startsWith(HIPE_CANCEL_PAYLOAD_PREFIX)) {
        await handleHipeCancelCallback(target, userId, callbackPayload, callbackId);
        return;
      }


      // 1) Проверка подписки по кнопке "Я подписан(а)"
      if (isSubscriptionCheckPayload(callbackPayload)) {
        // userId из payload нам нужен только чтобы понять, что это вообще кнопка проверки
        const payloadUserId = getUserIdFromSubscriptionPayload(callbackPayload);

        // А ДЛЯ ПРОВЕРКИ подписки используем ТОЛЬКО реальный ID из callback.user
        const callbackUserId = String(update?.callback?.user?.user_id || "").trim();

        if (!callbackUserId) {
          console.warn(
            "Subscription callback has no callback.user.user_id. PayloadUserId:",
            payloadUserId,
            "stableUserId:",
            userId
          );

          if (callbackId) {
            await answerMaxCallback(
              callbackId,
              "Кнопка устарела. Отправьте /проверить или получите новую кнопку."
            );
          }

          await sendMaxMessage(
            target,
            "⚠️ Эта кнопка проверки устарела. Пожалуйста, отправьте команду /проверить или получите новую кнопку."
          );

          return;
        }

        console.log(
          "Subscription check will use user_id (from callback.user):",
          callbackUserId,
          "payloadUserId:",
          payloadUserId,
          "stableUserId:",
          userId
        );

        await handleSubscriptionCheck(target, callbackUserId, callbackId);
        return;
      }

      if (String(callbackPayload || "").startsWith(PAYMENT_EMAIL_PAYLOAD_PREFIX)) {
        clearUserImageMode(userId);
        clearFamilyVideoDraft(userId);
        clearHoroscopeSetupState(userId);

        await startPaymentEmailFlow(target, userId, callbackPayload, callbackId);
        return;
      }

// 2) Меню: Создать фото
if (callbackPayload === MENU_CREATE_PHOTO_PAYLOAD) {
  clearUserImageMode(userId);

  answerCreatePhotoHelp(callbackId, target, userId).catch((error) => {
    console.error("answerCreatePhotoHelp failed:", error?.message || error);
  });

  return;
}

  // 2.1) Выбор формата фото
if (String(callbackPayload || "").startsWith(PHOTO_FORMAT_PAYLOAD_PREFIX)) {
  const formatKey = String(callbackPayload || "").slice(PHOTO_FORMAT_PAYLOAD_PREFIX.length);

  answerPhotoFormatSelected(callbackId, target, userId, formatKey).catch((error) => {
    console.error("answerPhotoFormatSelected failed:", error?.message || error);
  });

  return;
}

 // Меню стилей фото
if (callbackPayload === MENU_PHOTO_STYLES_PAYLOAD) {
  clearUserImageMode(userId);

  await answerPhotoStylesMenu(callbackId, target);
  return;
}

// Выбор конкретного стиля фото
if (String(callbackPayload || "").startsWith(PHOTO_STYLE_PAYLOAD_PREFIX)) {
  const styleKey = String(callbackPayload).slice(PHOTO_STYLE_PAYLOAD_PREFIX.length);
  const style = PHOTO_STYLES[styleKey];

  if (!style) {
    if (callbackId) {
      await answerMaxCallback(callbackId, "Неизвестный стиль.");
    }

    return;
  }

  setUserPhotoStyle(userId, styleKey);

  await answerPhotoStyleActivated(callbackId, target, style);
  return;
} 
  
// 3) Меню: Реставрация
if (callbackPayload === MENU_RESTORE_PHOTO_PAYLOAD) {
  setUserImageMode(userId, IMAGE_MODE_RESTORATION);

  runCallbackTaskInBackground(target, "open restoration menu", async () => {
    await sendRestorationPhotoHelp(target);
  });

  return;
}
            // 4) Меню: Создать видео по промту / фото + промт
if (callbackPayload === MENU_CREATE_PROMPT_VIDEO_PAYLOAD) {
  clearUserImageMode(userId);

  await sendCreatePromptVideoHelp(target, userId);
  return;
}

      // 4.1) Меню: Оживить фото
if (callbackPayload === MENU_CREATE_VIDEO_PAYLOAD) {
  clearUserImageMode(userId);

  await sendCreateVideoHelp(target, userId);
  return;
}

  if (callbackPayload === MENU_CREATE_FAMILY_VIDEO_PAYLOAD) {
  clearUserImageMode(userId);
  clearFamilyVideoDraft(userId);

  await sendFamilyVideoHelp(target, userId);
  return;
}

      // 5) Меню: Создать карточку товара
      if (callbackPayload === MENU_PRODUCT_CARD_PAYLOAD) {
        clearUserImageMode(userId);

        await sendProductCardInfo(target, userId);
        return;
      }

      if (callbackPayload === MENU_CREATE_MUSIC_PAYLOAD) {
        clearUserImageMode(userId);

        await sendMusicInfo(target, userId);
        return;
      }

      if (callbackPayload === MENU_HOROSCOPE_PAYLOAD) {
        clearUserImageMode(userId);
        clearFamilyVideoDraft(userId);

        await sendHoroscopeMenu(target, userId);
        return;
      }

      if (callbackPayload === MENU_EARN_PAYLOAD) {
        clearUserImageMode(userId);
        clearFamilyVideoDraft(userId);
        clearHoroscopeSetupState(userId);

        await sendEarnMenu(target, userId);
        return;
      }

      if (callbackPayload === EARN_WITHDRAW_PAYLOAD) {
        clearUserImageMode(userId);
        clearFamilyVideoDraft(userId);
        clearHoroscopeSetupState(userId);

        await startReferralWithdraw(target, userId);
        return;
      }

  if (callbackPayload === HOROSCOPE_YES_NO_PAYLOAD) {
  clearUserImageMode(userId);
  clearFamilyVideoDraft(userId);
  clearHoroscopeSetupState(userId);

  await sendHoroscopeYesNoStart(target, userId);
  return;
}

      if (callbackPayload === HOROSCOPE_PROFILE_PAYLOAD) {
        clearUserImageMode(userId);

        await sendHoroscopeProfile(target, userId);
        return;
      }

      if (callbackPayload === HOROSCOPE_START_PAYLOAD) {
        clearUserImageMode(userId);

        await startHoroscopeSetup(target, userId);
        return;
      }

      if (callbackPayload === HOROSCOPE_TODAY_PAYLOAD) {
        clearUserImageMode(userId);

        await sendHoroscopeToday(target, userId);
        return;
      }

  if (callbackPayload === HOROSCOPE_TOMORROW_PAYLOAD) {
  clearUserImageMode(userId);

  await sendHoroscopeTomorrow(target, userId);
  return;
}

      if (callbackPayload === HOROSCOPE_DAILY_ENABLE_PAYLOAD) {
        clearUserImageMode(userId);

        await enableHoroscopeDaily(target, userId);
        return;
      }

      if (callbackPayload === HOROSCOPE_DAILY_DISABLE_PAYLOAD) {
        clearUserImageMode(userId);

        await disableHoroscopeDaily(target, userId);
        return;
      }

      if (String(callbackPayload || "").startsWith(HOROSCOPE_TIME_PAYLOAD_PREFIX)) {
        clearUserImageMode(userId);

        await handleHoroscopeTimeButton(target, userId, callbackPayload);
        return;
      }

      // 5) Меню: Отключить лимиты / Premium
      if (callbackPayload === MENU_PREMIUM_PAYLOAD) {
        clearUserImageMode(userId);

        await sendPremiumInfo(target, userId);
        return;
      }

  if (callbackPayload === MENU_SPONSORS_PAYLOAD) {
  clearUserImageMode(userId);

  await answerSponsorsList(callbackId, target);
  return;
}

// 6) Кнопка "Назад" — возвращаем к меню
if (callbackPayload === MENU_BACK_PAYLOAD) {
  clearUserImageMode(userId);
  clearFamilyVideoDraft(userId);
  clearHoroscopeSetupState(userId);

  await sendMainMenu(target);
  return;
}

      // 7) Неизвестная кнопка
      if (callbackId) {
        await answerMaxCallback(callbackId, "Неизвестная кнопка.");
      }

      return;
    }
    // Админ-команда проверки реферальных выплат
    if (String(userText || "").trim().toLowerCase() === "/cash") {
      if (updateType !== "message_created") return;

      await sendCashAdminReport(target, userId);
      return;
    }

    // Админ-команда ручной выдачи Premium пользователю по ID
    if (isGiveGptCommand(userText)) {
      if (updateType !== "message_created") return;

      await handleGiveGptCommand(target, userId, userText);
      return;
    }

    // Админ-команда тестового/реального розыгрыша Premium-акции
    if (isPremiumRaffleCommand(userText)) {
      if (updateType !== "message_created") return;

      await handlePremiumRaffleCommand(target, userId, userText);
      return;
    }

    // Админ-команда остановки /hipe рассылки
    if (isHipeStopCommand(userText)) {
      if (updateType !== "message_created") return;

      await handleHipeStopCommand(target, userId);
      return;
    }

    // Админ-команда статистики /hipe
    if (isHipeStatsCommand(userText)) {
      if (updateType !== "message_created") return;

      await handleHipeStatsCommand(target, userId);
      return;
    }

    // Админ-команда /hipe: предпросмотр и рассылка с вашей link-кнопкой
    if (isHipeCommand(userText)) {
      if (updateType !== "message_created") return;

      await handleHipeCommand(target, userId, userText, incomingImageUrl);
      return;
    }

    // Админ-команда рассылки всем пользователям бота
    if (isBroadcastCommand(userText)) {
      if (updateType !== "message_created") return;

      await handleBroadcastCommand(target, userId, userText, incomingImageUrl);
      return;
    }
    // Текстовая команда проверки подписки
    if (
      userText.toLowerCase() === "/check_sub" ||
      userText.toLowerCase() === "/проверить"
    ) {
      await handleSubscriptionCheck(target, userId, "");
      return;
    }

    if (updateType !== "message_created") return;

    if (await handlePaymentEmailText(target, userId, userText)) {
      return;
    }

    if (await handleReferralWithdrawText(target, userId, userText)) {
      return;
    }

    const floodCheckText = `${userText || ""} ${incomingImageUrl ? "[image]" : ""}`;

    const floodResult = checkAntiFlood(userId, floodCheckText);

    if (floodResult.blocked) {
      await sendFloodWarningIfNeeded(target, userId, floodResult);
      return;
    }

    if (userText === "/start") {
      await sendMaxMessage(
        target,
        "🦄**Бот работает**. Напишите вопрос или попросите создать фото/картинку."
      );
      return;
    }

    if (["/reset", "/new", "/clear", "/сброс"].includes(userText.toLowerCase())) {
      clearChatContext(userId);
      clearUserImageMode(userId);
      clearHoroscopeSetupState(userId);

      await sendMaxMessage(
        target,
        "🧹 Контекст диалога очищен. Можем начать заново."
      );

      return;
    }

    if (userText.toLowerCase().includes("spam")) {
      await sendMaxMessage(
        target,
        "**Это уже не смешно🥺. Стоп спам, пожалуйста😢**."
      );
      return;
    }

    if (/^\s*(?:\/horoscope|\/гороскоп|гороскоп)\s*$/iu.test(userText)) {
      await sendHoroscopeMenu(target, userId);
      return;
    }

    if (await handleHoroscopeTextInput(target, userId, userText)) {
      return;
    }

    if (await handleHoroscopeYesNoQuestion(target, userId, userText)) {
  return;
}

    if (isRestorationMode(userId)) {
      if (!incomingImageUrl) {
        await sendMaxMessage(
          target,
          "🛠️ Режим реставрации включён. Отправьте старую фотографию — любой текст будет проигнорирован."
        );
        return;
      }

      if (isUserBusy(userId)) {
        await sendBusyWarningIfNeeded(target, userId, firstName);
        return;
      }

      lockUserProcessing(userId);
      processingLocked = true;

      status = await startDynamicStatus(target, "Фото реставрируется🚂");

      await handleImageRequest(
        update,
        target,
        RESTORATION_PROMPT,
        incomingImageUrl,
        userId,
        `✅ ${PHOTO_READY_LINK_TEXT} Фото аккуратно отреставрировано.`
      );

      await status.stop();
      status = null;

      return;
    }

const photoStyleModeActive = isPhotoStyleMode(userId);

if (photoStyleModeActive) {
  const styleKey = getUserPhotoStyle(userId);
  const style = PHOTO_STYLES[styleKey];

  if (!style) {
    clearUserImageMode(userId);

    await sendMaxMessage(
      target,
      "Стиль не найден. Нажмите «Создать фото» → «СТИЛИ» и выберите стиль заново."
    );

    return;
  }

  // Отдельная логика для режима ЗАМЕНА ЧЕЛОВЕКА
  if (styleKey === "lemonade") {
    const freshImageUrls = Array.isArray(incomingImageUrls)
      ? incomingImageUrls.filter(Boolean)
      : [];

    const draft = getReplacementDraft(userId);
    const savedImages = Array.isArray(draft.images) ? draft.images.filter(Boolean) : [];
    const combinedImages = [...savedImages, ...freshImageUrls].filter(Boolean).slice(0, 2);

    const replacementUserText =
      String(userText || "").trim() ||
      String(draft.userText || "").trim();

    if (!combinedImages.length) {
      await sendMaxMessage(
        target,
        [
          `🎎 **Стиль активирован: ${style.title}**`,
          "",
          "Отправьте 2 фото:",
          "",
          "Фото 1 — кого заменяем.",
          "Фото 2 — кем заменяем.",
          "",
          "Можно отправить 2 фото одним сообщением или по очереди."
        ].join("\n")
      );

      return;
    }

    if (combinedImages.length < 2) {
      setReplacementDraft(userId, combinedImages, replacementUserText);

      await sendMaxMessage(
        target,
        [
          "✅ **Фото 1 принято.**",
          "",
          "Теперь отправьте **Фото 2** — человека, на которого нужно заменить.",
          "",
          "Фото 1 — кого заменяем.",
          "Фото 2 — кем заменяем."
        ].join("\n")
      );

      return;
    }

    if (isUserBusy(userId)) {
      await sendBusyWarningIfNeeded(target, userId, firstName);
      return;
    }

    lockUserProcessing(userId);
    processingLocked = true;

    status = await startDynamicStatus(
      target,
      "Меняю человека на фото 🎎"
    );

    const stylePrompt = buildPhotoStylePrompt(styleKey, replacementUserText);
    const styleImageOptions = getPhotoStyleImageOptions(styleKey);

    await handleReplacementImageRequest(
      update,
      target,
      stylePrompt,
      combinedImages[0],
      combinedImages[1],
      userId,
      `✅ ${PHOTO_READY_LINK_TEXT} Стиль: ${style.title}`,
      styleImageOptions
    );

    clearReplacementDraft(userId);
    clearUserPhotoStyle(userId);
    clearUserImageMode(userId);

    await sendMaxMessage(
      target,
      [
        "✅ **Замена готова.**",
        "",
        "Если нужно сделать ещё одну замену, снова нажмите **Создать фото бесплатно** → **СТИЛИ** → **🎎 ЗАМЕНА**.",
        "",
        "Напоминание:",
        "Фото 1 — кого заменяем.",
        "Фото 2 — кем заменяем."
      ].join("\n")
    );

    await status.stop();
    status = null;

    return;
  }

  // Обычные стили работают по старой логике с одним фото
  if (!incomingImageUrl) {
    await sendMaxMessage(
      target,
      `🎨 Стиль **${style.title}** активирован. Теперь отправьте фото.`
    );

    return;
  }

  if (isUserBusy(userId)) {
    await sendBusyWarningIfNeeded(target, userId, firstName);
    return;
  }

  lockUserProcessing(userId);
  processingLocked = true;

  status = await startDynamicStatus(
    target,
    "Фото создаётся в выбранном стиле 🏎️"
  );

  const stylePrompt = buildPhotoStylePrompt(styleKey, userText);
  const styleImageOptions = getPhotoStyleImageOptions(styleKey);

  await handleImageRequest(
    update,
    target,
    stylePrompt,
    incomingImageUrl,
    userId,
    `✅ ${PHOTO_READY_LINK_TEXT} Стиль: ${style.title}`,
    styleImageOptions
  );

  await status.stop();
  status = null;

  return;
}


const productCardModeActive = isProductCardMode(userId);

if (productCardModeActive) {
  if (!userText && !incomingImageUrl) {
    await sendMaxMessage(
      target,
      "🛒 Режим карточки товара включён. Отправьте **фото + промт** или просто **описание товара**."
    );
    return;
  }



  if (!userText && incomingImageUrl) {
    await sendMaxMessage(
      target,
      "🛒 Фото получил. Теперь отправьте **описание товара / промт**.\n\nНапример:\n`Крем для лица Nuvelora, бело-золотая упаковка, премиальная карточка для маркетплейса, чистый фон, четкая надпись Nuvelora`"
    );
    return;
  }

  if (isUserBusy(userId)) {
    await sendBusyWarningIfNeeded(target, userId, firstName);
    return;
  }

  lockUserProcessing(userId);
  processingLocked = true;

  status = await startDynamicStatus(target, "🛒 Карточки товара создаются");

  await handleProductCardRequest(
    update,
    target,
    userText,
    incomingImageUrl,
    userId
  );

  await status.stop();
  status = null;

  return;
}
    const musicModeActive = isMusicMode(userId);

if (musicModeActive) {
  if (!userText) {
    await sendMaxMessage(
      target,
      [
        "🎵 Режим создания музыки включён.",
        "",
        "Отправьте описание трека.",
        "",
        "Пример:",
        "`30-секундный энергичный трек для рекламы кафе, летний вайб, поп, гитара, лёгкий вокал`"
      ].join("\n")
    );
    return;
  }

  if (isUserBusy(userId)) {
    await sendBusyWarningIfNeeded(target, userId, firstName);
    return;
  }

  lockUserProcessing(userId);
  processingLocked = true;

  status = await startDynamicStatus(target, "🎵 Музыка создаётся");

  await handleMusicRequest(
    update,
    target,
    userText,
    userId
  );

  await status.stop();
  status = null;

  return;
}

    const promptVideoModeActive = isPromptVideoMode(userId);

if (promptVideoModeActive) {
  if (!userText && !incomingImageUrl) {
    await sendMaxMessage(
      target,
      "🎞️ Режим создания видео включён. Отправьте **промт** или **фото + промт**."
    );
    return;
  }

  if (!userText && incomingImageUrl) {
    await sendMaxMessage(
      target,
      "🎞️ Фото получил. Теперь отправьте **промт**, что должно происходить в видео."
    );
    return;
  }

  if (isUserBusy(userId)) {
    await sendBusyWarningIfNeeded(target, userId, firstName);
    return;
  }

  lockUserProcessing(userId);
  processingLocked = true;

  status = await startDynamicStatus(target, "🎞️ Видео создаётся");

  await handlePromptVideoRequest(
    update,
    target,
    userText,
    incomingImageUrl,
    userId
  );

  await status.stop();
  status = null;

  return;
}

    const familyVideoModeActive = isFamilyVideoMode(userId);

if (familyVideoModeActive) {
  if (!incomingImageUrls.length) {
    await sendMaxMessage(
      target,
      "🔥 Режим **«ТРЕНД МЕСЯЦА»** включён. Отправьте **готовое фото для тренда**. Если фото ещё нет — нажмите «Создать фото бесплатно» → «СТИЛИ» → «⚾ ТРЕНД»."
    );
    return;
  }

  if (isUserBusy(userId)) {
    await sendBusyWarningIfNeeded(target, userId, firstName);
    return;
  }

  lockUserProcessing(userId);
  processingLocked = true;

  await handleFamilyVideoRequest(
    update,
    target,
    incomingImageUrls,
    userId
  );

  return;
}

    const videoModeActive = isVideoMode(userId);

if (videoModeActive) {
  if (!incomingImageUrl) {
    await sendMaxMessage(
      target,
      "🎬 Режим оживления фото включён. Отправьте **фото человека**. Текст писать не нужно."
    );
    return;
  }

  if (isUserBusy(userId)) {
    await sendBusyWarningIfNeeded(target, userId, firstName);
    return;
  }

  lockUserProcessing(userId);
  processingLocked = true;

  status = await startDynamicStatus(target, "🎞️ Видео создаётся");

  await handleVideoRequest(
    update,
    target,
    "",
    incomingImageUrl,
    userId
  );

  await status.stop();
  status = null;

  return;
}
    


if (!userText && incomingImageUrl) {
  const videoAccess = await getVideoAccessForUser(userId);

  if (videoAccess.allowed) {
    setUserImageMode(userId, IMAGE_MODE_VIDEO);

    if (isUserBusy(userId)) {
      await sendBusyWarningIfNeeded(target, userId, firstName);
      return;
    }

    lockUserProcessing(userId);
    processingLocked = true;

    status = await startDynamicStatus(target, "🎬 Оживляем фото");

    await handleVideoRequest(
      update,
      target,
      "",
      incomingImageUrl,
      userId
    );

    await status.stop();
    status = null;

    return;
  }

  await sendMaxMessage(
    target,
    "Фото получил. Теперь отправьте его вместе с текстом, что нужно изменить или создать на его основе."
  );
  return;
}

    if (!userText) {
      await sendMaxMessage(
        target,
        "Я пока умею отвечать на текст, а также создавать изображения по запросам вроде: создай фото кота в космосе."
      );
      return;
    }

    if (isUserBusy(userId)) {
      await sendBusyWarningIfNeeded(target, userId,firstName);
      return;
    }

    lockUserProcessing(userId);
    processingLocked = true;

if (isPromptVideoRequest(userText)) {
  const videoAccess = await getPromptVideoAccessForUser(userId);

  if (!videoAccess.allowed) {
    clearUserImageMode(userId);
    await sendCreatePromptVideoHelp(target, userId);
    return;
  }

  setUserImageMode(userId, IMAGE_MODE_PROMPT_VIDEO);

  status = await startDynamicStatus(target, "📽️ Видео создаётся");

  await handlePromptVideoRequest(update, target, userText, incomingImageUrl, userId);

  await status.stop();
  status = null;
  return;
}

if (isVideoRequest(userText, Boolean(incomingImageUrl))) {
  const videoAccess = await getVideoAccessForUser(userId);

  if (!videoAccess.allowed) {
    clearUserImageMode(userId);
    await sendCreateVideoHelp(target, userId);
    return;
  }

  setUserImageMode(userId, IMAGE_MODE_VIDEO);

  status = await startDynamicStatus(target, "🎬Оживляем фото");

  await handleVideoRequest(update, target, "", incomingImageUrl, userId);

  await status.stop();
  status = null;
  return;
}



    if (isImageRequest(userText, Boolean(incomingImageUrl))) {
      status = await startDynamicStatus(target, "🏜️Шедевр создается");

      await handleImageRequest(update, target, userText, incomingImageUrl, userId);

      await status.stop();
      status = null;
      return;
    }

    const userLimits = await getUserDailyLimits(userId);

    if (await isRequestLimitReached(userId, "chatgpt", userLimits.chatgpt)) {
      await sendMaxMessage(
        target,
        userLimits.premium
          ? "Кажется вам надо немного отдохнуть от ИИ🏝️ **Premium-лимит на сегодня: 20 запросов CHATgpt**."
          : "Кажется вам надо немного отдохнуть от ИИ🏝️(chatgpt), **приходите чуть позже и продолжайте**🦦"
      );
      return;
    }

    if (await isSubscriptionRequiredForRequest(userId, "chatgpt")) {
      await sendSubscriptionPrompt(
        target,
        userId,
        `Вы уже использовали ${CHATGPT_REQUESTS_BEFORE_SUBSCRIPTION} текстовых запроса бесплатно.`
      );
      return;
    }

    await incrementRequestCount(userId, "chatgpt");

    status = await startDynamicStatus(target, "💬ИИ думает");

const answer = await runTextOpenAI(() => askOpenAI(userId, userText));

await status.stop();
status = null;

await sendMaxMessage(
  target,
  formatChatGptAnswerWithName(firstName, answer)
);

await maybeSendRandomNudgeAfterGeneration(target, userId);
  } catch (error) {
    console.error("Update handling failed:", error);

    if (status) {
      await status.stop().catch((statusError) => {
        console.error("Failed to remove dynamic status:", statusError);
      });
    }

    await sendMaxMessage(target, safeUserError(error)).catch((sendError) => {
      console.error("Failed to send error message to MAX:", sendError);
    });
  } finally {
    if (processingLocked) {
      unlockUserProcessing(userId);
    }
  }
}

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "MAX OpenAI bot",
    webhook: "/webhook"
  });
});

app.get("/health", (req, res) => {
  res.status(200).type("text/plain").send("ok");
});

app.get("/hipe/click/:campaignId/:userId", async (req, res) => {
  const campaignId = Number(req.params.campaignId);
  const userId = String(req.params.userId || "").trim();

  if (!dbPool || !Number.isInteger(campaignId) || campaignId <= 0 || !isValidUserIdForBroadcast(userId)) {
    res.status(400).type("text/plain").send("Некорректная ссылка.");
    return;
  }

  try {
    const campaignResult = await dbPool.query(
      `SELECT id, button_url FROM max_bot_hipe_campaigns WHERE id = $1 AND bot_key = $2 LIMIT 1`,
      [campaignId, BOT_KEY]
    );

    const campaign = campaignResult.rows[0];

    if (!campaign?.button_url) {
      res.status(404).type("text/plain").send("Ссылка не найдена.");
      return;
    }

    await dbPool.query(
      `
        INSERT INTO max_bot_hipe_clicks (campaign_id, bot_key, user_id, user_agent, ip)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        campaignId,
        BOT_KEY,
        userId,
        String(req.get("user-agent") || "").slice(0, 500),
        String(req.ip || req.headers["x-forwarded-for"] || "").slice(0, 120)
      ]
    );

    res.redirect(302, campaign.button_url);
  } catch (error) {
    console.error("Hipe click tracking failed:", error?.message || error);
    res.status(500).type("text/plain").send("Ошибка перехода. Попробуйте позже.");
  }
});



app.get("/premium/return", (req, res) => {
  res
    .status(200)
    .type("text/html; charset=utf-8")
    .send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 24px;">
          <h2>Спасибо за оплату</h2>
          <p>Если платеж прошел успешно, Premium будет активирован автоматически. Вернитесь в бот.</p>
        </body>
      </html>
    `);
});

app.get("/product-card/return", (req, res) => {
  res
    .status(200)
    .type("text/html; charset=utf-8")
    .send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 24px;">
          <h2>Спасибо за оплату</h2>
          <p>Если платеж прошел успешно, доступ к созданию карточки товара будет активирован автоматически. Вернитесь в бот.</p>
        </body>
      </html>
    `);
});


app.get("/music/return", (req, res) => {
  res
    .status(200)
    .type("text/html; charset=utf-8")
    .send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 24px;">
          <h2>Спасибо за оплату</h2>
          <p>Если платеж прошел успешно, доступ к созданию музыки будет активирован автоматически. Вернитесь в бот.</p>
        </body>
      </html>
    `);
});



app.get("/prompt-video/return", (req, res) => {
  res
    .status(200)
    .type("text/html; charset=utf-8")
    .send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 24px;">
          <h2>Спасибо за оплату</h2>
          <p>Если платеж прошел успешно, доступ к созданию видео будет активирован автоматически. Вернитесь в бот.</p>
        </body>
      </html>
    `);
});



app.get("/video/return", (req, res) => {
  res
    .status(200)
    .type("text/html; charset=utf-8")
    .send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 24px;">
          <h2>Спасибо за оплату</h2>
          <p>Если платеж прошел успешно, доступ к оживлению фото будет активирован автоматически. Вернитесь в бот.</p>
        </body>
      </html>
    `);
});

const handlePremiumBuyRoute = buildYooKassaBuyRouteHandler({
  title: "Премиум на месяц",
  priceRub: PREMIUM_PRICE_RUB,
  createPayment: createYooKassaPremiumPayment,
  failMessage: "Не удалось создать платеж. Вернитесь в бота и попробуйте позже."
});

const handleProductCardBuyRoute = buildYooKassaBuyRouteHandler({
  title: "Создание карточки товара",
  priceRub: PRODUCT_CARD_PRICE_RUB,
  createPayment: createYooKassaProductCardPayment,
  failMessage: "Не удалось создать платеж за карточку товара. Вернитесь в бота и попробуйте позже."
});

const handleMusicBuyRoute = buildYooKassaBuyRouteHandler({
  title: "Создание музыки AI",
  priceRub: MUSIC_PRICE_RUB,
  createPayment: createYooKassaMusicPayment,
  failMessage: "Не удалось создать платеж за музыку. Вернитесь в бота и попробуйте позже."
});

const handlePromptVideoBuyRoute = buildYooKassaBuyRouteHandler({
  title: "Создание видео AI",
  priceRub: PROMPT_VIDEO_PRICE_RUB,
  createPayment: createYooKassaPromptVideoPayment,
  failMessage: "Не удалось создать платеж за видео. Вернитесь в бота и попробуйте позже."
});

const handleVideoBuyStandardRoute = buildYooKassaBuyRouteHandler({
  title: "Оживление фото AI",
  priceRub: VIDEO_PRICE_RUB,
  createPayment: createYooKassaVideoPayment,
  failMessage: "Не удалось создать платеж за видео. Вернитесь в бота и попробуйте позже."
});

const handleFamilyVideoBuyRoute = buildYooKassaBuyRouteHandler({
  title: "ТРЕНД МЕСЯЦА",
  priceRub: FAMILY_VIDEO_PRICE_RUB,
  createPayment: createYooKassaFamilyVideoPayment,
  failMessage: "Не удалось создать платеж за тренд-видео. Вернитесь в бота и попробуйте позже."
});

async function handleVideoBuyRoute(req, res) {
  const userId = getPaymentUserIdFromRequest(req);
  const mode = getPaymentModeFromRequest(req);

  if (!isValidUserIdForBroadcast(userId)) {
    res.status(400).type("text/plain").send("Некорректный user_id.");
    return;
  }

  if (mode === VIDEO_MODE_FAMILY_PAYMENT) {
    res.redirect(
      302,
      `/family-video/buy?user_id=${encodeURIComponent(userId)}`
    );
    return;
  }

  return handleVideoBuyStandardRoute(req, res);
}


function buildPremiumRaffleRulesHtml() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Правила Premium-акции с розыгрышем призов</title>
  <meta name="description" content="Официальные правила Premium-акции MAX-бота Чат-Бот Chatgpt | Нейросети ИИ" />
  <style>
    :root { color-scheme: light; --bg:#f6f7fb; --card:#ffffff; --text:#182033; --muted:#5d667a; --line:#e6e9f2; --accent:#4f46e5; --accent2:#10b981; --warn:#b45309; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, Helvetica, sans-serif; background:var(--bg); color:var(--text); line-height:1.6; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 24px 14px 64px; }
    .hero { background: linear-gradient(135deg, #4f46e5, #7c3aed); color:#fff; border-radius: 24px; padding: 30px 22px; box-shadow: 0 16px 45px rgba(79,70,229,.22); }
    .hero h1 { margin:0 0 10px; font-size: clamp(28px, 4vw, 44px); line-height:1.1; }
    .hero p { margin: 8px 0 0; opacity:.94; font-size: 17px; }
    .badge-row { display:flex; flex-wrap:wrap; gap:10px; margin-top:18px; }
    .badge { background: rgba(255,255,255,.16); border:1px solid rgba(255,255,255,.25); padding:7px 10px; border-radius:999px; font-size:14px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:22px; margin-top:18px; box-shadow: 0 8px 28px rgba(20,26,45,.06); }
    h2 { margin: 0 0 12px; font-size: 24px; }
    h3 { margin: 18px 0 8px; font-size: 18px; }
    p { margin: 8px 0; }
    ul, ol { padding-left: 24px; margin: 8px 0; }
    li { margin: 5px 0; }
    a { color: var(--accent); word-break: break-word; }
    .important { border-left: 5px solid var(--warn); background:#fff7ed; padding:14px 16px; border-radius:12px; margin-top:12px; }
    .ok { border-left: 5px solid var(--accent2); background:#ecfdf5; padding:14px 16px; border-radius:12px; margin-top:12px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap:12px; }
    .mini { background:#f8fafc; border:1px solid var(--line); border-radius:14px; padding:14px; }
    .small { color:var(--muted); font-size:14px; }
    table { width:100%; border-collapse:collapse; overflow:hidden; border-radius:14px; border:1px solid var(--line); }
    th, td { padding:12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { background:#f1f5f9; }
    tr:last-child td { border-bottom:0; }
    .footer { text-align:center; color:var(--muted); margin-top:24px; font-size:14px; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <h1>Premium-акция с розыгрышем призов 🎁</h1>
      <p>Официальные правила рекламной акции для пользователей Premium-доступа в MAX-боте «Чат-Бот Chatgpt | Нейросети ИИ».</p>
      <div class="badge-row">
        <span class="badge">Период: 10.06.2026 — 10.09.2026</span>
        <span class="badge">Всего призов: 10</span>
        <span class="badge">Каждая покупка Premium = 1 токен</span>
      </div>
    </section>

    <section class="card">
      <h2>1. Организатор акции</h2>
      <p><strong>Индивидуальный предприниматель Журавлев Антон Андреевич</strong></p>
      <p>ИНН: <strong>236700415542</strong><br />ОГРНИП: <strong>323237500112662</strong><br />Email для связи: <a href="mailto:toni.zhuravlev.xd@mail.ru">toni.zhuravlev.xd@mail.ru</a></p>
      <p>Основной бот: <a href="https://max.ru/id236700415542_bot">https://max.ru/id236700415542_bot</a></p>
      <p>Дополнительный бот «РОЗЫГРЫШ БОТ»: <a href="https://max.ru/id231711659887_bot">https://max.ru/id231711659887_bot</a></p>
      <p class="small">Редакция правил от 01.06.2026.</p>
    </section>

    <section class="card">
      <h2>2. Статус акции</h2>
      <p>Акция проводится в целях продвижения MAX-бота «Чат-Бот Chatgpt | Нейросети ИИ», Premium-доступа к функциям бота и информационно-технологических услуг Организатора.</p>
      <div class="important">
        <strong>Акция не является лотереей, азартной игрой, ставкой, инвестиционным проектом или способом заработка.</strong>
        Покупка Premium предоставляет пользователю доступ к платным функциям бота, а участие в акции является дополнительной возможностью для пользователей, выполнивших условия настоящих правил.
      </div>
    </section>

    <section class="card">
      <h2>3. Территория и возраст участников</h2>
      <p>Акция проводится на территории стран СНГ.</p>
      <p>Получить приз может только лицо, достигшее 18 лет. Если победителем становится пользователь младше 18 лет, получение приза возможно только через родителя, законного представителя или опекуна.</p>
    </section>

    <section class="card">
      <h2>4. Сроки проведения</h2>
      <div class="grid">
        <div class="mini"><strong>Начало:</strong><br />10 июня 2026 года, 00:00 МСК</div>
        <div class="mini"><strong>Окончание:</strong><br />10 сентября 2026 года, 23:59 МСК</div>
        <div class="mini"><strong>Итоги:</strong><br />до 20 сентября 2026 года включительно</div>
      </div>
      <p>Организатор вправе продлить срок подведения итогов, если потребуется дополнительная техническая проверка базы участников, оплат, подписок, наличия ботов у пользователя или связь с потенциальными победителями.</p>
    </section>

    <section class="card">
      <h2>5. Как участвовать</h2>
      <ol>
        <li>Купить Premium-доступ в MAX-боте «Чат-Бот Chatgpt | Нейросети ИИ» в период акции.</li>
        <li>Получить уникальный токен участника после успешной оплаты.</li>
        <li>Ознакомиться с настоящими правилами.</li>
        <li>Подписаться на обязательные MAX-каналы Организатора.</li>
        <li>Подписаться на официальную группу Организатора во ВКонтакте.</li>
        <li>Не удалять два обязательных MAX-бота Организатора до момента проверки итогов.</li>
        <li>Не оформлять возврат оплаты Premium до подведения итогов.</li>
      </ol>
      <div class="ok">
        Каждая успешная покупка Premium в период акции создаёт один токен. Повторная покупка Premium создаёт дополнительный токен и увеличивает шанс быть выбранным системой.
      </div>
    </section>

    <section class="card">
      <h2>6. Обязательные подписки и боты</h2>
      <h3>MAX-каналы</h3>
      <ul>
        <li><a href="https://max.ru/id231711659887_biz">https://max.ru/id231711659887_biz</a></li>
        <li><a href="https://max.ru/id236700415542_biz">https://max.ru/id236700415542_biz</a></li>
        <li><a href="https://max.ru/join/P7GhkQ-vh7uGxJE2UYOY4QoDG27pJLFh1yfA9tj-ag0">https://max.ru/join/P7GhkQ-vh7uGxJE2UYOY4QoDG27pJLFh1yfA9tj-ag0</a></li>
      </ul>
      <h3>Группа ВКонтакте</h3>
      <ul>
        <li><a href="https://vk.com/chatgpt_stickers">https://vk.com/chatgpt_stickers</a></li>
      </ul>
      <h3>MAX-боты, которые нельзя удалять до проверки итогов</h3>
      <ul>
        <li><a href="https://max.ru/id236700415542_bot">https://max.ru/id236700415542_bot</a></li>
        <li><a href="https://max.ru/id231711659887_bot">https://max.ru/id231711659887_bot</a></li>
      </ul>
    </section>

    <section class="card">
      <h2>7. Призовой фонд</h2>
      <p>Общее количество призов: <strong>10</strong>.</p>
      <table>
        <thead><tr><th>Место</th><th>Приз</th></tr></thead>
        <tbody>
          <tr><td>1 место</td><td><strong>Авиабилеты в Турцию для двух лиц в одну сторону</strong></td></tr>
          <tr><td>2 место</td><td>1000 рублей</td></tr>
          <tr><td>3 место</td><td>500 рублей</td></tr>
          <tr><td>4 место</td><td>500 рублей</td></tr>
          <tr><td>5 место</td><td>500 рублей</td></tr>
          <tr><td>6 место</td><td>Игровая мышка или аналогичный приз по усмотрению Организатора</td></tr>
          <tr><td>7–10 места</td><td>Premium / GPT / ChatGPT Premium / Premium-функции сервиса сроком от 1 до 3 месяцев</td></tr>
        </tbody>
      </table>
    </section>

    <section class="card">
      <h2>8. Важно про главный приз</h2>
      <div class="important">
        <p><strong>Главный приз — это не туристический тур и не путёвка.</strong></p>
        <p>Организатор предоставляет только два авиабилета в Турцию в одну сторону. Дату, время, город вылета, город прилёта, авиакомпанию, маршрут, аэропорт, наличие пересадок и иные параметры перелёта определяет Организатор по своему усмотрению.</p>
      </div>
      <p>В главный приз не входят: обратные билеты, проживание, питание, медицинская или туристическая страховка, трансфер, багаж сверх нормы авиакомпании, визы, миграционные документы, личные расходы, расходы до аэропорта и от аэропорта, а также любые иные расходы, прямо не указанные как входящие в приз.</p>
      <p>Организатор не является туроператором, турагентом, авиакомпанией, страховой компанией или перевозчиком, не формирует туристический продукт и не оказывает туристические услуги.</p>
    </section>

    <section class="card">
      <h2>9. Как выбираются победители</h2>
      <p>Победители определяются случайным образом среди токенов участников, внесённых в базу акции.</p>
      <p>Каждый токен участвует отдельно. Если у пользователя несколько токенов, каждый токен увеличивает вероятность выбора пользователя. Наличие токенов не гарантирует победу.</p>
      <p>После выбора токенов Организатор проверяет выполнение условий. Победа считается подтверждённой только после успешной проверки.</p>
    </section>

    <section class="card">
      <h2>10. Тестовый розыгрыш</h2>
      <p>Организатор может проводить тестовый розыгрыш для проверки технической системы.</p>
      <p>Тестовый розыгрыш не является официальным подведением итогов, не создаёт победителей, не даёт права на призы и не влияет на реальный розыгрыш.</p>
    </section>

    <section class="card">
      <h2>11. Проверка условий и отказ в призе</h2>
      <p>Перед выдачей призов Организатор проверяет наличие успешной оплаты Premium, токена, подписок, двух обязательных MAX-ботов, отсутствие возврата оплаты и отсутствие нарушений правил.</p>
      <p>Организатор вправе отказать в выдаче основного приза, если участник отписался от обязательных каналов, удалил обязательные боты, оформил возврат, использовал фейковые аккаунты, не вышел на связь, не предоставил данные для получения приза или нарушил правила акции.</p>
    </section>

    <section class="card">
      <h2>12. Утешительные призы</h2>
      <p>Если участник был выбран системой, но не выполнил все условия для получения основного приза, Организатор вправе предоставить утешительный приз по своему усмотрению.</p>
      <p>Утешительный приз может включать Premium-доступ сроком от 1 до 3 месяцев, дополнительные Premium-дни, цифровой бонус внутри сервиса или иной подарок.</p>
      <p>Если участник удалил обязательные MAX-боты, отписался от каналов, сделал возврат оплаты или нарушил правила, Организатор вправе отказать как в основном, так и в утешительном призе.</p>
    </section>

    <section class="card">
      <h2>13. Публикация итогов</h2>
      <p>Итоги акции будут опубликованы на основных платформах Организатора: в MAX-ботах, MAX-каналах, группе ВКонтакте и/или иных официальных каналах Организатора.</p>
      <p>В итогах могут быть указаны место победителя, вид приза, ID пользователя, никнейм или имя пользователя при технической доступности, частично скрытый токен и дата подведения итогов.</p>
      <p>Победитель должен ответить Организатору в течение 72 часов с момента первого сообщения. Если победитель не отвечает, Организатор вправе выбрать другого участника или предоставить иной приз по своему усмотрению.</p>
    </section>

    <section class="card">
      <h2>14. Налоги, расходы и замена призов</h2>
      <p>Победитель самостоятельно несёт ответственность за соблюдение налоговых требований своей страны проживания, если иное не предусмотрено применимым законодательством.</p>
      <p>Организатор вправе запросить данные, необходимые для документального, бухгалтерского или налогового оформления приза.</p>
      <p>Организатор вправе заменить любой приз на аналогичный, цифровой приз, денежный эквивалент или Premium-доступ, если передача заявленного приза невозможна, затруднена, слишком затратна или нарушает правила сторонних сервисов либо законодательства.</p>
    </section>

    <section class="card">
      <h2>15. Краткие условия</h2>
      <ul>
        <li>Покупка Premium — это покупка доступа к функциям бота, а не покупка билета на розыгрыш.</li>
        <li>Участие в акции — дополнительный бонус для Premium-пользователей.</li>
        <li>Каждая покупка Premium создаёт один токен.</li>
        <li>Повторная покупка Premium увеличивает шанс победы.</li>
        <li>Для получения основного приза нужно выполнить все условия.</li>
        <li>Главный приз включает только два авиабилета в Турцию в одну сторону.</li>
      </ul>
    </section>

    <p class="footer">© 2026 ИП Журавлев Антон Андреевич. Premium-акция с розыгрышем призов.</p>
  </main>
</body>
</html>`;
}

function handlePremiumRaffleRulesRoute(_req, res) {
  res
    .status(200)
    .type("text/html; charset=utf-8")
    .send(buildPremiumRaffleRulesHtml());
}

app.get(["/promo", "/premium-promo", "/premium-raffle"], handlePremiumRaffleRulesRoute);

app.get("/premium/buy", handlePremiumBuyRoute);
app.post("/premium/buy", handlePremiumBuyRoute);

app.get("/product-card/buy", handleProductCardBuyRoute);
app.post("/product-card/buy", handleProductCardBuyRoute);

app.get("/music/buy", handleMusicBuyRoute);
app.post("/music/buy", handleMusicBuyRoute);

app.get("/prompt-video/buy", handlePromptVideoBuyRoute);
app.post("/prompt-video/buy", handlePromptVideoBuyRoute);

app.get("/video/buy", handleVideoBuyRoute);
app.post("/video/buy", handleVideoBuyRoute);

app.get("/family-video/buy", handleFamilyVideoBuyRoute);
app.post("/family-video/buy", handleFamilyVideoBuyRoute);

app.get("/family-video/return", (req, res) => {
  res
    .status(200)
    .type("text/html; charset=utf-8")
    .send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 24px;">
          <h2>Спасибо за оплату</h2>
          <p>Если платеж прошел успешно, доступ к режиму «ТРЕНД МЕСЯЦА» будет активирован автоматически. Вернитесь в бот.</p>
        </body>
      </html>
    `);
});

async function handleYooKassaWebhook(req, res) {
  // YooKassa нужно быстро получить HTTP 200.
  res.status(200).json({ ok: true });

  const notification = req.body;

  (async () => {
    try {
      const event = String(notification?.event || "");
      const object = notification?.object || {};
      const paymentId = String(object?.id || "").trim();

      if (event !== "payment.succeeded" || !paymentId) {
        return;
      }

      // Проверяем платеж повторно через YooKassa, чтобы не доверять только webhook.
      const payment = await getYooKassaPayment(paymentId);
      const metadata = payment?.metadata || {};
      const product = String(metadata.product || "").trim();

      if (product === "premium_month") {
        const result = await applyPremiumPayment(payment);

        console.log("Premium payment apply result:", result);

        if (result.granted && result.userId) {
          await persistTemporaryHoroscopeProfileForPremiumUser(result.userId).catch((error) => {
            console.warn("Failed to persist temporary horoscope profile after Premium payment:", error?.message || error);
          });

          await sendMaxMessage(
            {
              type: "user_id",
              id: result.userId
            },
            [
              "✅ **Премиум на месяц получен!**",
              "",
              "Теперь вам открыт доступ:",
              `• ${PREMIUM_IMAGE_REQUEST_LIMIT} фото в день с лучшей моделью;`,
              `• ${PREMIUM_CHATGPT_REQUEST_LIMIT} запросов ChatGPT в день;`,
              `• оживить фото / видео по фото: ${PREMIUM_VIDEO_REQUEST_LIMIT} раз в день;`,
              "• ежедневный гороскоп по выбранному времени;",
              "• без обязательной подписки на каналы;",
              "",
              "🎁 **Бонусные кредиты начислены:**",
              `• создать видео: +${PREMIUM_BONUS_PROMPT_VIDEO_CREDITS};`,
              `• создать карточку товара: +${PREMIUM_BONUS_PRODUCT_CARD_CREDITS};`,
              `• создать музыку: +${PREMIUM_BONUS_MUSIC_CREDITS}.`,
              "",
              "Кредиты суммируются при повторной покупке Premium. Если кредиты закончились — купите Premium ещё раз.",
              ...buildPremiumRaffleSuccessLines(result.raffleTicket),
              "",
              "Спасибо, вы стали Спонсором Бота и членом нашей семьи 🙌🏻"
            ].join("\n")
          ).catch((error) => {
            console.warn("Failed to send premium success message:", error?.message || error);
          });
        }

        return;
      }

      if (product === PRODUCT_CARD_PRODUCT_CODE) {
        const result = await applyProductCardPayment(payment);

        console.log("Product card payment apply result:", result);

        if (result.granted && result.userId) {
          setUserImageMode(result.userId, IMAGE_MODE_PRODUCT_CARD);

          await sendMaxMessage(
            {
              type: "user_id",
              id: result.userId
            },
            [
              "✅ **Оплата прошла. Доступ к карточке товара открыт.**",
              "",
              "Теперь отправьте:",
              "• **фото товара + промт** — лучший вариант;",
              "или",
              "• **просто промт товара**.",
              "",
              "Я создам **3 красивые карточки товара с разных ракурсов**.",
              "",
              "Пример:",
              "`Крем для лица Nuvelora, премиальная бело-золотая карточка для маркетплейса, чистый фон, четкая надпись Nuvelora`"
            ].join("\n")
          ).catch((error) => {
            console.warn("Failed to send product card success message:", error?.message || error);
          });
        }

        return;
      }

      if (product === MUSIC_PRODUCT_CODE) {
  const result = await applyMusicPayment(payment);

  console.log("Music payment apply result:", result);

  if (result.granted && result.userId) {
    setUserImageMode(result.userId, IMAGE_MODE_MUSIC);

    await sendMaxMessage(
      {
        type: "user_id",
        id: result.userId
      },
      [
        "✅ **Оплата прошла. Доступ к созданию музыки открыт.**",
        "",
        "Теперь нажмите в меню «🎵 Создать музыку» ещё раз или сразу отправьте описание трека.",
        "",
        "Я создам **MP3-трек на 30 секунд** через Lyria 3 Clip.",
        "",
        "Пример:",
        "`Создай 30-секундный энергичный поп-трек для рекламы frozen yogurt, летнее настроение, мягкий вокал, современный бит`"
      ].join("\n")
    ).catch((error) => {
      console.warn("Failed to send music success message:", error?.message || error);
    });
  }

  return;
}


if (product === PROMPT_VIDEO_PRODUCT_CODE) {
  const result = await applyPromptVideoPayment(payment);

  console.log("Prompt video payment apply result:", result);

  if (result.granted && result.userId) {
    setUserImageMode(result.userId, IMAGE_MODE_PROMPT_VIDEO);

    await sendMaxMessage(
      {
        type: "user_id",
        id: result.userId
      },
      [
        "✅ **Оплата прошла. Режим «Создать видео» открыт.**",
        "",
        "Теперь отправьте:",
        "• **просто промт** — видео с нуля;",
        "• **фото + промт** — видео на основе фото.",
        "",
        "Видео будет создано на **5 секунд**, качество **720p**, модель **KLING**.",
        "",
        "Пример:",
        "`кот в очках едет на скейте по солнечной улице, плавная камера, реалистично`"
      ].join("\n")
    ).catch((error) => {
      console.warn(
        "Failed to send prompt video success message:",
        error?.message || error
      );
    });
  }

  return;
}

if (product === FAMILY_VIDEO_PRODUCT_CODE) {
  const result = await applyFamilyVideoPayment(payment);

  console.log("Family video payment apply result:", result);

  if (result.granted && result.userId) {
    setUserImageMode(result.userId, IMAGE_MODE_FAMILY_VIDEO);
    clearFamilyVideoDraft(result.userId);

    await sendMaxMessage(
      {
        type: "user_id",
        id: result.userId
      },
      [
        "✅ **Оплата прошла. Режим «ТРЕНД МЕСЯЦА» открыт.**",
        "",
        "Подсказка:",
        "Вам нужно отправить **готовое фото для тренда**.",
        "Нажмите **«Создать фото бесплатно»**, выберите **«СТИЛИ»** и там выберите стиль **«⚾ ТРЕНД»**.",
        "Когда фото будет готово — просто отправьте его сюда, и бот создаст для вас тренд-видео.",
        "",
        "Видео будет создано на **5 секунд** через **KLING**, вертикальный формат **9:16**."
      ].join("\n")
    ).catch((error) => {
      console.warn(
        "Failed to send family video success message:",
        error?.message || error
      );
    });
  }

  return;
}

if (product === VIDEO_PRODUCT_CODE) {
  const result = await applyVideoPayment(payment);

  console.log("Video payment apply result:", result);

  if (result.granted && result.userId) {
    setUserImageMode(result.userId, IMAGE_MODE_VIDEO);

    await sendMaxMessage(
      {
        type: "user_id",
        id: result.userId
      },
      [
        "✅ **Оплата прошла. Оживление фото доступно.**",
        "",
        "Теперь просто отправьте **фото человека**.",
        "",
        "Текст можно не писать. Если отправите фото с текстом — текст будет проигнорирован.",
        "",
        "Я сделаю видео на **5 секунд** через Seedance Lite: человек будет смотреть в камеру, слегка улыбаться и мягко махать рукой."
      ].join("\n")
    ).catch((error) => {
      console.warn(
        "Failed to send video success message:",
        error?.message || error
      );
    });
  }

  return;
}

console.warn("Unknown YooKassa product:", {
  paymentId,
  product,
  metadata
});
    } catch (error) {
      console.error("YooKassa webhook processing failed:", error);
    }
  })();
}
      
app.post("/yookassa-webhook", handleYooKassaWebhook);
app.post("/yookassa/webhook", handleYooKassaWebhook);

app.post("/webhook", (req, res) => {
  if (MAX_WEBHOOK_SECRET) {
    const receivedSecret = req.get("X-Max-Bot-Api-Secret") || "";

    if (receivedSecret !== MAX_WEBHOOK_SECRET) {
      res.status(401).json({ ok: false, error: "Invalid webhook secret" });
      return;
    }
  }

  res.status(200).json({ ok: true });

  const payload = req.body;
  const updates = Array.isArray(payload?.updates) ? payload.updates : [payload];

  for (const update of updates) {
    handleUpdate(update).catch((error) => {
      console.error("Unhandled update handling failure:", error);
    });
  }
});

resetDailyLimits();

(async () => {
  try {
    await initBroadcastUsersDb();
    await initHipeDb();
    await initLimitsDb();
    await initPremiumDb();
    await initReferralDb();
    await initHoroscopeDb();
  } catch (error) {
    console.warn("DB init failed:", error?.message || error);
  } finally {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`MAX OpenAI bot is running on port ${PORT}`);
      startHoroscopeDailyPublisher();

      setTimeout(() => {
        if (VIDEO_EXAMPLE_URL && !cachedVideoExampleToken) {
          getVideoExampleMaxToken().catch((error) => {
            console.warn("Video example warmup failed:", error?.message || error);
          });
        }

        if (FAMILY_VIDEO_EXAMPLE_URL && !cachedFamilyVideoExampleToken) {
          getFamilyVideoExampleMaxToken().catch((error) => {
            console.warn("Family video example warmup failed:", error?.message || error);
          });
        }
      }, 2000).unref?.();
    });
  }
})();