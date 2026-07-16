import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildIndex } from "./corpus.js";
import { assertCorpusRoot, resolveConfig } from "./config.js";
import { buildContextResponse, buildGetResponse } from "./search.js";
import { contextToMarkdown, getToMarkdown } from "./format.js";
import {
  DEFAULT_MAX_CHUNKS,
  MAX_CHUNKS_CAP,
  MAX_GET_IDS,
  SERVER_NAME,
  SERVER_VERSION,
} from "./constants.js";
import type { DocChunk } from "./types.js";

let cachedIndex: Promise<DocChunk[]> | undefined;

async function getIndex(): Promise<DocChunk[]> {
  cachedIndex ??= (async () => {
    const config = resolveConfig();
    assertCorpusRoot(config);
    return buildIndex(config);
  })();

  try {
    return await cachedIndex;
  } catch (error) {
    // Do not cache failures; a later call may succeed (e.g. volume remounted).
    cachedIndex = undefined;
    throw error;
  }
}

const NAMESPACE_VALUES = ["auto", "api", "help", "applied"] as const;
const ROUTED_NAMESPACE_VALUES = ["api", "help", "applied"] as const;
const INTENT_VALUES = ["answer", "build_context", "source_map"] as const;
const RESPONSE_FORMAT_VALUES = ["markdown", "json"] as const;
const SOURCE_TYPE_VALUES = ["markdown", "openapi", "applied-context"] as const;

const contextInputShape = {
  query: z
    .string()
    .min(2, "Query must be at least 2 characters")
    .max(500, "Query must not exceed 500 characters")
    .describe("The GoHighLevel documentation question or implementation task, e.g. 'Create a contact custom field via the API'."),
  namespace: z
    .enum(NAMESPACE_VALUES)
    .default("auto")
    .describe("Corpus area to search: 'api' (official GHL API v2 docs + OpenAPI specs + webhook/OAuth references), 'help' (help-center articles — landing area, may be empty), 'applied' (PPC's own GHL object model, field registry, and build specs), or 'auto' to route from the query (default)."),
  intent: z
    .enum(INTENT_VALUES)
    .default("answer")
    .describe("How the context will be used: 'answer' a question, 'build_context' for coding, or 'source_map' to list where sources live."),
  max_chunks: z
    .number()
    .int()
    .min(1)
    .max(MAX_CHUNKS_CAP)
    .default(DEFAULT_MAX_CHUNKS)
    .describe(`Maximum chunks to return per page, 1-${MAX_CHUNKS_CAP} (default ${DEFAULT_MAX_CHUNKS}).`),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of ranked matches to skip, for paging through results (default 0)."),
  response_format: z
    .enum(RESPONSE_FORMAT_VALUES)
    .default("markdown")
    .describe("Text output format: 'markdown' for human-readable (default) or 'json' for the full machine-readable object. Structured content is always attached either way."),
};

const contextChunkShape = z.object({
  id: z.string(),
  score: z.number(),
  namespace: z.enum(ROUTED_NAMESPACE_VALUES),
  source_type: z.enum(SOURCE_TYPE_VALUES),
  path: z.string(),
  heading: z.string(),
  excerpt: z.string(),
  metadata: z.record(z.string()),
});

const paginationShape = z.object({
  total_matches: z.number().int(),
  count: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
});

const contextOutputShape = {
  query: z.string(),
  namespace: z.enum(ROUTED_NAMESPACE_VALUES),
  intent: z.enum(INTENT_VALUES),
  guidance: z.string(),
  chunks: z.array(contextChunkShape),
  pagination: paginationShape,
  follow_ups: z.array(z.string()),
  truncated: z.boolean().optional(),
  truncation_message: z.string().optional(),
  stats: z.object({
    indexed_chunks: z.number().int(),
    returned_chunks: z.number().int(),
  }),
};

const getInputShape = {
  ids: z
    .array(z.string().min(3))
    .min(1)
    .max(MAX_GET_IDS)
    .optional()
    .describe(`Chunk ids exactly as returned by ghl_docs_context (e.g. "Github Repo/highlevel-api-docs/apps/v3/contacts-v3.json#post-/contacts/"), up to ${MAX_GET_IDS} per call.`),
  path: z
    .string()
    .min(2)
    .optional()
    .describe("A relative corpus path exactly as returned in a previous result's 'path' field. Returns every chunk of that document, in order."),
  response_format: z
    .enum(RESPONSE_FORMAT_VALUES)
    .default("markdown")
    .describe("Text output format: 'markdown' for human-readable (default) or 'json' for the full machine-readable object."),
};

const fullChunkShape = z.object({
  id: z.string(),
  namespace: z.enum(ROUTED_NAMESPACE_VALUES),
  source_type: z.enum(SOURCE_TYPE_VALUES),
  path: z.string(),
  heading: z.string(),
  text: z.string(),
  metadata: z.record(z.string()),
});

const getOutputShape = {
  found: z.array(fullChunkShape),
  missing: z.array(z.string()),
  truncated: z.boolean().optional(),
  truncation_message: z.string().optional(),
};

