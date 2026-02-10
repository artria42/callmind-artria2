# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Инструкции

- Всегда отвечать на русском языке
- Писать комментарии в коде на русском
- Объяснять ошибки и предложения на русском
- Используй Sequential Thinking для сложных размышлений
- Никогда не используй наследование, присваивание классу внешних функций, рефлексию и другие сложные техники. Код должен быь понятен Junior разработчику с минимальным опытом
- Используй Context7 для досткупа к документации всех библиотек
- Для реализации любых фич с использованием интеграций с внешним api/библиотеками изучай документации с помощью Context7 инструментов
- Если есть изменения на фронтенде, то проверь что фронт работает, открыв его через Playwright

## Project Overview

Clinic CallMind AI v6.0 - An AI-powered call analytics system for Miramed clinic (Aktobe, Kazakhstan). Analyzes medical consultation phone calls in Kazakh/Russian, transcribes and translates them, and scores call quality against a defined sales script.

**Core Value Proposition**: Automated quality assurance for clinic call center operations using Soniox STT (WER 9% on Kazakh) with stereo channel separation and GPT-4o analysis.

## Architecture

### Two-Tier Structure

1. **Backend** (`backend/`) - Node.js/Express API server
2. **Frontend** (`frontend/`) - Static single-page application (no build step)

### Key Data Flow

```
Bitrix24 Call → Webhook → Backend Sync → Audio Download
→ Stereo Split (ffmpeg) → Soniox STT ×2 channels (transcribe + translate kk→ru)
→ Merge by timestamps → Interleaved dialog → GPT-4o Analysis → Supabase Storage
→ Frontend Display (alternating manager/client replicas)
```

### Backend Architecture

**Core Pipeline** ([backend/index.js](backend/index.js)):
- **Transcription**: Uses Soniox STT API (WER 9% on Kazakh — best in class, $0.10/hour)
- **Stereo Processing**: ffmpeg splits audio into left (patient) and right (admin) channels
- **Translation**: Built-in Soniox one-way translation kk→ru (no separate GPT-4o call needed)
- **Dialog Assembly**: Word-level timestamps from Soniox → group into replicas by pauses → merge channels by time
- **Analysis**: GPT-4o scores calls against 4-block sales script rubric

**Integration Points**:
- Bitrix24 OAuth + REST API for call data/CRM
- Supabase for persistent storage (calls, managers, scores)
- Soniox STT API for transcription + translation
- OpenAI API via GOOGLE_PROXY_URL (for analysis only)

**Database Schema** (Supabase):
- `calls` - call metadata, audio URLs, transcripts
- `managers` - Bitrix24 user sync
- `call_scores` - 6-block analysis results
- `settings` - Bitrix tokens storage

### Frontend Architecture

Single HTML file ([frontend/index.html](frontend/index.html)) with:
- Vanilla JavaScript (no framework)
- Tailwind CSS (CDN)
- Lucide icons
- Three main screens: Dashboard, Calls, Team ranking

## Development Commands

### Backend

```bash
cd backend
npm install
npm start        # Production mode
npm run dev      # Development mode (same as start)
```

**Environment Setup**: Create `backend/.env` with:
```
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
BITRIX_DOMAIN=
BITRIX_CLIENT_ID=
BITRIX_CLIENT_SECRET=
GOOGLE_PROXY_URL=
OPENAI_API_KEY=
SONIOX_API_KEY=
PORT=3000
```

### Frontend

No build required. Open [frontend/index.html](frontend/index.html) in browser or serve with:
```bash
cd frontend
python3 -m http.server 8000
```

Update `API_URL` constant in index.html (line 34) to point to backend.

### Docker

```bash
cd backend
docker build -t callmind .
docker run -p 3000:3000 --env-file .env callmind
```

**Note**: Dockerfile installs ffmpeg for stereo channel separation.

## Key Implementation Details

### Transcription Strategy (Soniox STT v6.0)

**Why Soniox over gpt-4o-transcribe/whisper-1**:
- WER 9% on Kazakh (vs 36% gpt-4o-transcribe, vs 43% whisper-1) — best in class
- Built-in speaker diarization (up to 15 speakers)
- Word-level timestamps for dialog reconstruction
- Built-in translation kk→ru (no separate GPT-4o call needed)
- Code-switching kk/ru detected per-word automatically
- Cost: $0.10/hour (vs $0.36/hour for OpenAI)

**Dialog Output Format v6.0**: Soniox returns word-level tokens with timestamps, speaker IDs, and language tags. Tokens are grouped into replicas by pauses (>1.5s threshold), then merged from both channels by start_ms timestamps. Result: interleaved dialog `[{role: 'manager', text: '...'}, {role: 'client', text: '...'}, ...]`.

**Context Terms**: Soniox supports `context.terms` (boost recognition of specific words like "Мирамед", "УЗИ") and `context.translation_terms` (custom kk→ru dictionary for medical terms).

