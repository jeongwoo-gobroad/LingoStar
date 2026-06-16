# GPT Call vs MCP Server Boundary

LingoStar deliberately separates ChatGPT reasoning from MCP server responsibilities.

## Boundary Diagram

```mermaid
flowchart LR
  User["Learner"] --> GPT["ChatGPT model call"]
  GPT -->|"tool calls"| MCP["LingoStar MCP server"]
  MCP -->|"structuredContent.state"| GPT
  MCP --> Widget["Widget resource"]
  Widget -->|"short visible follow-up + hidden model context"| GPT
  Widget -->|"state/audio/feedback tool calls"| MCP
  MCP --> DB["Memory or Firestore"]
```

## ChatGPT Does

- Understand natural-language learning goals.
- Explain the app using learner-facing terms: learning track, practice set, exercise.
- Present learning-track status as Markdown tables.
- Change settings through `update_lingostar_settings`.
- Create or update learning tracks.
- Generate structured practice sets.
- Grade speaking answers at practice-set submission.
- Judge level and goal completion under CEFR or explicit exam standards.
- Answer learner questions from the native ChatGPT composer without replacing the active practice set.

## MCP Server Does

- Expose Apps SDK tools and widget resource metadata.
- Enforce structural output schemas and descriptions.
- Validate per-area exercise counts and payloads.
- Store state by user key.
- Maintain logical multi-context records in `agentContexts`.
- Provide OAuth resource-server metadata and bearer-token checks.
- Provide server STT/TTS fallback when enabled.

## Widget Does

- Render welcome, learning-track selection, and lesson surfaces only.
- Keep UI text in the interface language while showing the target language as the learning target.
- Use system-like colors, spacing, fonts, and rounded shapes.
- Avoid duplicate ChatGPT composer behavior.
- Auto-grade objective answers immediately.
- Provide current-problem skip buttons.
- Show centered speech/listening availability messages.
- Submit speaking answers to ChatGPT for evaluation.
- Sync the current exercise context so ChatGPT can answer learner questions while preserving the active practice set.

## Multi-Agent Status

The current implementation is not a process-level multi-agent backend. It is ChatGPT + MCP + durable logical contexts.

The initial design's agents are represented as persisted context roles:

- User Agent -> stable user key and state namespace
- Language Selection -> learning tracks, languages, goals
- Tracking Agent -> natural-language progress context
- Problem Management Agent -> natural-language weakness context

This keeps the app deployable as a ChatGPT App today while preserving an upgrade path to future server-side orchestration.

## Section Contract

`exerciseCounts` is authoritative:

- Speaking enabled: `language_info + listening + reading + writing + speaking`
- Speaking disabled: `language_info + listening + reading + writing`

Each enabled area must contain its configured count, 3-6 items.

The server rejects invalid sections rather than silently accepting partial problem sets.

## Audio Boundary

Browser speech APIs are preferred where the environment supports them. Optional server audio tools exist only for configured fallback:

- `synthesize_speech`: TTS fallback for listening
- `transcribe_audio`: STT fallback for speaking recordings

If `IS_AI_FALLBACK=false`, the widget and server do not use OpenAI audio fallback.
