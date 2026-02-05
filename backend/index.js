const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
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
    message: '🏥 Clinic CallMind API v2',
    features: ['bitrix', 'ai-analysis', 'smart-translate-kk-ru', 'gpt4o-role-detection'],
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
//  ТРАНСКРИБАЦИЯ v2 — Whisper + GPT-4o (перевод + роли в одном вызове)
// ====================================================================

/**
 * Шаг 1: Whisper транскрибация с подсказками для медицинского контекста
 * Возвращает сырой текст и сегменты с таймкодами
 */
async function whisperTranscribe(audioBuffer) {
  // Подсказка помогает Whisper лучше распознавать специфичные термины
  const whisperPrompt = 'Мирамед, клиника, диагностика, суставы, позвоночник, артроз, грыжа, МРТ, рентген, ' +
    'Сәлеметсіз бе, қайырлы күн, ауырады, дәрігер, емхана, буын, омыртқа, ' +
    'администратор, запись, приём, доктор, консультация, обследование, 9900 тенге';

  let plainText = '';
  let segments = [];

  // Попытка через прокси
  if (GOOGLE_PROXY_URL) {
    try {
      console.log('🎤 Whisper via proxy (with prompt)...');
      const proxyResponse = await axios.post(GOOGLE_PROXY_URL, {
        type: 'transcribe',
        apiKey: OPENAI_API_KEY,
        audio: audioBuffer.toString('base64'),
        prompt: whisperPrompt
      }, { timeout: 180000 });

      if (proxyResponse.data.text) {
        plainText = proxyResponse.data.text;
        segments = proxyResponse.data.segments || [];
      }
    } catch (e) {
      console.log('Proxy transcribe failed:', e.message);
    }
  }

  // Fallback — напрямую к OpenAI
  if (!plainText) {
    console.log('🎤 Whisper direct (with prompt)...');
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
    plainText = response.data.text;
    segments = response.data.segments || [];
  }

  return { plainText, segments };
}

/**
 * Шаг 2: GPT-4o — перевод на русский + разметка ролей (ОДИН вызов)
 * Получает сырой транскрипт с таймкодами, возвращает чистый диалог
 */
async function translateAndAssignRoles(plainText, segments) {
  // Формируем текст с таймкодами для GPT-4o
  let segmentedText;
  if (segments?.length > 0) {
    segmentedText = segments.map((seg, i) => {
      const start = formatTime(seg.start);
      const end = formatTime(seg.end);
      return `[${start}-${end}] ${seg.text.trim()}`;
    }).join('\n');
  } else {
    segmentedText = plainText;
  }

  const prompt = `Ты — эксперт по обработке телефонных разговоров медицинской клиники MIRAMED (Актобе, Казахстан).
Клиника лечит суставы и позвоночник без операции.

Тебе дан сырой транскрипт телефонного звонка с таймкодами. Разговор может быть на казахском, русском или на смеси обоих языков (code-switching).

ТВОИ ЗАДАЧИ:

1. ПЕРЕВОД: Весь текст должен быть на грамотном русском языке.
   - Казахские фразы переведи на русский
   - Русские фразы оставь как есть, исправив ошибки распознавания
   - Медицинские термины переведи корректно (буын = сустав, омыртқа = позвоночник, ауырады = болит и т.д.)
   - Исправь типичные ошибки Whisper: слипшиеся слова, неправильная пунктуация, искажённые имена

2. РОЛИ: Определи кто говорит — администратор (manager) или пациент (client).
   Правила определения ролей:
   - Администратор ВСЕГДА говорит первым (приветствует, представляется)
   - Администратор: приветствует, называет клинику, спрашивает чем помочь, предлагает запись, называет цены, диктует адрес
   - Пациент: описывает жалобы/боли, спрашивает о ценах, соглашается/отказывается от записи, называет своё имя
   - Если звонок начинается с "Алло" / "Сәлеметсіз бе" без представления клиники — это входящий звонок, первый говорит пациент
   - Если звонок начинается с "Клиника Мирамед" / "Добрый день, клиника" — первый говорит администратор
   - Смена говорящего определяется по паузам (>1 сек между сегментами), смене темы и контексту

3. ФОРМАТ ОТВЕТА — строго JSON массив:
[
  {"role": "manager", "text": "Текст на русском языке"},
  {"role": "client", "text": "Текст на русском языке"},
  ...
]

ВАЖНО:
- Объединяй подряд идущие реплики одного говорящего в одну
- Не добавляй от себя слова, которых не было в разговоре
- Убери мусорные звуки (ммм, ааа, эээ) если они не несут смысла
- Если текст слишком короткий (1-2 фразы) или это автоответчик/гудки, верни как есть с role: "manager"
- Верни ТОЛЬКО JSON массив, без комментариев, без markdown

ТРАНСКРИПТ:
${segmentedText}`;

  console.log('🧠 GPT-4o: translate + roles...');
  const response = await axios.post(GOOGLE_PROXY_URL, {
    type: 'chat',
    apiKey: OPENAI_API_KEY,
    model: 'gpt-4o',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  }, { timeout: 120000 });

  const content = response.data.choices[0].message.content.trim();

  // Парсим JSON из ответа
  let formatted;
  try {
    // Убираем возможные markdown-обёртки
    const cleanContent = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    formatted = JSON.parse(cleanContent);
  } catch (parseError) {
    // Пробуем найти JSON массив в тексте
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      formatted = JSON.parse(match[0]);
    } else {
      console.error('❌ Failed to parse GPT-4o role response, falling back');
      formatted = [{ role: 'manager', text: content }];
    }
  }

  // Валидация и очистка
  formatted = formatted
    .filter(item => item.text && item.text.trim().length > 0)
    .map(item => ({
      role: item.role === 'client' ? 'client' : 'manager',
      text: item.text.trim()
    }));

  // Объединяем подряд идущие реплики одного спикера (на случай если GPT не объединил)
  formatted = mergeConsecutiveReplicas(formatted);

  // Собираем plain text на русском
  const russianPlainText = formatted.map(r => r.text).join(' ');

  return { plainText: russianPlainText, formatted };
}