### Stereo Channel Processing

**Function**: `splitStereoChannels()`
- Left channel = patient, Right channel = admin (swapped for outgoing calls)
- Converts to WAV 16kHz mono for Soniox upload
- Fallback to mono mode with Soniox diarization if audio has <2 channels or ffmpeg unavailable
- Uses temp files in OS tmpdir, cleaned up in finally block

### Call Scoring System (4-Block Sales Script)

**4-Block Sales Script Analysis**:
1. Programming + Pain Discovery (20%) - taking initiative, qualifying pain points
2. Value Presentation (30%) - price fork, USDs of 2 joints, free follow-up bonus
3. Closing + Booking (40%) - "choice without choice" technique, objection handling
4. Organization (10%) - full data collection (name, DOB, location, ID reminder)

**Scoring Logic**: GPT-4o receives full sales script as system prompt with detailed rubrics. Returns structured JSON with per-block scores and explanations.

**Call Types**:
- ПЕРВИЧНЫЙ (primary)
- ПОВТОРНЫЙ (follow-up)
- СЕРВИСНЫЙ (service)
- КОРОТКИЙ (short/missed call - all scores = 0)

### Bitrix24 Integration

**OAuth Flow**:
- `/api/bitrix/auth` - returns authorization URL
- `/api/bitrix/callback` - exchanges code for tokens
- Tokens stored in Supabase `settings` table
- Auto-refresh on `expired_token` error

**Webhook Handlers**:
- `ONVOXIMPLANTCALLEND` event triggers `syncNewCalls()` with 5s delay
- Polls Bitrix API for calls from last 2 hours
- Auto-analyzes new calls with audio URLs

**Sync Schedule**:
- Initial sync 30s after server start
- Every 5 minutes thereafter (if tokens exist)

## Critical Constraints

### Language-Specific

- **Primary Languages**: Kazakh and Russian (often code-switched in single call)
- **Medical Terminology**: See Kazakh→Russian dictionary in Soniox `context.translation_terms` (sonioxCreateTranscription function)
- **Clinic Specifics**: Miramed clinic, 9,900 KZT diagnostic package, joint/spine treatment

### Audio Processing

- **ffmpeg Dependency**: Required for stereo mode. Graceful fallback to mono if unavailable
- **Supported Formats**: MP3 input, WAV 16kHz output for transcription
- **Channel Assignment**: Left=patient, Right=admin (Bitrix24 standard for clinic calls)

### API Limitations

- **Soniox**: Max file 1 GB, async API with polling (3s intervals, 5min timeout)
- **OpenAI Timeout**: 180s for analysis
- **Rate Limits**: Sequential processing (no parallel analysis of multiple calls)

## Common Development Patterns

### Adding New Analysis Criteria

1. Update system prompt in `analyzeCall()` function (lines 585-698)
2. Add new block score field to JSON schema (line 705-722)
3. Update frontend block rendering in `renderBlockWithExplanation()` (lines 939-962)
4. Sync Supabase schema: add column to `call_scores` table

### Modifying Transcription

- **Languages**: Change `language_hints` array in `sonioxCreateTranscription()`
- **Context Terms**: Add medical terms to `context.terms` array for better recognition
- **Translation Dictionary**: Add kk→ru pairs to `context.translation_terms`
- **Pause Threshold**: Adjust `pauseThresholdMs` parameter in `groupTokensIntoReplicas()` (default 1500ms)

### Adding New API Endpoints

Follow pattern: Express route → call Supabase/Bitrix → return JSON
Example at lines 777-812 (managers, calls endpoints)

## Testing Approach

No automated tests currently. Manual testing workflow:

1. **Bitrix Connection**: GET `/api/bitrix/status` should show `connected: true`
2. **Call Sync**: POST to `/api/bitrix/calls` to trigger manual sync
3. **Analysis**: POST `/api/analyze/:callId` to process single call
4. **View Results**: GET `/api/calls/:id` to see scores

**Debugging Transcription**: Raw text logged to console before translation (lines 327-333)

## Deployment Notes

- **Platform**: Designed for Railway (see `API_URL` in frontend/index.html:34)
- **Port**: Uses `process.env.PORT || 3000`
- **ffmpeg**: Must be available in production environment (included in Dockerfile)
- **Startup**: Loads Bitrix tokens from DB on start (line 834)

## Important Code Locations

- Soniox API functions (upload, transcribe, poll, get, delete): ~lines 500-680
- Token processing (groupTokensIntoReplicas, mergeChannelReplicas, groupMonoTokensIntoDialog): ~lines 680-900
- Main transcribeAudio() pipeline: ~lines 900-990
- GPT-4o analysis system prompt: analyzeCall() function
- Stereo channel split: splitStereoChannels() function
- Bitrix sync logic: syncNewCalls() function
- Frontend modal rendering: showCallDetail() in frontend/index.html
