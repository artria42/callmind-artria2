const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Подключение к Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Конфигурация
const BITRIX_DOMAIN = process.env.BITRIX_DOMAIN;
const BITRIX_CLIENT_ID = process.env.BITRIX_CLIENT_ID;
const BITRIX_CLIENT_SECRET = process.env.BITRIX_CLIENT_SECRET;
const GOOGLE_PROXY_URL = process.env.GOOGLE_PROXY_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Хранилище токенов Битрикс
let bitrixTokens = {
  access_token: null,
  refresh_token: null
};

// ==================== СОХРАНЕНИЕ ТОКЕНОВ В БАЗУ ====================

async function saveTokensToDb() {
  try {
    await supabase.from('settings').upsert({
      key: 'bitrix_tokens',
      value: JSON.stringify(bitrixTokens),
      updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
    console.log('✅ Tokens saved to database');
  } catch (e) {
    console.error('Error saving tokens:', e.message);
  }
}

async function loadTokensFromDb() {
  try {
    const { data } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'bitrix_tokens')
      .single();
    
    if (data?.value) {
      bitrixTokens = JSON.parse(data.value);
      console.log('✅ Tokens loaded from database');
      return true;
    }
  } catch (e) {
    console.log('No saved tokens found');
  }
  return false;
}

// ==================== ОСНОВНЫЕ РОУТЫ ====================

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: '🏥 Clinic CallMind API работает!',
    version: '1.0.0',
    features: ['bitrix', 'ai-analysis', 'dual-channel-transcription', 'client-insights'],
    bitrix_connected: !!bitrixTokens.access_token
  });
});

// ==================== BITRIX24 AUTH ====================

app.get('/api/bitrix/auth', (req, res) => {
  const authUrl = `https://${BITRIX_DOMAIN}/oauth/authorize/?client_id=${BITRIX_CLIENT_ID}&response_type=code`;
  res.json({ auth_url: authUrl, message: 'Перейдите по ссылке для авторизации' });
});

app.get('/api/bitrix/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Код не получен' });

  try {
    const tokenUrl = `https://${BITRIX_DOMAIN}/oauth/token/?grant_type=authorization_code&client_id=${BITRIX_CLIENT_ID}&client_secret=${BITRIX_CLIENT_SECRET}&code=${code}`;
    const response = await axios.get(tokenUrl);
    bitrixTokens = {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token
    };
    await saveTokensToDb();
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>✅ Битрикс24 успешно подключён!</h1><p>Можете закрыть это окно.</p></body></html>');
  } catch (error) {
    res.status(500).json({ error: 'Ошибка авторизации', details: error.message });
  }
});

app.get('/api/bitrix/status', (req, res) => {
  res.json({ connected: !!bitrixTokens.access_token, domain: BITRIX_DOMAIN });
});

async function refreshBitrixToken() {
  if (!bitrixTokens.refresh_token) {
    await loadTokensFromDb();
    if (!bitrixTokens.refresh_token) return false;
  }
  try {
    const tokenUrl = `https://${BITRIX_DOMAIN}/oauth/token/?grant_type=refresh_token&client_id=${BITRIX_CLIENT_ID}&client_secret=${BITRIX_CLIENT_SECRET}&refresh_token=${bitrixTokens.refresh_token}`;
    const response = await axios.get(tokenUrl);
    bitrixTokens = {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token
    };
    await saveTokensToDb();
    console.log('✅ Bitrix token refreshed');
    return true;
  } catch (error) {
    console.error('❌ Failed to refresh token:', error.message);
    return false;
  }
}

async function callBitrixMethod(method, params = {}) {
  if (!bitrixTokens.access_token) throw new Error('Битрикс не авторизован');
  
  try {
    const url = `https://${BITRIX_DOMAIN}/rest/${method}?auth=${bitrixTokens.access_token}`;
    const response = await axios.post(url, params);
    return response.data.result;
  } catch (error) {
    if (error.response?.data?.error === 'expired_token') {
      const refreshed = await refreshBitrixToken();
      if (refreshed) {
        const url = `https://${BITRIX_DOMAIN}/rest/${method}?auth=${bitrixTokens.access_token}`;
        const response = await axios.post(url, params);
        return response.data.result;
      }
    }
    throw error;
  }
}

