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
          attempt,
          // Детали от API (для отладки Yandex)
          responseData: error.response?.data,
          responseHeaders: error.response?.headers
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

// Soniox Speech-to-Text (транскрибация казахского/русского, WER 9%)
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;
const SONIOX_API_URL = 'https://api.soniox.com/v1';

let bitrixTokens = { access_token: null, refresh_token: null };

// In-memory кеш обрабатываемых звонков (защита от дубликатов)
const processingCalls = new Set();

// Проверяем наличие ffmpeg при старте
let FFMPEG_AVAILABLE = false;
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  FFMPEG_AVAILABLE = true;
  logger.info('✅ ffmpeg найден');
} catch (e) {
  logger.warn('⚠️ ffmpeg не найден — разделение каналов недоступно, будет fallback на Soniox моно с диаризацией');
}

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
    message: '🏥 Clinic CallMind API v6.0',
    features: ['bitrix', 'ai-analysis', 'stereo-channel-split', 'soniox-stt', 'dialog-format'],
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
      soniox: !!process.env.SONIOX_API_KEY,
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
//  ТРАНСКРИБАЦИЯ v6.0 (Soniox)
//
//  Soniox STT: WER 9% на казахском (лучший в мире)
//  Встроенная диаризация + перевод каз→рус + word timestamps
//  Заменяет: Yandex SpeechKit + GPT-4o перевод
//
//  ФОРМАТ ВЫВОДА v6.0: Чередующиеся реплики [{role, text}, ...]
//  Вместо двух блоков текста — полноценный диалог по ролям
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

// ====================================================================
//  SONIOX SPEECH-TO-TEXT API v6.0
//
//  Soniox: WER 9% на казахском (лучший в мире), $0.10/час
//  Встроенная диаризация + перевод каз→рус + word timestamps
//  Заменяет: Yandex SpeechKit + GPT-4o перевод
// ====================================================================

/**
 * Soniox: загрузка аудиофайла
 * POST /v1/files (multipart/form-data)
 * @param {Buffer} audioBuffer - аудио файл (WAV или MP3)
 * @param {string} fileName - имя файла
 * @returns {string} fileId - идентификатор файла на Soniox
 */
async function sonioxUploadFile(audioBuffer, fileName) {
  const FormData = require('form-data');
  const formData = new FormData();
  formData.append('file', audioBuffer, { filename: fileName });

  const response = await callWithRetry(
    () => axios.post(`${SONIOX_API_URL}/files`, formData, {
      headers: {
        ...formData.getHeaders(),
        'Authorization': `Bearer ${SONIOX_API_KEY}`
      },
      timeout: 120000 // 2 минуты на загрузку
    }),
    3,
    `sonioxUpload[${fileName}]`
  );

  const fileId = response.data.id;
  logger.info(`Soniox файл загружен: ${fileId}`, { fileName, size: audioBuffer.length });
  return fileId;
}

/**
 * Soniox: создание задачи транскрибации
 * POST /v1/transcriptions
 * @param {string} fileId - ID файла на Soniox
 * @param {boolean} useDiarization - включить диаризацию (для моно)
 * @returns {string} transcriptionId
 */
