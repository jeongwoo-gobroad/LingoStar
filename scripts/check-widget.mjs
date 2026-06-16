import { readFileSync } from "node:fs";

const html = readFileSync("public/lingostar-widget.html", "utf8");
const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);

if (!match) {
  throw new Error("Widget module script not found.");
}

const renderedHtml = [];
const attrs = new Map();
const listeners = new Map();
const widgetStateCalls = [];
const displayModeCalls = [];
const appEl = {
  addEventListener() {},
  querySelector() {
    return null;
  },
  set innerHTML(value) {
    renderedHtml.push(String(value));
  },
  get innerHTML() {
    return renderedHtml.at(-1) || "";
  },
};
const windowStub = {
  parent: null,
  openai: {
    locale: "ko-KR",
    setWidgetState(state) {
      widgetStateCalls.push(state);
      return Promise.resolve();
    },
    requestDisplayMode(args) {
      displayModeCalls.push(args);
      return Promise.resolve();
    },
    notifyIntrinsicHeight() {},
    updateModelContext() {
      return Promise.resolve({});
    },
  },
  matchMedia() {
    return { matches: true };
  },
  postMessage() {},
  addEventListener(type, listener) {
    const bucket = listeners.get(type) || [];
    bucket.push(listener);
    listeners.set(type, bucket);
  },
  speechSynthesis: null,
};
windowStub.parent = windowStub;

globalThis.window = windowStub;
globalThis.document = {
  body: { prepend() {} },
  documentElement: {
    setAttribute(name, value) {
      attrs.set(name, value);
    },
    getAttribute(name) {
      return attrs.get(name) || "";
    },
  },
  createElement() {
    return { style: {}, prepend() {}, set innerHTML(_) {}, get innerHTML() { return ""; } };
  },
  getElementById(id) {
    return id === "app" ? appEl : null;
  },
};
globalThis.localStorage = {
  store: new Map(),
  getItem(key) {
    return this.store.get(key) || null;
  },
  setItem(key, value) {
    this.store.set(key, String(value));
  },
};
Object.defineProperty(globalThis, "navigator", {
  value: { language: "ko-KR", mediaDevices: {} },
  configurable: true,
});

