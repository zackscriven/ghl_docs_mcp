import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppliedSource, CorpusConfig, RoutedNamespace } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* --------------------------------------------------------------------------
 * CORPUS-SPECIFIC CONFIGURATION
 *
 * Every value that is specific to the GoHighLevel corpus lives in this module:
 * root derivation, namespace path routing, query routing keywords, the
 * applied-context source paths, the applied priority-boost pattern, and the
 * test doc names. The indexer (corpus.ts) and ranker (search.ts) read from
 * here and contain no GHL-specific literals, so folding this server into a
 * single corpus-agnostic engine later is a matter of swapping this file.
 * ------------------------------------------------------------------------ */

/** Corpus subfolder (relative to corpus root) that holds the cloned GHL API docs repo. */
export const API_REPO_PREFIX = "Github Repo/highlevel-api-docs/";

/** Corpus subfolder that holds selectively-scraped help-center articles. */
export const HELP_PREFIX = "Help Reference/";

/**
 * Path-prefix → namespace routing for files physically inside the corpus root.
 * First matching prefix wins; anything unmatched falls back to DEFAULT_NAMESPACE.
 */
export const ROUTE_PREFIXES: Array<{ prefix: string; namespace: RoutedNamespace }> = [
  { prefix: API_REPO_PREFIX, namespace: "api" },
  { prefix: HELP_PREFIX, namespace: "help" },
];

/** Namespace used when nothing else matches (the authoritative API docs). */
export const DEFAULT_NAMESPACE: RoutedNamespace = "api";

/**
 * `.json` files under this in-corpus prefix are treated as OpenAPI specs and
 * chunked by operation. Everything else is chunked as markdown (or skipped).
 */
export const OPENAPI_PATH_PREFIX = `${API_REPO_PREFIX}apps`;

/** Query → namespace routing keywords. Highest keyword-hit count wins. */
export const ROUTING_KEYWORDS: Record<RoutedNamespace, string[]> = {
  api: [
    "api",
    "endpoint",
    "oauth",
    "scope",
    "scopes",
    "token",
    "access token",
    "refresh token",
    "webhook",
    "request body",
    "response",
    "payload",
    "rest",
    "location id",
    "bearer",
    "rate limit",
    "pagination",
    "operationid",
    "v2",
    "v3",
    "curl",
  ],
  help: [
    "workflow",
    "funnel",
    "calendar",
    "form builder",
    "survey",
    "snapshot",
    "custom value",
    "merge field",
    "agent studio",
    "trigger",
    "campaign",
    "smart list",
    "membership",
    "course",
    "how do i",
    "help center",
    "in the app",
    "automation",
  ],
  applied: [
    "object model",
    "custom object",
    "custom field",
    "field registry",
    "registry",
    "billing submission",
    "contact-as-patient",
    "patient",
    "insurance",
    "insurer",
    "superbill",
    "intake",
    "eligibility",
    "payer",
    "practiceos",
    "ppc",
    "erd",
    "data model",
    "proposed key",
    "policyholder",
    "medicaid",
  ],
};

/**
 * Applied-context sources only out-rank raw vendor docs when the query is
 * actually about the object model / field schema. A bare boost on every query
 * would let the object model and registry pollute unrelated build-spec or
 * how-to searches (this is the exact lesson carried over from stedi_docs_mcp:
 * never boost unconditionally).
 */
export const APPLIED_BOOST_PATTERN =
  /\b(object model|custom object|custom field|field registry|registry|schema|data model|erd|contact field|billing submission|proposed key|field id|object map|field map)\b/i;

/** Doc names asserted by the real-corpus test suite (kept here so tests stay corpus-agnostic). */
export const TEST_DOC_NAMES = {
  bigApiSpec: `${API_REPO_PREFIX}apps/v3/contacts-v3.json`,
  objectModel: "System_Docs/GHL_OBJECT_MODEL.md",
  fieldRegistryCsv:
    "Product/Private_Practice_CRM/Attribution_API/Schemas/GHL_Object_Field_Registry/2026-06-23_private-practice-crm-ghl-architecture-registry.csv",
};

