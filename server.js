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

const SERVICE_VERSION = "0.10.2";
const WIDGET_VERSION = "0.10.2";
const WELCOME_WIDGET_URI = "ui://widget/lingostar-welcome-v0-10-2.html";
const SESSION_SELECT_WIDGET_URI = "ui://widget/lingostar-session-select-v0-10-2.html";
const LESSON_WIDGET_URI = "ui://widget/lingostar-lesson-v0-10-2.html";
const WIDGET_URI = LESSON_WIDGET_URI;
const WIDGET_URIS = {
  welcome: WELCOME_WIDGET_URI,
  sessionSelect: SESSION_SELECT_WIDGET_URI,
  lesson: LESSON_WIDGET_URI,
};
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
const OAUTH_WEB_CLIENT_ID = firstCleanValue(
  process.env.OAUTH_WEB_CLIENT_ID,
  ENV_FILE.OAUTH_WEB_CLIENT_ID,
  OAUTH_CLIENT_ID
);
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
const widgetHtmlTemplate = readFileSync("public/lingostar-widget.html", "utf8");
const UI_COPY_PATHS = {
  en: "content/ui_en_ux.json",
  ko: "content/ui_ko_ux.json",
};
const UI_COPY = loadUiCopy();
const UI_COPY_JSON = JSON.stringify(UI_COPY).replaceAll("<", "\\u003c");
function widgetHtmlForDefaultView(defaultView = "auto") {
  return widgetHtmlTemplate
    .replaceAll("__LINGOSTAR_ICON__", ICON_URL)
    .replaceAll("__LINGOSTAR_APP_ORIGIN__", APP_ORIGIN)
    .replaceAll("__LINGOSTAR_DEFAULT_VIEW__", defaultView)
    .replaceAll("__LINGOSTAR_UI_COPY__", UI_COPY_JSON);
}
const widgetHtml = widgetHtmlForDefaultView("welcome");
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
  initialView: z.enum(["auto", "welcome", "select", "lesson"]).optional(),
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
    requestHeader(context, "openai-locale") ??
    requestHeader(context, "x-openai-locale") ??
    requestHeader(context, "accept-language") ??
    ""
  );
}

function loadJsonFile(path, fallback = {}) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function loadUiCopy() {
  const fallback = {
    en: {
      appName: "LingoStar",
      welcomeTitle: "Start language practice in ChatGPT",
      welcomeBody: "Tell ChatGPT what you want to learn. LingoStar will save a learning track, open a practice set, and keep progress for next time.",
      selectTitle: "Choose a learning track",
      lessonComplete: "Practice saved. Ask ChatGPT for your next practice set when you are ready.",
    },
    ko: {
      appName: "LingoStar",
      welcomeTitle: "ChatGPT에서 언어 학습을 시작하세요",
      welcomeBody: "배우고 싶은 언어와 목표를 ChatGPT에 말하면 학습 트랙을 저장하고 연습 묶음을 열어 드립니다.",
      selectTitle: "학습 트랙 선택",
      lessonComplete: "연습 결과를 저장했습니다. 준비되면 ChatGPT에 다음 연습을 요청하세요.",
    },
  };
  const loaded = {};
  for (const locale of SUPPORTED_UI_LOCALES) {
    loaded[locale] = {
      ...(fallback[locale] ?? fallback.en),
      ...loadJsonFile(UI_COPY_PATHS[locale], {}),
    };
  }
  return loaded;
}

function uiCopyFor(locale = "en") {
  const normalized = normalizeUiLocale(locale) ?? "en";
  return UI_COPY[normalized] ?? UI_COPY.en;
}

/* ------------------------------------------------------------------ */
/*  TEXT dictionary (en / ko)                                          */
/* ------------------------------------------------------------------ */

const FALLBACK_HELP_CONTENT = {
  en: {
    title: "How LingoStar works",
    intro: "LingoStar helps you keep several language learning sessions and practice them inside ChatGPT.",
    features: [
      "Create separate language sessions for each target language and goal.",
      "Practice language information, listening, reading, writing, and speaking in each section.",
      "Some mobile ChatGPT environments may limit speaking. Type an answer or skip the current speaking exercise when needed.",
      "Ask questions in the ChatGPT composer while LingoStar keeps the current exercise context.",
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
      "ChatGPT 입력창에서 질문해도 현재 문제 문맥을 유지합니다.",
      "설정에서 영역별 문제 수, 진행 상황, 취약점, 통과 점수, 발화 속도를 조정할 수 있습니다.",
      "모든 화면의 피드백 버튼으로 오류나 개선 의견을 보낼 수 있습니다."
    ],
    footer: "학습 대상 언어의 예문과 문제는 해당 언어로 표시하고, 인터페이스는 지원되는 경우 ChatGPT 접속 언어를 따릅니다."
  }
};

