import fs from "node:fs";
import path from "node:path";
import { buildIndex } from "./corpus.js";
import { assertCorpusRoot, resolveConfig, TEST_DOC_NAMES } from "./config.js";
import { buildContextResponse, buildGetResponse } from "./search.js";
import { contextToMarkdown, getToMarkdown } from "./format.js";
import { buildFixtureCorpus } from "./fixture.js";
import type { CorpusConfig, DocChunk } from "./types.js";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "test" && rest.includes("--fixture")) {
    await runFixtureTests();
    return;
  }

  const config = resolveConfig();
  assertCorpusRoot(config);
  const chunks = await buildIndex(config);

  if (command === "dry-run") {
    const stats = summarize(chunks);
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  if (command === "query") {
    const query = rest.join(" ").trim();
    if (!query) throw new Error('Usage: npm run query -- "your query"');
    console.log(JSON.stringify(buildContextResponse(chunks, { query }), null, 2));
    return;
  }

  if (command === "test") {
    runCorpusAssertions(config, chunks);
    const queries = [
      "Create a contact via the API",
      "OAuth scopes for an endpoint",
      "How does the Billing Submission object model work",
      "Which OpenAPI operation searches contacts?",
      "Prepare an agent context packet for a GHL custom object build",
    ];
    for (const query of queries) {
      const response = buildContextResponse(chunks, { query });
      console.log(`${query} -> ${response.namespace} (${response.chunks.length} chunks)`);
    }
    console.log("All local checks passed.");
    return;
  }

  throw new Error("Usage: node dist/cli.js <dry-run|query|test> [--fixture]");
}

function summarize(chunks: DocChunk[]) {
  const byNamespace: Record<string, number> = {};
  const bySourceType: Record<string, number> = {};
  for (const chunk of chunks) {
    byNamespace[chunk.namespace] = (byNamespace[chunk.namespace] ?? 0) + 1;
    bySourceType[chunk.sourceType] = (bySourceType[chunk.sourceType] ?? 0) + 1;
  }

  return {
    corpusRoot: resolveConfig().corpusRoot,
    chunks: chunks.length,
    byNamespace,
    bySourceType,
    objectModelChunks: chunks.filter((chunk) => chunk.relativePath.endsWith("GHL_OBJECT_MODEL.md")).length,
    fieldRegistryCsvChunks: chunks.filter((chunk) =>
      chunk.relativePath.endsWith("private-practice-crm-ghl-architecture-registry.csv"),
    ).length,
    contactsV3SpecChunks: chunks.filter((chunk) => chunk.relativePath.endsWith("apps/v3/contacts-v3.json")).length,
  };
}

/** Assertions that require the real Product/PracticeOS/GHL corpus. */
function runCorpusAssertions(config: CorpusConfig, chunks: DocChunk[]): void {
  assertAgentsSymlink(config.corpusRoot);
  assertNoExcludedArtifacts(chunks);

  const norm = (p: string) => p.replaceAll(path.sep, "/");

  if (!chunks.some((chunk) => norm(chunk.relativePath) === TEST_DOC_NAMES.bigApiSpec)) {
    throw new Error(`Missing chunks for ${TEST_DOC_NAMES.bigApiSpec}.`);
  }
  const contactsSpecChunks = chunks.filter((chunk) => norm(chunk.relativePath) === TEST_DOC_NAMES.bigApiSpec);
  if (contactsSpecChunks.length < 10) {
    throw new Error("contacts-v3.json did not chunk into OpenAPI operations.");
  }
  if (!contactsSpecChunks.some((chunk) => chunk.sourceType === "openapi" && chunk.metadata.operationId)) {
    throw new Error("contacts-v3.json operations are missing operationId metadata.");
  }

  if (!chunks.some((chunk) => norm(chunk.relativePath) === TEST_DOC_NAMES.objectModel)) {
    throw new Error("Missing chunks for the applied GHL object model.");
  }
  const csvChunks = chunks.filter((chunk) => norm(chunk.relativePath) === TEST_DOC_NAMES.fieldRegistryCsv);
  if (!csvChunks.length) {
    throw new Error("Field registry CSV did not chunk into retrievable content.");
  }
  if (!csvChunks.every((chunk) => chunk.namespace === "applied" && chunk.metadata.priority === "high")) {
    throw new Error("Field registry CSV chunks must be applied namespace with high priority.");
  }
}

