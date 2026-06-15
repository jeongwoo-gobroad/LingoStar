import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

/* ------------------------------------------------------------------ */
/*  Static assets                                                     */
/* ------------------------------------------------------------------ */

const SERVICE_VERSION = "0.7.0";
const WIDGET_VERSION = "0.7.0";
const WIDGET_URI = "ui://widget/lingostar-studio-v0-7-0.html";
const iconAssetPath = existsSync("public/icon-96.png")
  ? "public/icon-96.png"
  : existsSync("public/icon.png")
    ? "public/icon.png"
    : existsSync("icon.png")
      ? "icon.png"
      : null;
const iconPng = iconAssetPath ? readFileSync(iconAssetPath) : null;

/* ------------------------------------------------------------------ */
/*  Per-user state store                                               */
/* ------------------------------------------------------------------ */

const storesByUser = new Map();
const storeAliases = new Map();
let feedbackItemsMemory = [];

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MIN_EXERCISES_PER_AREA = 3;
const MAX_EXERCISES_PER_AREA = 6;
const DEFAULT_EXERCISES_PER_AREA = 3;
const SUPPORTED_UI_LOCALES = ["en", "ko"];
const SKILLS = ["speaking", "writing", "listening", "reading"];
const EXERCISE_AREAS = ["language_info", "listening", "reading", "writing", "speaking"];
const SECTION_SCORE_WEIGHTS = { listening: 0.2, reading: 0.4, writing: 0.3, speaking: 0.1 };

/* ------------------------------------------------------------------ */
/*  Environment                                                        */
/* ------------------------------------------------------------------ */

function cleanEnvValue(value) {
  return String(value ?? "").trim();
}

