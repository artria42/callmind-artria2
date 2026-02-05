const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  console.log('✅ ffmpeg найден');
} catch (e) {
  console.log('⚠️ ffmpeg не найден — разделение каналов недоступно, будет fallback на GPT-4o');
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
  } catch (e) {
    console.error('Error saving tokens:', e.message);
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
      const { data: existing } = await supabase.from('calls').select('id, audio_url').eq('bitrix_call_id', call.ID).single();
      if (existing) {
        if (!existing.audio_url && call.CALL_RECORD_URL) {
          await supabase.from('calls').update({ audio_url: call.CALL_RECORD_URL }).eq('id', existing.id);
          const { data: score } = await supabase.from('call_scores').select('id').eq('call_id', existing.id).single();
          if (!score) analyzeCallById(existing.id).catch(e => console.error(e.message));
        }
        continue;
      }
      const { data: manager } = await supabase.from('managers').select('id').eq('bitrix_id', call.PORTAL_USER_ID).single();
      const { data: newCall } = await supabase.from('calls').insert({
        bitrix_call_id: call.ID, manager_id: manager?.id, client_name: call.PHONE_NUMBER,
        duration: parseInt(call.CALL_DURATION) || 0, call_date: call.CALL_START_DATE,
        audio_url: call.CALL_RECORD_URL || null,
        crm_link: call.CRM_ENTITY_ID ? `https://${BITRIX_DOMAIN}/crm/${(call.CRM_ENTITY_TYPE || 'contact').toLowerCase()}/details/${call.CRM_ENTITY_ID}/` : null
      }).select().single();
      if (newCall?.audio_url) analyzeCallById(newCall.id).catch(e => console.error(e.message));
    }
  } catch (e) { console.error('Sync error:', e.message); }
}