let TEXT = {
  en: {
    loaded: "Loaded the latest LingoStar state.",
    noSession: "Create or select a learning track first.",
    notFound: "No matching learning track was found in your LingoStar data.",
    deleted: "Deleted the requested learning track.",
    deletedAll: "Deleted all learning tracks in your LingoStar data.",
    missingContext: "The learning track or practice set could not be found.",
    sessionSelected: (language) => `Selected ${language}. Continue the unfinished practice set if one exists; otherwise create the next practice set.`,
    sessionStored: (language) => `Stored the ${language} learning track. Create or open the next practice set before giving long prose.`,
    settingsStored: "Updated the learning settings. New settings apply to the next practice set unless the current set is already open.",
    sectionStored: (count, speakingEnabled) => `Stored a practice set with ${count} exercises. Speaking is ${speakingEnabled ? "included" : "not included"} for this set.`,
    resultsStored: "Exercise results saved. If the practice set is complete, summarize the outcome and suggest the next conversational command.",
    levelJudged: "Level judgment recorded.",
    transcribed: "Audio transcribed.",
    synthesized: "Audio synthesized.",
    feedbackStored: "Feedback submitted.",
  },
  ko: {
    loaded: "최신 LingoStar 상태를 불러왔습니다.",
    noSession: "먼저 학습 트랙을 만들거나 선택해 주세요.",
    notFound: "현재 LingoStar 데이터에서 일치하는 학습 트랙을 찾지 못했습니다.",
    deleted: "요청한 학습 트랙을 삭제했습니다.",
    deletedAll: "내 LingoStar 데이터의 모든 학습 트랙을 삭제했습니다.",
    missingContext: "학습 트랙 또는 연습 묶음을 찾지 못했습니다.",
    sessionSelected: (language) => `${language} 학습 트랙을 선택했습니다. 미완료 연습 묶음이 있으면 이어가고, 없으면 다음 연습 묶음을 생성하세요.`,
    sessionStored: (language) => `${language} 학습 트랙을 저장했습니다. 긴 설명을 하기 전에 다음 연습 묶음을 만들거나 열어 주세요.`,
    settingsStored: "학습 설정을 업데이트했습니다. 이미 열린 연습 묶음은 유지되고, 새 설정은 다음 연습 묶음부터 적용됩니다.",
    sectionStored: (count, speakingEnabled) => `${count}문항 연습 묶음을 저장했습니다. 이번 연습에는 말하기가 ${speakingEnabled ? "포함됩니다" : "포함되지 않습니다"}.`,
    resultsStored: "문제 결과를 저장했습니다. 연습 묶음이 끝났다면 결과를 요약하고 다음에 쓸 수 있는 명령을 안내하세요.",
    levelJudged: "단계 판정을 기록했습니다.",
    transcribed: "녹음 내용을 텍스트로 변환했습니다.",
    synthesized: "듣기 음성을 만들었습니다.",
    feedbackStored: "피드백을 접수했습니다.",
  },
};

const HELP_FALLBACK_OVERRIDES = {
  ko: {
    title: "LingoStar 도움말",
    intro: "LingoStar는 ChatGPT 안에서 언어 공부를 이어 가는 앱입니다.",
    features: [
      "학습 트랙은 하나의 언어와 목표를 묶은 단위입니다.",
      "연습 묶음은 화면에서 직접 푸는 짧은 문제 세트입니다.",
      "설정과 진행 상황은 ChatGPT 입력창에서 자연어로 관리합니다.",
      "일부 모바일 환경에서는 말하기 입력이 제한될 수 있습니다.",
      "삭제는 현재 사용자에게 속한 학습 트랙에만 적용됩니다.",
    ],
    footer: "학습 내용은 목표 언어로, 안내 문구는 가능한 경우 사용자의 표시 언어로 보여 줍니다.",
  },
};

if (FALLBACK_HELP_CONTENT.ko) {
  FALLBACK_HELP_CONTENT.ko = HELP_FALLBACK_OVERRIDES.ko;
}

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
  const resourceUri = options.resourceUri || WIDGET_URI;
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
    meta.ui.resourceUri = resourceUri;
    meta["openai/outputTemplate"] = resourceUri;
  }
  return meta;
}

function renderToolMeta(scopes = [], invoking, invoked, resourceUri = WIDGET_URI) {
  return toolMeta(scopes, invoking, invoked, { render: true, resourceUri });
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

function uiLocaleFromLanguage(value = "") {
  const normalized = cleanText(value).toLowerCase();
  if (!normalized) return null;
  if (
    normalized.includes("ko") ||
    normalized.includes("korean") ||
    normalized.includes("한국") ||
    normalized.includes("한국어")
  ) {
    return "ko";
  }
  if (normalized.includes("en") || normalized.includes("english") || normalized.includes("영어")) {
    return "en";
  }
  return null;
}

function interfaceLanguage(nativeLanguage, setting = "auto", requestedLocale = "en") {
  if (setting === "en" || setting === "ko") return setting;
  return normalizeUiLocale(requestedLocale) ?? uiLocaleFromLanguage(nativeLanguage) ?? "en";
}

function textFor(sessionOrLocale) {
  const locale =
    typeof sessionOrLocale === "string"
      ? sessionOrLocale
      : sessionOrLocale?.runtime?.interfaceLanguage ?? sessionOrLocale?.host?.interfaceLanguage ?? "en";
  return TEXT[normalizeUiLocale(locale) ?? "en"] ?? TEXT.en;
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
      uiCopy: uiCopyFor("en"),
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
  const activeForLocale =
    state.sessions?.find((session) => session.id === state.activeSessionId) ??
    state.sessions?.[0] ??
    null;
  state.host.interfaceLanguage =
    normalizeUiLocale(requestedLocale) ??
    normalizeUiLocale(activeForLocale?.runtime?.interfaceLanguage) ??
    uiLocaleFromLanguage(activeForLocale?.nativeLanguage) ??
    "en";
  state.host.developerMode = DEVELOPER_MODE;

  // GUI
  state.gui ??= {};
  state.gui.widgetVersion = WIDGET_VERSION;
  state.gui.help = ensureTranslationCache(state, state.host.interfaceLanguage || requestedLocale || "en");
  state.gui.uiCopy = uiCopyFor(state.host.interfaceLanguage || requestedLocale || "en");
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
    state.gui.screen = "select";
  } else {
    state.gui.screen = "welcome";
  }

  return state;
}

