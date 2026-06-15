import { ThinkingLevel, type ThinkingConfig } from "@google/genai";
import type { TranscriptEntry } from "../../shared/types.ts";

/** OpenAI reasoning-capable families (gpt-5*, o-series). Non-reasoning otherwise. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o[0-9])/i.test(model);
}

/** Map GEMINI_THINKING_LEVEL to the SDK enum; minimize thinking for latency. */
export function geminiThinking(level: string): ThinkingConfig {
  const up = level.trim().toUpperCase();
  const map: Record<string, ThinkingLevel> = {
    MINIMAL: ThinkingLevel.MINIMAL,
    LOW: ThinkingLevel.LOW,
    MEDIUM: ThinkingLevel.MEDIUM,
    HIGH: ThinkingLevel.HIGH,
  };
  return { thinkingLevel: map[up] ?? ThinkingLevel.MINIMAL, includeThoughts: false };
}

export interface RoledLine {
  speaker: string; // character id, or "human"
  name: string;
  text: string;
}

/** Build OpenAI chat messages: this character = assistant, everyone else = user. */
export function toOpenAiMessages(
  selfId: string,
  lines: RoledLine[],
): { role: "assistant" | "user"; content: string }[] {
  const out: { role: "assistant" | "user"; content: string }[] = [];
  for (const l of lines) {
    if (l.speaker === selfId) {
      out.push({ role: "assistant", content: l.text });
    } else {
      out.push({ role: "user", content: `${l.name}: ${l.text}` });
    }
  }
  return out;
}

/** Build Gemini contents: this character = model, everyone else = user. */
export function toGeminiContents(
  selfId: string,
  lines: RoledLine[],
): { role: "user" | "model"; parts: { text: string }[] }[] {
  return lines.map((l) =>
    l.speaker === selfId
      ? { role: "model" as const, parts: [{ text: l.text }] }
      : { role: "user" as const, parts: [{ text: `${l.name}: ${l.text}` }] },
  );
}

export function transcriptToLines(entries: TranscriptEntry[]): RoledLine[] {
  return entries.map((e) => ({ speaker: e.speaker, name: e.name, text: e.text }));
}
