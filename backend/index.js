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
    message: '🏥 Clinic CallMind API v3',
    features: ['bitrix', 'ai-analysis', 'stereo-channel-split', 'smart-translate-kk-ru'],
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
//  ТРАНСКРИБАЦИЯ v3.1 — ИСПРАВЛЕННАЯ ВЕРСИЯ
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

    // Проверяем количество каналов
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

    // Левый канал (пациент) — 16kHz моно для Whisper
    execSync(`ffmpeg -y -i "${inputPath}" -af "pan=mono|c0=c0" -ar 16000 -ac 1 "${leftPath}"`, { stdio: 'ignore' });
    // Правый канал (администратор)
    execSync(`ffmpeg -y -i "${inputPath}" -af "pan=mono|c0=c1" -ar 16000 -ac 1 "${rightPath}"`, { stdio: 'ignore' });

    const leftBuffer = fs.readFileSync(leftPath);
    const rightBuffer = fs.readFileSync(rightPath);

    console.log(`✅ Каналы разделены: L(пациент)=${leftBuffer.length}b, R(админ)=${rightBuffer.length}b`);
    return { client: leftBuffer, manager: rightBuffer };
  } finally {
    try { fs.unlinkSync(inputPath); } catch (e) {}
    try { fs.unlinkSync(leftPath); } catch (e) {}
    try { fs.unlinkSync(rightPath); } catch (e) {}
  }
}

/**
 * Whisper транскрибация одного канала
 * ВРЕМЕННО: прокси НЕ возвращает segments, звоним OpenAI напрямую
 */
async function whisperTranscribeChannel(audioBuffer, channelName) {
  const whisperPrompt = 'Мирамед, клиника, диагностика, суставы, позвоночник, артроз, грыжа, МРТ, рентген, ' +
    'Сәлеметсіз бе, қайырлы күн, ауырады, дәрігер, емхана, буын, омыртқа, ' +
    'администратор, запись, приём, доктор, консультация, обследование, 9900 тенге';

  console.log(`🎤 Whisper [${channelName}] direct OpenAI (нужны segments)...`);
  const FormData = require('form-data');
  const formData = new FormData();
  formData.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'segment');
  formData.append('prompt', whisperPrompt);
  
  const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, ...formData.getHeaders() },
    timeout: 180000
  });
  
  const plainText = response.data.text;
  const segments = response.data.segments || [];

  console.log(`✅ Whisper [${channelName}]: ${plainText.length} chars, ${segments.length} segments`);
  return { plainText, segments };
}

/**
 * Объединяет транскрипты двух каналов в хронологический диалог по таймкодам
 */
