# Telegram Voice Transcription via ElevenLabs Scribe

## Goal

Enable NanoClaw's Telegram bot to transcribe incoming voice notes using ElevenLabs Scribe API, so the agent receives text instead of `[Voice message]` placeholder.

## Architecture

Voice note arrives in Telegram → host downloads `.ogg` file via Grammy API → sends to ElevenLabs Scribe API → receives transcript → delivers to agent as `[Voice: transcript]`.

All processing happens on the host side (in `telegram.ts`), before the message reaches the container. The agent works with text only — no changes to container/agent-runner.

## Components

### 1. `src/transcription.ts` (new file)

- `transcribeAudio(buffer: Buffer): Promise<string>`
- HTTP POST to `https://api.elevenlabs.io/v1/speech-to-text` (multipart/form-data)
- Sends OGG buffer as file upload with `model_id: "scribe_v1"`
- Returns transcribed text
- Reads `ELEVENLABS_API_KEY` from environment

### 2. `src/channels/telegram.ts` (modify)

- Change voice message handler: instead of `storeNonText(ctx, '[Voice message]')`, download the file and transcribe it
- Download flow: `ctx.getFile()` → fetch from `https://api.telegram.org/file/bot<token>/<file_path>`
- On success: store message as `[Voice: <transcript>]`
- On failure: fallback to `[Voice message]` with warning log

### 3. `.env` (add key)

- `ELEVENLABS_API_KEY` — required for transcription, graceful degradation if missing

## Data Flow

```
User sends voice note
  → Grammy receives ctx.message.voice
  → bot.api.getFile(voice.file_id)
  → fetch OGG from Telegram CDN
  → transcribeAudio(buffer)
  → ElevenLabs Scribe API returns text
  → message stored as "[Voice: <transcript>]"
  → agent receives text via normal message flow
```

## Error Handling

- No API key configured → `[Voice message]` (current behavior, no change)
- ElevenLabs API error/timeout → `[Voice message]` + warning log
- File download failure → `[Voice message]` + warning log

## Scope

- Voice notes only (not audio files, video notes, or documents)
- Host-side transcription (not in container)
- Ukrainian and Russian language support (Scribe auto-detects, supports 99 languages)

## Cost

- ElevenLabs Scribe: ~$0.40/hour of audio
- Typical voice note (30s): ~$0.003