const CONTEXT_DESCRIPTION = `Search the local GoHighLevel documentation corpus and return focused, ranked source excerpts for a question or coding task. Routes the query into one of three internal namespaces (official API v2 docs + OpenAPI specs + webhook/OAuth references; help-center articles; and PPC's own applied GHL object model / field registry / build specs) and returns compact chunks with source paths. This is a local documentation index only — it NEVER calls the live GoHighLevel API. (A separate live GHL connector, ghl-mcp-server, owns all live reads/writes; this server has zero overlap with it.)

Args:
  - query (string, required): The documentation question or task, 2-500 chars.
  - namespace ('auto' | 'api' | 'help' | 'applied', default 'auto'): Corpus area. Use 'auto' unless you already know the area.
  - intent ('answer' | 'build_context' | 'source_map', default 'answer'): How the returned context will be used; adjusts guidance.
  - max_chunks (int 1-${MAX_CHUNKS_CAP}, default ${DEFAULT_MAX_CHUNKS}): Page size.
  - offset (int >= 0, default 0): Ranked matches to skip, for paging.
  - response_format ('markdown' | 'json', default 'markdown'): Text rendering; structured content is always attached.

Returns (structured):
  { query, namespace, intent, guidance, chunks: [{ id, score, namespace, source_type, path, heading, excerpt, metadata }], pagination: { total_matches, count, offset, has_more, next_offset? }, follow_ups: [string], truncated?, truncation_message?, stats: { indexed_chunks, returned_chunks } }

Chunk excerpts are capped; pass a chunk's id (or its path) to ghl_docs_get for the full text.

Examples:
  - "Create a contact and set a custom field via the API" -> auto-routes to api; OpenAPI operations from contacts + custom-fields specs rank first.
  - "How does the Billing Submission object model work in PracticeOS?" -> auto-routes to applied; the PPC object model and field registry rank first.
  - namespace='api', query='OAuth scopes for calendars' -> OAuth authorization/scopes docs.
  - Follow-up paging: repeat the same query with offset=pagination.next_offset.

Errors:
  - "GHL docs corpus root not found ..." -> set GHL_DOCS_CORPUS_ROOT to the absolute path of Product/PracticeOS/GHL and restart.
  - Empty chunks with guidance "No strong ... matches" -> retry with a more specific GHL resource name, operationId, custom object/field, or PracticeOS concept.`;

const GET_DESCRIPTION = `Fetch the full text of specific indexed GoHighLevel documentation chunks by id, or every chunk of one document by its relative path. Use this after ghl_docs_context to expand excerpts you actually need — do not use it to browse (use ghl_docs_context for discovery). Reads the local corpus index only; it NEVER calls the live GoHighLevel API.

Args:
  - ids (string[], 1-${MAX_GET_IDS}, optional): Chunk ids exactly as returned by ghl_docs_context.
  - path (string, optional): A relative corpus path exactly as returned in a result's 'path' field; returns all chunks of that document in order.
  - response_format ('markdown' | 'json', default 'markdown'): Text rendering; structured content is always attached.
  At least one of ids or path is required.

Returns (structured):
  { found: [{ id, namespace, source_type, path, heading, text, metadata }], missing: [string], truncated?, truncation_message? }

Examples:
  - ids=["System_Docs/GHL_OBJECT_MODEL.md#md-3-0"] -> full text of that section.
  - path="Github Repo/highlevel-api-docs/docs/oauth/Scopes.md" -> every chunk of that document (may truncate; follow the truncation message).

Errors:
  - Calling with neither ids nor path returns an error explaining both options.
  - Unknown ids/paths are reported in 'missing' rather than failing the whole call.`;

function errorResult(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${message}` }],
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "ghl_docs_context",
    {
      title: "Search GHL Docs Context",
      description: CONTEXT_DESCRIPTION,
      inputSchema: contextInputShape,
      outputSchema: contextOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const chunks = await getIndex();
        const response = buildContextResponse(chunks, {
          query: args.query,
          namespace: args.namespace,
          intent: args.intent,
          maxChunks: args.max_chunks,
          offset: args.offset,
        });
        const text =
          args.response_format === "json"
            ? JSON.stringify(response, null, 2)
            : contextToMarkdown(response);
        return {
          content: [{ type: "text", text }],
          structuredContent: response,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "ghl_docs_get",
    {
      title: "Get GHL Docs Chunks",
      description: GET_DESCRIPTION,
      inputSchema: getInputShape,
      outputSchema: getOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        if (!args.ids?.length && !args.path) {
          return errorResult(
            new Error(
              "Provide 'ids' (chunk ids from a ghl_docs_context result) and/or 'path' (a relative corpus path from a result's 'path' field).",
            ),
          );
        }
        const chunks = await getIndex();
        const response = buildGetResponse(chunks, { ids: args.ids, path: args.path });
        const text =
          args.response_format === "json"
            ? JSON.stringify(response, null, 2)
            : getToMarkdown(response);
        return {
          content: [{ type: "text", text }],
          structuredContent: response,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export async function runServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