app.get('/api/bitrix/calls', async (req, res) => {
  try {
    const calls = await callBitrixMethod('voximplant.statistic.get', {
      FILTER: { '>CALL_START_DATE': new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
      SORT: 'CALL_START_DATE', ORDER: 'DESC'
    });
    for (const call of calls || []) {
      const { data: manager } = await supabase.from('managers').select('id').eq('bitrix_id', call.PORTAL_USER_ID).single();
      await supabase.from('calls').upsert({
        bitrix_call_id: call.ID, manager_id: manager?.id, client_name: call.PHONE_NUMBER,
        duration: parseInt(call.CALL_DURATION) || 0, call_date: call.CALL_START_DATE,
        audio_url: call.CALL_RECORD_URL || null,
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
//  ФОРМАТ ВЫВОДА: 2 блока (manager + client), НЕ диалог по репликам
//  Это надёжнее — GPT не путает роли и не выдумывает чередование
// ====================================================================

/**
 * Разделяет стерео MP3 на два моно-канала через ffmpeg
 * L (левый) = пациент, R (правый) = администратор
 */
function splitStereoChannels(audioBuffer) {
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
      console.log('⚠️ Аудио моно — разделение невозможно');
      return null;
    }

    // Конвертируем в WAV 16kHz PCM — лучше качество для gpt-4o-transcribe
    execSync(`ffmpeg -y -i "${inputPath}" -af "pan=mono|c0=c0" -ar 16000 -ac 1 -f wav "${leftPath}"`, { stdio: 'ignore' });
    execSync(`ffmpeg -y -i "${inputPath}" -af "pan=mono|c0=c1" -ar 16000 -ac 1 -f wav "${rightPath}"`, { stdio: 'ignore' });

    const leftBuffer = fs.readFileSync(leftPath);
    const rightBuffer = fs.readFileSync(rightPath);

    console.log(`✅ Каналы разделены (WAV 16kHz): L(пациент)=${leftBuffer.length}b, R(админ)=${rightBuffer.length}b`);
    return { client: leftBuffer, manager: rightBuffer };
  } finally {
    try { fs.unlinkSync(inputPath); } catch (e) {}
    try { fs.unlinkSync(leftPath); } catch (e) {}
    try { fs.unlinkSync(rightPath); } catch (e) {}
  }
}

/**
 * gpt-4o-transcribe: транскрибация одного канала
 *
 * Почему НЕ whisper-1:
 * - whisper-1 на казахском выдаёт "Аллаға сауын атып" вместо "Алло"
 * - gpt-4o-transcribe имеет WER на 7% ниже на казахском
 * - Лучше понимает code-switching (каз+рус в одном предложении)
 *
 * Формат: json (text only) — segments недоступны в gpt-4o-transcribe
 */
async function transcribeChannel(audioBuffer, channelName) {
  console.log(`🎤 gpt-4o-transcribe [${channelName}] → OpenAI (language=kk)...`);

  const FormData = require('form-data');
  const formData = new FormData();
  // WAV лучше чем MP3 для точности распознавания
  formData.append('file', audioBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
  formData.append('model', 'gpt-4o-transcribe');
  formData.append('language', 'kk');
  formData.append('response_format', 'json');
  formData.append('prompt', WHISPER_PROMPT_KK);

  const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, ...formData.getHeaders() },
    timeout: 180000
  });

  const text = (response.data.text || '').trim();
  console.log(`✅ gpt-4o-transcribe [${channelName}]: ${text.length} chars`);
  return text;
}

/**
 * GPT-4o: Перевод двух каналов → два полотна русского текста
 *
 * Формат: { manager: "полный текст админа", client: "полный текст пациента" }
 * НЕ пытаемся нарезать на реплики — это ненадёжно на мусорном входе
 */
async function repairAndTranslate(adminRawText, clientRawText) {
  console.log('\n' + '='.repeat(60));
  console.log('📝 СЫРОЙ ТЕКСТ ОТ gpt-4o-transcribe (до перевода):');
  console.log('='.repeat(60));
  console.log('\n[АДМИН]:', adminRawText.substring(0, 500));
  console.log('\n[ПАЦИЕНТ]:', clientRawText.substring(0, 500));
  console.log('='.repeat(60) + '\n');

  if (!adminRawText.trim() && !clientRawText.trim()) {
    return { manager: '', client: '' };
  }

  const systemPrompt = `# РОЛЬ
Ты — переводчик медицинских звонков казахский/русский → чистый русский.

# КОНТЕКСТ
Звонок в клинику "Мирамед" (Актобе). Лечение суставов, позвоночника.
Диагностика 9 900 тенге. Язык: казахский, русский, или микс.
У тебя ДВА КАНАЛА — администратор и пациент, записаны раздельно.

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
хабарласып тұрмын=звоню вам, қабарлас=слушаю

# ПРАВИЛА
1. Прочитай ОБА канала → пойми общий контекст
2. Переведи КАЖДЫЙ канал на чистый русский ОТДЕЛЬНО
3. Переводи ДОСЛОВНО — не добавляй отсебятины, не выдумывай
4. Если что-то непонятно — переведи как понял, но НЕ выдумывай
5. Исправляй очевидные ошибки распознавания по контексту
6. Повторы убирай

# ФОРМАТ ОТВЕТА — строго JSON, без markdown:
{
  "manager": "Полный переведённый текст администратора одним блоком",
  "client": "Полный переведённый текст пациента одним блоком"
}`;

  const userPrompt = `КАНАЛ АДМИНИСТРАТОРА (сырой):
${adminRawText}

КАНАЛ ПАЦИЕНТА (сырой):
${clientRawText}`;

  console.log('🧠 GPT-4o: перевод двух каналов...');

  const response = await axios.post(GOOGLE_PROXY_URL, {
    type: 'chat',
    apiKey: OPENAI_API_KEY,
    model: 'gpt-4o',
    max_tokens: 4000,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  }, { timeout: 120000 });

  const content = response.data.choices[0].message.content.trim();
  let result;
  try {
    const clean = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    result = JSON.parse(clean);
  } catch (e) {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      result = JSON.parse(match[0]);
    } else {
      console.error('⚠️ GPT не вернул JSON, fallback');
      result = { manager: adminRawText, client: clientRawText };
    }
  }

  const managerText = (result.manager || result.admin || '').trim();
  const clientText = (result.client || result.patient || '').trim();

  console.log(`✅ Перевод done: manager=${managerText.length}ch, client=${clientText.length}ch`);
  return { manager: managerText, client: clientText };
}

/**
 * GPT-4o: Перевод моно-аудио (оба голоса в одном канале)
 */
async function repairAndTranslateMono(rawText) {
  if (!rawText || rawText.trim().length < 15) {
    return { manager: rawText || '', client: '' };
  }

  const systemPrompt = `# РОЛЬ
Ты — переводчик медицинских звонков казахский/русский → чистый русский.

# КОНТЕКСТ
Телефонный разговор клиники "Мирамед" (Актобе). Оба голоса в одном аудио (моно).
Клиника лечит суставы и позвоночник. Диагностика 9 900 тенге.

# МЕДИЦИНСКИЙ СЛОВАРЬ
буын=сустав, омыртқа=позвоночник, бел=поясница, тізе=колено, мойын=шея
иық=плечо, аяқ=нога, ауырады=болит, қатты ауырады=сильно болит
ісінді=отекло, дәрігер=врач, емхана=клиника, тексеру=обследование
емдеу=лечение, зейнетақы=пенсия, жүргенде=при ходьбе, түнде=ночью

# ОПРЕДЕЛЕНИЕ РОЛЕЙ
АДМИНИСТРАТОР: приветствует, задаёт вопросы о боли, предлагает запись
ПАЦИЕНТ: описывает симптомы, спрашивает цену, рассказывает историю

# ПРАВИЛА
1. Переведи на русский
2. Раздели на два блока: что сказал админ и что сказал пациент
3. Переводи ДОСЛОВНО, не выдумывай

# ФОРМАТ — строго JSON:
{
  "manager": "Всё что сказал администратор, одним блоком",
  "client": "Всё что сказал пациент, одним блоком"
}`;

  console.log('🧠 GPT-4o: перевод моно...');

  const response = await axios.post(GOOGLE_PROXY_URL, {
    type: 'chat',
    apiKey: OPENAI_API_KEY,
    model: 'gpt-4o',
    max_tokens: 4000,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `ТРАНСКРИПТ:\n${rawText}` }
    ]
  }, { timeout: 120000 });

  const content = response.data.choices[0].message.content.trim();
  let result;
  try {
    const clean = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    result = JSON.parse(clean);
  } catch (e) {
    const match = content.match(/\{[\s\S]*\}/);
    result = match ? JSON.parse(match[0]) : { manager: rawText, client: '' };
  }

  return {
    manager: (result.manager || result.admin || '').trim(),
    client: (result.client || result.patient || '').trim()
  };
}

