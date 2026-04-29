#!/usr/bin/env node
/**
 * Module 2: Data Harmonization — MCP Server
 * Transport: stdio (local)
 *
 * Tools exposed:
 *   1. harmonize_dataset     — transforms raw metadata into AI-ready, FAIR-scored dataset
 *   2. get_harmonization_log — returns log of all harmonized datasets this session
 *   3. export_dataset        — exports a harmonized dataset as CSV, JSON, or Excel
 *   4. get_queue_status      — returns status of datasets queued for Module 3
 *   5. flush_queue           — retries all queued datasets against Module 3
 */

import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as readline from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = join(__dirname, "../exports");
const MODULE3_URL = process.env.MODULE3_MCP_URL || null;
const MODULE3_SERVER = process.env.MODULE3_SERVER_PATH || null;

// Ensure export dir exists
if (!existsSync(EXPORT_DIR)) mkdirSync(EXPORT_DIR, { recursive: true });

// ── Anthropic client ─────────────────────────────────────────────────────────
const anthropic = new Anthropic();

// ── In-memory state ──────────────────────────────────────────────────────────
const harmonizedDatasets = new Map(); // id → harmonized dataset object
const module3Queue = [];              // datasets waiting to be sent to Module 3
let sessionLog = [];                  // full activity log for this session

function logEntry(msg, type = "info") {
  const entry = {
    timestamp: new Date().toISOString(),
    type,
    message: msg,
  };
  sessionLog.push(entry);
  process.stderr.write(`[kg-module2] [${type}] ${msg}\n`);
  return entry;
}

// ── Darwin Core canonical field mappings ─────────────────────────────────────
// Commonly encountered synonyms → Darwin Core standard terms
const DARWIN_CORE_MAPPINGS = {
  // Taxonomy
  species: "dwc:scientificName",
  organism: "dwc:scientificName",
  scientific_name: "dwc:scientificName",
  taxon: "dwc:taxonRank",
  taxonomy: "dwc:taxonRank",
  kingdom: "dwc:kingdom",
  phylum: "dwc:phylum",
  class: "dwc:class",
  order: "dwc:order",
  family: "dwc:family",
  genus: "dwc:genus",
  // Identifiers
  id: "dwc:occurrenceID",
  identifier: "dwc:occurrenceID",
  accession: "dwc:catalogNumber",
  accession_number: "dwc:catalogNumber",
  catalog_number: "dwc:catalogNumber",
  entry_name: "dwc:catalogNumber",
  // Sequences
  sequence: "dwc:associatedSequences",
  nucleotide_sequence: "dwc:associatedSequences",
  protein_sequence: "dwc:associatedSequences",
  dna: "dwc:associatedSequences",
  // Geography
  location: "dwc:locality",
  country: "dwc:country",
  region: "dwc:stateProvince",
  habitat: "dwc:habitat",
  // Dates
  date: "dwc:eventDate",
  collection_date: "dwc:eventDate",
  year: "dwc:year",
  month: "dwc:month",
  // Occurrence
  count: "dwc:individualCount",
  quantity: "dwc:individualCount",
  sex: "dwc:sex",
  life_stage: "dwc:lifeStage",
  // Measurements
  length: "dwc:measurementValue",
  weight: "dwc:measurementValue",
  size: "dwc:measurementValue",
  value: "dwc:measurementValue",
  unit: "dwc:measurementUnit",
  // Provenance
  source: "dwc:institutionCode",
  institution: "dwc:institutionCode",
  collection: "dwc:collectionCode",
  dataset: "dwc:datasetName",
  // Annotations
  function: "dwc:taxonRemarks",
  description: "dwc:taxonRemarks",
  notes: "dwc:occurrenceRemarks",
  remarks: "dwc:occurrenceRemarks",
  annotation: "dwc:identificationRemarks",
};

function mapToDarwinCore(fieldName) {
  const normalized = fieldName.toLowerCase().replace(/[\s-]/g, "_");
  return DARWIN_CORE_MAPPINGS[normalized] || null;
}

// ── OLS4 (Ontology Lookup Service v4) integration ─────────────────────────────
// EMBL-EBI's OLS4 is a federated registry of hundreds of biomedical ontologies
// (GO, ChEBI, MONDO, EFO, Uberon, Darwin Core, Dublin Core, Schema.org, and
// many more). We use its REST API to resolve free-text field names to
// canonical ontology terms, supplementing the static DARWIN_CORE_MAPPINGS table.
//
// Reference: Jupp et al., "A new Ontology Lookup Service at EMBL-EBI",
// continuously updated as part of EMBL-EBI's annual Database Issue in
// Nucleic Acids Research (2025 issue: doi.org/10.1093/nar/gkae1148).
// API base: https://www.ebi.ac.uk/ols4/api/  (free, no auth required)
//
// We use this as a CONTEXT-PROVIDER, not a replacement: OLS4 candidate
// matches are fed into Claude's harmonization prompt so Claude makes the
// final mapping decision with both the static dictionary and OLS4 evidence.
const OLS4_BASE = "https://www.ebi.ac.uk/ols4/api";

