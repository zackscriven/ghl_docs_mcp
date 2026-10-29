import fs from "node:fs/promises";
import path from "node:path";
import type { AppliedSource, CorpusConfig, DocChunk, RoutedNamespace } from "./types.js";
import { stableId, titleFromPath, tokenize } from "./text.js";
import { DEFAULT_NAMESPACE, OPENAPI_PATH_PREFIX, ROUTE_PREFIXES } from "./config.js";

const MAX_MARKDOWN_CHARS = 5000;

/** How many registry rows go into a single retrievable CSV chunk. */
const CSV_ROWS_PER_CHUNK = 12;

/** Columns rendered per registry row (in order), when present. */
const CSV_RENDER_COLUMNS = [
  "record_id",
  "record_type",
  "status",
  "object_or_system",
  "group_or_folder",
  "field_label",
  "proposed_key",
  "data_type",
  "description",
  "allowed_values_or_mapping",
  "data_classification",
  "phi_risk",
  "allowed_destinations",
  "notes",
];

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
  // 2026-10-28 marketplace bundle: per-endpoint pages duplicate v3/services/*.md
  // (one file per service is the indexed source); _extract-test is scratch.
  "pages",
  "_extract-test",
]);

const SECRET_PATTERNS = [
  /\.env$/i,
  /\.pem$/i,
  /\.key$/i,
  /secret/i,
  /credential/i,
  /token/i,
];

export async function buildIndex(config: CorpusConfig): Promise<DocChunk[]> {
  const files = await listFiles(config.corpusRoot);
  const chunks: DocChunk[] = [];

  for (const filePath of files) {
    if (shouldExcludeFile(filePath)) continue;
    const relativePath = path.relative(config.corpusRoot, filePath);
    if (filePath.endsWith(".md")) {
      chunks.push(...(await chunksFromMarkdown(filePath, relativePath, routeNamespace(relativePath))));
    } else if (filePath.endsWith(".json") && isOpenApiPath(relativePath)) {
      chunks.push(...(await chunksFromOpenApi(filePath, relativePath)));
    }
  }

  // Inject applied-context sources from their canonical homes (not duplicated
  // into the corpus). Priority-high sources are unshifted so ties favor them;
  // ranking still decides final order per query.
  const applied: DocChunk[] = [];
  for (const source of config.appliedSources) {
    try {
      applied.push(...(await chunksFromApplied(source, config.workspaceRoot)));
    } catch {
      // Applied context is helpful but must not prevent the server from starting.
    }
  }
  chunks.unshift(...applied);

  return chunks;
}

export function routeNamespace(relativePath: string): RoutedNamespace {
  const normalized = relativePath.split(path.sep).join("/");
  for (const { prefix, namespace } of ROUTE_PREFIXES) {
    if (normalized.startsWith(prefix)) return namespace;
  }
  return DEFAULT_NAMESPACE;
}

function isOpenApiPath(relativePath: string): boolean {
  return relativePath.split(path.sep).join("/").startsWith(OPENAPI_PATH_PREFIX);
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith("._")) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      files.push(...(await listFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function shouldExcludeFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base.startsWith("._")) return true;
  if (!filePath.endsWith(".md") && !filePath.endsWith(".json")) return true;
  return SECRET_PATTERNS.some((pattern) => pattern.test(base));
}

/* ----------------------------- applied layer ----------------------------- */

async function chunksFromApplied(source: AppliedSource, workspaceRoot: string): Promise<DocChunk[]> {
  const relativePath = path.relative(workspaceRoot, source.absPath);
  const produced =
    source.kind === "csv"
      ? await chunksFromCsv(source.absPath, relativePath)
      : await chunksFromMarkdown(source.absPath, relativePath, "applied", "applied-context");

  if (!source.priority) return produced;
  return produced.map((chunk) => ({
    ...chunk,
    metadata: { ...chunk.metadata, priority: "high" },
  }));
}

/* ------------------------------- markdown -------------------------------- */

async function chunksFromMarkdown(
  filePath: string,
  relativePath: string,
  namespace: RoutedNamespace,
  sourceType: DocChunk["sourceType"] = "markdown",
): Promise<DocChunk[]> {
  const content = await fs.readFile(filePath, "utf8");
  const sections = splitMarkdownByHeading(content);
  const chunks: DocChunk[] = [];

  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    const pieces = splitLongText(section.text, MAX_MARKDOWN_CHARS);
    for (let j = 0; j < pieces.length; j += 1) {
      const heading = pieces.length > 1 ? `${section.heading} (${j + 1}/${pieces.length})` : section.heading;
      const text = pieces[j];
      chunks.push({
        id: stableId(relativePath, `md-${i}-${j}`),
        namespace,
        sourceType,
        filePath,
        relativePath,
        title: titleFromPath(filePath),
        heading,
        text,
        tokens: tokenize(`${relativePath} ${heading} ${text}`),
        metadata: {},
      });
    }
  }

  return chunks;
}

function splitMarkdownByHeading(content: string): Array<{ heading: string; text: string }> {
  const lines = content.split(/\r?\n/);
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current = { heading: "Overview", lines: [] as string[] };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch && current.lines.join("\n").trim()) {
      sections.push(current);
      current = { heading: headingMatch[2].trim(), lines: [line] };
    } else {
      if (headingMatch) current.heading = headingMatch[2].trim();
      current.lines.push(line);
    }
  }

  if (current.lines.join("\n").trim()) sections.push(current);
  return sections.map((section) => ({ heading: section.heading, text: section.lines.join("\n").trim() }));
}

