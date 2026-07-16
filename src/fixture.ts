import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CorpusConfig } from "./types.js";
import { makeConfig } from "./config.js";

export interface FixtureHandle {
  config: CorpusConfig;
  cleanup: () => void;
}

/**
 * Builds a synthetic, self-contained corpus in a temp directory that mirrors
 * the real Product/PracticeOS/GHL layout (plus its applied-context siblings).
 * Used by `npm run test:fixture` so the full indexing/search/exclusion behavior
 * can be verified on any machine, without the real corpus present.
 */
export function buildFixtureCorpus(): FixtureHandle {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ghl-docs-fixture-"));
  const corpusRoot = path.join(workspaceRoot, "Product", "PracticeOS", "GHL");

  const writeCorpus = (relative: string, content: string): void => {
    const target = path.join(corpusRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };
  const writeWorkspace = (relative: string, content: string): void => {
    const target = path.join(workspaceRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };

  fs.mkdirSync(corpusRoot, { recursive: true });

  // Governance pair: CLAUDE.md canonical, AGENTS.md a symlink to it.
  writeCorpus("CLAUDE.md", "# GHL Reference Corpus (fixture)\n\nFixture governance file.\n");
  fs.symlinkSync("CLAUDE.md", path.join(corpusRoot, "AGENTS.md"));

  const repo = path.join("Github Repo", "highlevel-api-docs");

  // api namespace: OAuth markdown reference.
  writeCorpus(
    path.join(repo, "docs", "oauth", "Scopes.md"),
    [
      "# OAuth Scopes",
      "",
      "Each API endpoint requires an OAuth access token with the correct scope.",
      "",
      "## Contacts scopes",
      "",
      "The contacts.readonly scope grants read access; contacts.write grants create and update.",
    ].join("\n"),
  );

  // api namespace: one long markdown doc that must split into multiple chunks.
  const longSections: string[] = [
    "# Contacts API guide (fixture)",
    "",
    "Create, update, and search contact records through the contacts endpoint.",
  ];
  for (let section = 1; section <= 4; section += 1) {
    longSections.push("", `## Request section ${section}`, "");
    for (let paragraph = 0; paragraph < 24; paragraph += 1) {
      longSections.push(
        `Paragraph ${section}.${paragraph}: the contact request carries firstName, lastName, email, phone, and a customField array for the subscriber record. `.repeat(3),
        "",
      );
    }
  }
  writeCorpus(path.join(repo, "docs", "contacts-guide.md"), longSections.join("\n"));

  // api namespace: a mini OpenAPI spec with $refs that must resolve.
  writeCorpus(
    path.join(repo, "apps", "v3", "mini-contacts.json"),
    JSON.stringify(
      {
        openapi: "3.0.0",
        info: { title: "Mini Contacts API v3", version: "v3" },
        components: {
          schemas: {
            CreateContactDto: {
              type: "object",
              description: "Fixture create-contact body.",
              properties: {
                email: { type: "string", description: "Contact email address." },
                customField: { $ref: "#/components/schemas/CustomField" },
              },
            },
            CustomField: {
              type: "object",
              properties: {
                value: { type: "string", description: "Custom field value from the contact record." },
              },
            },
          },
        },
        paths: {
          "/contacts/": {
            post: {
              operationId: "CreateContact",
              summary: "Create a contact",
              tags: ["Contacts"],
              requestBody: {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/CreateContactDto" },
                  },
                },
              },
            },
          },
          "/contacts/search": {
            post: {
              operationId: "SearchContacts",
              summary: "Search contacts",
              tags: ["Contacts"],
            },
          },
          "/contacts/{contactId}": {
            get: {
              operationId: "GetContact",
              summary: "Get a contact by id",
              tags: ["Contacts"],
            },
          },
        },
      },
      null,
      2,
    ),
  );

  // help namespace: landing README stub plus one article so routing has content.
  writeCorpus(
    path.join("Help Reference", "README.md"),
    "# Help Reference (fixture)\n\nLanding area for selectively-scraped help-center articles.\n",
  );
  writeCorpus(
    path.join("Help Reference", "workflows.md"),
    [
      "# Building a Workflow",
      "",
      "Workflows automate actions in the app. Add a trigger, then one or more actions.",
      "",
      "## Triggers",
      "",
      "A workflow trigger starts an automation when an event such as a form submission occurs.",
    ].join("\n"),
  );

  // Files that must be EXCLUDED from the index.
  writeCorpus(path.join(repo, "docs", "._ghost.md"), "# AppleDouble sidecar\n\nMust never be indexed.\n");
  writeCorpus(path.join(repo, "docs", "api-token.md"), "# Token file\n\nMust never be indexed (secret pattern).\n");
  writeCorpus("notes.txt", "Plain text files are not indexed.\n");
  const gitDir = path.join(corpusRoot, repo, ".git");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "internals.md"), "# Git internals\n\nMust never be indexed.\n", "utf8");

  // --- Applied-context siblings, at the workspace-relative canonical homes ---

  // High-priority: object model (deliberately contains NO superbill/template/spec
  // tokens so a superbill query does not surface it).
  writeWorkspace(
    path.join("System_Docs", "GHL_OBJECT_MODEL.md"),
    [
      "# PPC GHL Object Model (fixture)",
      "",
      "Contact is the patient master record. Payer is a dropdown on Contact.",
      "",
      "## Custom object: Billing Submission",
      "",
      "The Billing Submission custom object stores historical billing truth: one record per date of service.",
      "It snapshots the payer and member id at submission time so changing current Contact fields does not rewrite history.",
      "",
      "## Contact custom fields",
      "",
      "Current insurance values live as Contact custom fields in the Insurance Information folder.",
    ].join("\n"),
  );

  // High-priority: field registry README + CSV (exact CSV filename the config expects).
  const registryDir = path.join(
    "Product",
    "Private_Practice_CRM",
    "Attribution_API",
    "Schemas",
    "GHL_Object_Field_Registry",
  );
  writeWorkspace(
    path.join(registryDir, "README.md"),
    "# GHL Object And Field Registry (fixture)\n\nOffline architecture source of truth for the GHL object and field map.\n",
  );
  writeWorkspace(
    path.join(registryDir, "2026-06-23_private-practice-crm-ghl-architecture-registry.csv"),
    [
      "record_id,record_type,status,object_or_system,group_or_folder,field_label,proposed_key,data_type,description,allowed_values_or_mapping,data_classification,phi_risk,allowed_destinations,notes",
      '"FLD-010","Field","Proposed","Billing Submission","Snapshot","Member ID Snapshot","member_id_snapshot","Text","Historical billing identifier captured at submission time.","","Identifier","High when joined to healthcare context","GHL Billing Submission","Minimum necessary only."',
      '"FLD-011","Field","Proposed","Contact","Insurance Information","Payer / Insurer","primary_insurer","Dropdown","Current payer for the contact.","Aetna, BCBS, Cigna, Self-pay","Business operational","Low","GHL Contact","Seed from insurer dropdown."',
    ].join("\n"),
  );

  // Ordinary applied material: a build spec (no priority boost). Strong superbill
  // tokens so a superbill query surfaces THIS, not the object model.
  writeWorkspace(
    path.join("Product", "Private_Practice_CRM", "Build_Specs", "SUPERBILL_TEMPLATE_SPEC.md"),
    [
      "# Superbill Template Spec (fixture)",
      "",
      "This spec defines the monthly superbill template for out-of-network clients.",
      "",
      "## Superbill fields",
      "",
      "The superbill template includes the CPT code, diagnosis, charge, and the monthly superbill period covered.",
    ].join("\n"),
  );

  return {
    config: makeConfig(corpusRoot, workspaceRoot),
    cleanup: () => fs.rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}
