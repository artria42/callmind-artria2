const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// ==================== ЛОГИРОВАНИЕ ====================
// Структурированное логирование с Winston
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    // Ошибки в отдельный файл
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    // Все логи
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880,
      maxFiles: 5
    }),
    // Консоль для Railway
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Создаем папку для логов если её нет
if (!fs.existsSync('logs')) {
  fs.mkdirSync('logs');
}

// ==================== RETRY ЛОГИКА ====================
/**
 * Retry функция с exponential backoff для OpenAI API
 * @param {Function} requestFn - Функция запроса к API
 * @param {Number} maxRetries - Максимальное количество попыток
 * @param {String} operationName - Название операции для логов
 */
async function callWithRetry(requestFn, maxRetries = 3, operationName = 'API call') {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      // Определяем можно ли повторить запрос
      const isRetryable =
        error.code === 'ECONNABORTED' || // Timeout
        error.code === 'ENOTFOUND' ||    // DNS
        error.code === 'ECONNRESET' ||   // Connection reset
        error.message?.includes('socket hang up') || // Socket errors
        error.response?.status === 429 || // Rate limit
        error.response?.status >= 500;    // Server error

      const isLastAttempt = attempt === maxRetries;

      if (!isRetryable || isLastAttempt) {
        logger.error(`❌ ${operationName} failed after ${attempt} attempts`, {
          error: error.message,
          status: error.response?.status,
          code: error.code,
          attempt
        });
        throw error;
      }

      // Специальная обработка rate limit - более длительная задержка
      let delayMs;
      if (error.response?.status === 429) {
        // Для rate limit используем более агрессивный backoff
        delayMs = Math.min(Math.pow(2, attempt) * 2000, 30000); // 4s, 8s, 16s, max 30s
        logger.warn(`⚠️ ${operationName} rate limited, retry ${attempt}/${maxRetries} через ${delayMs}ms`, {
          status: 429
        });
      } else {
        // Для остальных ошибок: 1s, 2s, 4s, 8s...
        delayMs = Math.min(Math.pow(2, attempt - 1) * 1000, 10000);
        logger.warn(`⚠️ ${operationName} failed, retry ${attempt}/${maxRetries} через ${delayMs}ms`, {
          error: error.message,
          status: error.response?.status,
          code: error.code
        });
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

const app = express();

// Доверяем прокси Railway для корректной работы rate limiter
// Railway использует reverse proxy, который устанавливает X-Forwarded-For заголовки
app.set('trust proxy', 1);

// ==================== RATE LIMITING ====================
// Защита от DDoS и перерасхода OpenAI API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100, // Максимум 100 запросов с одного IP
  message: { error: 'Слишком много запросов, попробуйте позже' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', { ip: req.ip, path: req.path });
    res.status(429).json({ error: 'Слишком много запросов, попробуйте позже' });
  }
});

// CORS настройки - разрешаем запросы только с фронтенда
app.use(cors({
  origin: [
    'https://dreamy-lokum-46cbc7.netlify.app',
    'http://localhost:8000', // Для локальной разработки
    /\.netlify\.app$/ // Для всех Netlify preview деплоев
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/', apiLimiter);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BITRIX_DOMAIN = process.env.BITRIX_DOMAIN;
const BITRIX_CLIENT_ID = process.env.BITRIX_CLIENT_ID;
const BITRIX_CLIENT_SECRET = process.env.BITRIX_CLIENT_SECRET;
const GOOGLE_PROXY_URL = process.env.GOOGLE_PROXY_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

let bitrixTokens = { access_token: null, refresh_token: null };

// Проверяем наличие ffmpeg при старте
let FFMPEG_AVAILABLE = false;
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  FFMPEG_AVAILABLE = true;
  logger.info('✅ ffmpeg найден');
} catch (e) {
  logger.warn('⚠️ ffmpeg не найден — разделение каналов недоступно, будет fallback на GPT-4o');
}

// ====================================================================
//  FIX #1: WHISPER PROMPT — связные фразы вместо списка слов
//
//  Whisper prompt — это НЕ инструкция. Это "предшествующий контекст",
//  как будто этот текст уже был произнесён. Whisper продолжает стиль.
//
//  Старый prompt: список слов через запятую → Whisper не понимает контекст
//  Новый prompt: реалистичное начало разговора → Whisper подхватывает стиль
// ====================================================================
const WHISPER_PROMPT_KK =
  'Алло, сәлеметсіз бе. Клиника Мирамед, хабарласып тұрмын. ' +
  'Сіздің буыныңыз ауырады ма? Тізе, бел, омыртқа, иық. ' +
  'Артроз, грыжа, диагностика, емдеу. ' +
  'Дәрігерге жазылу, консультация, тексеру. МРТ, рентген. ' +
  'Диагностика тоғыз мың тоғыз жүз теңге. ' +
  'Қалай ауырады, қашан ауырады, түнде мазалай ма, жүргенде ше. ' +
  'Здравствуйте, клиника Мирамед. Запись на приём, обследование, диагностика. ' +
  'Суставы, позвоночник, колено, поясница, артроз, грыжа. Девять тысяч девятьсот тенге.';

// ==================== TOKENS ====================

async function saveTokensToDb() {
  try {
    await supabase.from('settings').upsert({
      key: 'bitrix_tokens',
      value: JSON.stringify(bitrixTokens),
      updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
    logger.debug('Bitrix tokens saved to DB');
  } catch (e) {
    logger.error('Error saving tokens', { error: e.message });
  }
}

async function loadTokensFromDb() {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'bitrix_tokens').single();
    if (data?.value) {
      bitrixTokens = JSON.parse(data.value);
      return true;
    }
  } catch (e) {}
  return false;
}

// ==================== ROUTES ====================

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: '🏥 Clinic CallMind API v5.0',
    features: ['bitrix', 'ai-analysis', 'stereo-channel-split', 'gpt-4o-transcribe', 'two-block-format'],
    ffmpeg: FFMPEG_AVAILABLE,
    bitrix_connected: !!bitrixTokens.access_token
  });
});

// ==================== HEALTH CHECK ====================
// Endpoint для мониторинга и keep-alive от Railway
app.get('/health', (req, res) => {
  const healthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    uptimeFormatted: formatUptime(process.uptime()),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      unit: 'MB'
    },
    services: {
      bitrix: !!bitrixTokens.access_token,
      ffmpeg: FFMPEG_AVAILABLE,
      supabase: true, // Проверяем что подключение есть
      openai: !!process.env.OPENAI_API_KEY
    },
    environment: process.env.NODE_ENV || 'development'
  };

  logger.info('Health check', healthStatus);
  res.json(healthStatus);
});

// Форматирование uptime в читаемый вид
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

app.get('/api/bitrix/auth', (req, res) => {
  res.json({ auth_url: `https://${BITRIX_DOMAIN}/oauth/authorize/?client_id=${BITRIX_CLIENT_ID}&response_type=code` });
});

