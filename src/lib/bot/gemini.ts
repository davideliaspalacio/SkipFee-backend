import { GoogleGenAI } from '@google/genai';
import { env } from '@/lib/env';

let _client: GoogleGenAI | null = null;

export function gemini(): GoogleGenAI {
  if (_client) return _client;
  _client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return _client;
}

export function geminiModel(): string {
  return env.GEMINI_MODEL;
}
