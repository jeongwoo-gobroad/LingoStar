import { spawn } from "node:child_process";

const PORT = process.env.DEVELOPER_MODE_VERIFY_PORT || "8791";
let requestId = 0;

const child = spawn(process.execPath, ["server.js", "--developer-mode"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}: ${stderr}`);
    }
    try {
      const response = await fetch(`http://localhost:${PORT}/`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Developer-mode server did not start.");
}

async function rpc(method, params = {}) {
  const response = await fetch(`http://localhost:${PORT}/mcp`, {
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

function assert(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
}

try {
  await waitForServer();
  await rpc("initialize", {
    protocolVersion: "2026-01-26",
    clientInfo: { name: "lingostar-developer-mode-verify", version: "1.0.0" },
    capabilities: {},
  });

  const firstMeta = { "openai/locale": "ko-KR", "openai/subject": "demo-video-user-a" };
  const secondMeta = { "openai/locale": "ko-KR", "openai/subject": "demo-video-user-b" };

  await rpc("tools/call", {
    name: "manage_learning_session",
    arguments: {
      session: {
        id: "developer-mode-session",
        targetLanguage: "Japanese",
        nativeLanguage: "Korean",
        status: "active",
        goal: { type: "exam", detail: "JLPT N4 demo" },
        settings: {
          displayLanguage: "auto",
          exercisesPerSkill: 5,
          speakingEnabled: true,
          levelMode: "cefr",
        },
        runtime: { speechLang: "ja-JP" },
        levels: [{ id: "developer-mode-level", name: "N4 Demo", status: "active", sections: [] }],
        skillProfile: { speaking: 0, writing: 0, listening: 0, reading: 0 },
        feedbackMemory: [],
        sectionHistory: [],
      },
    },
    _meta: firstMeta,
  });

  const secondStateResult = await rpc("tools/call", {
    name: "get_lingostar_state",
    arguments: {},
    _meta: secondMeta,
  });

  const state = secondStateResult.structuredContent?.state;
  assert("developer mode is exposed in host state", state?.host?.developerMode === true);
  assert("different subjects share one demo store in developer mode", state?.sessions?.some((session) => session.id === "developer-mode-session"));

  console.log(JSON.stringify({ port: PORT, developerModeSharedStore: true }, null, 2));
} finally {
  child.kill();
}
