#!/usr/bin/env node
/**
 * Module 1: Legacy Database Discovery — MCP Server
 * Transport: stdio (local)
 *
 * Tools exposed:
 *   1. search_pubmed         — search PubMed with free-text keywords, extract legacy database references
 *   2. get_discovery_log     — return all databases discovered this session with rankings
 *   3. review_databases      — present ranked list for researcher review; approve by threshold or manually
 *   4. send_to_module2       — send approved databases to Module 2 harmonize_dataset
 *   5. get_session_status    — return counts, FAIR score summary, pending approvals
 */

import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as readline from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, "../data/registry.json");
const MODULE2_SERVER = process.env.MODULE2_SERVER_PATH || null;

// ── Anthropic client ──────────────────────────────────────────────────────────
const anthropic = new Anthropic();

// ── In-memory session state ───────────────────────────────────────────────────
// registry: persisted canonical database entries across sessions
// pendingApproval: databases awaiting researcher review before Module 2 handoff
let registry = loadRegistry();
let pendingApproval = [];   // [{ id, entry, score, source }]
let sessionLog = [];
let searchHistory = [];

function loadRegistry() {
  if (existsSync(REGISTRY_PATH)) {
    try { return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")); }
    catch { return {}; }
  }
  return {};
}

function saveRegistry() {
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

function logEntry(msg, type = "info") {
  const entry = { timestamp: new Date().toISOString(), type, message: msg };
  sessionLog.push(entry);
  process.stderr.write(`[kg-module1] [${type}] ${msg}\n`);
  return entry;
}

// ── PubMed API helpers ────────────────────────────────────────────────────────
const PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

async function pubmedSearch(queries, maxResults = 100, yearCutoff = null) {
  // Build combined query from multiple keyword strings joined with OR.
  // Date filtering uses separate mindate/maxdate URL parameters — NOT embedded
  // inside the term string, which causes double-encoding and zero results.
  const combined = queries.map(q => `(${q})`).join(" OR ");

  let searchUrl =
    `${PUBMED_BASE}/esearch.fcgi?db=pubmed` +
    `&term=${encodeURIComponent(combined)}` +
    `&retmax=${maxResults}` +
    `&retmode=json`;

  if (yearCutoff) {
    searchUrl += `&datetype=pdat&mindate=1800/01/01&maxdate=${yearCutoff}/12/31`;
  }

  let searchRes;
  try {
    searchRes = await fetch(searchUrl);
  } catch (netErr) {
    throw new Error(`PubMed network error: ${netErr.message}. URL attempted: ${searchUrl}`);
  }

  if (!searchRes.ok) {
    const body = await searchRes.text().catch(() => "");
    throw new Error(`PubMed HTTP ${searchRes.status}: ${body.slice(0, 200)}`);
  }

  const rawText = await searchRes.text();
  let searchData;
  try {
    searchData = JSON.parse(rawText);
  } catch {
    throw new Error(`PubMed returned non-JSON: ${rawText.slice(0, 200)}`);
  }

  const allIds = searchData.esearchresult?.idlist || [];
  const resultCount = searchData.esearchresult?.count || "0";
  process.stderr.write(`[kg-module1] PubMed: ${resultCount} total matches, returning ${allIds.length} IDs\n`);

  if (allIds.length === 0) return [];

  // Post-filter by year as a safety net in case API date filter is inconsistent
  const ids = allIds;

  // Fetch abstracts and metadata in batches of 20
  const papers = [];
  const batchSize = 20;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const fetchUrl = `${PUBMED_BASE}/efetch.fcgi?db=pubmed&id=${batch.join(",")}&retmode=xml&rettype=abstract`;
    const fetchRes = await fetch(fetchUrl);
    if (!fetchRes.ok) continue;
    const xml = await fetchRes.text();
    const parsed = parsePubMedXML(xml);
    papers.push(...parsed);
  }

  // Post-filter: discard any papers beyond the year cutoff that slipped through
  if (yearCutoff) {
    return papers.filter(p => p.year > 0 && p.year <= yearCutoff);
  }
  return papers;
}

function parsePubMedXML(xml) {
  const papers = [];
  const articleMatches = xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g);

  for (const match of articleMatches) {
    const article = match[1];

    const pmid = extractXML(article, "PMID") || "";
    const title = extractXML(article, "ArticleTitle") || "";
    const abstract = extractXML(article, "AbstractText") || "";
    const yearStr = extractXML(article, "PubDate>.*?<Year") || extractXML(article, "Year") || "";
    const year = parseInt(yearStr.match(/\d{4}/)?.[0] || "0");

    // Extract author list
    const authorMatches = [...article.matchAll(/<LastName>(.*?)<\/LastName>/g)];
    const authors = authorMatches.slice(0, 3).map(m => m[1]).join(", ");

    // Extract journal
    const journal = extractXML(article, "Title") || extractXML(article, "ISOAbbreviation") || "";

    if (pmid && (title || abstract)) {
      papers.push({ pmid, title, abstract, year, authors, journal });
    }
  }

  return papers;
}