function envFlag(value, defaultValue = false) {
  const normalized = cleanEnvValue(value).toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

const ENV_FILE = loadDotEnv();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ENV_FILE.OPENAI_API_KEY ?? "";
const OPENAI_STT_MODEL = process.env.OPENAI_STT_MODEL ?? ENV_FILE.OPENAI_STT_MODEL ?? "gpt-4o-transcribe";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL ?? ENV_FILE.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE ?? ENV_FILE.OPENAI_TTS_VOICE ?? "alloy";
const OPENAI_TTS_FORMAT = process.env.OPENAI_TTS_FORMAT ?? ENV_FILE.OPENAI_TTS_FORMAT ?? "mp3";
const IS_AI_FALLBACK = !["0", "false", "no", "off"].includes(
  cleanEnvValue(process.env.IS_AI_FALLBACK ?? ENV_FILE.IS_AI_FALLBACK ?? "true").toLowerCase()
);
const STATE_STORE = cleanEnvValue(process.env.LINGOSTAR_STATE_STORE ?? ENV_FILE.LINGOSTAR_STATE_STORE ?? "memory").toLowerCase();
const FIRESTORE_PROJECT_ID = firstCleanValue(
  process.env.FIRESTORE_PROJECT_ID,
  ENV_FILE.FIRESTORE_PROJECT_ID,
  process.env.GOOGLE_CLOUD_PROJECT,
  process.env.GCLOUD_PROJECT
);
const FIRESTORE_DATABASE_ID = cleanEnvValue(process.env.FIRESTORE_DATABASE_ID ?? ENV_FILE.FIRESTORE_DATABASE_ID ?? "(default)");
const FIRESTORE_COLLECTION = cleanEnvValue(process.env.FIRESTORE_COLLECTION ?? ENV_FILE.FIRESTORE_COLLECTION ?? "lingostar_states");
const ALLOWED_DOMAINS_ENV = process.env.ALLOWED_DOMAINS ?? ENV_FILE.ALLOWED_DOMAINS ?? "";
const ALLOWED_DOMAINS_ARRAY = ALLOWED_DOMAINS_ENV ? ALLOWED_DOMAINS_ENV.split(",").map(s => s.trim()) : [];
const WIDGET_CONNECT_DOMAINS_ENV = process.env.WIDGET_CONNECT_DOMAINS ?? ENV_FILE.WIDGET_CONNECT_DOMAINS ?? "";
const WIDGET_RESOURCE_DOMAINS_ENV = process.env.WIDGET_RESOURCE_DOMAINS ?? ENV_FILE.WIDGET_RESOURCE_DOMAINS ?? "";
const CORS_ALLOWED_ORIGINS_ENV = process.env.CORS_ALLOWED_ORIGINS ?? ENV_FILE.CORS_ALLOWED_ORIGINS ?? "";
const WIDGET_CONNECT_DOMAINS_ARRAY = WIDGET_CONNECT_DOMAINS_ENV ? WIDGET_CONNECT_DOMAINS_ENV.split(",").map(s => s.trim()) : [];
const WIDGET_RESOURCE_DOMAINS_ARRAY = WIDGET_RESOURCE_DOMAINS_ENV ? WIDGET_RESOURCE_DOMAINS_ENV.split(",").map(s => s.trim()) : [];
const CORS_ALLOWED_ORIGINS_ARRAY = CORS_ALLOWED_ORIGINS_ENV ? CORS_ALLOWED_ORIGINS_ENV.split(",").map(s => s.trim()) : [];
const APP_ORIGIN_RAW = firstCleanValue(
  process.env.APP_ORIGIN,
  ENV_FILE.APP_ORIGIN,
  ALLOWED_DOMAINS_ARRAY[0],
  "http://localhost:8787"
);
const APP_ORIGIN = APP_ORIGIN_RAW.replace(/\/+$/, "");
const WIDGET_CONNECT_DOMAINS = [...new Set([APP_ORIGIN, ...ALLOWED_DOMAINS_ARRAY, ...WIDGET_CONNECT_DOMAINS_ARRAY].filter(Boolean))];
const WIDGET_RESOURCE_DOMAINS = [...new Set([APP_ORIGIN, ...WIDGET_RESOURCE_DOMAINS_ARRAY].filter(Boolean))];
const CORS_ALLOWED_ORIGINS = [...new Set([APP_ORIGIN, ...ALLOWED_DOMAINS_ARRAY, ...CORS_ALLOWED_ORIGINS_ARRAY].filter(Boolean))];
const DEVELOPER_MODE =
  process.argv.includes("--developer-mode") ||
  ENV_FILE.LINGOSTAR_DEVELOPER_MODE === "1" ||
  process.env.LINGOSTAR_DEVELOPER_MODE === "1";
const AUTH_REQUIRED_RAW = firstCleanValue(
  process.env._AUTH_REQUIRED,
  ENV_FILE._AUTH_REQUIRED,
  process.env.AUTH_REQUIRED,
  ENV_FILE.AUTH_REQUIRED,
  process.env.LINGOSTAR_AUTH_REQUIRED,
  ENV_FILE.LINGOSTAR_AUTH_REQUIRED,
  process.env.OAUTH_REQUIRED,
  ENV_FILE.OAUTH_REQUIRED
);
const AUTH_REQUIRED =
  !DEVELOPER_MODE && envFlag(AUTH_REQUIRED_RAW, false);
const OAUTH_ISSUER_RAW = firstCleanValue(process.env.OAUTH_ISSUER, ENV_FILE.OAUTH_ISSUER);
const OAUTH_ISSUER = OAUTH_ISSUER_RAW.replace(/\/+$/, "");
const OAUTH_ISSUER_ACCEPTED = acceptedIssuerValues(OAUTH_ISSUER_RAW);
const OAUTH_JWKS_URL = firstCleanValue(process.env.OAUTH_JWKS_URL, ENV_FILE.OAUTH_JWKS_URL);
const OAUTH_AUDIENCE = firstCleanValue(process.env.OAUTH_AUDIENCE, ENV_FILE.OAUTH_AUDIENCE, APP_ORIGIN);
const OAUTH_AUTHORIZATION_SERVERS = firstCleanValue(
  process.env.OAUTH_AUTHORIZATION_SERVERS,
  ENV_FILE.OAUTH_AUTHORIZATION_SERVERS,
  OAUTH_ISSUER
)
  .split(",")
  .map((item) => item.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const OAUTH_SCOPES = (
  process.env.OAUTH_SCOPES ??
  ENV_FILE.OAUTH_SCOPES ??
  "lingostar.read lingostar.write lingostar.audio"
)
  .split(/[,\s]+/)
  .map((item) => item.trim())
  .filter(Boolean);
const OAUTH_REQUEST_SCOPES = (
  firstCleanValue(process.env.OAUTH_REQUEST_SCOPES, ENV_FILE.OAUTH_REQUEST_SCOPES) ||
  OAUTH_SCOPES.join(" ")
)
  .split(/[,\s]+/)
  .map((item) => item.trim())
  .filter(Boolean);
const OAUTH_CLIENT_ID = firstCleanValue(process.env.OAUTH_CLIENT_ID, ENV_FILE.OAUTH_CLIENT_ID);
const OAUTH_SCOPE_MODE_RAW = cleanEnvValue(process.env.OAUTH_SCOPE_MODE ?? ENV_FILE.OAUTH_SCOPE_MODE ?? "strict").toLowerCase();
const OAUTH_SCOPE_MODE = ["strict", "optional", "none"].includes(OAUTH_SCOPE_MODE_RAW)
  ? OAUTH_SCOPE_MODE_RAW
  : "strict";
const OAUTH_VALIDATE_CLIENT_ID = !["0", "false", "no", "off"].includes(
  cleanEnvValue(
    process.env.OAUTH_VALIDATE_CLIENT_ID ??
    ENV_FILE.OAUTH_VALIDATE_CLIENT_ID ??
    (OAUTH_CLIENT_ID ? "true" : "false")
  ).toLowerCase()
);
const OAUTH_ALLOW_SCOPELESS_TOKENS = ["1", "true", "yes", "on"].includes(
  cleanEnvValue(process.env.OAUTH_ALLOW_SCOPELESS_TOKENS ?? ENV_FILE.OAUTH_ALLOW_SCOPELESS_TOKENS ?? "false").toLowerCase()
);
const FEEDBACK_ADMIN_ID = firstCleanValue(process.env.FEEDBACK_ADMIN_ID, ENV_FILE.FEEDBACK_ADMIN_ID);
const FEEDBACK_ADMIN_PASSWORD = firstCleanValue(process.env.FEEDBACK_ADMIN_PASSWORD, ENV_FILE.FEEDBACK_ADMIN_PASSWORD);
const OAUTH_RESOURCE_METADATA_URL = `${APP_ORIGIN}/.well-known/oauth-protected-resource`;
const OAUTH_RESOURCE_DOCUMENTATION =
  process.env.OAUTH_RESOURCE_DOCUMENTATION ??
  ENV_FILE.OAUTH_RESOURCE_DOCUMENTATION ??
  `${APP_ORIGIN}/privacy-poilcy.html`;
const ICON_URL = iconPng ? `${APP_ORIGIN}/icon.png` : "";
const widgetHtml = readFileSync("public/lingostar-widget.html", "utf8").replaceAll(
  "__LINGOSTAR_ICON__",
  ICON_URL
).replaceAll(
  "__LINGOSTAR_APP_ORIGIN__",
  APP_ORIGIN
);
const privacyPolicyHtml = existsSync("privacy-poilcy.html")
  ? readFileSync("privacy-poilcy.html", "utf8")
  : "";
const termsOfServiceHtml = existsSync("terms-of-service.html")
  ? readFileSync("terms-of-service.html", "utf8")
  : "";
const HELP_DOC_PATHS = {
  en: "content/help/en.md",
  ko: "content/help/ko.md",
};
let oauthJwks = null;

/* ------------------------------------------------------------------ */
/*  Zod schemas                                                        */
/* ------------------------------------------------------------------ */

const displayLanguageSchema = z.enum(["auto", "en", "ko"]);
const learnerStageSchema = z.enum(["foundation", "intro", "intermediate", "advanced"]).describe(
  "Learner stage inferred from the user's context: foundation means symbols/pronunciation/basic facts are still needed; intro means the learner can read/pronounce enough to solve normal exercises; intermediate means everyday communication; advanced means nuanced or exam/professional performance."
);

const appStateSchema = z.object({
  version: z.string().describe("LingoStar state schema version."),
  activeSessionId: z.string().nullable().describe("The active language learning session ID, or null when no session is selected."),
  sessions: z.array(z.record(z.unknown())).describe("All learning sessions visible to this authenticated ChatGPT user."),
  currentSection: z.record(z.unknown()).nullable().describe("The active lesson section currently shown in the UI, or null when no section is open."),
  recentFeedback: z.array(z.record(z.unknown())).describe("Recent correction and feedback entries across sessions."),
  feedbackItems: z.array(z.record(z.unknown())).optional().describe("User-submitted product feedback entries for this user namespace."),
  translationCache: z.record(z.unknown()).optional().describe("Server-side cached UI/help translations keyed by widget version and interface language."),
  agentContexts: z.record(z.unknown()).optional().describe("Persistent multi-context memory for User Agent, Language Selection, Tracking Agent, and Problem Management Agent roles."),
  dashboard: z.record(z.unknown()).describe("Dashboard summary data for the user's sessions and next action."),
  host: z.record(z.unknown()).optional().describe("Host and locale metadata resolved from ChatGPT Apps request context."),
  gui: z.record(z.unknown()).describe("UI configuration and capability flags for the widget."),
}).describe("Complete persisted LingoStar app state for exactly one user namespace.");

const stateOutputSchema = {
  state: appStateSchema,
};

const transcriptOutputSchema = {
  state: appStateSchema,
  transcript: z.string(),
};

const speechOutputSchema = {
  state: appStateSchema,
  audioDataUrl: z.string(),
  mimeType: z.string(),
};

const exerciseChoiceSchema = z.object({
  id: z.string().describe("A short, unique identifier for this choice (e.g., 'a', '1', 'choice_A')"),
  text: z.string().describe("The text content of the multiple choice option")
});

const languageInfoPayloadSchema = z.object({
  topic: z.string().describe("Language-specific knowledge topic, such as writing system, pronunciation rule, particles/articles, honorifics, tones, word order, or exam-format fact."),
  explanation: z.string().describe("Concise teaching note in the user's native/interface language. It should explain the target-language fact before the choice question."),
  targetExamples: z.array(z.string()).min(1).describe("Examples in the target language. Use native script when the language has a native writing system."),
  question: z.string().describe("Multiple-choice question that checks the language-specific information, not general reading comprehension."),
  choices: z.array(exerciseChoiceSchema).min(3).max(5).describe("An array of 3-5 possible multiple-choice answers for this language-info item."),
  correctChoiceId: z.string().describe("The id of the correct answer. MUST match one of the choice ids."),
  difficultyStage: learnerStageSchema.describe("The learner stage this language-info item is designed for.")
}).describe("Structured payload required by the language-info UI.");

const speakingPayloadSchema = z.object({
  scenario: z.string().describe("The context or roleplay scenario the user should speak about (e.g., 'Introduce yourself in Japanese')"),
  exampleResponse: z.string().optional().describe("An example of a good spoken response"),
  speechLang: z.string().describe("The BCP-47 language tag for speech recognition (e.g., 'ja-JP', 'en-US')"),
  skippable: z.boolean().optional().describe("Whether the widget may let the learner skip this speaking exercise without lowering the skill profile")
});
const listeningPayloadSchema = z.object({
  audioText: z.string().describe("The exact text that the TTS engine will speak. MUST BE IN THE TARGET LANGUAGE (e.g. Japanese). MUST USE NATIVE SCRIPT (e.g. Kanji/Hiragana, NEVER Romaji). DO NOT translate this to English or the native language."),
  question: z.string().describe("A question about the audio text"),
  choices: z.array(exerciseChoiceSchema).length(5).describe("An array of exactly 5 possible multiple choice answers"),
  correctChoiceId: z.string().describe("The id of the choice that is the correct answer. MUST match one of the choices' ids."),
  expectedKeywords: z.array(z.string()).optional().describe("Keywords the user should include in their response if not multiple choice"),
  speechLang: z.string().describe("The BCP-47 language tag for TTS pronunciation (e.g., 'ja-JP', 'en-US')")
});
const writingPayloadSchema = z.object({
  targetSentence: z.string().describe("The complete, correct sentence the user must build by rearranging tokens"),
  tokens: z.array(z.string()).describe("An array of words or phrases that the user will drag and drop to form the targetSentence. MUST contain all parts of the targetSentence, shuffled."),
  dragMode: z.string().optional().describe("Use token_reorder for drag-and-drop writing exercises")
});
const readingPayloadSchema = z.object({
  passage: z.string().describe("The reading passage or text the user must read"),
  question: z.string().describe("The question asking about the passage"),
  choices: z.array(exerciseChoiceSchema).min(3).max(5).describe("An array of 3-5 possible multiple choice answers"),
  correctChoiceId: z.string().describe("The id of the choice that is the correct answer. MUST match one of the choices' ids.")
});

const exerciseSchema = z.discriminatedUnion("skill", [
  z.object({
    id: z.string().optional().describe("Stable ID for this language-info exercise. The server creates one when omitted."),
    type: z.string().optional().describe("Exercise UI type. For language-info exercises this should be 'language_info'."),
    skill: z.literal("language_info").describe("Exercise category for language-specific knowledge checks."),
    sequence: z.number().optional().describe("Display order within the section."),
    prompt: z.string().describe("Instructions for the user on what to learn or answer in this language-info exercise."),
    instructions: z.string().optional().describe("Additional hints or grammar/culture notes."),
    payload: languageInfoPayloadSchema
  }).passthrough(),
  z.object({
    id: z.string().optional().describe("Stable ID for this speaking exercise. The server creates one when omitted."),
    type: z.string().optional().describe("Exercise UI type. For speaking exercises this should be 'speaking'."),
    skill: z.literal("speaking").describe("Skill category for this exercise: speaking."),
    sequence: z.number().optional().describe("Display order within the section."),
    prompt: z.string().describe("Instructions for the user on what to do in this speaking exercise"),
    instructions: z.string().optional().describe("Additional hints or grammar notes"),
    payload: speakingPayloadSchema.describe("Structured payload required by the speaking UI.")
  }).passthrough(),
  z.object({
    id: z.string().optional().describe("Stable ID for this listening exercise. The server creates one when omitted."),
    type: z.string().optional().describe("Exercise UI type. For listening exercises this should be 'listening'."),
    skill: z.literal("listening").describe("Skill category for this exercise: listening."),
    sequence: z.number().optional().describe("Display order within the section."),
    prompt: z.string().describe("Instructions for the user on what to do in this listening exercise"),
    instructions: z.string().optional().describe("Additional hints or grammar notes"),
    payload: listeningPayloadSchema.describe("Structured payload required by the listening UI.")
  }).passthrough(),
  z.object({
    id: z.string().optional().describe("Stable ID for this writing exercise. The server creates one when omitted."),
    type: z.string().optional().describe("Exercise UI type. For writing exercises this should be 'writing'."),
    skill: z.literal("writing").describe("Skill category for this exercise: writing."),
    sequence: z.number().optional().describe("Display order within the section."),
    prompt: z.string().describe("Instructions for the user on what to do in this writing/token rearrangement exercise"),
    instructions: z.string().optional().describe("Additional hints or grammar notes"),
    payload: writingPayloadSchema.describe("Structured payload required by the writing UI.")
  }).passthrough(),
  z.object({
    id: z.string().optional().describe("Stable ID for this reading exercise. The server creates one when omitted."),
    type: z.string().optional().describe("Exercise UI type. For reading exercises this should be 'reading'."),
    skill: z.literal("reading").describe("Skill category for this exercise: reading."),
    sequence: z.number().optional().describe("Display order within the section."),
    prompt: z.string().describe("Instructions for the user on what to do in this reading exercise"),
    instructions: z.string().optional().describe("Additional hints or grammar notes"),
    payload: readingPayloadSchema.describe("Structured payload required by the reading UI.")
  }).passthrough()
]).describe("A single exercise object. You MUST provide the specific payload fields required for the chosen skill.");

const sectionSchema = z.object({
  id: z.string().optional().describe("Stable ID for this lesson section. The server creates one when omitted."),
  sessionId: z.string().optional().describe("ID of the language learning session that owns this section. Defaults to the active session."),
  levelId: z.string().optional().describe("ID of the curriculum level this section belongs to."),
  title: z.string().describe("The title of this lesson section (e.g., 'Basic Greetings')"),
  exercisesPerSkill: z.number().optional().describe("Backward-compatible uniform count per enabled exercise area. Prefer exerciseCounts for new calls."),
  exerciseCounts: z.record(z.number()).optional().describe("Exact per-area exercise counts. Keys may include language_info, listening, reading, writing, and speaking. Each configured count must be 3-6."),
  exercises: z.array(exerciseSchema).describe("An array of exercises for this lesson. Make sure to generate exercises for various skills."),
}).passthrough().describe("A lesson section containing exactly the configured number of exercises for each enabled exercise area: language_info, listening, reading, writing, and speaking when enabled.");

const sessionLevelSchema = z.object({
  id: z.string().optional().describe("Unique ID for the level"),
  title: z.string().optional().describe("Title of the level (e.g., 'Foundation', 'Intermediate')"),
  name: z.string().optional().describe("Existing display name for the level"),
  cefr: z.string().optional().describe("CEFR level code when applicable"),
  description: z.string().optional().describe("Brief description of what is covered in this level"),
  status: z.string().optional().describe("Status of the level (e.g., 'active', 'locked')")
}).passthrough();

const goalSchema = z.object({
  type: z.string().optional().describe("Goal category, e.g. exam, conversation, travel, business, or school."),
  detail: z.string().optional().describe("Concrete goal detail, e.g. JLPT N4, daily conversation, or business email practice."),
}).passthrough().describe("Detailed learning goal object.");

const runtimeSchema = z.object({
  interfaceLanguage: z.string().optional().describe("Resolved UI language code, e.g. ko or en."),
  speechLang: z.string().optional().describe("BCP-47 speech language for the target language, e.g. ja-JP or en-US."),
}).passthrough().describe("Runtime hints resolved by the server or widget.");

const skillProfileSchema = z.object({
  language_info: z.number().optional().describe("Current language-specific knowledge estimate on a 0-100 scale."),
  speaking: z.number().optional().describe("Current speaking ability estimate on a 0-100 scale."),
  writing: z.number().optional().describe("Current writing ability estimate on a 0-100 scale."),
  listening: z.number().optional().describe("Current listening ability estimate on a 0-100 scale."),
  reading: z.number().optional().describe("Current reading ability estimate on a 0-100 scale."),
}).passthrough().describe("Tracked per-skill learner ability profile.");

const feedbackMemoryEntrySchema = z.record(z.unknown()).describe("A remembered correction, learner claim, or feedback pattern for personalization.");
const sectionHistoryEntrySchema = z.record(z.unknown()).describe("A completed or historical section summary for progress tracking.");

const sessionSchema = z.object({
  id: z.string().optional().describe("Stable ID for this language learning session. The server creates one when omitted."),
  targetLanguage: z.string().describe("The language the user wants to learn (e.g., 'Japanese', 'French')"),
  nativeLanguage: z.string().optional().describe("The user's native language for UI translations (e.g., 'Korean', 'English')"),
  goalType: z.string().optional().describe("The user's primary goal (e.g. 'conversation', 'exam preparation', 'travel')"),
  goal: goalSchema.optional(),
  stage: learnerStageSchema.optional().describe("Current learner stage inferred from context. Use foundation for absolute beginners who need writing-system/pronunciation/language-info study before normal problem solving."),
  progressContext: z.string().optional().describe("Natural-language tracking context describing the user's current progress in this target language. Write it in the user's native/interface language."),
  weaknessContext: z.string().optional().describe("Natural-language problem-management context describing weak areas and recurring mistakes for this target language. Write it in the user's native/interface language."),
  interests: z.array(z.string()).optional().describe("Topics the user is interested in (e.g., ['anime', 'food'])"),
  avoidTopics: z.array(z.string()).optional().describe("Topics the user explicitly wants to avoid"),
  status: z.string().optional().describe("Session status, usually 'active' for usable sessions."),
  settings: z.object({
    displayLanguage: displayLanguageSchema.optional().describe("The language to display the app UI in"),
    exercisesPerSkill: z.number().optional().describe("Backward-compatible uniform number of exercises per area. Prefer exerciseCounts. New deployments clamp counts to 3-6."),
    exerciseCounts: z.object({
      language_info: z.number().optional().describe("Number of language-specific information questions per section. Minimum 3, maximum 6."),
      listening: z.number().optional().describe("Number of listening questions per section. Minimum 3, maximum 6."),
      reading: z.number().optional().describe("Number of reading questions per section. Minimum 3, maximum 6."),
      writing: z.number().optional().describe("Number of writing questions per section. Minimum 3, maximum 6."),
      speaking: z.number().optional().describe("Number of speaking prompts per section. Minimum 3, maximum 6 when speaking is enabled."),
    }).passthrough().optional().describe("Per-area exercise counts configured by the learner."),
    sectionPassThreshold: z.number().optional().describe("Weighted section score threshold from 0-100. Default is 85."),
    minSectionsForGoalCompletion: z.number().optional().describe("Minimum completed/passed sections required before a goal can be marked complete. Minimum is 10."),
    ttsRate: z.number().optional().describe("Browser and server TTS speech speed. Default 1.0 approximates native speaking speed."),
    speakingEnabled: z.boolean().optional().describe("Whether speaking/microphone exercises are enabled"),
    levelMode: z.enum(["cefr", "freeform"]).optional().describe("Curriculum structure mode"),
  }).passthrough().optional().describe("App settings for this session"),
  runtime: runtimeSchema.optional(),
  levels: z.array(sessionLevelSchema).optional().describe("The learning curriculum broken down into levels"),
  skillProfile: skillProfileSchema.optional(),
  feedbackMemory: z.array(feedbackMemoryEntrySchema).optional().describe("Long-lived feedback memory used to personalize future exercises."),
  sectionHistory: z.array(sectionHistoryEntrySchema).optional().describe("Completed section history used for progress and next-section planning."),
}).passthrough().describe("The main language learning session configuration.");

/* ------------------------------------------------------------------ */
/*  .env loader                                                        */
/* ------------------------------------------------------------------ */

function loadDotEnv() {
  if (!existsSync(".env")) return {};
  const parsed = {};
  const lines = readFileSync(".env", "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const rawValue = match[2].trim();
    parsed[match[1]] = rawValue.replace(/^["']|["']$/g, "");
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/*  Locale helpers                                                     */
/* ------------------------------------------------------------------ */

function normalizeUiLocale(locale) {
  const raw = cleanText(locale).toLowerCase();
  if (!raw) return null;
  const primary = raw.split("-")[0];
  if (SUPPORTED_UI_LOCALES.includes(primary)) return primary;
  return null;
}

function requestedLocaleFromContext(context) {
  return (
    context?._meta?.["openai/locale"] ??
    context?._meta?.["webplus/i18n"] ??
    context?._meta?.["openai/userLocation"]?.locale ??
    ""
  );
}

/* ------------------------------------------------------------------ */
/*  TEXT dictionary (en / ko)                                          */
/* ------------------------------------------------------------------ */

let TEXT = {
  en: {
    loaded: "Loaded LingoStar state.",
    noSession: "Create or select a language session first.",
    notFound: "Session not found.",
    deleted: "Deleted the language session.",
    missingContext: "The session or section could not be found.",
    sessionStored: (language) => `Stored ${language} session.`,
    sectionStored: (count) => `Stored section with ${count} exercises.`,
    resultsStored: "Exercise results saved.",
    levelJudged: "Level judgment recorded.",
    transcribed: "Audio transcribed.",
    synthesized: "Audio synthesized.",
    feedbackStored: "Feedback submitted.",
  },
  ko: {
    loaded: "LingoStar 상태를 불러왔습니다.",
    noSession: "먼저 언어 세션을 만들거나 선택해 주세요.",
    notFound: "세션을 찾을 수 없습니다.",
    deleted: "언어 세션을 삭제했습니다.",
    missingContext: "세션 또는 섹션을 찾을 수 없습니다.",
    sessionStored: (language) => `${language} 세션을 저장했습니다.`,
    sectionStored: (count) => `${count}개 문제가 포함된 섹션을 저장했습니다.`,
    resultsStored: "문제 결과를 저장했습니다.",
    levelJudged: "레벨 판단을 기록했습니다.",
    transcribed: "음성을 텍스트로 변환했습니다.",
    synthesized: "음성을 생성했습니다.",
    feedbackStored: "피드백을 접수했습니다.",
  },
};

TEXT = {
  en: {
    loaded: "Loaded LingoStar state.",
    noSession: "Create or select a language session first.",
    notFound: "Session not found.",
    deleted: "Deleted the language session.",
    missingContext: "The session or section could not be found.",
    sessionStored: (language) => `Stored ${language} session. If no initial section is active, immediately call create_lesson_exercises; do not print exercises in chat text.`,
    sectionStored: (count) => `Stored section with ${count} exercises.`,
    resultsStored: "Exercise results saved.",
    levelJudged: "Level judgment recorded.",
    transcribed: "Audio transcribed.",
    synthesized: "Audio synthesized.",
    feedbackStored: "Feedback submitted.",
  },
  ko: {
    loaded: "LingoStar 상태를 불러왔습니다.",
    noSession: "먼저 언어 학습 세션을 만들거나 선택해 주세요.",
    notFound: "세션을 찾을 수 없습니다.",
    deleted: "언어 학습 세션을 삭제했습니다.",
    missingContext: "세션 또는 섹션을 찾을 수 없습니다.",
    sessionStored: (language) => `${language} 세션을 저장했습니다. 활성 섹션이 없다면 즉시 create_lesson_exercises를 호출하고, 문제를 채팅 본문에 출력하지 마세요.`,
    sectionStored: (count) => `${count}개 문제가 포함된 섹션을 저장했습니다.`,
    resultsStored: "문제 결과를 저장했습니다.",
    levelJudged: "레벨 판단을 기록했습니다.",
    transcribed: "음성을 텍스트로 변환했습니다.",
    synthesized: "음성을 생성했습니다.",
    feedbackStored: "피드백을 접수했습니다.",
  },
};

const FALLBACK_HELP_CONTENT = {
  en: {
    title: "How LingoStar works",
    intro: "LingoStar helps you keep several language learning sessions and practice them inside ChatGPT.",
    features: [
      "Create separate language sessions for each target language and goal.",
      "Practice language information, listening, reading, writing, and speaking in each section.",
      "Some mobile ChatGPT environments may limit speaking. Type an answer or skip the current speaking exercise when needed.",
      "Ask AI inside a lesson without losing the current exercise state.",
      "Change per-area exercise counts, progress context, weakness context, pass threshold, and speech speed in settings.",
      "Send product feedback from any screen with the feedback button."
    ],
    footer: "Target-language content remains in the language you are learning; interface text follows your ChatGPT locale when supported."
  },
  ko: {
    title: "LingoStar 이용 안내",
    intro: "LingoStar는 여러 언어 학습 세션을 만들고 ChatGPT 안에서 이어서 연습할 수 있게 도와줍니다.",
    features: [
      "배우는 언어와 목표별로 별도 학습 세션을 만들 수 있습니다.",
      "각 섹션에서 언어 정보, 듣기, 읽기, 쓰기, 말하기를 함께 연습합니다.",
      "일부 모바일 ChatGPT 환경에서는 말하기가 제한될 수 있습니다. 이 경우 답안을 직접 입력하거나 현재 말하기 문제를 건너뛰세요.",
      "문제 풀이 화면의 Ask AI로 현재 섹션을 유지한 채 질문할 수 있습니다.",
      "설정에서 영역별 문제 수, 진행 상황, 취약점, 통과 점수, 발화 속도를 조정할 수 있습니다.",
      "모든 화면의 피드백 버튼으로 오류나 개선 의견을 보낼 수 있습니다."
    ],
    footer: "학습 대상 언어의 예문과 문제는 해당 언어로 표시하고, 인터페이스는 지원되는 경우 ChatGPT 접속 언어를 따릅니다."
  }
};

function parseHelpMarkdown(markdown, locale) {
  const lines = String(markdown || "").split(/\r?\n/);
  const titleLine = lines.find((line) => line.startsWith("# ")) || "";
  const title = cleanText(titleLine.replace(/^#\s+/, "")) || FALLBACK_HELP_CONTENT[locale]?.title || FALLBACK_HELP_CONTENT.en.title;
  const intro = cleanText(
    lines
      .slice(lines.findIndex((line) => line.startsWith("# ")) + 1)
      .find((line) => line.trim() && !line.startsWith("#") && !line.startsWith("-")) || ""
  ) || FALLBACK_HELP_CONTENT[locale]?.intro || FALLBACK_HELP_CONTENT.en.intro;
  const features = lines
    .filter((line) => line.trim().startsWith("- "))
    .map((line) => cleanText(line.replace(/^\s*-\s+/, "")))
    .filter(Boolean);
  return {
    title,
    intro,
    features: features.length ? features : FALLBACK_HELP_CONTENT[locale]?.features ?? FALLBACK_HELP_CONTENT.en.features,
    footer: "",
    markdown: String(markdown || ""),
    source: "static-md",
  };
}

function loadHelpContent() {
  const loaded = {};
  for (const locale of SUPPORTED_UI_LOCALES) {
    const filePath = HELP_DOC_PATHS[locale];
    if (filePath && existsSync(filePath)) {
      loaded[locale] = parseHelpMarkdown(readFileSync(filePath, "utf8"), locale);
    } else {
      loaded[locale] = { ...FALLBACK_HELP_CONTENT[locale], markdown: "", source: "fallback" };
    }
  }
  return loaded;
}

const HELP_CONTENT = loadHelpContent();

function helpContentFor(locale) {
  const uiLocale = normalizeUiLocale(locale) ?? "en";
  const content = HELP_CONTENT[uiLocale] ?? HELP_CONTENT.en ?? FALLBACK_HELP_CONTENT.en;
  return {
    ...content,
    locale: uiLocale,
    widgetVersion: WIDGET_VERSION,
  };
}

function searchHelpContent(locale, query = "") {
  const help = helpContentFor(locale);
  const needle = cleanText(query).toLowerCase();
  const lines = String(help.markdown || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidates = lines
    .map((line) => line.replace(/^#+\s*/, "").replace(/^-\s*/, ""))
    .filter((line) => line && !line.startsWith("---"));
  const matched = needle
    ? candidates.filter((line) => line.toLowerCase().includes(needle))
    : candidates;
  return {
    locale: help.locale,
    title: help.title,
    query: cleanText(query),
    results: matched.slice(0, 8),
    source: help.source || "static-md",
  };
}

function markdownToHtml(markdown = "") {
  const html = [];
  let inList = false;
  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      continue;
    }
    if (line.startsWith("# ")) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      html.push(`<h1>${htmlEscape(line.replace(/^#\s+/, ""))}</h1>`);
    } else if (line.startsWith("## ")) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      html.push(`<h2>${htmlEscape(line.replace(/^##\s+/, ""))}</h2>`);
    } else if (line.startsWith("- ")) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${htmlEscape(line.replace(/^-\s+/, ""))}</li>`);
    } else {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      html.push(`<p>${htmlEscape(line)}</p>`);
    }
  }
  if (inList) html.push("</ul>");
  return html.join("\n");
}

function ensureTranslationCache(state, requestedLocale = "en") {
  const uiLocale = normalizeUiLocale(requestedLocale) ?? "en";
  if (!state.translationCache || state.translationCache.widgetVersion !== WIDGET_VERSION) {
    state.translationCache = {
      widgetVersion: WIDGET_VERSION,
      locales: {},
      clearedAt: nowIso(),
    };
  }
  state.translationCache.locales[uiLocale] ??= helpContentFor(uiLocale);
  return state.translationCache.locales[uiLocale];
}

/* ------------------------------------------------------------------ */
/*  Utility functions                                                  */
/* ------------------------------------------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

function shortId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeAnswer(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[.,!?;:()[\]{}"'`]/g, "")
    .replace(/\s+/g, " ");
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function firstCleanValue(...values) {
  for (const value of values) {
    const cleaned = cleanText(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function acceptedIssuerValues(value) {
  const raw = cleanText(value);
  if (!raw) return [];
  const withoutSlash = raw.replace(/\/+$/, "");
  const withSlash = withoutSlash ? `${withoutSlash}/` : "";
  return [...new Set([raw, withoutSlash, withSlash].filter(Boolean))];
}

function requestHeader(context, name) {
  const headers = context?.requestInfo?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) ?? headers.get(name.toLowerCase()) ?? "";
  return headers[name] ?? headers[name.toLowerCase()] ?? "";
}

function bearerTokenFromContext(context) {
  const authorization = requestHeader(context, "authorization");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function oauthProtectedResourceMetadata() {
  const metadata = {
    resource: APP_ORIGIN,
    authorization_servers: OAUTH_AUTHORIZATION_SERVERS,
    bearer_methods_supported: ["header"],
    resource_documentation: OAUTH_RESOURCE_DOCUMENTATION,
  };
  if (shouldAdvertiseOAuthScopes()) {
    metadata.scopes_supported = OAUTH_SCOPES;
  }
  if (OAUTH_CLIENT_ID) {
    metadata.client_id = OAUTH_CLIENT_ID;
  }
  return metadata;
}

function shouldAdvertiseOAuthScopes() {
  return OAUTH_SCOPE_MODE !== "none" && OAUTH_SCOPES.length > 0;
}

function shouldEnforceOAuthScopes() {
  return OAUTH_SCOPE_MODE === "strict";
}

function scopeValuesFromClaim(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  return cleanText(value).split(/\s+/).filter(Boolean);
}

function tokenScopes(payload) {
  return new Set([
    ...scopeValuesFromClaim(payload?.scope),
    ...scopeValuesFromClaim(payload?.scp),
    ...scopeValuesFromClaim(payload?.permissions),
  ]);
}

function missingRequiredScopes(requiredScopes, availableScopes) {
  if (!shouldEnforceOAuthScopes()) return [];
  if (!requiredScopes.length) return [];
  if (!availableScopes.size && OAUTH_ALLOW_SCOPELESS_TOKENS) {
    return [];
  }
  return requiredScopes.filter((scope) => !availableScopes.has(scope));
}

function scopesForOAuthRequest(requiredScopes = []) {
  if (OAUTH_SCOPE_MODE === "none") return [];
  return [...new Set([...OAUTH_REQUEST_SCOPES, ...requiredScopes].filter(Boolean))];
}

function tokenClientIds(payload) {
  return [
    payload?.azp,
    payload?.client_id,
    payload?.clientId,
    payload?.cid,
  ]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map(cleanText)
    .filter(Boolean);
}

function tokenClientMatches(payload) {
  if (!OAUTH_CLIENT_ID) return true;
  const clientIds = tokenClientIds(payload);
  return clientIds.length === 0 || clientIds.includes(OAUTH_CLIENT_ID);
}

function describeScopeClaims(payload) {
  return {
    scope: cleanText(payload?.scope),
    scp: Array.isArray(payload?.scp) ? payload.scp.length : 0,
    permissions: Array.isArray(payload?.permissions) ? payload.permissions.length : 0,
  };
}

function authChallengeHeader(scopes = OAUTH_SCOPES, error = "invalid_token", description = "Authentication is required.") {
  const safeDescription = cleanText(description).replace(/"/g, "'");
  const requestedScopes = scopesForOAuthRequest(scopes);
  const scopeText = requestedScopes.length ? `, scope="${requestedScopes.join(" ")}"` : "";
  return `Bearer resource_metadata="${OAUTH_RESOURCE_METADATA_URL}"${scopeText}, error="${error}", error_description="${safeDescription}"`;
}

function authErrorResponse(scopes, error, description) {
  const challenge = authChallengeHeader(scopes, error, description);
  return {
    content: [{ type: "text", text: `Authentication required: ${description}` }],
    _meta: {
      "mcp/www_authenticate": [challenge],
    },
    isError: true,
  };
}

function requiredSecuritySchemes(scopes = []) {
  if (!AUTH_REQUIRED) return [{ type: "noauth" }];
  return [{ type: "oauth2", scopes: scopesForOAuthRequest(scopes) }];
}

function toolMeta(scopes = [], invoking, invoked, options = {}) {
  const securitySchemes = requiredSecuritySchemes(scopes);
  const meta = {
    securitySchemes,
    ui: {
      visibility: ["model", "app"],
    },
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
  if (options.render) {
    meta.ui.resourceUri = WIDGET_URI;
    meta["openai/outputTemplate"] = WIDGET_URI;
  }
  return meta;
}

function renderToolMeta(scopes = [], invoking, invoked) {
  return toolMeta(scopes, invoking, invoked, { render: true });
}

function dataToolMeta(scopes = [], invoking, invoked) {
  return toolMeta(scopes, invoking, invoked, { render: false });
}

function audienceMatches(payload, expectedAudience) {
  if (!expectedAudience) return true;
  const audiences = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud].filter(Boolean);
  if (audiences.includes(expectedAudience)) return true;
  return cleanText(payload?.resource) === expectedAudience;
}

function signingKeySet() {
  const jwksUrl = OAUTH_JWKS_URL || (OAUTH_ISSUER ? `${OAUTH_ISSUER}/.well-known/jwks.json` : "");
  if (!jwksUrl) throw new Error("OAUTH_ISSUER or OAUTH_JWKS_URL must be configured when LINGOSTAR_AUTH_REQUIRED=1.");
  oauthJwks ??= createRemoteJWKSet(new URL(jwksUrl));
  return oauthJwks;
}

async function authorizeContext(context, scopes = []) {
  if (!AUTH_REQUIRED) return { ok: true };
  if (!OAUTH_AUTHORIZATION_SERVERS.length) {
    return {
      ok: false,
      response: authErrorResponse(scopes, "server_error", "OAuth issuer is not configured on this LingoStar server."),
    };
  }

  const token = bearerTokenFromContext(context);
  if (!token) {
    return {
      ok: false,
      response: authErrorResponse(scopes, "invalid_token", "No access token was provided."),
    };
  }

  try {
    const verifyOptions = OAUTH_ISSUER_ACCEPTED.length ? { issuer: OAUTH_ISSUER_ACCEPTED } : {};
    const { payload } = await jwtVerify(token, signingKeySet(), verifyOptions);
    if (!audienceMatches(payload, OAUTH_AUDIENCE)) {
      console.error(`[AUTH_ERROR] Audience mismatch. Expected: ${OAUTH_AUDIENCE}, Payload aud: ${JSON.stringify(payload?.aud)}, Payload resource: ${payload?.resource}`);
      return {
        ok: false,
        response: authErrorResponse(scopes, "invalid_token", "The access token audience does not match this MCP server."),
      };
    }
    if (OAUTH_VALIDATE_CLIENT_ID && !tokenClientMatches(payload)) {
      console.error(`[AUTH_ERROR] Client ID mismatch. Expected: ${OAUTH_CLIENT_ID}, Payload clientIds: ${JSON.stringify(tokenClientIds(payload))}`);
      return {
        ok: false,
        response: authErrorResponse(scopes, "invalid_token", "The access token client does not match this MCP server."),
      };
    }

    const availableScopes = tokenScopes(payload);
    const missingScopes = missingRequiredScopes(scopes, availableScopes);
    if (missingScopes.length) {
      console.error(`[AUTH_ERROR] Missing scopes. Required: ${missingScopes.join(", ")}, Available: ${[...availableScopes].join(", ")}`);
      return {
        ok: false,
        response: authErrorResponse(scopes, "insufficient_scope", `Missing required scope(s): ${missingScopes.join(", ")}.`),
      };
    }

    context.lingostarAuthSubject = cleanText(payload.sub ?? payload.email ?? payload.user_id);
    context.lingostarAuthScopes = [...availableScopes];
    context.lingostarAuthScopeClaims = describeScopeClaims(payload);
    return { ok: true, payload };
  } catch (error) {
    console.error(`[AUTH_ERROR] jwtVerify failed: ${error?.message}`, error);
    return {
      ok: false,
      response: authErrorResponse(scopes, "invalid_token", cleanText(error?.message) || "The access token could not be verified."),
    };
  }
}

function canonicalStoreKey(key) {
  let current = cleanText(key);
  const seen = new Set();
  while (current && storeAliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = storeAliases.get(current);
  }
  return current;
}

function mergeStoreState(target, source) {
  if (!target || !source || target === source) return;
  if ((!target.sessions || target.sessions.length === 0) && source.sessions?.length) {
    target.activeSessionId = source.activeSessionId ?? target.activeSessionId;
    target.sessions = source.sessions;
    target.currentSection = source.currentSection ?? target.currentSection;
    target.recentFeedback = source.recentFeedback ?? target.recentFeedback;
    target.dashboard = source.dashboard ?? target.dashboard;
  }
}

function linkStoreAlias(aliasKey, canonicalKey) {
  const alias = canonicalStoreKey(aliasKey);
  const canonical = canonicalStoreKey(canonicalKey);
  if (!alias || !canonical || alias === canonical) return canonical || alias;

  const aliasState = storesByUser.get(alias);
  const canonicalState = storesByUser.get(canonical);
  if (aliasState && !canonicalState) {
    storesByUser.set(canonical, aliasState);
  } else if (aliasState && canonicalState) {
    mergeStoreState(canonicalState, aliasState);
  }
  storeAliases.set(alias, canonical);
  return canonical;
}

function getUserKey(context) {
  if (DEVELOPER_MODE) return "developer-mode:local-demo-user";

  const meta = context?._meta ?? {};
  const authExtra = context?.authInfo?.extra ?? {};
  const userKey = firstCleanValue(
    context?.lingostarAuthSubject,
    context?.authInfo?.subject,
    authExtra.subject,
    authExtra.sub,
    authExtra.user,
    authExtra.user_id,
    authExtra.userId,
    meta["openai/subject"],
    meta["openai/user"],
    meta["openai/user_id"],
    meta["openai/userId"],
    meta["gemini/user_id"],
    meta["gemini/user"],
    meta["gemini/userId"],
    meta["google/user_id"],
    meta["google/user"],
    meta["google/userId"],
    meta["user"],
    meta["user_id"],
    meta["userId"],
    meta["sub"],
    requestHeader(context, "x-openai-subject"),
    requestHeader(context, "x-openai-user-id"),
    requestHeader(context, "x-user-id")
  );

  const sessionKey = firstCleanValue(
    context?.sessionId,
    meta["openai/session"],
    meta["openai/conversation"],
    meta["openai/conversation_id"],
    meta["openai/chat_id"],
    meta["openai/thread_id"],
    meta["gemini/session"],
    meta["gemini/conversation"],
    meta["gemini/session_id"],
    meta["gemini/conversation_id"],
    meta["google/session"],
    meta["google/conversation"],
    meta["google/session_id"],
    meta["google/conversation_id"],
    meta["conversation"],
    meta["conversationId"],
    meta["conversation_id"],
    requestHeader(context, "mcp-session-id"),
    requestHeader(context, "x-openai-session-id"),
    requestHeader(context, "x-openai-conversation-id")
  );
  const canonicalUserKey = userKey ? `user:${userKey}` : "";
  const canonicalSessionKey = sessionKey ? `session:${sessionKey}` : "";

  if (canonicalUserKey && canonicalSessionKey) {
    return linkStoreAlias(canonicalSessionKey, canonicalUserKey);
  }
  if (canonicalUserKey) return canonicalStoreKey(canonicalUserKey);
  if (canonicalSessionKey) return canonicalStoreKey(canonicalSessionKey);

  return "anonymous:local-demo-user";
}

function interfaceLanguage(nativeLanguage, setting = "auto", requestedLocale = "en") {
  if (setting === "en" || setting === "ko") return setting;
  const locale = normalizeUiLocale(requestedLocale);
  if (locale) return locale;
  const normalized = cleanText(nativeLanguage).toLowerCase();
  if (
    normalized.includes("ko") ||
    normalized.includes("korean") ||
    normalized.includes("한국") ||
    normalized.includes("한국어")
  ) {
    return "ko";
  }
  return "en";
};

function textFor(sessionOrLocale) {
  const locale =
    typeof sessionOrLocale === "string"
      ? sessionOrLocale
      : sessionOrLocale?.runtime?.interfaceLanguage ?? "en";
  return TEXT[locale] ?? TEXT.en;
}

function splitList(value) {
  if (Array.isArray(value)) {
    return value.map(cleanText).filter(Boolean);
  }
  return cleanText(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferLearnerStage(session = {}) {
  const raw = [
    session.stage,
    session.goal?.detail,
    session.goalType,
    session.progressContext,
    session.weaknessContext,
    ...(session.levels ?? []).map((level) => `${level.name ?? ""} ${level.cefr ?? ""}`),
  ].join(" ").toLowerCase();
  if (["foundation", "absolute beginner", "alphabet", "script", "pronunciation", "hangul", "kana", "hiragana", "katakana", "기초", "문자", "발음", "가나", "히라가나", "가타카나", "한글"].some((term) => raw.includes(term))) return "foundation";
  if (["intro", "a1", "n5", "입문", "초급"].some((term) => raw.includes(term))) return "intro";
  if (["advanced", "c1", "c2", "n1", "심화", "고급"].some((term) => raw.includes(term))) return "advanced";
  if (["intermediate", "b1", "b2", "n3", "n2", "중급"].some((term) => raw.includes(term))) return "intermediate";
  return "foundation";
};

function enabledSkillsForSession(session) {
  return session?.settings?.speakingEnabled === false
    ? SKILLS.filter((skill) => skill !== "speaking")
    : [...SKILLS];
}

function enabledExerciseAreasForSession(session) {
  return session?.settings?.speakingEnabled === false
    ? EXERCISE_AREAS.filter((area) => area !== "speaking")
    : [...EXERCISE_AREAS];
}

function normalizeAreaName(value) {
  const area = cleanText(value).toLowerCase();
  if (area === "info" || area === "language-info" || area === "languageinfo") return "language_info";
  return EXERCISE_AREAS.includes(area) ? area : area;
}

function clampExerciseCount(value, fallback = DEFAULT_EXERCISES_PER_AREA) {
  return clampInteger(value, MIN_EXERCISES_PER_AREA, MAX_EXERCISES_PER_AREA, fallback);
}

function normalizeExerciseCounts(input = {}, fallback = DEFAULT_EXERCISES_PER_AREA) {
  const source = typeof input === "object" && input ? input : {};
  const counts = {};
  for (const area of EXERCISE_AREAS) {
    counts[area] = clampExerciseCount(source[area], fallback);
  }
  return counts;
}

function exerciseCountsForSession(session) {
  const fallback = clampExerciseCount(session?.settings?.exercisesPerSkill, DEFAULT_EXERCISES_PER_AREA);
  return normalizeExerciseCounts(session?.settings?.exerciseCounts, fallback);
}

function countExercisesByArea(exercises = []) {
  const counts = Object.fromEntries(EXERCISE_AREAS.map((area) => [area, 0]));
  for (const exercise of exercises) {
    const area = normalizeAreaName(exercise?.skill || exercise?.type);
    if (counts[area] !== undefined) counts[area] += 1;
  }
  return counts;
}

function inferExercisesPerArea(exercises = [], enabledAreas = EXERCISE_AREAS) {
  const counts = countExercisesByArea(exercises);
  const values = enabledAreas.map((area) => counts[area]).filter((count) => count > 0);
  if (!values.length) return DEFAULT_EXERCISES_PER_AREA;
  return Math.min(...values);
}

function normalizeExercises(exercises, enabledAreas = EXERCISE_AREAS) {
  if (!exercises || !Array.isArray(exercises)) return [];
  const counts = {};
  for (const area of enabledAreas) counts[area] = 0;
  
  return exercises.map((e) => {
    const skill = normalizeAreaName(e.skill || e.type || "language_info");
    counts[skill] = (counts[skill] || 0) + 1;
    return {
      ...e,
      id: e.id || shortId("ex"),
      type: e.type || skill,
      skill: skill,
      sequence: e.sequence || counts[skill],
      prompt: e.prompt || "Please answer the question.",
      instructions: e.instructions || "",
      payload: e.payload || {}
    };
  });
}

function expectedExerciseCount(session, exerciseCounts) {
  return enabledExerciseAreasForSession(session).reduce(
    (sum, area) => sum + (exerciseCounts[area] ?? DEFAULT_EXERCISES_PER_AREA),
    0
  );
}

function validateSectionSkillCounts(section, session) {
  const exercises = section?.exercises ?? [];
  const enabledAreas = enabledExerciseAreasForSession(session);
  const disabledAreas = EXERCISE_AREAS.filter((area) => !enabledAreas.includes(area));
  const fallbackCount = clampExerciseCount(
    section?.exercisesPerSkill,
    clampExerciseCount(session?.settings?.exercisesPerSkill, DEFAULT_EXERCISES_PER_AREA)
  );
  const sessionCounts = exerciseCountsForSession(session);
  const exerciseCounts = normalizeExerciseCounts(
    section?.exerciseCounts ?? sessionCounts,
    fallbackCount
  );
  const counts = countExercisesByArea(exercises);
  const errors = [];

  for (const area of enabledAreas) {
    if (counts[area] !== exerciseCounts[area]) {
      errors.push(`${area}: expected ${exerciseCounts[area]}, received ${counts[area]}`);
    }
  }
  for (const area of disabledAreas) {
    if (counts[area] > 0) {
      errors.push(`${area}: expected 0 because this area is disabled, received ${counts[area]}`);
    }
  }

  for (const exercise of exercises) {
    const label = exercise?.id || `sequence ${exercise?.sequence ?? "?"}`;
    if (exercise.type !== exercise.skill) {
      errors.push(`${label}: type and skill must match`);
    }
    if (exercise.type === "language_info") {
      if (!cleanText(exercise.payload?.topic)) errors.push(`${label}: language_info.topic is required`);
      if (!cleanText(exercise.payload?.explanation)) errors.push(`${label}: language_info.explanation is required`);
      if (!Array.isArray(exercise.payload?.targetExamples) || exercise.payload.targetExamples.length === 0) {
        errors.push(`${label}: language_info.targetExamples is required`);
      }
      if (!cleanText(exercise.payload?.question)) errors.push(`${label}: language_info.question is required`);
      const choiceCount = Array.isArray(exercise.payload?.choices) ? exercise.payload.choices.length : 0;
      if (choiceCount < 3 || choiceCount > 5) errors.push(`${label}: language_info.choices must contain 3-5 choices`);
      if (!cleanText(exercise.payload?.correctChoiceId)) errors.push(`${label}: language_info.correctChoiceId is required`);
      if (Array.isArray(exercise.payload?.choices) && cleanText(exercise.payload?.correctChoiceId)) {
        const choiceIds = exercise.payload.choices.map((choice, index) =>
          typeof choice === "string" ? String(index) : cleanText(choice.id)
        );
        if (!choiceIds.includes(cleanText(exercise.payload.correctChoiceId))) {
          errors.push(`${label}: language_info.correctChoiceId must match one of the choice ids`);
        }
      }
    }
    if (exercise.type === "listening") {
      if (!cleanText(exercise.payload?.audioText)) errors.push(`${label}: listening.audioText is required`);
      if (!cleanText(exercise.payload?.question)) errors.push(`${label}: listening.question is required`);
      if (!Array.isArray(exercise.payload?.choices) || exercise.payload.choices.length !== 5) {
        errors.push(`${label}: listening.choices must contain exactly 5 choices`);
      }
      if (!cleanText(exercise.payload?.correctChoiceId)) errors.push(`${label}: listening.correctChoiceId is required`);
      if (Array.isArray(exercise.payload?.choices) && cleanText(exercise.payload?.correctChoiceId)) {
        const choiceIds = exercise.payload.choices.map((choice, index) =>
          typeof choice === "string" ? String(index) : cleanText(choice.id)
        );
        if (!choiceIds.includes(cleanText(exercise.payload.correctChoiceId))) {
          errors.push(`${label}: listening.correctChoiceId must match one of the choice ids`);
        }
      }
    }
    if (exercise.type === "reading") {
      if (!cleanText(exercise.payload?.passage)) errors.push(`${label}: reading.passage is required`);
      if (!cleanText(exercise.payload?.question)) errors.push(`${label}: reading.question is required`);
      const choiceCount = Array.isArray(exercise.payload?.choices) ? exercise.payload.choices.length : 0;
      if (choiceCount < 3 || choiceCount > 5) {
        errors.push(`${label}: reading.choices must contain 3-5 choices`);
      }
      if (!cleanText(exercise.payload?.correctChoiceId)) errors.push(`${label}: reading.correctChoiceId is required`);
      if (Array.isArray(exercise.payload?.choices) && cleanText(exercise.payload?.correctChoiceId)) {
        const choiceIds = exercise.payload.choices.map((choice, index) =>
          typeof choice === "string" ? String(index) : cleanText(choice.id)
        );
        if (!choiceIds.includes(cleanText(exercise.payload.correctChoiceId))) {
          errors.push(`${label}: reading.correctChoiceId must match one of the choice ids`);
        }
      }
    }
    if (exercise.type === "writing") {
      if (!cleanText(exercise.payload?.targetSentence ?? exercise.payload?.text)) {
        errors.push(`${label}: writing.targetSentence or writing.text is required`);
      }
      if (!Array.isArray(exercise.payload?.tokens) || exercise.payload.tokens.length === 0) {
        errors.push(`${label}: writing.tokens is required`);
      }
    }
    if (exercise.type === "speaking") {
      if (!cleanText(exercise.payload?.scenario)) errors.push(`${label}: speaking.scenario is required`);
      if (!cleanText(exercise.payload?.exampleResponse)) errors.push(`${label}: speaking.exampleResponse is required`);
    }
  }

  return {
    ok: errors.length === 0,
    exercisesPerSkill: fallbackCount,
    exerciseCounts,
    expectedTotal: expectedExerciseCount(session, exerciseCounts),
    actualTotal: exercises.length,
    counts,
    errors,
  };
}

sectionValidationMessage = function sectionValidationMessage(session, validation) {
  const locale = session?.runtime?.interfaceLanguage ?? "en";
  if (locale === "ko") {
    return `섹션 구조가 맞지 않습니다. 영역별 설정 개수에 맞춰 총 ${validation.expectedTotal}개가 필요합니다. 현재 ${validation.actualTotal}개입니다. 세부: ${validation.errors.join("; ")}`;
  }
  return `Invalid section shape. Expected configured per-area exercise counts, ${validation.expectedTotal} total. Received ${validation.actualTotal}. Details: ${validation.errors.join("; ")}`;
}

function sectionValidationMessage(session, validation) {
  const locale = session?.runtime?.interfaceLanguage ?? "en";
  if (locale === "ko") {
    return `섹션 구조가 올바르지 않습니다. 영역별 설정 개수에 맞춰 총 ${validation.expectedTotal}개 문제가 필요하지만 현재 ${validation.actualTotal}개입니다. 세부 오류: ${validation.errors.join("; ")}`;
  }
  return `Invalid section shape. Expected configured per-area exercise counts, ${validation.expectedTotal} total. Received ${validation.actualTotal}. Details: ${validation.errors.join("; ")}`;
};

function allowedCorsOrigin(origin) {
  if (!origin || origin === "*") return CORS_ALLOWED_ORIGINS[0] ?? "*";
  return CORS_ALLOWED_ORIGINS.includes(origin) ? origin : CORS_ALLOWED_ORIGINS[0] ?? "*";
}

/* ------------------------------------------------------------------ */
/*  Audio helpers                                                      */
/* ------------------------------------------------------------------ */

function audioFileExtension(mimeType = "") {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("m4a")) return "m4a";
  return "webm";
}

function audioMimeType(format = "") {
  const normalized = cleanText(format).toLowerCase();
  if (normalized === "wav") return "audio/wav";
  if (normalized === "opus") return "audio/ogg";
  if (normalized === "aac") return "audio/aac";
  if (normalized === "flac") return "audio/flac";
  if (normalized === "pcm") return "audio/pcm";
  return "audio/mpeg";
}

function normalizeAudioBase64(audioBase64) {
  const raw = cleanText(audioBase64);
  return raw.includes(",") ? raw.split(",").at(-1) : raw;
}

function speechLanguageCode(speechLang = "") {
  return cleanText(speechLang).split("-")[0] || undefined;
}

function speechLangForTargetLanguage(targetLanguage = "") {
  const raw = cleanText(targetLanguage).toLowerCase();
  if (!raw) return "";
  const entries = [
    [["japanese", "日本語", "일본어", "ja"], "ja-JP"],
    [["korean", "한국어", "조선말", "ko"], "ko-KR"],
    [["english", "영어", "en"], "en-US"],
    [["french", "français", "프랑스어", "fr"], "fr-FR"],
    [["spanish", "español", "스페인어", "es"], "es-ES"],
    [["german", "deutsch", "독일어", "de"], "de-DE"],
    [["italian", "italiano", "이탈리아어", "it"], "it-IT"],
    [["chinese", "中文", "mandarin", "중국어", "zh"], "zh-CN"],
    [["portuguese", "português", "포르투갈어", "pt"], "pt-BR"],
    [["russian", "русский", "러시아어", "ru"], "ru-RU"],
    [["arabic", "العربية", "아랍어", "ar"], "ar-SA"],
  ];
  for (const [aliases, speechLang] of entries) {
    if (aliases.some((alias) => raw.includes(alias.toLowerCase()))) return speechLang;
  }
  return "";
}

function openAiAudioUnavailableMessage(sessionOrLocale) {
  const locale =
    typeof sessionOrLocale === "string"
      ? sessionOrLocale
      : sessionOrLocale?.runtime?.interfaceLanguage ?? "en";
  if (!IS_AI_FALLBACK) {
    return locale === "ko"
      ? "이 환경에서는 음성 기능을 사용할 수 없습니다. 답안을 직접 입력하거나 현재 문제를 건너뛰세요."
      : "Speech is unavailable in this environment. Type an answer or skip the current exercise.";
  }
  return locale === "ko"
    ? "음성 처리를 사용할 수 없습니다. 브라우저 음성 기능, 직접 입력, 또는 건너뛰기를 사용해 주세요."
    : "Audio processing is unavailable. Use browser audio, manual input, or skip the current exercise.";
}

function openAiAudioErrorMessage(sessionOrLocale, error) {
  const locale =
    typeof sessionOrLocale === "string"
      ? sessionOrLocale
      : sessionOrLocale?.runtime?.interfaceLanguage ?? "en";
  const detail = cleanText(error?.message).slice(0, 500);
  return locale === "ko"
    ? `OpenAI 음성 처리 중 오류가 발생했습니다.${detail ? ` (${detail})` : ""}`
    : `OpenAI audio failed.${detail ? ` (${detail})` : ""}`;
};

/* ------------------------------------------------------------------ */
/*  OpenAI STT                                                         */
/* ------------------------------------------------------------------ */

async function transcribeSpeechWithOpenAI({ audioBase64, mimeType = "audio/webm", speechLang }) {
  const buffer = Buffer.from(normalizeAudioBase64(audioBase64), "base64");
  if (!buffer.length) throw new Error("No audio bytes were provided.");

  const formData = new FormData();
  formData.append("model", OPENAI_STT_MODEL);
  const language = speechLanguageCode(speechLang);
  if (language) formData.append("language", language);
  formData.append(
    "file",
    new Blob([buffer], { type: mimeType }),
    `speech.${audioFileExtension(mimeType)}`
  );

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return cleanText(data.text ?? data.transcript ?? "");
}

async function synthesizeSpeechWithOpenAI({ text, voice, format, speed }) {
  const input = cleanText(text);
  if (!input) throw new Error("No speech text was provided.");

  const audioFormat = cleanText(format) || OPENAI_TTS_FORMAT;
  const body = {
    model: OPENAI_TTS_MODEL,
    input,
    voice: cleanText(voice) || OPENAI_TTS_VOICE,
    format: audioFormat,
  };
  if (speed !== undefined) {
    body.speed = Math.max(0.25, Math.min(4, Number(speed) || 1));
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }

  const mimeType = audioMimeType(audioFormat);
  const audioBase64 = Buffer.from(await response.arrayBuffer()).toString("base64");
  return {
    audioDataUrl: `data:${mimeType};base64,${audioBase64}`,
    mimeType,
  };
}

/* ------------------------------------------------------------------ */
/*  State factory                                                      */
/* ------------------------------------------------------------------ */

function createEmptyState() {
  return {
    version: SERVICE_VERSION,
    activeSessionId: null,
    sessions: [],
    currentSection: null,
    recentFeedback: [],
    feedbackItems: [],
    translationCache: {
      widgetVersion: WIDGET_VERSION,
      locales: {},
      clearedAt: nowIso(),
    },
    agentContexts: {
      userAgent: {
        stableUserId: "",
        note: "Manages the stable LingoStar user namespace for this ChatGPT user.",
        updatedAt: nowIso(),
      },
      languageSelection: {
        activeSessionId: null,
        languages: [],
        updatedAt: nowIso(),
      },
      trackingAgent: {
        contextsBySessionId: {},
        updatedAt: nowIso(),
      },
      problemManagementAgent: {
        weaknessesBySessionId: {},
        updatedAt: nowIso(),
      },
    },
    dashboard: {
      totalSessions: 0,
      activeLanguage: null,
      nextBestAction: "prompt_gpt",
      averageProgress: 0,
    },
    host: {},
    gui: {
      screen: "oobe",
      widgetVersion: WIDGET_VERSION,
      help: helpContentFor("en"),
      supportedDisplayLanguages: ["auto", "en", "ko"],
      icon: ICON_URL || "fallback",
      audio: {
        browserSpeechSynthesis: true,
        browserSpeechRecognition: true,
        aiFallbackEnabled: IS_AI_FALLBACK,
        openAiSttConfigured: Boolean(OPENAI_API_KEY),
        openAiSttModel: OPENAI_STT_MODEL,
        openAiTtsConfigured: Boolean(OPENAI_API_KEY),
        openAiTtsModel: OPENAI_TTS_MODEL,
        openAiTtsVoice: OPENAI_TTS_VOICE,
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/*  State access                                                       */
/* ------------------------------------------------------------------ */

function firestoreDocumentId(userKey) {
  return Buffer.from(cleanText(userKey) || "anonymous", "utf8").toString("base64url");
}

let googleAccessToken = "";
let googleAccessTokenExpiry = 0;

async function googleMetadataAccessToken() {
  if (googleAccessToken && Date.now() < googleAccessTokenExpiry - 60_000) return googleAccessToken;
  const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!response.ok) throw new Error(`Metadata token request failed: ${response.status}`);
  const data = await response.json();
  googleAccessToken = data.access_token;
  googleAccessTokenExpiry = Date.now() + Number(data.expires_in ?? 300) * 1000;
  return googleAccessToken;
}

function firestoreDocumentUrl(userKey) {
  if (!FIRESTORE_PROJECT_ID) {
    throw new Error("FIRESTORE_PROJECT_ID or GOOGLE_CLOUD_PROJECT is required when LINGOSTAR_STATE_STORE=firestore.");
  }
  const db = encodeURIComponent(FIRESTORE_DATABASE_ID);
  const collection = encodeURIComponent(FIRESTORE_COLLECTION);
  const docId = encodeURIComponent(firestoreDocumentId(userKey));
  return `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/${db}/documents/${collection}/${docId}`;
}

async function loadStateFromFirestore(userKey) {
  const token = await googleMetadataAccessToken();
  const response = await fetch(firestoreDocumentUrl(userKey), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return createEmptyState();
  if (!response.ok) throw new Error(`Firestore load failed: ${response.status} ${await response.text()}`);
  const doc = await response.json();
  const stateJson = doc.fields?.stateJson?.stringValue;
  if (!stateJson) return createEmptyState();
  return JSON.parse(stateJson);
}

async function saveStateToFirestore(userKey, state) {
  const token = await googleMetadataAccessToken();
  const response = await fetch(`${firestoreDocumentUrl(userKey)}?updateMask.fieldPaths=stateJson&updateMask.fieldPaths=updatedAt`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        stateJson: { stringValue: JSON.stringify(state) },
        updatedAt: { timestampValue: nowIso() },
      },
    }),
  });
  if (!response.ok) throw new Error(`Firestore save failed: ${response.status} ${await response.text()}`);
}

const FEEDBACK_INDEX_KEY = "global:feedback-index";

async function loadFeedbackItems() {
  if (STATE_STORE === "firestore") {
    const feedbackState = await loadStateFromFirestore(FEEDBACK_INDEX_KEY);
    return Array.isArray(feedbackState.feedbackItems) ? feedbackState.feedbackItems : [];
  }
  return feedbackItemsMemory;
}

async function saveFeedbackItems(items) {
  const capped = items.slice(-2000);
  if (STATE_STORE === "firestore") {
    const feedbackState = createEmptyState();
    feedbackState.feedbackItems = capped;
    await saveStateToFirestore(FEEDBACK_INDEX_KEY, feedbackState);
    return;
  }
  feedbackItemsMemory = capped;
}

async function appendFeedbackItem(context, state, args = {}) {
  const message = cleanText(args.message).slice(0, 4000);
  if (!message) return null;
  const items = await loadFeedbackItems();
  const lastSequence = items.reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0);
  const sequence = lastSequence + 1;
  const item = {
    id: `feedback-${String(sequence).padStart(6, "0")}`,
    sequence,
    createdAt: nowIso(),
    widgetVersion: WIDGET_VERSION,
    serviceVersion: SERVICE_VERSION,
    userRef: firestoreDocumentId(getUserKey(context)),
    sessionId: cleanText(args.sessionId),
    sectionId: cleanText(args.sectionId),
    exerciseId: cleanText(args.exerciseId),
    screen: cleanText(args.screen || state.gui?.screen || "unknown"),
    severity: cleanText(args.severity || "feedback"),
    message,
  };
  items.push(item);
  await saveFeedbackItems(items);

  state.feedbackItems ??= [];
  state.feedbackItems.unshift(item);
  state.feedbackItems = state.feedbackItems.slice(0, 100);
  state.recentFeedback ??= [];
  state.recentFeedback.unshift({
    id: item.id,
    sessionId: item.sessionId,
    skill: "product_feedback",
    text: item.message,
    createdAt: item.createdAt,
  });
  state.recentFeedback = state.recentFeedback.slice(0, 50);
  return item;
}

async function getState(context) {
  const userKey = getUserKey(context);
  if (STATE_STORE === "firestore") {
    const state = await loadStateFromFirestore(userKey);
    storesByUser.set(userKey, state);
    return migrateState(state, requestedLocaleFromContext(context), userKey);
  }
  if (!storesByUser.has(userKey)) {
    storesByUser.set(userKey, createEmptyState());
  }
  return migrateState(storesByUser.get(userKey), requestedLocaleFromContext(context), userKey);
}

async function saveState(context, state) {
  const userKey = getUserKey(context);
  refreshDashboard(state);
  storesByUser.set(userKey, state);
  if (STATE_STORE === "firestore") {
    await saveStateToFirestore(userKey, state);
  }
  return state;
}

/* ------------------------------------------------------------------ */
/*  Migration                                                          */
/* ------------------------------------------------------------------ */

function migrateState(state, requestedLocale = "en", userKey = "") {
  state.version = SERVICE_VERSION;

  // Host metadata
  state.host ??= {};
  state.host.locale = requestedLocale || "en";
  state.host.interfaceLanguage = normalizeUiLocale(requestedLocale) ?? "en";
  state.host.developerMode = DEVELOPER_MODE;

  // GUI
  state.gui ??= {};
  state.gui.widgetVersion = WIDGET_VERSION;
  state.gui.help = ensureTranslationCache(state, state.host.interfaceLanguage || requestedLocale || "en");
  state.gui.supportedDisplayLanguages ??= ["auto", "en", "ko"];
  state.gui.icon = ICON_URL || "fallback";
  state.gui.audio = {
    browserSpeechSynthesis: true,
    browserSpeechRecognition: true,
    openAiSttConfigured: Boolean(OPENAI_API_KEY),
    openAiSttModel: OPENAI_STT_MODEL,
    openAiTtsConfigured: Boolean(OPENAI_API_KEY),
    openAiTtsModel: OPENAI_TTS_MODEL,
    openAiTtsVoice: OPENAI_TTS_VOICE,
    aiFallbackEnabled: IS_AI_FALLBACK,
  };

  // New fields
  state.recentFeedback ??= [];
  state.feedbackItems ??= [];
  state.currentSection ??= null;

  // Remove old v0.2.0 fields
  delete state.currentLesson;
  delete state.generationMemory;

  // Migrate sessions
  for (const session of state.sessions ?? []) {
    session.settings ??= {};
    session.settings.displayLanguage ??= "auto";
    session.settings.exercisesPerSkill = clampExerciseCount(session.settings.exercisesPerSkill, DEFAULT_EXERCISES_PER_AREA);
    session.settings.exerciseCounts = normalizeExerciseCounts(session.settings.exerciseCounts, session.settings.exercisesPerSkill);
    session.settings.sectionPassThreshold = clampInteger(session.settings.sectionPassThreshold, 0, 100, 85);
    session.settings.minSectionsForGoalCompletion = Math.max(10, clampInteger(session.settings.minSectionsForGoalCompletion, 10, 500, 10));
    session.settings.ttsRate = Math.max(0.6, Math.min(1.4, Number(session.settings.ttsRate) || 1));
    session.settings.speakingEnabled ??= true;
    session.settings.levelMode ??= "cefr";
    session.stage = learnerStageSchema.safeParse(session.stage).success ? session.stage : inferLearnerStage(session);
    session.progressContext = cleanText(session.progressContext);
    session.weaknessContext = cleanText(session.weaknessContext);
    session.runtime ??= {};
    session.runtime.interfaceLanguage = interfaceLanguage(
      session.nativeLanguage,
      session.settings.displayLanguage,
      requestedLocale
    );
    session.runtime.speechLang ||= speechLangForTargetLanguage(session.targetLanguage);

    // Sanitize levels
    session.levels ??= [];
    for (const lvl of session.levels) {
      lvl.id ??= shortId("level");
      lvl.name = String(lvl.name ?? lvl.cefr ?? lvl.id ?? "").trim() || "Level";
      lvl.status ??= "active";
      lvl.sections ??= [];
    }

    // Sanitize skillProfile (prevent NaN string/number errors)
    const coerceScore = (v) => {
      const parsed = Number(v);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    session.skillProfile ??= {};
    session.skillProfile.language_info = coerceScore(session.skillProfile.language_info);
    session.skillProfile.speaking = coerceScore(session.skillProfile.speaking);
    session.skillProfile.writing = coerceScore(session.skillProfile.writing);
    session.skillProfile.listening = coerceScore(session.skillProfile.listening);
    session.skillProfile.reading = coerceScore(session.skillProfile.reading);

    session.feedbackMemory ??= [];
    session.sectionHistory ??= [];
    session.goal ??= { type: session.goalType || "conversation", detail: "" };
    session.goal.status ??= "active";
    session.goal.startedAt ??= session.createdAt ?? nowIso();

    // Remove old v0.2.0 session fields
    delete session.generationMemory;
    delete session.lessonHistory;
    delete session.capabilityMap;
    delete session.plan;
    delete session.progress;
    delete session.level;
  }

  refreshAgentContexts(state, userKey);
  return state;
}

function refreshAgentContexts(state, userKey = "") {
  state.agentContexts ??= {};
  state.agentContexts.userAgent ??= {};
  state.agentContexts.userAgent.stableUserId ||= firestoreDocumentId(userKey || "anonymous");
  state.agentContexts.userAgent.note = "Manages the stable LingoStar user namespace for this ChatGPT user.";
  state.agentContexts.userAgent.updatedAt = nowIso();

  state.agentContexts.languageSelection = {
    activeSessionId: state.activeSessionId ?? null,
    languages: (state.sessions ?? []).map((session) => ({
      sessionId: session.id,
      targetLanguage: session.targetLanguage,
      nativeLanguage: session.nativeLanguage,
      goal: session.goal,
      stage: session.stage,
      status: session.status,
    })),
    updatedAt: nowIso(),
  };

  const tracking = {};
  const weaknesses = {};
  for (const session of state.sessions ?? []) {
    tracking[session.id] = {
      targetLanguage: session.targetLanguage,
      nativeLanguage: session.nativeLanguage,
      stage: session.stage,
      progressContext: session.progressContext || "",
      skillProfile: session.skillProfile ?? {},
      sectionCount: session.sectionHistory?.length ?? 0,
      updatedAt: session.updatedAt ?? nowIso(),
    };
    weaknesses[session.id] = {
      targetLanguage: session.targetLanguage,
      nativeLanguage: session.nativeLanguage,
      weaknessContext: session.weaknessContext || "",
      recentFeedback: (state.recentFeedback ?? []).filter((item) => item.sessionId === session.id).slice(0, 10),
      updatedAt: session.updatedAt ?? nowIso(),
    };
  }
  state.agentContexts.trackingAgent = {
    contextsBySessionId: tracking,
    updatedAt: nowIso(),
  };
  state.agentContexts.problemManagementAgent = {
    weaknessesBySessionId: weaknesses,
    updatedAt: nowIso(),
  };
}

/* ------------------------------------------------------------------ */
/*  Dashboard refresh                                                  */
/* ------------------------------------------------------------------ */

function refreshDashboard(state) {
  migrateState(state, state.host?.locale ?? "en");
  refreshAgentContexts(state);

  const active =
    state.sessions.find((session) => session.id === state.activeSessionId) ?? null;

  // Count total completed sections across all sessions
  let totalCompletedSections = 0;
  let totalSkillScore = 0;
  let sessionCount = state.sessions.length;

  for (const session of state.sessions) {
    const completedSections = (session.sectionHistory ?? []).filter(
      (s) => s.status === "completed"
    ).length;
    totalCompletedSections += completedSections;

    const profile = session.skillProfile ?? { speaking: 0, writing: 0, listening: 0, reading: 0 };
    const avg =
      (profile.speaking + profile.writing + profile.listening + profile.reading) / 4;
    totalSkillScore += avg;
  }

  const averageProgress = sessionCount > 0 ? totalSkillScore / sessionCount : 0;

  // Determine nextBestAction
  let nextBestAction = "prompt_gpt";
  if (state.sessions.length === 0) {
    nextBestAction = "prompt_gpt";
  } else if (state.currentSection) {
    nextBestAction = "continue_section";
  } else {
    nextBestAction = "prompt_new_section";
  }

  state.dashboard = {
    totalSessions: state.sessions.length,
    totalCompletedSections,
    activeLanguage: active?.targetLanguage ?? null,
    nextBestAction,
    averageProgress: Number(averageProgress.toFixed(3)),
  };

  // GUI screen
  if (state.currentSection) {
    state.gui.screen = "lesson";
  } else if (state.sessions.length > 0) {
    state.gui.screen = "dashboard";
  } else {
    state.gui.screen = "oobe";
  }

  return state;
}

/* ------------------------------------------------------------------ */
/*  Reply helper                                                       */
/* ------------------------------------------------------------------ */

function replyWithState(state, message, isError = false) {
  refreshDashboard(state);
  return {
    content: message ? [{ type: "text", text: message }] : [],
    structuredContent: { state },
    isError: isError,
  };
}

/* ------------------------------------------------------------------ */
/*  Session / section finders                                          */
/* ------------------------------------------------------------------ */

function findSession(state, sessionId) {
  return state.sessions.find((session) => session.id === sessionId);
}

function exerciseIdsForSection(section) {
  return (section.exercises ?? []).map((exercise) => exercise.id);
}

function computeSectionScore(section, session) {
  const results = section.results ?? [];
  const bySkill = {};
  for (const area of Object.keys(SECTION_SCORE_WEIGHTS)) bySkill[area] = [];
  for (const result of results) {
    if (bySkill[result.skill]) bySkill[result.skill].push(Math.max(0, Math.min(100, Number(result.score) || 0)));
  }

  let weightedScore = 0;
  for (const [skill, weight] of Object.entries(SECTION_SCORE_WEIGHTS)) {
    const scores = bySkill[skill] ?? [];
    const average = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
    weightedScore += average * weight;
  }
  const threshold = clampInteger(session?.settings?.sectionPassThreshold, 0, 100, 85);
  return {
    weightedScore: Number(weightedScore.toFixed(1)),
    threshold,
    passed: weightedScore >= threshold,
    weights: SECTION_SCORE_WEIGHTS,
  };
}

function completedSectionsSinceGoalStart(session) {
  const startedAt = Date.parse(session?.goal?.lastCompletedAt ?? session?.goal?.startedAt ?? session?.createdAt ?? 0);
  return (session?.sectionHistory ?? []).filter((section) => {
    if (!["completed", "passed"].includes(section.status)) return false;
    const completedAt = Date.parse(section.completedAt ?? 0);
    return !startedAt || completedAt >= startedAt;
  }).length;
}

const READ_SCOPES = ["lingostar.read"];
const WRITE_SCOPES = ["lingostar.write"];
const AUDIO_SCOPES = ["lingostar.audio"];

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function feedbackAdminAuthorized(req) {
  if (!FEEDBACK_ADMIN_ID || !FEEDBACK_ADMIN_PASSWORD) return false;
  const header = cleanText(req.headers.authorization);
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const splitAt = decoded.indexOf(":");
  if (splitAt < 0) return false;
  const id = decoded.slice(0, splitAt);
  const password = decoded.slice(splitAt + 1);
  return id === FEEDBACK_ADMIN_ID && password === FEEDBACK_ADMIN_PASSWORD;
}

function feedbackUnauthorized(res) {
  res.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "www-authenticate": 'Basic realm="LingoStar feedback"',
  }).end("Feedback admin credentials are required.");
}

function renderFeedbackPage(items, page, pageSize) {
  const sorted = [...items].sort((a, b) => (Number(b.sequence) || 0) - (Number(a.sequence) || 0));
  const total = sorted.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(1, Math.min(page, pageCount));
  const start = (safePage - 1) * pageSize;
  const rows = sorted.slice(start, start + pageSize);
  const nav = `
    <nav>
      ${safePage > 1 ? `<a href="/feedback?page=${safePage - 1}&pageSize=${pageSize}">Previous</a>` : "<span>Previous</span>"}
      <strong>Page ${safePage} / ${pageCount}</strong>
      ${safePage < pageCount ? `<a href="/feedback?page=${safePage + 1}&pageSize=${pageSize}">Next</a>` : "<span>Next</span>"}
    </nav>`;
  const tableRows = rows.map((item) => `
    <tr>
      <td>${htmlEscape(item.sequence)}</td>
      <td>${htmlEscape(item.createdAt)}</td>
      <td>${htmlEscape(item.screen)}</td>
      <td>${htmlEscape(item.sessionId)}</td>
      <td>${htmlEscape(item.userRef)}</td>
      <td><pre>${htmlEscape(item.message)}</pre></td>
    </tr>`).join("");
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>LingoStar Feedback</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;color:#111827;background:#f8fafc}
header,nav{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;background:white;border:1px solid #e5e7eb}
th,td{padding:10px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top;font-size:14px}
th{background:#f1f5f9;font-weight:700}
pre{white-space:pre-wrap;margin:0;font-family:inherit;max-width:520px}
a{color:#4f46e5;text-decoration:none;font-weight:700}
span{color:#94a3b8}
</style>
</head>
<body>
<header>
  <h1>LingoStar Feedback</h1>
  <p>Total ${total} items</p>
</header>
${nav}
<table>
  <thead><tr><th>#</th><th>Created</th><th>Screen</th><th>Session</th><th>User</th><th>Message</th></tr></thead>
  <tbody>${tableRows || '<tr><td colspan="6">No feedback yet.</td></tr>'}</tbody>
</table>
${nav}
</body>
</html>`;
}

function writeJson(res, status, payload) {
  res
    .writeHead(status, { "content-type": "application/json; charset=utf-8" })
    .end(JSON.stringify(payload, null, 2));
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function webContextFromRequest(req) {
  return {
    requestInfo: { headers: req.headers },
    _meta: {
      "openai/locale": "ko-KR",
      "openai/subject": req.headers["x-lingostar-web-user"] || "web-local-user",
    },
  };
}

async function authorizeWebRequest(req, scopes) {
  const context = webContextFromRequest(req);
  const auth = await authorizeContext(context, scopes);
  if (!auth.ok) {
    const status = bearerTokenFromContext(context) ? 403 : 401;
    return { ok: false, status, response: auth.response };
  }
  return { ok: true, context };
}

function publicConfig() {
  return {
    serviceVersion: SERVICE_VERSION,
    widgetVersion: WIDGET_VERSION,
    appOrigin: APP_ORIGIN,
    authRequired: AUTH_REQUIRED,
    oauthIssuer: OAUTH_ISSUER,
    oauthIssuerAccepted: OAUTH_ISSUER_ACCEPTED,
    oauthAudience: OAUTH_AUDIENCE,
    oauthClientId: OAUTH_CLIENT_ID,
    oauthScopeMode: OAUTH_SCOPE_MODE,
    oauthRequestScopes: OAUTH_REQUEST_SCOPES,
    oauthClientIdConfigured: Boolean(OAUTH_CLIENT_ID),
  };
}

function renderHelpPage(locale = "ko") {
  const help = helpContentFor(locale);
  const html = markdownToHtml(help.markdown || "");
  return `<!doctype html>
<html lang="${htmlEscape(help.locale)}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${htmlEscape(help.title)} - LingoStar</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;color:#111827;background:#f8fafc;line-height:1.65}
main{max-width:820px;margin:0 auto;padding:32px 20px}
article{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px;box-shadow:0 8px 24px rgba(15,23,42,.06)}
h1{font-size:28px;margin:0 0 12px}
h2{font-size:18px;margin:28px 0 8px}
p,li{font-size:15px;color:#374151}
a{color:#4f46e5;text-decoration:none;font-weight:700}
</style>
</head>
<body>
<main>
  <p><a href="/">LingoStar</a></p>
  <article>${html || `<h1>${htmlEscape(help.title)}</h1><p>${htmlEscape(help.intro)}</p>`}</article>
</main>
</body>
</html>`;
}

function renderHomePage() {
  const configJson = JSON.stringify(publicConfig()).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>LingoStar</title>
<style>
:root{color-scheme:light;--bg:#f6f7fb;--surface:#fff;--text:#111827;--muted:#6b7280;--border:#e5e7eb;--accent:#4f46e5;--danger:#dc2626;--soft:#eef2ff}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--text)}
button,input,textarea{font:inherit}
.shell{max-width:1120px;margin:0 auto;padding:24px}
.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}
.brand{display:flex;align-items:center;gap:12px}
.mark{width:42px;height:42px;border-radius:10px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:800}
.grid{display:grid;grid-template-columns:320px minmax(0,1fr);gap:16px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;box-shadow:0 8px 24px rgba(15,23,42,.05)}
.stack{display:flex;flex-direction:column;gap:10px}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.spread{display:flex;justify-content:space-between;gap:12px;align-items:center}
.muted{color:var(--muted);font-size:14px}
.badge{background:var(--soft);color:var(--accent);font-weight:700;border-radius:999px;padding:4px 10px;font-size:12px}
button{border:0;border-radius:8px;background:var(--accent);color:#fff;padding:9px 13px;font-weight:700;cursor:pointer}
button.secondary{background:#f3f4f6;color:#111827;border:1px solid var(--border)}
button.danger{background:var(--danger)}
button:disabled{opacity:.55;cursor:not-allowed}
input,textarea{width:100%;border:1px solid var(--border);border-radius:8px;padding:9px 11px;background:#fff}
label{font-size:13px;font-weight:700;color:#374151}
.session{border:1px solid var(--border);border-radius:10px;padding:12px;background:#fff}
.session.active{border-color:var(--accent);background:var(--soft)}
.metric{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}
.metric div{background:#f9fafb;border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center}
.metric b{display:block;font-size:18px}
.history{border-top:1px solid var(--border);padding-top:10px;margin-top:10px}
.notice{padding:10px 12px;border-radius:10px;background:#ecfdf5;color:#065f46;font-weight:650}
.error{background:#fef2f2;color:#991b1b}
@media(max-width:820px){.grid{grid-template-columns:1fr}.metric{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div class="shell">
  <header class="top">
    <div class="brand"><div class="mark">L</div><div><h1>LingoStar</h1><p class="muted">언어 세션과 진행 상황을 관리합니다.</p></div></div>
    <div class="row"><a href="/help?locale=ko">도움말</a><button id="login" class="secondary">로그인</button><button id="logout" class="secondary">로그아웃</button></div>
  </header>
  <div id="notice"></div>
  <main id="app" class="grid"></main>
</div>
<script>
const CONFIG = ${configJson};
let accessToken = localStorage.getItem("lingostar.accessToken") || "";
let state = null;
let activeSessionId = null;
const app = document.getElementById("app");
const notice = document.getElementById("notice");

function esc(value){return String(value ?? "").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[ch]));}
function setNotice(text, error=false){notice.innerHTML = text ? '<p class="notice '+(error?'error':'')+'">'+esc(text)+'</p>' : '';}
function headers(){const h={"content-type":"application/json"}; if(accessToken) h.authorization="Bearer "+accessToken; return h;}
async function api(path, options={}) {
  const res = await fetch(path, {...options, headers:{...headers(), ...(options.headers||{})}});
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data?.message || data?.content?.[0]?.text || "요청에 실패했습니다.");
  return data;
}
function average(profile={}) {
  const keys = ["language_info","listening","reading","writing","speaking"];
  return Math.round(keys.reduce((sum,key)=>sum+(Number(profile[key])||0),0)/keys.length);
}
async function load() {
  try {
    const data = await api("/api/state");
    state = data.state;
    activeSessionId = state.activeSessionId || (state.sessions?.length === 1 ? state.sessions[0].id : null);
    render();
  } catch (err) {
    setNotice(err.message, true);
    renderEmpty();
  }
}
function renderEmpty(){
  app.innerHTML = '<section class="panel stack"><h2>연결 필요</h2><p class="muted">Auth0 로그인이 필요한 서버라면 로그인 후 다시 시도하세요.</p></section>';
}
function render(){
  const sessions = state?.sessions || [];
  const active = sessions.find(s=>s.id===activeSessionId) || (sessions.length === 1 ? sessions[0] : null);
  app.innerHTML = '<aside class="panel stack">'+
    '<div class="spread"><h2>세션</h2><button id="new-session" class="secondary">새 세션</button></div>'+
    (sessions.length ? sessions.map(s=>'<article class="session '+(s.id===active?.id?'active':'')+'">'+
      '<div class="spread"><strong>'+esc(s.targetLanguage || "Language")+'</strong><span class="badge">'+average(s.skillProfile)+'</span></div>'+
      '<p class="muted">'+esc(s.goal?.detail || s.goal?.type || "")+'</p>'+
      '<div class="row"><button class="secondary" data-select="'+esc(s.id)+'">선택</button><button class="danger" data-delete="'+esc(s.id)+'">삭제</button></div>'+
    '</article>').join('') : '<p class="muted">아직 세션이 없습니다. ChatGPT 앱에서 세션을 만들거나 아래 버튼을 사용하세요.</p>')+
    '</aside>'+
    '<section class="panel stack">'+renderDetail(active)+'</section>';
}
function renderDetail(session){
  if(!session) return '<h2>세션 관리</h2><p class="muted">새 세션을 만들거나 ChatGPT에서 LingoStar를 호출하세요.</p>';
  const profile = session.skillProfile || {};
  const history = session.sectionHistory || [];
  return '<div class="spread"><div><h2>'+esc(session.targetLanguage)+'</h2><p class="muted">'+esc(session.nativeLanguage || "")+'</p></div><span class="badge">'+esc(session.status || "active")+'</span></div>'+
    '<div class="metric">'+["language_info","listening","reading","writing","speaking"].map(k=>'<div><span class="muted">'+esc(k)+'</span><b>'+Math.round(Number(profile[k])||0)+'</b></div>').join('')+'</div>'+
    '<form id="settings" class="stack">'+
      '<label>진행 상황<textarea name="progressContext" rows="3">'+esc(session.progressContext || "")+'</textarea></label>'+
      '<label>취약점<textarea name="weaknessContext" rows="3">'+esc(session.weaknessContext || "")+'</textarea></label>'+
      '<div class="row"><button type="submit">설정 저장</button><button type="button" id="select-current" class="secondary">이 세션 선택</button></div>'+
    '</form>'+
    '<div class="history"><h3>최근 섹션</h3>'+(history.length ? history.slice(0,8).map(h=>'<p class="muted">'+esc(h.title || h.id)+' · '+esc(h.completedAt || "")+'</p>').join('') : '<p class="muted">완료된 섹션이 없습니다.</p>')+'</div>';
}
async function saveSettings(form){
  const session = (state.sessions||[]).find(s=>s.id===activeSessionId);
  if(!session) return;
  const fd = new FormData(form);
  const updated = {...session, progressContext:String(fd.get("progressContext")||""), weaknessContext:String(fd.get("weaknessContext")||"")};
  await api("/api/session/"+encodeURIComponent(session.id)+"/settings", {method:"POST", body:JSON.stringify({session:updated})});
  setNotice("설정을 저장했습니다.");
  await load();
}
document.addEventListener("click", async (e)=>{
  const select = e.target.closest("[data-select]");
  const del = e.target.closest("[data-delete]");
  if(select){activeSessionId=select.dataset.select; await api("/api/session/select",{method:"POST",body:JSON.stringify({sessionId:activeSessionId})}); await load();}
  if(del && confirm("이 언어 세션을 삭제할까요?")){await api("/api/session/"+encodeURIComponent(del.dataset.delete),{method:"DELETE"}); setNotice("세션을 삭제했습니다."); await load();}
  if(e.target.id==="new-session") setNotice("새 세션은 ChatGPT에서 LingoStar에게 목표 언어와 목표를 말해 만들 수 있습니다.");
  if(e.target.id==="select-current" && activeSessionId){await api("/api/session/select",{method:"POST",body:JSON.stringify({sessionId:activeSessionId})}); setNotice("세션을 선택했습니다."); await load();}
});
document.addEventListener("submit", async (e)=>{if(e.target.id==="settings"){e.preventDefault(); await saveSettings(e.target);}});
document.getElementById("login").onclick=()=>{
  if(!CONFIG.oauthIssuer || !CONFIG.oauthClientId){setNotice("이 서버에는 OAuth 클라이언트가 설정되어 있지 않습니다.", true); return;}
  setNotice("웹 대시보드 로그인은 Auth0 연결 정보가 있는 배포 환경에서 사용하세요.");
};
document.getElementById("logout").onclick=()=>{localStorage.removeItem("lingostar.accessToken"); accessToken=""; load();};
load();
</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/*  MCP server factory                                                 */
/* ------------------------------------------------------------------ */

function createLingoStarServer() {
  const server = new McpServer({ name: "lingostar", version: SERVICE_VERSION });

  /* ---------- Widget resource ---------- */

  registerAppResource(server, "lingostar-studio", WIDGET_URI, {}, async () => ({
    contents: [
      {
        uri: WIDGET_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: widgetHtml,
        _meta: {
          ui: {
            domain: APP_ORIGIN,
            prefersBorder: false,
            csp: {
              connectDomains: WIDGET_CONNECT_DOMAINS,
              resourceDomains: WIDGET_RESOURCE_DOMAINS,
            }
          },
          "openai/widgetDomain": APP_ORIGIN,
          "openai/widgetPrefersBorder": false,
          "openai/widgetCSP": {
            connect_domains: WIDGET_CONNECT_DOMAINS,
            resource_domains: WIDGET_RESOURCE_DOMAINS,
          },
          "openai/widgetDescription":
            "LingoStar language learning dashboard and mixed-skill exercise interface.",
        },
      },
    ],
  }));

  /* ====================================================================
   *  Tool 1: open_lingostar_app (render tool)
   * ==================================================================== */

  registerAppTool(
    server,
    "open_lingostar_app",
    {
      title: "Open LingoStar",
      description:
        "Render the LingoStar widget. Use this when the user opens the app, wants the dashboard/session picker, current section, or settings UI. Data and mutation tools should be called separately.",
      inputSchema: {},
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(READ_SCOPES),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: renderToolMeta(READ_SCOPES, "Opening LingoStar", "LingoStar opened"),
    },
    async (_args, context) => {
      const auth = await authorizeContext(context, READ_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      return replyWithState(state, textFor(state.sessions[0] ?? "en").loaded);
    }
  );

  /* ====================================================================
   *  Tool 2: get_lingostar_state
   * ==================================================================== */

  registerAppTool(
    server,
    "get_lingostar_state",
    {
      title: "Get LingoStar state",
      description:
        "Returns the user's full LingoStar state including sessions, active section, dashboard, and GUI configuration.",
      inputSchema: {},
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(READ_SCOPES),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: dataToolMeta(READ_SCOPES, "Loading LingoStar", "LingoStar loaded"),
    },
    async (_args, context) => {
      const auth = await authorizeContext(context, READ_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      return replyWithState(state, textFor(state.sessions[0] ?? "en").loaded);
    }
  );

  /* ====================================================================
   *  Tool 3: search_lingostar_help
   * ==================================================================== */

  registerAppTool(
    server,
    "search_lingostar_help",
    {
      title: "Search LingoStar help",
      description:
        "Searches the static LingoStar help markdown loaded by the server. Use this for help, usage, audio, session, section, settings, or troubleshooting questions before rendering any UI.",
      inputSchema: {
        query: z.string().optional().describe("The user's help question or keyword."),
        locale: z.enum(["en", "ko"]).optional().describe("Preferred help locale."),
      },
      outputSchema: {
        locale: z.string().describe("Resolved help locale."),
        title: z.string().describe("Help document title."),
        query: z.string().describe("Normalized search query."),
        results: z.array(z.string()).describe("Matching help snippets from the static markdown file."),
        source: z.string().describe("Help source, normally static-md."),
      },
      securitySchemes: requiredSecuritySchemes(READ_SCOPES),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: dataToolMeta(READ_SCOPES, "Searching help", "Help searched"),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, READ_SCOPES);
      if (!auth.ok) return auth.response;
      const locale = args.locale || normalizeUiLocale(requestedLocaleFromContext(context)) || "en";
      const result = searchHelpContent(locale, args.query);
      return {
        content: result.results.length
          ? [{ type: "text", text: result.results.join("\n") }]
          : [{ type: "text", text: result.title }],
        structuredContent: result,
      };
    }
  );

  /* ====================================================================
   *  Tool 4: select_learning_session
   * ==================================================================== */

  registerAppTool(
    server,
    "select_learning_session",
    {
      title: "Select learning session",
      description:
        "Sets the active LingoStar language session after the user explicitly chooses it in the widget or conversation. This does not create a new lesson section.",
      inputSchema: {
        sessionId: z.string().describe("The ID of the language learning session to make active."),
      },
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(WRITE_SCOPES),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: dataToolMeta(WRITE_SCOPES, "Selecting session", "Session selected"),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, WRITE_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      const session = findSession(state, args.sessionId);
      if (!session) return replyWithState(state, textFor("en").notFound, true);
      state.activeSessionId = session.id;
      if (state.currentSection?.sessionId !== session.id) state.currentSection = null;
      session.updatedAt = nowIso();
      await saveState(context, state);
      return replyWithState(state, textFor(session).loaded);
    }
  );

  /* ====================================================================
   *  Tool 5: manage_learning_session
   * ==================================================================== */

  registerAppTool(
    server,
    "manage_learning_session",
    {
      title: "Manage learning session",
      description:
        "Creates or updates a language learning session. CRITICAL: When the user asks to start learning, call this tool before giving prose. For a NEW session, provide 'initialSection' whenever possible so the first lesson opens immediately in the UI; otherwise call create_lesson_exercises in the same assistant turn. NEVER output lesson content in chat text. NEVER ask the user to type answers in chat; the user submits answers through the UI.",
      inputSchema: {
        session: sessionSchema.describe("Session parameters. The server fills defaults and preserves structured profile fields."),
        initialSection: sectionSchema
          .omit({ sessionId: true })
          .partial({ levelId: true, exercisesPerSkill: true })
          .optional()
          .describe("Optional first section. If provided, it must contain exactly the configured exerciseCounts for each enabled exercise area; otherwise the model must call create_lesson_exercises immediately in the same turn and never print exercise bodies in chat."),
      },
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(WRITE_SCOPES),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: dataToolMeta(WRITE_SCOPES, "Storing session", "Session stored"),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, WRITE_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      const requestedLocale = requestedLocaleFromContext(context);
      const incoming = args.session ?? {};

      // Ensure basic fields
      if (!incoming.id) {
        incoming.id = shortId("session");
      }
      incoming.targetLanguage = String(incoming.targetLanguage || "Unknown").trim();
      incoming.nativeLanguage = String(incoming.nativeLanguage || "Unknown").trim();

      // Ensure timestamps
      incoming.createdAt ??= nowIso();
      incoming.updatedAt = nowIso();
      incoming.status ??= "active";

      // Ensure goal and personalization shape
      if (!incoming.goal || typeof incoming.goal !== "object") {
        incoming.goal = { type: incoming.goalType || "conversation", detail: "" };
      } else {
        incoming.goal.type ??= incoming.goalType || "conversation";
        incoming.goal.detail ??= "";
      }
      incoming.interests = splitList(incoming.interests);
      incoming.avoidTopics = splitList(incoming.avoidTopics);
      incoming.stage = learnerStageSchema.safeParse(incoming.stage).success ? incoming.stage : inferLearnerStage(incoming);
      incoming.progressContext = cleanText(incoming.progressContext);
      incoming.weaknessContext = cleanText(incoming.weaknessContext);

      // Settings defaults
      incoming.settings ??= {};
      incoming.settings.displayLanguage ??= "auto";
      incoming.settings.exercisesPerSkill = clampExerciseCount(incoming.settings.exercisesPerSkill, DEFAULT_EXERCISES_PER_AREA);
      incoming.settings.exerciseCounts = normalizeExerciseCounts(incoming.settings.exerciseCounts, incoming.settings.exercisesPerSkill);
      incoming.settings.sectionPassThreshold = clampInteger(incoming.settings.sectionPassThreshold, 0, 100, 85);
      incoming.settings.minSectionsForGoalCompletion = Math.max(10, clampInteger(incoming.settings.minSectionsForGoalCompletion, 10, 500, 10));
      incoming.settings.ttsRate = Math.max(0.6, Math.min(1.4, Number(incoming.settings.ttsRate) || 1));
      incoming.settings.speakingEnabled ??= true;
      incoming.settings.levelMode ??= "cefr";

      // Runtime resolution
      incoming.runtime ??= {};
      incoming.runtime.interfaceLanguage = interfaceLanguage(
        incoming.nativeLanguage ?? "",
        incoming.settings.displayLanguage,
        requestedLocale
      );
      incoming.runtime.speechLang ||= speechLangForTargetLanguage(incoming.targetLanguage);

      // Data structures
      incoming.levels ??= [];
      for (const lvl of incoming.levels) {
        lvl.id ??= shortId("level");
        lvl.name = String(lvl.name ?? lvl.cefr ?? lvl.id ?? "").trim() || "Level";
        lvl.status ??= "active";
        lvl.sections ??= [];
      }

      const coerceScore = (v) => {
        const parsed = Number(v);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      incoming.skillProfile ??= {};
      incoming.skillProfile.language_info = coerceScore(incoming.skillProfile.language_info);
      incoming.skillProfile.speaking = coerceScore(incoming.skillProfile.speaking);
      incoming.skillProfile.writing = coerceScore(incoming.skillProfile.writing);
      incoming.skillProfile.listening = coerceScore(incoming.skillProfile.listening);
      incoming.skillProfile.reading = coerceScore(incoming.skillProfile.reading);

      incoming.feedbackMemory ??= [];
      incoming.sectionHistory ??= [];

      // Upsert
      const existingIndex = state.sessions.findIndex((s) => s.id === incoming.id);
      if (existingIndex >= 0) {
        state.sessions[existingIndex] = incoming;
      } else {
        state.sessions.push(incoming);
      }

      state.activeSessionId = incoming.id;
      
      if (args.initialSection && args.initialSection.exercises?.length > 0) {
        const sectionExercisesPerSkill = clampExerciseCount(
          args.initialSection.exercisesPerSkill,
          incoming.settings.exercisesPerSkill
        );
        args.initialSection.exercisesPerSkill = sectionExercisesPerSkill;
        args.initialSection.exerciseCounts = normalizeExerciseCounts(
          args.initialSection.exerciseCounts,
          sectionExercisesPerSkill
        );
        args.initialSection.sessionId = incoming.id;
        args.initialSection.levelId ??= incoming.levels?.[0]?.id || shortId("level");
        args.initialSection.exercises = normalizeExercises(
          args.initialSection.exercises,
          enabledExerciseAreasForSession(incoming)
        );

        const validation = validateSectionSkillCounts(args.initialSection, incoming);
        if (!validation.ok) {
          state.currentSection = null;
          await saveState(context, state);
          return replyWithState(state, sectionValidationMessage(incoming, validation), true);
        }

        state.currentSection = {
          id: shortId("section"),
          sessionId: incoming.id,
          levelId: args.initialSection.levelId,
          title: args.initialSection.title || "Initial Section",
          status: "active",
          exercisesPerSkill: sectionExercisesPerSkill,
          exerciseCounts: args.initialSection.exerciseCounts,
          exercises: args.initialSection.exercises,
          reviewExercises: [],
          results: [],
          completedAt: null,
          createdAt: nowIso()
        };
      } else {
        if (state.currentSection?.sessionId !== incoming.id) {
          state.currentSection = null;
        }
      }

      const lang = cleanText(incoming.targetLanguage) || "Language";
      await saveState(context, state);
      return replyWithState(state, textFor(incoming).sessionStored(lang));
    }
  );

  /* ====================================================================
   *  Tool 3: create_lesson_exercises
   * ==================================================================== */

  registerAppTool(
    server,
    "create_lesson_exercises",
    {
      title: "Create lesson exercises",
      description:
        "CRITICAL: Use this tool for the actual questions/exercises for a lesson section, including when the app asks for the next section. App messages may be short; read the app/model context for target language, level, enabled skills, and per-skill count. NEVER output exercises in chat text. NEVER ask the user to type answers in chat. Store the section with this tool so it opens in the UI.",
      inputSchema: {
        section: sectionSchema.describe("The full section object with exercises. Must include exactly the configured exerciseCounts for each enabled exercise area.")
      },
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(WRITE_SCOPES),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: dataToolMeta(WRITE_SCOPES, "Storing section", "Section stored"),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, WRITE_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      const incoming = args.section ?? {};

      // Ensure ID
      if (!incoming.id) {
        incoming.id = shortId("section");
      }

      // Ensure timestamps
      incoming.createdAt ??= nowIso();
      incoming.completedAt ??= null;
      incoming.status ??= "active";

      // Ensure arrays
      // Validate session exists
      incoming.sessionId ??= state.activeSessionId;
      const session = incoming.sessionId
        ? findSession(state, incoming.sessionId)
        : null;
      if (!session) {
        return replyWithState(state, textFor("en").missingContext, true);
      }

      incoming.exercises = normalizeExercises(incoming.exercises, enabledExerciseAreasForSession(session));
      incoming.reviewExercises ??= [];
      incoming.results ??= [];

      // Validate per-area exercise counts.
      const exercisesPerSkill = clampExerciseCount(
        incoming.exercisesPerSkill,
        inferExercisesPerArea(incoming.exercises, enabledExerciseAreasForSession(session))
      );
      incoming.exercisesPerSkill = exercisesPerSkill;
      incoming.exerciseCounts = normalizeExerciseCounts(incoming.exerciseCounts, exercisesPerSkill);

      const validation = validateSectionSkillCounts(incoming, session);
      if (!validation.ok) {
        return replyWithState(state, sectionValidationMessage(session, validation), true);
      }

      // Set as current section
      state.currentSection = incoming;

      // Add section ID to the appropriate level
      if (incoming.levelId) {
        const level = (session.levels ?? []).find((l) => l.id === incoming.levelId);
        if (level) {
          level.sections ??= [];
          if (!level.sections.includes(incoming.id)) {
            level.sections.push(incoming.id);
          }
        }
      }

      session.updatedAt = nowIso();

      await saveState(context, state);
      return replyWithState(
        state,
        textFor(session).sectionStored(incoming.exercises.length)
      );
    }
  );

  /* ====================================================================
   *  Tool 4: grade_section_answers
   * ==================================================================== */

  registerAppTool(
    server,
    "grade_section_answers",
    {
      title: "Grade entire section answers",
      description:
        "Evaluates the user's answers for all exercises in the section simultaneously. App messages may be short; read the app/model context for the answer payload. Call this tool to save scores and feedback instead of printing raw answer lists in chat.",
      inputSchema: {
        sessionId: z.string().optional().describe("The ID of the current session"),
        sectionId: z.string().optional().describe("The ID of the section being evaluated"),
        evaluations: z.array(
          z.object({
            exerciseId: z.string().describe("The ID of the specific exercise being evaluated"),
            score: z.number().min(0).max(100).describe("Score out of 100"),
            skill: z.string().describe("Exercise area being evaluated: language_info, listening, reading, writing, or speaking."),
            userAnswer: z.string().optional().describe("The learner's submitted answer or transcript. Use [SKIPPED] only when the learner deliberately skipped."),
            learnerClaim: z.string().optional().describe("Optional learner-provided self-assessment or explanation for this answer."),
            skipped: z.boolean().optional().describe("True when the learner explicitly skipped this exercise."),
            needsReview: z.boolean().describe("Whether this exercise should be added to the review queue"),
            feedback: z.object({
              short: z.string().describe("1-2 sentences of praise or correction"),
              detail: z.string().optional().describe("Detailed grammatical or semantic analysis")
            })
          })
        ).describe("Array of evaluation results for each exercise answered."),
        sectionFeedback: z.string().describe("A general feedback message covering the user's overall performance in this section.")
      },
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(WRITE_SCOPES),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: dataToolMeta(WRITE_SCOPES, "Grading section", "Grading complete"),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, WRITE_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      args.sessionId ??= state.activeSessionId;
      args.sectionId ??= state.currentSection?.id;

      const session = args.sessionId ? findSession(state, args.sessionId) : null;
      if (!session) {
        return replyWithState(state, textFor("en").notFound, true);
      }

      // Find section (current or in history)
      const section =
        state.currentSection?.id === args.sectionId
          ? state.currentSection
          : null;

      if (!section) {
        return replyWithState(state, textFor(session).missingContext, true);
      }

      // Upsert results by exercise ID so repeated grading does not create duplicates.
      section.results ??= [];
      for (const result of args.evaluations ?? []) {
        result.gradedAt = nowIso();
        const existingIndex = section.results.findIndex(
          (item) => item.exerciseId === result.exerciseId
        );
        if (existingIndex >= 0) section.results[existingIndex] = result;
        else section.results.push(result);
      }

      // Update skillProfile from results
      const profile = session.skillProfile ?? {
        language_info: 0,
        speaking: 0,
        writing: 0,
        listening: 0,
        reading: 0,
      };
      for (const result of args.evaluations ?? []) {
        const skill = result.skill;
        if (result.skipped) continue;
        if (skill && profile[skill] !== undefined) {
          const score = Math.max(0, Math.min(100, Number(result.score) || 0));
          // Weighted moving update: nudge toward the 0-100 score.
          profile[skill] = Math.min(
            100,
            Math.max(0, profile[skill] + (score - profile[skill]) * 0.15)
          );
          profile[skill] = Number(profile[skill].toFixed(1));
        }
      }
      session.skillProfile = profile;

      // Auto-generate reviewExercises from needsReview results
      section.reviewExercises ??= [];
      for (const result of args.evaluations ?? []) {
        if (result.needsReview) {
          const originalExercise = (section.exercises ?? []).find(
            (e) => e.id === result.exerciseId
          );
          if (originalExercise) {
            const already = section.reviewExercises.some(
              (r) => r.id === `review-${originalExercise.id}`
            );
            if (!already) {
              section.reviewExercises.push({
                ...originalExercise,
                id: `review-${originalExercise.id}`,
                isReview: true,
              });
            }
          }
        }
      }

      // Update recentFeedback
      for (const result of args.evaluations ?? []) {
        if (result.feedback) {
          state.recentFeedback.unshift({
            id: shortId("feedback"),
            sessionId: session.id,
            exerciseId: result.exerciseId,
            skill: result.skill,
            createdAt: nowIso(),
            text: result.feedback.short ?? result.feedback.detail ?? "",
          });
        }
      }
      state.recentFeedback = state.recentFeedback.slice(0, 20);

      // Complete the section when the original exercise set is done. Review items
      // are stored as follow-up context, not as a moving completion target.
      const allExerciseIds = exerciseIdsForSection(section);
      const completedIds = new Set(
        (section.results ?? []).map((r) => r.exerciseId)
      );
      const allComplete = allExerciseIds.every((id) => completedIds.has(id));

      if (allComplete && allExerciseIds.length > 0 && section.status !== "completed") {
        section.status = "completed";
        section.completedAt = nowIso();
        section.aggregate = {
          ...computeSectionScore(section, session),
          completedAt: section.completedAt,
        };

        // Add to sectionHistory
        session.sectionHistory ??= [];
        session.sectionHistory.unshift({
          id: section.id,
          title: section.title,
          status: section.aggregate.passed ? "passed" : "completed",
          completedAt: section.completedAt,
          exerciseCount: section.exercises?.length ?? 0,
          weightedScore: section.aggregate.weightedScore,
          threshold: section.aggregate.threshold,
          passed: section.aggregate.passed,
        });
        session.sectionHistory = session.sectionHistory.slice(0, 50);

        // Clear currentSection when complete
        state.currentSection = null;
      }

      session.updatedAt = nowIso();

      await saveState(context, state);
      return replyWithState(state, textFor(session).resultsStored);
    }
  );

  /* ====================================================================
   *  Tool 5: store_level_judgment
   * ==================================================================== */

  registerAppTool(
    server,
    "store_level_judgment",
    {
      title: "Store level judgment",
      description:
        "Records GPT's judgment on whether a level is complete. If isComplete is true, the level's status is set to 'completed'.",
      inputSchema: {
        sessionId: z.string().describe("The ID of the session"),
        levelId: z.string().describe("The ID of the level being judged"),
        isComplete: z.boolean().describe("Whether the LLM considers this level entirely complete based on the user's performance"),
        reason: z.string().describe("The rationale for marking this level as complete or incomplete"),
      },
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(WRITE_SCOPES),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: dataToolMeta(WRITE_SCOPES, "Judging level", "Level judged"),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, WRITE_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      const session = findSession(state, args.sessionId);

      if (!session) {
        return replyWithState(state, textFor("en").notFound, true);
      }

      const level = (session.levels ?? []).find((l) => l.id === args.levelId);
      if (!level) {
        return replyWithState(state, textFor(session).missingContext, true);
      }

      level.completionJudgment = {
        isComplete: args.isComplete,
        reason: args.reason,
        judgedAt: nowIso(),
      };

      if (args.isComplete) {
        level.status = "completed";
      }

      session.updatedAt = nowIso();

      await saveState(context, state);
      return replyWithState(state, textFor(session).levelJudged);
    }
  );

  /* ====================================================================
   *  Tool 6: store_goal_judgment
   * ==================================================================== */

  registerAppTool(
    server,
    "store_goal_judgment",
    {
      title: "Store goal judgment",
      description:
        "Records GPT's rigorous judgment on whether the learner has achieved the active language goal. Use international speaking/language standards such as CEFR or the explicitly named exam/certification standard. The server only marks the goal complete when this judgment is positive AND the learner has completed at least the configured minimum number of sections since the previous goal completion.",
      inputSchema: {
        sessionId: z.string().describe("The ID of the language learning session whose active goal is being judged."),
        isGoalAchieved: z.boolean().describe("Whether GPT judges the current goal achieved under the relevant international standard or explicit certification standard."),
        standardUsed: z.string().describe("The standard used for judgment, e.g. CEFR A2, JLPT N4, TOPIK II, DELE B1, or a specific conversational benchmark."),
        reason: z.string().describe("Detailed rationale in the user's native/interface language explaining why the goal is or is not achieved."),
        nextGoalSuggestion: z.string().optional().describe("Suggested next goal in the user's native/interface language if the current goal is complete."),
      },
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(WRITE_SCOPES),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: dataToolMeta(WRITE_SCOPES, "Judging goal", "Goal judged"),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, WRITE_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      const session = findSession(state, args.sessionId);
      if (!session) return replyWithState(state, textFor("en").notFound, true);

      const completedSinceGoal = completedSectionsSinceGoalStart(session);
      const requiredSections = Math.max(10, clampInteger(session.settings?.minSectionsForGoalCompletion, 10, 500, 10));
      session.goal ??= { type: session.goalType || "conversation", detail: "" };
      session.goal.lastJudgment = {
        isGoalAchieved: Boolean(args.isGoalAchieved),
        standardUsed: args.standardUsed,
        reason: args.reason,
        nextGoalSuggestion: args.nextGoalSuggestion ?? "",
        completedSectionsSinceGoal: completedSinceGoal,
        requiredSections,
        judgedAt: nowIso(),
      };

      if (args.isGoalAchieved && completedSinceGoal >= requiredSections) {
        session.goal.status = "completed";
        session.goal.completedAt = nowIso();
        session.goal.lastCompletedAt = session.goal.completedAt;
        state.dashboard.nextBestAction = "set_new_goal";
      } else {
        session.goal.status = "active";
      }
      session.updatedAt = nowIso();
      await saveState(context, state);
      return replyWithState(
        state,
        session.goal.status === "completed"
          ? "Goal completed. Ask the learner to choose a new goal."
          : "Goal judgment recorded. Continue learning until the standard and minimum-section requirements are met."
      );
    }
  );

  /* ====================================================================
   *  Tool 7: transcribe_audio (STT only)
   * ==================================================================== */

  registerAppTool(
    server,
    "transcribe_audio",
    {
      title: "Transcribe audio",
      description:
        "Transcribes speech audio using server-side OpenAI STT when OPENAI_API_KEY is configured. Returns the transcript only — no grading or evaluation.",
      inputSchema: {
        audioBase64: z.string().min(1).describe("Base64-encoded audio data."),
        mimeType: z.string().optional().describe("Audio MIME type, defaults to audio/webm."),
        speechLang: z.string().optional().describe("BCP-47 language code for the speech."),
      },
      outputSchema: transcriptOutputSchema,
      securitySchemes: requiredSecuritySchemes(AUDIO_SCOPES),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: dataToolMeta(AUDIO_SCOPES, "Transcribing audio", "Audio transcribed"),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, AUDIO_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      const localeTarget =
        state.sessions.find((s) => s.id === state.activeSessionId) ?? "en";

      if (!IS_AI_FALLBACK || !OPENAI_API_KEY) {
        const reason = openAiAudioUnavailableMessage(localeTarget);
        return {
          content: [{ type: "text", text: reason }],
          structuredContent: {
            state: refreshDashboard(state),
            transcript: "",
          },
        };
      }

      try {
        const transcript = await transcribeSpeechWithOpenAI({
          audioBase64: args.audioBase64,
          mimeType: args.mimeType ?? "audio/webm",
          speechLang: args.speechLang,
        });

        return {
          content: [{ type: "text", text: textFor(localeTarget).transcribed }],
          structuredContent: {
            state: refreshDashboard(state),
            transcript,
          },
        };
      } catch (error) {
        const reason = openAiAudioErrorMessage(localeTarget, error);
        return {
          content: [{ type: "text", text: reason }],
          structuredContent: {
            state: refreshDashboard(state),
            transcript: "",
          },
        };
      }
    }
  );

  /* ====================================================================
   *  Tool 7: synthesize_speech (TTS only)
   * ==================================================================== */

  registerAppTool(
    server,
    "synthesize_speech",
    {
      title: "Synthesize speech",
      description:
        "Synthesizes listening audio using server-side OpenAI TTS when OPENAI_API_KEY is configured. Returns a data URL for playback only.",
      inputSchema: {
        text: z.string().min(1).describe("Text to synthesize in the target language."),
        speechLang: z.string().optional().describe("BCP-47 language hint for pronunciation."),
        voice: z.string().optional().describe("OpenAI TTS voice, e.g. alloy, ash, coral, echo, sage, shimmer, verse, marin, cedar."),
        format: z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]).optional().describe("Audio output format, defaults to mp3."),
        speed: z.number().min(0.25).max(4).optional().describe("Speech speed, defaults to 1.0."),
      },
      outputSchema: speechOutputSchema,
      securitySchemes: requiredSecuritySchemes(AUDIO_SCOPES),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: dataToolMeta(AUDIO_SCOPES, "Synthesizing audio", "Audio synthesized"),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, AUDIO_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      const localeTarget =
        state.sessions.find((s) => s.id === state.activeSessionId) ?? "en";

      if (!IS_AI_FALLBACK || !OPENAI_API_KEY) {
        const reason = openAiAudioUnavailableMessage(localeTarget);
        return {
          content: [{ type: "text", text: reason }],
          structuredContent: {
            state: refreshDashboard(state),
            audioDataUrl: "",
            mimeType: "",
          },
        };
      }

      try {
        const audio = await synthesizeSpeechWithOpenAI({
          text: args.text,
          voice: args.voice,
          format: args.format,
          speed: args.speed,
        });

        return {
          content: [{ type: "text", text: textFor(localeTarget).synthesized }],
          structuredContent: {
            state: refreshDashboard(state),
            ...audio,
          },
        };
      } catch (error) {
        const reason = openAiAudioErrorMessage(localeTarget, error);
        return {
          content: [{ type: "text", text: reason }],
          structuredContent: {
            state: refreshDashboard(state),
            audioDataUrl: "",
            mimeType: "",
          },
        };
      }
    }
  );

  /* ====================================================================
   *  Tool 8: submit_feedback
   * ==================================================================== */

  registerAppTool(
    server,
    "submit_feedback",
    {
      title: "Submit feedback",
      description:
        "Stores product feedback from the LingoStar widget. Use this for UI errors, broken audio, confusing exercises, or feature requests. Each entry receives a server-side sequence number for admin review.",
      inputSchema: {
        message: z.string().min(1).max(4000).describe("The learner's feedback message or bug report."),
        screen: z.string().optional().describe("The UI screen where the feedback was submitted, such as oobe, dashboard, lesson, or settings."),
        sessionId: z.string().optional().describe("The active learning session ID, if any."),
        sectionId: z.string().optional().describe("The active lesson section ID, if any."),
        exerciseId: z.string().optional().describe("The active exercise ID, if any."),
        severity: z.string().optional().describe("Optional severity label such as feedback, bug, or blocker."),
      },
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(WRITE_SCOPES),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: dataToolMeta(WRITE_SCOPES, "Submitting feedback", "Feedback submitted"),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, WRITE_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      const item = await appendFeedbackItem(context, state, args);
      if (item) await saveState(context, state);
      return replyWithState(state, item ? textFor(state.sessions[0] ?? state.host?.interfaceLanguage ?? "en").feedbackStored : "Feedback was empty.", !item);
    }
  );

  /* ====================================================================
   *  Tool 9: delete_session
   * ==================================================================== */

  registerAppTool(
    server,
    "delete_session",
    {
      title: "Delete session",
      description:
        "Deletes a language learning session only when the user explicitly asks for deletion.",
      inputSchema: {
        sessionId: z.string().describe("The ID of the session to delete"),
      },
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(WRITE_SCOPES),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
      _meta: dataToolMeta(WRITE_SCOPES, "Deleting session", "Session deleted"),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, WRITE_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      const session = findSession(state, args.sessionId);
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((item) => item.id !== args.sessionId);

      if (state.activeSessionId === args.sessionId) {
        state.activeSessionId = null;
      }
      if (state.currentSection?.sessionId === args.sessionId) {
        state.currentSection = null;
      }

      const deleted = before !== state.sessions.length;
      if (deleted) await saveState(context, state);
      return replyWithState(
        state,
        deleted ? textFor(session ?? "en").deleted : textFor(session ?? "en").notFound
      );
    }
  );

  return server;
}

/* ------------------------------------------------------------------ */
/*  HTTP server                                                        */
/* ------------------------------------------------------------------ */

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";
const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
const MCP_ALLOWED_HEADERS = "authorization, accept, content-type, mcp-session-id, Mcp-Session-Id, x-openai-subject, x-openai-user-id, x-openai-session-id, x-openai-conversation-id";
const MCP_COMPAT_PATHS = new Set([MCP_PATH, "/"]);

const mcpActiveSessions = new Map();

function setMcpResponseHeaders(req, res) {
  const origin = req.headers.origin || "*";
  const allowedOrigin = allowedCorsOrigin(origin);
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
  res.setHeader("X-Accel-Buffering", "no");
  return allowedOrigin;
}

function upsertRawHeader(req, name, value) {
  if (!Array.isArray(req.rawHeaders)) return;
  const lowerName = name.toLowerCase();
  const index = req.rawHeaders.findIndex((header, headerIndex) =>
    headerIndex % 2 === 0 && header.toLowerCase() === lowerName
  );
  if (index >= 0) {
    req.rawHeaders[index + 1] = value;
  } else {
    req.rawHeaders.push(name, value);
  }
}

function normalizeMcpPostHeaders(req) {
  if (req.method !== "POST") return;

  const accept = String(req.headers.accept ?? "");
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    req.headers.accept = "application/json, text/event-stream";
    upsertRawHeader(req, "Accept", "application/json, text/event-stream");
    if (req.headersDistinct) {
      req.headersDistinct.accept = ["application/json, text/event-stream"];
    }
  }

  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.includes("application/json")) {
    req.headers["content-type"] = "application/json";
    upsertRawHeader(req, "Content-Type", "application/json");
    if (req.headersDistinct) {
      req.headersDistinct["content-type"] = ["application/json"];
    }
  }
}

async function handleStatelessMcpRequest(req, res) {
  const server = createLingoStarServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  let closed = false;
  const closeTransport = async () => {
    if (closed) return;
    closed = true;
    try {
      await transport.close();
    } catch (error) {
      console.error("Error closing stateless MCP transport:", error);
    }
    try {
      await server.close();
    } catch (error) {
      console.error("Error closing stateless MCP server:", error);
    }
  };

  res.on("finish", closeTransport);
  res.on("close", closeTransport);
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && MCP_COMPAT_PATHS.has(url.pathname)) {
    const allowedOrigin = setMcpResponseHeaders(req, res);
    res.writeHead(204, {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": MCP_ALLOWED_HEADERS,
      "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
      "X-Accel-Buffering": "no",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/status.json")) {
    res
      .writeHead(200, { "content-type": "application/json; charset=utf-8" })
      .end(JSON.stringify({
        ok: true,
        service: "lingostar",
        version: SERVICE_VERSION,
        widgetVersion: WIDGET_VERSION,
        widgetUri: WIDGET_URI,
        authRequired: AUTH_REQUIRED,
        developerMode: DEVELOPER_MODE,
        aiFallbackEnabled: IS_AI_FALLBACK,
        stateStore: STATE_STORE,
        firestoreConfigured: Boolean(FIRESTORE_PROJECT_ID),
        appOrigin: APP_ORIGIN,
        mcpEndpoint: MCP_PATH,
        mcpCompatibilityPaths: [...MCP_COMPAT_PATHS],
        oauthIssuerConfigured: Boolean(OAUTH_ISSUER),
        oauthIssuerAccepted: OAUTH_ISSUER_ACCEPTED,
        oauthJwksConfigured: Boolean(OAUTH_JWKS_URL || OAUTH_ISSUER),
        oauthClientIdConfigured: Boolean(OAUTH_CLIENT_ID),
        oauthScopeMode: OAUTH_SCOPE_MODE,
        oauthScopesAdvertised: shouldAdvertiseOAuthScopes(),
        oauthScopesEnforced: shouldEnforceOAuthScopes(),
        oauthScopes: OAUTH_SCOPES,
        oauthRequestScopes: OAUTH_REQUEST_SCOPES,
        oauthValidateClientId: OAUTH_VALIDATE_CLIENT_ID,
        oauthAllowScopelessTokens: OAUTH_ALLOW_SCOPELESS_TOKENS,
        feedbackAdminConfigured: Boolean(FEEDBACK_ADMIN_ID && FEEDBACK_ADMIN_PASSWORD),
      }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    writeJson(res, 200, publicConfig());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/help") {
    const locale = normalizeUiLocale(url.searchParams.get("locale")) || "ko";
    const query = url.searchParams.get("q") || "";
    writeJson(res, 200, query ? searchHelpContent(locale, query) : helpContentFor(locale));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const auth = await authorizeWebRequest(req, READ_SCOPES);
    if (!auth.ok) {
      writeJson(res, auth.status, { message: auth.response?.content?.[0]?.text || "Authentication required." });
      return;
    }
    const state = await getState(auth.context);
    writeJson(res, 200, { state: refreshDashboard(state) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session/select") {
    const auth = await authorizeWebRequest(req, WRITE_SCOPES);
    if (!auth.ok) {
      writeJson(res, auth.status, { message: auth.response?.content?.[0]?.text || "Authentication required." });
      return;
    }
    try {
      const body = await readRequestJson(req);
      const state = await getState(auth.context);
      const session = findSession(state, body.sessionId);
      if (!session) {
        writeJson(res, 404, { message: "Session not found." });
        return;
      }
      state.activeSessionId = session.id;
      if (state.currentSection?.sessionId !== session.id) state.currentSection = null;
      await saveState(auth.context, state);
      writeJson(res, 200, { state: refreshDashboard(state) });
    } catch (error) {
      writeJson(res, 400, { message: cleanText(error?.message) || "Invalid request." });
    }
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/session/")) {
    const auth = await authorizeWebRequest(req, WRITE_SCOPES);
    if (!auth.ok) {
      writeJson(res, auth.status, { message: auth.response?.content?.[0]?.text || "Authentication required." });
      return;
    }
    const sessionId = decodeURIComponent(url.pathname.slice("/api/session/".length));
    const state = await getState(auth.context);
    const before = state.sessions.length;
    state.sessions = state.sessions.filter((session) => session.id !== sessionId);
    if (state.activeSessionId === sessionId) state.activeSessionId = null;
    if (state.currentSection?.sessionId === sessionId) state.currentSection = null;
    if (before === state.sessions.length) {
      writeJson(res, 404, { message: "Session not found." });
      return;
    }
    await saveState(auth.context, state);
    writeJson(res, 200, { state: refreshDashboard(state) });
    return;
  }

  const settingsMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/settings$/);
  if (req.method === "POST" && settingsMatch) {
    const auth = await authorizeWebRequest(req, WRITE_SCOPES);
    if (!auth.ok) {
      writeJson(res, auth.status, { message: auth.response?.content?.[0]?.text || "Authentication required." });
      return;
    }
    try {
      const sessionId = decodeURIComponent(settingsMatch[1]);
      const body = await readRequestJson(req);
      const state = await getState(auth.context);
      const existingIndex = state.sessions.findIndex((session) => session.id === sessionId);
      if (existingIndex < 0) {
        writeJson(res, 404, { message: "Session not found." });
        return;
      }
      const incoming = body.session ?? {};
      state.sessions[existingIndex] = {
        ...state.sessions[existingIndex],
        ...incoming,
        id: sessionId,
        updatedAt: nowIso(),
      };
      await saveState(auth.context, state);
      writeJson(res, 200, { state: refreshDashboard(state) });
    } catch (error) {
      writeJson(res, 400, { message: cleanText(error?.message) || "Invalid request." });
    }
    return;
  }

  if (
    req.method === "GET" &&
    (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp"
    )
  ) {
    res
      .writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=300",
      })
      .end(JSON.stringify(oauthProtectedResourceMetadata(), null, 2));
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(renderHomePage());
    return;
  }

  if (req.method === "GET" && url.pathname === "/help") {
    const locale = normalizeUiLocale(url.searchParams.get("locale")) || "ko";
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(renderHelpPage(locale));
    return;
  }

  if (req.method === "GET" && url.pathname === "/icon.png" && iconPng) {
    res
      .writeHead(200, {
        "content-type": "image/png",
        "cache-control": "public, max-age=3600",
      })
      .end(iconPng);
    return;
  }

  if (req.method === "GET" && url.pathname === "/preview") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(widgetHtml);
    return;
  }

  if (req.method === "GET" && url.pathname === "/feedback") {
    if (!feedbackAdminAuthorized(req)) {
      feedbackUnauthorized(res);
      return;
    }
    try {
      const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
      const pageSize = clampInteger(url.searchParams.get("pageSize"), 1, 100, 20);
      const items = await loadFeedbackItems();
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(renderFeedbackPage(items, page, pageSize));
    } catch (error) {
      res
        .writeHead(500, { "content-type": "text/plain; charset=utf-8" })
        .end(`Feedback page failed: ${cleanText(error?.message)}`);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/privacy-poilcy.html" && privacyPolicyHtml) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(privacyPolicyHtml);
    return;
  }

  if (req.method === "GET" && url.pathname === "/terms-of-service.html" && termsOfServiceHtml) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(termsOfServiceHtml);
    return;
  }

  const isMcpRequest =
    url.pathname === MCP_PATH ||
    (url.pathname === "/" && req.method !== "GET");

  if (isMcpRequest && req.method && MCP_METHODS.has(req.method)) {
    setMcpResponseHeaders(req, res);
    normalizeMcpPostHeaders(req);

    if (req.method === "GET") {
      const server = createLingoStarServer();
      const transport = new SSEServerTransport(MCP_PATH, res, { enableDnsRebindingProtection: false });
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");

      res.on("close", () => {
        mcpActiveSessions.delete(transport.sessionId);
        transport.close();
        server.close();
      });

      try {
        await server.connect(transport);
        mcpActiveSessions.set(transport.sessionId, { server, transport });
      } catch (error) {
        console.error("Error starting SSE:", error);
        if (!res.headersSent) res.writeHead(500).end("Internal server error");
      }
      return;
    }

    if (req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId") || req.headers["mcp-session-id"];
      const active = mcpActiveSessions.get(sessionId);

      if (!active) {
        try {
          await handleStatelessMcpRequest(req, res);
        } catch (error) {
          console.error("Error handling stateless MCP POST:", error);
          if (!res.headersSent) res.writeHead(500).end("Internal server error");
        }
        return;
      }

      try {
        await active.transport.handlePostMessage(req, res);
      } catch (error) {
        console.error("Error handling MCP POST:", error);
        if (!res.headersSent) res.writeHead(500).end("Internal server error");
      }
      return;
    }

    res.writeHead(405).end("Method Not Allowed");
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`LingoStar MCP server v${SERVICE_VERSION} listening on http://localhost:${port}${MCP_PATH}`);
});