/**
 * Search OLS4 for ontology terms matching a free-text field name.
 * Returns up to `limit` candidates with ontology, IRI, label, and short_form.
 * Fails soft — on any error returns [] so the pipeline keeps running.
 *
 * Default ontology bias: dwc, schema, dcterms (the three the harmonization
 * prompt prefers). When `extendedOntologies=true`, also include the broader
 * biomedical set (GO, EFO, MONDO, ChEBI, etc.).
 */
async function ols4Search(query, { limit = 5, extendedOntologies = false } = {}) {
  if (!query || typeof query !== "string") return [];

  const ontologies = extendedOntologies
    ? "dwc,schema,dcterms,obi,efo,go,chebi,mondo,uberon,ncit"
    : "dwc,schema,dcterms";

  const url =
    `${OLS4_BASE}/search?q=${encodeURIComponent(query)}` +
    `&ontology=${ontologies}` +
    `&rows=${limit}&exact=false&queryFields=label,synonym`;

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "kg-module2/1.0 (research)" },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      process.stderr.write(`[kg-module2] OLS4 HTTP ${res.status} for "${query}" — skipping\n`);
      return [];
    }
    const data = await res.json();
    const docs = data?.response?.docs || [];
    return docs.map(d => ({
      label: d.label || "",
      shortForm: d.short_form || d.obo_id || "",
      ontology: d.ontology_prefix || d.ontology_name || "",
      iri: d.iri || "",
      description: Array.isArray(d.description) ? d.description[0] : (d.description || "")
    }));
  } catch (err) {
    process.stderr.write(`[kg-module2] OLS4 error for "${query}": ${err.message} — skipping\n`);
    return [];
  }
}

/**
 * Look up OLS4 candidates for a list of field names in parallel.
 * Returns a map { fieldName → [candidates] }. Empty arrays for fields with
 * no matches or fetch failures. Capped concurrency to avoid hammering EBI.
 */
async function ols4LookupFields(fieldNames, opts = {}) {
  const out = {};
  if (!Array.isArray(fieldNames) || fieldNames.length === 0) return out;

  // Sequential with a short pause is friendlier than parallel here.
  // EBI rate-limits aggressive clients; this loop is bounded by typical
  // dataset field counts (rarely > 30).
  for (const f of fieldNames) {
    if (typeof f !== "string" || !f.trim()) continue;
    out[f] = await ols4Search(f, opts);
  }
  return out;
}

/**
 * Format OLS4 candidate matches as a compact prompt block for Claude.
 * Returns "" if there are no candidates so the prompt cleanly degrades.
 */
function formatOLS4Context(candidatesByField) {
  if (!candidatesByField || Object.keys(candidatesByField).length === 0) return "";

  const lines = [];
  for (const [field, candidates] of Object.entries(candidatesByField)) {
    if (!candidates || candidates.length === 0) continue;
    const top = candidates.slice(0, 3).map(c => {
      const labelPart = c.label ? c.label : c.shortForm;
      const ontPart = c.ontology ? `[${c.ontology}]` : "";
      return `${labelPart} ${ontPart} (${c.shortForm})`.trim();
    });
    lines.push(`  ${field} → ${top.join(" | ")}`);
  }

  if (lines.length === 0) return "";
  return `\nOLS4 (Ontology Lookup Service v4 @ EMBL-EBI) candidate matches for these fields:\n${lines.join("\n")}\n`;
}