// ====================================================================
//  ГЛАВНАЯ ФУНКЦИЯ ТРАНСКРИБАЦИИ v5.0
//
//  Pipeline: gpt-4o-transcribe (каждый канал) → GPT-4o (перевод)
//  Вывод: formatted = [{ role: 'manager', text: '...' }, { role: 'client', text: '...' }]
//  Два блока-полотна, не диалог
// ====================================================================

async function transcribeAudio(audioUrl) {
  try {
    console.log('📥 Downloading audio...');
    const audioResponse = await axios.get(audioUrl, {
      responseType: 'arraybuffer', timeout: 120000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const audioBuffer = Buffer.from(audioResponse.data);
    console.log(`📦 Audio: ${audioBuffer.length} bytes`);

    // ========== СТЕРЕО РЕЖИМ (основной) ==========
    if (FFMPEG_AVAILABLE) {
      try {
        const channels = splitStereoChannels(audioBuffer);

        if (channels) {
          console.log('🔀 Стерео режим — gpt-4o-transcribe × 2 каналов');

          // Параллельная транскрибация
          const [managerRaw, clientRaw] = await Promise.all([
            transcribeChannel(channels.manager, 'администратор'),
            transcribeChannel(channels.client, 'пациент')
          ]);

          if (!managerRaw && !clientRaw) {
            return { plain: '', formatted: [] };
          }

          console.log(`✅ Transcribe done: Manager ${managerRaw.length}ch, Client ${clientRaw.length}ch`);

          // GPT-4o: перевод → два полотна текста
          const translated = await repairAndTranslate(managerRaw, clientRaw);

          const formatted = [];
          if (translated.manager) formatted.push({ role: 'manager', text: translated.manager });
          if (translated.client) formatted.push({ role: 'client', text: translated.client });

          const plainText = formatted.map(r => r.text).join(' ');
          console.log(`✅ Стерео pipeline v5.0 done: ${formatted.length} блоков`);
          return { plain: plainText, formatted };
        }
      } catch (e) {
        console.error('⚠️ Stereo failed, falling back to mono:', e.message);
      }
    }

    // ========== МОНО FALLBACK ==========
    console.log('📝 Моно режим — gpt-4o-transcribe');

    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    fd.append('model', 'gpt-4o-transcribe');
    fd.append('language', 'kk');
    fd.append('response_format', 'json');
    fd.append('prompt', WHISPER_PROMPT_KK);

    console.log('🎤 gpt-4o-transcribe (mono, kk)...');
    const r = await axios.post('https://api.openai.com/v1/audio/transcriptions', fd, {
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, ...fd.getHeaders() },
      timeout: 180000
    });

    const rawText = (r.data.text || '').trim();
    console.log(`✅ Mono transcribe: ${rawText.length} chars`);

    if (rawText.length < 15) {
      return { plain: rawText, formatted: [{ role: 'manager', text: rawText }] };
    }

    // GPT-4o: перевод + разделение по ролям → два полотна
    const translated = await repairAndTranslateMono(rawText);

    const formatted = [];
    if (translated.manager) formatted.push({ role: 'manager', text: translated.manager });
    if (translated.client) formatted.push({ role: 'client', text: translated.client });

    const finalPlain = formatted.map(r => r.text).join(' ');
    console.log(`✅ Mono pipeline v5.0 done: ${formatted.length} блоков`);
    return { plain: finalPlain, formatted };

  } catch (error) {
    console.error('❌ Transcription error:', error.message);
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

# ЭТАЛОННЫЙ СКРИПТ ПРОДАЖ (6 ЭТАПОВ)
Менеджер должен пройти все этапы по порядку. Оценивай каждый блок 0-100 по тому, насколько менеджер выполнил ключевые действия этапа.

## БЛОК 1: УСТАНОВЛЕНИЕ КОНТАКТА + ПРОГРАММИРОВАНИЕ (Этапы 1 + 1.5)
Ключевые действия менеджера:
- Обратиться по имени: «Алло, [Имя]?»
- Представиться: «Меня зовут [Имя], клиника Miramed»
- Подтвердить заявку: «Вы оставляли заявку по поводу лечения суставов без операции, верно?»
- Если клиент забыл/не помнит — объяснить откуда звонок, упомянуть адрес клиники
- ПРОГРАММИРОВАНИЕ (перехват инициативы): «Я задам пару вопросов по самочувствию, потом расскажу чем можем помочь. Договорились?»
- Спросить удобно ли говорить

КРИТЕРИИ ОЦЕНКИ:
90-100: Все действия выполнены, включая программирование
70-89: Представился и подтвердил заявку, но без программирования
50-69: Представился, но не подтвердил заявку и не перехватил инициативу
30-49: Формальное приветствие без представления клиники
0-29: Не представился или грубо

## БЛОК 2: ВЫЯВЛЕНИЕ БОЛИ + УСИЛЕНИЕ (Этап 2)
Ключевые действия менеджера:
- Спросить ЧТО беспокоит: «Что именно беспокоит? Колено, спина, тазобедренный?»
- Уточнить ХАРАКТЕР боли: «Боль острая или ноющая, тянущая? Давно началось?»
- УСИЛИТЬ боль (напомнить клиенту зачем ему это нужно): «А в быту мешает? По лестнице подниматься сложно? Долго ходить?»
- Дать клиенту выговориться, проявить эмпатию

КРИТЕРИИ ОЦЕНКИ:
90-100: Все три вопроса (что, характер, быт) + эмпатия
70-89: Спросил что болит и уточнил, но не усилил боль
50-69: Только спросил что болит, без уточнений
30-49: Не расспросил про боль, сразу перешёл к офферу
0-29: Вообще не выявлял потребности

## БЛОК 3: ПРЕЗЕНТАЦИЯ ОФФЕРА (Этап 3)
Ключевые действия менеджера:
- Проявить эмпатию/склейку: «Понимаю, жить с такой болью тяжело»
- Упомянуть специализацию: «Безоперационное восстановление суставов»
- Описать состав «Экспертной диагностики»:
  1) Консультация профильного ортопеда
  2) УЗИ двух суставов (больного + здорового для сравнения) — объяснить зачем
  3) Бесплатный повторный приём в течение недели
