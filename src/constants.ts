export const SERVER_NAME = "ghl_docs_mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Maximum serialized size (characters) of a single tool response. Responses
 * that would exceed this are truncated with an actionable message instead of
 * overwhelming the calling agent's context.
 */
export const CHARACTER_LIMIT = 25_000;

/** Default and maximum number of chunks returned per ghl_docs_context call. */
export const DEFAULT_MAX_CHUNKS = 6;
export const MAX_CHUNKS_CAP = 12;

/** Maximum chunk ids accepted per ghl_docs_get call. */
export const MAX_GET_IDS = 8;

/** Maximum characters of a chunk excerpt in search results. */
export const EXCERPT_LENGTH = 1_200;