function extractXML(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag.split(">")[0].split(" ")[0]}>`, "i"));
  return match ? match[1].replace(/<[^>]+>/g, "").trim() : null;
}

// ── Web fetch helper for database URL checking ────────────────────────────────
async function tryFetchURL(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; research-bot/1.0)" }
    });
    clearTimeout(timeout);
    const text = await res.text();
    return {
      reachable: res.ok,
      status: res.status,
      snippet: text.slice(0, 2000),
      abandoned: !res.ok
    };
  } catch (err) {
    return {
      reachable: false,
      status: 0,
      snippet: "",
      abandoned: true,
      error: err.message
    };
  }
}

// ── Claude reasoning calls ────────────────────────────────────────────────────
async function claudeExtractDatabases(paper, yearCutoff) {
  const prompt = `You are a legacy database discovery engine analyzing a scientific paper to identify explicitly named and cited databases.

Paper details:
- PMID: ${paper.pmid}
- Title: ${paper.title}
- Year: ${paper.year}
- Authors: ${paper.authors}
- Journal: ${paper.journal}
- Abstract: ${paper.abstract}

Year cutoff: ${yearCutoff || "none specified"}

Your task: Identify every database that is EXPLICITLY named and cited in this paper. Do not infer databases from context — only include ones clearly named.

For each database found, assess whether it is a LEGACY database. A legacy database must meet ALL THREE of these criteria:
1. Pre-relational structure: flat-file, hierarchical, or network model (not a modern relational/SQL database)
2. No MCP integration: does not have a known modern API or MCP-ready data access layer in its CURRENT state
3. Old: typically created or primarily used before the relational database era (pre-1990s to early 2000s)

Examples of legacy databases (meet all 3 criteria):
- Early flat-file sequence archives (pre-INSDC era GenBank flat files, PIR protein sequence library)
- Hierarchical protein databases from the 1980s (NBRF, Atlas of Protein Sequence and Structure)
- Network-model chemical databases (early CAS registry flat exports)
- Abandoned taxonomy flat files (early ITIS text dumps)
- Pre-web ecology datasets stored as fixed-width text files

Examples that are NOT legacy (fail one or more criteria):
- Modern GenBank (has NCBI E-utilities API — fails criterion 2)
- UniProt (has REST API — fails criterion 2)
- KEGG (has API — fails criterion 2)
- Any PostgreSQL/MySQL database (relational — fails criterion 1)

Return ONLY a JSON object with no markdown or preamble:
{
  "databases": [
    {
      "name": "exact name as cited in paper",
      "isLegacy": true,
      "legacyReason": "which criteria it meets and why",
      "notLegacyReason": null,
      "url": "URL if mentioned in paper, or null",
      "accessionPatterns": ["any accession number patterns mentioned, e.g. AB123456"],
      "domain": "scientific domain (Genomics, Proteomics, Chemistry, Ecology, etc.)",
      "description": "what the paper says this database contains",
      "inferredFields": [
        {"name": "field_name", "confidence": "inferred", "reason": "why inferred from domain"}
      ],
      "explicitFields": ["fields explicitly named in the paper"],
      "yearOfDatabase": "estimated creation year if mentioned or inferable",
      "citationContext": "exact sentence or phrase from abstract that names this database"
    }
  ],
  "nonLegacyDatabases": ["names of databases found but excluded because they are not legacy"],
  "extractionNotes": "any notes about the extraction"
}`;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }]
  });

  const text = response.content.map(b => b.text || "").join("");
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { databases: [], nonLegacyDatabases: [], extractionNotes: "Parse error" };
  }
}

async function claudeCheckMCPReadiness(dbName, url, urlData) {
  const urlContext = urlData
    ? `URL status: ${urlData.reachable ? "reachable" : "unreachable/dead"} (HTTP ${urlData.status})
Page snippet: ${urlData.snippet.slice(0, 500)}`
    : "No URL available to check.";

  const prompt = `You are checking whether a database has a modern API or MCP-ready data access layer in its CURRENT state (2026).

Database name: ${dbName}
URL provided: ${url || "none"}
${urlContext}