// ── Claude harmonization calls ───────────────────────────────────────────────
async function claudeHarmonizeFields(dataset, ols4Candidates = null) {
  const olsContext = formatOLS4Context(ols4Candidates);
  const prompt = `You are a data harmonization engine following Darwin Core and FAIR principles (Findability, Accessibility, Interoperability, Reusability), prioritizing Interoperability.

Given this dataset metadata, perform the following transformations:
1. Standardize field names to Darwin Core terms where applicable
2. Detect and normalize units automatically from field names and descriptions (use explicit units if provided)
3. Fill missing value strategies per field (Claude decides best approach)
4. Flag renamed fields with a tag
5. Map to Schema.org or Dublin Core where Darwin Core doesn't apply

Dataset metadata:
- Name: ${dataset.name}
- Domain: ${dataset.domain}
- Records: ${dataset.records}
- Fields: ${JSON.stringify(dataset.fields || [])}
- Description: ${dataset.description || "not provided"}
- Explicit units: ${JSON.stringify(dataset.units || {})}
${olsContext}
The OLS4 candidate matches above (if present) come from EMBL-EBI's Ontology Lookup Service v4 — they are evidence-backed suggestions from real biomedical ontologies. Prefer an OLS4 candidate over guessing when the match is clearly relevant, but use your judgment: a low-relevance OLS4 hit should NOT override a clearly correct manual mapping.

Return ONLY a JSON object with no markdown or preamble:
{
  "harmonizedFields": [
    {
      "originalName": "field_name",
      "canonicalName": "dwc:termName or schema:termName",
      "ontology": "Darwin Core|Schema.org|Dublin Core",
      "detectedUnit": "unit string or null",
      "missingValueStrategy": "mean|mode|median|forward_fill|empty_string|null|custom description",
      "renamed": true|false,
      "renameFlag": "RENAMED: original_name → canonical_name" or null,
      "notes": "any important notes about this field"
    }
  ],
  "unmappedFields": ["fields that could not be mapped to any ontology"],
  "unitNormalization": {
    "detected": {"field": "unit"},
    "explicit": {"field": "unit"},
    "conflicts": ["field: detected X but explicit Y"]
  },
  "harmonizationNotes": "overall notes about the harmonization"
}`;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content.map((b) => b.text || "").join("");
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { harmonizedFields: [], unmappedFields: [], unitNormalization: {}, harmonizationNotes: "Parse error" };
  }
}

async function claudeCalculateFAIRScore(dataset, harmonization) {
  const prompt = `You are a FAIR data scoring engine. Calculate a holistic FAIR score for this dataset after harmonization.

Dataset: ${dataset.name}
Domain: ${dataset.domain}
Records: ${dataset.records}
Original fields: ${JSON.stringify(dataset.fields || [])}
Description provided: ${dataset.description ? "yes" : "no"}
Source ID provided: ${dataset.sourceId ? "yes" : "no"}

Harmonization results:
- Fields mapped to Darwin Core: ${harmonization.harmonizedFields?.filter(f => f.ontology === "Darwin Core").length || 0}
- Fields mapped to Schema.org: ${harmonization.harmonizedFields?.filter(f => f.ontology === "Schema.org").length || 0}
- Fields mapped to Dublin Core: ${harmonization.harmonizedFields?.filter(f => f.ontology === "Dublin Core").length || 0}
- Unmapped fields: ${harmonization.unmappedFields?.length || 0}
- Unit conflicts detected: ${harmonization.unitNormalization?.conflicts?.length || 0}
- Renamed fields: ${harmonization.harmonizedFields?.filter(f => f.renamed).length || 0}

Score each FAIR pillar 0-1 and return ONLY a JSON object with no markdown or preamble:
{
  "findability": {
    "score": 0.0,
    "rationale": "one sentence"
  },
  "accessibility": {
    "score": 0.0,
    "rationale": "one sentence"
  },
  "interoperability": {
    "score": 0.0,
    "rationale": "one sentence"
  },
  "reusability": {
    "score": 0.0,
    "rationale": "one sentence"
  },
  "overallScore": 0.0,
  "improvements": ["list of specific improvements that would raise the score"]
}

Rules:
- overallScore = weighted average (F:0.2, A:0.2, I:0.4, R:0.2) reflecting Interoperability priority
- Be honest and critical — legacy datasets rarely score above 0.85
- improvements should be concrete and actionable`;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content.map((b) => b.text || "").join("");
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return {
      findability: { score: 0.5, rationale: "Could not calculate" },
      accessibility: { score: 0.5, rationale: "Could not calculate" },
      interoperability: { score: 0.5, rationale: "Could not calculate" },
      reusability: { score: 0.5, rationale: "Could not calculate" },
      overallScore: 0.5,
      improvements: [],
    };
  }
}

async function claudeTransformRecords(dataset, harmonization) {
  const prompt = `You are a data transformation engine. Given this dataset metadata and harmonization plan, generate a representative sample of transformed records showing what the harmonized data would look like.

Dataset: ${dataset.name}
Original fields: ${JSON.stringify(dataset.fields || [])}
Harmonized fields: ${JSON.stringify(harmonization.harmonizedFields?.map(f => ({ original: f.originalName, canonical: f.canonicalName, unit: f.detectedUnit })) || [])}
Missing value strategies: ${JSON.stringify(harmonization.harmonizedFields?.reduce((acc, f) => ({ ...acc, [f.canonicalName]: f.missingValueStrategy }), {}) || {})}

Generate 3 sample transformed records showing the canonical field names, with realistic values for the domain "${dataset.domain}".

Return ONLY a JSON object with no markdown or preamble:
{
  "sampleRecords": [
    { "canonical_field_name": "value", ... },
    { "canonical_field_name": "value", ... },
    { "canonical_field_name": "value", ... }
  ],
  "transformationSummary": "one paragraph describing what transformations were applied"
}`;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content.map((b) => b.text || "").join("");
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { sampleRecords: [], transformationSummary: "Could not generate sample records" };
  }
}

