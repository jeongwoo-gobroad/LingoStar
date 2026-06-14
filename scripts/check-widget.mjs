import { readFileSync } from "node:fs";

const html = readFileSync("public/lingostar-widget.html", "utf8");
const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);

if (!match) {
  throw new Error("Widget module script not found.");
}

new Function(match[1]);

if (!html.includes('const ICON_SRC = "__LINGOSTAR_ICON__";')) {
  throw new Error("Widget icon must be injected by the server as an absolute URL.");
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

console.log("widget script parse ok");