async function sonioxCreateTranscription(fileId, useDiarization) {
  const params = {
    model: 'stt-async-preview',
    file_id: fileId,
    // Казахский и русский — основные языки клиники
    language_hints: ['kk', 'ru'],
    enable_language_identification: true,
    // Встроенный перевод каз→рус (заменяет GPT-4o перевод)
    translation: { type: 'one_way', target_language: 'ru' },
    // Контекст клиники для повышения точности распознавания
    context: {
      terms: [
        'Мирамед', 'УЗИ', 'сустав', 'суставы', 'позвоночник',
        'диагностика', 'колено', 'поясница', 'артроз', 'грыжа',
        'PRP', 'блокада', 'гиалуроновая', 'консультация',
        'девять тысяч девятьсот', '9900', 'тенге'
      ],
      translation_terms: [
        { source: 'буын', target: 'сустав' },
        { source: 'омыртқа', target: 'позвоночник' },
        { source: 'бел', target: 'поясница' },
        { source: 'тізе', target: 'колено' },
        { source: 'ауырады', target: 'болит' },
        { source: 'дәрігер', target: 'врач' },
        { source: 'тексеру', target: 'обследование' },
        { source: 'емдеу', target: 'лечение' },
        { source: 'жазылу', target: 'записаться' },
        { source: 'қанша тұрады', target: 'сколько стоит' },
        { source: 'Мейрамед', target: 'Мирамед' }
      ]
    }
  };

  // Диаризация только для моно (для стерео каналы уже разделены)
  if (useDiarization) {
    params.enable_speaker_diarization = true;
  }

  const response = await callWithRetry(
    () => axios.post(`${SONIOX_API_URL}/transcriptions`, params, {
      headers: {
        'Authorization': `Bearer ${SONIOX_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }),
    3,
    'sonioxCreateTranscription'
  );

  const transcriptionId = response.data.id;
  logger.info(`Soniox задача создана: ${transcriptionId}`, { fileId, useDiarization });
  return transcriptionId;
}

/**
 * Soniox: ожидание завершения транскрибации (polling)
 * GET /v1/transcriptions/{id} каждые 3 секунды
 * @param {string} transcriptionId - ID задачи
 * @param {number} maxWaitMs - максимальное время ожидания (по умолчанию 5 минут)
 */
async function sonioxWaitForCompletion(transcriptionId, maxWaitMs = 300000) {
  const startTime = Date.now();
  const POLL_INTERVAL = 3000; // Проверяем каждые 3 секунды

  while (Date.now() - startTime < maxWaitMs) {
    const response = await axios.get(
      `${SONIOX_API_URL}/transcriptions/${transcriptionId}`,
      {
        headers: { 'Authorization': `Bearer ${SONIOX_API_KEY}` },
        timeout: 10000
      }
    );

    const status = response.data.status;
    logger.debug(`Soniox статус: ${status}`, { transcriptionId });

    if (status === 'completed') {
      logger.info(`Soniox транскрибация завершена`, {
        transcriptionId,
        durationMs: Date.now() - startTime,
        audioDurationMs: response.data.audio_duration_ms
      });
      return;
    }

    if (status === 'error') {
      throw new Error(`Soniox ошибка: ${response.data.error_type} - ${response.data.error_message}`);
    }

    // queued или processing — ждем
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }

  throw new Error(`Soniox timeout: транскрибация не завершилась за ${maxWaitMs / 1000} сек`);
}

/**
 * Soniox: получение результата транскрибации
 * GET /v1/transcriptions/{id}/transcript
 * @param {string} transcriptionId - ID задачи
 * @returns {Array} массив токенов [{text, start_ms, end_ms, speaker, language, translation_status, confidence}]
 */
async function sonioxGetTranscript(transcriptionId) {
  const response = await axios.get(
    `${SONIOX_API_URL}/transcriptions/${transcriptionId}/transcript`,
    {
      headers: { 'Authorization': `Bearer ${SONIOX_API_KEY}` },
      timeout: 30000
    }
  );

  const tokens = response.data.tokens || [];
  logger.info(`Soniox транскрипт: ${tokens.length} токенов`, { transcriptionId });
  return tokens;
}

/**
 * Soniox: удаление файла (очистка после обработки)
 * DELETE /v1/files/{file_id}
 * @param {string} fileId - ID файла
 */
async function sonioxDeleteFile(fileId) {
  try {
    await axios.delete(`${SONIOX_API_URL}/files/${fileId}`, {
      headers: { 'Authorization': `Bearer ${SONIOX_API_KEY}` },
      timeout: 10000
    });
    logger.debug(`Soniox файл удален: ${fileId}`);
  } catch (error) {
    // Не критично — не блокируем основной pipeline
    logger.warn(`Soniox не удалось удалить файл ${fileId}`, { error: error.message });
  }
}

// ====================================================================
//  ОБРАБОТКА ТОКЕНОВ SONIOX
//
//  Токены от Soniox содержат: text, start_ms, end_ms, speaker,
//  language, translation_status, confidence
//  Нужно: сгруппировать в реплики по паузам и merge по таймкодам
// ====================================================================

/**
 * Группировка токенов одного канала в реплики по паузам
 *
 * Если между токенами пауза > порога — это разные реплики.
 * Фильтрует: берёт переведённые + русские оригиналы, пропускает казахские оригиналы.
 *
 * @param {Array} tokens - токены от Soniox [{text, start_ms, end_ms, language, translation_status}]
 * @param {string} role - 'manager' или 'client'
 * @param {number} pauseThresholdMs - порог паузы в мс (по умолчанию 1500)
 * @returns {Array} реплики [{role, text, start_ms, end_ms}]
 */
function groupTokensIntoReplicas(tokens, role, pauseThresholdMs = 1500) {
  if (!tokens || tokens.length === 0) return [];

  // Берём только переведённые токены или русские оригиналы
  // Пропускаем оригиналы казахского (они дублируются переводом)
  const filtered = tokens.filter(t => {
    if (t.language === 'kk' && t.translation_status === 'original') return false;
    return true;
  });

  if (filtered.length === 0) return [];

  const replicas = [];
  let currentWords = [filtered[0].text];
  let currentStartMs = filtered[0].start_ms;
  let currentEndMs = filtered[0].end_ms;

  for (let i = 1; i < filtered.length; i++) {
    const prevEnd = filtered[i - 1].end_ms;
    const currStart = filtered[i].start_ms;
    const pause = currStart - prevEnd;

    if (pause > pauseThresholdMs) {
      // Пауза — сохраняем реплику и начинаем новую
      const text = currentWords.join('').trim();
      if (text) {
        replicas.push({ role, text, start_ms: currentStartMs, end_ms: currentEndMs });
      }
      currentWords = [filtered[i].text];
      currentStartMs = filtered[i].start_ms;
    } else {
      currentWords.push(filtered[i].text);
    }
    currentEndMs = filtered[i].end_ms;
  }

  // Последняя реплика
  const lastText = currentWords.join('').trim();
  if (lastText) {
    replicas.push({ role, text: lastText, start_ms: currentStartMs, end_ms: currentEndMs });
  }

  logger.info(`Сгруппировано ${filtered.length} токенов → ${replicas.length} реплик [${role}]`);
  return replicas;
}

/**
 * Merge реплик из двух каналов в чередующийся диалог по таймкодам
 *
 * @param {Array} managerReplicas - реплики менеджера [{role, text, start_ms, end_ms}]
 * @param {Array} clientReplicas - реплики клиента [{role, text, start_ms, end_ms}]
 * @returns {Array} диалог [{role, text}]
 */
function mergeChannelReplicas(managerReplicas, clientReplicas) {
  // Объединяем и сортируем по start_ms
  const all = [...managerReplicas, ...clientReplicas];
  all.sort((a, b) => a.start_ms - b.start_ms);

  // Убираем start_ms/end_ms — фронтенд ожидает [{role, text}]
  const dialog = all.map(r => ({ role: r.role, text: r.text }));

  logger.info(`Merge диалог: ${dialog.length} реплик`, {
    manager: managerReplicas.length,
    client: clientReplicas.length
  });

  return dialog;
}

/**
 * Soniox: полный pipeline для одного аудио-канала (стерео режим)
 * Загрузка → Транскрибация+Перевод → Polling → Результат → Очистка
 *
 * @param {Buffer} audioBuffer - WAV аудио одного канала
 * @param {string} channelName - 'администратор' или 'пациент' (для логов)
 * @returns {Array} токены от Soniox
 */
async function transcribeChannelWithSoniox(audioBuffer, channelName) {
  const fileName = `channel_${channelName}_${Date.now()}.wav`;
  let fileId = null;

  try {
    logger.info(`Soniox [${channelName}]: загрузка файла...`, { size: audioBuffer.length });
    fileId = await sonioxUploadFile(audioBuffer, fileName);

    // БЕЗ диаризации — канал уже содержит одного спикера
    logger.info(`Soniox [${channelName}]: запуск транскрибации...`);
    const transcriptionId = await sonioxCreateTranscription(fileId, false);

    logger.info(`Soniox [${channelName}]: ожидание результата...`);
    await sonioxWaitForCompletion(transcriptionId);

    const tokens = await sonioxGetTranscript(transcriptionId);
    logger.info(`Soniox [${channelName}]: получено ${tokens.length} токенов`);
    return tokens;
  } finally {
    // Удаляем файл (не блокируем pipeline)
    if (fileId) sonioxDeleteFile(fileId);
  }
}

/**
 * Soniox: полный pipeline для моно-аудио (с диаризацией)
 *
 * @param {Buffer} audioBuffer - MP3 или WAV аудио
 * @returns {Array} токены от Soniox (с полем speaker)
 */
async function transcribeMonoWithSoniox(audioBuffer) {
  const fileName = `mono_${Date.now()}.mp3`;
  let fileId = null;

  try {
    logger.info('Soniox [моно]: загрузка файла...', { size: audioBuffer.length });
    fileId = await sonioxUploadFile(audioBuffer, fileName);

    // С диаризацией — определяем спикеров автоматически
    logger.info('Soniox [моно]: запуск транскрибации с диаризацией...');
    const transcriptionId = await sonioxCreateTranscription(fileId, true);

    logger.info('Soniox [моно]: ожидание результата...');
    await sonioxWaitForCompletion(transcriptionId);

    const tokens = await sonioxGetTranscript(transcriptionId);
    logger.info(`Soniox [моно]: получено ${tokens.length} токенов`);
    return tokens;
  } finally {
    if (fileId) sonioxDeleteFile(fileId);
  }
}

/**
 * Группировка моно-токенов в диалог по speaker + паузы
 *
 * Soniox назначает speaker: "1", "2" и т.д.
 * Первый speaker = admin (поднимает трубку / звонит)
 *
 * @param {Array} tokens - токены с полем speaker
 * @param {string} callDirection - 'incoming' или 'outgoing'
 * @returns {Array} диалог [{role, text}]
 */
function groupMonoTokensIntoDialog(tokens, callDirection) {
  if (!tokens || tokens.length === 0) return [];

  // Фильтруем: только переведённые + русские оригиналы
  const filtered = tokens.filter(t => {
    if (t.language === 'kk' && t.translation_status === 'original') return false;
    return true;
  });

  if (filtered.length === 0) return [];

  // Первый speaker = admin (обычно admin начинает разговор)
  const firstSpeaker = filtered[0].speaker || '1';
  const speakerRoleMap = {};
  speakerRoleMap[firstSpeaker] = 'manager';

  // Группируем по смене speaker или по паузам
  const PAUSE_THRESHOLD = 1500;
  const replicas = [];
  let currentWords = [filtered[0].text];
  let currentSpeaker = filtered[0].speaker || '1';
  let currentStartMs = filtered[0].start_ms;

  for (let i = 1; i < filtered.length; i++) {
    const token = filtered[i];
    const prevToken = filtered[i - 1];
    const speaker = token.speaker || '1';
    const pause = token.start_ms - prevToken.end_ms;

    // Новая реплика при смене speaker или длинной паузе
    if (speaker !== currentSpeaker || pause > PAUSE_THRESHOLD) {
      const text = currentWords.join('').trim();
      if (text) {
        if (!speakerRoleMap[currentSpeaker]) {
          speakerRoleMap[currentSpeaker] = 'client';
        }
        replicas.push({ role: speakerRoleMap[currentSpeaker], text, start_ms: currentStartMs });
      }
      currentWords = [token.text];
      currentSpeaker = speaker;
      currentStartMs = token.start_ms;
    } else {
      currentWords.push(token.text);
    }
  }

  // Последняя реплика
  const lastText = currentWords.join('').trim();
  if (lastText) {
    if (!speakerRoleMap[currentSpeaker]) {
      speakerRoleMap[currentSpeaker] = 'client';
    }
    replicas.push({ role: speakerRoleMap[currentSpeaker], text: lastText, start_ms: currentStartMs });
  }

  // Сортируем и убираем start_ms
  replicas.sort((a, b) => a.start_ms - b.start_ms);
  const dialog = replicas.map(r => ({ role: r.role, text: r.text }));

  logger.info(`Моно-диалог: ${dialog.length} реплик`, {
    speakers: Object.keys(speakerRoleMap).length
  });

  return dialog;
}

// ====================================================================
//  ГЛАВНАЯ ФУНКЦИЯ ТРАНСКРИБАЦИИ v6.0 (Soniox)
//
//  Pipeline:
//    СТЕРЕО: ffmpeg split → Soniox ×2 (транскрибация+перевод) → merge → диалог
//    МОНО: Soniox (транскрибация+перевод+диаризация) → диалог
//
//  Вывод: formatted = [{role: 'manager', text: 'реплика'}, {role: 'client', text: 'реплика'}, ...]
//  Чередующиеся реплики с ролями (настоящий диалог!)
// ====================================================================

async function transcribeAudio(audioUrl, callDirection = 'incoming') {
  try {
    logger.info('Скачиваю аудио...', { url: audioUrl, direction: callDirection });
    const audioResponse = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 180000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const audioBuffer = Buffer.from(audioResponse.data);
    logger.info(`Аудио скачано: ${audioBuffer.length} байт`);

    // ========== СТЕРЕО РЕЖИМ (основной) ==========
    if (FFMPEG_AVAILABLE) {
      try {
        const channels = splitStereoChannels(audioBuffer, callDirection);

        if (channels) {
          logger.info('Стерео режим: Soniox ×2 каналов');

          // Параллельная транскрибация двух каналов через Soniox
          const [managerTokens, clientTokens] = await Promise.all([
            transcribeChannelWithSoniox(channels.manager, 'администратор'),
            transcribeChannelWithSoniox(channels.client, 'пациент')
          ]);

          // Группируем токены в реплики по паузам
          const managerReplicas = groupTokensIntoReplicas(managerTokens, 'manager');
          const clientReplicas = groupTokensIntoReplicas(clientTokens, 'client');

          // Merge в чередующийся диалог по таймкодам
          const formatted = mergeChannelReplicas(managerReplicas, clientReplicas);

          if (formatted.length === 0) {
            return { plain: '', formatted: [] };
          }

          const plain = formatted.map(r => r.text).join(' ');
          logger.info(`Стерео pipeline v6.0 done: ${formatted.length} реплик`);
          return { plain, formatted };
        }
      } catch (e) {
        logger.warn('Стерео failed, fallback на моно', { error: e.message });
      }
    }

    // ========== МОНО FALLBACK ==========
    // Soniox принимает MP3 напрямую — не нужна конвертация в WAV
    logger.info('Моно режим: Soniox с диаризацией');

    const monoTokens = await transcribeMonoWithSoniox(audioBuffer);

    // Группируем по speaker + паузы → чередующийся диалог
    const formatted = groupMonoTokensIntoDialog(monoTokens, callDirection);

    if (formatted.length === 0) {
      return { plain: '', formatted: [] };
    }

    const plain = formatted.map(r => r.text).join(' ');
    logger.info(`Моно pipeline v6.0 done: ${formatted.length} реплик`);
    return { plain, formatted };

  } catch (error) {
    logger.error('Ошибка транскрибации', {
      error: error.message,
      stack: error.stack,
      audioUrl
    });
    throw new Error(`Ошибка транскрибации: ${error.message}`);
  }
}

// ==================== ИИ АНАЛИЗ ====================
// Скрипт анализа можно менять через UI (страница "Скрипт")

// Дефолтный скрипт анализа (используется если в БД нет кастомного)
const DEFAULT_ANALYSIS_SCRIPT = `Ты — Виртуальный РОП клиники Miramed (Актобе, Казахстан). Оффер: консультация+УЗИ 2 суставов+повтор=9900₸ (обычно 25000₸).

ЦЕЛЬ: Конверсия. Жестко штрафуй "справочное бюро", поощряй дожим.

🔴 КРИТИЧЕСКИЕ ОШИБКИ (AUTO-FAIL = total_score: 0):
1. Запись пациента со СВЕЖЕЙ ТРАВМОЙ (перелом/отек вчера/сегодня) → должен отказать и направить в травмпункт
2. Грубость/конфликт (повышение голоса, сарказм, перебивание)
3. СЛИВ ИНИЦИАТИВЫ: Клиент спросил цену → Менеджер ответил цифру → Пауза → Клиент "спасибо" → Менеджер попрощался (это ЗАПРЕЩЕНО!)

АЛГОРИТМ ПРОДАЖИ (0-100):

ЭТАП 1 - ПРОГРАММИРОВАНИЕ И БОЛЬ (20%):
- Перехват: "Чтобы подобрать врача, позвольте уточню пару моментов?"
- Квалификация: Что болит? Характер боли? Как мешает жизни?

ЭТАП 2 - ПРЕЗЕНТАЦИЯ ЦЕННОСТИ (30%):
- Вилка цен: "Обычно 25000, сейчас по акции 9900"
- Наполнение: УЗИ ДВУХ суставов (сравнение больного и здорового)
- Бонус: Повторный прием бесплатный/включен
- Экспертность: Безоперационные методы, честный прогноз

ЭТАП 3 - ДОЖИМ И ЗАПИСЬ (40%) — КЛЮЧЕВОЙ:
- Выбор без выбора: "Среда утром или четверг вечером?" (НЕ "хотите записаться?")
- Обработка "подумаю": Бронь, аргумент дефицита/боли
- Обработка "дорого": Сравнение с МРТ/частными кабинетами

ЭТАП 4 - ОРГАНИЗАЦИЯ (10%):
- ФИО + дата рождения
- Локация/карта WhatsApp
- Напоминание про удостоверение

FEW-SHOT:
❌ ПЛОХО (0%): Клиент: "Сколько?" Менеджер: "9900" Клиент: "Подумаю" Менеджер: "Хорошо, звоните"
✅ ХОРОШО (100%): Клиент: "Дорого 9900" Менеджер: "Если делать УЗИ+врач отдельно, выйдет 20-25т. Здесь за 9900 полный комплекс. Четверг удобно?"

ТИПЫ: ПЕРВИЧНЫЙ|ПОВТОРНЫЙ|СЕРВИСНЫЙ|КОРОТКИЙ
is_successful=true ТОЛЬКО если клиент ЗАПИСАЛСЯ на дату

В explanation цитируй фразы, будь жестким к пассивности.`;

// Загрузка скрипта анализа из Supabase (или дефолтный если нет в БД)
async function getAnalysisScript() {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'analysis_script').single();
    if (data?.value) {
      const parsed = JSON.parse(data.value);
      if (parsed.script && parsed.script.trim().length > 0) {
        logger.info('📋 Используем кастомный скрипт анализа из БД');
        return parsed.script;
      }
    }
  } catch (err) {
    // Нет записи в БД — используем дефолтный
  }
  logger.info('📋 Используем дефолтный скрипт анализа');
  return DEFAULT_ANALYSIS_SCRIPT;
}

async function analyzeCall(transcript, formatted) {
  const dialogText = formatted?.length
    ? formatted.map(r => `${r.role === 'manager' ? 'АДМИНИСТРАТОР' : 'ПАЦИЕНТ'}: ${r.text}`).join('\n')
    : transcript;

  // Загружаем скрипт из БД (или дефолтный)
  const systemPrompt = await getAnalysisScript();

  const userPrompt = `Оцени звонок:

${dialogText}

JSON (СТРОГО):
{
  "call_type": "ПЕРВИЧНЫЙ|ПОВТОРНЫЙ|СЕРВИСНЫЙ|КОРОТКИЙ",
  "has_critical_error": false,
  "critical_error_type": "нет|свежая_травма|грубость|слив_инициативы",
  "block1_score": число, "block1_explanation": "ЭТАП 1 (20%): что сделал/не сделал, цитаты",
  "block2_score": число, "block2_explanation": "ЭТАП 2 (30%): вилка цен? УЗИ 2? бонус? цитаты",
  "block3_score": число, "block3_explanation": "ЭТАП 3 (40%): выбор без выбора? обработка возражений? цитаты",
  "block4_score": число, "block4_explanation": "ЭТАП 4 (10%): ФИО? локация? удостоверение?",
  "block5_score": 0, "block5_explanation": "не используется",
  "block6_score": 0, "block6_explanation": "не используется",
  "total_score": число,
  "client_info": {
    "facts": ["имя, возраст если есть"],
    "needs": ["что нужно"],
    "pains": ["что болит, как давно, как мешает"],
    "objections": ["возражения"]
  },
  "ai_summary": "Резюме РОПа: записался? главная ошибка? что улучшить?",
  "is_successful": true/false
}

ЕСЛИ КРИТИЧЕСКАЯ ОШИБКА → has_critical_error=true, total_score=0, все блоки=0`;

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
  // Защита от параллельной обработки одного звонка
  if (processingCalls.has(callId)) {
    logger.warn(`⚠️ Call ${callId} уже обрабатывается, пропускаем дубликат`);
    throw new Error(`Call ${callId} is already being processed`);
  }

  // Добавляем в список обрабатываемых
  processingCalls.add(callId);

  try {
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
  } finally {
    // Обязательно удаляем из списка после завершения (успех или ошибка)
    processingCalls.delete(callId);
  }
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

// ==================== СКРИПТ АНАЛИЗА ====================

// Получить текущий скрипт (из БД или дефолтный)
app.get('/api/script', async (req, res) => {
  try {
    const script = await getAnalysisScript();
    const isDefault = script === DEFAULT_ANALYSIS_SCRIPT;
    res.json({ script, isDefault });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Сохранить кастомный скрипт
app.post('/api/script', async (req, res) => {
  try {
    const { script } = req.body;
    if (!script || script.trim().length < 10) {
      return res.status(400).json({ error: 'Скрипт слишком короткий' });
    }
    await supabase.from('settings').upsert({
      key: 'analysis_script',
      value: JSON.stringify({ script: script.trim() }),
      updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
    logger.info('📋 Скрипт анализа обновлён через UI');
    res.json({ success: true, message: 'Скрипт сохранён' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Сбросить скрипт к дефолтному
app.post('/api/script/reset', async (req, res) => {
  try {
    await supabase.from('settings').delete().eq('key', 'analysis_script');
    logger.info('📋 Скрипт анализа сброшен к дефолтному');
    res.json({ success: true, script: DEFAULT_ANALYSIS_SCRIPT });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/whatsapp/chats', (req, res) => res.json({ chats: [], message: 'В разработке' }));
app.get('/api/whatsapp/analyses', (req, res) => res.json({ analyses: [], message: 'В разработке' }));

// ==================== START ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  logger.info(`🏥 CallMind v6.0 (Soniox STT) запущен`, {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    ffmpeg: FFMPEG_AVAILABLE,
    soniox: !!SONIOX_API_KEY,
    pipeline: FFMPEG_AVAILABLE
      ? 'Stereo split → Soniox ×2 (kk/ru + translate) → merge by timestamps → GPT-4o analyze'
      : 'Mono: Soniox (kk/ru + diarization + translate) → GPT-4o analyze'
  });

  logger.info(`📋 Формат вывода: чередующиеся реплики по ролям (диалог)`);

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