Determine:
1. Does this database currently have a known REST API, SOAP API, or other programmatic access layer?
2. Does it have an MCP server or MCP-compatible endpoint?
3. Is it actively maintained with modern data access?

Known databases WITH modern APIs (not legacy): NCBI/GenBank (E-utilities), UniProt (REST), KEGG (API), PDB (REST), ChEMBL (REST), Ensembl (REST), STRING (API).

Return ONLY a JSON object:
{
  "hasMCPOrAPI": true|false,
  "apiDescription": "what API exists if any, or null",
  "isActivelyMaintained": true|false,
  "urlAbandoned": true|false,
  "evidence": "one sentence explaining your determination",
  "confidence": "high|medium|low"
}`;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }]
  });

  const text = response.content.map(b => b.text || "").join("");
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { hasMCPOrAPI: false, urlAbandoned: false, evidence: "Could not determine", confidence: "low" };
  }
}

async function claudeScoreFAIR(db, urlData, mcpCheck, paper) {
  const prompt = `You are a FAIR data scoring engine assessing a legacy scientific database discovered via a PubMed paper citation.

Database: ${db.name}
Domain: ${db.domain}
Description: ${db.description}
Year of database: ${db.yearOfDatabase || "unknown"}
URL provided: ${db.url || "none"}
URL reachable: ${urlData ? (urlData.reachable ? "yes" : "no — dead/abandoned") : "not checked"}
Has modern API: ${mcpCheck.hasMCPOrAPI ? "yes — " + mcpCheck.apiDescription : "no"}
URL abandoned: ${mcpCheck.urlAbandoned || urlData?.abandoned ? "yes (evidence of abandonment)" : "no"}
Explicit fields mentioned in paper: ${db.explicitFields?.join(", ") || "none"}
Inferred fields: ${db.inferredFields?.map(f => f.name).join(", ") || "none"}
Source paper year: ${paper.year}
Citation context: "${db.citationContext}"

Score each FAIR pillar 0.0–1.0 for this DATABASE (not the paper):
- Findability: does it have a persistent identifier, is it named consistently, is it findable today?
- Accessibility: can its data be accessed programmatically or at all?
- Interoperability: does it use standard formats or vocabularies?
- Reusability: is there a license, provenance, or description sufficient for reuse?

A dead URL with no API and sparse metadata should score LOW. An abandoned database should score lower on Accessibility but may score higher on Findability if it is well-named.

Return ONLY a JSON object:
{
  "findability": { "score": 0.0, "rationale": "one sentence" },
  "accessibility": { "score": 0.0, "rationale": "one sentence" },
  "interoperability": { "score": 0.0, "rationale": "one sentence" },
  "reusability": { "score": 0.0, "rationale": "one sentence" },
  "overallScore": 0.0,
  "legacyScore": 0.0,
  "improvements": ["specific improvements that would increase FAIR score"],
  "abandonmentEvidence": "description of evidence that this database is abandoned or legacy, or null"
}

