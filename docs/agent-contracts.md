# Agent Contracts

This document describes the structural-output contract between ChatGPT, the LingoStar MCP server, and the widget.

## Tools

| Tool | Caller | Purpose | Mutates state |
| --- | --- | --- | --- |
| `open_lingostar_app` | GPT | Render the welcome/onboarding component | No |
| `open_lingostar_session_select` | GPT | Render the learning-track picker | No |
| `open_lingostar_lesson` | GPT | Render the active lesson component | No |
| `get_lingostar_state` | GPT / Widget | Load private user state, active practice set, UI copy, and help summary | No |
| `search_lingostar_help` | GPT | Search static help markdown loaded at server startup | No |
| `select_learning_session` | GPT / Widget | Select a learning track by exact ID or target language inside the current user's state | Yes |
| `manage_learning_session` | GPT | Create or update a learning track; may include the first practice set | Yes |
| `update_lingostar_settings` | GPT | Apply natural-language settings changes to one learning track | Yes |
| `create_lesson_exercises` | GPT | Store a generated practice set after validation and render the lesson | Yes |
| `grade_section_answers` | GPT / Widget | Store scores and feedback, update profiles, and complete the practice set when all answers exist | Yes |
| `store_level_judgment` | GPT | Record level completion judgment | Yes |
| `store_goal_judgment` | GPT | Record rigorous goal completion judgment after the minimum practice-set threshold | Yes |
| `transcribe_audio` | Widget | Optional server STT fallback | No |
| `synthesize_speech` | Widget | Optional server TTS fallback | No |
| `submit_feedback` | Widget | Store product feedback with a sequential admin-review ID | Yes |
| `delete_session` | GPT / Widget | Delete one, active, target-language, or all learning tracks for the current user only | Yes |

## App State

```ts
type AppState = {
  version: "0.10.0";
  activeSessionId: string | null;
  sessions: LanguageSession[];
  currentSection: Section | null;
  recentFeedback: FeedbackEvent[];
  feedbackItems: FeedbackEvent[];
  translationCache: { widgetVersion: string; locales: Record<string, unknown>; clearedAt: string };
  agentContexts: {
    userAgent: { stableUserId: string; note: string; updatedAt: string };
    languageSelection: { activeSessionId: string | null; languages: unknown[]; updatedAt: string };
    trackingAgent: { contextsBySessionId: Record<string, unknown>; updatedAt: string };
    problemManagementAgent: { weaknessesBySessionId: Record<string, unknown>; updatedAt: string };
  };
  dashboard: Record<string, unknown>; // derived compatibility snapshot, not a user-facing dashboard
  host: { locale: string; interfaceLanguage: "en" | "ko"; developerMode: boolean };
  gui: {
    screen: "welcome" | "select" | "lesson";
    widgetVersion: string;
    help: { title: string; intro: string; features: string[]; footer?: string };
    uiCopy: Record<string, string>;
    icon: "embedded" | "fallback";
    audio: {
      browserSpeechSynthesis: boolean;
      browserSpeechRecognition: boolean;
      aiFallbackEnabled: boolean;
      openAiSttConfigured: boolean;
      openAiTtsConfigured: boolean;
    };
  };
};
```

## User-Facing Terms

| Internal field | User-facing wording |
| --- | --- |
| `LanguageSession` | learning track / 학습 트랙 |
| `Section` | practice set / 연습 묶음 |
| `Exercise` | exercise or problem / 문제 |

The model should use the user-facing wording in chat. Tool inputs still use internal field names.

## Language Session

```ts
type LearnerStage = "foundation" | "intro" | "intermediate" | "advanced";

type LanguageSession = {
  id: string;
  targetLanguage: string;
  nativeLanguage: string;
  status: "active" | "paused";
  goal: { type: string; detail: string; status?: "active" | "completed"; startedAt?: string };
  stage: LearnerStage;
  progressContext: string;
  weaknessContext: string;
  interests: string[];
  avoidTopics: string[];
  settings: {
    displayLanguage: "auto" | "en" | "ko";
    exercisesPerSkill: number; // compatibility fallback, 3-6
    exerciseCounts: {
      language_info: number;
      listening: number;
      reading: number;
      writing: number;
      speaking: number;
    };
    sectionPassThreshold: number;
    minSectionsForGoalCompletion: number;
    ttsRate: number; // 0.6-1.4
    speakingEnabled: boolean;
    levelMode: "cefr" | "freeform";
  };
  runtime: { interfaceLanguage: "en" | "ko"; speechLang: string };
  levels: Level[];
  skillProfile: {
    language_info: number;
    listening: number;
    reading: number;
    writing: number;
    speaking: number;
  };
  feedbackMemory: unknown[];
  sectionHistory: SectionHistoryItem[];
};
```

## Section

`exerciseCounts` is authoritative. `exercisesPerSkill` exists for compatibility only.

```ts
type Section = {
  id: string;
  sessionId: string;
  levelId?: string;
  title: string;
  status: "active" | "completed";
  exercisesPerSkill?: number;
  exerciseCounts: Record<"language_info" | "listening" | "reading" | "writing" | "speaking", number>;
  exercises: Exercise[];
  reviewExercises: Exercise[];
  results: ExerciseResult[];
  aggregate?: {
    weightedScore: number;
    threshold: number;
    passed: boolean;
    weights: { listening: 0.2; reading: 0.4; writing: 0.3; speaking: 0.1 };
  };
};
```

## Exercise Types

`language_info` is a separate structural output type.

```ts
type LanguageInfoExercise = {
  type: "language_info";
  skill: "language_info";
  prompt: string;
  instructions?: string;
  payload: {
    topic: string;
    explanation: string;
    targetExamples: string[];
    question: string;
    choices: { id: string; text: string }[];
    correctChoiceId: string;
    difficultyStage: LearnerStage;
  };
};
```

Other payload requirements:

- `listening`: `audioText`, `speechLang`, `question`, exactly 5 `choices`, `correctChoiceId`
- `reading`: `passage`, `question`, 3-5 `choices`, `correctChoiceId`
- `writing`: `targetSentence`, shuffled `tokens`, `dragMode: "token_reorder"`
- `speaking`: `scenario`, `exampleResponse`, `speechLang`, `skippable: true`

## Grading

The widget auto-grades `language_info`, `listening`, `reading`, and `writing`. Speaking is evaluated by ChatGPT when the practice set is submitted.

```ts
type ExerciseResult = {
  exerciseId: string;
  score: number; // 0-100
  skill: "language_info" | "listening" | "reading" | "writing" | "speaking";
  userAnswer?: string;
  learnerClaim?: string;
  skipped?: boolean;
  needsReview: boolean;
  feedback: { short: string; detail?: string };
  gradedAt: string;
};
```

Skipped results are stored and can create review exercises, but they do not lower the skill profile. Section pass/fail uses these weights:

- listening: 0.2
- reading: 0.4
- writing: 0.3
- speaking: 0.1

`language_info` is required for completion but is unweighted.
