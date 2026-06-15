import { readFileSync } from "node:fs";

const html = readFileSync("public/lingostar-widget.html", "utf8");
const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);

if (!match) {
  throw new Error("Widget module script not found.");
}

const renderedHtml = [];
const attrs = new Map();
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
  openai: { locale: "ko-KR" },
  matchMedia() {
    return { matches: true };
  },
  addEventListener() {},
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

if (!html.includes("Loading your language learning studio")) {
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

if (html.includes("skip-skill")) {
  throw new Error("Audio skip controls must not skip an entire skill category.");
}

console.log("widget script parse ok");