/* ------------------------------------------------------------------ */
/*  Reply helper                                                       */
/* ------------------------------------------------------------------ */

function stateLocale(state) {
  return normalizeUiLocale(state?.host?.interfaceLanguage || state?.host?.locale || "en") ?? "en";
}

function withCommandFooter(message, state, options = {}) {
  const text = cleanText(message);
  if (options.commandFooter === false) return text;
  const footer = basicCommandFooter(state);
  return text ? `${text}\n\n${footer}` : footer;
}

function basicCommandFooter(state) {
  const ko = stateLocale(state) === "ko";
  if (ko) {
    return [
      "---",
      "기본 명령: `제 언어별 학습 트랙을 보여 주세요` / `다음 연습 시작` / `설정을 바꾸고 싶어요` / `모든 언어 학습 트랙을 삭제해 주세요`",
      "설정 예시: `말하기를 포함해 주세요`, `읽기 문제를 4개로 해 주세요`, `음성 속도를 0.8로 낮춰 주세요`",
    ].join("\n");
  }
  return [
    "---",
    "Basic commands: `show my learning tracks` / `start the next practice set` / `change my settings` / `delete all learning tracks`",
    "Settings examples: `include speaking`, `make reading four questions`, `slow audio speed to 0.8`",
  ].join("\n");
}

function sessionTableMessage(state) {
  const ko = stateLocale(state) === "ko";
  if (!state.sessions?.length) {
    return ko
      ? "현재 저장된 학습 트랙이 없습니다. 배우고 싶은 언어와 목표를 말해 주세요."
      : "No learning tracks are saved yet. Tell ChatGPT the language and goal you want.";
  }
  const rows = state.sessions.map((session) => {
    const completed = (session.sectionHistory ?? []).filter((item) => item.status === "completed" || item.status === "passed").length;
    const status = session.id === state.activeSessionId ? (ko ? "활성" : "Active") : (session.status || (ko ? "저장됨" : "Saved"));
    const activeSet = state.currentSection?.sessionId === session.id ? (ko ? "있음" : "Yes") : (ko ? "없음" : "No");
    return `| ${cleanText(session.targetLanguage) || "-"} | ${cleanText(session.goal?.detail || session.goal?.type) || "-"} | ${status} | ${activeSet} | ${completed} |`;
  });
  const header = ko
    ? "현재 학습 트랙입니다.\n\n| 언어 | 목표 | 상태 | 진행 중인 연습 | 완료한 연습 |\n|---|---|---|---|---|"
    : "Current learning tracks.\n\n| Language | Goal | Status | Unfinished practice | Completed sets |\n|---|---|---|---|---|";
  return `${header}\n${rows.join("\n")}`;
}

function replyWithState(state, message, isError = false, options = {}) {
  refreshDashboard(state);
  const structuredContent = { state };
  if (options.initialView) structuredContent.initialView = options.initialView;
  const text = withCommandFooter(message, state, options);
  return {
    content: text ? [{ type: "text", text }] : [],
    structuredContent,
    isError: isError,
  };
}

/* ------------------------------------------------------------------ */
/*  Session / section finders                                          */
/* ------------------------------------------------------------------ */

function findSession(state, sessionId) {
  return state.sessions.find((session) => session.id === sessionId);
}

function normalizedLookupText(value) {
  return cleanText(value).toLowerCase().replace(/\s+/g, "");
}

function findSessionsByTargetLanguage(state, targetLanguage) {
  const target = normalizedLookupText(targetLanguage);
  if (!target) return [];
  return (state.sessions ?? []).filter((session) => {
    const candidates = [
      session.targetLanguage,
      getDisplayLanguageNameForServer(session.targetLanguage),
      session.goal?.detail,
    ].map(normalizedLookupText);
    return candidates.some((item) => item && (item === target || item.includes(target) || target.includes(item)));
  });
}

function goalLookupText(value = {}) {
  const goal = value.goal && typeof value.goal === "object" ? value.goal : value;
  return cleanText([
    goal?.type,
    goal?.detail,
    value.goalType,
  ].filter(Boolean).join(" "));
}