- Показать выгоду: «Обычно такой комплекс стоит ~25 000, а у нас 9 900»
- Назвать цену 9 900 ₸
- Подвести итог: «Честный прогноз — можно спасти сустав или пора к хирургу»

КРИТЕРИИ ОЦЕНКИ:
90-100: Полная презентация всех 3 компонентов + цена + выгода + склейка
70-89: Упомянул оффер и цену, но не все 3 компонента или без склейки
50-69: Назвал цену, но не объяснил что входит
30-49: Формально упомянул приём, без деталей
0-29: Не презентовал оффер

## БЛОК 4: ЗАПИСЬ — ВЫБОР БЕЗ ВЫБОРА (Этап 4)
Ключевые действия менеджера:
- НЕ спрашивать «Хотите записаться?» — сразу предлагать варианты
- Упомянуть фиксацию условий: «Чтобы закрепить за вами цену 9 900 и право на бесплатный повторный приём»
- Предложить 2 конкретных варианта: «В среду в 11:00 или в четверг в 16:30»
- Уточнить выбранное время: «16:30 или 17:15?»

КРИТЕРИИ ОЦЕНКИ:
90-100: Два варианта времени + фиксация условий, без вопроса «хотите ли»
70-89: Предложил время, но одним вариантом или с вопросом «хотите записаться?»
50-69: Спросил «хотите записаться?» без конкретного времени
30-49: Не предложил запись явно
0-29: Не дошёл до записи

