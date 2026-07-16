import type {
  ContextChunk,
  ContextResponse,
  DocChunk,
  FullChunk,
  GetChunksResponse,
  Intent,
  Namespace,
  Pagination,
  RoutedNamespace,
  SearchResult,
} from "./types.js";
import { excerpt, tokenize } from "./text.js";
import { CHARACTER_LIMIT, DEFAULT_MAX_CHUNKS, MAX_CHUNKS_CAP } from "./constants.js";
import { APPLIED_BOOST_PATTERN, DEFAULT_NAMESPACE, ROUTING_KEYWORDS } from "./config.js";

export interface ContextRequest {
  query: string;
  namespace?: Namespace;
  intent?: Intent;
  maxChunks?: number;
  offset?: number;
  /** Override for tests; defaults to CHARACTER_LIMIT. */
  characterLimit?: number;
}

export function buildContextResponse(chunks: DocChunk[], request: ContextRequest): ContextResponse {
  const namespace = request.namespace ?? "auto";
  const intent = request.intent ?? "answer";
  const maxChunks = clamp(request.maxChunks ?? DEFAULT_MAX_CHUNKS, 1, MAX_CHUNKS_CAP);
  const offset = Math.max(0, Math.floor(request.offset ?? 0));
  const characterLimit = request.characterLimit ?? CHARACTER_LIMIT;

  const routed = namespace === "auto" ? routeQuery(request.query) : namespace;
  const candidates = chunks.filter((chunk) => chunk.namespace === routed);
  const results = search(candidates, request.query);
  const page = results.slice(offset, offset + maxChunks);

  const response: ContextResponse = {
    query: request.query,
    namespace: routed,
    intent,
    guidance: guidanceFor(routed, intent, page.length, results.length),
    chunks: page.map(toContextChunk),
    pagination: paginate(results.length, page.length, offset),
    follow_ups: followUpsFor(routed, request.query),
    stats: {
      indexed_chunks: chunks.length,
      returned_chunks: page.length,
    },
  };

  return enforceContextCharacterLimit(response, characterLimit);
}

export interface GetRequest {
  ids?: string[];
  path?: string;
  /** Override for tests; defaults to CHARACTER_LIMIT. */
  characterLimit?: number;
}

export function buildGetResponse(chunks: DocChunk[], request: GetRequest): GetChunksResponse {
  const characterLimit = request.characterLimit ?? CHARACTER_LIMIT;
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const found: DocChunk[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const id of request.ids ?? []) {
    const hit = byId.get(id);
    if (!hit) {
      missing.push(id);
      continue;
    }
    if (!seen.has(hit.id)) {
      seen.add(hit.id);
      found.push(hit);
    }
  }

  if (request.path) {
    const normalized = normalizePath(request.path);
    const pathHits = chunks.filter((chunk) => normalizePath(chunk.relativePath) === normalized);
    if (!pathHits.length) {
      missing.push(request.path);
    }
    for (const hit of pathHits) {
      if (!seen.has(hit.id)) {
        seen.add(hit.id);
        found.push(hit);
      }
    }
  }

  const response: GetChunksResponse = {
    found: found.map(toFullChunk),
    missing,
  };

  return enforceGetCharacterLimit(response, characterLimit);
}

export function routeQuery(query: string): RoutedNamespace {
  const haystack = query.toLowerCase();
  const scores = Object.entries(ROUTING_KEYWORDS).map(([namespace, keywords]) => ({
    namespace: namespace as RoutedNamespace,
    score: keywords.reduce((sum, keyword) => sum + (haystack.includes(keyword) ? 1 : 0), 0),
  }));
  scores.sort((a, b) => b.score - a.score);
  return scores[0]?.score ? scores[0].namespace : DEFAULT_NAMESPACE;
}

export function search(chunks: DocChunk[], query: string): SearchResult[] {
  const queryTokens = tokenize(query);
  const querySet = new Set(queryTokens);
  const rawQuery = query.toLowerCase();

  return chunks
    .map((chunk) => scoreChunk(chunk, queryTokens, querySet, rawQuery))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score);
}

