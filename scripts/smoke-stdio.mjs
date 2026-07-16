#!/usr/bin/env node
/**
 * End-to-end stdio smoke test: boots the built server as a child process
 * against the synthetic fixture corpus and exercises the real MCP wire
 * protocol (initialize -> tools/list -> tools/call), including error paths.
 *
 * Usage: npm run smoke
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");

const { buildFixtureCorpus } = await import(path.join(serverRoot, "dist", "fixture.js"));

let failures = 0;
const pass = (label) => console.log(`PASS ${label}`);
const fail = (label, detail) => {
  failures += 1;
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};
const check = (condition, label, detail) => (condition ? pass(label) : fail(label, detail));

class StdioClient {
  constructor(env) {
    this.child = spawn(process.execPath, [path.join(serverRoot, "dist", "index.js")], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.child.stdout.on("data", (data) => {
      this.buffer += data.toString();
      let newline;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id !== undefined && this.pending.has(message.id)) {
          this.pending.get(message.id)(message);
          this.pending.delete(message.id);
        }
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async start() {
    const init = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.0" },
    });
    this.notify("notifications/initialized", {});
    return init;
  }

  stop() {
    this.child.kill();
  }
}

const fixture = buildFixtureCorpus();

try {
  // --- Happy-path server against the fixture corpus ---
  const client = new StdioClient({ GHL_DOCS_CORPUS_ROOT: fixture.config.corpusRoot });
  const init = await client.start();
  check(init.result?.serverInfo?.name === "ghl_docs_mcp", "initialize returns server name");

  const tools = await client.request("tools/list", {});
  const toolNames = (tools.result?.tools ?? []).map((tool) => tool.name).sort();
  check(
    JSON.stringify(toolNames) === JSON.stringify(["ghl_docs_context", "ghl_docs_get"]),
    "tools/list exposes both tools",
    JSON.stringify(toolNames),
  );
  const contextTool = tools.result.tools.find((tool) => tool.name === "ghl_docs_context");
  check(contextTool?.annotations?.readOnlyHint === true, "context tool advertises readOnlyHint");
  check(contextTool?.annotations?.openWorldHint === false, "context tool advertises openWorldHint=false");
  check(Boolean(contextTool?.outputSchema), "context tool advertises an outputSchema");
  check(Boolean(contextTool?.title), "context tool advertises a title");

  const searchCall = await client.request("tools/call", {
    name: "ghl_docs_context",
    arguments: { query: "Explain the GHL custom object model and the contact field schema" },
  });
  const searchResult = searchCall.result;
  check(searchResult?.isError !== true, "context call succeeds", JSON.stringify(searchResult?.content?.[0]));
  check(Boolean(searchResult?.structuredContent?.chunks?.length), "context call returns structured chunks");
  check(
    searchResult?.structuredContent?.chunks?.[0]?.source_type === "applied-context",
    "model query surfaces applied-context source over the wire",
  );
  check(
    typeof searchResult?.content?.[0]?.text === "string" && searchResult.content[0].text.startsWith("# GHL docs context"),
    "default response_format renders markdown",
  );

  const jsonCall = await client.request("tools/call", {
    name: "ghl_docs_context",
    arguments: { query: "create a contact operation", response_format: "json", max_chunks: 2 },
  });
  let parsedJson;
  try {
    parsedJson = JSON.parse(jsonCall.result?.content?.[0]?.text ?? "");
  } catch {
    parsedJson = undefined;
  }
  check(Boolean(parsedJson?.pagination), "response_format=json returns parseable JSON with pagination");

  const chunkId = searchResult?.structuredContent?.chunks?.[0]?.id;
  const getCall = await client.request("tools/call", {
    name: "ghl_docs_get",
    arguments: { ids: [chunkId], response_format: "json" },
  });
  check(
    getCall.result?.structuredContent?.found?.[0]?.id === chunkId,
    "ghl_docs_get returns the requested chunk over the wire",
  );

  const badGet = await client.request("tools/call", {
    name: "ghl_docs_get",
    arguments: {},
  });
  check(badGet.result?.isError === true, "ghl_docs_get with no args returns isError");
  check(
    (badGet.result?.content?.[0]?.text ?? "").includes("ids"),
    "no-args error message is actionable",
  );

  const invalidInput = await client.request("tools/call", {
    name: "ghl_docs_context",
    arguments: { query: "x" },
  });
  check(
    invalidInput.result?.isError === true || Boolean(invalidInput.error),
    "too-short query is rejected by input validation",
  );

  client.stop();

  // --- Misconfigured server: corpus root missing ---
  const badClient = new StdioClient({ GHL_DOCS_CORPUS_ROOT: "/nonexistent/ghl-corpus" });
  await badClient.start();
  const badCall = await badClient.request("tools/call", {
    name: "ghl_docs_context",
    arguments: { query: "contact" },
  });
  check(badCall.result?.isError === true, "missing corpus root returns isError instead of crashing");
  check(
    (badCall.result?.content?.[0]?.text ?? "").includes("GHL_DOCS_CORPUS_ROOT"),
    "missing corpus root error tells the operator which env var to set",
  );
  badClient.stop();
} finally {
  fixture.cleanup();
}

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed.`);
  process.exit(1);
}
console.log("\nAll stdio smoke checks passed.");