app.get('/api/bitrix/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'No code' });
  try {
    const response = await axios.get(`https://${BITRIX_DOMAIN}/oauth/token/?grant_type=authorization_code&client_id=${BITRIX_CLIENT_ID}&client_secret=${BITRIX_CLIENT_SECRET}&code=${code}`);
    bitrixTokens = { access_token: response.data.access_token, refresh_token: response.data.refresh_token };
    await saveTokensToDb();
    res.send('<h1>✅ Битрикс24 подключён!</h1>');
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bitrix/status', (req, res) => {
  res.json({ connected: !!bitrixTokens.access_token, domain: BITRIX_DOMAIN });
});

// ==================== BITRIX API ====================

async function refreshBitrixToken() {
  if (!bitrixTokens.refresh_token) {
    await loadTokensFromDb();
    if (!bitrixTokens.refresh_token) return false;
  }
  try {
    const response = await axios.get(`https://${BITRIX_DOMAIN}/oauth/token/?grant_type=refresh_token&client_id=${BITRIX_CLIENT_ID}&client_secret=${BITRIX_CLIENT_SECRET}&refresh_token=${bitrixTokens.refresh_token}`);
    bitrixTokens = { access_token: response.data.access_token, refresh_token: response.data.refresh_token };
    await saveTokensToDb();
    return true;
  } catch (e) { return false; }
}

async function callBitrixMethod(method, params = {}) {
  if (!bitrixTokens.access_token) throw new Error('Битрикс не авторизован');
  try {
    const response = await axios.post(`https://${BITRIX_DOMAIN}/rest/${method}?auth=${bitrixTokens.access_token}`, params);
    return response.data.result;
  } catch (error) {
    if (error.response?.data?.error === 'expired_token') {
      if (await refreshBitrixToken()) {
        const response = await axios.post(`https://${BITRIX_DOMAIN}/rest/${method}?auth=${bitrixTokens.access_token}`, params);
        return response.data.result;
      }
    }
    throw error;
  }
}

// ==================== WEBHOOKS ====================

app.post('/api/bitrix/webhook', async (req, res) => {
  const event = req.body.event || req.body.EVENT;
  if (event === 'ONVOXIMPLANTCALLEND' || event === 'onVoximplantCallEnd') {
    setTimeout(() => syncNewCalls(), 5000);
  }
  res.json({ status: 'ok' });
});

app.post('/api/bitrix/call-webhook', async (req, res) => {
  const event = req.body.event || req.body.EVENT;
  if (event === 'ONVOXIMPLANTCALLEND' || event === 'onVoximplantCallEnd') {
    setTimeout(() => syncNewCalls(), 5000);
  }
  res.json({ status: 'ok' });
});

// ==================== SYNC ====================