/**
 * Объединяет подряд идущие реплики одного и того же спикера
 */
function mergeConsecutiveReplicas(formatted) {
  if (!formatted.length) return [];
  const merged = [{ ...formatted[0] }];
  for (let i = 1; i < formatted.length; i++) {
    const curr = formatted[i];
    const last = merged[merged.length - 1];
    if (curr.role === last.role) {
      last.text += ' ' + curr.text;
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}

/**
 * Форматирует секунды в MM:SS
 */
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Главная функция транскрибации
 * Скачивает аудио → Whisper → GPT-4o (перевод + роли)
 */
async function transcribeAudio(audioUrl) {
  console.log('📥 Downloading audio...');
  const audioResponse = await axios.get(audioUrl, {
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const audioBuffer = Buffer.from(audioResponse.data);
  console.log(`📦 Audio: ${audioBuffer.length} bytes`);

  // Шаг 1: Whisper — получаем сырой транскрипт
  const { plainText: rawText, segments } = await whisperTranscribe(audioBuffer);
  console.log(`✅ Whisper done: ${rawText.length} chars, ${segments.length} segments`);

  // Если текст слишком короткий — нечего переводить
  if (rawText.length < 15) {
    console.log('⚠️ Very short transcript, skipping GPT processing');
    return {
      plain: rawText,
      formatted: [{ role: 'manager', text: rawText }]
    };
  }

  // Шаг 2: GPT-4o — перевод + роли
  const { plainText: russianText, formatted } = await translateAndAssignRoles(rawText, segments);
  console.log(`✅ GPT-4o done: ${formatted.length} replicas, ${russianText.length} chars`);

  return { plain: russianText, formatted };
}

// ==================== ИИ АНАЛИЗ (Вызов 2) ====================

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
2. ВЫЯВЛЕНИЕ БОЛИ — что болит, как давно, мешает ли в быту, были ли обследования
3. ПРЕЗЕНТАЦИЯ — эмпатия, описание оффера "Экспертная диагностика", цена 9 900 ₸
4. ЗАПИСЬ — предложить конкретное время, не спрашивать "хотите ли вы?"
5. ВОЗРАЖЕНИЯ — если были, как отработал (если возражений не было — ставь 80)
6. ФИНАЛИЗАЦИЯ — подтверждение ФИО, дата и время записи, адрес клиники, напоминание

ПРАВИЛА ОЦЕНКИ:
- Короткий звонок / недозвон / автоответчик = 70 за все блоки
- Если звонок на казахском и был переведён — оценивай по содержанию, не снижай за язык
- total_score = среднее арифметическое 6 блоков (округли до целого)

Ответь ТОЛЬКО JSON:
{
  "call_type": "ПЕРВИЧНЫЙ|ПОВТОРНЫЙ|СЕРВИСНЫЙ|КОРОТКИЙ",
  "block1_score": число, "block1_explanation": "краткое объяснение на русском",
  "block2_score": число, "block2_explanation": "краткое объяснение на русском",
  "block3_score": число, "block3_explanation": "краткое объяснение на русском",
  "block4_score": число, "block4_explanation": "краткое объяснение на русском",
  "block5_score": число, "block5_explanation": "краткое объяснение на русском",
  "block6_score": число, "block6_explanation": "краткое объяснение на русском",
  "total_score": число,
  "client_info": {
    "facts": ["возраст, пол, имя если назвал"],
    "needs": ["что хочет: записаться, узнать цену и т.д."],
    "pains": ["что болит, как давно, какие симптомы"],
    "objections": ["возражения если были"]
  },
  "ai_summary": "Резюме звонка в 2-3 предложениях на русском",
  "is_successful": true/false
}`;

  console.log('🤖 GPT-4o: analyzing call quality...');
  const response = await axios.post(GOOGLE_PROXY_URL, {
    type: 'chat',
    apiKey: OPENAI_API_KEY,
    model: 'gpt-4o',
    max_tokens: 2500,
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

  console.log(`\n${'='.repeat(50)}`);
  console.log(`🎤 Processing call ${callId}...`);
  console.log(`${'='.repeat(50)}`);

  // Шаг 1+2: Транскрибация + перевод + роли
  const { plain, formatted } = await transcribeAudio(call.audio_url);
  await supabase.from('calls').update({
    transcript: plain,
    transcript_formatted: formatted
  }).eq('id', callId);

  // Шаг 3: Анализ качества
  const analysis = await analyzeCall(plain, formatted);

  await supabase.from('call_scores').upsert({
    call_id: callId,
    call_type: analysis.call_type,
    total_score: Math.round(analysis.total_score),
    block1_score: Math.round(analysis.block1_score),
    block2_score: Math.round(analysis.block2_score),
    block3_score: Math.round(analysis.block3_score),
    block4_score: Math.round(analysis.block4_score),
    block5_score: Math.round(analysis.block5_score),
    block6_score: Math.round(analysis.block6_score),
    score_explanations: {
      block1: analysis.block1_explanation,
      block2: analysis.block2_explanation,
      block3: analysis.block3_explanation,
      block4: analysis.block4_explanation,
      block5: analysis.block5_explanation,
      block6: analysis.block6_explanation
    },
    client_info: analysis.client_info,
    ai_summary: analysis.ai_summary,
    is_successful: analysis.is_successful
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
    console.error(`Analysis error for call ${req.params.callId}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Переанализ — сбрасывает старый результат и анализирует заново
app.post('/api/reanalyze/:callId', async (req, res) => {
  try {
    // Удаляем старые данные
    await supabase.from('call_scores').delete().eq('call_id', req.params.callId);
    await supabase.from('calls').update({ transcript: null, transcript_formatted: null }).eq('id', req.params.callId);

    const result = await analyzeCallById(req.params.callId);
    res.json({ success: true, analysis: result.analysis });
  } catch (error) {
    console.error(`Reanalysis error for call ${req.params.callId}:`, error.message);
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
  console.log(`🏥 CallMind v2 на порту ${PORT}`);
  console.log(`🧠 Pipeline: Whisper → GPT-4o (translate+roles) → GPT-4o (analysis)`);
  if (await loadTokensFromDb()) {
    setInterval(() => syncNewCalls().catch(console.error), 5 * 60 * 1000);
    setTimeout(() => syncNewCalls(), 30000);
  }
});
