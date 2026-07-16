export type Namespace = "auto" | "api" | "help" | "applied";

export type RoutedNamespace = Exclude<Namespace, "auto">;

export type Intent = "answer" | "build_context" | "source_map";

export type ResponseFormat = "markdown" | "json";

/**
 * An applied-layer source injected from its canonical home elsewhere in the
 * workspace (not duplicated into the corpus). Paths are resolved relative to
 * the workspace root so an env-overridden corpus keeps finding them.
 */
export interface AppliedSource {
  /** Absolute path to the file on disk. */
  absPath: string;
  /** How to chunk it: standard markdown, or the field-registry CSV. */
  kind: "markdown" | "csv";
  /** Present when this source should out-rank raw docs on relevant queries. */
  priority?: "high";
}

export interface CorpusConfig {
  corpusRoot: string;
  workspaceRoot: string;
  appliedSources: AppliedSource[];
}

export interface DocChunk {
  id: string;
  namespace: RoutedNamespace;
  sourceType: "markdown" | "openapi" | "applied-context";
  filePath: string;
  relativePath: string;
  title: string;
  heading: string;
  text: string;
  tokens: string[];
  metadata: Record<string, string>;
}

export interface SearchResult {
  chunk: DocChunk;
  score: number;
  reasons: string[];
}

/** Compact chunk representation returned by ghl_docs_context. */
export interface ContextChunk {
  id: string;
  score: number;
  namespace: RoutedNamespace;
  source_type: DocChunk["sourceType"];
  path: string;
  heading: string;
  excerpt: string;
  metadata: Record<string, string>;
}

export interface Pagination {
  total_matches: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
}

/** Type alias (not interface) so it satisfies the SDK's structuredContent index signature. */
export type ContextResponse = {
  query: string;
  namespace: RoutedNamespace;
  intent: Intent;
  guidance: string;
  chunks: ContextChunk[];
  pagination: Pagination;
  follow_ups: string[];
  truncated?: boolean;
  truncation_message?: string;
  stats: {
    indexed_chunks: number;
    returned_chunks: number;
  };
};

/** Full-text chunk representation returned by ghl_docs_get. */
export interface FullChunk {
  id: string;
  namespace: RoutedNamespace;
  source_type: DocChunk["sourceType"];
  path: string;
  heading: string;
  text: string;
  metadata: Record<string, string>;
}

/** Type alias (not interface) so it satisfies the SDK's structuredContent index signature. */
export type GetChunksResponse = {
  found: FullChunk[];
  missing: string[];
  truncated?: boolean;
  truncation_message?: string;
};
