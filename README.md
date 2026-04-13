# Module 3 — Knowledge Graph Builder

An MCP server (local, stdio) that takes AI-ready, FAIR-validated datasets from
Module 2 and builds an incrementally-updated knowledge graph using Claude as the
reasoning engine.

---

## Architecture

```
Module 2 output (AI-ready datasets)
        │
        ▼
┌──────────────────────────────────────┐
│         MCP Server (stdio)           │
│                                      │
│  Tool 1: ingest_dataset              │  ◄─ incremental, per dataset
│    └─ Claude: extract_entities       │
│    └─ Dedup: embedding similarity    │
│    └─ Claude: infer_relations        │
│    └─ Claude: revise_edges           │
│                                      │
│  Tool 2: build_graph                 │  ◄─ full pass after bulk ingest
│    └─ Global dedup pass              │
│    └─ Claude: full relation sweep    │
│                                      │
│  Tool 3: query_graph                 │  ◄─ natural language → Claude
│                                      │
│  Tool 4: export_graph                │  ◄─ JSON-LD / Turtle / CSV
│  Tool 5: get_graph_status            │
└──────────────────────────────────────┘
        │
        ▼
  data/graph.json  (persisted, versioned)
  exports/         (JSON-LD, Turtle/RDF, Edge CSV)
```

---

## Setup

### Prerequisites
- Node.js ≥ 18
- An `ANTHROPIC_API_KEY` environment variable

### Install

```bash
cd kg-module3
npm install
```

### Run the server (standalone)

```bash
ANTHROPIC_API_KEY=sk-... npm start
```

### Register with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "kg-module3": {
      "command": "node",
      "args": ["/absolute/path/to/kg-module3/src/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-..."
      }
    }
  }
}
```

Restart Claude Desktop. The five tools will appear automatically.

---

## Tools

### `ingest_dataset`
Incrementally ingests one AI-ready dataset. Runs entity extraction, embedding-
based deduplication, relation inference, and edge revision — all via Claude.

**Required fields:**
| Field | Type | Description |
|---|---|---|
| `name` | string | Dataset name |
| `domain` | string | Scientific domain |
| `records` | number | Row count |
| `fairScore` | number | FAIR compliance score (0–1) |

**Optional:** `fields` (array), `description`, `sourceId`

**Returns:** nodes added, total nodes/edges, full activity log.

---

### `build_graph`
Runs a full graph build pass: global deduplication sweep across all nodes,
followed by a complete relation inference call across the entire node set.
Use after batching multiple `ingest_dataset` calls.

**Optional:** `dedup_threshold` (default 0.72)

---

### `query_graph`
Answers a natural-language question using Claude reasoning over the live graph.

```
Q: What relationships exist between genomic sequences and metabolic pathways?
A: The graph shows DNA Sequence nodes (from GenBank) connected to Metabolic
   Pathway nodes (from KEGG) via "encodes" and "maps to" relations...
```

---

### `export_graph`
Exports the graph in one or all formats.

| Format | File | Standard |
|---|---|---|
| `jsonld` | `exports/knowledge_graph.jsonld` | JSON-LD / Schema.org |
| `turtle` | `exports/knowledge_graph.ttl` | Turtle / RDF |
| `csv` | `exports/edges.csv` | Edge list with provenance |
| `all` | all three | — |

All node URIs follow `urn:kg:module3:{id}` — structured for future persistent
identifier assignment (Findability-first FAIR design).

---

### `get_graph_status`
Returns node counts by type, edge count, average FAIR score, ingested dataset
list, graph version, and last-updated timestamp.

---

## Deduplication

Deduplication uses **Jaccard token similarity** over normalised node names as an
embedding proxy (no external embedding endpoint required). The default threshold
is **0.72** — tunable per `build_graph` call.

When a duplicate is detected:
- The node with the **higher FAIR score** is kept
- Edges referencing the removed node are **repointed** to the surviving node
- Self-loops introduced by merging are removed
- Duplicate edges (same from/to/label) are collapsed

This mirrors the deduplication design intended for Module 1, so the threshold
and merge strategy can be shared when Module 1 is built.

---

## Graph persistence

The graph is stored at `data/graph.json` and versioned on every write. Each
build increments `meta.version`. The file survives server restarts — re-ingesting
the same dataset will update the existing node rather than duplicate it.

---

## Testing

```bash
ANTHROPIC_API_KEY=sk-... node src/test_client.js
```

This spawns the server as a child process and exercises all five tools
end-to-end with three real datasets (GenBank, KEGG, UniProt).

---

## FAIR alignment

| Pillar | Implementation |
|---|---|
| **Findability** | Every node carries a `urn:kg:module3:{id}` URI. JSON-LD export uses `@id`. Dataset nodes store upstream `sourceId`. |
| **Accessibility** | JSON-LD and Turtle exports are machine-readable standard formats. |
| **Interoperability** | Turtle export uses `rdfs:label`, `schema:about`, `schema:dateCreated`. |
| **Reusability** | Every edge carries `source` (dataset name), `rationale`, and `confidence`. |

---

## Connecting to Module 1 & 2

Module 3 is designed to be the terminal consumer in the pipeline:

```
Module 1 → discovers + ranks legacy databases (FAIR scoring, dedup)
Module 2 → harmonizes raw data → AI-ready datasets
Module 3 → builds knowledge graph from AI-ready datasets  ← this module
```

The `ingest_dataset` tool accepts the same fields Module 2 would produce.
When Modules 1 and 2 are built, they can call `ingest_dataset` directly via
MCP tool calls, making the pipeline fully agentic.
