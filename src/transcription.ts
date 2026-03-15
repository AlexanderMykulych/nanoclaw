/**
 * Audio transcription via ElevenLabs Scribe API.
 */
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

let apiKey: string | undefined;

function getApiKey(): string | undefined {
  if (apiKey !== undefined) return apiKey || undefined;
  apiKey =
    process.env.ELEVENLABS_API_KEY ||
    readEnvFile(['ELEVENLABS_API_KEY']).ELEVENLABS_API_KEY ||
    '';
  return apiKey || undefined;
}

export function isTranscriptionAvailable(): boolean {
  return !!getApiKey();
}

/**
 * Transcribe audio buffer using ElevenLabs Scribe API.
 * Returns the transcribed text, or throws on failure.
 */
export async function transcribeAudio(
  buffer: Buffer,
  filename: string = 'voice.ogg',
): Promise<string> {
  const key = getApiKey();
  if (!key) throw new Error('ELEVENLABS_API_KEY not configured');

  const boundary = `----NanoClawBoundary${Date.now()}`;
  const parts: Buffer[] = [];

  // model_id field
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\nscribe_v1\r\n`,
    ),
  );

  // file field
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`,
    ),
  );
  parts.push(buffer);
  parts.push(Buffer.from('\r\n'));

  // closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const response = await fetch(ELEVENLABS_STT_URL, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`ElevenLabs API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { text?: string };
  if (!data.text) {
    throw new Error('ElevenLabs returned empty transcription');
  }

  return data.text.trim();
}
