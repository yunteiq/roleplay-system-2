// Pure text utilities for the latency pipeline:
//  - SpeakableChunker: turns a growing LLM token stream into stable, final,
//    voice-friendly chunks that can be flushed to TTS before the full sentence
//    (or even the first sentence) is complete.
//  - name/alias routing match (instant, no LLM)
//  - transcript similarity (speculative commit vs. abort)

const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
const STRONG = ".!?…;:";
const PUNCT_TAIL = ".,!?;:…-–—\"'’)]";

export function countWords(s: string): number {
  const m = s.match(WORD);
  return m ? m.length : 0;
}

function wordList(s: string): string[] {
  const m = s.toLowerCase().match(WORD);
  return m ? m : [];
}

interface Boundary {
  end: number; // exclusive char index in the scanned string
  words: number;
  strong: boolean;
}

function scanBoundaries(
  s: string,
  allowComma: boolean,
  allowDash: boolean,
  atEnd: boolean,
): Boundary[] {
  const out: Boundary[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const isStrong = STRONG.includes(c);
    const isComma = c === ",";
    const isDash = c === "-" || c === "–" || c === "—";
    const allowed = isStrong || (isComma && allowComma) || (isDash && allowDash);
    if (!allowed) continue;
    const atStrEnd = i + 1 === s.length;
    const confirmed = atStrEnd ? atEnd : /\s/.test(s[i + 1]!);
    if (!confirmed) continue;
    const end = i + 1;
    out.push({ end, words: countWords(s.slice(0, end)), strong: isStrong });
  }
  return out;
}

function completeWordEnds(s: string, atEnd: boolean): number[] {
  const ends: number[] = [];
  for (const m of s.matchAll(WORD)) {
    const e = (m.index ?? 0) + m[0].length;
    if (e < s.length || atEnd) ends.push(e);
  }
  return ends;
}

function hardCut(s: string, ends: number[], n: number): number {
  let cut = ends[n - 1]!;
  while (cut < s.length && PUNCT_TAIL.includes(s[cut]!)) cut++;
  return cut;
}

export interface ChunkerOptions {
  firstMinWords: number;
  firstMaxWords: number;
  laterMaxWords: number;
  allowComma: boolean;
  allowDash: boolean;
}

/**
 * Incrementally converts streamed text into final, speakable chunks.
 * Every returned chunk is final: it never depends on text that has not yet been
 * emitted, so it is safe to send straight to TTS.
 */
export class SpeakableChunker {
  private full = "";
  private emitted = 0;
  private firstEmitted = false;

  constructor(private opts: ChunkerOptions) {}

  get hasEmittedFirst(): boolean {
    return this.firstEmitted;
  }

  /** Words available but not yet emitted. */
  pendingWords(): number {
    return countWords(this.full.slice(this.emitted));
  }

  push(delta: string): void {
    this.full += delta;
  }

  /** Drain any chunks that are ready under normal (non-forced) conditions. */
  drain(): string[] {
    return this.run(false, false);
  }

  /** Called when the first-chunk timer fires: allow emitting a short first chunk. */
  forceFirst(): string[] {
    return this.run(false, true);
  }

  /** Stream ended: emit everything remaining as final chunks. */
  flush(): string[] {
    return this.run(true, true);
  }

  private run(atEnd: boolean, forceFirst: boolean): string[] {
    const out: string[] = [];
    let allowForce = forceFirst;
    for (;;) {
      const pending = this.full.slice(this.emitted);
      if (countWords(pending) === 0 && !atEnd) break;
      const consume = this.nextChunk(pending, atEnd, allowForce && !this.firstEmitted);
      if (consume == null) break;
      if (consume <= 0) break;
      const text = pending.slice(0, consume).trim();
      this.emitted += consume;
      allowForce = false;
      if (text) {
        out.push(text);
        this.firstEmitted = true;
      }
    }
    return out;
  }

  private nextChunk(s: string, atEnd: boolean, forceFirst: boolean): number | null {
    const { allowComma, allowDash } = this.opts;
    const minWords = this.firstEmitted ? 1 : this.opts.firstMinWords;
    const maxWords = this.firstEmitted ? this.opts.laterMaxWords : this.opts.firstMaxWords;
    const bounds = scanBoundaries(s, allowComma, allowDash, atEnd);
    const ends = completeWordEnds(s, atEnd);
    const completeWords = ends.length;

    if (!this.firstEmitted) {
      // First chunk: speak ASAP. Earliest boundary within [min, max] words.
      const cand = bounds.find((b) => b.words >= minWords && b.words <= maxWords);
      if (cand) return cand.end;
      if (completeWords >= maxWords) return hardCut(s, ends, maxWords);
      if (forceFirst && completeWords >= minWords) {
        return hardCut(s, ends, Math.min(completeWords, maxWords));
      }
      return null;
    }

    // Later chunk: pack up to maxWords, breaking at the latest boundary in budget.
    let best: Boundary | null = null;
    for (const b of bounds) {
      if (b.words >= 1 && b.words <= maxWords) best = b;
      if (b.words > maxWords) break;
    }
    if (best) return best.end;
    if (completeWords >= maxWords) return hardCut(s, ends, maxWords);
    if (atEnd && completeWords >= 1) return s.length;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Routing: instant name / alias match
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findWord(hayLower: string, needleLower: string): number {
  if (!needleLower) return -1;
  const re = new RegExp(
    `(^|[^\\p{L}\\p{N}])(${escapeRe(needleLower)})(?=[^\\p{L}\\p{N}]|$)`,
    "u",
  );
  const m = re.exec(hayLower);
  return m ? m.index + m[1]!.length : -1;
}

export interface NameMatchCandidate {
  id: string;
  name: string;
  aliases: string[];
}

/** Returns the id of the earliest-named character, or null if none named. */
export function matchCharacterByName(
  text: string,
  candidates: NameMatchCandidate[],
): string | null {
  const hay = text.toLowerCase();
  let bestId: string | null = null;
  let bestIdx = Infinity;
  for (const c of candidates) {
    const needles = [c.name, ...c.aliases];
    for (const n of needles) {
      const needle = n.toLowerCase().trim();
      const idx = findWord(hay, needle);
      if (idx >= 0 && idx < bestIdx) {
        bestIdx = idx;
        bestId = c.id;
      }
    }
  }
  return bestId;
}

// ---------------------------------------------------------------------------
// Similarity for speculative commit / abort (word-level LCS ratio)
// ---------------------------------------------------------------------------

function lcsLen(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) cur[j] = prev[j - 1]! + 1;
      else cur[j] = Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m]!;
}

/** 0..1 similarity between two transcripts (1 = identical word sequence). */
export function similarity(a: string, b: string): number {
  const wa = wordList(a);
  const wb = wordList(b);
  if (wa.length === 0 && wb.length === 0) return 1;
  if (wa.length === 0 || wb.length === 0) return 0;
  const l = lcsLen(wa, wb);
  return (2 * l) / (wa.length + wb.length);
}
