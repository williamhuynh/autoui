// End-to-end verification for autoui.html (single-file version).
// Run: npm install --no-save puppeteer && node scripts/verify.mjs
// Test A mocks the Anthropic API at the network layer and checks the full
// pipeline (key entry → transcript → debounce → SSE parse → iframe paint).
// Test B lets the request hit the real api.anthropic.com with a fake OAuth
// token and checks the browser-direct auth path + error surfacing.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8123;

const server = http.createServer((req, res) => {
  const file = path.join(root, req.url === "/" ? "autoui.html" : req.url);
  try {
    res.setHeader("Content-Type", "text/html");
    res.end(fs.readFileSync(file));
  } catch {
    res.statusCode = 404;
    res.end("nope");
  }
});
await new Promise((r) => server.listen(PORT, r));

const MOCK_HTML =
  "<!doctype html><html><head><title>mock</title></head><body><h1>MOCK-OK counter app</h1><button id=b>+1</button></body></html>";

function sseBody() {
  const chunks = MOCK_HTML.match(/.{1,40}/g);
  let out =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock"}}\n\n';
  for (const c of chunks) {
    out += `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: c },
    })}\n\n`;
  }
  out += 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  return out;
}

const waitFor = async (fn, ms = 20000, step = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error("timeout waiting for condition");
};

const browser = await puppeteer.launch({
  headless: true,
  // --ignore-certificate-errors: this CI sandbox MITMs TLS with a proxy CA
  // that Chrome doesn't trust (curl does, via the system store).
  args: ["--no-sandbox", "--ignore-certificate-errors"],
});
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [page console.error]", m.text());
});

let mockApi = true;
let capturedHeaders = null;
await page.setRequestInterception(true);
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers":
    "content-type,anthropic-version,anthropic-beta,anthropic-dangerous-direct-browser-access,x-api-key,authorization",
};
page.on("request", (req) => {
  if (req.url().startsWith("https://api.anthropic.com")) {
    if (req.method() === "OPTIONS" && mockApi) {
      // Browser enforces CORS even on intercepted responses — answer the preflight.
      return req.respond({ status: 204, headers: corsHeaders, body: "" });
    }
    if (req.method() === "POST") capturedHeaders = req.headers();
    if (mockApi) {
      return req.respond({
        status: 200,
        headers: { ...corsHeaders, "content-type": "text/event-stream" },
        body: sseBody(),
      });
    }
  }
  req.continue();
});

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

await page.goto(`http://localhost:${PORT}/autoui.html`);

// ---- Test A: mocked successful generation ----
console.log("\nTest A: mocked Anthropic API (full success pipeline)");
check("key bar shown on first load", await page.$eval("#keybar", (el) => el.classList.contains("show")));

await page.type("#key-input", "sk-ant-api03-mocktest");
await page.click("#key-save");

await page.type("#composer-input", "I need a simple counter app for my warehouse team");
await page.click("#composer button");

const srcdoc = await waitFor(async () => {
  const v = await page.$eval("#preview", (el) => el.getAttribute("srcdoc"));
  return v && v.includes("MOCK-OK") ? v : null;
});
check("prototype painted into iframe from SSE stream", srcdoc.includes("MOCK-OK counter app"));
check("version pill shows v1", (await page.$eval("#version-text", (el) => el.textContent)).startsWith("v1"));
check("request used x-api-key auth", capturedHeaders?.["x-api-key"] === "sk-ant-api03-mocktest");
check(
  "browser-direct header sent",
  capturedHeaders?.["anthropic-dangerous-direct-browser-access"] === "true",
);
const bodyA = JSON.parse(
  await page.evaluate(() => window.__lastBody ?? "null").catch(() => "null"),
);

// ---- Test B: real API, OAuth-style token ----
console.log("\nTest B: real api.anthropic.com with fake OAuth token");
mockApi = false;
capturedHeaders = null;
await page.click("#key-btn");
await page.$eval("#key-input", (el) => (el.value = ""));
await page.type("#key-input", "sk-ant-oat01-fake-for-verification");
await page.click("#key-save");

await page.type("#composer-input", "also add a daily totals chart");
await page.click("#composer button");

const toast = await waitFor(async () => {
  const t = await page.$eval("#toast", (el) =>
    el.style.display !== "none" ? el.textContent : "",
  );
  return t && t.includes("Authentication failed") ? t : null;
}, 30000);
check("real API reached, auth error surfaced in UI", Boolean(toast), toast);
check(
  "request used Authorization: Bearer",
  capturedHeaders?.["authorization"] === "Bearer sk-ant-oat01-fake-for-verification",
);
check("oauth beta header sent", capturedHeaders?.["anthropic-beta"] === "oauth-2025-04-20");

await browser.close();
server.close();

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
