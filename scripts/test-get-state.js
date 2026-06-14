const PORT = process.env.PORT || 8787;
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;

let requestId = 0;

async function rpc(method, params = {}) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
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
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

async function checkState() {
  await rpc("initialize", {
    protocolVersion: "2026-01-26",
    clientInfo: { name: "lingostar-state-check", version: "1.0.0" },
    capabilities: {},
  });

  const result = await rpc("tools/call", {
    name: "get_lingostar_state",
    arguments: {},
    _meta: { "openai/locale": "ko-KR", "openai/subject": "manual-state-check" },
  });

  console.log(JSON.stringify(result.structuredContent?.state, null, 2));
}

checkState().catch((error) => {
  console.error(`Failed to read state from ${MCP_URL}:`, error);
  process.exit(1);
});
