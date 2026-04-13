#!/usr/bin/env node
/**
 * Module 3 — MCP Client Test Script
 *
 * Spawns the MCP server as a child process and exercises all five tools:
 *   1. get_graph_status   (baseline)
 *   2. ingest_dataset     (×3 datasets, incremental)
 *   3. build_graph        (full dedup + relation pass)
 *   4. query_graph        (natural-language query)
 *   5. export_graph       (all formats)
 *
 * Usage:  node src/test_client.js
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "server.js");

// ── Spawn server ──────────────────────────────────────────────────────────────
const server = spawn("node", [SERVER], {
  stdio: ["pipe", "pipe", "inherit"],
});

const rl = createInterface({ input: server.stdout, terminal: false });
let msgId = 1;
const pending = new Map();

rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  } catch { /* ignore non-JSON stderr echoes */ }
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = msgId++;
    pending.set(id, resolve);
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    server.stdin.write(payload);
  });
}

async function callTool(name, args = {}) {
  const res = await send("tools/call", { name, arguments: args });
  if (res.error) throw new Error(res.error.message);
  const text = res.result?.content?.[0]?.text || "{}";
  return JSON.parse(text);
}

// ── Pretty print ──────────────────────────────────────────────────────────────
function section(title) {
  console.log("\n" + "═".repeat(60));
  console.log(`  ${title}`);
  console.log("═".repeat(60));
}

function print(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// ── Sample datasets (simulating Module 2 output) ──────────────────────────────
const DATASETS = [
  {
    name: "GenBank Legacy Nucleotide Sequences",
    domain: "Genomics",
    records: 12800,
    fairScore: 0.82,
    fields: ["accession", "organism", "sequence", "length", "definition"],
    description:
      "Legacy nucleotide sequences deposited pre-2005, harmonized for AI readiness. Covers bacterial, viral, and eukaryotic genomes.",
    sourceId: "urn:ncbi:genbank:legacy",
  },
  {
    name: "KEGG Metabolic Pathway Archive",
    domain: "Biochemistry",
    records: 4200,
    fairScore: 0.91,
    fields: ["pathway_id", "name", "genes", "compounds", "reactions", "organism"],
    description:
      "Archived KEGG pathways from 1999-2003. Maps enzyme-catalyzed reactions and metabolite flows across organisms.",
    sourceId: "urn:kegg:pathway:archive",
  },
  {
    name: "UniProt SwissProt Historical Entries",
    domain: "Proteomics",
    records: 19200,
    fairScore: 0.94,
    fields: ["entry_name", "protein_name", "gene_names", "organism", "sequence", "function"],
    description:
      "Manually curated protein entries from SwissProt prior to TrEMBL merger. High-confidence annotations with experimental evidence.",
    sourceId: "urn:uniprot:swissprot:historical",
  },
];

// ── Run tests ─────────────────────────────────────────────────────────────────
async function run() {
  // Handshake
  await send("initialize", {
    protocolVersion: "2024-11-05",
    clientInfo: { name: "test-client", version: "1.0.0" },
    capabilities: {},
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // List tools
  section("Tool Discovery");
  const toolsRes = await send("tools/list");
  console.log("Available tools:");
  toolsRes.result.tools.forEach((t) => console.log(`  • ${t.name} — ${t.description.slice(0, 60)}…`));

  // 1. Baseline status
  section("1 · get_graph_status (baseline)");
  print(await callTool("get_graph_status"));

  // 2. Ingest datasets incrementally
  for (const ds of DATASETS) {
    section(`2 · ingest_dataset — ${ds.name}`);
    const result = await callTool("ingest_dataset", ds);
    console.log(`  Nodes added:  ${result.nodesAdded}`);
    console.log(`  Total nodes:  ${result.totalNodes}`);
    console.log(`  Total edges:  ${result.totalEdges}`);
    console.log("\n  Activity log:");
    result.log.forEach((l) => console.log(`    ${l}`));
  }

  // 3. Status after ingestion
  section("3 · get_graph_status (post-ingestion)");
  print(await callTool("get_graph_status"));

  // 4. Full build pass
  section("4 · build_graph (dedup + full relation inference)");
  const buildResult = await callTool("build_graph", { dedup_threshold: 0.72 });
  console.log(`  Merged nodes: ${buildResult.mergedNodes}`);
  console.log(`  New edges:    ${buildResult.newEdgesAdded}`);
  console.log(`  Total nodes:  ${buildResult.totalNodes}`);
  console.log(`  Total edges:  ${buildResult.totalEdges}`);
  console.log("\n  Build log:");
  buildResult.log.forEach((l) => console.log(`    ${l}`));

  // 5. Natural-language query
  section("5 · query_graph — natural language");
  const q1 = await callTool("query_graph", {
    question: "What relationships exist between genomic sequences and metabolic pathways in the graph?",
  });
  console.log(`  Q: ${q1.question}\n`);
  console.log(`  A: ${q1.answer}`);

  const q2 = await callTool("query_graph", {
    question: "Which datasets contributed protein-related entities and how are they connected?",
  });
  console.log(`\n  Q: ${q2.question}\n`);
  console.log(`  A: ${q2.answer}`);

  // 6. Export
  section("6 · export_graph (all formats)");
  const exp = await callTool("export_graph", { format: "all" });
  console.log(`  Nodes exported: ${exp.nodes}`);
  console.log(`  Edges exported: ${exp.edges}`);
  console.log("  Files:");
  Object.entries(exp.files).forEach(([fmt, path]) => console.log(`    ${fmt}: ${path}`));

  // Final status
  section("Final · get_graph_status");
  print(await callTool("get_graph_status"));

  console.log("\n✓ All tests complete.\n");
  server.kill();
  process.exit(0);
}

run().catch((err) => {
  console.error("Test failed:", err);
  server.kill();
  process.exit(1);
});