await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(match[1])}`);
await new Promise((resolve) => setTimeout(resolve, 250));

if (!renderedHtml.length) {
  throw new Error("Widget module did not render under a host-like environment.");
}

const lessonState = {
  version: "0.10.2",
  activeSessionId: "session-test",
  sessions: [{
    id: "session-test",
    targetLanguage: "Japanese",
    nativeLanguage: "Korean",
    goal: { type: "exam", detail: "JLPT N4" },
    status: "active",
    settings: {},
    runtime: {},
    sectionHistory: [],
  }],
  currentSection: {
    id: "section-test",
    sessionId: "session-test",
    title: "N4 practice",
    exercises: [{
      id: "exercise-test",
      type: "reading",
      skill: "reading",
      prompt: "Read and answer.",
      payload: {
        passage: "日本語の文です。",
        question: "What is this?",
        choices: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }],
        correctChoiceId: "a",
      },
    }],
    results: [],
  },
  recentFeedback: [],
  feedbackItems: [],
  dashboard: {},
  host: { interfaceLanguage: "ko-KR" },
  gui: { screen: "lesson", widgetVersion: "0.10.2" },
};

const beforeGlobalsRenderCount = renderedHtml.length;
const globalsEvent = {
  detail: {
    globals: {
      widgetState: { viewMode: "lesson", currentExerciseIndex: 0, tokenAnswer: [], typedAnswers: [], pendingDeleteSessionId: null },
      toolOutput: { state: lessonState, initialView: "lesson" },
    },
  },
};
for (const listener of listeners.get("openai:set_globals") || []) {
  listener(globalsEvent);
  listener(globalsEvent);
  listener(globalsEvent);
}
await new Promise((resolve) => setTimeout(resolve, 250));

const globalsRenderCount = renderedHtml.length - beforeGlobalsRenderCount;
if (globalsRenderCount !== 1) {
  throw new Error(`Widget re-rendered ${globalsRenderCount} times for identical openai:set_globals payloads.`);
}

if (displayModeCalls.filter((item) => item?.mode === "fullscreen").length > 1) {
  throw new Error("Widget requested fullscreen repeatedly for the same lesson globals payload.");
}

if (!html.includes('const ICON_SRC = "__LINGOSTAR_ICON__";')) {
  throw new Error("Widget icon must be injected by the server as an absolute URL.");
}

if (!html.includes('const DEFAULT_VIEW = "__LINGOSTAR_DEFAULT_VIEW__";')) {
  throw new Error("Widget default view must be injected by the server for each component template.");
}

if (!html.includes('const UI_COPY = typeof __LINGOSTAR_UI_COPY__ === "object"')) {
  throw new Error("Widget copy must be injected from language-specific UI resources.");
}

if (!html.includes('rpcRequest("ui/message"')) {
  throw new Error("Widget follow-up messages must use the standard ui/message request.");
}

if (!html.includes('rpcRequest("ui/update-model-context"')) {
  throw new Error("Widget must send detailed model instructions through ui/update-model-context.");
}

if (html.includes("ui/sendFollowUpMessage")) {
  throw new Error("Widget still references non-standard ui/sendFollowUpMessage.");
}

if (html.includes("sendFollowUpToHost(buildSectionGenerationPrompt())")) {
  throw new Error("Widget must not expose the raw section-generation prompt as a visible chat message.");
}

if (!html.includes("appCapabilities")) {
  throw new Error("Widget initialize request must advertise appCapabilities.");
}

if (!html.includes("Loading LingoStar")) {
  throw new Error("Widget must include static fallback UI before JavaScript runs.");
}

if (!html.includes("hydrateFromOpenAiGlobals")) {
  throw new Error("Widget must hydrate from ChatGPT-provided window.openai globals.");
}

if (!html.includes("window.openai?.callTool")) {
  throw new Error("Widget should prefer the documented window.openai.callTool API when available.");
}

if (!html.includes('window.addEventListener("openai:set_globals"')) {
  throw new Error("Widget must listen for ChatGPT openai:set_globals updates.");
}

if (!html.includes("setWidgetState") || !html.includes("widgetState")) {
  throw new Error("Widget must persist interaction state through window.openai.widgetState.");
}

if (!html.includes("sendFollowUpMessage")) {
  throw new Error("Widget should use window.openai.sendFollowUpMessage when available.");
}

if (!html.includes("requestDisplayMode({ mode: targetMode })")) {
  throw new Error("Widget should request fullscreen display mode for complex lesson surfaces.");
}

if (!html.includes("requestInlineDisplayMode")) {
  throw new Error("Widget must request inline display mode after section completion.");
}

if (!html.includes('requestInlineDisplayMode("section-complete")')) {
  throw new Error("Widget must automatically return to inline display after section completion.");
}

if (html.includes('data-action="dashboard">${c.backToDashboard}')) {
  throw new Error("Lesson surfaces must not include an in-section dashboard navigation button.");
}

if (html.includes('data-action="settings"') || html.includes("renderSettings") || html.includes("open_lingostar_settings")) {
  throw new Error("Widget must not include a settings surface; settings are conversational.");
}

if (html.includes("open_lingostar_dashboard")) {
  throw new Error("Widget must not reference the removed dashboard render tool.");
}

if (html.includes('data-action="ask-ai"')) {
  throw new Error("Widget must not duplicate ChatGPT's composer with an in-widget Ask AI action.");
}

if (html.includes('data-action="toggle-theme"') || html.includes("theme-toggle")) {
  throw new Error("Widget must not add app-level theme controls; it should inherit ChatGPT/native theme context.");
}

if (html.includes("background:linear-gradient")) {
  throw new Error("Widget must not rely on decorative gradients; use native cards and accent-only branding.");
}

if (html.includes('rpcNotify("ui/resize"')) {
  throw new Error("Widget must not send unsupported resize notifications on every render.");
}

if (html.includes("animation:fadeIn") || html.includes("@keyframes fadeIn")) {
  throw new Error("Widget must not restart full-surface fade animations on each render.");
}

if (!html.includes("lastToolOutputJson") || !html.includes("lastWidgetStateJson") || !html.includes("lastDisplayModeRequest")) {
  throw new Error("Widget host synchronization must be deduplicated to avoid render loops.");
}

if (html.includes("skillEmoji") || html.includes("emoji")) {
  throw new Error("Widget must not rely on emoji labels or redundant visual branding.");
}

if (!html.includes("pendingDirectEvaluationFor")) {
  throw new Error("Widget submit flow must recover pending objective answer drafts before marking them skipped.");
}

if (!html.includes("Objective Results Already Saved")) {
  throw new Error("Widget speaking submit flow must tell the model objective results are already stored.");
}

if (html.includes("skip-skill")) {
  throw new Error("Audio skip controls must not skip an entire skill category.");
}

console.log("widget script parse ok");