legacyScore: 0.0–1.0 where 1.0 = strongly legacy (dead URL, no API, pre-relational, sparse metadata). This is separate from FAIR and used for ranking.
overallScore: weighted average F×0.25 + A×0.25 + I×0.25 + R×0.25`;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }]
  });

  const text = response.content.map(b => b.text || "").join("");
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return {
      findability: { score: 0.5, rationale: "Could not calculate" },
      accessibility: { score: 0.5, rationale: "Could not calculate" },
      interoperability: { score: 0.5, rationale: "Could not calculate" },
      reusability: { score: 0.5, rationale: "Could not calculate" },
      overallScore: 0.5,
      legacyScore: 0.5,
      improvements: [],
      abandonmentEvidence: null
    };
  }
}

// ── Deduplication ─────────────────────────────────────────────────────────────
function normalizeDbName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

function jaccardSim(a, b) {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const intersection = [...setA].filter(t => setB.has(t)).length;
  return intersection / (setA.size + setB.size - intersection);
}

function findDuplicate(name, url, accessions, threshold = 0.72) {
  const normName = normalizeDbName(name);
  const normUrl = url ? url.toLowerCase().replace(/https?:\/\/(www\.)?/, "").split("/")[0] : null;

  for (const [id, entry] of Object.entries(registry)) {
    // Name match
    const sim = jaccardSim(
      name.toLowerCase(),
      entry.name.toLowerCase()
    );
    if (sim >= threshold) return id;

    // Exact normalized name match
    if (normalizeDbName(entry.name) === normName) return id;

    // URL domain match
    if (normUrl && entry.url) {
      const entryDomain = entry.url.toLowerCase().replace(/https?:\/\/(www\.)?/, "").split("/")[0];
      if (normUrl === entryDomain) return id;
    }

    // Accession pattern overlap
    if (accessions?.length && entry.accessionPatterns?.length) {
      const overlap = accessions.some(a => entry.accessionPatterns.includes(a));
      if (overlap) return id;
    }
  }
  return null;
}

function makeDbId(name) {
  return "db1_" + name.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").slice(0, 36) + "_" + Date.now();
}

// ── Module 2 handoff ──────────────────────────────────────────────────────────
async function sendToModule2(entry) {
  const payload = {
    name: entry.name,
    domain: entry.domain,
    records: entry.estimatedRecords || 0,
    fairScore: entry.fairScore.overallScore,
    fields: [
      ...(entry.explicitFields || []),
      ...(entry.inferredFields?.map(f => `${f.name} [inferred]`) || [])
    ],
    description: `Legacy database discovered via PubMed. ${entry.description || ""}. ${entry.fairScore.abandonmentEvidence || ""}`.trim(),
    sourceId: entry.url || `urn:pubmed:${entry.sourcePMIDs?.join(",")}`,
    units: {}
  };

  if (!MODULE2_SERVER) {
    logEntry(`Module 2 path not configured — cannot send ${entry.name}`, "warn");
    return { success: false, reason: "MODULE2_SERVER_PATH not set" };
  }

  try {
    const { spawn } = await import("child_process");
    const { createInterface } = await import("readline");

    const server = spawn("node", [MODULE2_SERVER], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env }
    });

    const rl = createInterface({ input: server.stdout, terminal: false });
    let msgId = 1;
    const pending = new Map();

    rl.on("line", line => {
      try {
        const msg = JSON.parse(line);
        const resolve = pending.get(msg.id);
        if (resolve) { pending.delete(msg.id); resolve(msg); }
      } catch { }
    });

    const send = (method, params = {}) => new Promise(resolve => {
      const id = msgId++;
      pending.set(id, resolve);
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

    await send("initialize", {
      protocolVersion: "2025-11-25",
      clientInfo: { name: "kg-module1", version: "1.0.0" },
      capabilities: {}
    });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const id = msgId++;
    server.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id,
      method: "tools/call",
      params: { name: "harmonize_dataset", arguments: payload }
    }) + "\n");

    setTimeout(() => { server.kill(); }, 60000);

    logEntry(`Sent to Module 2: ${entry.name}`, "ok");
    return { success: true, payload };
  } catch (err) {
    logEntry(`Module 2 handoff failed for ${entry.name}: ${err.message}`, "warn");
    return { success: false, reason: err.message };
  }
}

// ── Tool handlers ─────────────────────────────────────────────────────────────
const TOOLS = {
  search_pubmed: {
    description: "Search PubMed with one or more free-text keyword queries, extract legacy database references from matching papers, score them with FAIR principles, and add them to the discovery registry. Legacy databases must meet all three criteria: pre-relational structure, no current MCP/API access, and evidence of being old or abandoned.",
    inputSchema: {
      type: "object",
      required: ["queries"],
      properties: {
        queries: { type: "array", items: { type: "string" }, description: "One or more free-text search queries. Results are combined with OR." },
        max_results: { type: "number", description: "Max papers to retrieve (default 100, range 10–500)" },
        year_cutoff: { type: "number", description: "Only include papers published on or before this year (e.g. 2005). Omit for no cutoff." },
        dedup_threshold: { type: "number", description: "Similarity threshold for database deduplication (default 0.72)" }
      }
    }
  },

  get_discovery_log: {
    description: "Return all legacy databases discovered this session, ranked by legacy score (most abandoned/legacy first) and FAIR score. Shows full metadata including citation sources, field lists, and scoring rationale.",
    inputSchema: {
      type: "object",
      properties: {
        min_fair_score: { type: "number", description: "Filter to databases with FAIR score at or above this value" },
        min_legacy_score: { type: "number", description: "Filter to databases with legacy score at or above this value" },
        sort_by: { type: "string", enum: ["legacy_score", "fair_score", "name", "year"], description: "Sort field (default: legacy_score)" }
      }
    }
  },

  review_databases: {
    description: "Present the ranked list of discovered databases for researcher review. Approve all databases above a FAIR score threshold for Module 2 handoff, or manually select specific databases by ID. Returns the list of what is now pending approval.",
    inputSchema: {
      type: "object",
      properties: {
        approve_threshold: { type: "number", description: "Auto-approve all databases with FAIR score >= this value (e.g. 0.75). If omitted, no auto-approval." },
        approve_ids: { type: "array", items: { type: "string" }, description: "Specific database IDs to manually approve regardless of score." },
        reject_ids: { type: "array", items: { type: "string" }, description: "Specific database IDs to reject and remove from pending." }
      }
    }
  },

  send_to_module2: {
    description: "Send all approved databases to Module 2 for harmonization. Requires databases to have been approved via review_databases first. Calls Module 2 harmonize_dataset for each approved entry.",
    inputSchema: {
      type: "object",
      properties: {
        module2_server_path: { type: "string", description: "Optional override path to Module 2 server.js" },
        approved_only: { type: "boolean", description: "If true (default), only send approved databases. If false, send all discovered databases." }
      }
    }
  },

  get_session_status: {
    description: "Return current session statistics: papers searched, databases discovered, registry size, pending approvals, FAIR score summary, and session log.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
};

async function executeTool(name, args) {
  switch (name) {

    // ── 1. search_pubmed ────────────────────────────────────────────────────
    case "search_pubmed": {
      const queries = args.queries || [];
      const maxResults = Math.min(Math.max(args.max_results || 100, 10), 500);
      const yearCutoff = args.year_cutoff || null;
      const dedupThreshold = args.dedup_threshold || 0.72;
      const log = [];
      const newDatabases = [];
      const updatedDatabases = [];

      if (queries.length === 0) return { success: false, error: "At least one query required" };

      // ── Disambiguate queries before sending to PubMed ──────────────────────
      // Only expand genuine single-word acronyms that are known to collide
      // with unrelated biology terms (e.g. PIR = piRNAs vs Protein Information
      // Resource). Clear multi-word queries are passed through unchanged.
      logEntry(`Disambiguating ${queries.length} quer${queries.length === 1 ? "y" : "ies"}...`);
      const disambigPrompt = `You are a PubMed search query expert helping avoid acronym collisions.