// ==================== ВЕБХУКИ БИТРИКС24 ====================

app.post('/api/bitrix/webhook', async (req, res) => {
  try {
    console.log('📥 Webhook received:', new Date().toISOString());
    console.log('Body:', JSON.stringify(req.body).substring(0, 500));
    
    const event = req.body.event || req.body.EVENT;
    
    if (event === 'ONVOXIMPLANTCALLEND' || event === 'onVoximplantCallEnd') {
      console.log('📞 Call ended event');
      setTimeout(async () => {
        await syncNewCalls();
      }, 5000);
    }
    
    res.json({ status: 'ok' });
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bitrix/call-webhook', async (req, res) => {
  try {
    console.log('📥 Call webhook received:', new Date().toISOString());
    console.log('Body:', JSON.stringify(req.body).substring(0, 500));
    
    const event = req.body.event || req.body.EVENT;
    
    if (event === 'ONVOXIMPLANTCALLEND' || event === 'onVoximplantCallEnd') {
      console.log('📞 Call ended event');
      setTimeout(async () => {
        await syncNewCalls();
      }, 5000);
    }
    
    res.json({ status: 'ok' });
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== СИНХРОНИЗАЦИЯ ЗВОНКОВ ====================

async function syncNewCalls() {
  try {
    if (!bitrixTokens.access_token) {
      console.log('⚠️ Bitrix not authorized, skipping sync');
      return;
    }
    
    console.log('🔄 Syncing calls...');
    
    const calls = await callBitrixMethod('voximplant.statistic.get', {
      FILTER: { '>CALL_START_DATE': new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
      SORT: 'CALL_START_DATE',
      ORDER: 'DESC'
    });
    
    let newCount = 0;
    let analyzedCount = 0;
    
    for (const call of calls || []) {
      const { data: existing } = await supabase
        .from('calls')
        .select('id, audio_url')
        .eq('bitrix_call_id', call.ID)
        .single();
      
      if (existing) {
        if (!existing.audio_url && call.CALL_RECORD_URL) {
          await supabase.from('calls').update({
            audio_url: call.CALL_RECORD_URL
          }).eq('id', existing.id);
          
          const { data: score } = await supabase
            .from('call_scores')
            .select('id')
            .eq('call_id', existing.id)
            .single();
          
          if (!score) {
            console.log(`🤖 Auto-analyzing call ${existing.id}...`);
            analyzeCallById(existing.id).catch(e => console.error('Auto-analysis error:', e.message));
            analyzedCount++;
          }
        }
        continue;
      }
      
      const { data: manager } = await supabase
        .from('managers')
        .select('id')
        .eq('bitrix_id', call.PORTAL_USER_ID)
        .single();
      
      const { data: newCall, error } = await supabase.from('calls').insert({
        bitrix_call_id: call.ID,
        manager_id: manager?.id,
        client_name: call.PHONE_NUMBER,
        duration: parseInt(call.CALL_DURATION) || 0,
        call_date: call.CALL_START_DATE,
        audio_url: call.CALL_RECORD_URL || null,
        crm_link: call.CRM_ENTITY_ID ? `https://${BITRIX_DOMAIN}/crm/${(call.CRM_ENTITY_TYPE || 'contact').toLowerCase()}/details/${call.CRM_ENTITY_ID}/` : null,
        crm_entity_type: call.CRM_ENTITY_TYPE || null,
        crm_entity_id: call.CRM_ENTITY_ID || null
      }).select().single();
      
      if (!error && newCall) {
        newCount++;
        console.log(`✅ New call saved: ${newCall.id}`);
        
        if (newCall.audio_url) {
          console.log(`🤖 Auto-analyzing call ${newCall.id}...`);
          analyzeCallById(newCall.id).catch(e => console.error('Auto-analysis error:', e.message));
          analyzedCount++;
        }
      }
    }
    
    console.log(`🔄 Sync complete: ${newCount} new, ${analyzedCount} analyzing`);
  } catch (e) {
    console.error('Sync error:', e.message);
  }
}

app.get('/api/bitrix/calls', async (req, res) => {
  try {
    const calls = await callBitrixMethod('voximplant.statistic.get', {
      FILTER: { '>CALL_START_DATE': new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
      SORT: 'CALL_START_DATE',
      ORDER: 'DESC'
    });

    for (const call of calls || []) {
      const { data: manager } = await supabase.from('managers').select('id').eq('bitrix_id', call.PORTAL_USER_ID).single();

      await supabase.from('calls').upsert({
        bitrix_call_id: call.ID,
        manager_id: manager?.id,
        client_name: call.PHONE_NUMBER,
        duration: parseInt(call.CALL_DURATION) || 0,
        call_date: call.CALL_START_DATE,
        audio_url: call.CALL_RECORD_URL || null,
        crm_link: call.CRM_ENTITY_ID ? `https://${BITRIX_DOMAIN}/crm/${(call.CRM_ENTITY_TYPE || 'contact').toLowerCase()}/details/${call.CRM_ENTITY_ID}/` : null,
        crm_entity_type: call.CRM_ENTITY_TYPE || null,
        crm_entity_id: call.CRM_ENTITY_ID || null
      }, { onConflict: 'bitrix_call_id' });
    }

    res.json({ success: true, count: calls?.length || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bitrix/users', async (req, res) => {
  try {
    const users = await callBitrixMethod('user.get', { filter: { ACTIVE: true } });
    
    for (const user of users) {
      const fullName = `${user.NAME} ${user.LAST_NAME}`.trim();
      await supabase.from('managers').upsert({
        bitrix_id: user.ID,
        name: fullName
      }, { onConflict: 'bitrix_id' });
    }

    res.json({ success: true, count: users.length, users: users.map(u => ({
      id: u.ID,
      name: `${u.NAME} ${u.LAST_NAME}`,
      email: u.EMAIL
    }))});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ТРАНСКРИБАЦИЯ ====================

async function transcribeAudioDualChannel(audioUrl) {
  try {
    console.log('📥 Downloading audio...');
    const audioResponse = await axios.get(audioUrl, { 
      responseType: 'arraybuffer', 
      timeout: 120000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const audioBuffer = Buffer.from(audioResponse.data);
    console.log(`📦 Audio size: ${audioBuffer.length} bytes`);
    
    let plainText = '';
    let segments = [];
    
    // Пробуем через Google Proxy
    if (GOOGLE_PROXY_URL) {
      try {
        console.log('🎤 Sending to Whisper via Google Proxy...');
        const base64Audio = audioBuffer.toString('base64');
        
        const proxyResponse = await axios.post(GOOGLE_PROXY_URL, {
          type: 'transcribe',
          apiKey: OPENAI_API_KEY,
          audio: base64Audio
        }, { timeout: 180000 });
        
        if (proxyResponse.data.text) {
          plainText = proxyResponse.data.text;
          segments = proxyResponse.data.segments || [];
          console.log(`✅ Transcription via proxy complete: ${plainText.length} chars`);
        } else if (proxyResponse.data.error) {
          throw new Error(proxyResponse.data.error);
        }
      } catch (proxyError) {
        console.log('⚠️ Proxy failed, trying direct API...', proxyError.message);
      }
    }
    
    // Если прокси не сработал — пробуем напрямую
    if (!plainText) {
      console.log('🎤 Sending to Whisper API directly...');
      const FormData = require('form-data');
      const formData = new FormData();
      formData.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'verbose_json');
      formData.append('timestamp_granularities[]', 'segment');
      
      const transcribeResponse = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          ...formData.getHeaders()
        },
        timeout: 180000
      });
      
      const result = transcribeResponse.data;
      plainText = result.text;
      segments = result.segments || [];
      console.log(`✅ Transcription direct complete: ${plainText.length} chars, ${segments.length} segments`);
    }
    
    const formattedTranscript = formatTranscriptWithRoles(segments, plainText);
    
    return {
      plain: plainText,
      formatted: formattedTranscript
    };
  } catch (error) {
    console.error('Transcription error:', error.message);
    throw error;
  }
}

function formatTranscriptWithRoles(segments, plainText) {
  if (!segments || segments.length === 0) {
    return parseTranscriptByPatterns(plainText);
  }
  
  const formatted = [];
  let currentSpeaker = 'manager';
  let lastEnd = 0;
  
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const gap = seg.start - lastEnd;
    
    if (gap > 1.5 && i > 0) {
      currentSpeaker = currentSpeaker === 'manager' ? 'client' : 'manager';
    }
    
    const detectedRole = detectRoleByContent(seg.text);
    if (detectedRole) {
      currentSpeaker = detectedRole;
    }
    
    formatted.push({
      role: currentSpeaker,
      text: seg.text.trim(),
      start: seg.start,
      end: seg.end
    });
    
    lastEnd = seg.end;
  }
  
  return mergeConsecutiveReplicas(formatted);
}

function detectRoleByContent(text) {
  const lowerText = text.toLowerCase();
  
  const managerPhrases = [
    'добрый день', 'здравствуйте', 'клиника', 'администратор',
    'чем могу помочь', 'могу вам помочь', 'записать вас',
    'какой врач', 'к какому врачу', 'на какое время',
    'свободное время', 'удобное время', 'ваш телефон',
    'перезвоним', 'подтвердим', 'напомним', 'ожидаем вас',
    'miramed', 'мирамед'
  ];
  
  const clientPhrases = [
    'хочу записаться', 'хотел бы', 'хотела бы', 'нужен врач',
    'болит', 'беспокоит', 'проблема', 'жалоба',
    'сколько стоит', 'какая цена', 'стоимость',
    'когда можно', 'есть ли время', 'подскажите'
  ];
  
  for (const phrase of managerPhrases) {
    if (lowerText.includes(phrase)) return 'manager';
  }
  
  for (const phrase of clientPhrases) {
    if (lowerText.includes(phrase)) return 'client';
  }
  
  return null;
}

function parseTranscriptByPatterns(plainText) {
  const sentences = plainText.split(/(?<=[.!?])\s+/);
  const formatted = [];
  let currentSpeaker = 'manager';
  
  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    
    const detectedRole = detectRoleByContent(sentence);
    if (detectedRole) {
      currentSpeaker = detectedRole;
    }
    
    formatted.push({
      role: currentSpeaker,
      text: sentence.trim()
    });
    
    if (!detectedRole) {
      currentSpeaker = currentSpeaker === 'manager' ? 'client' : 'manager';
    }
  }
  
  return mergeConsecutiveReplicas(formatted);
}

function mergeConsecutiveReplicas(formatted) {
  if (formatted.length === 0) return [];
  
  const merged = [formatted[0]];
  
  for (let i = 1; i < formatted.length; i++) {
    const current = formatted[i];
    const last = merged[merged.length - 1];
    
    if (current.role === last.role) {
      last.text += ' ' + current.text;
      if (current.end) last.end = current.end;
    } else {
      merged.push(current);
    }
  }
  
  return merged;
}

// ==================== ИИ АНАЛИЗ ====================

async function analyzeCall(transcript, transcriptFormatted) {
  let dialogText = transcript;
  if (transcriptFormatted && transcriptFormatted.length > 0) {
    dialogText = transcriptFormatted.map(r => 
      `${r.role === 'manager' ? 'МЕНЕДЖЕР' : 'ПАЦИЕНТ'}: ${r.text}`
    ).join('\n');
  }

  const prompt = `Ты — старший аудитор колл-центра клиники **MIRAMED** (Актобе). 
Твоя задача — ОБЪЕКТИВНО оценить звонок менеджера по продажам.

**КОНТЕКСТ КЛИНИКИ:**
- Клиника специализируется на безоперационном лечении суставов и позвоночника
- Основной оффер: "Экспертная диагностика" за 9 900 ₸ (консультация врача + УЗИ двух суставов + бесплатный повторный приём)
- Цель звонка: записать пациента на диагностику

ДИАЛОГ:
${dialogText}

═══════════════════════════════════════════════════════════════
ЭТАП 1: ОПРЕДЕЛИ ТИП ЗВОНКА
═══════════════════════════════════════════════════════════════

🔵 **ПЕРВИЧНЫЙ** — новый пациент, первый контакт по заявке
🟢 **ПОВТОРНЫЙ** — повторный звонок, уточнение, перенос записи
🟡 **СЕРВИСНЫЙ** — вопросы об услугах, ценах, как добраться
⚪ **КОРОТКИЙ/НЕДОЗВОН** — клиент занят, сбросил, "перезвоните позже"

═══════════════════════════════════════════════════════════════
ЭТАП 2: ОЦЕНКА ПО БЛОКАМ СКРИПТА MIRAMED (0-100)
═══════════════════════════════════════════════════════════════

Для КАЖДОГО блока укажи балл и ПОДРОБНОЕ объяснение (2-3 предложения).

**БЛОК 1: УСТАНОВЛЕНИЕ КОНТАКТА**
Что должен сделать менеджер:
- Поздороваться, назвать имя клиента
- Представиться: "Меня зовут [Имя], клиника Miramed"
- Подтвердить заявку: "Вы оставляли заявку по поводу лечения суставов без операции?"
- Спросить удобно ли говорить
- ПРОГРАММИРОВАНИЕ: объяснить что сейчас задаст пару вопросов, чтобы подобрать специалиста

**БЛОК 2: ВЫЯВЛЕНИЕ БОЛИ (Усиление)**
Что должен сделать менеджер:
- Выяснить что беспокоит (колено, спина, тазобедренный)
- Уточнить характер боли (острая/ноющая) и как давно
- УСИЛИТЬ БОЛЬ: спросить мешает ли в быту (лестница, ходьба, хромота)
- Дать клиенту выговориться о проблеме

**БЛОК 3: ПРЕЗЕНТАЦИЯ РЕШЕНИЯ**
Что должен сделать менеджер:
- Проявить эмпатию: "Понимаю, жить с такой болью тяжело"
- Объяснить специализацию: безоперационное восстановление суставов
- Презентовать оффер "Экспертная диагностика":
  1) Консультация врача-ортопеда
  2) УЗИ двух суставов (больного и здорового для сравнения)
  3) Бесплатный повторный приём в течение недели
- Назвать цену: 9 900 ₸ (вместо ~25 000 ₸)
- Объяснить ценность: "Получите честный прогноз — можно ли спасти сустав"

**БЛОК 4: ЗАПИСЬ (Выбор без выбора)**
Что должен сделать менеджер:
- НЕ спрашивать "Хотите записаться?" 
- Сразу предложить 2 варианта времени: "Есть среда в 11:00 или четверг в 16:30"
- Зафиксировать выбор клиента
- Уточнить конкретное время

**БЛОК 5: ОТРАБОТКА ВОЗРАЖЕНИЙ**
(Оценивать только если были возражения, иначе ставить 80)
Типичные возражения и как отрабатывать:
- "Дорого" → сравнить с ценами в городе (~20 000 ₸), объяснить что всё включено
- "Подумаю" → предложить предварительную бронь, напомнить про акцию
- "Не поможет, везде был" → объяснить что это только диагностика, честный прогноз
- "В поликлинике бесплатно" → напомнить про очереди (месяц ждать), а боль сейчас

**БЛОК 6: ФИНАЛИЗАЦИЯ**
Что должен сделать менеджер:
- Взять ФИО и дату рождения
- Подтвердить дату, время, адрес клиники
- Напомнить цену 9 900 ₸ и что входит
- Попросить взять удостоверение личности
- Попросить прийти за 10-15 минут
- Спросить про WhatsApp для отправки геолокации
- Попрощаться, попросить предупредить если планы изменятся

═══════════════════════════════════════════════════════════════
ЭТАП 3: ИНФОРМАЦИЯ О ПАЦИЕНТЕ
═══════════════════════════════════════════════════════════════

Извлеки из разговора:

**ФАКТЫ:**
- Имя пациента
- Что беспокоит (колено/спина/тазобедренный)
- Как давно болит
- Был ли раньше в клинике или у других врачей
- На какое время записался

**ПОТРЕБНОСТИ:**
- Диагностика или лечение
- Срочность (сильная боль или терпимо)
- Какой результат хочет получить

**БОЛИ (физические и эмоциональные):**
- Что конкретно болит, какая боль
- Как мешает в быту (хромота, лестница, не может долго ходить)
- Эмоциональное состояние (устал от боли, отчаялся)

**ВОЗРАЖЕНИЯ:**
- По цене
- По времени ("подумаю", "посоветуюсь")
- Недоверие ("не поможет", "везде был")
- Другие

═══════════════════════════════════════════════════════════════
ПРАВИЛА ОЦЕНКИ:
═══════════════════════════════════════════════════════════════

- Для КОРОТКОГО/НЕДОЗВОНА: ставь 70 баллов за все блоки, это не вина менеджера
- Если возражений НЕ было: блок 5 = 80 баллов
- Если клиент САМ отказался без возражений: не снижай баллы за блок 5
- total_score = среднее арифметическое всех 6 блоков
- is_successful = true если клиент записался на приём

═══════════════════════════════════════════════════════════════
ФОРМАТ ОТВЕТА (строго JSON):
═══════════════════════════════════════════════════════════════

{
  "call_type": "ПЕРВИЧНЫЙ" | "ПОВТОРНЫЙ" | "СЕРВИСНЫЙ" | "КОРОТКИЙ",
  
  "block1_score": число 0-100,
  "block1_explanation": "Подробное объяснение: что сделал хорошо, что упустил...",
  
  "block2_score": число 0-100,
  "block2_explanation": "Подробное объяснение...",
  
  "block3_score": число 0-100,
  "block3_explanation": "Подробное объяснение...",
  
  "block4_score": число 0-100,
  "block4_explanation": "Подробное объяснение...",
  
  "block5_score": число 0-100,
  "block5_explanation": "Подробное объяснение...",
  
  "block6_score": число 0-100,
  "block6_explanation": "Подробное объяснение...",
  
  "total_score": число (среднее 6 блоков, округлить),
  
  "client_info": {
    "facts": ["факт 1", "факт 2", ...],
    "needs": ["потребность 1", ...],
    "pains": ["боль 1", ...],
    "objections": ["возражение 1", ...] или [] если не было
  },
  
  "ai_summary": "Краткое резюме: тип звонка, что произошло, результат. 2-3 предложения.",
  "is_successful": true/false
}

ВАЖНО: Возвращай ТОЛЬКО валидный JSON, без markdown и комментариев!`;

  try {
    const response = await axios.post(GOOGLE_PROXY_URL, {
      type: 'chat',
      apiKey: OPENAI_API_KEY,
      model: 'gpt-4o',
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }]
    }, {
      timeout: 120000
    });

    if (response.data.error) {
      throw new Error(response.data.error.message || response.data.error);
    }

    const content = response.data.choices[0].message.content;
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Не удалось извлечь JSON из ответа');
    }

    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('Analysis error:', error.message);
    throw error;
  }
}

async function analyzeCallById(callId) {
  const { data: call, error: callError } = await supabase
    .from('calls')
    .select('*')
    .eq('id', callId)
    .single();

  if (callError || !call) {
    throw new Error('Звонок не найден');
  }

  if (!call.audio_url) {
    throw new Error('У звонка нет аудиозаписи');
  }

  console.log(`🎤 Transcribing call ${callId}...`);
  const { plain: transcript, formatted: transcriptFormatted } = await transcribeAudioDualChannel(call.audio_url);

  await supabase.from('calls').update({ 
    transcript,
    transcript_formatted: transcriptFormatted
  }).eq('id', callId);

  console.log(`🤖 Analyzing call ${callId}...`);
  const analysis = await analyzeCall(transcript, transcriptFormatted);

  const scoreData = {
    call_id: callId,
    call_type: analysis.call_type,
    total_score: Math.round(analysis.total_score),
    
    greeting_score: Math.round(analysis.block1_score),
    classification_score: Math.round(analysis.block2_score),
    offer_score: Math.round(analysis.block3_score),
    closing_score: Math.round(analysis.block5_score),
    
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
  };

  const { error: scoreError } = await supabase.from('call_scores').upsert(scoreData, { onConflict: 'call_id' });

  if (scoreError) {
    console.error(`❌ Error saving scores for call ${callId}:`, scoreError);
    throw new Error('Ошибка сохранения оценок: ' + scoreError.message);
  }

  console.log(`✅ Call ${callId} analyzed: ${analysis.total_score}/100`);
  
  return { transcript, transcriptFormatted, analysis };
}

app.post('/api/analyze/:callId', async (req, res) => {
  const { callId } = req.params;

  try {
    const result = await analyzeCallById(callId);
    
    res.json({
      success: true,
      call_id: callId,
      transcript: result.transcript.substring(0, 500) + '...',
      analysis: result.analysis
    });

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze-all', async (req, res) => {
  try {
    const { data: calls } = await supabase
      .from('calls')
      .select('id, audio_url')
      .not('audio_url', 'is', null)
      .not('audio_url', 'eq', '');

    const { data: scoredCalls } = await supabase
      .from('call_scores')
      .select('call_id');

    const scoredIds = new Set(scoredCalls?.map(s => s.call_id) || []);
    const unanalyzedCalls = calls?.filter(c => !scoredIds.has(c.id)) || [];

    res.json({
      total_with_audio: calls?.length || 0,
      already_analyzed: scoredIds.size,
      pending_analysis: unanalyzedCalls.length,
      pending_call_ids: unanalyzedCalls.map(c => c.id)
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ДАННЫЕ ИЗ SUPABASE ====================

app.get('/api/managers', async (req, res) => {
  const { data, error } = await supabase.from('managers').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/calls', async (req, res) => {
  try {
    const { data: calls, error: callsError } = await supabase
      .from('calls')
      .select(`*, manager:managers(name)`)
      .order('call_date', { ascending: false });
    
    if (callsError) throw callsError;
    
    const { data: allScores, error: scoresError } = await supabase
      .from('call_scores')
      .select('*');
    
    if (scoresError) throw scoresError;
    
    const scoresMap = {};
    for (const score of allScores || []) {
      scoresMap[score.call_id] = score;
    }
    
    const transformed = calls.map(call => ({
      ...call,
      scores: scoresMap[call.id] || null
    }));
    
    res.json(transformed);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calls/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: call, error: callError } = await supabase
      .from('calls')
      .select(`*, manager:managers(name)`)
      .eq('id', id)
      .single();
    
    if (callError) throw callError;
    
    const { data: scores } = await supabase
      .from('call_scores')
      .select('*')
      .eq('call_id', id)
      .single();
    
    res.json({
      ...call,
      scores: scores || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const { count: totalCalls } = await supabase.from('calls').select('*', { count: 'exact', head: true });
    const { data: scores } = await supabase.from('call_scores').select('total_score');
    const avgScore = scores?.length ? Math.round(scores.reduce((a, b) => a + b.total_score, 0) / scores.length) : 0;
    const { count: successfulCalls } = await supabase.from('call_scores').select('*', { count: 'exact', head: true }).gte('total_score', 80);
    const { count: analyzedCalls } = await supabase.from('call_scores').select('*', { count: 'exact', head: true });
    const { count: totalManagers } = await supabase.from('managers').select('*', { count: 'exact', head: true });

    res.json({
      totalCalls: totalCalls || 0,
      avgScore,
      successfulCalls: successfulCalls || 0,
      analyzedCalls: analyzedCalls || 0,
      totalManagers: totalManagers || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== WHATSAPP (ЗАГЛУШКА) ====================

app.get('/api/whatsapp/chats', async (req, res) => {
  res.json({ success: true, count: 0, chats: [], message: 'WhatsApp интеграция в разработке' });
});

app.get('/api/whatsapp/analyses', async (req, res) => {
  res.json({ success: true, count: 0, analyses: [], stats: {}, message: 'WhatsApp интеграция в разработке' });
});

// ==================== ЗАПУСК ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🏥 Clinic CallMind сервер запущен на порту ${PORT}`);
  console.log(`🤖 ИИ-анализ: ${GOOGLE_PROXY_URL ? 'включён' : 'выключен'}`);
  
  const loaded = await loadTokensFromDb();
  if (loaded) {
    console.log('🔑 Битрикс токены загружены из базы');
    
    setInterval(async () => {
      try {
        console.log('🔄 Автосинхронизация звонков...');
        await syncNewCalls();
      } catch (e) {
        console.error('Ошибка автосинхронизации:', e.message);
      }
    }, 5 * 60 * 1000);
    
    console.log('⏰ Автосинхронизация включена (каждые 5 минут)');
    setTimeout(() => syncNewCalls(), 30000);
  } else {
    console.log('⚠️ Токены не найдены — требуется авторизация');
  }
});