## БЛОК 5: ОТРАБОТКА ВОЗРАЖЕНИЙ (Этап 5)
Типичные возражения и ЭТАЛОННЫЕ ответы:
- «Дорого / 9 900 много» → Посчитать: приём 5-7 тыс + УЗИ 8-10 тыс + повторный = ~20 000. У нас 9 900 всё включено + экономия на МРТ.
- «Я подумаю / посоветуюсь» → Понимаю. Предупредить что акция с бесплатным повторным приёмом при записи сейчас. Предложить предварительную бронь.
- «Вдруг не поможет / уже везде был» → Зову на диагностику, не на лечение. Врач честно скажет: можно спасти или нет. Берёмся только если видим прогноз.
- «В поликлинике бесплатно» → Очереди месяц. Боль не ждёт. Примем завтра без очередей.

КРИТЕРИИ ОЦЕНКИ:
90-100: Грамотно отработал все возражения с аргументами из скрипта
70-89: Отработал, но не все или не по скрипту
50-69: Попытался, но слабо/формально
30-49: Проигнорировал возражения
0-29: Сдался при первом возражении
ЕСЛИ ВОЗРАЖЕНИЙ НЕ БЫЛО → ставь 80 (нейтральная оценка)

## БЛОК 6: ФИНАЛИЗАЦИЯ (Этап 6)
Ключевые действия менеджера:
- Записать ФИО клиента
- Записать дату рождения
- Проговорить: дату, время, адрес клиники, сумму 9 900 ₸
- Напомнить: взять удостоверение + прийти за 10-15 минут
- Спросить про WhatsApp для отправки геолокации
- Попросить предупредить если планы изменятся