function scoreChunk(
  chunk: DocChunk,
  queryTokens: string[],
  querySet: Set<string>,
  rawQuery: string,
): SearchResult {
  let score = 0;
  const reasons: string[] = [];
  const tokenCounts = new Map<string, number>();
  for (const token of chunk.tokens) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);

  for (const token of queryTokens) {
    const count = tokenCounts.get(token) ?? 0;
    if (count > 0) {
      score += 2 + Math.min(count, 8) * 0.4;
      reasons.push(token);
    }
  }

  const pathText = `${chunk.relativePath} ${chunk.heading} ${chunk.title}`.toLowerCase();
  for (const token of querySet) {
    if (pathText.includes(token)) score += 2.5;
  }

  // The PracticeOS applied-context sources (object model + field registry) only
  // out-rank raw vendor docs when the query is actually about the object model
  // / field schema; a bare boost on every query would let them pollute
  // unrelated build-spec or how-to searches.
  if (chunk.metadata.priority === "high" && score > 0) {
    score += APPLIED_BOOST_PATTERN.test(rawQuery) ? 8 : 1;
  }

  if (
    chunk.sourceType === "openapi" &&
    /api|endpoint|schema|request|response|operation/i.test(queryTokens.join(" "))
  ) {
    score += 2;
  }
  if (chunk.sourceType === "openapi" && /\b(openapi|spec|schema|endpoint|operation|operationid)\b/i.test(rawQuery)) {
    score += 10;
  }

  return { chunk, score, reasons };
}

function toContextChunk(result: SearchResult): ContextChunk {
  return {
    id: result.chunk.id,
    score: Number(result.score.toFixed(2)),
    namespace: result.chunk.namespace,
    source_type: result.chunk.sourceType,
    path: result.chunk.relativePath,
    heading: result.chunk.heading,
    excerpt: excerpt(result.chunk.text),
    metadata: result.chunk.metadata,
  };
}

function toFullChunk(chunk: DocChunk): FullChunk {
  return {
    id: chunk.id,
    namespace: chunk.namespace,
    source_type: chunk.sourceType,
    path: chunk.relativePath,
    heading: chunk.heading,
    text: chunk.text,
    metadata: chunk.metadata,
  };
}

function paginate(totalMatches: number, count: number, offset: number): Pagination {
  const hasMore = offset + count < totalMatches;
  return {
    total_matches: totalMatches,
    count,
    offset,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + count } : {}),
  };
}

function withChunkCount(response: ContextResponse, keep: number): ContextResponse {
  const chunks = response.chunks.slice(0, keep);
  return {
    ...response,
    chunks,
    pagination: paginate(response.pagination.total_matches, chunks.length, response.pagination.offset),
    stats: { ...response.stats, returned_chunks: chunks.length },
  };
}

function contextTruncationMessage(response: ContextResponse, requested: number, limit: number): string {
  const nextOffset = response.pagination.next_offset;
  return [
    `Returned ${response.chunks.length} of ${requested} requested chunks to stay under ${limit} characters.`,
    nextOffset !== undefined
      ? `Continue with offset=${nextOffset}, or fetch specific chunks by id with ghl_docs_get.`
      : `Fetch specific chunks by id with ghl_docs_get for full text.`,
  ].join(" ");
}

function markContextTruncated(response: ContextResponse, message: string): ContextResponse {
  return { ...response, truncated: true, truncation_message: message };
}

/**
 * Trims a response down to `limit` serialized characters. Unlike a naive
 * overhead estimate, the truncation message is measured as part of the payload
 * (and JSON escaping is accounted for via a re-serialize shrink loop), so the
 * returned response genuinely fits under the limit.
 */
function enforceContextCharacterLimit(response: ContextResponse, limit: number): ContextResponse {
  if (JSON.stringify(response).length <= limit) return response;

  const requested = response.chunks.length;
  let current = response;

  // Drop whole chunks while the truncated response would still overflow.
  while (
    current.chunks.length > 1 &&
    JSON.stringify(markContextTruncated(current, contextTruncationMessage(current, requested, limit))).length > limit
  ) {
    current = withChunkCount(current, current.chunks.length - 1);
  }

  const message = contextTruncationMessage(current, requested, limit);
  let out = markContextTruncated(current, message);

  // A single surviving chunk may still be too large: shrink its excerpt until it fits.
  if (JSON.stringify(out).length > limit && current.chunks.length === 1) {
    const only = current.chunks[0];
    let room = only.excerpt.length;
    const build = (chars: number): ContextResponse =>
      markContextTruncated(
        {
          ...current,
          chunks: [{ ...only, excerpt: chars >= only.excerpt.length ? only.excerpt : `${only.excerpt.slice(0, chars)}...` }],
        },
        message,
      );
    while (room > 0 && JSON.stringify(build(room)).length > limit) room -= 48;
    out = build(Math.max(0, room));
  }

  return out;
}

