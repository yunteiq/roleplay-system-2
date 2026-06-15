# Live NPC Voice Roleplay

A distributed, low-latency voice roleplay system. A human talks out loud and converses with
multiple AI characters. **Each character is "played by" its own laptop** running this same website,
and that laptop voices only its assigned character via streaming TTS. A separate **host** laptop
orchestrates the scene and does no audio I/O.

The whole pipeline streams and pipelines aggressively: streaming STT → instant name match or
speculative director → streaming dialogue → stable speakable chunks → streaming TTS → low-latency
playback — and the **active mic** follows the conversation so the laptop that just spoke listens for
the human's next line.

---

## Requirements

- **Node.js 20+** (developed on Node 26)
- An **`OPENAI_API_KEY`** — a single key runs STT, director, dialogue, and TTS
- Optional **`GEMINI_API_KEY`** to use the Gemini director/dialogue options
- Multiple laptops on the same Wi-Fi/LAN, each with a mic + speakers (for the full experience)

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set OPENAI_API_KEY
```

## Run

Development (watches server + client):

```bash
npm run dev
```

Production-style:

```bash
npm run build   # bundles the client into ./public
npm start       # runs the server with tsx
```

Other scripts:

```bash
npm run typecheck   # tsc --noEmit (strict)
npm run build       # build client only
```

On start, the server prints URLs like:

```
Open on this machine:
   https://localhost:8787
Open on other laptops (same Wi-Fi/LAN):
   https://192.168.1.42:8787
```

## How to use it

1. **Every laptop** opens the printed **https** URL and accepts the self-signed certificate warning once.
2. On one laptop, click **Become Host**, fill in the **scene setting** and **character rows**
   (name, persona, voice, aliases, optional secret), and click **Create / Update scene**.
3. On each **character laptop**, claim a character in the lobby, then click **Join audio**
   (this unlocks the mic + speakers — required by browsers).
4. The host clicks **Start**.
5. Talk to the laptop that holds the **active mic** (it shows **LISTENING**). At scene start the active
   mic defaults to the first claimed character; the host can override it anytime with **Set mic here**.
6. If you **name a character**, that character replies. Otherwise the **director** picks who responds.
   The right character speaks in its own voice on its own laptop, and the **active mic moves to that
   laptop** so it's ready for your next line.
7. **Barge-in:** start talking while a character is speaking/thinking — its audio is cut immediately,
   in-flight work is aborted, and your new line is captured.

### Testing without microphones

The host dashboard has:

- **Speak as the human** — type a line to drive the pipeline as if spoken.
- **Make them say…** — force a specific character to speak a line (direct TTS).
- **Set mic here** — move the active mic to any connected character's laptop.

## The active mic rule

At any moment exactly **one** laptop's mic is used for STT. The server assigns it to the laptop that
is currently speaking or most recently spoke, so after a character replies, that laptop listens for the
human's next line. Mics are always **hot** (full-duplex) — the active-mic assignment only decides whose
frames are forwarded to STT. A character laptop **plays its TTS and captures its mic at the same time**;
the browser's native echo cancellation removes the laptop's own playback from its mic.

## HTTPS

Browsers only allow `getUserMedia` in a secure context, so the server serves **HTTPS by default**.

- A self-signed cert is generated on first run and cached in `./.cert`. Its SANs include `localhost`,
  `127.0.0.1`, and your machine's LAN IPv4 addresses, so the LAN URLs work.
- For no warnings, supply a trusted cert (e.g. [mkcert](https://github.com/FiloSottile/mkcert)) via
  `TLS_CERT` and `TLS_KEY`.
- `INSECURE_HTTP=true` serves plain HTTP. The mic then only works on `localhost` or behind an
  HTTPS-terminating proxy/tunnel.

## Models

Configure any model as `provider:model` in `.env`:

| Role     | Default                          | Notes |
|----------|----------------------------------|-------|
| STT      | `openai:gpt-4o-mini-transcribe`  | Realtime, streaming, server VAD |
| Director | `openai:gpt-4.1-nano`            | Fast, non-reasoning, JSON-only |
| Dialogue | `openai:gpt-4.1-mini`            | Fast persona; alt `openai:gpt-5.4-mini` |
| TTS      | `openai:gpt-4o-mini-tts`         | Streaming PCM, per-voice + instructions |

Gemini options (need `GEMINI_API_KEY`): `gemini:gemini-3.5-flash` (dialogue),
`gemini:gemini-3.1-flash-lite` (director), with `GEMINI_THINKING_LEVEL=MINIMAL`.
(`gemini-2.0-flash` is retired — do not use it.)

See [`.env.example`](./.env.example) for the full, documented configuration surface (VAD, audio,
TTS chunking, and speculation tuning).

## Architecture

One 24 kHz, 16-bit, mono PCM path end to end. Transport is a single WebSocket: JSON control messages
(discriminated by a `t` field) plus binary frames (mic PCM upstream, TTS PCM downstream, framed by
`speakBegin`/`speakEnd`). Compression is disabled for PCM and TCP no-delay is set.

```
src/
  shared/types.ts          wire protocol + domain types (client + server)
  server/
    index.ts               https/http + static + WebSocket bootstrap, prints LAN URLs
    config.ts              env config + provider:model parsing
    log.ts                 leveled logger
    text.ts                SpeakableChunker, name/alias match, similarity
    tls.ts                 self-signed cert (cached, LAN SANs)
    hub.ts                 connection registry + message dispatch (one live scene)
    scene.ts               turn state machine, active mic, barge-in, speculation
    providers/
      clients.ts           warm OpenAI / Gemini clients
      stt.ts               OpenAI Realtime transcription (GA format)
      director.ts          routing LLM (JSON-only, low latency)
      dialogue.ts          streaming dialogue LLM
      tts.ts               streaming TTS (raw PCM)
  client/
    main.ts                state, WebSocket, audio lifecycle, rendering
    ws.ts                  typed WebSocket wrapper (arraybuffer binary)
    ui.ts                  hyperscript helper + shared view types
    audio/
      worklet.ts           capture + playback AudioWorklet processors
      capture.ts           mic capture (full-duplex), Int16 frames + RMS
      playback.ts          gapless ring-buffer playback, immediate stop()
    views/                 lobby / host / character
