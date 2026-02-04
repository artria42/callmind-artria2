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

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: '🏥 Clinic CallMind API',
    features: ['bitrix', 'ai-analysis', 'auto-translate-kk-to-ru'],
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

async function refreshBitrixToken() {
  if (!bitrixTokens.refresh_token) { await loadTokensFromDb(); if (!bitrixTokens.refresh_token) return false; }
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

// ==================== ПЕРЕВОД КАЗАХСКИЙ → РУССКИЙ ====================

async function translateToRussian(text) {
  if (!text || text.length < 10) return text;
  
  const kazakhChars = /[әғқңөұүһі]/i;
  const kazakhWords = ['сәлем', 'қалай', 'жақсы', 'рақмет', 'иә', 'жоқ', 'керек', 'болады', 'қайда', 'қашан', 'неге', 'кім', 'бар', 'біз', 'сіз', 'олар', 'менің', 'сенің', 'оның', 'ауырады', 'дәрігер', 'емхана'];
  const lowerText = text.toLowerCase();
  
  const hasKazakh = kazakhChars.test(text) || kazakhWords.some(w => lowerText.includes(w));
  if (!hasKazakh) return text;
  
  console.log('🌐 Translating Kazakh → Russian (GPT-4o)...');
  try {
    const response = await axios.post(GOOGLE_PROXY_URL, {
      type: 'chat', apiKey: OPENAI_API_KEY, model: 'gpt-4o', max_tokens: 4000,
      messages: [{ role: 'user', content: `Ты — профессиональный переводчик с казахского на русский язык.

Это транскрипт телефонного разговора из медицинской клиники (лечение суставов и позвоночника).
Транскрипт может содержать ошибки автоматического распознавания речи — слова могут быть искажены.

Твоя задача:
1. Исправь ошибки транскрибации (распознавания речи)
2. Переведи казахский текст на грамотный русский язык
3. Сохрани медицинский контекст разговора (боли в суставах, запись к врачу и т.д.)

Если текст уже на русском — просто исправь ошибки распознавания и верни.
Верни ТОЛЬКО исправленный/переведённый текст, без комментариев и пояснений.

Текст для обработки:
${text}` }]
    }, { timeout: 90000 });
    const translated = response.data.choices[0].message.content.trim();
    console.log('✅ Translation complete');
    return translated;
  } catch (e) {
    console.error('Translation error:', e.message);
    return text;
  }
}

async function translateFormatted(formatted) {
  if (!formatted?.length) return formatted;
  const allText = formatted.map(r => r.text).join(' ');
  const kazakhChars = /[әғқңөұүһі]/i;
  const kazakhWords = ['сәлем', 'қалай', 'жақсы', 'рақмет', 'иә', 'жоқ', 'керек', 'болады'];
  if (!kazakhChars.test(allText) && !kazakhWords.some(w => allText.toLowerCase().includes(w))) return formatted;
  
  const result = [];
  for (const item of formatted) {
    result.push({ ...item, text: await translateToRussian(item.text) });
  }
  return result;
}

// ==================== ТРАНСКРИБАЦИЯ ====================

async function transcribeAudio(audioUrl) {
  console.log('📥 Downloading audio...');
  const audioResponse = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 120000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const audioBuffer = Buffer.from(audioResponse.data);
  console.log(`📦 Audio: ${audioBuffer.length} bytes`);
  
  let plainText = '', segments = [];
  
  if (GOOGLE_PROXY_URL) {
    try {
      console.log('🎤 Whisper via proxy...');
      const proxyResponse = await axios.post(GOOGLE_PROXY_URL, {
        type: 'transcribe', apiKey: OPENAI_API_KEY, audio: audioBuffer.toString('base64')
      }, { timeout: 180000 });
      if (proxyResponse.data.text) {
        plainText = proxyResponse.data.text;
        segments = proxyResponse.data.segments || [];
      }
    } catch (e) { console.log('Proxy failed:', e.message); }
  }
  
  if (!plainText) {
    console.log('🎤 Whisper direct...');
    const FormData = require('form-data');
    const formData = new FormData();
    formData.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');
    const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, ...formData.getHeaders() }, timeout: 180000
    });
    plainText = response.data.text;
    segments = response.data.segments || [];
  }
  
  console.log(`✅ Transcribed: ${plainText.length} chars`);
  
  let formatted = formatWithRoles(segments, plainText);
  
  // Перевод на русский
  plainText = await translateToRussian(plainText);
  formatted = await translateFormatted(formatted);
  
  return { plain: plainText, formatted };
}

