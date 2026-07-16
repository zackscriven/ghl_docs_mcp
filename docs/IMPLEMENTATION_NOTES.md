# Implementation Notes

Sibling build to `stedi_docs_mcp` (v0.2.0). Same proven shape: a private, local
documentation/context MCP that routes a query into internal namespaces and
returns ranked, compact excerpts — **not** a live API client.

Binding decisions:

- One server: `ghl_docs_mcp`.
- Two tools: `ghl_docs_context` (search) and `ghl_docs_get` (fetch full text by id/path).
- Internal namespaces: `api`, `help`, `applied`, `auto`.
- Private POC only; do not publish or redistribute the corpus in Phase 1.
- No live GoHighLevel API calls. The live connector `ghl-mcp-server` owns all live reads/writes — zero overlap.

## Corpus routing

- `Github Repo/highlevel-api-docs/apps/*.json` (and `apps/v3/*.json`) are OpenAPI specs → `api`, chunked by operation.
- `Github Repo/highlevel-api-docs/docs/**.md` (OAuth, webhook events, marketplace, country list) → `api`, chunked by heading.
- `Help Reference/**` → `help` (landing area, may be empty).
- Applied context, injected from canonical workspace homes (never duplicated into the corpus):
  - `System_Docs/GHL_OBJECT_MODEL.md` — the v3 Contact-as-Patient master model (priority: high).
  - `Product/Private_Practice_CRM/Attribution_API/Schemas/GHL_Object_Field_Registry/` — README + the 49 KB registry CSV (priority: high).
  - `Product/Private_Practice_CRM/Build_Specs/*.md` — additional applied material (no priority boost).

The applied priority-high sources (object model + registry) out-rank raw vendor
docs **only** on object-model / custom-field / schema-flavored queries; a bare
boost on every query would let them pollute unrelated build-spec or how-to
searches. This is the same eligibility-note lesson carried over from
`stedi_docs_mcp` (`APPLIED_BOOST_PATTERN` in `config.ts`).

## Corpus baseline (regression reference)

`npm run dry-run` against the real corpus (GHL API docs commit cloned 2026-07-13,
CC0 1.0):

```
chunks: 1780
  byNamespace:   api 1654 · applied 124 · help 2
  bySourceType:  openapi 1203 · markdown 453 · applied-context 124
  objectModelChunks: 28 · fieldRegistryCsvChunks: 8 · contactsV3SpecChunks: 31
```

Treat 1780 as the baseline; a large swing means the corpus changed (re-cloned
repo, added Help Reference scrapes, or edited applied sources).

## Corpus-agnostic engine + single config module

Per the build brief, **all** GHL-specific values live in one module (`config.ts`):
root derivation, path→namespace prefixes (`ROUTE_PREFIXES`), the OpenAPI path
marker, query routing keywords (`ROUTING_KEYWORDS`), the applied priority-boost
pattern (`APPLIED_BOOST_PATTERN`), the applied source list (`buildAppliedSources`),
and the test doc names (`TEST_DOC_NAMES`). `corpus.ts` (indexer) and `search.ts`
(ranker) contain no GHL literals, so folding this and `stedi_docs_mcp` into a
single corpus-agnostic server later is a matter of swapping this file.

## CSV chunker (new vs. stedi)

The stedi indexer chunked only `.md`/`.json`. The GHL field registry is a CSV,
so `corpus.ts` gained a small RFC-4180-ish CSV parser + `chunksFromCsv`: it
groups ~12 rows per retrievable chunk, renders each row as a labeled key/value
block, and stamps a `Generated from CSV, source: <path>` provenance header. The
registry content is fully retrievable via `ghl_docs_context`/`ghl_docs_get`
without adding a separate markdown mirror.

## mcp-builder surface

- `registerTool` API with `title`, full Args/Returns/Examples/Errors descriptions, and annotations (`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` — local corpus only).
- `outputSchema` + `structuredContent` on both tools (SDK-validated).
- `response_format` (`markdown` default, `json`), pagination (`offset`, `total_matches`, `has_more`, `next_offset`), and a 25,000-character response cap with actionable truncation messages.
- Errors return in-result (`isError`) with next-step guidance; a missing corpus root names `GHL_DOCS_CORPUS_ROOT`.
- `evals/ghl_docs_mcp_evals.xml` — 10 QA pairs per the evaluation guide; answers verified against the real corpus documents and each phrased to auto-route to the correct namespace.

## Deliberate deviations / improvements

- **Truncation now genuinely respects the character limit.** The stedi enforce-limit routine measured overhead *before* attaching the `truncation_message`, so a response could overshoot the limit by ~the message length (harmless at 25 k, but the fixture at an 1,800-char limit exposed it with GHL's longer source paths). The rewrite measures the truncated payload as it will actually serialize (re-serialize shrink loop), so the returned response provably fits.
- Server/tool naming stays `ghl_docs_mcp` / `ghl_docs_context` / `ghl_docs_get` (house convention), not the generic `{service}-mcp-server`.
- No MCP resources registered: a ~1,771-chunk corpus would make a noisy resource list; `ghl_docs_get` covers targeted retrieval.
- stdio transport only (local, single-user POC); no HTTP transport, no embeddings — lexical search is sufficient for v0.
- `#/`-internal `$ref`s are resolved inline (depth 2); the few external `../common/common-schemas.json#…` error-DTO refs in the v3 specs are left as literal `$ref` strings (harmless, and they keep the operation chunk intact).

## Verification (all green, 2026-07-13)

- `npm run build` — clean (`engines: node >=18`).
- `npm run test:fixture` — 42 assertions against the synthetic corpus (routing, applied-priority present/absent, big-doc splitting, OpenAPI `$ref` resolution, CSV chunking, exclusions incl. sidecars/.git/secrets, pagination, truncation, get-by-id/path, AGENTS.md symlink, corpus-root error).
- `npm run smoke` — 17 stdio wire-protocol checks (initialize → tools/list with annotations/outputSchema/titles → tools/call happy path, json format, get round-trip, no-args error, too-short-query rejection, missing-corpus-root error).
- `npm test` — real-corpus assertions (symlink, exclusions, contacts-v3 chunks into operations with operationIds, object model + registry CSV present and applied+high-priority).
