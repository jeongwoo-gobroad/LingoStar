# Agent Contracts

This document describes the structural-output contract between ChatGPT, the LingoStar MCP server, and the widget.

## Tools

| Tool | Caller | Purpose | Mutates state |
| --- | --- | --- | --- |
| `open_lingostar_app` | GPT | Render the widget; only this tool carries the Apps SDK output template | No |
| `get_lingostar_state` | GPT / Widget | Load full user state, dashboard, active section, GUI config | No |
| `search_lingostar_help` | GPT | Search static help markdown loaded at server startup | No |
| `select_learning_session` | GPT / Widget | Persist the user's explicitly selected active language session | Yes |
| `manage_learning_session` | GPT / Widget settings | Create or update a language session; may include the first section | Yes |
| `create_lesson_exercises` | GPT | Store GPT-generated section exercises after validation | Yes |
| `grade_section_answers` | GPT / Widget auto-grader | Store scores and feedback, update profiles, create reviews | Yes |
| `store_level_judgment` | GPT | Record level completion judgment | Yes |
| `store_goal_judgment` | GPT | Record rigorous goal completion judgment after the minimum section threshold | Yes |
| `transcribe_audio` | Widget | Server OpenAI STT fallback only | No |
| `synthesize_speech` | Widget | Server OpenAI TTS fallback only | No |
| `submit_feedback` | Widget | Store product feedback with a sequential admin-review ID | Yes |
| `delete_session` | GPT / Widget | Delete an explicitly requested session | Yes |

## App State

```ts
type AppState = {
  version: "0.7.0";
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
  dashboard: DashboardSummary;
  host: { locale: string; interfaceLanguage: "en" | "ko"; developerMode: boolean };
  gui: {
    screen: "oobe" | "dashboard" | "lesson";
    widgetVersion: string;
    help: { title: string; intro: string; features: string[]; footer?: string };
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
  progressContext: string;  // natural language, interface/native language
  weaknessContext: string;  // natural language, interface/native language
  settings: {
    displayLanguage: "auto" | "en" | "ko";
    exercisesPerSkill: number; // backward-compatible fallback, 3-6
    exerciseCounts: {
      language_info: number;
      listening: number;
      reading: number;
      writing: number;
      speaking: number;
    };
    sectionPassThreshold: number; // default 85
    minSectionsForGoalCompletion: number; // minimum 10
    ttsRate: number; // 0.6-1.4, default 1.0
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

`exerciseCounts` is authoritative. `exercisesPerSkill` exists for backward compatibility only.

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

`language_info` is a separate structural output type, not an optional field on another exercise.

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

The widget auto-grades `language_info`, `listening`, `reading`, and `writing` as soon as the learner answers. Speaking is evaluated by ChatGPT when the section is submitted.

```ts
type ExerciseResult = {
  exerciseId: string;
  score: number; // 0-100
  skill: "language_info" | "listening" | "reading" | "writing" | "speaking";
  userAnswer?: string; // Submitted choice, written answer, transcript, or [SKIPPED]
  learnerClaim?: string;
  skipped?: boolean;
  needsReview: boolean;
  feedback: { short: string; detail?: string };
  gradedAt: string;
};
```

Skipped results are stored and can create review exercises, but they do not lower the skill profile. Section pass/fail uses only the weighted score:

- listening: 0.2
- reading: 0.4
- writing: 0.3
- speaking: 0.1

`language_info` is required for completion but is not part of the weighted pass score.