async function syncNewCalls() {
  if (!bitrixTokens.access_token) return;
  try {
    const calls = await callBitrixMethod('voximplant.statistic.get', {
      FILTER: { '>CALL_START_DATE': new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
      SORT: 'CALL_START_DATE', ORDER: 'DESC'
    });
    for (const call of calls || []) {
      const { data: existing } = await supabase.from('calls').select('id, audio_url, call_direction').eq('bitrix_call_id', call.ID).single();
      if (existing) {
        if (!existing.audio_url && call.CALL_RECORD_URL) {
          const callDirection = call.CALL_TYPE === "2" ? "outgoing" : "incoming";
          await supabase.from('calls').update({
            audio_url: call.CALL_RECORD_URL,
            call_direction: callDirection
          }).eq('id', existing.id);
          const { data: score } = await supabase.from('call_scores').select('id').eq('call_id', existing.id).single();
          if (!score) analyzeCallById(existing.id).catch(e => console.error(e.message));
        }
        continue;
      }
      const { data: manager } = await supabase.from('managers').select('id').eq('bitrix_id', call.PORTAL_USER_ID).single();
      // CALL_TYPE: "1" = входящий, "2" = исходящий (для swap каналов)
      const callDirection = call.CALL_TYPE === "2" ? "outgoing" : "incoming";
      const { data: newCall } = await supabase.from('calls').insert({
        bitrix_call_id: call.ID, manager_id: manager?.id, client_name: call.PHONE_NUMBER,
        duration: parseInt(call.CALL_DURATION) || 0, call_date: call.CALL_START_DATE,
        audio_url: call.CALL_RECORD_URL || null,
        call_direction: callDirection,
        crm_link: call.CRM_ENTITY_ID ? `https://${BITRIX_DOMAIN}/crm/${(call.CRM_ENTITY_TYPE || 'contact').toLowerCase()}/details/${call.CRM_ENTITY_ID}/` : null
      }).select().single();
      if (newCall?.audio_url) {
        analyzeCallById(newCall.id).catch(e => {
          logger.error('Auto-analysis failed', { callId: newCall.id, error: e.message });
        });
      }
    }
  } catch (e) {
    logger.error('Sync error', { error: e.message, stack: e.stack });
  }
}

app.get('/api/bitrix/calls', async (req, res) => {
  try {
    const calls = await callBitrixMethod('voximplant.statistic.get', {
      FILTER: { '>CALL_START_DATE': new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
      SORT: 'CALL_START_DATE', ORDER: 'DESC'
    });
    for (const call of calls || []) {
      const { data: manager } = await supabase.from('managers').select('id').eq('bitrix_id', call.PORTAL_USER_ID).single();
      const callDirection = call.CALL_TYPE === "2" ? "outgoing" : "incoming";
      await supabase.from('calls').upsert({
        bitrix_call_id: call.ID, manager_id: manager?.id, client_name: call.PHONE_NUMBER,
        duration: parseInt(call.CALL_DURATION) || 0, call_date: call.CALL_START_DATE,
        audio_url: call.CALL_RECORD_URL || null,
        call_direction: callDirection,
        crm_link: call.CRM_ENTITY_ID ? `https://${BITRIX_DOMAIN}/crm/${(call.CRM_ENTITY_TYPE || 'contact').toLowerCase()}/details/${call.CRM_ENTITY_ID}/` : null
      }, { onConflict: 'bitrix_call_id' });
    }
    res.json({ success: true, count: calls?.length || 0 });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/bitrix/users', async (req, res) => {
  try {
    const users = await callBitrixMethod('user.get', { filter: { ACTIVE: true } });
    for (const user of users) {
      await supabase.from('managers').upsert({ bitrix_id: user.ID, name: `${user.NAME} ${user.LAST_NAME}`.trim() }, { onConflict: 'bitrix_id' });
    }
    res.json({ success: true, count: users.length });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ====================================================================
//  ТРАНСКРИБАЦИЯ v5.0
//
//  КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: whisper-1 → gpt-4o-transcribe
//
//  Исследование казахского STT (MDPI, July 2025) показало:
//  - Whisper-1 (v2) на казахском: WER ~43%
//  - gpt-4o-transcribe на казахском: WER ~36% (лучший среди не fine-tuned)
//  - Значительно лучше chrF (81.15) и COMET (1.02) — сохраняет смысл
//
//  gpt-4o-transcribe:
//  ✅ Значительно лучше на казахском (меньше галлюцинаций, лучше WER)
//  ✅ Поддерживает language + prompt
//  ✅ Тот же API endpoint /v1/audio/transcriptions
//  ❌ НЕ поддерживает verbose_json / segments — только json и text
//  → Нам segments НЕ нужны — мы используем формат "два полотна текста"
//
//  ФОРМАТ ВЫВОДА v5.2: Два блока текста (manager + client)
//  GPT-4o переводит ДОСЛОВНО, форматирует абзацами, НЕ восстанавливает порядок
// ====================================================================

/**
 * Разделяет стерео MP3 на два моно-канала через ffmpeg
 *
 * ВАЖНО: Направление звонка влияет на распределение каналов!
 *
 * ВХОДЯЩИЙ (incoming): LEFT = клиент, RIGHT = администратор
 * ИСХОДЯЩИЙ (outgoing): LEFT = администратор, RIGHT = клиент
 *
 * @param {Buffer} audioBuffer - Аудио файл
 * @param {string} callDirection - "incoming" или "outgoing"
 */
function splitStereoChannels(audioBuffer, callDirection = 'incoming') {
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const inputPath = path.join(tmpDir, `call_${ts}.mp3`);
  const leftPath = path.join(tmpDir, `call_${ts}_left.mp3`);
  const rightPath = path.join(tmpDir, `call_${ts}_right.mp3`);

  try {
    fs.writeFileSync(inputPath, audioBuffer);

    const probeOutput = execSync(
      `ffprobe -v quiet -print_format json -show_streams "${inputPath}"`,
      { encoding: 'utf-8' }
    );
    const streams = JSON.parse(probeOutput).streams || [];
    const audioStream = streams.find(s => s.codec_type === 'audio');
    const channels = audioStream?.channels || 1;

    if (channels < 2) {
      logger.warn('⚠️ Аудио моно — разделение невозможно', { channels });
      return null;
    }

    // Конвертируем в WAV 16kHz PCM — лучше качество для gpt-4o-transcribe
    execSync(`ffmpeg -y -i "${inputPath}" -af "pan=mono|c0=c0" -ar 16000 -ac 1 -f wav "${leftPath}"`, { stdio: 'ignore' });
    execSync(`ffmpeg -y -i "${inputPath}" -af "pan=mono|c0=c1" -ar 16000 -ac 1 -f wav "${rightPath}"`, { stdio: 'ignore' });

    const leftBuffer = fs.readFileSync(leftPath);
    const rightBuffer = fs.readFileSync(rightPath);

    // SWAP ЛОГИКА для исходящих звонков
    // Исходящий: LEFT=админ, RIGHT=клиент → нужно поменять местами
    // Входящий: LEFT=клиент, RIGHT=админ → оставляем как есть
    const isOutgoing = callDirection === 'outgoing';

    logger.info(`✅ Каналы разделены (WAV 16kHz)`, {
      direction: callDirection,
      swapped: isOutgoing,
      leftSize: leftBuffer.length,
      rightSize: rightBuffer.length
    });

    if (isOutgoing) {
      // Исходящий звонок: LEFT=админ, RIGHT=клиент
      return { client: rightBuffer, manager: leftBuffer };
    } else {
      // Входящий звонок: LEFT=клиент, RIGHT=админ
      return { client: leftBuffer, manager: rightBuffer };
    }
  } finally {
    try { fs.unlinkSync(inputPath); } catch (e) {}
    try { fs.unlinkSync(leftPath); } catch (e) {}
    try { fs.unlinkSync(rightPath); } catch (e) {}
  }
}

/**
 * gpt-4o-transcribe: транскрибация одного канала с автоопределением языка
 *
 * Почему НЕ whisper-1:
 * - whisper-1 на казахском выдаёт "Аллаға сауын атып" вместо "Алло"
 * - gpt-4o-transcribe имеет WER на 7% ниже на казахском
 * - Лучше понимает code-switching (каз+рус в одном предложении)
 *
 * Автоопределение языка (без параметра language):
 * - Работает для русских, казахских и смешанных звонков
 * - Форсирование language='kk' вызывало галлюцинации на русских звонках
 *
 * Формат: json (text only) — segments недоступны в gpt-4o-transcribe
 */
async function transcribeChannel(audioBuffer, channelName) {
  logger.info(`🎤 gpt-4o-transcribe [${channelName}] → OpenAI (auto language detection)...`);

  const FormData = require('form-data');
  const formData = new FormData();
  // WAV лучше чем MP3 для точности распознавания
  formData.append('file', audioBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
  formData.append('model', 'gpt-4o-transcribe');
  // НЕ указываем language — gpt-4o-transcribe сам определит (ru/kk/mix)
  formData.append('response_format', 'json');
  formData.append('prompt', WHISPER_PROMPT_KK);

  // Используем retry логику для надежности
  const response = await callWithRetry(
    () => axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, ...formData.getHeaders() },
      timeout: 300000 // Увеличено до 5 минут для длинных записей
    }),
    3, // 3 попытки
    `transcribeChannel[${channelName}]`
  );

  const text = (response.data.text || '').trim();
  logger.info(`✅ gpt-4o-transcribe [${channelName}]: ${text.length} chars`);
  return text;
}

/**
 * GPT-4o: Перевод двух каналов → два блока текста с форматированием
 *
 * ЛОГИКА v5.2:
 * Получаем два канала (админ + клиент), переводим ДОСЛОВНО на русский,
 * форматируем абзацами (после 2-3 предложений).
 * НЕ восстанавливаем порядок реплик — это приводит к выдумыванию деталей.
 *
 * Формат: { manager: "текст админа\n\nабзац2\n\nабзац3", client: "текст клиента..." }
 */
async function repairAndTranslate(adminRawText, clientRawText) {
  logger.info('📝 СЫРОЙ ТЕКСТ ОТ gpt-4o-transcribe (до перевода)', {
    adminLength: adminRawText.length,
    clientLength: clientRawText.length,
    adminPreview: adminRawText.substring(0, 200),
    clientPreview: clientRawText.substring(0, 200)
  });

  if (!adminRawText.trim() && !clientRawText.trim()) {
    return { manager: '', client: '' };
  }

  const systemPrompt = `# РОЛЬ
Ты — профессиональный переводчик медицинских звонков казахский/русский → чистый русский.

# КРИТИЧЕСКИ ВАЖНО
**ПЕРЕВОДИ ДОСЛОВНО**. Не выдумывай, не добавляй, не интерпретируй. Если что-то непонятно — переведи максимально близко к оригиналу, но НЕ ПРИДУМЫВАЙ детали.

# ЗАДАЧА
У тебя есть ДВА КАНАЛА звонка в клинику "Мирамед" (Актобе):
1. КАНАЛ АДМИНИСТРАТОРА — весь текст менеджера (на казахском/русском/миксе)
2. КАНАЛ ПАЦИЕНТА — весь текст пациента (на казахском/русском/миксе)

Твоя задача:
1. **ПРОЧИТАЙ ОБА КАНАЛА** — пойми общий контекст (звонок про лечение суставов)
2. **ПЕРЕВЕДИ КАЖДЫЙ КАНАЛ ОТДЕЛЬНО** на чистый русский язык
3. **СОХРАНИ ВСЕ ДЕТАЛИ**:
   - Имена людей (не выдумывай, переводи как слышишь)
   - Названия мест (Актобе, Шымкент, город и т.д.)
   - Имена врачей (ТОЧНО, не выдумывай!)
   - Цены, даты, время
   - Все симптомы и жалобы пациента
   - Все предложения администратора
4. **ФОРМАТИРУЙ АБЗАЦАМИ**: После 2-3 предложений делай двойной перевод строки (\\n\\n)
5. **УБИРАЙ МУСОР**: Повторы слов, артефакты распознавания (но НЕ смысловые повторы!)

# МЕДИЦИНСКИЙ СЛОВАРЬ (казахский → русский)
буын=сустав, омыртқа=позвоночник, бел=поясница, тізе=колено
иық=плечо, мойын=шея, аяқ=нога, қол=рука
ауырады=болит, қатты ауырады=сильно болит, ісінді=отекло
сыздайды=ноет, батырады=стреляет, дәрігер=врач, емхана=клиника
тексеру=обследование, емдеу=лечение, зейнетақы=пенсия
жазылу=записаться, қанша тұрады=сколько стоит
жүргенде=при ходьбе, түнде=ночью, мазалайды=беспокоит
келесі апта=следующая неделя, тұрсам=если стою, отырсам=если сижу
Сәлеметсіз бе=Здравствуйте, Қайырлы күн=Добрый день
алло=алло, мархабат=здравствуйте (неформально)
дәріхана=аптека, емделу=лечиться

# КОНТЕКСТ КЛИНИКИ МИРАМЕД
- Клиника "Мирамед" в Актобе
- Лечение суставов и позвоночника без операции
- Акция: Консультация + УЗИ двух суставов + бесплатный повторный приём = 9 900 тенге (обычно 15 000)
- Врачи: травматологи-ортопеды высшей категории
- Методы: PRP-терапия, плазмотерапия

# ФОРМАТ ОТВЕТА — строго JSON, без markdown:
{
  "manager": "Полный переведённый текст администратора.\\n\\nФорматированный абзацами после 2-3 предложений.\\n\\nТретий абзац.",
  "client": "Полный переведённый текст пациента.\\n\\nТоже с абзацами для читабельности."
}

# ПРАВИЛА ПЕРЕВОДА
1. ДОСЛОВНО — сохраняй структуру речи говорящего
2. НЕ МЕНЯЙ ПОРЯДОК — переводи каждый канал как есть, не пытайся восстановить диалог
3. НЕ ВЫДУМЫВАЙ — если непонятно, переведи приблизительно, но не добавляй от себя
4. СОХРАНЯЙ ВСЕ ИМЕНА — не изменяй и не "исправляй" имена людей и врачей
5. ФОРМАТИРУЙ — делай абзацы для удобочитаемости`;

  const userPrompt = `КАНАЛ АДМИНИСТРАТОРА (сырой):
${adminRawText}

КАНАЛ ПАЦИЕНТА (сырой):
${clientRawText}

Переведи оба канала ДОСЛОВНО на русский, сохрани все детали, отформатируй абзацами. Верни JSON.`;

  logger.info('🧠 GPT-4o: перевод двух каналов (v5.2 - точность)...');

  // Используем retry логику для надежности
  const response = await callWithRetry(
    () => axios.post(GOOGLE_PROXY_URL, {
      type: 'chat',
      apiKey: OPENAI_API_KEY,
      model: 'gpt-4o',
      max_tokens: 4000,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    }, { timeout: 180000 }), // Увеличено до 3 минут
    3,
    'repairAndTranslate'
  );

  // Проверяем валидность ответа
  if (!response?.data?.choices?.length) {
    logger.error('❌ GPT-4o translation: invalid response', {
      responseData: response?.data
    });
    // Fallback - возвращаем сырой текст
    return { manager: adminRawText, client: clientRawText };
  }

  const content = response.data.choices[0].message?.content?.trim();
  if (!content) {
    logger.warn('⚠️ GPT-4o translation: empty content, using raw text');
    return { manager: adminRawText, client: clientRawText };
  }
  let result;
  try {
    const clean = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    result = JSON.parse(clean);
  } catch (e) {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      result = JSON.parse(match[0]);
    } else {
      logger.warn('⚠️ GPT не вернул JSON, fallback', {
        contentPreview: content.substring(0, 200)
      });
      result = { manager: adminRawText, client: clientRawText };
    }
  }

  const managerText = (result.manager || result.admin || '').trim();
  const clientText = (result.client || result.patient || '').trim();

  logger.info(`✅ Перевод done (v5.2)`, {
    managerLength: managerText.length,
    clientLength: clientText.length
  });

  return { manager: managerText, client: clientText };
}

/**
 * GPT-4o: Перевод моно-аудио (оба голоса в одном канале) → два блока текста
 *
 * ЛОГИКА v5.2:
 * Из моно-транскрипта GPT-4o разделяет по ролям, переводит ДОСЛОВНО,
 * форматирует абзацами. Возвращает два блока (manager + client).
 */
async function repairAndTranslateMono(rawText) {
  if (!rawText || rawText.trim().length < 15) {
    return { manager: rawText || '', client: '' };
  }

  const systemPrompt = `# РОЛЬ
Ты — профессиональный переводчик медицинских звонков казахский/русский → чистый русский.

# КРИТИЧЕСКИ ВАЖНО
**ПЕРЕВОДИ ДОСЛОВНО**. Не выдумывай, не добавляй, не интерпретируй.

# ЗАДАЧА
У тебя есть транскрипт звонка в клинику "Мирамед" (Актобе), где ОБА ГОЛОСА записаны в одном канале (моно).

Твоя задача:
1. **РАЗДЕЛИТЬ ПО РОЛЯМ**: Определи кто говорил (администратор или пациент) по контексту
   - Администратор: приветствует, задаёт вопросы о боли, предлагает запись, называет цену
   - Пациент: отвечает на вопросы, описывает симптомы, спрашивает про цену
2. **ПЕРЕВЕСТИ** каждую роль на чистый русский
3. **СОХРАНИ ВСЕ ДЕТАЛИ**: имена, места, врачей, цены, симптомы
4. **ФОРМАТИРУЙ АБЗАЦАМИ**: После 2-3 предложений делай \\n\\n
5. **УБИРАЙ МУСОР**: Повторы слов, артефакты распознавания

# МЕДИЦИНСКИЙ СЛОВАРЬ (казахский → русский)
буын=сустав, омыртқа=позвоночник, бел=поясница, тізе=колено, мойын=шея
иық=плечо, аяқ=нога, ауырады=болит, қатты ауырады=сильно болит
ісінді=отекло, дәрігер=врач, емхана=клиника, тексеру=обследование
емдеу=лечение, зейнетақы=пенсия, жүргенде=при ходьбе, түнде=ночью
Сәлеметсіз бе=Здравствуйте, Қайырлы күн=Добрый день

# КОНТЕКСТ КЛИНИКИ МИРАМЕД
- Клиника "Мирамед" в Актобе
- Акция: 9 900 тенге за консультацию + УЗИ

# ФОРМАТ ОТВЕТА — строго JSON, без markdown:
{
  "manager": "Весь текст администратора одним блоком.\\n\\nС абзацами.",
  "client": "Весь текст пациента одним блоком.\\n\\nС абзацами."
}

# ПРАВИЛА
1. ДОСЛОВНО — не выдумывай детали
2. НЕ МЕНЯЙ ПОРЯДОК — собери все фразы каждой роли в один блок
3. СОХРАНЯЙ ВСЕ ИМЕНА — не изменяй имена людей и врачей`;

  logger.info('🧠 GPT-4o: перевод моно (v5.2 - точность)...');

  // Используем retry логику для надежности
  const response = await callWithRetry(
    () => axios.post(GOOGLE_PROXY_URL, {
      type: 'chat',
      apiKey: OPENAI_API_KEY,
      model: 'gpt-4o',
      max_tokens: 4000,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `ТРАНСКРИПТ (моно):\n${rawText}\n\nРаздели по ролям, переведи ДОСЛОВНО на русский, отформатируй абзацами. Верни JSON.` }
      ]
    }, { timeout: 180000 }), // Увеличено до 3 минут
    3,
    'repairAndTranslateMono'
  );

  // Проверяем валидность ответа
  if (!response?.data?.choices?.length) {
    logger.error('❌ GPT-4o mono translation: invalid response', {
      responseData: response?.data
    });
    // Fallback - возвращаем сырой текст
    return { manager: rawText, client: '' };
  }

  const content = response.data.choices[0].message?.content?.trim();
  if (!content) {
    logger.warn('⚠️ GPT-4o mono translation: empty content, using raw text');
    return { manager: rawText, client: '' };
  }
  let result;
  try {
    const clean = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    result = JSON.parse(clean);
  } catch (e) {
    const match = content.match(/\{[\s\S]*\}/);
    result = match ? JSON.parse(match[0]) : { manager: rawText, client: '' };
  }

  const managerText = (result.manager || result.admin || '').trim();
  const clientText = (result.client || result.patient || '').trim();

  logger.info(`✅ Моно-перевод done (v5.2)`, {
    managerLength: managerText.length,
    clientLength: clientText.length
  });

  return { manager: managerText, client: clientText };
}

// ====================================================================
//  ГЛАВНАЯ ФУНКЦИЯ ТРАНСКРИБАЦИИ v5.2
//
//  Pipeline: gpt-4o-transcribe (каждый канал) → GPT-4o (перевод ДОСЛОВНЫЙ)
//  Вывод: formatted = [{ role: 'manager', text: '...' }, { role: 'client', text: '...' }]
//  Два блока текста с форматированием абзацами (НЕ реплики!)
// ====================================================================

async function transcribeAudio(audioUrl, callDirection = 'incoming') {
  try {
    logger.info('📥 Downloading audio...', { url: audioUrl, direction: callDirection });
    const audioResponse = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 180000, // Увеличено до 3 минут
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const audioBuffer = Buffer.from(audioResponse.data);
    logger.info(`📦 Audio downloaded`, { size: audioBuffer.length });

    // ========== СТЕРЕО РЕЖИМ (основной) ==========
    if (FFMPEG_AVAILABLE) {
      try {
        const channels = splitStereoChannels(audioBuffer, callDirection);

        if (channels) {
          logger.info('🔀 Стерео режим — gpt-4o-transcribe × 2 каналов');

          // Параллельная транскрибация
          const [managerRaw, clientRaw] = await Promise.all([
            transcribeChannel(channels.manager, 'администратор'),
            transcribeChannel(channels.client, 'пациент')
          ]);

          if (!managerRaw && !clientRaw) {
            return { plain: '', formatted: [] };
          }

          logger.info(`✅ Transcribe done`, {
            managerLength: managerRaw.length,
            clientLength: clientRaw.length
          });

          // GPT-4o: перевод двух каналов → два блока с форматированием
          const translated = await repairAndTranslate(managerRaw, clientRaw);

          const formatted = [];
          if (translated.manager) formatted.push({ role: 'manager', text: translated.manager });
          if (translated.client) formatted.push({ role: 'client', text: translated.client });

          const plainText = formatted.map(r => r.text).join(' ');
          logger.info(`✅ Стерео pipeline v5.2 done`, { blocks: formatted.length });
          return { plain: plainText, formatted };
        }
      } catch (e) {
        logger.warn('⚠️ Stereo failed, falling back to mono', { error: e.message });
      }
    }

    // ========== МОНО FALLBACK ==========
    logger.info('📝 Моно режим — gpt-4o-transcribe');

    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    fd.append('model', 'gpt-4o-transcribe');
    // НЕ указываем language — gpt-4o-transcribe сам определит (ru/kk/mix)
    fd.append('response_format', 'json');
    fd.append('prompt', WHISPER_PROMPT_KK);

    logger.info('🎤 gpt-4o-transcribe (mono, auto language)...');

    // Используем retry логику для надежности
    const r = await callWithRetry(
      () => axios.post('https://api.openai.com/v1/audio/transcriptions', fd, {
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, ...fd.getHeaders() },
        timeout: 300000 // Увеличено до 5 минут
      }),
      3,
      'transcribeAudio[mono]'
    );

    const rawText = (r.data.text || '').trim();
    logger.info(`✅ Mono transcribe done`, { textLength: rawText.length });

    if (rawText.length < 15) {
      return { plain: rawText, formatted: [{ role: 'manager', text: rawText }] };
    }

    // GPT-4o: перевод + разделение по ролям → два блока с форматированием
    const translated = await repairAndTranslateMono(rawText);

    const formatted = [];
    if (translated.manager) formatted.push({ role: 'manager', text: translated.manager });
    if (translated.client) formatted.push({ role: 'client', text: translated.client });

    const finalPlain = formatted.map(r => r.text).join(' ');
    logger.info(`✅ Mono pipeline v5.2 done`, { blocks: formatted.length });
    return { plain: finalPlain, formatted };

  } catch (error) {
    logger.error('❌ Transcription error', {
      error: error.message,
      stack: error.stack,
      audioUrl
    });
    throw new Error(`Ошибка транскрибации: ${error.message}`);
  }
}

