const PORT = process.env.PORT || 8793;
process.env.PORT = String(PORT);
process.env.LINGOSTAR_AUTH_REQUIRED = "1";
process.env.OAUTH_ISSUER = "https://auth.example.test";
process.env.OAUTH_AUDIENCE = "https://lingostar.example.test";
process.env.OAUTH_CLIENT_ID = "auth-verify-client";
process.env.OAUTH_SCOPE_MODE = "none";
process.env.APP_ORIGIN = "https://lingostar.example.test";
process.env.CORS_ALLOWED_ORIGINS = "https://lingostar.example.test,https://chatgpt.com";
process.env.WIDGET_CONNECT_DOMAINS = "https://lingostar.example.test";
process.env.WIDGET_RESOURCE_DOMAINS = "https://lingostar.example.test";

await import("../server.js");

let requestId = 0;
const assertions = [];

function assert(label, condition) {
  assertions.push({ label, pass: Boolean(condition) });
  if (!condition) console.error(`FAIL: ${label}`);
}

function toolSecuritySchemes(tool) {
  return tool?.securitySchemes ?? tool?._meta?.securitySchemes ?? [];
}

async function waitForServer() {
  for (let i = 0; i < 20; i += 1) {
    try {
      const response = await fetch(`http://localhost:${PORT}/healthz`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Server did not start.");
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

await waitForServer();

const healthResponse = await fetch(`http://localhost:${PORT}/healthz`);
const health = await healthResponse.json();
assert("scope-none health exposes mode", health.oauthScopeMode === "none");
assert("scope-none health disables advertised scopes", health.oauthScopesAdvertised === false);
assert("scope-none health disables scope enforcement", health.oauthScopesEnforced === false);

const metadataResponse = await fetch(`http://localhost:${PORT}/.well-known/oauth-protected-resource`);
const metadata = await metadataResponse.json();
assert("scope-none metadata resource is APP_ORIGIN", metadata.resource === "https://lingostar.example.test");
assert("scope-none metadata omits scopes_supported", !("scopes_supported" in metadata));
assert("scope-none metadata includes configured client id", metadata.client_id === "auth-verify-client");

await rpc("initialize", {
  protocolVersion: "2026-01-26",
  clientInfo: { name: "lingostar-auth-scope-none-verify", version: "1.0.0" },
  capabilities: {},
});

const toolsResult = await rpc("tools/list", {});
const stateTool = toolsResult.tools.find((tool) => tool.name === "get_lingostar_state");
const manageTool = toolsResult.tools.find((tool) => tool.name === "manage_learning_session");
assert("scope-none get state advertises oauth2", toolSecuritySchemes(stateTool).some((scheme) => scheme.type === "oauth2"));
assert("scope-none get state has empty scope list", toolSecuritySchemes(stateTool).some((scheme) => scheme.type === "oauth2" && Array.isArray(scheme.scopes) && scheme.scopes.length === 0));
assert("scope-none manage has empty scope list", toolSecuritySchemes(manageTool).some((scheme) => scheme.type === "oauth2" && Array.isArray(scheme.scopes) && scheme.scopes.length === 0));

const unauthenticatedCall = await rpc("tools/call", {
  name: "get_lingostar_state",
  arguments: {},
});
const challenge = unauthenticatedCall._meta?.["mcp/www_authenticate"]?.[0] ?? "";
assert("scope-none unauthenticated tool call is an MCP error result", unauthenticatedCall.isError === true);
assert("scope-none challenge includes protected resource metadata", challenge.includes("oauth-protected-resource"));
assert("scope-none challenge does not request OAuth scopes", !challenge.includes("scope="));

const passed = assertions.filter((item) => item.pass).length;
const failed = assertions.length - passed;
console.log(JSON.stringify({
  port: PORT,
  assertions: { total: assertions.length, passed, failed },
  failedTests: assertions.filter((item) => !item.pass).map((item) => item.label),
}, null, 2));

if (failed > 0) {
  console.error(`${failed} assertion(s) failed.`);
  process.exit(1);
}

console.log("All scope-none auth assertions passed.");
process.exit(0);
