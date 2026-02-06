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

Clinic CallMind AI v5.0 - An AI-powered call analytics system for Miramed clinic (Aktobe, Kazakhstan). Analyzes medical consultation phone calls in Kazakh/Russian, transcribes and translates them, and scores call quality against a defined sales script.

**Core Value Proposition**: Automated quality assurance for clinic call center operations using stereo audio channel separation and GPT-4o analysis.

## Architecture

### Two-Tier Structure

1. **Backend** (`backend/`) - Node.js/Express API server
2. **Frontend** (`frontend/`) - Static single-page application (no build step)

### Key Data Flow

```
Bitrix24 Call → Webhook → Backend Sync → Audio Download
→ Stereo Split (ffmpeg) → gpt-4o-transcribe (×2 channels)
→ GPT-4o Translation + Dialogue Reconstruction → GPT-4o Analysis → Supabase Storage
→ Frontend Display
```

### Backend Architecture

**Core Pipeline** ([backend/index.js](backend/index.js)):
- **Transcription**: Uses `gpt-4o-transcribe` model (better WER for Kazakh than whisper-1: 36% vs 43%)
- **Stereo Processing**: ffmpeg splits audio into left (patient) and right (admin) channels
- **Translation**: GPT-4o translates Kazakh/Russian mixed speech to clean Russian
- **Analysis**: GPT-4o scores calls against 6-block sales script rubric

**Integration Points**:
- Bitrix24 OAuth + REST API for call data/CRM
- Supabase for persistent storage (calls, managers, scores)
- OpenAI API via GOOGLE_PROXY_URL

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

### Transcription Strategy (Lines 225-574)

**Why gpt-4o-transcribe over whisper-1**:
- 7% better WER on Kazakh language (research: MDPI July 2025)
- Better handling of code-switching (Kazakh+Russian in same sentence)
- Limitation: No `verbose_json` or segments support (only `json` and `text`)

**Dialogue Reconstruction Format v5.1**: GPT-4o reconstructs turn-by-turn dialogue from two separate audio channels, returning an array of utterances with roles (manager/client). GPT-4o infers the logical order of utterances based on question-answer patterns and conversational context, then translates each utterance to Russian.

**Whisper Prompt** (lines 48-56):
- NOT instructions but "prior context" - Whisper continues this style
- Contains realistic medical call opening in Kazakh to guide transcription
- Includes common medical terms and clinic-specific phrases

### Stereo Channel Processing (Lines 249-287)

**Function**: `splitStereoChannels()`
- Left channel = patient, Right channel = admin
- Converts to WAV 16kHz mono for better transcription quality
- Fallback to mono mode if audio has <2 channels or ffmpeg unavailable
- Uses temp files in OS tmpdir, cleaned up in finally block

### Call Scoring System (Lines 576-741)

**6-Block Sales Script Analysis**:
1. Contact Establishment + Programming (0-100 pts) - includes Stage 1.5: taking initiative with client consent
2. Pain Point Discovery + Amplification (0-100 pts) - what hurts, how, and impact on daily life
3. Offer Presentation (0-100 pts) - detailed "Expert Diagnostics" with 3 components (consultation + 2-joint ultrasound + free follow-up)
4. Appointment Booking (0-100 pts) - "choice without choice" technique, no "do you want to book?" question
5. Objection Handling (0-100 pts, default 80 if no objections) - 4 standard objections with scripted responses
6. Finalization (0-100 pts) - full data collection (name, DOB, date/time, address, sum, ID reminder, WhatsApp geolocation)

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
- **Medical Terminology**: See Kazakh→Russian dictionary in system prompts (lines 342-357, 430-434)
- **Clinic Specifics**: Miramed clinic, 9,900 KZT diagnostic package, joint/spine treatment

### Audio Processing

- **ffmpeg Dependency**: Required for stereo mode. Graceful fallback to mono if unavailable
- **Supported Formats**: MP3 input, WAV 16kHz output for transcription
- **Channel Assignment**: Left=patient, Right=admin (Bitrix24 standard for clinic calls)

### API Limitations

- **OpenAI Timeout**: 180s for transcription, 120s for translation/analysis
- **gpt-4o-transcribe**: No segments or timestamps (returns plain text only)
- **Rate Limits**: Sequential processing (no parallel analysis of multiple calls)

## Common Development Patterns

### Adding New Analysis Criteria

1. Update system prompt in `analyzeCall()` function (lines 585-698)
2. Add new block score field to JSON schema (line 705-722)
3. Update frontend block rendering in `renderBlockWithExplanation()` (lines 939-962)
4. Sync Supabase schema: add column to `call_scores` table

### Modifying Transcription

- **Language**: Change `language: 'kk'` parameter (line 307, 542)
- **Prompt**: Modify `WHISPER_PROMPT_KK` constant (lines 48-56)
- **Model**: Replace `gpt-4o-transcribe` string (lines 306, 541)

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

- Transcription pipeline: lines 489-574
- GPT-4o analysis system prompt: lines 585-698
- Stereo channel split: lines 250-287
- Bitrix sync logic: lines 167-194
- Frontend modal rendering: lines 768-937