/**
 * Builds the list of applied-context sources for a given workspace root. Both
 * the real resolver and the fixture use this so the injected set never drifts.
 *
 * - GHL_OBJECT_MODEL.md (the v3 Contact-as-Patient master model) and the field
 *   registry (README + CSV) carry priority "high": they win on model/schema
 *   queries only.
 * - The Build_Specs are indexed as ordinary applied material (no priority).
 */
export function buildAppliedSources(workspaceRoot: string): AppliedSource[] {
  const inWorkspace = (...segments: string[]) => path.join(workspaceRoot, ...segments);

  const sources: AppliedSource[] = [
    // High-priority: the canonical object model.
    {
      absPath: inWorkspace("System_Docs", "GHL_OBJECT_MODEL.md"),
      kind: "markdown",
      priority: "high",
    },
    // High-priority: the field registry (README explains it, CSV holds the rows).
    {
      absPath: inWorkspace(
        "Product",
        "Private_Practice_CRM",
        "Attribution_API",
        "Schemas",
        "GHL_Object_Field_Registry",
        "README.md",
      ),
      kind: "markdown",
      priority: "high",
    },
    {
      absPath: inWorkspace(
        "Product",
        "Private_Practice_CRM",
        "Attribution_API",
        "Schemas",
        "GHL_Object_Field_Registry",
        "2026-06-23_private-practice-crm-ghl-architecture-registry.csv",
      ),
      kind: "csv",
      priority: "high",
    },
  ];

  // Ordinary applied material: every Build_Specs markdown file (no priority boost).
  const buildSpecsDir = inWorkspace("Product", "Private_Practice_CRM", "Build_Specs");
  try {
    for (const entry of fs.readdirSync(buildSpecsDir)) {
      if (entry.startsWith("._") || !entry.endsWith(".md")) continue;
      sources.push({ absPath: path.join(buildSpecsDir, entry), kind: "markdown" });
    }
  } catch {
    // Build_Specs is optional; a missing folder should not break the index.
  }

  return sources;
}

/** Assemble a config for an explicit corpus/workspace pair (used by the fixture). */
export function makeConfig(corpusRoot: string, workspaceRoot: string): CorpusConfig {
  return {
    corpusRoot,
    workspaceRoot,
    appliedSources: buildAppliedSources(workspaceRoot),
  };
}

export function resolveConfig(): CorpusConfig {
  const serverRoot = path.resolve(__dirname, "..");
  const defaultWorkspaceRoot = path.resolve(serverRoot, "..", "..");
  const envCorpusRoot = process.env.GHL_DOCS_CORPUS_ROOT;
  const corpusRoot =
    envCorpusRoot ?? path.join(defaultWorkspaceRoot, "Product", "PracticeOS", "GHL");

  // The workspace is three levels above the corpus (…/Product/PracticeOS/GHL),
  // so an env-overridden corpus still resolves its applied-context siblings.
  const workspaceRoot = envCorpusRoot
    ? path.resolve(corpusRoot, "..", "..", "..")
    : defaultWorkspaceRoot;

  return makeConfig(corpusRoot, workspaceRoot);
}

/**
 * Fails fast with an actionable message when the corpus root is missing,
 * instead of silently serving an empty index.
 */
export function assertCorpusRoot(config: CorpusConfig): void {
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(config.corpusRoot).isDirectory();
  } catch {
    isDirectory = false;
  }

  if (!isDirectory) {
    throw new Error(
      `GHL docs corpus root not found at "${config.corpusRoot}". ` +
        `Set the GHL_DOCS_CORPUS_ROOT environment variable to the absolute path of ` +
        `Product/PracticeOS/GHL (the folder containing "Github Repo/highlevel-api-docs" ` +
        `and "Help Reference") and restart the server.`,
    );
  }
}
