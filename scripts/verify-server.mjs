const PORT = process.env.PORT || 8790;
process.env.PORT = String(PORT);
process.env.FEEDBACK_ADMIN_ID ||= "verify-admin";
process.env.FEEDBACK_ADMIN_PASSWORD ||= "verify-password";
process.env.OAUTH_REQUIRED = "1";
process.env._AUTH_REQUIRED = "0";

await import("../server.js");

let requestId = 0;

async function waitForServer() {
  for (let i = 0; i < 20; i += 1) {
    try {
      const response = await fetch(`http://localhost:${PORT}/`);
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
        topic: "Japanese kana basics",
        explanation: "Hiragana is a core Japanese phonetic script used for native words and grammar endings.",
        targetExamples: ["あ", "い", "う", "です"],
        question: "Which script is a Japanese phonetic script?",
        choices: [
          { id: "a", text: "Hiragana" },
          { id: "b", text: "Latin alphabet only" },
          { id: "c", text: "Arabic numerals" },
        ],
        correctChoiceId: "a",
        difficultyStage: "foundation",
      },
    };
  }
  if (skill === "speaking") {
    return {
      ...base,
      payload: {
        scenario: "You meet a classmate. Greet them naturally.",
        exampleResponse: "こんにちは。元気ですか。",
        speechLang: "ja-JP",
        skippable: true,
      },
    };
  }
  if (skill === "listening") {
    return {
      ...base,
      payload: {
        audioText: "あきさんは朝、カフェで日本語を勉強します。",
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
  if (skill === "writing") {
    return {
      ...base,
      payload: {
        targetSentence: "カフェで日本語を勉強します。",
        tokens: ["日本語を", "カフェで", "勉強します。"],
        dragMode: "token_reorder",
      },
    };
  }
  return {
    ...base,
    payload: {
      passage: "あきさんは毎朝カフェで日本語を勉強します。午後は短い記事を読みます。",
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

function makeExerciseSet(count = 5) {
  const exercises = [];
  let sequence = 1;
  for (const skill of ["language_info", "speaking", "listening", "writing", "reading"]) {
    for (let i = 0; i < count; i += 1) {
      exercises.push(makeExercise(skill, i, sequence));
      sequence += 1;
    }
  }
  return exercises;
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

await waitForServer();

await rpc("initialize", {
  protocolVersion: "2026-01-26",
  clientInfo: { name: "lingostar-verify", version: "1.0.0" },
  capabilities: {},
});

const meta = { "openai/locale": "ko-KR", "openai/subject": "verify-user-001" };
const otherUserMeta = { "openai/locale": "ko-KR", "openai/subject": "verify-user-002" };
const assertions = [];

const iconResponse = await fetch(`http://localhost:${PORT}/icon.png`);
assert("icon route returns png", iconResponse.ok && iconResponse.headers.get("content-type")?.includes("image/png"));
assert("icon route has bytes", (await iconResponse.arrayBuffer()).byteLength > 0);

const previewResponse = await fetch(`http://localhost:${PORT}/preview`);
const previewHtml = await previewResponse.text();
assert("preview injects absolute icon url", /const ICON_SRC = "https?:\/\/[^"]+\/icon\.png";/.test(previewHtml));
assert("preview does not use relative icon path", !previewHtml.includes('const ICON_SRC = "/icon.png";'));

const healthResponse = await fetch(`http://localhost:${PORT}/healthz`);
const healthJson = await healthResponse.json();
assert("health endpoint is ok", healthResponse.ok && healthJson?.ok === true);
assert("health exposes state store", typeof healthJson?.stateStore === "string");
assert("health exposes AI fallback flag", typeof healthJson?.aiFallbackEnabled === "boolean");
assert("health exposes widget version", healthJson?.widgetVersion === "0.6.2");
assert("health exposes versioned widget uri", healthJson?.widgetUri?.includes("v0-6-2"));
assert("_AUTH_REQUIRED=0 overrides legacy OAUTH_REQUIRED=1", healthJson?.authRequired === false);

const statusResponse = await fetch(`http://localhost:${PORT}/status.json`);
const statusJson = await statusResponse.json();
assert("status diagnostics endpoint is ok", statusResponse.ok && statusJson?.ok === true);
assert("status diagnostics endpoint reports MCP canonical path", statusJson?.mcpEndpoint === "/mcp");

const metadataResponse = await fetch(`http://localhost:${PORT}/.well-known/oauth-protected-resource`);
const metadataJson = await metadataResponse.json();
assert("oauth protected resource metadata has resource", typeof metadataJson?.resource === "string" && metadataJson.resource.length > 0);
assert("oauth protected resource metadata lists scopes", metadataJson?.scopes_supported?.includes("lingostar.read"));

const feedbackUnauthorizedResponse = await fetch(`http://localhost:${PORT}/feedback`);
assert("feedback admin page requires basic auth", feedbackUnauthorizedResponse.status === 401);

const corsResponse = await fetch(`http://localhost:${PORT}/mcp`, {
  method: "OPTIONS",
  headers: {
    Origin: "https://chatgpt.com",
    "Access-Control-Request-Headers": "authorization, content-type",
  },
});
assert("mcp preflight allows authorization header", corsResponse.headers.get("access-control-allow-headers")?.includes("authorization"));
assert("mcp preflight disables proxy buffering", corsResponse.headers.get("x-accel-buffering") === "no");

const rootCorsResponse = await fetch(`http://localhost:${PORT}/`, {
  method: "OPTIONS",
  headers: {
    Origin: "https://chatgpt.com",
    "Access-Control-Request-Headers": "authorization, content-type",
  },
});
assert("root MCP compatibility preflight succeeds", rootCorsResponse.status === 204);
assert("root MCP compatibility preflight disables proxy buffering", rootCorsResponse.headers.get("x-accel-buffering") === "no");

const sseResponse = await fetch(`http://localhost:${PORT}/mcp`, {
  method: "GET",
  headers: { Accept: "text/event-stream" },
});
assert("legacy SSE endpoint opens", sseResponse.ok && sseResponse.headers.get("content-type")?.includes("text/event-stream"));
assert("legacy SSE disables proxy buffering", sseResponse.headers.get("x-accel-buffering") === "no");
await sseResponse.body?.cancel();

const toolsResult = await rpc("tools/list", { _meta: meta });
const toolNames = toolsResult.tools.map((tool) => tool.name);
console.log("Tools:", toolNames.join(", "));

const resourceResult = await rpc("resources/read", {
  uri: "ui://widget/lingostar-studio-v0-6-2.html",
});
const widgetResource = resourceResult.contents?.[0];
assert("widget resource template can be read", widgetResource?.uri === "ui://widget/lingostar-studio-v0-6-2.html");
assert("widget resource has MCP app MIME type", widgetResource?.mimeType?.includes("text/html") && widgetResource?.mimeType?.includes("mcp-app"));
assert("widget resource includes app HTML", widgetResource?.text?.includes("LingoStar"));
assert("widget resource includes CSP metadata", Boolean(widgetResource?._meta?.ui?.csp));

const rootResourceResult = await rpcAt("/", "resources/read", {
  uri: "ui://widget/lingostar-studio-v0-6-2.html",
});
assert("root POST compatibility reads widget resource", rootResourceResult.contents?.[0]?.uri === "ui://widget/lingostar-studio-v0-6-2.html");

const looseAcceptBody = JSON.stringify({
  jsonrpc: "2.0",
  id: ++requestId,
  method: "tools/list",
  params: {},
});
const looseRootAcceptResponse = await fetch(`http://localhost:${PORT}/`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: looseAcceptBody,
});
assert("root POST compatibility tolerates missing Accept header", looseRootAcceptResponse.ok);

const looseMcpAcceptResponse = await fetch(`http://localhost:${PORT}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "*/*" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: ++requestId,
    method: "tools/list",
    params: {},
  }),
});
assert("mcp POST tolerates loose Accept header", looseMcpAcceptResponse.ok);

const looseRootContentTypeResponse = await fetch(`http://localhost:${PORT}/`, {
  method: "POST",
  headers: { Accept: "application/json, text/event-stream" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: ++requestId,
    method: "tools/list",
    params: {},
  }),
});
assert("root POST compatibility tolerates missing JSON content type", looseRootContentTypeResponse.ok);

const looseMcpContentTypeResponse = await fetch(`http://localhost:${PORT}/mcp`, {
  method: "POST",
  headers: {
    Accept: "application/json, text/event-stream",
    "Content-Type": "text/plain",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: ++requestId,
    method: "tools/list",
    params: {},
  }),
});
assert("mcp POST tolerates loose Content-Type header", looseMcpContentTypeResponse.ok);

assert("manage_learning_session tool exists", toolNames.includes("manage_learning_session"));
assert("create_lesson_exercises tool exists", toolNames.includes("create_lesson_exercises"));
assert("grade_section_answers tool exists", toolNames.includes("grade_section_answers"));
assert("store_level_judgment tool exists", toolNames.includes("store_level_judgment"));
assert("store_goal_judgment tool exists", toolNames.includes("store_goal_judgment"));
assert("transcribe_audio tool exists", toolNames.includes("transcribe_audio"));
assert("synthesize_speech tool exists", toolNames.includes("synthesize_speech"));
assert("submit_feedback tool exists", toolNames.includes("submit_feedback"));
assert("get_lingostar_state tool exists", toolNames.includes("get_lingostar_state"));
assert("delete_session tool exists", toolNames.includes("delete_session"));
assert("legacy plan_next_lesson removed", !toolNames.includes("plan_next_lesson"));
assert("legacy synthesize_listening_audio removed", !toolNames.includes("synthesize_listening_audio"));

const manageTool = findTool(toolsResult, "manage_learning_session");
const createTool = findTool(toolsResult, "create_lesson_exercises");
const stateTool = findTool(toolsResult, "get_lingostar_state");

assert("state output schema is described", hasDescription(schemaAt(stateTool?.outputSchema, "state")));
assert("state sessions output is described", hasDescription(schemaAt(stateTool?.outputSchema, "state", "sessions")));
assert("manage session schema is described", hasDescription(schemaAt(manageTool?.inputSchema, "session")));
assert("manage session id is described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "id")));
assert("manage session targetLanguage is described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "targetLanguage")));
assert("manage session status is described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "status")));
assert("manage session goal is described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "goal")));
assert("manage session goal type is described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "goal", "type")));
assert("manage session stage is described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "stage")));
assert("manage session progressContext is described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "progressContext")));
assert("manage session weaknessContext is described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "weaknessContext")));
assert("manage session exerciseCounts is described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "settings", "exerciseCounts")));
assert("manage session pass threshold is described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "settings", "sectionPassThreshold")));
assert("manage session runtime speechLang is described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "runtime", "speechLang")));
assert("manage session skillProfile is described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "skillProfile")));
assert("manage session feedbackMemory is described", hasDescription(schemaAt(manageTool?.inputSchema, "session", "feedbackMemory")));
assert("manage initialSection schema is described", hasDescription(schemaAt(manageTool?.inputSchema, "initialSection")));
assert("default get state tool is noauth", toolSecuritySchemes(stateTool).some((scheme) => scheme.type === "noauth"));
assert("state tool has ChatGPT output template alias", stateTool?._meta?.["openai/outputTemplate"] === healthJson.widgetUri);
assert("state tool allows app-side tool calls", stateTool?._meta?.["openai/widgetAccessible"] === true);
assert("state tool is visible to widget app", stateTool?._meta?.ui?.visibility?.includes("app"));
assert("default manage tool is noauth", toolSecuritySchemes(manageTool).some((scheme) => scheme.type === "noauth"));
assert("create section schema is described", hasDescription(schemaAt(createTool?.inputSchema, "section")));
assert("create section id is described", hasDescription(schemaAt(createTool?.inputSchema, "section", "id")));
assert("create section sessionId is described", hasDescription(schemaAt(createTool?.inputSchema, "section", "sessionId")));
assert("create section levelId is described", hasDescription(schemaAt(createTool?.inputSchema, "section", "levelId")));
assert("create section exercisesPerSkill is described", hasDescription(schemaAt(createTool?.inputSchema, "section", "exercisesPerSkill")));
assert("create section exerciseCounts is described", hasDescription(schemaAt(createTool?.inputSchema, "section", "exerciseCounts")));

const stateResult = await rpc("tools/call", {
  name: "get_lingostar_state",
  arguments: {},
  _meta: meta,
});
const state = stateResult.structuredContent?.state;
assert("state version is 0.6.2", state?.version === "0.6.2");
assert("state has currentSection null", state?.currentSection === null);
assert("interface language resolved to ko", state?.host?.interfaceLanguage === "ko");
assert("state exposes TTS capability", typeof state?.gui?.audio?.openAiTtsModel === "string");
assert("state exposes widget version", state?.gui?.widgetVersion === "0.6.2");
assert("state exposes help content", typeof state?.gui?.help?.title === "string");

const sessionResult = await rpc("tools/call", {
  name: "manage_learning_session",
  arguments: {
    session: {
      id: "session-test0001",
      targetLanguage: "Japanese",
      nativeLanguage: "English",
      status: "active",
      goal: { type: "exam", detail: "JLPT N3" },
      interests: ["anime", "cooking"],
      avoidTopics: [],
      settings: {
        displayLanguage: "auto",
        exercisesPerSkill: 5,
        exerciseCounts: { language_info: 5, listening: 5, reading: 5, writing: 5, speaking: 5 },
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
          name: "A1 - Survival Basics",
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
assert("session preserved goal detail", session?.goal?.detail === "JLPT N3");
assert("session uses per-skill setting", session?.settings?.exercisesPerSkill === 5);
assert("session uses per-area language_info count", session?.settings?.exerciseCounts?.language_info === 5);
assert("session has language_info profile", typeof session?.skillProfile?.language_info === "number");
assert("session infers Japanese speech language when provided or stored", session?.runtime?.speechLang === "ja-JP");

const feedbackResult = await rpc("tools/call", {
  name: "submit_feedback",
  arguments: {
    message: "Verify feedback item",
    screen: "dashboard",
    sessionId: session?.id,
    severity: "test",
  },
  _meta: meta,
});
const feedbackState = feedbackResult.structuredContent?.state;
assert("feedback stored on user state", feedbackState?.feedbackItems?.[0]?.message === "Verify feedback item");

const feedbackAuth = Buffer.from(`${process.env.FEEDBACK_ADMIN_ID}:${process.env.FEEDBACK_ADMIN_PASSWORD}`).toString("base64");
const feedbackPageResponse = await fetch(`http://localhost:${PORT}/feedback?page=1&pageSize=10`, {
  headers: { Authorization: `Basic ${feedbackAuth}` },
});
const feedbackPageHtml = await feedbackPageResponse.text();
assert("feedback admin page renders stored item", feedbackPageResponse.ok && feedbackPageHtml.includes("Verify feedback item"));

const otherUserStateResult = await rpc("tools/call", {
  name: "get_lingostar_state",
  arguments: {},
  _meta: otherUserMeta,
});
const otherUserState = otherUserStateResult.structuredContent?.state;
assert("different subject has isolated sessions", otherUserState?.sessions?.length === 0);

const aliasConversationOnlyMeta = {
  "openai/locale": "ko-KR",
  "openai/conversation_id": "verify-alias-conversation",
};
await rpc("tools/call", {
  name: "get_lingostar_state",
  arguments: {},
  _meta: aliasConversationOnlyMeta,
});
await rpc("tools/call", {
  name: "manage_learning_session",
  arguments: {
    session: {
      id: "session-alias-test",
      targetLanguage: "Spanish",
      nativeLanguage: "English",
      status: "active",
      goal: { type: "conversation", detail: "Travel basics" },
      settings: {
        displayLanguage: "auto",
        exercisesPerSkill: 5,
        exerciseCounts: { language_info: 5, listening: 5, reading: 5, writing: 5, speaking: 5 },
        sectionPassThreshold: 85,
        minSectionsForGoalCompletion: 10,
        ttsRate: 1,
        speakingEnabled: true,
        levelMode: "cefr",
      },
      levels: [{ id: "level-alias-test", name: "A1 basics", status: "active" }],
      skillProfile: { language_info: 0, speaking: 0, writing: 0, listening: 0, reading: 0 },
      feedbackMemory: [],
      sectionHistory: [],
    },
  },
  _meta: {
    ...aliasConversationOnlyMeta,
    "openai/subject": "verify-alias-user",
  },
});
const aliasedStateResult = await rpc("tools/call", {
  name: "get_lingostar_state",
  arguments: {},
  _meta: aliasConversationOnlyMeta,
});
const aliasedState = aliasedStateResult.structuredContent?.state;
assert("conversation-only widget calls resolve to user store after aliasing", aliasedState?.sessions?.some((s) => s.id === "session-alias-test"));

const initialExercises = makeExerciseSet(5);
const initialSectionResult = await rpc("tools/call", {
  name: "manage_learning_session",
  arguments: {
    session: {
      id: "session-initial-section",
      targetLanguage: "Japanese",
      nativeLanguage: "Korean",
      status: "active",
      goal: { type: "exam", detail: "JLPT N4" },
      settings: {
        displayLanguage: "auto",
        exercisesPerSkill: 5,
        exerciseCounts: { language_info: 5, listening: 5, reading: 5, writing: 5, speaking: 5 },
        sectionPassThreshold: 85,
        minSectionsForGoalCompletion: 10,
        ttsRate: 1,
        speakingEnabled: true,
        levelMode: "cefr",
      },
      runtime: { speechLang: "ja-JP" },
      levels: [{ id: "level-initial-section", name: "N4 foundation", status: "active" }],
      skillProfile: { language_info: 0, speaking: 0, writing: 0, listening: 0, reading: 0 },
      feedbackMemory: [],
      sectionHistory: [],
    },
    initialSection: {
      levelId: "level-initial-section",
      title: "Initial N4 Section",
      exercisesPerSkill: 5,
      exercises: initialExercises,
    },
  },
  _meta: { "openai/locale": "ko-KR", "openai/subject": "verify-initial-section-user" },
});
const initialSectionState = initialSectionResult.structuredContent?.state;
assert("manage_learning_session with initialSection opens current section", initialSectionState?.currentSection?.exercises?.length === 25);
assert("manage_learning_session with initialSection switches GUI to lesson", initialSectionState?.gui?.screen === "lesson");

const exercises = makeExerciseSet(5);

const sectionResult = await rpc("tools/call", {
  name: "create_lesson_exercises",
  arguments: {
    section: {
      sessionId: "session-test0001",
      levelId: "level-test0001",
      title: "Test Section",
      exercisesPerSkill: 5,
      exercises,
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
assert("section has 5*n exercises", section?.exercises?.length === 25);
assert("section has n language_info", counts.language_info === 5);
assert("section has n speaking", counts.speaking === 5);
assert("section has n listening", counts.listening === 5);
assert("section has n writing", counts.writing === 5);
assert("section has n reading", counts.reading === 5);
assert(
  "listening choices are 5-way",
  section?.exercises?.filter((exercise) => exercise.type === "listening")
    .every((exercise) => exercise.payload.choices.length === 5)
);

const invalidSectionResult = await rpc("tools/call", {
  name: "create_lesson_exercises",
  arguments: {
    section: {
      sessionId: "session-test0001",
      title: "Invalid Section",
      exercisesPerSkill: 5,
      exercises: exercises.slice(0, 10),
    },
  },
  _meta: meta,
});
const invalidText = invalidSectionResult.content?.[0]?.text ?? "";
assert("invalid section is rejected", invalidText.includes("섹션 구조") || invalidText.includes("Invalid section"));

const gradingResult = await rpc("tools/call", {
  name: "grade_section_answers",
  arguments: {
    sessionId: "session-test0001",
    sectionId: section?.id,
    evaluations: [
      {
        exerciseId: "ex-writing-1",
        score: 80,
        skill: "writing",
        needsReview: false,
        feedback: { short: "Good.", detail: "Solid sentence order." },
      },
      {
        exerciseId: "ex-reading-1",
        score: 30,
        skill: "reading",
        needsReview: true,
        feedback: { short: "Review needed.", detail: "Choice mismatch." },
      },
      {
        exerciseId: "ex-speaking-1",
        score: 0,
        skill: "speaking",
        skipped: true,
        needsReview: true,
        feedback: { short: "Skipped.", detail: "Review later." },
      },
    ],
    sectionFeedback: "Good start.",
  },
  _meta: meta,
});
const afterGrading = gradingResult.structuredContent?.state;
assert("results stored", afterGrading?.currentSection?.results?.length === 3);
assert("review exercise generated", afterGrading?.currentSection?.reviewExercises?.length === 2);
const writingScore = afterGrading?.sessions?.[0]?.skillProfile?.writing;
assert("0-100 score scale is respected", writingScore > 5 && writingScore < 20);
assert("skipped exercise does not lower profile", afterGrading?.sessions?.[0]?.skillProfile?.speaking === 5);

const goalJudgmentResult = await rpc("tools/call", {
  name: "store_goal_judgment",
  arguments: {
    sessionId: "session-test0001",
    isGoalAchieved: true,
    standardUsed: "JLPT N3",
    reason: "Verification test judgment before the minimum section threshold.",
    nextGoalSuggestion: "Move toward JLPT N2.",
  },
  _meta: meta,
});
const afterGoalJudgment = goalJudgmentResult.structuredContent?.state;
const judgedSession = afterGoalJudgment?.sessions?.find((item) => item.id === "session-test0001");
assert("goal judgment is stored", judgedSession?.goal?.lastJudgment?.standardUsed === "JLPT N3");
assert("goal is not completed before minimum sections", judgedSession?.goal?.status === "active");

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