function mergeChannelTranscripts(managerResult, clientResult) {
  const managerSegs = managerResult.segments || [];
  const clientSegs = clientResult.segments || [];

  // Fallback: если сегментов нет — используем plainText целиком
  if (managerSegs.length === 0 && clientSegs.length === 0) {
    console.log('⚠️ Нет сегментов — используем plainText');
    const result = [];
    if (managerResult.plainText?.trim()) {
      result.push({ role: 'manager', text: managerResult.plainText.trim(), start: 0, end: 0 });
    }
    if (clientResult.plainText?.trim()) {
      result.push({ role: 'client', text: clientResult.plainText.trim(), start: 0, end: 0 });
    }
    return result;
  }

  const allSegments = [];

  if (managerSegs.length > 0) {
    for (const seg of managerSegs) {
      if (seg.text?.trim()) {
        allSegments.push({ role: 'manager', text: seg.text.trim(), start: seg.start, end: seg.end });
      }
    }
  } else if (managerResult.plainText?.trim()) {
    allSegments.push({ role: 'manager', text: managerResult.plainText.trim(), start: 0, end: 0 });
  }

  if (clientSegs.length > 0) {
    for (const seg of clientSegs) {
      if (seg.text?.trim()) {
        allSegments.push({ role: 'client', text: seg.text.trim(), start: seg.start, end: seg.end });
      }
    }
  } else if (clientResult.plainText?.trim()) {
    allSegments.push({ role: 'client', text: clientResult.plainText.trim(), start: 0, end: 0 });
  }

  // Хронологическая сортировка
  allSegments.sort((a, b) => a.start - b.start);

  // Объединяем подряд идущие реплики одного спикера (пауза < 2 сек)
  const merged = [];
  for (const seg of allSegments) {
    const last = merged[merged.length - 1];
    if (last && last.role === seg.role && (seg.start - last.end) < 2.0) {
      last.text += ' ' + seg.text;
      last.end = seg.end;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/**
 * GPT-4o: ТОЧНЫЙ перевод + нарезка на реплики
 * 🔥 ИСПРАВЛЕННАЯ ВЕРСИЯ v2 — передаём таймкоды для сохранения хронологии
 */
async function translateDialogue(formatted) {
  // Формируем диалог с таймкодами, чтобы GPT видел последовательность
  const dialogText = formatted.map(r => {
    const time = r.start ? `[${formatTime(r.start)}]` : '';
    const role = r.role === 'manager' ? 'АДМИНИСТРАТОР' : 'ПАЦИЕНТ';
    return `${time} ${role}: ${r.text}`;
  }).join('\n');

  const prompt = `Ты — профессиональный переводчик медицинских звонков клиники MIRAMED (Актобе, Казахстан).

КОНТЕКСТ: Звонок записан в стерео. Каждая строка — это один сегмент речи с таймкодом.

ЗАДАЧА 1 — ПЕРЕВОД:
- Если текст на казахском → переведи на русский ДОСЛОВНО
- Если на русском → оставь как есть, исправь только ошибки распознавания
- Медицинский словарь:
  буын=сустав, омыртқа=позвоночник, бел=поясница, тізе=колено, иық=плечо
  ауырады=болит, қатты ауырады=сильно болит, ісініп кетті=отекло
  қозғалыс=движение, дәрігер=врач, емхана=клиника, тексеру=обследование

ЗАДАЧА 2 — СТРУКТУРА ДИАЛОГА:
- Раздели длинные реплики на короткие (1-3 предложения)
- СТРОГО СОХРАНЯЙ ХРОНОЛОГИЮ — реплики должны чередоваться так, как идут в диалоге
- Если администратор говорит несколько раз подряд — так и оставь
- НЕ МЕНЯЙ РОЛИ — что было manager остаётся manager

ЗАПРЕТЫ:
❌ НЕ объединяй весь текст администратора в один блок
❌ НЕ объединяй весь текст пациента в один блок
❌ НЕ выдумывай текст
❌ НЕ меняй порядок реплик

ПРИМЕР:
Вход:
[0:01] АДМИНИСТРАТОР: Сәлеметсіз бе клиника Мирамед
[0:05] ПАЦИЕНТ: Сәлем менің белім ауырады
[0:10] АДМИНИСТРАТОР: Қанша уақыт ауырады
[0:14] ПАЦИЕНТ: Екі апта болды

Выход:
[
  {"role": "manager", "text": "Здравствуйте, клиника Мирамед."},
  {"role": "client", "text": "Здравствуйте, у меня поясница болит."},
  {"role": "manager", "text": "Сколько времени болит?"},
  {"role": "client", "text": "Уже две недели."}
]

ФОРМАТ — JSON массив. Без markdown.

ДИАЛОГ:
${dialogText}`;

  console.log('🧠 GPT-4o: translating with timecodes...');
  const response = await axios.post(GOOGLE_PROXY_URL, {
    type: 'chat', apiKey: OPENAI_API_KEY, model: 'gpt-4o', max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  }, { timeout: 120000 });

  const content = response.data.choices[0].message.content.trim();
  let translated;
  try {
    const clean = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    translated = JSON.parse(clean);
  } catch (e) {
    const match = content.match(/\[[\s\S]*\]/);
    translated = match ? JSON.parse(match[0]) : formatted.map(r => ({ role: r.role, text: r.text }));
  }

  // Валидация
  translated = translated
    .filter(item => item.text && item.text.trim().length > 0)
    .map(item => ({
      role: item.role === 'client' ? 'client' : 'manager',
      text: item.text.trim()
    }));

  // НЕ объединяем подряд идущие реплики — пусть GPT сам решает
  return translated;
}

// Вспомогательная функция для форматирования времени
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * GPT-4o определяет роли + переводит (моно режим)
 * УЛУЧШЕННАЯ ВЕРСИЯ с примерами реальных диалогов
 */
async function translateAndAssignRolesGPT(plainText, segments) {
  let segmentedText;
  if (segments?.length > 0) {
    segmentedText = segments.map(seg => {
      const m = Math.floor(seg.start / 60);
      const s = Math.floor(seg.start % 60);
      return `[${m}:${s.toString().padStart(2, '0')}] ${seg.text.trim()}`;
    }).join('\n');
  } else {
    segmentedText = plainText;
  }

  const prompt = `Ты — эксперт по обработке звонков клиники MIRAMED (Актобе, Казахстан).

КОНТЕКСТ: Телефонный разговор. Оба голоса записаны в одном аудио. Язык: казахский, русский или смесь.

ЗАДАЧИ:
1. ПЕРЕВОД на русский (медицинский словарь):
   буын=сустав, омыртқа=позвоночник, бел=поясница, тізе=колено, мойын=шея
   ауырады=болит, қатты ауырады=сильно болит, дәрігер=врач, емхана=клиника
   тексеру=обследование, операция=операция, рентген=рентген, МРТ=МРТ
   
2. ОПРЕДЕЛИ РОЛИ по смыслу:
   АДМИНИСТРАТОР (manager):
   - Приветствует: "Здравствуйте", "Клиника Мирамед", "Добрый день"
   - Задаёт вопросы о боли: "Что беспокоит?", "Когда болит?", "Как проявляется?"
   - Предлагает услуги: "Мы лечим", "У нас есть", "Консультация за"
   - Предлагает запись: "Можете записаться", "Удобно завтра?"
   
   ПАЦИЕНТ (client):
   - Описывает симптомы: "Болит колено", "Не могу ходить", "Ноги беспокоят"
   - Рассказывает историю: "Делала рентген", "Врач сказал", "Ездила в санаторий"
   - Задаёт вопросы: "Что делать?", "Это артроз?", "Сколько стоит?"
   - Прощается: "Спасибо", "До свидания"

3. РАЗДЕЛИ на короткие реплики (1-3 предложения)
4. ЧЕРЕДУЙ роли в правильном порядке

ЗАПРЕТЫ:
❌ НЕ объединяй весь текст одного человека в один блок
❌ НЕ выдумывай фразы, которых нет
❌ НЕ пропускай предложения
❌ НЕ меняй смысл

ПРИМЕР:
Вход:
[0:05] Сәлеметсіз бе клиника Мирамед қайырлы күн
[0:12] Сәлем менің белім қатты ауырады
[0:18] Қашан ауырады түнде ме немесе жүргенде
[0:25] Жүргенде көп жүре алмаймын

Выход:
[
  {"role": "manager", "text": "Здравствуйте, клиника Мирамед, добрый день."},
  {"role": "client", "text": "Здравствуйте, у меня поясница сильно болит."},
  {"role": "manager", "text": "Когда болит — ночью или при ходьбе?"},
  {"role": "client", "text": "При ходьбе, не могу много ходить."}
]

ФОРМАТ — JSON массив. Без markdown.

ТРАНСКРИПТ:
${segmentedText}`;

  console.log('🧠 GPT-4o: translate + roles...');
  const response = await axios.post(GOOGLE_PROXY_URL, {
    type: 'chat', apiKey: OPENAI_API_KEY, model: 'gpt-4o', max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  }, { timeout: 120000 });

  const content = response.data.choices[0].message.content.trim();
  let formatted;
  try {
    const clean = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    formatted = JSON.parse(clean);
  } catch (e) {
    const match = content.match(/\[[\s\S]*\]/);
    formatted = match ? JSON.parse(match[0]) : [{ role: 'manager', text: content }];
  }

  formatted = formatted
    .filter(item => item.text && item.text.trim().length > 0)
    .map(item => ({ role: item.role === 'client' ? 'client' : 'manager', text: item.text.trim() }));

  return formatted;
}

/**
 * ГЛАВНАЯ ФУНКЦИЯ ТРАНСКРИБАЦИИ
 */
async function transcribeAudio(audioUrl) {
  console.log('📥 Downloading audio...');
  const audioResponse = await axios.get(audioUrl, {
    responseType: 'arraybuffer', timeout: 120000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const audioBuffer = Buffer.from(audioResponse.data);
  console.log(`📦 Audio: ${audioBuffer.length} bytes`);

/**
 * ГЛАВНАЯ ФУНКЦИЯ ТРАНСКРИБАЦИИ
 * ОТКЛЮЧЁН СТЕРЕО-РЕЖИМ - не работает из-за crosstalk
 */
async function transcribeAudio(audioUrl) {
  console.log("📥 Downloading audio...");
  const audioResponse = await axios.get(audioUrl, {
    responseType: "arraybuffer", timeout: 120000,
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  const audioBuffer = Buffer.from(audioResponse.data);
  console.log(`📦 Audio: ${audioBuffer.length} bytes`);

  console.log("📝 Моно режим с определением ролей через GPT-4o");

  const whisperPrompt = "Мирамед, клиника, диагностика, суставы, позвоночник, артроз, грыжа, " +
    "Сәлеметсіз бе, қайырлы күн, ауырады, дәрігер, емхана, 9900 тенге";

  console.log("🎤 Whisper direct...");
  const FormData = require("form-data");
  const fd = new FormData();
  fd.append("file", audioBuffer, { filename: "audio.mp3", contentType: "audio/mpeg" });
  fd.append("model", "whisper-1");
  fd.append("response_format", "verbose_json");
  fd.append("timestamp_granularities[]", "segment");
  fd.append("prompt", whisperPrompt);
  const r = await axios.post("https://api.openai.com/v1/audio/transcriptions", fd, {
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, ...fd.getHeaders() }, timeout: 180000
  });
  const plainText = r.data.text;
  const segments = r.data.segments || [];

  console.log(`✅ Whisper: ${plainText.length} chars, ${segments.length} segments`);

  if (plainText.length < 15) {
    return { plain: plainText, formatted: [{ role: "manager", text: plainText }] };
  }

  const formatted = await translateAndAssignRolesGPT(plainText, segments);
  return { plain: formatted.map(r => r.text).join(" "), formatted };
}
}

// ==================== ИИ АНАЛИЗ ====================

async function analyzeCall(transcript, formatted) {
  const dialogText = formatted?.length
    ? formatted.map(r => `${r.role === 'manager' ? 'АДМИНИСТРАТОР' : 'ПАЦИЕНТ'}: ${r.text}`).join('\n')
    : transcript;

  const prompt = `Ты — аудитор колл-центра клиники MIRAMED (Актобе). Оцени звонок.

КОНТЕКСТ: Клиника лечит суставы и позвоночник без операции. Оффер: "Экспертная диагностика" за 9 900 ₸.

ДИАЛОГ:
${dialogText}

ОЦЕНИ ПО БЛОКАМ (0-100):
1. КОНТАКТ — приветствие, представление клиники, подтверждение заявки
2. ВЫЯВЛЕНИЕ БОЛИ — что болит, как давно, мешает ли в быту
3. ПРЕЗЕНТАЦИЯ — эмпатия, описание оффера, цена 9 900 ₸
4. ЗАПИСЬ — предложить конкретное время
5. ВОЗРАЖЕНИЯ — если были, как отработал (не было = 80)
6. ФИНАЛИЗАЦИЯ — ФИО, дата, адрес, напоминание

ПРАВИЛА: Короткий/недозвон = 70. total_score = среднее 6 блоков.

Ответь ТОЛЬКО JSON:
{
  "call_type": "ПЕРВИЧНЫЙ|ПОВТОРНЫЙ|СЕРВИСНЫЙ|КОРОТКИЙ",
  "block1_score": число, "block1_explanation": "...",
  "block2_score": число, "block2_explanation": "...",
  "block3_score": число, "block3_explanation": "...",
  "block4_score": число, "block4_explanation": "...",
  "block5_score": число, "block5_explanation": "...",
  "block6_score": число, "block6_explanation": "...",
  "total_score": число,
  "client_info": { "facts": [], "needs": [], "pains": [], "objections": [] },
  "ai_summary": "Резюме 2-3 предложения",
  "is_successful": true/false
}`;

  console.log('🤖 GPT-4o: analyzing...');
  const response = await axios.post(GOOGLE_PROXY_URL, {
    type: 'chat', apiKey: OPENAI_API_KEY, model: 'gpt-4o', max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }]
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
  console.log(`🏥 CallMind v3.1 на порту ${PORT}`);
  console.log(`🔀 Pipeline: ${FFMPEG_AVAILABLE ? 'Stereo split → Whisper×2 → GPT-4o translate → GPT-4o analyze' : 'Mono: Whisper → GPT-4o (translate+roles) → GPT-4o analyze'}`);
  if (await loadTokensFromDb()) {
    setInterval(() => syncNewCalls().catch(console.error), 5 * 60 * 1000);
    setTimeout(() => syncNewCalls(), 30000);
  }
});