function formatWithRoles(segments, plainText) {
  if (!segments?.length) return parseByPatterns(plainText);
  
  const formatted = [];
  let speaker = 'manager', lastEnd = 0;
  
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.start - lastEnd > 1.5 && i > 0) speaker = speaker === 'manager' ? 'client' : 'manager';
    const detected = detectRole(seg.text);
    if (detected) speaker = detected;
    formatted.push({ role: speaker, text: seg.text.trim(), start: seg.start, end: seg.end });
    lastEnd = seg.end;
  }
  return mergeReplicas(formatted);
}

function detectRole(text) {
  const t = text.toLowerCase();
  const mgrRu = ['добрый день', 'здравствуйте', 'клиника', 'записать вас', 'мирамед', 'miramed', 'администратор', 'менеджер'];
  const mgrKz = ['сәлеметсіз', 'қайырлы күн', 'клиника', 'жазайын'];
  const cliRu = ['хочу записаться', 'болит', 'беспокоит', 'сколько стоит', 'подскажите'];
  const cliKz = ['жазылғым келеді', 'ауырады', 'мазалайды', 'қанша тұрады'];
  
  if ([...mgrRu, ...mgrKz].some(p => t.includes(p))) return 'manager';
  if ([...cliRu, ...cliKz].some(p => t.includes(p))) return 'client';
  return null;
}

function parseByPatterns(text) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const formatted = [];
  let speaker = 'manager';
  for (const s of sentences) {
    if (!s.trim()) continue;
    const detected = detectRole(s);
    if (detected) speaker = detected;
    formatted.push({ role: speaker, text: s.trim() });
    if (!detected) speaker = speaker === 'manager' ? 'client' : 'manager';
  }
  return mergeReplicas(formatted);
}

function mergeReplicas(formatted) {
  if (!formatted.length) return [];
  const merged = [formatted[0]];
  for (let i = 1; i < formatted.length; i++) {
    const curr = formatted[i], last = merged[merged.length - 1];
    if (curr.role === last.role) { last.text += ' ' + curr.text; if (curr.end) last.end = curr.end; }
    else merged.push(curr);
  }
  return merged;
}

// ==================== ИИ АНАЛИЗ ====================

async function analyzeCall(transcript, formatted) {
  const dialogText = formatted?.length ? formatted.map(r => `${r.role === 'manager' ? 'МЕНЕДЖЕР' : 'ПАЦИЕНТ'}: ${r.text}`).join('\n') : transcript;

  const prompt = `Ты — аудитор колл-центра клиники MIRAMED (Актобе). Оцени звонок.

КОНТЕКСТ: Клиника лечит суставы без операции. Оффер: "Экспертная диагностика" за 9 900 ₸.

ДИАЛОГ:
${dialogText}

ОЦЕНИ ПО БЛОКАМ (0-100):
1. КОНТАКТ — приветствие, представление, подтверждение заявки
2. ВЫЯВЛЕНИЕ БОЛИ — что болит, как давно, мешает ли в быту
3. ПРЕЗЕНТАЦИЯ — эмпатия, описание оффера, цена 9 900 ₸
4. ЗАПИСЬ — предложить время, не спрашивать "хотите?"
5. ВОЗРАЖЕНИЯ — если были, как отработал (если не было — 80)
6. ФИНАЛИЗАЦИЯ — ФИО, дата, адрес, напоминания

ПРАВИЛА: Короткий/недозвон = 70 за всё. total_score = среднее 6 блоков.

Ответь JSON:
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

  const response = await axios.post(GOOGLE_PROXY_URL, {
    type: 'chat', apiKey: OPENAI_API_KEY, model: 'gpt-4o', max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }]
  }, { timeout: 120000 });

  const content = response.data.choices[0].message.content;
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  return JSON.parse(match[0]);
}

async function analyzeCallById(callId) {
  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).single();
  if (!call?.audio_url) throw new Error('No audio');

  console.log(`🎤 Transcribing call ${callId}...`);
  const { plain, formatted } = await transcribeAudio(call.audio_url);
  await supabase.from('calls').update({ transcript: plain, transcript_formatted: formatted }).eq('id', callId);

  console.log(`🤖 Analyzing call ${callId}...`);
  const analysis = await analyzeCall(plain, formatted);

  await supabase.from('call_scores').upsert({
    call_id: callId, call_type: analysis.call_type, total_score: Math.round(analysis.total_score),
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

  console.log(`✅ Call ${callId}: ${analysis.total_score}/100`);
  return { transcript: plain, formatted, analysis };
}

app.post('/api/analyze/:callId', async (req, res) => {
  try {
    const result = await analyzeCallById(req.params.callId);
    res.json({ success: true, analysis: result.analysis });
  } catch (error) {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🏥 CallMind на порту ${PORT}`);
  console.log(`🌐 Автоперевод: казахский → русский`);
  if (await loadTokensFromDb()) {
    setInterval(() => syncNewCalls().catch(console.error), 5 * 60 * 1000);
    setTimeout(() => syncNewCalls(), 30000);
  }
});