function goalTokens(value = {}) {
  return goalLookupText(value)
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{Letter}\p{Number}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function goalSimilarityScore(existing = {}, incoming = {}) {
  const a = normalizedLookupText(goalLookupText(existing));
  const b = normalizedLookupText(goalLookupText(incoming));
  if (!a || !b) return 0;
  if (a === b) return 1;
  const examCode = /(jlptn\d|hsk\d|topik\d|dele[a-c]\d|delf[a-c]\d|dalfc\d)/i;
  const aExam = a.match(examCode)?.[1]?.toLowerCase();
  const bExam = b.match(examCode)?.[1]?.toLowerCase();
  if (aExam && bExam && aExam !== bExam) return 0;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const aTokens = new Set(goalTokens(existing));
  const bTokens = new Set(goalTokens(incoming));
  if (!aTokens.size || !bTokens.size) return 0;
  const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
  return shared / Math.max(aTokens.size, bTokens.size);
}

function findReusableSession(state, incoming = {}) {
  const sameLanguage = findSessionsByTargetLanguage(state, incoming.targetLanguage);
  const matchingGoal = sameLanguage
    .map((session) => ({ session, score: goalSimilarityScore(session, incoming) }))
    .sort((left, right) => right.score - left.score)
    .find((item) => item.score >= 0.55)?.session ?? null;
  return { sameLanguage, matchingGoal };
}

function hasSkillProfileSignal(profile = {}) {
  return EXERCISE_AREAS.some((area) => Number(profile?.[area]) > 0);
}

function mergeExerciseCounts(base = {}, patch = {}) {
  return normalizeExerciseCounts({
    ...(base ?? {}),
    ...(patch ?? {}),
  }, DEFAULT_EXERCISES_PER_AREA);
}

function mergeSessionForUpsert(existing, incoming, options = {}) {
  if (!existing) return incoming;
  const preserveExisting = Boolean(options.preserveExistingPreferences);
  const settings = preserveExisting
    ? {
        ...(incoming.settings ?? {}),
        ...(existing.settings ?? {}),
        exerciseCounts: mergeExerciseCounts(incoming.settings?.exerciseCounts, existing.settings?.exerciseCounts),
      }
    : {
        ...(existing.settings ?? {}),
        ...(incoming.settings ?? {}),
        exerciseCounts: mergeExerciseCounts(existing.settings?.exerciseCounts, incoming.settings?.exerciseCounts),
      };
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    createdAt: existing.createdAt ?? incoming.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    goal: {
      ...(existing.goal ?? {}),
      ...(incoming.goal ?? {}),
      detail: cleanText(incoming.goal?.detail) || cleanText(existing.goal?.detail),
      type: cleanText(incoming.goal?.type) || cleanText(existing.goal?.type) || "conversation",
    },
    settings,
    levels: existing.levels?.length ? existing.levels : incoming.levels ?? [],
    skillProfile: hasSkillProfileSignal(existing.skillProfile) ? existing.skillProfile : incoming.skillProfile ?? existing.skillProfile ?? {},
    sectionHistory: existing.sectionHistory?.length ? existing.sectionHistory : incoming.sectionHistory ?? [],
    feedbackMemory: existing.feedbackMemory?.length ? existing.feedbackMemory : incoming.feedbackMemory ?? [],
    progressContext: cleanText(incoming.progressContext) || cleanText(existing.progressContext),
    weaknessContext: cleanText(incoming.weaknessContext) || cleanText(existing.weaknessContext),
  };
}

function languageGoalConflictMessage(state, incoming, matches = []) {
  const ko = stateLocale(state) === "ko";
  const language = cleanText(incoming.targetLanguage) || (ko ? "해당 언어" : "that language");
  const requestedGoal = cleanText(incoming.goal?.detail || incoming.goal?.type) || (ko ? "새 목표" : "the new goal");
  const rows = matches.map((session) => {
    const goal = cleanText(session.goal?.detail || session.goal?.type) || "-";
    return `| ${cleanText(session.id)} | ${cleanText(session.targetLanguage) || "-"} | ${goal} |`;
  });
  if (ko) {
    return [
      `${language} 학습 트랙이 이미 있지만 목표가 "${requestedGoal}"와 다릅니다.`,
      "",
      "| 트랙 ID | 언어 | 현재 목표 |",
      "|---|---|---|",
      ...rows,
      "",
      "기존 트랙을 이어가려면 해당 트랙을 선택해 달라고 말해 주세요. 목표를 바꾸려면 기존 트랙을 업데이트해 달라고 말해 주세요. 별도 트랙을 만들고 싶다면 그렇게 말해 주세요.",
    ].join("\n");
  }
  return [
    `You already have ${language} learning track(s), but the goal differs from "${requestedGoal}".`,
    "",
    "| Track ID | Language | Current goal |",
    "|---|---|---|",
    ...rows,
    "",
    "Ask to select one, update an existing goal, or create a separate track.",
  ].join("\n");
}

function getDisplayLanguageNameForServer(value = "") {
  const raw = cleanText(value);
  const lower = raw.toLowerCase();
  const names = {
    japanese: "Japanese",
    ja: "Japanese",
    "ja-jp": "Japanese",
    korean: "Korean",
    ko: "Korean",
    "ko-kr": "Korean",
    english: "English",
    en: "English",
    spanish: "Spanish",
    es: "Spanish",
    french: "French",
    fr: "French",
    german: "German",
    de: "German",
    chinese: "Chinese",
    zh: "Chinese",
  };
  return names[lower] || raw;
}