scripts/build-client.mjs   esbuild: app bundle + worklet bundle + assets
```

### Latency pipeline (hot path)

```
active-mic laptop ──PCM/WS──▶ server STT (streaming + server VAD)
                                    │ stable partial
                                    ├─▶ instant name/alias match  OR  speculative director
                                    ▼
                              dialogue LLM (streamed tokens)
                                    │ stable speakable chunks (1–8 words first, then ≤16)
                                    ▼
                              TTS (streamed PCM) ──WS──▶ responding laptop (immediate playback)
                                                              └─▶ becomes the new active mic
```

The dialogue model is prompted to start with a very short first phrase and continue in concise
speakable chunks; TTS starts on the **first stable chunk**, before the first full sentence is done.
On the final STT transcript, speculative work is **committed** if it's similar enough, otherwise it's
**aborted and restarted**. Turn IDs + `AbortSignal` let barge-in stop dialogue, queued TTS, and
playback instantly.

## Troubleshooting

- **No mic prompt / mic blocked:** you must be on **https** (or `localhost`). A plain
  `http://LAN-IP` blocks the mic. Accept the cert warning once.
- **It cuts me off too early:** raise `VAD_SILENCE_MS` (e.g. `400`) and/or `VAD_THRESHOLD`.
- **A character interrupts itself while speaking:** that's its own playback leaking past echo
  cancellation. Use a headset, increase distance, or raise `VAD_THRESHOLD`.
- **Pitched/garbled audio:** something isn't at 24 kHz. The client warns if the browser refused a
  24 kHz `AudioContext`; keep `AUDIO_SAMPLE_RATE=24000` everywhere.
- **Provider errors:** they're logged on the server and shown in the host UI; they never crash the
  server. The most common one is a missing/invalid `OPENAI_API_KEY`.
