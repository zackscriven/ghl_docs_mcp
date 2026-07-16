import path from "node:path";
import { EXCERPT_LENGTH } from "./constants.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "contain",
  "contains",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "openapi",
  "or",
  "the",
  "to",
  "which",
  "with",
]);

export function tokenize(input: string): string[] {
  const baseTokens = input
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));

  const expanded = new Set<string>();
  for (const token of baseTokens) {
    expanded.add(token);
    // Light singularization so "contacts"/"objects"/"fields" match their singulars.
    if (token.length > 3 && token.endsWith("s")) expanded.add(token.slice(0, -1));
  }

  return [...expanded];
}

export function excerpt(input: string, maxLength = EXCERPT_LENGTH): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

export function stableId(relativePath: string, suffix: string): string {
  return `${relativePath.replaceAll(path.sep, "/")}#${suffix}`
    .replace(/[^a-zA-Z0-9_./#:-]+/g, "-")
    .replace(/-+/g, "-");
}

export function titleFromPath(filePath: string): string {
  return path.basename(filePath).replace(/\.(md|json|csv)$/i, "");
}