function resolveSessionForMutation(state, args = {}) {
  if (args.sessionId) return findSession(state, args.sessionId) ?? null;
  const languageMatches = findSessionsByTargetLanguage(state, args.targetLanguage);
  if (languageMatches.length === 1) return languageMatches[0];
  if (!args.targetLanguage && state.activeSessionId) return findSession(state, state.activeSessionId) ?? null;
  if (!args.targetLanguage && state.sessions?.length === 1) return state.sessions[0];
  return null;
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
a{color:#0f8a6a;text-decoration:none;font-weight:700}
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
    widgetUris: WIDGET_URIS,
    authRequired: AUTH_REQUIRED,
    help: {
      ko: `${APP_ORIGIN}/help?locale=ko`,
      en: `${APP_ORIGIN}/help?locale=en`,
    },
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
article{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;box-shadow:0 2px 8px rgba(15,23,42,.06)}
h1{font-size:28px;margin:0 0 12px}
h2{font-size:18px;margin:28px 0 8px}
p,li{font-size:15px;color:#374151}
a{color:#0f8a6a;text-decoration:none;font-weight:700}
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
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>LingoStar</title>
<style>
:root{color-scheme:light;--bg:#f8fafc;--surface:#fff;--text:#111827;--muted:#64748b;--border:#e2e8f0;--accent:#10a37f;--soft:#ecfdf5}
*{box-sizing:border-box}
body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);line-height:1.55}
main{max-width:860px;margin:0 auto;padding:40px 20px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}
.brand{display:flex;align-items:center;gap:12px}
.mark{width:44px;height:44px;border-radius:10px;background:var(--accent);display:grid;place-items:center;color:#fff;font-weight:900}
h1,p{margin:0}
h1{font-size:30px;letter-spacing:0}
.muted{color:var(--muted)}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:22px;display:grid;gap:14px}
.row{display:flex;gap:10px;flex-wrap:wrap}
a{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:9px 13px;border-radius:8px;text-decoration:none;font-weight:800}
a.primary{background:var(--accent);color:#fff}
a.secondary{background:#fff;color:var(--text);border:1px solid var(--border)}
.lang{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
.note{background:var(--soft);border:1px solid #bbf7d0;border-radius:8px;padding:13px;color:#166534;font-weight:700}
@media(max-width:760px){.top{align-items:flex-start;display:grid}.lang{grid-template-columns:1fr}}
</style>
</head>
<body>
<main>
  <header class="top">
    <div class="brand"><div class="mark">L</div><div><h1>LingoStar</h1><p class="muted">ChatGPT Apps language practice</p></div></div>
    <div class="row"><a class="secondary" href="/help?locale=ko">도움말</a><a class="secondary" href="/help?locale=en">Help</a></div>
  </header>
  <section class="panel">
    <p class="note">LingoStar 학습은 ChatGPT 안의 앱 화면과 채팅으로 진행합니다.</p>
    <div class="lang">
      <div>
        <h2>한국어</h2>
        <p class="muted">이 페이지는 공개 도움말 입구입니다. 학습 기록과 설정은 ChatGPT 안의 LingoStar 앱에서만 다룹니다.</p>
      </div>
      <div>
        <h2>English</h2>
        <p class="muted">This is a public help entry point. Learning records and settings are handled inside the LingoStar app in ChatGPT.</p>
      </div>
    </div>
    <div class="row">
      <a class="primary" href="/help?locale=ko">한국어 도움말</a>
      <a class="secondary" href="/help?locale=en">English help</a>
    </div>
  </section>
</main>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/*  MCP server factory                                                 */
/* ------------------------------------------------------------------ */

function createLingoStarServer() {
  const server = new McpServer({ name: "lingostar", version: SERVICE_VERSION });

  /* ---------- Widget resource ---------- */

  function registerLingoStarResource(name, uri, defaultView, description) {
    registerAppResource(server, name, uri, {}, async () => ({
      contents: [
        {
          uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtmlForDefaultView(defaultView),
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
            "openai/widgetDescription": description,
          },
        },
      ],
    }));
  }

  registerLingoStarResource(
    "lingostar-welcome",
    WELCOME_WIDGET_URI,
    "welcome",
    "LingoStar welcome and onboarding card. Use for first-start guidance when the learner has no saved learning tracks."
  );
  registerLingoStarResource(
    "lingostar-session-select",
    SESSION_SELECT_WIDGET_URI,
    "select",
    "LingoStar learning-track selector. Use only for choosing or deleting saved language tracks; show detailed progress and settings conversationally in ChatGPT text."
  );
  registerLingoStarResource(
    "lingostar-lesson",
    LESSON_WIDGET_URI,
    "lesson",
    "LingoStar fullscreen-friendly lesson surface for solving the active language section. Use after creating exercises or when the user wants to continue the current section."
  );

  async function renderLingoStarView(context, initialView = "auto") {
    const auth = await authorizeContext(context, READ_SCOPES);
    if (!auth.ok) return auth.response;
    const state = await getState(context);
    return replyWithState(state, textFor(state.host?.interfaceLanguage ?? state.sessions[0] ?? "en").loaded, false, { initialView });
  }

  /* ====================================================================
   *  Tool 1: open_lingostar_app (render tool)
   * ==================================================================== */

  registerAppTool(
    server,
    "open_lingostar_app",
    {
      title: "Open LingoStar",
      description:
        "Render the LingoStar widget using the best available view. Use this for first-start onboarding, learning-track selection, or continuing the active practice set. Settings, progress details, and deletion should be handled conversationally with data tools.",
      inputSchema: {},
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(READ_SCOPES),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: renderToolMeta(READ_SCOPES, "Opening LingoStar", "LingoStar opened", WELCOME_WIDGET_URI),
    },
    async (_args, context) => {
      return renderLingoStarView(context, "auto");
    }
  );

  registerAppTool(
    server,
    "open_lingostar_session_select",
    {
      title: "Open LingoStar learning tracks",
      description:
        "Render the learning-track selector as a compact card list. Use this when the user has multiple saved tracks or when a new conversation needs explicit selection. Do not use it for settings, detailed progress, or exercise solving.",
      inputSchema: {},
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(READ_SCOPES),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: renderToolMeta(READ_SCOPES, "Opening learning tracks", "Learning tracks opened", SESSION_SELECT_WIDGET_URI),
    },
    async (_args, context) => {
      return renderLingoStarView(context, "select");
    }
  );

  registerAppTool(
    server,
    "open_lingostar_lesson",
    {
      title: "Open LingoStar lesson",
      description:
        "Render the active LingoStar lesson section in fullscreen-friendly mode. Use this after create_lesson_exercises or when the user wants to continue solving the current section. If no active section exists, first call create_lesson_exercises.",
      inputSchema: {},
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(READ_SCOPES),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: renderToolMeta(READ_SCOPES, "Opening lesson", "Lesson opened", LESSON_WIDGET_URI),
    },
    async (_args, context) => {
      return renderLingoStarView(context, "lesson");
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
        "Returns the user's latest private LingoStar state. Use this before answering progress, settings, details, or management questions; present learning tracks as a Markdown table in chat.",
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
      return replyWithState(state, sessionTableMessage(state), false, {
        initialView: state.sessions?.length ? "select" : "welcome",
      });
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
        "Searches the static LingoStar help markdown loaded by the server. Use this for help, usage, audio, learning-track, practice-set, settings, or troubleshooting questions before rendering any UI.",
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
        "Sets the active LingoStar learning track after the user explicitly chooses it in the widget or conversation. If an unfinished practice set exists, render the lesson. If no practice set exists, call create_lesson_exercises in the same assistant turn instead of rendering a progress page.",
      inputSchema: {
        sessionId: z.string().optional().describe("Exact learning-track ID to make active, when the user or widget provides it."),
        targetLanguage: z
          .string()
          .optional()
          .describe("Target language or track name to select when the user says things like 'Japanese track'. Must resolve inside the current user's private state only."),
      },
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(WRITE_SCOPES),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: dataToolMeta(WRITE_SCOPES, "Selecting learning track", "Learning track selected"),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, WRITE_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      const session = resolveSessionForMutation(state, args);
      if (!session) return replyWithState(state, textFor("en").notFound, true);
      state.activeSessionId = session.id;
      if (state.currentSection?.sessionId !== session.id) state.currentSection = null;
      session.updatedAt = nowIso();
      await saveState(context, state);
      return replyWithState(
        state,
        textFor(session).sessionSelected(cleanText(session.targetLanguage) || "selected language"),
        false,
        { initialView: state.currentSection ? "lesson" : "select" }
      );
    }
  );

  /* ====================================================================
   *  Tool 5: manage_learning_session
   * ==================================================================== */

  registerAppTool(
    server,
    "manage_learning_session",
    {
      title: "Start or manage learning session",
      description:
        "Use this when the learner starts, resumes, creates, or updates a language learning track. When initialSection is provided, this tool stores the practice set and renders the lesson widget immediately. If initialSection is omitted, call create_lesson_exercises or open_lingostar_lesson before telling the learner to solve exercises. NEVER output lesson content in chat text. NEVER ask the user to type answers in chat; the user submits answers through the UI.",
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
      _meta: renderToolMeta(WRITE_SCOPES, "Storing session", "Session stored", LESSON_WIDGET_URI),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, WRITE_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      const requestedLocale = requestedLocaleFromContext(context);
      let incoming = args.session ?? {};
      const providedSessionId = Boolean(cleanText(incoming.id));

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

      if (!providedSessionId) {
        const { sameLanguage, matchingGoal } = findReusableSession(state, incoming);
        if (matchingGoal) {
          incoming.id = matchingGoal.id;
          incoming = mergeSessionForUpsert(matchingGoal, incoming, { preserveExistingPreferences: true });
        } else if (sameLanguage.length > 0) {
          return replyWithState(state, languageGoalConflictMessage(state, incoming, sameLanguage), false, {
            initialView: "select",
          });
        }
      }

      // Upsert without erasing existing history, settings, or feedback memory.
      const existingIndex = state.sessions.findIndex((s) => s.id === incoming.id);
      if (existingIndex >= 0) {
        incoming = mergeSessionForUpsert(state.sessions[existingIndex], incoming, {
          preserveExistingPreferences: !providedSessionId,
        });
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
      return replyWithState(
        state,
        textFor(incoming).sessionStored(lang),
        false,
        { initialView: state.currentSection ? "lesson" : "select" }
      );
    }
  );

  /* ====================================================================
   *  Tool 6: update_lingostar_settings
   * ==================================================================== */

  registerAppTool(
    server,
    "update_lingostar_settings",
    {
      title: "Update LingoStar settings",
      description:
        "Use this when the learner conversationally asks to change settings, such as speaking on/off, per-area question counts, pass score, audio speed, display language, progress notes, weak-point notes, target language, native language, interests, or avoided topics. This is a data tool; do not render a settings widget. New exercise settings apply to the next practice set unless a current practice set is already open.",
      inputSchema: {
        sessionId: z.string().optional().describe("Preferred exact learning-track ID to update. Use when the user selected a specific track or the current state table provided an ID."),
        targetLanguage: z.string().optional().describe("Target language or learning-track name to update when no sessionId is available, e.g. Japanese or Korean. If multiple tracks match, ask the user to choose instead of guessing."),
        patch: z.object({
          targetLanguage: z.string().optional().describe("New target language for this learning track, if the learner explicitly renames or changes it."),
          nativeLanguage: z.string().optional().describe("Learner's native/interface language for explanations, if explicitly changed."),
          goal: goalSchema.optional().describe("Updated learning goal, such as JLPT N4, travel conversation, or business email."),
          progressContext: z.string().optional().describe("Updated progress note in the learner's interface language. Preserve useful prior context unless the learner asks to replace it."),
          weaknessContext: z.string().optional().describe("Updated weak-point note in the learner's interface language. Preserve useful prior context unless the learner asks to replace it."),
          interests: z.array(z.string()).optional().describe("Updated interests for personalization."),
          avoidTopics: z.array(z.string()).optional().describe("Updated topics to avoid."),
          settings: z.object({
            displayLanguage: displayLanguageSchema.optional().describe("UI display language: auto, en, or ko."),
            exercisesPerSkill: z.number().optional().describe("Uniform fallback number of exercises per enabled area. Prefer exerciseCounts when changing one area."),
            exerciseCounts: z.object({
              language_info: z.number().optional().describe("Number of language fact questions per practice set, 3-6."),
              listening: z.number().optional().describe("Number of listening questions per practice set, 3-6."),
              reading: z.number().optional().describe("Number of reading questions per practice set, 3-6."),
              writing: z.number().optional().describe("Number of writing questions per practice set, 3-6."),
              speaking: z.number().optional().describe("Number of speaking prompts per practice set, 3-6 when speaking is enabled."),
            }).passthrough().optional().describe("Per-area question counts the learner asked to change."),
            sectionPassThreshold: z.number().optional().describe("Practice-set pass score threshold from 0-100."),
            minSectionsForGoalCompletion: z.number().optional().describe("Minimum completed practice sets before a goal can be marked complete. Minimum 10."),
            ttsRate: z.number().optional().describe("Speech playback speed, usually 0.6-1.4 for the widget."),
            speakingEnabled: z.boolean().optional().describe("Whether future practice sets should include speaking prompts."),
            levelMode: z.enum(["cefr", "freeform"]).optional().describe("Curriculum structure mode."),
          }).passthrough().optional().describe("Settings changes extracted from the learner's natural-language request."),
        }).passthrough().describe("Only include fields the learner explicitly asked to change or that are necessary to keep the setting coherent."),
      },
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(WRITE_SCOPES),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: dataToolMeta(WRITE_SCOPES, "Updating settings", "Settings updated"),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, WRITE_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      const session = resolveSessionForMutation(state, args);
      if (!session) {
        return replyWithState(state, textFor(state.host?.interfaceLanguage ?? "en").notFound, true, { initialView: state.sessions?.length ? "select" : "welcome" });
      }

      const patch = args.patch ?? {};
      if (patch.targetLanguage !== undefined) session.targetLanguage = cleanText(patch.targetLanguage) || session.targetLanguage;
      if (patch.nativeLanguage !== undefined) session.nativeLanguage = cleanText(patch.nativeLanguage) || session.nativeLanguage;
      if (patch.goal) {
        session.goal = {
          ...(session.goal ?? {}),
          ...patch.goal,
        };
        session.goal.type ??= session.goalType || "conversation";
        session.goal.detail ??= "";
      }
      if (patch.progressContext !== undefined) session.progressContext = cleanText(patch.progressContext);
      if (patch.weaknessContext !== undefined) session.weaknessContext = cleanText(patch.weaknessContext);
      if (patch.interests !== undefined) session.interests = splitList(patch.interests);
      if (patch.avoidTopics !== undefined) session.avoidTopics = splitList(patch.avoidTopics);

      session.settings ??= {};
      if (patch.settings) {
        const nextSettings = { ...session.settings, ...patch.settings };
        nextSettings.displayLanguage = displayLanguageSchema.safeParse(nextSettings.displayLanguage).success ? nextSettings.displayLanguage : "auto";
        nextSettings.exercisesPerSkill = clampExerciseCount(nextSettings.exercisesPerSkill, session.settings.exercisesPerSkill || DEFAULT_EXERCISES_PER_AREA);
        nextSettings.exerciseCounts = normalizeExerciseCounts(
          { ...(session.settings.exerciseCounts ?? {}), ...(patch.settings.exerciseCounts ?? {}) },
          nextSettings.exercisesPerSkill
        );
        nextSettings.sectionPassThreshold = clampInteger(nextSettings.sectionPassThreshold, 0, 100, 85);
        nextSettings.minSectionsForGoalCompletion = Math.max(10, clampInteger(nextSettings.minSectionsForGoalCompletion, 10, 500, 10));
        nextSettings.ttsRate = Math.max(0.6, Math.min(1.4, Number(nextSettings.ttsRate) || 1));
        nextSettings.speakingEnabled = nextSettings.speakingEnabled !== false;
        nextSettings.levelMode = ["cefr", "freeform"].includes(nextSettings.levelMode) ? nextSettings.levelMode : "cefr";
        session.settings = nextSettings;
      }

      session.stage = learnerStageSchema.safeParse(session.stage).success ? session.stage : inferLearnerStage(session);
      session.runtime ??= {};
      session.runtime.interfaceLanguage = interfaceLanguage(
        session.nativeLanguage ?? "",
        session.settings.displayLanguage,
        requestedLocaleFromContext(context)
      );
      session.runtime.speechLang = speechLangForTargetLanguage(session.targetLanguage);
      session.updatedAt = nowIso();

      await saveState(context, state);
      return replyWithState(
        state,
        textFor(session).settingsStored,
        false,
        { initialView: state.currentSection?.sessionId === session.id ? "lesson" : "select" }
      );
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
        "CRITICAL: Use this tool for the actual questions/exercises for a lesson section, including when the app asks for the next section. App messages may be short; read the app/model context for target language, level, enabled skills, and per-skill count. NEVER output exercises in chat text. NEVER ask the user to type answers in chat. This tool stores the section and renders the lesson UI.",
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
      _meta: renderToolMeta(WRITE_SCOPES, "Storing section", "Section stored", LESSON_WIDGET_URI),
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
        textFor(session).sectionStored(incoming.exercises.length, session.settings?.speakingEnabled !== false),
        false,
        { initialView: "lesson" }
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
        screen: z.string().optional().describe("The UI screen where the feedback was submitted, such as welcome, select, or lesson."),
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
        "Deletes one or more private LingoStar learning tracks only when the user explicitly asks for deletion. Use deleteAll for requests such as 'delete all language sessions'. Use targetLanguage for requests such as 'delete my Japanese track'. Never suggest a web dashboard for deletion.",
      inputSchema: {
        sessionId: z.string().optional().describe("Exact learning-track ID to delete, when known."),
        targetLanguage: z.string().optional().describe("Target language or track name to delete, e.g. Japanese. Deletes matching tracks only inside the current user's state."),
        deleteAll: z.boolean().optional().describe("True only when the user explicitly asks to delete all LingoStar language sessions or all learning tracks."),
        deleteActive: z.boolean().optional().describe("True only when the user explicitly asks to delete the currently active/selected learning track."),
      },
      outputSchema: stateOutputSchema,
      securitySchemes: requiredSecuritySchemes(WRITE_SCOPES),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
      _meta: dataToolMeta(WRITE_SCOPES, "Deleting learning track", "Learning track deleted"),
    },
    async (args, context) => {
      const auth = await authorizeContext(context, WRITE_SCOPES);
      if (!auth.ok) return auth.response;
      const state = await getState(context);
      const before = state.sessions.length;
      let deleteIds = [];
      if (args.deleteAll) {
        deleteIds = state.sessions.map((session) => session.id);
      } else if (args.sessionId) {
        deleteIds = findSession(state, args.sessionId) ? [args.sessionId] : [];
      } else if (args.deleteActive && state.activeSessionId) {
        deleteIds = [state.activeSessionId];
      } else if (args.targetLanguage) {
        deleteIds = findSessionsByTargetLanguage(state, args.targetLanguage).map((session) => session.id);
      }

      if (!deleteIds.length) {
        return replyWithState(
          state,
          textFor(state.host?.interfaceLanguage ?? "en").notFound,
          true,
          { initialView: state.sessions?.length ? "select" : "welcome" }
        );
      }

      const deletedSessions = state.sessions.filter((item) => deleteIds.includes(item.id));
      state.sessions = state.sessions.filter((item) => !deleteIds.includes(item.id));

      if (deleteIds.includes(state.activeSessionId)) {
        state.activeSessionId = null;
      }
      if (deleteIds.includes(state.currentSection?.sessionId)) {
        state.currentSection = null;
      }

      const deleted = before !== state.sessions.length;
      if (deleted) await saveState(context, state);
      const localeTarget = deletedSessions[0] ?? state.host?.interfaceLanguage ?? "en";
      return replyWithState(
        state,
        deleted
          ? (args.deleteAll ? textFor(localeTarget).deletedAll : textFor(localeTarget).deleted)
          : textFor(localeTarget).notFound,
        !deleted,
        { initialView: state.sessions?.length ? "select" : "welcome" }
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
        widgetUris: WIDGET_URIS,
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
        oauthWebClientIdConfigured: Boolean(OAUTH_WEB_CLIENT_ID),
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

  if (
    url.pathname === "/api/state" ||
    url.pathname === "/api/session" ||
    url.pathname === "/api/session/select" ||
    url.pathname.startsWith("/api/session/")
  ) {
    writeJson(res, 410, {
      message: "The web state API is disabled. Manage LingoStar learning tracks through the ChatGPT app tools.",
    });
    return;
  }


  if (req.method === "GET" && url.pathname === "/.well-known/openai-apps-challenge") {
    const challengeToken = process.env.OPENAI_APPS_CHALLENGE_TOKEN || ENV_FILE.OPENAI_APPS_CHALLENGE_TOKEN || "YOUR_TOKEN_HERE";
    res
      .writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=300",
      })
      .end(challengeToken);
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

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/auth/callback")) {
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