КРИТЕРИИ ОЦЕНКИ:
90-100: ФИО + дата/время + адрес + сумма + удостоверение + WhatsApp
70-89: ФИО + дата/время + адрес, но без деталей (удостоверение, WhatsApp)
50-69: Назвал дату/время, но не уточнил адрес и ФИО
30-49: Формально закончил без подтверждения данных
0-29: Оборвал разговор

# ОСОБЫЕ СЛУЧАИ
- Короткий звонок / недозвон / автоответчик → call_type: "КОРОТКИЙ", все блоки = 0, total_score = 0
- Сервисный звонок (перезапись, вопрос по лечению) → call_type: "СЕРВИСНЫЙ", оценивай по факту
- Повторный звонок существующему пациенту → call_type: "ПОВТОРНЫЙ"

# ПРАВИЛА ОЦЕНКИ
- total_score = среднее арифметическое 6 блоков (округли до целого)
- is_successful = true если клиент записался на приём
- В explanation пиши КОНКРЕТНО что менеджер сделал/не сделал (со ссылкой на скрипт)
- Будь СТРОГИМ но СПРАВЕДЛИВЫМ — если менеджер сделал хорошо, хвали

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

  console.log('🤖 GPT-4o: analyzing with full script reference...');
  const response = await axios.post(GOOGLE_PROXY_URL, {
    type: 'chat',
    apiKey: OPENAI_API_KEY,
    model: 'gpt-4o',
    max_tokens: 3000,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  }, { timeout: 120000 });

  const content = response.data.choices[0].message.content;
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in analysis response');
  return JSON.parse(match[0]);
}

// ==================== ANALYZE BY ID ====================

async function analyzeCallById(callId) {
  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).single();
  if (!call?.audio_url) throw new Error('No audio');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎤 Processing call ${callId}...`);
  console.log(`${'='.repeat(60)}`);

  const { plain, formatted } = await transcribeAudio(call.audio_url);
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

  console.log(`✅ Call ${callId} done: ${analysis.total_score}/100`);
  return { transcript: plain, formatted, analysis };
}

// ==================== API ROUTES ====================

app.post('/api/analyze/:callId', async (req, res) => {
  try {
    const result = await analyzeCallById(req.params.callId);
    res.json({ success: true, analysis: result.analysis });
  } catch (error) {
    console.error(`Analysis error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/reanalyze/:callId', async (req, res) => {
  try {
    await supabase.from('call_scores').delete().eq('call_id', req.params.callId);
    await supabase.from('calls').update({ transcript: null, transcript_formatted: null }).eq('id', req.params.callId);
    const result = await analyzeCallById(req.params.callId);
    res.json({ success: true, analysis: result.analysis });
  } catch (error) {
    console.error(`Reanalysis error:`, error.message);
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
  console.log(`🏥 CallMind v5.0 (gpt-4o-transcribe) на порту ${PORT}`);
  console.log(`🔀 Pipeline: ${FFMPEG_AVAILABLE
    ? 'Stereo split → gpt-4o-transcribe×2 (kk) → GPT-4o translate → GPT-4o analyze'
    : 'Mono: gpt-4o-transcribe (kk) → GPT-4o translate+roles → GPT-4o analyze'}`);
  console.log(`📋 Формат: 2 блока (администратор + пациент), не диалог`);
  if (await loadTokensFromDb()) {
    setInterval(() => syncNewCalls().catch(console.error), 5 * 60 * 1000);
    setTimeout(() => syncNewCalls(), 30000);
  }
});
