import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tiny .env loader so no dotenv dependency is needed.
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const MODEL = process.env.AUTOUI_MODEL || "claude-fable-5";
const EFFORT = process.env.AUTOUI_EFFORT || "medium";
const PORT = Number(process.env.PORT || 3000);

function makeClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const oauthToken =
    process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
  if (apiKey) {
    return new Anthropic({ apiKey });
  }
  if (oauthToken) {
    // OAuth tokens (e.g. from `claude setup-token`) go on Authorization: Bearer
    // and require the oauth beta header on /v1/messages.
    return new Anthropic({
      apiKey: null,
      authToken: oauthToken,
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    });
  }
  return null;
}

const client = makeClient();
// A Claude Code OAuth token (sk-ant-oat01-…) is gated: the API only accepts
// requests whose system prompt leads with the Claude Code identity line —
// otherwise it returns a misleading rate_limit_error. API keys have no such
// requirement. Detect which one we're using so we can prepend it when needed.
const usingOAuth = Boolean(
  !process.env.ANTHROPIC_API_KEY &&
    (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN),
);
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

if (!client) {
  console.warn(
    "\n⚠️  No credentials found. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN " +
      "(run `claude setup-token` to mint one) in the environment or a .env file.\n" +
      "The UI will load, but builds will fail until a credential is provided.\n",
  );
}

const SYSTEM_PROMPT = `You are an elite product engineer sitting in on a live call. A transcript of the conversation is being streamed to you. Your job is to build, in real time, a working single-file HTML prototype of the product or feature the people on the call are describing — so that by the end of the call there is a polished, demoable artifact.

Output rules (strict):
- Output ONLY a complete HTML document. Start with <!doctype html> and end with </html>.
- No markdown, no code fences, no commentary, no explanation before or after the HTML.
- Everything inline: CSS in a <style> tag, JavaScript in a <script> tag. No external network requests, no CDN links, no external fonts or images (use system font stacks, CSS gradients, inline SVG, and emoji where visuals are needed).
- The prototype must be interactive and feel real: working buttons, tabs, forms, state changes, and realistic domain-appropriate sample data. Never use lorem ipsum or "TODO" placeholders.

Behavior rules:
- When given a previous version of the prototype, EVOLVE it: preserve the existing structure, design, and data, and apply only what the new parts of the transcript imply. Do not rebuild from scratch unless the conversation clearly pivots to a different product.
- The transcript is messy, conversational speech. Extract the product intent: features people wish they had, workflows they describe, complaints about current tools. Ignore small talk.
- Where the transcript is vague, make confident, reasonable product decisions rather than leaving gaps. You are the designer in the room.
- Match the design to the domain (an HVAC quoting tool should not look like a crypto dashboard). NEVER use generic AI-generated aesthetics: no overused font stacks presented as branding, no cliched purple-gradient-on-dark schemes, no cookie-cutter layouts. Use a cohesive, characterful palette and typography appropriate to the product, with small touches of motion and micro-interaction.`;

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: MODEL, hasCredentials: Boolean(client) });
});

app.post("/api/build", async (req, res) => {
  const { transcript, currentHtml } = req.body ?? {};

  if (!client) {
    return res.status(503).json({
      error:
        "No Anthropic credentials configured. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN and restart the server.",
    });
  }
  if (!transcript || !transcript.trim()) {
    return res.status(400).json({ error: "Transcript is empty." });
  }

  const parts = [];
  if (currentHtml && currentHtml.trim()) {
    parts.push(
      `Current version of the prototype:\n\n<current_prototype>\n${currentHtml}\n</current_prototype>`,
    );
  }
  parts.push(
    `Full transcript of the call so far (most recent speech at the end):\n\n<transcript>\n${transcript}\n</transcript>`,
  );
  parts.push(
    currentHtml && currentHtml.trim()
      ? "Update the prototype to reflect everything in the transcript, evolving the current version. Output the complete updated HTML document only."
      : "Create the first version of the prototype from this transcript. Output the complete HTML document only.",
  );

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 48000,
      output_config: { effort: EFFORT },
      system: usingOAuth
        ? [
            { type: "text", text: CLAUDE_CODE_IDENTITY },
            { type: "text", text: SYSTEM_PROMPT },
          ]
        : [{ type: "text", text: SYSTEM_PROMPT }],
      messages: [{ role: "user", content: parts.join("\n\n") }],
    });

    // Abort the model call only if the client disconnects mid-stream.
    res.on("close", () => {
      if (!res.writableEnded) stream.abort();
    });

    stream.on("text", (delta) => send({ type: "delta", text: delta }));

    const final = await stream.finalMessage();
    send({
      type: "done",
      stopReason: final.stop_reason,
      usage: {
        input: final.usage.input_tokens,
        output: final.usage.output_tokens,
      },
    });
  } catch (err) {
    if (err?.name === "APIUserAbortError") {
      // Client went away mid-build; nothing to report.
    } else {
      console.error("Build failed:", err);
      send({ type: "error", message: err?.message || "Build failed." });
    }
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`autoui running → http://localhost:${PORT}  (model: ${MODEL}, effort: ${EFFORT})`);
});