// ==================== ИИ АНАЛИЗ ====================
// Оценка привязана к РЕАЛЬНОМУ скрипту продаж MIRAMED

async function analyzeCall(transcript, formatted) {
  const dialogText = formatted?.length
    ? formatted.map(r => `${r.role === 'manager' ? 'АДМИНИСТРАТОР' : 'ПАЦИЕНТ'}: ${r.text}`).join('\n')
    : transcript;

  // System prompt — роль + полный скрипт (постоянный контекст)
  const systemPrompt = `# РОЛЬ
Ты — строгий аудитор колл-центра клиники MIRAMED (Актобе, Казахстан).
Клиника лечит суставы и позвоночник без операции.
Оффер: «Экспертная диагностика» = Консультация врача + УЗИ двух суставов + бесплатный повторный приём = 9 900 ₸.

# ЭТАЛОННЫЙ СКРИПТ ПРОДАЖ (6 БЛОКОВ)
Менеджер должен пройти все этапы по порядку. Оценивай каждый блок 0-100 по тому, насколько менеджер выполнил ключевые действия этапа.

## БЛОК 1: УСТАНОВЛЕНИЕ КОНТАКТА + ПРОГРАММИРОВАНИЕ (Этапы 1 + 1.5)
Ключевые действия менеджера:
**ЭТАП 1 - Установление контакта:**
- Обратиться по имени: «Алло, [Имя]?»
- Представиться: «Добрый день! Меня зовут [Имя менеджера], клиника Miramed (Актобе)»
- Подтвердить заявку: «Вы оставляли заявку по поводу лечения суставов без операции, верно?»
- Если клиент не помнит: «Понимаю, день суматошный. Это клиника на [адрес], мы лечим колени и спину без хирургии»
- Спросить удобно ли говорить: «Вам сейчас удобно уделить пару минут?»

**ЭТАП 1.5 - Программирование (перехват инициативы):**
- Объяснить структуру разговора: «Чтобы я не гадала и смогла подобрать нужного специалиста, давайте поступим так:»
- Получить согласие на вопросы: «Я задам пару вопросов по вашему самочувствию, потом расскажу чем можем помочь. Договорились?»
- Дождаться согласия клиента («Да, конечно»)

КРИТЕРИИ ОЦЕНКИ:
90-100: Все действия выполнены, включая программирование с получением согласия
70-89: Представился, подтвердил заявку, спросил про удобство, но без программирования
50-69: Представился и подтвердил заявку, но не перехватил инициативу
30-49: Формальное приветствие без представления клиники или без подтверждения заявки
0-29: Не представился, грубо, или пропустил этап

## БЛОК 2: ВЫЯВЛЕНИЕ БОЛИ + УСИЛЕНИЕ (Этап 2)
Ключевые действия менеджера:
- Спросить ЧТО беспокоит: «Что именно беспокоит? Колено, спина или тазобедренный сустав?»
- Уточнить ХАРАКТЕР боли: «Боль острая или такая ноющая, тянущая? Давно это началось?»
- УСИЛИТЬ боль (показать актуальность): «А в быту это уже мешает? Например, по лестнице подниматься или просто долго ходить пешком сложно стало?»
- Дать клиенту выговориться, проявить эмпатию

КРИТЕРИИ ОЦЕНКИ:
90-100: Все три вопроса (что, характер, влияние на быт) + эмпатия, дал выговориться
70-89: Спросил что болит и уточнил характер, но не усилил боль вопросом про быт
50-69: Только спросил что болит, без уточнений характера и влияния на жизнь
30-49: Не расспросил про боль толком, сразу перешёл к офферу
0-29: Вообще не выявлял потребности, пропустил этап

## БЛОК 3: МОЩНАЯ ПРЕЗЕНТАЦИЯ РЕШЕНИЯ (Этап 3)
Ключевые действия менеджера:
**1. СКЛЕЙКА (эмпатия):**
- «[Имя], спасибо что поделились. Я вас прекрасно понимаю, жить с такой болью и ограничениями действительно тяжело»

**2. ПРЕЗЕНТАЦИЯ КЛИНИКИ:**
- «Наша клиника «Miramed» специализируется именно на безоперационном восстановлении суставов и позвоночника»
- «Чтобы вам не гадать "поможет/не поможет" и не тратить деньги вслепую...»

**3. ОПИСАНИЕ "ЭКСПЕРТНОЙ ДИАГНОСТИКИ" (все 3 компонента!):**
   1) **Консультация врача**: «Это профильный ортопед, который специализируется на сохранении суставов»
   2) **УЗИ двух суставов**: «Больного и здорового. Врач увидит мягкие ткани, связки, воспаление в движении — чего нельзя сделать на рентгене. Сравниваем два сустава чтобы исключить ошибку»
   3) **Бесплатный повторный приём**: «В течение недели — бесплатно. Врач не просто назначит лечение, но и проконтролирует состояние через пару дней. В других клиниках за каждый вход платить, у нас включено»

**4. ЦЕННОСТЬ И ЦЕНА:**
- «Обычно такой комплекс (консультация + 2 УЗИ + повторный осмотр) стоит около 25 000 тенге»
- «Сейчас действуют квоты на первичную диагностику, полная стоимость для вас — 9 900 тенге»
- «Вы получаете честный прогноз — можно ли спасти сустав уколами или пора к хирургу»

**5. ЗАКРЫТИЕ ПРЕЗЕНТАЦИИ:**
- «Согласитесь, начать с такой глубокой диагностики и страховкой в виде бесплатного повторного приёма — разумно?»

КРИТЕРИИ ОЦЕНКИ:
90-100: Полная презентация (склейка + все 3 компонента с деталями + обоснование цены + закрытие)
70-89: Упомянул оффер, цену и основные компоненты, но без деталей (не объяснил зачем УЗИ двух суставов или не упомянул сравнение с обычной ценой 25 000)
50-69: Назвал цену 9 900 и что-то про приём, но не объяснил состав оффера
30-49: Формально упомянул приём без презентации ценности
0-29: Не презентовал оффер вообще

## БЛОК 4: ЗАПИСЬ — ВЫБОР БЕЗ ВЫБОРА (Этап 4)
Ключевые действия менеджера:
- НЕ спрашивать «Хотите записаться?» — это слабо! Сразу предлагать конкретику
- Упомянуть фиксацию условий: «Чтобы закрепить за вами эту специальную цену 9 900 и право на бесплатный повторный приём, нам нужно подобрать время на ближайшие дни»
- Создать выбор без выбора — два варианта: «Есть свободное окошко в среду в первой половине дня (например, в 11:00) и в четверг уже после обеда (в 16:30). Вам когда удобнее?»
- После выбора уточнить конкретное время: «Хорошо, в четверг. Есть 16:30 и 17:15. Какое время за вами забронировать?»

КРИТЕРИИ ОЦЕНКИ:
90-100: Фиксация условий + два варианта времени + уточнение, БЕЗ вопроса «хотите ли»
70-89: Предложил конкретное время (один-два варианта), но с вопросом «хотите записаться?» или без фиксации условий
50-69: Спросил «хотите записаться?» без конкретных вариантов времени
30-49: Не предложил запись явно, ждал инициативы от клиента
0-29: Не дошёл до записи

## БЛОК 5: ОТРАБОТКА ВОЗРАЖЕНИЙ (Этап 5)
Этот блок оценивается ТОЛЬКО если клиент высказал возражения. Если возражений не было → ставь 80 (нейтральная оценка).

Типичные возражения и ЭТАЛОННЫЕ ответы из скрипта:

**1. «Дорого / 9 900 тенге — это много?»**
→ «Давайте посчитаем честно. Если пойдёте к частному врачу, приём 5-7 тысяч. УЗИ двух суставов — еще 8-10 тысяч. Плюс платный повторный приём. Итого ~20 000. У нас всё за 9 900 + экономия на МРТ. Самая выгодная цена в Актобе за такую полную диагностику.»

**2. «Я подумаю / Мне нужно посоветоваться»**
→ «Конечно, решение серьёзное. Только хочу по-человечески предупредить: акция с бесплатным повторным приёмом действует при записи сейчас. Давайте я пока поставлю предварительную бронь на [день] на пару часов? Вы обсудите, если что — напишете и отменим. Хорошо?»

**3. «А вдруг не поможет? / Я уже везде был, ничего не помогает»**
→ «Прекрасно вас понимаю. Именно поэтому зову только на диагностику, не на дорогое лечение вслепую. Врач посмотрит на УЗИ. Если сустав разрушен и нужна операция — честно скажет. Мы берёмся только за случаи где видим прогноз успеха. Вы получите честный ответ: можно спасти или нет.»

**4. «В поликлинике бесплатно можно сделать»**
→ «Согласна, бесплатная медицина есть. Но очереди — ждать талон на УЗИ можно месяц. А боль никуда не денется и может стать хуже. Мы примем уже завтра, без очередей. Чем быстрее диагноз, тем проще и дешевле лечение.»

КРИТЕРИИ ОЦЕНКИ:
90-100: Грамотно отработал все возражения с аргументами максимально близко к скрипту
70-89: Отработал возражения, но не все аргументы из скрипта или своими словами (не по скрипту)
50-69: Попытался ответить, но слабо/формально, без убедительных аргументов
30-49: Проигнорировал возражения или ответил уклончиво
0-29: Сдался при первом возражении, не стал отрабатывать
80: ЕСЛИ ВОЗРАЖЕНИЙ НЕ БЫЛО (нейтральная оценка, не штрафуем)

## БЛОК 6: ФИНАЛИЗАЦИЯ И ЗАВЕРШЕНИЕ (Этап 6)
Ключевые действия менеджера:
**1. Сбор данных:**
- Записать ПОЛНЫЕ ФИО клиента
- Записать дату рождения

**2. Проверка и подтверждение:**
- Проговорить дату и время: «Вы записаны: [дата, день недели] в [время]»
- Проговорить адрес: «Куда подходить: г. Актобе, клиника Miramed, [адрес]»
- Проговорить сумму: «К оплате в клинике: 9 900 тенге (консультация + УЗИ двух суставов + бесплатный повторный осмотр)»

**3. Важные напоминания:**
- «Не забудьте взять удостоверение личности для договора»
- «Подойдите за 10-15 минут до начала приёма, чтобы оформить документы и зайти в кабинет вовремя»

**4. Цифровое сопровождение:**
- «Скажите, у вас на этом номере есть WhatsApp? Я сейчас отправлю точную геолокацию, адрес и памятку»

**5. Закрытие:**
- «Если планы изменятся — предупредите заранее, у нас плотная запись»
- «Ждём вас [день недели] в [время]. Всего доброго!»

КРИТЕРИИ ОЦЕНКИ:
90-100: ФИО + дата рождения + дата/время/адрес/сумма + удостоверение + WhatsApp + напоминание прийти за 10-15 минут
70-89: ФИО + дата/время + адрес + сумма, но без деталей (удостоверение, WhatsApp, время прихода)
50-69: Назвал дату/время, но не записал ФИО или не проговорил адрес/сумму
30-49: Формально закончил («До свидания») без подтверждения данных
0-29: Оборвал разговор без финализации

# ОСОБЫЕ СЛУЧАИ
- Короткий звонок / недозвон / автоответчик / клиент сбросил → call_type: "КОРОТКИЙ", все блоки = 0, total_score = 0
- Сервисный звонок (перезапись, вопрос по текущему лечению, уточнение адреса) → call_type: "СЕРВИСНЫЙ", оценивай адекватно по факту, не все блоки применимы
- Повторный звонок существующему пациенту клиники → call_type: "ПОВТОРНЫЙ"
- Первичный звонок новому лиду → call_type: "ПЕРВИЧНЫЙ" (основной тип)

# ПРАВИЛА ОЦЕНКИ
- total_score = среднее арифметическое 6 блоков (округли до целого)
- is_successful = true ТОЛЬКО если клиент ЗАПИСАЛСЯ на конкретную дату и время
- В explanation пиши КОНКРЕТНО что менеджер сделал/не сделал, цитируй фразы из звонка
- Ссылайся на скрипт: «По скрипту нужно было упомянуть УЗИ двух суставов, но менеджер не объяснил зачем»
- Будь СТРОГИМ но СПРАВЕДЛИВЫМ — если менеджер хорошо отработал, обязательно похвали конкретно
- Если менеджер сказал своими словами то же самое что в скрипте (по смыслу) — это считается выполненным

# ФОРМАТ ОТВЕТА — строго JSON, без markdown`;

  const userPrompt = `Оцени этот звонок:

${dialogText}

Ответь ТОЛЬКО JSON:
{
  "call_type": "ПЕРВИЧНЫЙ|ПОВТОРНЫЙ|СЕРВИСНЫЙ|КОРОТКИЙ",
  "block1_score": число, "block1_explanation": "конкретно что сделал/не сделал",
  "block2_score": число, "block2_explanation": "конкретно что сделал/не сделал",
  "block3_score": число, "block3_explanation": "конкретно что сделал/не сделал",
  "block4_score": число, "block4_explanation": "конкретно что сделал/не сделал",
  "block5_score": число, "block5_explanation": "конкретно что сделал/не сделал",
  "block6_score": число, "block6_explanation": "конкретно что сделал/не сделал",
  "total_score": число,
  "client_info": {
    "facts": ["Факты о клиенте: возраст, имя, если упоминались"],
    "needs": ["Что клиенту нужно"],
    "pains": ["Что болит, как давно, как мешает"],
    "objections": ["Какие возражения были"]
  },
  "ai_summary": "Резюме: что произошло, записался ли клиент, что можно улучшить",
  "is_successful": true/false
}`;

  logger.info('🤖 GPT-4o: analyzing with full script reference...');

  // Используем retry логику для надежности
  const response = await callWithRetry(
    () => axios.post(GOOGLE_PROXY_URL, {
      type: 'chat',
      apiKey: OPENAI_API_KEY,
      model: 'gpt-4o',
      max_tokens: 3000,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    }, { timeout: 180000 }), // Увеличено до 3 минут
    3,
    'analyzeCall'
  );

  // Проверяем валидность ответа
  if (!response?.data?.choices?.length) {
    logger.error('❌ GPT-4o returned invalid response', {
      responseData: response?.data,
      hasChoices: !!response?.data?.choices,
      choicesLength: response?.data?.choices?.length
    });
    throw new Error('Invalid GPT-4o response: no choices array');
  }

  const content = response.data.choices[0].message?.content;
  if (!content) {
    logger.error('❌ GPT-4o message has no content', {
      choice: response.data.choices[0]
    });
    throw new Error('Invalid GPT-4o response: no message content');
  }

  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    logger.error('❌ No JSON found in GPT-4o response', {
      contentPreview: content.substring(0, 500)
    });
    throw new Error('No JSON in analysis response');
  }

  return JSON.parse(match[0]);
}

