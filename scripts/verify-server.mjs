const PORT = process.env.PORT || 8790;
process.env.PORT = String(PORT);
process.env.FEEDBACK_ADMIN_ID ||= "verify-admin";
process.env.FEEDBACK_ADMIN_PASSWORD ||= "verify-password";
process.env.OAUTH_REQUIRED = "1";
process.env._AUTH_REQUIRED = "0";

await import("../server.js");

let requestId = 0;
const assertions = [];

const EXPECTED_VERSION = "0.10.1";
const EXPECTED_WIDGET_URIS = {
  welcome: "ui://widget/lingostar-welcome-v0-10-1.html",
  sessionSelect: "ui://widget/lingostar-session-select-v0-10-1.html",
  lesson: "ui://widget/lingostar-lesson-v0-10-1.html",
};
const DEFAULT_VIEW_BY_RESOURCE = {
  welcome: "welcome",
  sessionSelect: "select",
  lesson: "lesson",
};

async function waitForServer() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const response = await fetch(`http://localhost:${PORT}/healthz`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Server did not start.");
}

async function rpcAt(path, method, params = {}) {
  const response = await fetch(`http://localhost:${PORT}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++requestId,
      method,
      params,
    }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  if (data.error) {
    throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  }
  return data.result;
}

async function rpc(method, params = {}) {
  return rpcAt("/mcp", method, params);
}

function assert(label, condition) {
  assertions.push({ label, pass: Boolean(condition) });
  if (!condition) console.error(`FAIL: ${label}`);
}

function findTool(toolsResult, name) {
  return toolsResult.tools.find((tool) => tool.name === name);
}

function schemaAt(schema, ...path) {
  let node = schema;
  for (const segment of path) {
    if (!node) return null;
    if (segment === "items") {
      node = node.items;
    } else if (segment === "anyOf" || segment === "oneOf" || segment === "allOf") {
      node = node[segment]?.[0];
    } else {
      node = node.properties?.[segment];
    }
  }
  return node ?? null;
}

function hasDescription(node) {
  return typeof node?.description === "string" && node.description.trim().length >= 12;
}

function toolSecuritySchemes(tool) {
  return tool?.securitySchemes ?? tool?._meta?.securitySchemes ?? [];
}

function makeExercise(skill, index, sequence) {
  const base = {
    id: `ex-${skill}-${index + 1}`,
    type: skill,
    skill,
    sequence,
    prompt: `Test ${skill} prompt ${index + 1}`,
    instructions: `Test ${skill} instructions`,
  };
  if (skill === "language_info") {
    return {
      ...base,
      payload: {
        topic: "Japanese particles",
        explanation: "The particle de can mark where an action happens.",
        targetExamples: ["toshokan de benkyo shimasu"],
        question: "Which particle marks the place where an action happens?",
        choices: [
          { id: "a", text: "de" },
          { id: "b", text: "ka" },
          { id: "c", text: "mo" },
        ],
        correctChoiceId: "a",
        difficultyStage: "foundation",
      },
    };
  }
  if (skill === "listening") {
    return {
      ...base,
      payload: {
        audioText: "Aki studies at the cafe in the morning.",
        speechLang: "ja-JP",
        question: "Where does Aki study in the morning?",
        choices: [
          { id: "a", text: "Cafe" },
          { id: "b", text: "Library" },
          { id: "c", text: "Station" },
          { id: "d", text: "Park" },
          { id: "e", text: "Office" },
        ],
        correctChoiceId: "a",
        expectedKeywords: ["cafe"],
      },
    };
  }
  if (skill === "reading") {
    return {
      ...base,
      payload: {
        passage: "Aki reads a short article in the afternoon.",
        question: "What does Aki read in the afternoon?",
        choices: [
          { id: "a", text: "A short article" },
          { id: "b", text: "A menu" },
          { id: "c", text: "A ticket" },
        ],
        correctChoiceId: "a",
      },
    };
  }
  if (skill === "writing") {
    return {
      ...base,
      payload: {
        targetSentence: "Aki studies at the library.",
        tokens: ["at the library", "Aki", "studies"],
        dragMode: "token_reorder",
      },
    };
  }
  return {
    ...base,
    payload: {
      scenario: "Greet a classmate naturally.",
      exampleResponse: "Hello, nice to meet you.",
      speechLang: "ja-JP",
      skippable: true,
    },
  };
}

function makeExerciseSet(count = 3, includeSpeaking = true) {
  const skills = ["language_info", "listening", "reading", "writing"];
  if (includeSpeaking) skills.push("speaking");
  const exercises = [];
  let sequence = 1;
  for (const skill of skills) {
    for (let i = 0; i < count; i += 1) {
      exercises.push(makeExercise(skill, i, sequence));
      sequence += 1;
    }
  }
  return exercises;
}

await waitForServer();

await rpc("initialize", {
  protocolVersion: "2026-01-26",
  clientInfo: { name: "lingostar-verify", version: "1.0.0" },
  capabilities: {},
});

const meta = { "openai/locale": "ko-KR", "openai/subject": "verify-user-001" };
const otherUserMeta = { "openai/locale": "ko-KR", "openai/subject": "verify-user-002" };

const iconResponse = await fetch(`http://localhost:${PORT}/icon.png`);
assert("icon route returns png", iconResponse.ok && iconResponse.headers.get("content-type")?.includes("image/png"));
assert("icon route has bytes", (await iconResponse.arrayBuffer()).byteLength > 0);

const previewResponse = await fetch(`http://localhost:${PORT}/preview`);
const previewHtml = await previewResponse.text();
assert("preview injects absolute icon url", /const ICON_SRC = "https?:\/\/[^"]+\/icon\.png";/.test(previewHtml));
assert("preview injects UI copy", previewHtml.includes("const UI_COPY = typeof"));
assert("preview uses welcome default view", previewHtml.includes('const DEFAULT_VIEW = "welcome"'));

const healthResponse = await fetch(`http://localhost:${PORT}/healthz`);
const healthJson = await healthResponse.json();
assert("health endpoint is ok", healthResponse.ok && healthJson?.ok === true);
assert("health exposes widget version", healthJson?.widgetVersion === EXPECTED_VERSION);
assert("health exposes default lesson widget uri", healthJson?.widgetUri === EXPECTED_WIDGET_URIS.lesson);
assert("health exposes welcome widget uri", healthJson?.widgetUris?.welcome === EXPECTED_WIDGET_URIS.welcome);
assert("health exposes session select widget uri", healthJson?.widgetUris?.sessionSelect === EXPECTED_WIDGET_URIS.sessionSelect);
assert("health exposes lesson widget uri", healthJson?.widgetUris?.lesson === EXPECTED_WIDGET_URIS.lesson);
assert("_AUTH_REQUIRED=0 overrides legacy OAUTH_REQUIRED=1", healthJson?.authRequired === false);

const homeResponse = await fetch(`http://localhost:${PORT}/`);
const homeHtml = await homeResponse.text();
assert("home page is static help entry", homeResponse.ok && homeHtml.includes("public help entry point"));
assert("home page does not expose web session creation", !homeHtml.includes("/api/session") && !homeHtml.includes("New session"));
assert("home page does not expose OAuth implementation text", !homeHtml.includes("Auth0") && !homeHtml.includes("oauthClientId"));

const disabledWebStateResponse = await fetch(`http://localhost:${PORT}/api/state`);
assert("web state API is disabled", disabledWebStateResponse.status === 410);
const disabledWebSessionResponse = await fetch(`http://localhost:${PORT}/api/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
assert("web session creation API is disabled", disabledWebSessionResponse.status === 410);

const toolsResult = await rpc("tools/list", { _meta: meta });
const toolNames = toolsResult.tools.map((tool) => tool.name);
console.log("Tools:", toolNames.join(", "));

for (const [viewName, uri] of Object.entries(EXPECTED_WIDGET_URIS)) {
  const resourceResult = await rpc("resources/read", { uri });
  const widgetResource = resourceResult.contents?.[0];
  const expectedDefault = DEFAULT_VIEW_BY_RESOURCE[viewName];
  assert(`${viewName} widget resource can be read`, widgetResource?.uri === uri);
  assert(`${viewName} widget resource has MCP app MIME type`, widgetResource?.mimeType?.includes("text/html") && widgetResource?.mimeType?.includes("mcp-app"));
  assert(`${viewName} widget resource includes default view`, widgetResource?.text?.includes(`const DEFAULT_VIEW = "${expectedDefault}"`));
  assert(`${viewName} widget resource includes UI copy`, widgetResource?.text?.includes("const UI_COPY = typeof"));
  assert(`${viewName} widget resource includes CSP metadata`, Boolean(widgetResource?._meta?.ui?.csp));
}

const rootResourceResult = await rpcAt("/", "resources/read", { uri: EXPECTED_WIDGET_URIS.lesson });
assert("root POST compatibility reads widget resource", rootResourceResult.contents?.[0]?.uri === EXPECTED_WIDGET_URIS.lesson);

assert("open_lingostar_app render tool exists", toolNames.includes("open_lingostar_app"));
assert("open_lingostar_session_select render tool exists", toolNames.includes("open_lingostar_session_select"));
assert("open_lingostar_lesson render tool exists", toolNames.includes("open_lingostar_lesson"));
assert("old dashboard render tool is removed", !toolNames.includes("open_lingostar_dashboard"));
assert("old settings render tool is removed", !toolNames.includes("open_lingostar_settings"));
assert("get_lingostar_state tool exists", toolNames.includes("get_lingostar_state"));
assert("manage_learning_session tool exists", toolNames.includes("manage_learning_session"));
assert("update_lingostar_settings tool exists", toolNames.includes("update_lingostar_settings"));
assert("create_lesson_exercises tool exists", toolNames.includes("create_lesson_exercises"));
assert("grade_section_answers tool exists", toolNames.includes("grade_section_answers"));
assert("select_learning_session tool exists", toolNames.includes("select_learning_session"));
assert("delete_session tool exists", toolNames.includes("delete_session"));

const openTool = findTool(toolsResult, "open_lingostar_app");
const selectRenderTool = findTool(toolsResult, "open_lingostar_session_select");
const lessonRenderTool = findTool(toolsResult, "open_lingostar_lesson");
const stateTool = findTool(toolsResult, "get_lingostar_state");
const manageTool = findTool(toolsResult, "manage_learning_session");
const settingsTool = findTool(toolsResult, "update_lingostar_settings");
const createTool = findTool(toolsResult, "create_lesson_exercises");
const gradeTool = findTool(toolsResult, "grade_section_answers");
const deleteTool = findTool(toolsResult, "delete_session");
const selectTool = findTool(toolsResult, "select_learning_session");

assert("open app uses welcome template", openTool?._meta?.["openai/outputTemplate"] === EXPECTED_WIDGET_URIS.welcome);
assert("session select uses select template", selectRenderTool?._meta?.["openai/outputTemplate"] === EXPECTED_WIDGET_URIS.sessionSelect);
assert("lesson render uses lesson template", lessonRenderTool?._meta?.["openai/outputTemplate"] === EXPECTED_WIDGET_URIS.lesson);
assert("render tools allow app-side calls", openTool?._meta?.["openai/widgetAccessible"] === true);
assert("state output schema is described", hasDescription(schemaAt(stateTool?.outputSchema, "state")));
assert("state tool is data-only without output template", !stateTool?._meta?.["openai/outputTemplate"]);
assert("state tool is visible to widget app", stateTool?._meta?.ui?.visibility?.includes("app"));
assert("default state tool is noauth", toolSecuritySchemes(stateTool).some((scheme) => scheme.type === "noauth"));
assert("manage session targetLanguage is described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "targetLanguage")));
assert("manage session settings are described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "settings")));
assert("select targetLanguage is described", hasDescription(schemaAt(selectTool?.inputSchema, "targetLanguage")));
assert("settings patch target languages are described", hasDescription(schemaAt(settingsTool?.inputSchema, "targetLanguage")));
assert("settings patch object is described", hasDescription(schemaAt(settingsTool?.inputSchema, "patch")));
assert("delete targetLanguage is described", hasDescription(schemaAt(deleteTool?.inputSchema, "targetLanguage")));
assert("grade evaluations userAnswer is described", hasDescription(schemaAt(gradeTool?.inputSchema, "evaluations", "items", "userAnswer")));

const stateResult = await rpc("tools/call", {
  name: "get_lingostar_state",
  arguments: {},
  _meta: meta,
});
const initialState = stateResult.structuredContent?.state;
assert("state version is 0.10.1", initialState?.version === EXPECTED_VERSION);
assert("initial state opens welcome", stateResult.structuredContent?.initialView === "welcome");
assert("interface language resolved to ko", initialState?.host?.interfaceLanguage === "ko");
assert("state exposes UI copy", initialState?.gui?.uiCopy?.welcomeTitle);

const sessionResult = await rpc("tools/call", {
  name: "manage_learning_session",
  arguments: {
    session: {
      id: "session-test0001",
      targetLanguage: "Japanese",
      nativeLanguage: "Korean",
      status: "active",
      goal: { type: "exam", detail: "JLPT N4" },
      progressContext: "New learner preparing for JLPT N4.",
      weaknessContext: "Needs particles and sentence order practice.",
      interests: ["travel", "school"],
      avoidTopics: [],
      settings: {
        displayLanguage: "auto",
        exercisesPerSkill: 3,
        exerciseCounts: { language_info: 3, listening: 3, reading: 3, writing: 3, speaking: 3 },
        sectionPassThreshold: 85,
        minSectionsForGoalCompletion: 10,
        ttsRate: 1,
        speakingEnabled: true,
        levelMode: "cefr",
      },
      runtime: { speechLang: "ja-JP" },
      levels: [
        {
          id: "level-test0001",
          name: "N4 foundation",
          cefr: "A1",
          status: "active",
          sections: [],
          completionJudgment: null,
          createdAt: new Date().toISOString(),
        },
      ],
      skillProfile: { language_info: 5, speaking: 5, writing: 5, listening: 5, reading: 5 },
      feedbackMemory: [],
      sectionHistory: [],
    },
  },
  _meta: meta,
});
const afterSession = sessionResult.structuredContent?.state;
const session = afterSession?.sessions?.[0];
assert("session stored", afterSession?.sessions?.length === 1);
assert("session select view after creating session without section", sessionResult.structuredContent?.initialView === "select");
assert("session preserved goal detail", session?.goal?.detail === "JLPT N4");
assert("session uses per-area language_info count", session?.settings?.exerciseCounts?.language_info === 3);

const settingsResult = await rpc("tools/call", {
  name: "update_lingostar_settings",
  arguments: {
    targetLanguage: "Japanese",
    patch: {
      settings: {
        speakingEnabled: false,
        exerciseCounts: { language_info: 4, listening: 3, reading: 3, writing: 4, speaking: 3 },
        ttsRate: 0.9,
      },
      progressContext: "Conversational settings update was applied.",
    },
  },
  _meta: meta,
});
const afterSettings = settingsResult.structuredContent?.state;
const updatedSession = afterSettings?.sessions?.find((item) => item.id === session?.id);
assert("conversational settings update toggles speaking", updatedSession?.settings?.speakingEnabled === false);
assert("conversational settings update changes writing count", updatedSession?.settings?.exerciseCounts?.writing === 4);
assert("conversational settings update preserves target language", updatedSession?.targetLanguage === "Japanese");

const otherUserStateResult = await rpc("tools/call", {
  name: "get_lingostar_state",
  arguments: {},
  _meta: otherUserMeta,
});
assert("different subject has isolated sessions", otherUserStateResult.structuredContent?.state?.sessions?.length === 0);

const crossUserSelectResult = await rpc("tools/call", {
  name: "select_learning_session",
  arguments: { sessionId: session?.id },
  _meta: otherUserMeta,
});
assert("different subject cannot select another user's session", crossUserSelectResult.isError === true);

const crossUserDeleteResult = await rpc("tools/call", {
  name: "delete_session",
  arguments: { sessionId: session?.id },
  _meta: otherUserMeta,
});
assert("different subject cannot delete another user's session", crossUserDeleteResult.isError === true);

const selectResult = await rpc("tools/call", {
  name: "select_learning_session",
  arguments: { targetLanguage: "Japanese" },
  _meta: meta,
});
assert("select learning track succeeds", selectResult.structuredContent?.state?.activeSessionId === session?.id);

const sectionResult = await rpc("tools/call", {
  name: "create_lesson_exercises",
  arguments: {
    section: {
      sessionId: session?.id,
      levelId: "level-test0001",
      title: "Test Section",
      exercisesPerSkill: 3,
      exerciseCounts: { language_info: 3, listening: 3, reading: 3, writing: 3 },
      exercises: makeExerciseSet(3, false),
    },
  },
  _meta: meta,
});
const afterSection = sectionResult.structuredContent?.state;
const section = afterSection?.currentSection;
const counts = (section?.exercises ?? []).reduce((acc, exercise) => {
  acc[exercise.skill] = (acc[exercise.skill] ?? 0) + 1;
  return acc;
}, {});
assert("section stored", section !== null);
assert("create_lesson_exercises returns lesson initial view", sectionResult.structuredContent?.initialView === "lesson");
assert("section excludes speaking when speaking is disabled", !("speaking" in counts));
assert("section has 3 language_info", counts.language_info === 3);
assert("section has 3 writing", counts.writing === 3);

const gradingResult = await rpc("tools/call", {
  name: "grade_section_answers",
  arguments: {
    sessionId: session?.id,
    sectionId: section?.id,
    evaluations: [
      { exerciseId: "ex-language_info-1", score: 100, skill: "language_info", needsReview: false, userAnswer: "a", feedback: { short: "Correct.", detail: "Good." } },
      { exerciseId: "ex-listening-1", score: 100, skill: "listening", needsReview: false, userAnswer: "a", feedback: { short: "Correct.", detail: "Good." } },
      { exerciseId: "ex-reading-1", score: 100, skill: "reading", needsReview: false, userAnswer: "a", feedback: { short: "Correct.", detail: "Good." } },
      { exerciseId: "ex-writing-1", score: 90, skill: "writing", needsReview: false, userAnswer: "Aki studies at the library.", feedback: { short: "Good.", detail: "Solid order." } },
    ],
    sectionFeedback: "Verification grading.",
  },
  _meta: meta,
});
const afterGrading = gradingResult.structuredContent?.state;
assert("results stored", afterGrading?.currentSection?.results?.length === 4);
assert("profile updated on 0-100 grading", afterGrading?.sessions?.[0]?.skillProfile?.writing > 5);

const deleteByLanguageResult = await rpc("tools/call", {
  name: "delete_session",
  arguments: { targetLanguage: "Japanese" },
  _meta: meta,
});
assert("delete by target language succeeds", deleteByLanguageResult.isError !== true);
assert("deleted session removed from user's state", deleteByLanguageResult.structuredContent?.state?.sessions?.length === 0);
assert("delete returns welcome view after final session", deleteByLanguageResult.structuredContent?.initialView === "welcome");

await rpc("tools/call", {
  name: "manage_learning_session",
  arguments: {
    session: {
      id: "session-delete-all-a",
      targetLanguage: "Spanish",
      nativeLanguage: "Korean",
      status: "active",
      goal: { type: "conversation", detail: "Travel basics" },
      settings: { displayLanguage: "auto", exercisesPerSkill: 3, speakingEnabled: false, levelMode: "cefr" },
      levels: [{ id: "level-delete-all-a", name: "A1 basics", status: "active" }],
      skillProfile: { language_info: 0, speaking: 0, writing: 0, listening: 0, reading: 0 },
      feedbackMemory: [],
      sectionHistory: [],
    },
  },
  _meta: meta,
});
await rpc("tools/call", {
  name: "manage_learning_session",
  arguments: {
    session: {
      id: "session-delete-all-b",
      targetLanguage: "French",
      nativeLanguage: "Korean",
      status: "active",
      goal: { type: "conversation", detail: "Cafe basics" },
      settings: { displayLanguage: "auto", exercisesPerSkill: 3, speakingEnabled: false, levelMode: "cefr" },
      levels: [{ id: "level-delete-all-b", name: "A1 basics", status: "active" }],
      skillProfile: { language_info: 0, speaking: 0, writing: 0, listening: 0, reading: 0 },
      feedbackMemory: [],
      sectionHistory: [],
    },
  },
  _meta: meta,
});
const deleteAllResult = await rpc("tools/call", {
  name: "delete_session",
  arguments: { deleteAll: true },
  _meta: meta,
});
assert("delete all succeeds", deleteAllResult.isError !== true);
assert("delete all removes every user session", deleteAllResult.structuredContent?.state?.sessions?.length === 0);

const passed = assertions.filter((item) => item.pass).length;
const failed = assertions.filter((item) => !item.pass).length;
console.log(JSON.stringify({
  port: PORT,
  toolCount: toolNames.length,
  assertions: { total: assertions.length, passed, failed },
  failedTests: assertions.filter((item) => !item.pass).map((item) => item.label),
}, null, 2));

if (failed > 0) {
  console.error(`${failed} assertion(s) failed.`);
  process.exit(1);
}

console.log("All assertions passed.");
process.exit(0);