// ── Module 3 handoff ──────────────────────────────────────────────────────────
async function handoffToModule3(harmonizedDataset) {
  // Build the ingest_dataset payload Module 3 expects
  const payload = {
    name: harmonizedDataset.name,
    domain: harmonizedDataset.domain,
    records: harmonizedDataset.records,
    fairScore: harmonizedDataset.fairScore.overallScore,
    fields: harmonizedDataset.harmonization.harmonizedFields?.map(f => f.canonicalName) || [],
    description: `Harmonized by Module 2. ${harmonizedDataset.harmonization.harmonizationNotes || ""}`,
    sourceId: harmonizedDataset.sourceId || null,
  };

  // If Module 3 server path is configured, spawn it and call ingest_dataset
  if (MODULE3_SERVER) {
    try {
      const { spawn } = await import("child_process");
      const { createInterface } = await import("readline");

      const server = spawn("node", [MODULE3_SERVER], {
        stdio: ["pipe", "pipe", "inherit"],
      });

      const rl = createInterface({ input: server.stdout, terminal: false });
      let msgId = 1;
      const pending = new Map();

      rl.on("line", (line) => {
        try {
          const msg = JSON.parse(line);
          const resolve = pending.get(msg.id);
          if (resolve) { pending.delete(msg.id); resolve(msg); }
        } catch { }
      });

      const send = (method, params = {}) => new Promise((resolve) => {
        const id = msgId++;
        pending.set(id, resolve);
        server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

      // Handshake
      await send("initialize", {
        protocolVersion: "2025-11-25",
        clientInfo: { name: "kg-module2", version: "1.0.0" },
        capabilities: {},
      });
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      // Call ingest_dataset (fire and forget — don't await result)
      const id = msgId++;
      server.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ingest_dataset", arguments: payload } }) + "\n"
      );

      // Give it 30s to process then kill
      setTimeout(() => {
        server.kill();
        logEntry(`Module 3 handoff complete for: ${harmonizedDataset.name}`, "ok");
      }, 30000);

      return { success: true, method: "direct_spawn", payload };
    } catch (err) {
      logEntry(`Module 3 spawn failed: ${err.message} — queuing dataset`, "warn");
      module3Queue.push({ dataset: harmonizedDataset, payload, queuedAt: new Date().toISOString(), attempts: 1 });
      return { success: false, queued: true, reason: err.message };
    }
  } else {
    // No Module 3 path configured — queue it
    logEntry(`Module 3 path not configured — queuing dataset: ${harmonizedDataset.name}`, "warn");
    module3Queue.push({ dataset: harmonizedDataset, payload, queuedAt: new Date().toISOString(), attempts: 0 });
    return { success: false, queued: true, reason: "MODULE3_SERVER_PATH not configured" };
  }
}

// ── Export helpers ────────────────────────────────────────────────────────────
function buildExportData(harmonizedDataset) {
  const fields = harmonizedDataset.harmonization.harmonizedFields || [];
  const records = harmonizedDataset.sampleRecords || [];

  // Embed rename flags and metadata in the export
  const metadata = {
    _module: "kg-module2",
    _harmonizedAt: harmonizedDataset.harmonizedAt,
    _fairScore: harmonizedDataset.fairScore.overallScore,
    _ontologyMappings: fields.reduce((acc, f) => {
      acc[f.canonicalName] = f.ontology;
      return acc;
    }, {}),
    _renameFlags: fields.filter(f => f.renamed).map(f => f.renameFlag),
    _unitNormalization: harmonizedDataset.harmonization.unitNormalization,
    _improvements: harmonizedDataset.fairScore.improvements,
  };

  return { metadata, fields, records };
}

function exportCSV(harmonizedDataset) {
  const { metadata, fields, records } = buildExportData(harmonizedDataset);

  let csv = "";

  // Embed metadata as comments at top
  csv += `# Module 2 Harmonized Dataset: ${harmonizedDataset.name}\n`;
  csv += `# Harmonized: ${metadata._harmonizedAt}\n`;
  csv += `# FAIR Score: ${metadata._fairScore}\n`;
  csv += `# Rename flags: ${metadata._renameFlags.join(" | ") || "none"}\n`;
  csv += `# Unit normalization: ${JSON.stringify(metadata._unitNormalization?.detected || {})}\n`;
  csv += "#\n";

  if (records.length > 0) {
    const headers = Object.keys(records[0]);
    csv += headers.join(",") + "\n";
    records.forEach(r => {
      csv += headers.map(h => `"${(r[h] || "").toString().replace(/"/g, '""')}"`).join(",") + "\n";
    });
  } else {
    // No sample records — output field schema
    csv += "canonicalName,originalName,ontology,detectedUnit,missingValueStrategy,renamed\n";
    fields.forEach(f => {
      csv += `"${f.canonicalName}","${f.originalName}","${f.ontology}","${f.detectedUnit || ""}","${f.missingValueStrategy}","${f.renamed}"\n`;
    });
  }

  const filename = `${harmonizedDataset.id}_harmonized.csv`;
  const path = join(EXPORT_DIR, filename);
  writeFileSync(path, csv);
  return path;
}

function exportJSON(harmonizedDataset) {
  const { metadata, fields, records } = buildExportData(harmonizedDataset);

  const doc = {
    "@context": {
      dwc: "http://rs.tdwg.org/dwc/terms/",
      schema: "https://schema.org/",
      dc: "http://purl.org/dc/elements/1.1/",
      fair: "urn:fair:",
    },
    _metadata: metadata,
    dataset: {
      name: harmonizedDataset.name,
      domain: harmonizedDataset.domain,
      records: harmonizedDataset.records,
      sourceId: harmonizedDataset.sourceId,
    },
    fairScore: harmonizedDataset.fairScore,
    harmonization: {
      fields,
      unmappedFields: harmonizedDataset.harmonization.unmappedFields,
      unitNormalization: harmonizedDataset.harmonization.unitNormalization,
      notes: harmonizedDataset.harmonization.harmonizationNotes,
      transformationSummary: harmonizedDataset.transformationSummary,
    },
    sampleRecords: records,
  };

  const filename = `${harmonizedDataset.id}_harmonized.json`;
  const path = join(EXPORT_DIR, filename);
  writeFileSync(path, JSON.stringify(doc, null, 2));
  return path;
}

function exportExcel(harmonizedDataset) {
  // Generate Excel-compatible XML (SpreadsheetML) — no external dependency needed
  const { metadata, fields, records } = buildExportData(harmonizedDataset);

  const xmlEscape = (s) => String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">

  <Worksheet ss:Name="Harmonized Data">
    <Table>`;

  // Metadata header rows
  const metaRows = [
    ["Module 2 Harmonized Dataset", harmonizedDataset.name],
    ["Harmonized At", metadata._harmonizedAt],
    ["FAIR Score", metadata._fairScore],
    ["Rename Flags", metadata._renameFlags.join(" | ") || "none"],
    ["Domain", harmonizedDataset.domain],
    ["Records", harmonizedDataset.records],
    [],
  ];

  metaRows.forEach(row => {
    xml += "\n      <Row>";
    if (row.length === 0) {
      xml += "<Cell><Data ss:Type=\"String\"></Data></Cell>";
    } else {
      row.forEach(cell => {
        xml += `<Cell><Data ss:Type="String">${xmlEscape(cell)}</Data></Cell>`;
      });
    }
    xml += "</Row>";
  });

  // Data rows
  if (records.length > 0) {
    const headers = Object.keys(records[0]);
    xml += "\n      <Row>";
    headers.forEach(h => {
      xml += `<Cell><Data ss:Type="String">${xmlEscape(h)}</Data></Cell>`;
    });
    xml += "</Row>";

    records.forEach(r => {
      xml += "\n      <Row>";
      headers.forEach(h => {
        xml += `<Cell><Data ss:Type="String">${xmlEscape(r[h])}</Data></Cell>`;
      });
      xml += "</Row>";
    });
  } else {
    // Field schema sheet
    xml += "\n      <Row>";
    ["Canonical Name", "Original Name", "Ontology", "Unit", "Missing Value Strategy", "Renamed", "Flag"].forEach(h => {
      xml += `<Cell><Data ss:Type="String">${h}</Data></Cell>`;
    });
    xml += "</Row>";

    fields.forEach(f => {
      xml += "\n      <Row>";
      [f.canonicalName, f.originalName, f.ontology, f.detectedUnit || "", f.missingValueStrategy, f.renamed, f.renameFlag || ""].forEach(v => {
        xml += `<Cell><Data ss:Type="String">${xmlEscape(v)}</Data></Cell>`;
      });
      xml += "</Row>";
    });
  }

  xml += `
    </Table>
  </Worksheet>

  <Worksheet ss:Name="FAIR Score">
    <Table>
      <Row><Cell><Data ss:Type="String">Pillar</Data></Cell><Cell><Data ss:Type="String">Score</Data></Cell><Cell><Data ss:Type="String">Rationale</Data></Cell></Row>`;

  const fair = harmonizedDataset.fairScore;
  [
    ["Findability", fair.findability],
    ["Accessibility", fair.accessibility],
    ["Interoperability", fair.interoperability],
    ["Reusability", fair.reusability],
  ].forEach(([label, pillar]) => {
    xml += `\n      <Row><Cell><Data ss:Type="String">${label}</Data></Cell><Cell><Data ss:Type="Number">${pillar.score}</Data></Cell><Cell><Data ss:Type="String">${xmlEscape(pillar.rationale)}</Data></Cell></Row>`;
  });

  xml += `\n      <Row><Cell><Data ss:Type="String">Overall</Data></Cell><Cell><Data ss:Type="Number">${fair.overallScore}</Data></Cell><Cell><Data ss:Type="String">Weighted: F×0.2 + A×0.2 + I×0.4 + R×0.2</Data></Cell></Row>`;

  xml += `
    </Table>
  </Worksheet>

  <Worksheet ss:Name="Improvements">
    <Table>
      <Row><Cell><Data ss:Type="String">Recommended Improvements</Data></Cell></Row>`;

  (fair.improvements || []).forEach(imp => {
    xml += `\n      <Row><Cell><Data ss:Type="String">${xmlEscape(imp)}</Data></Cell></Row>`;
  });

  xml += `
    </Table>
  </Worksheet>
</Workbook>`;

  const filename = `${harmonizedDataset.id}_harmonized.xls`;
  const path = join(EXPORT_DIR, filename);
  writeFileSync(path, xml);
  return path;
}

// ── Generate dataset ID ───────────────────────────────────────────────────────
function makeDatasetId(name) {
  return "ds2_" + name.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").slice(0, 32) + "_" + Date.now();
}

// ── MCP tool definitions ──────────────────────────────────────────────────────
const TOOLS = {
  harmonize_dataset: {
    description: "Harmonize a structured metadata description into an AI-ready, FAIR-scored dataset. For each input field, queries OLS4 (EMBL-EBI's Ontology Lookup Service v4) for candidate ontology matches across Darwin Core, Schema.org, Dublin Core and other biomedical ontologies, then applies Claude-driven Darwin Core mapping, unit normalization, missing value strategies, field renaming with flags, and automatically hands off to Module 3.",
    inputSchema: {
      type: "object",
      required: ["name", "domain", "records"],
      properties: {
        name: { type: "string", description: "Dataset name" },
        domain: { type: "string", description: "Scientific domain" },
        records: { type: "number", description: "Number of records" },
        fields: { type: "array", items: { type: "string" }, description: "Field/column names" },
        description: { type: "string", description: "Free-text dataset description" },
        sourceId: { type: "string", description: "Upstream identifier (DOI, accession, etc.)" },
        units: { type: "object", description: "Explicit units per field: { field_name: unit_string }" },
      },
    },
  },

  get_harmonization_log: {
    description: "Returns the full activity log and list of all datasets harmonized in this session.",
    inputSchema: {
      type: "object",
      properties: {
        dataset_id: { type: "string", description: "Optional — filter log to a specific dataset ID" },
      },
    },
  },

  export_dataset: {
    description: "Export a harmonized dataset as CSV, JSON, or Excel. The exported file embeds FAIR scores, rename flags, and unit normalization metadata.",
    inputSchema: {
      type: "object",
      required: ["dataset_id", "format"],
      properties: {
        dataset_id: { type: "string", description: "Dataset ID returned by harmonize_dataset" },
        format: { type: "string", enum: ["csv", "json", "excel", "all"], description: "Export format" },
      },
    },
  },

  get_queue_status: {
    description: "Returns the status of datasets queued for Module 3 ingestion — includes dataset name, queue time, and attempt count.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  flush_queue: {
    description: "Retries all datasets currently queued for Module 3 ingestion. Use after Module 3 becomes available.",
    inputSchema: {
      type: "object",
      properties: {
        module3_server_path: { type: "string", description: "Optional — override path to Module 3 server.js" },
      },
    },
  },
};

// ── Tool execution ────────────────────────────────────────────────────────────
async function executeTool(name, args) {
  switch (name) {

    // ── 1. harmonize_dataset ─────────────────────────────────────────────────
    case "harmonize_dataset": {
      const log = [];
      const id = makeDatasetId(args.name);

      logEntry(`Starting harmonization: ${args.name}`);
      log.push(`Dataset: ${args.name} (${args.domain}, ${args.records} records)`);

      // Step 0: OLS4 ontology lookup for each input field (bioinformatics tool).
      // Fail-soft: any error here logs a warning and harmonization continues
      // without OLS4 context, falling back to Claude + the static mapping table.
      let ols4Candidates = null;
      const inputFields = Array.isArray(args.fields) ? args.fields : [];
      const fieldNames = inputFields
        .map(f => (typeof f === "string" ? f : f?.name || f?.field || ""))
        .filter(Boolean);

      if (fieldNames.length > 0) {
        log.push(`Calling OLS4 (EMBL-EBI Ontology Lookup Service v4) for ${fieldNames.length} field(s)...`);
        try {
          ols4Candidates = await ols4LookupFields(fieldNames, { limit: 5 });
          const fieldsWithHits = Object.values(ols4Candidates).filter(c => c.length > 0).length;
          log.push(`OLS4: ${fieldsWithHits}/${fieldNames.length} fields had candidate matches`);
        } catch (err) {
          log.push(`OLS4 lookup failed (${err.message}) — continuing without OLS4 context`);
          ols4Candidates = null;
        }
      }

      // Step 1: Field harmonization + ontology mapping (Claude, with OLS4 context)
      log.push("Calling Claude: field harmonization + Darwin Core mapping...");
      const harmonization = await claudeHarmonizeFields(args, ols4Candidates);
      const renamedCount = harmonization.harmonizedFields?.filter(f => f.renamed).length || 0;
      log.push(`Mapped ${harmonization.harmonizedFields?.length || 0} fields (${renamedCount} renamed)`);

      if (renamedCount > 0) {
        harmonization.harmonizedFields
          .filter(f => f.renamed)
          .forEach(f => log.push(`  FLAG: ${f.renameFlag}`));
      }

      if (harmonization.unmappedFields?.length > 0) {
        log.push(`Unmapped fields: ${harmonization.unmappedFields.join(", ")}`);
      }

      if (harmonization.unitNormalization?.conflicts?.length > 0) {
        log.push(`Unit conflicts detected: ${harmonization.unitNormalization.conflicts.join("; ")}`);
      }

      // Step 2: FAIR scoring
      log.push("Calling Claude: FAIR score calculation...");
      const fairScore = await claudeCalculateFAIRScore(args, harmonization);
      log.push(`FAIR score: ${fairScore.overallScore} (F:${fairScore.findability.score} A:${fairScore.accessibility.score} I:${fairScore.interoperability.score} R:${fairScore.reusability.score})`);

      // Step 3: Sample record transformation
      log.push("Calling Claude: generating sample transformed records...");
      const transformation = await claudeTransformRecords(args, harmonization);
      log.push(`Generated ${transformation.sampleRecords?.length || 0} sample records`);

      // Assemble harmonized dataset
      const harmonizedDataset = {
        id,
        name: args.name,
        domain: args.domain,
        records: args.records,
        sourceId: args.sourceId || null,
        harmonizedAt: new Date().toISOString(),
        harmonization,
        fairScore,
        sampleRecords: transformation.sampleRecords || [],
        transformationSummary: transformation.transformationSummary || "",
        log,
      };

      harmonizedDatasets.set(id, harmonizedDataset);
      logEntry(`Harmonization complete: ${args.name} (FAIR: ${fairScore.overallScore})`, "ok");

      // Step 4: Hand off to Module 3 (fire and forget)
      log.push("Handing off to Module 3...");
      const handoff = await handoffToModule3(harmonizedDataset);
      if (handoff.success) {
        log.push("Module 3 handoff: success");
      } else if (handoff.queued) {
        log.push(`Module 3 handoff: queued (${handoff.reason})`);
      }

      return {
        success: true,
        datasetId: id,
        name: args.name,
        fairScore: fairScore.overallScore,
        fairBreakdown: {
          findability: fairScore.findability.score,
          accessibility: fairScore.accessibility.score,
          interoperability: fairScore.interoperability.score,
          reusability: fairScore.reusability.score,
        },
        fieldsHarmonized: harmonization.harmonizedFields?.length || 0,
        fieldsRenamed: renamedCount,
        renameFlags: harmonization.harmonizedFields?.filter(f => f.renamed).map(f => f.renameFlag) || [],
        unmappedFields: harmonization.unmappedFields || [],
        unitConflicts: harmonization.unitNormalization?.conflicts || [],
        improvements: fairScore.improvements || [],
        transformationSummary: transformation.transformationSummary,
        module3Handoff: handoff,
        log,
      };
    }

    // ── 2. get_harmonization_log ─────────────────────────────────────────────
    case "get_harmonization_log": {
      const datasets = [...harmonizedDatasets.values()].map(d => ({
        id: d.id,
        name: d.name,
        domain: d.domain,
        records: d.records,
        fairScore: d.fairScore.overallScore,
        harmonizedAt: d.harmonizedAt,
        fieldsHarmonized: d.harmonization.harmonizedFields?.length || 0,
        fieldsRenamed: d.harmonization.harmonizedFields?.filter(f => f.renamed).length || 0,
      }));

      const filteredLog = args.dataset_id
        ? sessionLog.filter(e => e.message.includes(args.dataset_id))
        : sessionLog;

      return {
        totalHarmonized: harmonizedDatasets.size,
        datasets,
        queuedForModule3: module3Queue.length,
        sessionLog: filteredLog,
      };
    }

    // ── 3. export_dataset ────────────────────────────────────────────────────
    case "export_dataset": {
      const dataset = harmonizedDatasets.get(args.dataset_id);
      if (!dataset) {
        return { success: false, error: `Dataset not found: ${args.dataset_id}` };
      }

      const exports = {};
      const fmt = args.format;

      if (fmt === "csv" || fmt === "all")   exports.csv   = exportCSV(dataset);
      if (fmt === "json" || fmt === "all")  exports.json  = exportJSON(dataset);
      if (fmt === "excel" || fmt === "all") exports.excel = exportExcel(dataset);

      logEntry(`Exported ${args.dataset_id} as ${args.format}`, "ok");

      return {
        success: true,
        datasetId: args.dataset_id,
        name: dataset.name,
        files: exports,
        fairScore: dataset.fairScore.overallScore,
      };
    }

    // ── 4. get_queue_status ──────────────────────────────────────────────────
    case "get_queue_status": {
      return {
        queueLength: module3Queue.length,
        queue: module3Queue.map(q => ({
          datasetName: q.dataset.name,
          datasetId: q.dataset.id,
          queuedAt: q.queuedAt,
          attempts: q.attempts,
          fairScore: q.dataset.fairScore.overallScore,
        })),
        module3ServerConfigured: !!MODULE3_SERVER,
        hint: MODULE3_SERVER ? null : "Set MODULE3_SERVER_PATH env var to enable automatic handoff",
      };
    }

    // ── 5. flush_queue ───────────────────────────────────────────────────────
    case "flush_queue": {
      if (module3Queue.length === 0) {
        return { success: true, message: "Queue is empty — nothing to flush" };
      }

      if (args.module3_server_path) {
        process.env.MODULE3_SERVER_PATH = args.module3_server_path;
      }

      const results = [];
      const toRemove = [];

      for (let i = 0; i < module3Queue.length; i++) {
        const item = module3Queue[i];
        item.attempts++;
        const handoff = await handoffToModule3(item.dataset);
        if (handoff.success) {
          toRemove.push(i);
          results.push({ name: item.dataset.name, status: "sent" });
          logEntry(`Queue flush: sent ${item.dataset.name} to Module 3`, "ok");
        } else {
          results.push({ name: item.dataset.name, status: "failed", reason: handoff.reason });
          logEntry(`Queue flush: failed ${item.dataset.name} — ${handoff.reason}`, "warn");
        }
      }

      // Remove successfully sent items (reverse order to preserve indices)
      toRemove.reverse().forEach(i => module3Queue.splice(i, 1));

      return {
        success: true,
        attempted: results.length,
        sent: results.filter(r => r.status === "sent").length,
        failed: results.filter(r => r.status === "failed").length,
        remaining: module3Queue.length,
        results,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP stdio protocol ────────────────────────────────────────────────────────
function mcpResponse(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function mcpError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(req) {
  const { id, method, params } = req;

  if (method === "initialize") {
    return mcpResponse(id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: {
        name: "kg-module2",
        version: "1.0.0",
        description: "Module 2: Data Harmonization (MCP, stdio, local)",
      },
    });
  }

  if (method === "tools/list") {
    return mcpResponse(id, {
      tools: Object.entries(TOOLS).map(([name, def]) => ({
        name,
        description: def.description,
        inputSchema: def.inputSchema,
      })),
    });
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params;
    if (!TOOLS[name]) return mcpError(id, -32601, `Tool not found: ${name}`);
    try {
      const result = await executeTool(name, args || {});
      return mcpResponse(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (err) {
      return mcpError(id, -32603, err.message);
    }
  }

  if (method === "notifications/initialized") return null;

  return mcpError(id, -32601, `Method not found: ${method}`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    process.stdout.write(mcpError(null, -32700, "Parse error") + "\n");
    return;
  }
  const response = await handleRequest(req);
  if (response) process.stdout.write(response + "\n");
});

process.stderr.write("[kg-module2] MCP server ready (stdio)\n");