// ==================== ANALYZE BY ID ====================

async function analyzeCallById(callId) {
  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).single();
  if (!call?.audio_url) throw new Error('No audio');

  logger.info(`🎤 Processing call ${callId}`, {
    callId,
    audioUrl: call.audio_url,
    duration: call.duration,
    direction: call.call_direction || 'incoming'
  });

  const { plain, formatted } = await transcribeAudio(call.audio_url, call.call_direction);
  await supabase.from('calls').update({ transcript: plain, transcript_formatted: formatted }).eq('id', callId);

  const analysis = await analyzeCall(plain, formatted);

  await supabase.from('call_scores').upsert({
    call_id: callId, call_type: analysis.call_type,
    total_score: Math.round(analysis.total_score),
    block1_score: Math.round(analysis.block1_score), block2_score: Math.round(analysis.block2_score),
    block3_score: Math.round(analysis.block3_score), block4_score: Math.round(analysis.block4_score),
    block5_score: Math.round(analysis.block5_score), block6_score: Math.round(analysis.block6_score),
    score_explanations: {
      block1: analysis.block1_explanation, block2: analysis.block2_explanation,
      block3: analysis.block3_explanation, block4: analysis.block4_explanation,
      block5: analysis.block5_explanation, block6: analysis.block6_explanation
    },
    client_info: analysis.client_info, ai_summary: analysis.ai_summary, is_successful: analysis.is_successful
  }, { onConflict: 'call_id' });

  logger.info(`✅ Call ${callId} analyzed`, {
    callId,
    totalScore: analysis.total_score,
    isSuccessful: analysis.is_successful,
    callType: analysis.call_type
  });
  return { transcript: plain, formatted, analysis };
}