Original queries:
${queries.map((q, i) => `${i + 1}. ${q}`).join("\n")}

Rules:
1. If a query is already a clear multi-word phrase (3+ words), return it UNCHANGED.
2. If a query is a short acronym or 1-2 word phrase that could collide with unrelated biology terms, expand it minimally — add 1-2 clarifying words maximum.
3. NEVER rewrite a query into a long specific phrase. Short queries should stay short.
4. NEVER add words like "legacy", "historical", "deprecated", "discontinued", "flat-file" unless the researcher used those words.

Examples of correct behavior:
- "protein" → "protein" (already clear, return unchanged)
- "SWISS-PROT" → "SWISS-PROT" (already unambiguous, return unchanged)
- "PIR database" → "PIR protein database" (minimal expansion to avoid piRNA collision)
- "Protein Information Resource" → "Protein Information Resource" (already clear)
- "database 1990s" → "database 1990s" (researcher's own words, unchanged)

Return ONLY a JSON object with no markdown:
{"disambiguated": ["query 1", "query 2"]}`;

      let finalQueries = queries;
      try {
        const dr = await anthropic.messages.create({
          model: "claude-opus-4-6",
          max_tokens: 400,
          messages: [{ role: "user", content: disambigPrompt }]
        });
        const dText = dr.content.map(b => b.text || "").join("");
        const dData = JSON.parse(dText.replace(/```json|```/g, "").trim());
        if (dData.disambiguated?.length === queries.length) {
          finalQueries = dData.disambiguated;
          const changed = queries.filter((q, i) => q !== finalQueries[i]);
          if (changed.length > 0) {
            log.push(`Original queries: ${queries.join(" | ")}`);
            log.push(`Disambiguated:    ${finalQueries.join(" | ")}`);
          } else {
            log.push(`Queries passed through unchanged`);
          }
        }
      } catch {
        log.push(`Query disambiguation skipped — using original queries`);
      }

      logEntry(`Searching PubMed: [${finalQueries.join(", ")}] max=${maxResults} cutoff=${yearCutoff || "none"}`);
      log.push(`Max results: ${maxResults}, Year cutoff: ${yearCutoff || "none"}`);

      // Search PubMed
      let papers;
      try {
        papers = await pubmedSearch(finalQueries, maxResults, yearCutoff);
        log.push(`PubMed returned ${papers.length} papers`);
        searchHistory.push({ queries: finalQueries, originalQueries: queries, maxResults, yearCutoff, paperCount: papers.length, timestamp: new Date().toISOString() });
      } catch (err) {
        return { success: false, error: `PubMed search failed: ${err.message}` };
      }

      if (papers.length === 0) {
        return { success: true, papersSearched: 0, newDatabases: 0, message: "No papers found matching your queries." };
      }

      // Process each paper
      for (const paper of papers) {
        log.push(`\nProcessing: [PMID ${paper.pmid}] ${paper.title.slice(0, 60)}...`);

        // Extract database references via Claude
        const extracted = await claudeExtractDatabases(paper, yearCutoff);

        if (!extracted.databases || extracted.databases.length === 0) {
          log.push(`  No legacy databases found`);
          if (extracted.nonLegacyDatabases?.length > 0) {
            log.push(`  Non-legacy databases excluded: ${extracted.nonLegacyDatabases.join(", ")}`);
          }
          continue;
        }

        log.push(`  Found ${extracted.databases.length} legacy database(s)`);

        for (const db of extracted.databases) {
          if (!db.isLegacy) {
            log.push(`  Skipped (not legacy): ${db.name} — ${db.notLegacyReason}`);
            continue;
          }

          // Check for duplicate in registry
          const dupId = findDuplicate(db.name, db.url, db.accessionPatterns, dedupThreshold);

          if (dupId) {
            const existing = registry[dupId];
            // Only update if this paper is more recent
            if (paper.year > (existing.mostRecentPaperYear || 0)) {
              log.push(`  Duplicate found: "${db.name}" matches "${existing.name}" — updating from more recent paper (${paper.year})`);

              // Re-score with new paper data
              let urlData = null;
              if (db.url && db.url !== existing.url) {
                urlData = await tryFetchURL(db.url);
                if (urlData.abandoned) log.push(`  URL ${db.url} is dead — logging as abandonment evidence`);
              }

              const mcpCheck = await claudeCheckMCPReadiness(db.name, db.url, urlData);
              const fairScore = await claudeScoreFAIR(db, urlData, mcpCheck, paper);

              registry[dupId] = {
                ...existing,
                fairScore,
                mcpCheck,
                mostRecentPaperYear: paper.year,
                sourcePMIDs: [...new Set([...(existing.sourcePMIDs || []), paper.pmid])],
                updatedAt: new Date().toISOString()
              };
              updatedDatabases.push(dupId);
            } else {
              log.push(`  Duplicate found: "${db.name}" matches "${existing.name}" — skipping (existing entry is from equal or more recent paper)`);
              // Still add PMID to sources
              if (!registry[dupId].sourcePMIDs?.includes(paper.pmid)) {
                registry[dupId].sourcePMIDs = [...(registry[dupId].sourcePMIDs || []), paper.pmid];
              }
            }
            continue;
          }

          // New database — full pipeline
          log.push(`  New legacy database: ${db.name}`);

          // Check URL
          let urlData = null;
          if (db.url) {
            log.push(`  Checking URL: ${db.url}`);
            urlData = await tryFetchURL(db.url);
            if (urlData.abandoned) {
              log.push(`  URL is dead — logging as abandonment evidence (legacy score boost)`);
            } else {
              log.push(`  URL is reachable (HTTP ${urlData.status})`);
            }
          }

          // MCP/API readiness check
          log.push(`  Checking MCP/API readiness...`);
          const mcpCheck = await claudeCheckMCPReadiness(db.name, db.url, urlData);
          log.push(`  MCP/API: ${mcpCheck.hasMCPOrAPI ? "HAS API — " + mcpCheck.apiDescription : "no API found"} (confidence: ${mcpCheck.confidence})`);

          if (mcpCheck.hasMCPOrAPI && mcpCheck.confidence === "high") {
            log.push(`  Skipping: database has a known modern API — not legacy by criterion 2`);
            continue;
          }

          // FAIR scoring
          log.push(`  Scoring FAIR...`);
          const fairScore = await claudeScoreFAIR(db, urlData, mcpCheck, paper);
          log.push(`  FAIR: ${fairScore.overallScore.toFixed(2)} | Legacy: ${fairScore.legacyScore.toFixed(2)}`);

          // Build registry entry
          const id = makeDbId(db.name);
          const entry = {
            id,
            name: db.name,
            domain: db.domain,
            description: db.description,
            url: db.url || null,
            accessionPatterns: db.accessionPatterns || [],
            explicitFields: db.explicitFields || [],
            inferredFields: db.inferredFields || [],
            yearOfDatabase: db.yearOfDatabase || null,
            estimatedRecords: null,
            citationContext: db.citationContext,
            legacyReason: db.legacyReason,
            fairScore,
            mcpCheck,
            urlAbandoned: urlData?.abandoned || false,
            sourcePMIDs: [paper.pmid],
            sourceTitle: paper.title,
            mostRecentPaperYear: paper.year,
            approved: false,
            addedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          registry[id] = entry;
          newDatabases.push(id);
          log.push(`  Registered: ${id}`);
        }
      }

      saveRegistry();

      // Summary
      const allEntries = Object.values(registry);
      log.push(`\nSearch complete. Registry now contains ${allEntries.length} legacy databases.`);

      return {
        success: true,
        papersSearched: papers.length,
        newDatabasesFound: newDatabases.length,
        databasesUpdated: updatedDatabases.length,
        totalInRegistry: Object.keys(registry).length,
        newDatabases: newDatabases.map(id => ({
          id,
          name: registry[id].name,
          domain: registry[id].domain,
          fairScore: registry[id].fairScore.overallScore,
          legacyScore: registry[id].fairScore.legacyScore,
          urlAbandoned: registry[id].urlAbandoned
        })),
        log
      };
    }

    // ── 2. get_discovery_log ────────────────────────────────────────────────
    case "get_discovery_log": {
      const minFair = args.min_fair_score ?? 0;
      const minLegacy = args.min_legacy_score ?? 0;
      const sortBy = args.sort_by || "legacy_score";

      let entries = Object.values(registry).filter(e =>
        e.fairScore.overallScore >= minFair &&
        e.fairScore.legacyScore >= minLegacy
      );

      entries.sort((a, b) => {
        switch (sortBy) {
          case "fair_score": return b.fairScore.overallScore - a.fairScore.overallScore;
          case "name": return a.name.localeCompare(b.name);
          case "year": return (b.mostRecentPaperYear || 0) - (a.mostRecentPaperYear || 0);
          default: return b.fairScore.legacyScore - a.fairScore.legacyScore;
        }
      });

      return {
        totalInRegistry: Object.keys(registry).length,
        filtered: entries.length,
        sortedBy: sortBy,
        databases: entries.map(e => ({
          id: e.id,
          name: e.name,
          domain: e.domain,
          fairScore: e.fairScore.overallScore,
          legacyScore: e.fairScore.legacyScore,
          urlAbandoned: e.urlAbandoned,
          hasMCPOrAPI: e.mcpCheck?.hasMCPOrAPI || false,
          approved: e.approved,
          sourcePapers: e.sourcePMIDs?.length || 0,
          mostRecentPaperYear: e.mostRecentPaperYear,
          yearOfDatabase: e.yearOfDatabase,
          explicitFields: e.explicitFields,
          inferredFields: e.inferredFields?.map(f => `${f.name} [inferred]`) || [],
          description: e.description,
          legacyReason: e.legacyReason,
          abandonmentEvidence: e.fairScore.abandonmentEvidence,
          fairBreakdown: {
            findability: e.fairScore.findability.score,
            accessibility: e.fairScore.accessibility.score,
            interoperability: e.fairScore.interoperability.score,
            reusability: e.fairScore.reusability.score
          },
          improvements: e.fairScore.improvements
        }))
      };
    }

    // ── 3. review_databases ─────────────────────────────────────────────────
    case "review_databases": {
      const threshold = args.approve_threshold ?? null;
      const approveIds = args.approve_ids || [];
      const rejectIds = args.reject_ids || [];
      const log = [];
      let autoApproved = 0;
      let manualApproved = 0;
      let rejected = 0;

      // Auto-approve by threshold
      if (threshold !== null) {
        for (const [id, entry] of Object.entries(registry)) {
          if (entry.fairScore.overallScore >= threshold && !entry.approved) {
            registry[id].approved = true;
            const alreadyPending = pendingApproval.some(p => p.id === id);
            if (!alreadyPending) {
              pendingApproval.push({ id, entry: registry[id], approvedAt: new Date().toISOString(), method: "threshold" });
            }
            autoApproved++;
            log.push(`Auto-approved: ${entry.name} (FAIR: ${entry.fairScore.overallScore.toFixed(2)} >= ${threshold})`);
          }
        }
      }

      // Manual approval by ID
      for (const id of approveIds) {
        if (registry[id]) {
          registry[id].approved = true;
          const alreadyPending = pendingApproval.some(p => p.id === id);
          if (!alreadyPending) {
            pendingApproval.push({ id, entry: registry[id], approvedAt: new Date().toISOString(), method: "manual" });
          }
          manualApproved++;
          log.push(`Manually approved: ${registry[id].name}`);
        } else {
          log.push(`ID not found: ${id}`);
        }
      }

      // Rejections
      for (const id of rejectIds) {
        if (registry[id]) {
          registry[id].approved = false;
          const idx = pendingApproval.findIndex(p => p.id === id);
          if (idx >= 0) pendingApproval.splice(idx, 1);
          rejected++;
          log.push(`Rejected: ${registry[id].name}`);
        }
      }

      saveRegistry();

      // Return full ranked list for researcher review
      const allRanked = Object.values(registry)
        .sort((a, b) => b.fairScore.legacyScore - a.fairScore.legacyScore)
        .map(e => ({
          id: e.id,
          name: e.name,
          domain: e.domain,
          fairScore: e.fairScore.overallScore,
          legacyScore: e.fairScore.legacyScore,
          approved: e.approved,
          urlAbandoned: e.urlAbandoned,
          description: e.description?.slice(0, 120),
          sourcePapers: e.sourcePMIDs?.length || 0
        }));

      return {
        success: true,
        autoApproved,
        manualApproved,
        rejected,
        pendingApprovalCount: pendingApproval.length,
        pendingApproval: pendingApproval.map(p => ({
          id: p.id,
          name: p.entry.name,
          fairScore: p.entry.fairScore.overallScore,
          legacyScore: p.entry.fairScore.legacyScore,
          approvedAt: p.approvedAt,
          method: p.method
        })),
        fullRankedList: allRanked,
        log
      };
    }

    // ── 4. send_to_module2 ──────────────────────────────────────────────────
    case "send_to_module2": {
      if (args.module2_server_path) {
        process.env.MODULE2_SERVER_PATH = args.module2_server_path;
      }

      const sendAll = args.approved_only === false;
      const toSend = sendAll
        ? Object.values(registry)
        : pendingApproval.map(p => p.entry);

      if (toSend.length === 0) {
        return {
          success: false,
          error: sendAll
            ? "No databases in registry."
            : "No databases approved. Use review_databases to approve databases first."
        };
      }

      const results = [];
      for (const entry of toSend) {
        logEntry(`Sending to Module 2: ${entry.name}`);
        const result = await sendToModule2(entry);
        results.push({ name: entry.name, id: entry.id, ...result });

        if (result.success) {
          // Remove from pending after successful send
          const idx = pendingApproval.findIndex(p => p.id === entry.id);
          if (idx >= 0) pendingApproval.splice(idx, 1);
          registry[entry.id].sentToModule2 = true;
          registry[entry.id].sentAt = new Date().toISOString();
        }
      }

      saveRegistry();

      return {
        success: true,
        attempted: results.length,
        sent: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        remainingPending: pendingApproval.length,
        results
      };
    }

    // ── 5. get_session_status ───────────────────────────────────────────────
    case "get_session_status": {
      const entries = Object.values(registry);
      const fairScores = entries.map(e => e.fairScore.overallScore);
      const legacyScores = entries.map(e => e.fairScore.legacyScore);

      const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null;

      return {
        registrySize: entries.length,
        approved: entries.filter(e => e.approved).length,
        pendingApproval: pendingApproval.length,
        sentToModule2: entries.filter(e => e.sentToModule2).length,
        searches: searchHistory.length,
        totalPapersSearched: searchHistory.reduce((s, h) => s + h.paperCount, 0),
        domainBreakdown: entries.reduce((acc, e) => {
          acc[e.domain] = (acc[e.domain] || 0) + 1;
          return acc;
        }, {}),
        fairScoreSummary: {
          average: avg(fairScores) ? Math.round(avg(fairScores) * 100) / 100 : null,
          min: fairScores.length ? Math.min(...fairScores) : null,
          max: fairScores.length ? Math.max(...fairScores) : null
        },
        legacyScoreSummary: {
          average: avg(legacyScores) ? Math.round(avg(legacyScores) * 100) / 100 : null,
          min: legacyScores.length ? Math.min(...legacyScores) : null,
          max: legacyScores.length ? Math.max(...legacyScores) : null
        },
        abandonedUrlCount: entries.filter(e => e.urlAbandoned).length,
        searchHistory,
        recentLog: sessionLog.slice(-20)
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
        name: "kg-module1",
        version: "1.0.0",
        description: "Module 1: Legacy Database Discovery (MCP, stdio, local)"
      }
    });
  }

  if (method === "tools/list") {
    return mcpResponse(id, {
      tools: Object.entries(TOOLS).map(([name, def]) => ({
        name,
        description: def.description,
        inputSchema: def.inputSchema
      }))
    });
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params;
    if (!TOOLS[name]) return mcpError(id, -32601, `Tool not found: ${name}`);
    try {
      const result = await executeTool(name, args || {});
      return mcpResponse(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
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

rl.on("line", async line => {
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

process.stderr.write("[kg-module1] MCP server ready (stdio)\n");