function assertAgentsSymlink(corpusRoot: string): void {
  const agentsPath = path.join(corpusRoot, "AGENTS.md");
  const stat = fs.lstatSync(agentsPath);
  if (!stat.isSymbolicLink()) {
    throw new Error("GHL corpus AGENTS.md must be a symlink to CLAUDE.md.");
  }

  const linkTarget = fs.readlinkSync(agentsPath);
  if (linkTarget !== "CLAUDE.md") {
    throw new Error(`AGENTS.md symlink target must be CLAUDE.md, got ${linkTarget}`);
  }
}

function assertNoExcludedArtifacts(chunks: DocChunk[]): void {
  if (chunks.some((chunk) => path.basename(chunk.filePath).startsWith("._"))) {
    throw new Error("Index contains AppleDouble sidecar files.");
  }
  if (chunks.some((chunk) => chunk.filePath.includes(`${path.sep}.git${path.sep}`))) {
    throw new Error("Index contains .git internals.");
  }
}

/** Full behavior suite against the synthetic fixture corpus — runs anywhere. */
async function runFixtureTests(): Promise<void> {
  const { config, cleanup } = buildFixtureCorpus();
  let passed = 0;
  const check = (condition: boolean, label: string): void => {
    if (!condition) throw new Error(`Fixture check failed: ${label}`);
    passed += 1;
  };

  try {
    assertCorpusRoot(config);
    const chunks = await buildIndex(config);

    // --- Governance + exclusions ---
    assertAgentsSymlink(config.corpusRoot);
    passed += 1;
    assertNoExcludedArtifacts(chunks);
    passed += 1;
    check(!chunks.some((c) => c.relativePath.endsWith("api-token.md")), "secret-pattern file excluded");
    check(!chunks.some((c) => c.relativePath.endsWith("notes.txt")), "non-md/json file excluded");
    check(!chunks.some((c) => c.relativePath.includes(".git")), ".git contents excluded");

    // --- Corpus-root validation ---
    let corpusError = "";
    try {
      assertCorpusRoot({ ...config, corpusRoot: path.join(config.corpusRoot, "does-not-exist") });
    } catch (error) {
      corpusError = error instanceof Error ? error.message : String(error);
    }
    check(corpusError.includes("GHL_DOCS_CORPUS_ROOT"), "missing corpus root error is actionable");

    // --- Markdown chunking ---
    const bigDoc = chunks.filter((c) => c.relativePath.includes("contacts-guide.md"));
    check(bigDoc.length >= 4, `large markdown splits into multiple chunks (got ${bigDoc.length})`);
    check(bigDoc.some((c) => c.heading.includes("(1/")), "oversized section carries (1/n) heading");

    // --- OpenAPI chunking + $ref resolution ---
    const miniSpec = chunks.filter((c) => c.relativePath.endsWith("mini-contacts.json"));
    check(miniSpec.length === 3, `mini OpenAPI spec chunks per operation (got ${miniSpec.length})`);
    const createContact = miniSpec.find((c) => c.metadata.operationId === "CreateContact");
    check(Boolean(createContact), "operationId metadata present");
    check(
      Boolean(createContact?.text.includes("Custom field value from the contact record")),
      "$ref resolved into operation text",
    );
    check(createContact?.metadata.method === "POST", "method metadata present");
    check(miniSpec.every((c) => c.namespace === "api"), "OpenAPI operations land in the api namespace");

    // --- CSV chunking (field registry) ---
    const csvChunks = chunks.filter((c) => c.relativePath.endsWith(".csv"));
    check(csvChunks.length >= 1, "registry CSV produces chunks");
    check(
      csvChunks.every((c) => c.namespace === "applied" && c.metadata.priority === "high"),
      "CSV chunks are applied + high priority",
    );
    check(
      csvChunks.some((c) => c.text.includes("member_id_snapshot")),
      "CSV chunk text carries the field proposed_key (retrievable)",
    );
    check(
      csvChunks.some((c) => c.text.includes("Generated from CSV, source:")),
      "CSV chunk records its source provenance",
    );

    // --- Namespace routing ---
    const apiResponse = buildContextResponse(chunks, { query: "Create a contact via the API endpoint" });
    check(apiResponse.namespace === "api", "API query routes to api");
    const helpResponse = buildContextResponse(chunks, { query: "How do I build a workflow automation in the app?" });
    check(helpResponse.namespace === "help", "workflow/how-to query routes to help");
    const appliedResponse = buildContextResponse(chunks, {
      query: "Explain the GHL custom object model and field registry",
    });
    check(appliedResponse.namespace === "applied", "object-model query routes to applied");
    const forced = buildContextResponse(chunks, { query: "workflow", namespace: "help" });
    check(forced.namespace === "help", "explicit namespace is honored");

    // --- Applied-context priority (model/schema queries only) ---
    const modelQuery = buildContextResponse(chunks, {
      query: "Explain the GHL custom object model and the contact field schema",
    });
    check(
      modelQuery.chunks[0]?.source_type === "applied-context" && modelQuery.chunks[0]?.metadata.priority === "high",
      "model/schema query surfaces a high-priority applied source first",
    );
    const superbillQuery = buildContextResponse(chunks, { query: "monthly superbill template spec" });
    check(
      superbillQuery.chunks.length > 0 && superbillQuery.chunks[0]?.metadata.priority !== "high",
      "non-model applied query is not topped by the high-priority sources",
    );

    // --- Pagination ---
    const pageOne = buildContextResponse(chunks, { query: "contact request section subscriber", maxChunks: 2 });
    check(pageOne.pagination.count === 2, "max_chunks respected");
    check(pageOne.pagination.has_more, "has_more set when more matches exist");
    check(pageOne.pagination.next_offset === 2, "next_offset advances by page size");
    const pageTwo = buildContextResponse(chunks, {
      query: "contact request section subscriber",
      maxChunks: 2,
      offset: pageOne.pagination.next_offset,
    });
    check(pageTwo.chunks[0]?.id !== pageOne.chunks[0]?.id, "offset returns the next page");
    const pastEnd = buildContextResponse(chunks, { query: "contact request section subscriber", offset: 9999 });
    check(pastEnd.pagination.count === 0 && !pastEnd.pagination.has_more, "offset past end returns empty page");
    check(pastEnd.guidance.includes("offset"), "past-end guidance mentions offset");

    // --- Character-limit truncation ---
    const truncated = buildContextResponse(chunks, {
      query: "contact request section subscriber",
      maxChunks: 12,
      characterLimit: 1_800,
    });
    check(truncated.truncated === true, "tiny character limit triggers truncation");
    check(JSON.stringify(truncated).length <= 1_800, "truncated response respects the limit");
    check(
      Boolean(truncated.truncation_message?.includes("ghl_docs_get")),
      "truncation message points at ghl_docs_get",
    );

    // --- Get by id / path ---
    const targetId = apiResponse.chunks[0]?.id ?? "";
    const byId = buildGetResponse(chunks, { ids: [targetId, "bogus#id"] });
    check(byId.found.length === 1 && byId.found[0].id === targetId, "get by id returns the chunk");
    check(byId.found[0].text.length > 0, "get by id returns full text");
    check(byId.missing.includes("bogus#id"), "unknown id lands in missing");
    const byPath = buildGetResponse(chunks, { path: "Github Repo/highlevel-api-docs/apps/v3/mini-contacts.json" });
    check(byPath.found.length === 3, "get by path returns every chunk of the document");
    const getTruncated = buildGetResponse(chunks, {
      path: "Github Repo/highlevel-api-docs/docs/contacts-guide.md",
      characterLimit: 2_000,
    });
    check(getTruncated.truncated === true, "get response truncates under a tiny limit");
    check(JSON.stringify(getTruncated).length <= 2_000, "truncated get response respects the limit");

    // --- Formatting ---
    const markdown = contextToMarkdown(apiResponse);
    check(markdown.includes(apiResponse.chunks[0].path), "markdown rendering includes source paths");
    check(markdown.includes("offset") || markdown.includes("id:"), "markdown rendering includes chunk metadata");
    const getMarkdown = getToMarkdown(byId);
    check(getMarkdown.includes("Not found"), "get markdown lists missing ids");
    check(Boolean(JSON.parse(JSON.stringify(apiResponse))), "response is JSON-serializable");

    console.log(`Fixture checks passed (${passed} assertions).`);
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