function splitLongText(input: string, maxChars: number): string[] {
  if (input.length <= maxChars) return [input];
  const paragraphs = input.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (`${current}\n\n${paragraph}`.length > maxChars && current.trim()) {
      chunks.push(current.trim());
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxChars) return [chunk];
    const pieces: string[] = [];
    for (let i = 0; i < chunk.length; i += maxChars) {
      pieces.push(chunk.slice(i, i + maxChars));
    }
    return pieces;
  });
}

/* --------------------------------- CSV ----------------------------------- */

async function chunksFromCsv(filePath: string, relativePath: string): Promise<DocChunk[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const rows = parseCsv(raw);
  if (rows.length < 2) return [];

  const header = rows[0];
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => cell.trim().length > 0));
  const title = titleFromPath(filePath);
  const columns = CSV_RENDER_COLUMNS.filter((column) => header.includes(column));
  const chunks: DocChunk[] = [];

  for (let start = 0; start < dataRows.length; start += CSV_ROWS_PER_CHUNK) {
    const batch = dataRows.slice(start, start + CSV_ROWS_PER_CHUNK);
    const firstRow = start + 1;
    const lastRow = start + batch.length;
    const heading = `Field registry rows ${firstRow}-${lastRow}`;
    const blocks = batch.map((row) => renderCsvRow(header, row, columns));
    const text = [
      `Generated from CSV, source: ${relativePath.replaceAll(path.sep, "/")}`,
      `Rows ${firstRow}-${lastRow} of ${dataRows.length}.`,
      "",
      ...blocks,
    ].join("\n");

    const chunkIndex = Math.floor(start / CSV_ROWS_PER_CHUNK);
    chunks.push({
      id: stableId(relativePath, `csv-${chunkIndex}`),
      namespace: "applied",
      sourceType: "applied-context",
      filePath,
      relativePath,
      title,
      heading,
      text,
      tokens: tokenize(`${relativePath} ${heading} ${text}`),
      metadata: { source_format: "csv", rows: `${firstRow}-${lastRow}` },
    });
  }

  return chunks;
}

function renderCsvRow(header: string[], row: string[], columns: string[]): string {
  const value = (column: string): string => {
    const index = header.indexOf(column);
    return index >= 0 ? (row[index] ?? "").trim() : "";
  };

  const label = value("field_label") || value("object_or_system") || value("record_id") || "row";
  const recordId = value("record_id");
  const lines = [`### ${recordId ? `[${recordId}] ` : ""}${label}`];
  for (const column of columns) {
    if (column === "field_label" || column === "record_id") continue;
    const cell = value(column);
    if (cell) lines.push(`- ${column}: ${cell}`);
  }
  return lines.join("\n");
}

/** Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas, "" escapes, and CRLF. */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/* ------------------------------- OpenAPI --------------------------------- */

async function chunksFromOpenApi(filePath: string, relativePath: string): Promise<DocChunk[]> {
  const raw = await fs.readFile(filePath, "utf8");
  let spec: {
    info?: { title?: string; version?: string };
    paths?: Record<string, Record<string, unknown>>;
    components?: Record<string, unknown>;
  };
  try {
    spec = JSON.parse(raw);
  } catch {
    // A non-spec .json (e.g. a table of contents) that happens to sit under the
    // repo apps folder should be skipped, not crash the index.
    return [];
  }

  const chunks: DocChunk[] = [];
  const title = spec.info?.title ?? titleFromPath(filePath);

  for (const [apiPath, methods] of Object.entries(spec.paths ?? {})) {
    if (methods === null || typeof methods !== "object") continue;
    for (const [method, operation] of Object.entries(methods)) {
      if (method.startsWith("x-") || operation === null || typeof operation !== "object") continue;
      const op = operation as Record<string, unknown>;
      const opText = JSON.stringify(resolveRefs(op, spec as Record<string, unknown>, 2), null, 2);
      const tags = Array.isArray(op.tags) ? op.tags.map(String).join(", ") : "";
      const summary = String(op.summary ?? op.operationId ?? `${method.toUpperCase()} ${apiPath}`);
      const heading = `${method.toUpperCase()} ${apiPath}`;
      const text = [
        `Spec: ${title}`,
        `Operation: ${summary}`,
        tags ? `Tags: ${tags}` : "",
        op.description ? `Description: ${String(op.description)}` : "",
        opText,
      ]
        .filter(Boolean)
        .join("\n\n");

      chunks.push({
        id: stableId(relativePath, `${method}-${apiPath}`),
        namespace: "api",
        sourceType: "openapi",
        filePath,
        relativePath,
        title,
        heading,
        text,
        tokens: tokenize(`${relativePath} ${title} ${heading} ${summary} ${tags} ${text}`),
        metadata: {
          method: method.toUpperCase(),
          path: apiPath,
          tags,
          operationId: String(op.operationId ?? ""),
        },
      });
    }
  }

  return chunks;
}

function resolveRefs(value: unknown, spec: Record<string, unknown>, depth: number): unknown {
  if (depth < 0 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, spec, depth));
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
    const resolved = getJsonPointer(spec, record.$ref.slice(2));
    return resolved ? resolveRefs(resolved, spec, depth - 1) : value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    next[key] = resolveRefs(child, spec, depth);
  }
  return next;
}

function getJsonPointer(root: Record<string, unknown>, pointer: string): unknown {
  return pointer.split("/").reduce<unknown>((current, part) => {
    if (current === null || typeof current !== "object") return undefined;
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    return (current as Record<string, unknown>)[key];
  }, root);
}
