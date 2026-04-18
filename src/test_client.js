#!/usr/bin/env node
/**
 * Module 1 — MCP Client Test Script
 *
 * Exercises all five tools end-to-end:
 *   1. search_pubmed       — searches PubMed, extracts legacy databases
 *   2. get_discovery_log   — shows ranked results
 *   3. review_databases    — approves by threshold then manually
 *   4. send_to_module2     — sends approved databases to Module 2
 *   5. get_session_status  — final stats
 *
 * Usage:
 *   node src/test_client.js
 *
 * To test full pipeline with Module 2:
 *   MODULE2_SERVER_PATH=/absolute/path/to/kg-module2/src/server.js node src/test_client.js
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "server.js");

const serverEnv = {
  ...process.env,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};
if (process.env.MODULE2_SERVER_PATH) {
  serverEnv.MODULE2_SERVER_PATH = process.env.MODULE2_SERVER_PATH;
}

const server = spawn("node", [SERVER], {
  stdio: ["pipe", "pipe", "inherit"],
  env: serverEnv,
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

function send(method, params = {}) {
  return new Promise(resolve => {
    const id = msgId++;
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function callTool(name, args = {}) {
  const res = await send("tools/call", { name, arguments: args });
  if (res.error) throw new Error(res.error.message);
  const text = res.result?.content?.[0]?.text || "{}";
  return JSON.parse(text);
}

function section(title) {
  console.log("\n" + "═".repeat(60));
  console.log(`  ${title}`);
  console.log("═".repeat(60));
}

function print(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function run() {
  // Handshake
  await send("initialize", {
    protocolVersion: "2025-11-25",
    clientInfo: { name: "test-client-m1", version: "1.0.0" },
    capabilities: {}
  });
  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
  );

  // Tool discovery
  section("Tool Discovery");
  const toolsRes = await send("tools/list");
  console.log("Available tools:");
  toolsRes.result.tools.forEach(t =>
    console.log(`  • ${t.name} — ${t.description.slice(0, 65)}…`)
  );

  // 1. Baseline status
  section("1 · get_session_status (baseline)");
  print(await callTool("get_session_status"));

  // 2. Search PubMed — multiple queries, year cutoff
  section("2 · search_pubmed — legacy biological databases");
  const searchResult = await callTool("search_pubmed", {
    queries: [
      "flat-file biological database sequence archive 1980s 1990s",
      "legacy protein sequence database pre-relational",
      "nucleotide sequence flat file database archive abandoned"
    ],
    max_results: 20,   // small for test run — increase for real use
    year_cutoff: 2005,
    dedup_threshold: 0.72
  });

  console.log(`  Papers searched:    ${searchResult.papersSearched}`);
  console.log(`  New databases:      ${searchResult.newDatabasesFound}`);
  console.log(`  Databases updated:  ${searchResult.databasesUpdated}`);
  console.log(`  Total in registry:  ${searchResult.totalInRegistry}`);

  if (searchResult.newDatabases?.length > 0) {
    console.log("\n  Discovered databases:");
    searchResult.newDatabases.forEach(db => {
      console.log(`    • ${db.name} (${db.domain})`);
      console.log(`      FAIR: ${db.fairScore?.toFixed(2) || "N/A"} | Legacy: ${db.legacyScore?.toFixed(2) || "N/A"} | Abandoned URL: ${db.urlAbandoned}`);
    });
  }

  console.log("\n  Activity log (last 15 entries):");
  (searchResult.log || []).slice(-15).forEach(l => console.log(`    ${l}`));

  // 3. Discovery log — ranked by legacy score
  section("3 · get_discovery_log — ranked by legacy score");
  const logResult = await callTool("get_discovery_log", {
    sort_by: "legacy_score",
    min_legacy_score: 0
  });

  console.log(`  Total in registry: ${logResult.totalInRegistry}`);
  console.log(`  Showing: ${logResult.filtered}`);

  if (logResult.databases?.length > 0) {
    console.log("\n  Ranked databases:");
    logResult.databases.forEach((db, i) => {
      console.log(`\n  ${i + 1}. ${db.name} [${db.id}]`);
      console.log(`     Domain:      ${db.domain}`);
      console.log(`     FAIR score:  ${db.fairScore?.toFixed(2)}`);
      console.log(`     Legacy score:${db.legacyScore?.toFixed(2)}`);
      console.log(`     Abandoned:   ${db.urlAbandoned}`);
      console.log(`     Papers:      ${db.sourcePapers}`);
      console.log(`     Description: ${db.description?.slice(0, 100) || "N/A"}`);
      if (db.explicitFields?.length > 0) {
        console.log(`     Fields (explicit): ${db.explicitFields.join(", ")}`);
      }
      if (db.inferredFields?.length > 0) {
        console.log(`     Fields (inferred): ${db.inferredFields.join(", ")}`);
      }
    });
  } else {
    console.log("\n  No databases found. Try broader search queries or a wider year range.");
  }

  // 4. Review — auto-approve above 0.5, then show full list
  section("4 · review_databases — approve by threshold");
  const reviewResult = await callTool("review_databases", {
    approve_threshold: 0.5,   // low threshold for test purposes
  });

  console.log(`  Auto-approved:    ${reviewResult.autoApproved}`);
  console.log(`  Manual approved:  ${reviewResult.manualApproved}`);
  console.log(`  Rejected:         ${reviewResult.rejected}`);
  console.log(`  Pending approval: ${reviewResult.pendingApprovalCount}`);

  if (reviewResult.pendingApproval?.length > 0) {
    console.log("\n  Approved and pending send:");
    reviewResult.pendingApproval.forEach(p => {
      console.log(`    • ${p.name} — FAIR: ${p.fairScore?.toFixed(2)} | Legacy: ${p.legacyScore?.toFixed(2)} | via ${p.method}`);
    });
  }

  console.log("\n  Full ranked list:");
  (reviewResult.fullRankedList || []).forEach(db => {
    console.log(`    [${db.approved ? "✓" : " "}] ${db.name} — FAIR: ${db.fairScore?.toFixed(2)} | Legacy: ${db.legacyScore?.toFixed(2)}`);
  });

  // 5. Send to Module 2
  section("5 · send_to_module2");
  if (reviewResult.pendingApprovalCount > 0) {
    const sendResult = await callTool("send_to_module2", {
      module2_server_path: process.env.MODULE2_SERVER_PATH || ""
    });
    console.log(`  Attempted: ${sendResult.attempted}`);
    console.log(`  Sent:      ${sendResult.sent}`);
    console.log(`  Failed:    ${sendResult.failed}`);
    sendResult.results?.forEach(r => {
      console.log(`    • ${r.name}: ${r.success ? "sent" : "failed — " + r.reason}`);
    });
  } else {
    console.log("  No approved databases to send.");
  }

  // 6. Final status
  section("6 · get_session_status (final)");
  const status = await callTool("get_session_status");
  console.log(`  Registry size:       ${status.registrySize}`);
  console.log(`  Approved:            ${status.approved}`);
  console.log(`  Sent to Module 2:    ${status.sentToModule2}`);
  console.log(`  Searches performed:  ${status.searches}`);
  console.log(`  Papers searched:     ${status.totalPapersSearched}`);
  console.log(`  Abandoned URLs:      ${status.abandonedUrlCount}`);
  if (status.fairScoreSummary.average !== null) {
    console.log(`  Avg FAIR score:      ${status.fairScoreSummary.average}`);
    console.log(`  Avg legacy score:    ${status.legacyScoreSummary.average}`);
  }
  if (Object.keys(status.domainBreakdown).length > 0) {
    console.log(`  Domains:`);
    Object.entries(status.domainBreakdown).forEach(([d, n]) =>
      console.log(`    ${d}: ${n}`)
    );
  }

  console.log("\n✓ All Module 1 tests complete.\n");
  server.kill();
  process.exit(0);
}

run().catch(err => {
  console.error("Test failed:", err);
  server.kill();
  process.exit(1);
});