function getTruncationMessage(response: GetChunksResponse, requested: number, limit: number): string {
  return (
    `Returned ${response.found.length} of ${requested} matched chunks in full to stay under ${limit} characters. ` +
    `Request the remaining ids in a follow-up ghl_docs_get call.`
  );
}

function markGetTruncated(response: GetChunksResponse, message: string): GetChunksResponse {
  return { ...response, truncated: true, truncation_message: message };
}

function enforceGetCharacterLimit(response: GetChunksResponse, limit: number): GetChunksResponse {
  if (JSON.stringify(response).length <= limit) return response;

  const requested = response.found.length;
  let current = response;

  while (
    current.found.length > 1 &&
    JSON.stringify(markGetTruncated(current, getTruncationMessage(current, requested, limit))).length > limit
  ) {
    current = { ...current, found: current.found.slice(0, -1) };
  }

  const message = getTruncationMessage(current, requested, limit);
  let out = markGetTruncated(current, message);

  if (JSON.stringify(out).length > limit && current.found.length === 1) {
    const only = current.found[0];
    const build = (chars: number): GetChunksResponse =>
      markGetTruncated(
        {
          ...current,
          found: [
            {
              ...only,
              text:
                chars >= only.text.length
                  ? only.text
                  : `${only.text.slice(0, chars)}\n…[truncated — ${only.text.length - chars} more characters in ${only.path}]`,
            },
          ],
        },
        message,
      );
    let room = only.text.length;
    while (room > 0 && JSON.stringify(build(room)).length > limit) room -= 64;
    out = build(Math.max(0, room));
  }

  return out;
}

function guidanceFor(
  namespace: RoutedNamespace,
  intent: Intent,
  returned: number,
  totalMatches: number,
): string {
  if (!returned) {
    if (totalMatches > 0) {
      return `The offset is past the last of ${totalMatches} matches. Retry with a smaller offset.`;
    }
    if (namespace === "help") {
      return `No ${namespace} matches found. The Help Reference layer is a landing area and may be empty; try namespace='api' for endpoint/OpenAPI docs or namespace='applied' for the PPC object model.`;
    }
    return `No strong ${namespace} matches found. Try a more specific GHL term: an endpoint or resource name, an operationId, a custom object/field, or a PPC concept like Billing Submission.`;
  }

  const base =
    intent === "source_map"
      ? `Use these ${namespace} sources as the initial map. Load exact paths if a downstream agent needs more detail.`
      : intent === "build_context"
        ? `Use these ${namespace} chunks as coding context. They are excerpts, not full documents; fetch full chunks with ghl_docs_get before implementing risky behavior.`
        : `Routed to ${namespace}. The selected excerpts should answer the question or identify the next source to inspect.`;

  return totalMatches > returned
    ? `${base} ${totalMatches} chunks matched in total; page with offset for more.`
    : base;
}

function followUpsFor(namespace: RoutedNamespace, query: string): string[] {
  const lower = query.toLowerCase();
  const followUps = [
    `Load more ${namespace} context for this exact task.`,
    "Show source paths only.",
  ];

  if (lower.includes("custom object") || lower.includes("custom field") || lower.includes("object model")) {
    followUps.push("Include the PPC GHL object model and field registry.");
  }
  if (lower.includes("webhook")) {
    followUps.push("Route to the webhook events reference.");
  }
  if (lower.includes("oauth") || lower.includes("scope") || lower.includes("token")) {
    followUps.push("Search OAuth authorization and scopes docs.");
  }
  if (lower.includes("billing") || lower.includes("superbill") || lower.includes("insurance")) {
    followUps.push("Search the PracticeOS billing submission and insurer specs.");
  }

  return followUps;
}

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/").replace(/^\.\//, "");
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
