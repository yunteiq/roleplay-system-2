import type {
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { loadConfig } from "../config.ts";
import { openai, gemini } from "./clients.ts";
import { isReasoningModel, geminiThinking } from "./llm.ts";
import { log, errMsg } from "../log.ts";

export interface DirectorCandidate {
  id: string;
  name: string;
  persona: string;
}

export interface DirectorRequest {
  setting: string;
  history: string;
  latest: string;
  speakerName: string;
  candidates: DirectorCandidate[];
  /** true: routing a human line, must choose someone. false: NPC continuation, may yield. */
  mustPick: boolean;
  signal?: AbortSignal;
}

function buildPrompt(req: DirectorRequest): { system: string; user: string } {
  const roster = req.candidates
    .map((c) => `- id=${c.id} name="${c.name}" — ${c.persona.slice(0, 120)}`)
    .join("\n");

  const yieldRule = req.mustPick
    ? `You MUST pick exactly one character id from the roster.`
    : `If no character should jump in and control should return to the human, use "none".`;

  const system =
    `You are a fast theater director routing a live conversation. ` +
    `Decide which ONE character should speak next. ` +
    `Reply with JSON only, no prose: {"speaker":"<id-or-none>"}. ` +
    yieldRule +
    ` Prefer the character directly addressed or most relevant to the latest line.`;

  const user =
    `Setting: ${req.setting || "(none)"}\n\n` +
    `Characters:\n${roster}\n\n` +
    `Recent conversation:\n${req.history || "(empty)"}\n\n` +
    `Latest line by ${req.speakerName}: "${req.latest}"\n\n` +
    `Who speaks next? JSON only.`;

  return { system, user };
}

function parseChoice(content: string, candidates: DirectorCandidate[]): string | null {
  const ids = new Set(candidates.map((c) => c.id));
  let speaker: string | null = null;
  try {
    const obj = JSON.parse(content) as { speaker?: unknown };
    if (typeof obj.speaker === "string") speaker = obj.speaker;
  } catch {
    // Lenient fallback: find any candidate id mentioned in the raw text.
    for (const c of candidates) {
      if (content.includes(c.id)) return c.id;
    }
  }
  if (!speaker) return null;
  if (speaker === "none" || speaker === "human" || speaker === "") return null;
  if (ids.has(speaker)) return speaker;
  // Model may have returned a name instead of an id.
  const byName = candidates.find((c) => c.name.toLowerCase() === speaker!.toLowerCase());
  return byName ? byName.id : null;
}

async function openaiDirector(
  model: string,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const client = openai();
  const params: ChatCompletionCreateParamsNonStreaming = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
  };
  if (isReasoningModel(model)) {
    params.reasoning_effort = "minimal";
    params.max_completion_tokens = 60;
  } else {
    params.temperature = 0;
    params.max_tokens = 60;
  }
  const resp = await client.chat.completions.create(params, { signal });
  return resp.choices[0]?.message?.content ?? "";
}

async function geminiDirector(
  model: string,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const cfg = loadConfig();
  const ai = gemini();
  const resp = await ai.models.generateContent({
    model,
    contents: user,
    config: {
      systemInstruction: system,
      responseMimeType: "application/json",
      thinkingConfig: geminiThinking(cfg.geminiThinkingLevel),
      maxOutputTokens: 200,
      temperature: 0,
      abortSignal: signal,
    },
  });
  return resp.text ?? "";
}

/**
 * Pick the next speaker. Returns a character id, or null to yield to the human.
 * Errors are logged and surfaced as null so the scene can fall back gracefully.
 */
export async function runDirector(req: DirectorRequest): Promise<string | null> {
  if (req.candidates.length === 0) return null;
  if (req.candidates.length === 1 && req.mustPick) return req.candidates[0]!.id;

  const cfg = loadConfig();
  const model = cfg.directorModel;
  const { system, user } = buildPrompt(req);

  try {
    const content =
      model.provider === "gemini"
        ? await geminiDirector(model.model, system, user, req.signal)
        : await openaiDirector(model.model, system, user, req.signal);
    return parseChoice(content, req.candidates);
  } catch (e) {
    if (req.signal?.aborted) return null;
    log.error("director:", errMsg(e));
    return null;
  }
}
