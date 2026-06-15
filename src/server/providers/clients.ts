import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { loadConfig } from "../config.ts";
import { log } from "../log.ts";

let openaiClient: OpenAI | null = null;
let geminiClient: GoogleGenAI | null = null;

/** Reused OpenAI client. A single OPENAI_API_KEY drives STT, director, dialogue, TTS. */
export function openai(): OpenAI {
  const cfg = loadConfig();
  if (!cfg.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: cfg.openaiApiKey });
  }
  return openaiClient;
}

export function openaiKey(): string {
  const cfg = loadConfig();
  if (!cfg.openaiApiKey) throw new Error("OPENAI_API_KEY is not set");
  return cfg.openaiApiKey;
}

/** Reused Gemini client; only available when GEMINI_API_KEY is set. */
export function gemini(): GoogleGenAI {
  const cfg = loadConfig();
  if (!cfg.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set (required for gemini: models)");
  }
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: cfg.geminiApiKey });
  }
  return geminiClient;
}

export function hasGemini(): boolean {
  return !!loadConfig().geminiApiKey;
}

/** Warn early if the configuration references Gemini without a key. */
export function validateProviderKeys(): void {
  const cfg = loadConfig();
  if (!cfg.openaiApiKey) {
    log.warn("OPENAI_API_KEY is not set — STT/director/dialogue/TTS will fail until provided.");
  }
  const usesGemini = [cfg.directorModel, cfg.dialogueModel].some((m) => m.provider === "gemini");
  if (usesGemini && !cfg.geminiApiKey) {
    log.warn("A gemini: model is configured but GEMINI_API_KEY is not set.");
  }
}