// ==================== API ROUTES ====================

app.post('/api/analyze/:callId', async (req, res) => {
  try {
    logger.info(`Starting analysis`, { callId: req.params.callId });
    const result = await analyzeCallById(req.params.callId);
    res.json({ success: true, analysis: result.analysis });
  } catch (error) {
    logger.error(`Analysis failed`, {
      callId: req.params.callId,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/reanalyze/:callId', async (req, res) => {
  try {
    logger.info(`Starting reanalysis`, { callId: req.params.callId });
    await supabase.from('call_scores').delete().eq('call_id', req.params.callId);
    await supabase.from('calls').update({ transcript: null, transcript_formatted: null }).eq('id', req.params.callId);
    const result = await analyzeCallById(req.params.callId);
    res.json({ success: true, analysis: result.analysis });
  } catch (error) {
    logger.error(`Reanalysis failed`, {
      callId: req.params.callId,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/managers', async (req, res) => {
  const { data, error } = await supabase.from('managers').select('*').order('name');
  res.json(error ? { error: error.message } : data);
});

app.get('/api/calls', async (req, res) => {
  try {
    const { data: calls } = await supabase.from('calls').select('*, manager:managers(name)').order('call_date', { ascending: false });
    const { data: scores } = await supabase.from('call_scores').select('*');
    const scoresMap = Object.fromEntries((scores || []).map(s => [s.call_id, s]));
    res.json(calls.map(c => ({ ...c, scores: scoresMap[c.id] || null })));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/calls/:id', async (req, res) => {
  try {
    const { data: call } = await supabase.from('calls').select('*, manager:managers(name)').eq('id', req.params.id).single();
    const { data: scores } = await supabase.from('call_scores').select('*').eq('call_id', req.params.id).single();
    res.json({ ...call, scores });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/whatsapp/chats', (req, res) => res.json({ chats: [], message: 'В разработке' }));
app.get('/api/whatsapp/analyses', (req, res) => res.json({ analyses: [], message: 'В разработке' }));

// ==================== START ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  logger.info(`🏥 CallMind v5.0 (gpt-4o-transcribe) запущен`, {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    ffmpeg: FFMPEG_AVAILABLE,
    pipeline: FFMPEG_AVAILABLE
      ? 'Stereo split → gpt-4o-transcribe×2 (kk) → GPT-4o translate → GPT-4o analyze'
      : 'Mono: gpt-4o-transcribe (kk) → GPT-4o translate+roles → GPT-4o analyze'
  });

  logger.info(`📋 Формат вывода: 2 блока (администратор + пациент), не диалог`);

  // Загружаем токены Bitrix из БД
  if (await loadTokensFromDb()) {
    logger.info('✅ Bitrix tokens loaded from DB');

    // Автоматическая синхронизация каждые 5 минут
    setInterval(() => {
      syncNewCalls().catch(err => {
        logger.error('Sync failed', { error: err.message });
      });
    }, 5 * 60 * 1000);

    // Первая синхронизация через 30 секунд
    setTimeout(() => syncNewCalls(), 30000);
  } else {
    logger.warn('⚠️ Bitrix не авторизован - синхронизация отключена');
  }

  // ==================== KEEP-ALIVE МЕХАНИЗМ ====================
  // Предотвращает засыпание на Railway
  if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) {
    const KEEP_ALIVE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`
      : `http://localhost:${PORT}/health`;

    logger.info('🔄 Keep-alive механизм активирован', { url: KEEP_ALIVE_URL });

    // Пингуем себя каждые 5 минут чтобы Railway не усыпил сервис
    setInterval(async () => {
      try {
        await axios.get(KEEP_ALIVE_URL, { timeout: 10000 });
        logger.debug('✅ Keep-alive ping successful');
      } catch (error) {
        logger.warn('⚠️ Keep-alive ping failed', { error: error.message });
      }
    }, 5 * 60 * 1000); // Каждые 5 минут
  }
});
