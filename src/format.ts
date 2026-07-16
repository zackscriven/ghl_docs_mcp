import type { ContextResponse, GetChunksResponse } from "./types.js";

/** Human-readable rendering of a ghl_docs_context response. */
export function contextToMarkdown(response: ContextResponse): string {
  const { pagination } = response;
  const lines: string[] = [
    `# GHL docs context: "${response.query}"`,
    "",
    `Namespace: **${response.namespace}** · Intent: ${response.intent} · Showing ${pagination.count} of ${pagination.total_matches} matches (offset ${pagination.offset}, ${response.stats.indexed_chunks} chunks indexed)`,
    "",
    response.guidance,
    "",
  ];

  if (!response.chunks.length) {
    lines.push("_No matching chunks._", "");
  }

  for (const chunk of response.chunks) {
    lines.push(`## ${chunk.path} — ${chunk.heading}`);
    lines.push(`- id: \`${chunk.id}\``);
    lines.push(`- source: ${chunk.source_type} · namespace: ${chunk.namespace} · score: ${chunk.score}`);
    lines.push("", chunk.excerpt, "");
  }

  if (pagination.has_more && pagination.next_offset !== undefined) {
    lines.push(`_More matches available — call again with offset=${pagination.next_offset}._`, "");
  }
  if (response.truncated && response.truncation_message) {
    lines.push(`> ${response.truncation_message}`, "");
  }
  if (response.follow_ups.length) {
    lines.push("### Suggested follow-ups", "");
    for (const followUp of response.follow_ups) {
      lines.push(`- ${followUp}`);
    }
  }

  return lines.join("\n").trim();
}

/** Human-readable rendering of a ghl_docs_get response. */
export function getToMarkdown(response: GetChunksResponse): string {
  const lines: string[] = [`# GHL docs chunks (${response.found.length} found, ${response.missing.length} missing)`, ""];

  for (const chunk of response.found) {
    lines.push(`## ${chunk.path} — ${chunk.heading}`);
    lines.push(`- id: \`${chunk.id}\``);
    lines.push(`- source: ${chunk.source_type} · namespace: ${chunk.namespace}`);
    lines.push("", chunk.text, "");
  }

  if (response.missing.length) {
    lines.push("### Not found", "");
    for (const id of response.missing) {
      lines.push(`- \`${id}\` — no indexed chunk with this id or path. Ids come from ghl_docs_context results.`);
    }
    lines.push("");
  }

  if (response.truncated && response.truncation_message) {
    lines.push(`> ${response.truncation_message}`);
  }

  return lines.join("\n").trim();
}
