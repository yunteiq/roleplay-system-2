import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import { loadConfig } from "../config.ts";
import { openai, gemini } from "./clients.ts";
import {
  isReasoningModel,
  geminiThinking,
  toOpenAiMessages,
  toGeminiContents,
  type RoledLine,
} from "./llm.ts";

export interface DialogueCharacter {
  id: string;
  name: string;
  persona: string;
  secret?: string;
}

export interface DialogueRequest {
  setting: string;
  character: DialogueCharacter;
  lines: RoledLine[];
  signal: AbortSignal;
}

function systemPrompt(setting: string, c: DialogueCharacter): string {
  const parts = [
    `You are ${c.name}.`,
    c.persona ? `Persona: ${c.persona}` : "",
    setting ? `Scene setting: ${setting}` : "",
    c.secret ? `Secret knowledge (reveal only if it arises naturally, never list it): ${c.secret}` : "",
    "",
    "You are speaking aloud in realtime through text-to-speech.",
    "Start with a very short first phrase, 1-6 words.",
    "Then continue in concise, speakable chunks.",
    "Do not rely on later text to complete the first phrase.",
    "Avoid long opening clauses. Avoid filler unless it fits your character.",
    "Do not revise text you already said. Stay fully in character.",
    "Keep replies short and conversational, like real speech.",
    "Speak in 1-2 sentences unless explicitly asked for more detail.",
    "Maximum 80 words per response.",
    "Output only spoken words — no stage directions, names, or markdown.",
  ];
  return parts.filter(Boolean).join("\n");
}

async function* openaiDialogue(req: DialogueRequest): AsyncGenerator<string> {
  const client = openai();
  const cfg = loadConfig();
  const model = cfg.dialogueModel.model;
  const params: ChatCompletionCreateParamsStreaming = {
    model,
    stream: true,
    messages: [
      { role: "system", content: systemPrompt(req.setting, req.character) },
      ...toOpenAiMessages(req.character.id, req.lines),
    ],
  };
  if (isReasoningModel(model)) {
    // "low" (not "minimal"): newer reasoning models (e.g. gpt-5.x) dropped
    // "minimal"; "low" is accepted across the o-series and gpt-5 families.
    params.reasoning_effort = "low";
    params.verbosity = "low";
    params.max_completion_tokens = 400;
  } else {
    params.temperature = 0.7;
    params.max_tokens = 300;
  }
  const stream = await client.chat.completions.create(params, { signal: req.signal });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

async function* geminiDialogue(req: DialogueRequest): AsyncGenerator<string> {
  const ai = gemini();
  const cfg = loadConfig();
  const model = cfg.dialogueModel.model;
  const stream = await ai.models.generateContentStream({
    model,
    contents: toGeminiContents(req.character.id, req.lines),
    config: {
      systemInstruction: systemPrompt(req.setting, req.character),
      thinkingConfig: geminiThinking(cfg.geminiThinkingLevel),
      maxOutputTokens: 400,
      temperature: 0.7,
      abortSignal: req.signal,
    },
  });
  for await (const chunk of stream) {
    const t = chunk.text;
    if (t) yield t;
  }
}

/** Stream dialogue tokens for a character. Honors AbortSignal for barge-in. */
export function streamDialogue(req: DialogueRequest): AsyncGenerator<string> {
  const cfg = loadConfig();
  return cfg.dialogueModel.provider === "gemini" ? geminiDialogue(req) : openaiDialogue(req);
}
