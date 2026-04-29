# Module 2 — Data Harmonization

An MCP server (local, stdio) that takes structured metadata descriptions from
Module 1 and harmonizes them into AI-ready, FAIR-scored datasets using Claude
as the reasoning engine. Automatically hands off to Module 3.

---

## Architecture

```
Module 1 output (structured metadata descriptions)
        │
        ▼
┌──────────────────────────────────────────────────┐
│           MCP Server (stdio)                     │
│                                                  │
│  Tool 1: harmonize_dataset                       │
│    └─ OLS4 API (EMBL-EBI Ontology Lookup         │
│        Service v4) — bioinformatics tool         │
│    └─ Claude: field harmonization                │
│         → Darwin Core ontology mapping           │
│         → unit detection + normalization         │
│         → missing value strategies               │
│         → rename flags embedded in output        │
│    └─ Claude: FAIR score (holistic, I-priority)  │
│    └─ Claude: sample record transformation       │
│    └─ Auto handoff → Module 3 ingest_dataset     │
│                                                  │
│  Tool 2: get_harmonization_log                   │
│  Tool 3: export_dataset (CSV / JSON / Excel)     │
│  Tool 4: get_queue_status                        │
│  Tool 5: flush_queue                             │
└──────────────────────────────────────────────────┘
        │
        ▼
  exports/   (CSV, JSON, Excel — with embedded metadata)
  → Module 3 ingest_dataset (automatic, fire-and-forget)
```

---

## Setup

### Prerequisites
- Node.js ≥ 18
- `ANTHROPIC_API_KEY` environment variable
- Module 3 running or its path configured (optional — datasets queue if unavailable)

### Install

```bash
cd kg-module2
npm install
```

### Run standalone

```bash
ANTHROPIC_API_KEY=sk-... npm start
```

### Run test client

```bash
ANTHROPIC_API_KEY=sk-... npm test
```

### Run test client with automatic Module 3 handoff

```bash
ANTHROPIC_API_KEY=sk-... \
MODULE3_SERVER_PATH=/absolute/path/to/kg-module3/src/server.js \
npm run test:with-module3
```

---

## Register with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kg-module2": {
      "command": "node",
      "args": ["/absolute/path/to/kg-module2/src/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "MODULE3_SERVER_PATH": "/absolute/path/to/kg-module3/src/server.js"
      }
    },
    "kg-module3": {
      "command": "node",
      "args": ["/absolute/path/to/kg-module3/src/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Restart Claude Desktop. Both modules will appear as connected MCP servers.

---

## Tools

### `harmonize_dataset`
The core tool. Accepts a structured metadata description, calls EMBL-EBI's
**OLS4 (Ontology Lookup Service v4)** to retrieve candidate ontology matches
for each input field, then runs three Claude passes — field harmonization,
FAIR scoring, and sample record transformation — and automatically hands the
result off to Module 3.

**Bioinformatics tool: OLS4 (Ontology Lookup Service v4)** — EMBL-EBI's
federated ontology registry, hosting hundreds of biomedical ontologies
including Darwin Core, Schema.org, Dublin Core, GO, ChEBI, MONDO, EFO,
Uberon, and NCIt. Continuously published as part of EMBL-EBI's annual
*Nucleic Acids Research* Database Issue (2025 issue:
[doi.org/10.1093/nar/gkae1148](https://doi.org/10.1093/nar/gkae1148)). For
each input field, Module 2 queries `/ols4/api/search` (free, no auth) for the
top 5 candidate matches, biased toward the three target ontologies (dwc,
schema, dcterms). The candidates are passed into Claude's harmonization
prompt as evidence-backed suggestions; Claude makes the final mapping
decision using both the static mapping dictionary and OLS4 evidence.

**Required fields:**
| Field | Type | Description |
|---|---|---|
| `name` | string | Dataset name |
| `domain` | string | Scientific domain |
| `records` | number | Record count |

**Optional:** `fields` (array), `description`, `sourceId`, `units` (object)

**Returns:** dataset ID, FAIR score breakdown, rename flags, unmapped fields,
unit conflicts, transformation summary, Module 3 handoff status, improvement suggestions.

---

### `get_harmonization_log`
Returns all datasets harmonized this session with their FAIR scores and field counts.
Optionally filter by `dataset_id`.

---

### `export_dataset`
Exports a harmonized dataset in one or all formats. All exports embed FAIR scores,
rename flags, and unit normalization metadata directly in the file.

| Format | File | Sheets/Sections |
|---|---|---|
| `csv` | `{id}_harmonized.csv` | Metadata as comments + data rows |
| `json` | `{id}_harmonized.json` | Full JSON-LD with @context |
| `excel` | `{id}_harmonized.xls` | 3 sheets: Data, FAIR Score, Improvements |
| `all` | all three | — |

---

### `get_queue_status`
Shows datasets waiting to be sent to Module 3 — name, queue time, attempt count.
If `MODULE3_SERVER_PATH` is not configured, all datasets queue automatically.

---

### `flush_queue`
Retries all queued datasets against Module 3. Pass `module3_server_path` to
override the configured path. Use after Module 3 becomes available.

---

## Harmonization details

### Darwin Core ontology mapping
Fields are mapped to Darwin Core terms first, then Schema.org, then Dublin Core.
Claude performs the mapping automatically. Unmapped fields are flagged and returned
in `unmappedFields`.

**Example mappings:**
| Input field | Canonical term | Ontology |
|---|---|---|
| `organism` | `dwc:scientificName` | Darwin Core |
| `accession` | `dwc:catalogNumber` | Darwin Core |
| `sequence` | `dwc:associatedSequences` | Darwin Core |
| `function` | `dwc:taxonRemarks` | Darwin Core |
| `source` | `dwc:institutionCode` | Darwin Core |

### Rename flags
When a field is renamed for canonical consistency, a flag is embedded in the
output metadata:
```
RENAMED: organism → dwc:scientificName
```
Flags appear in the `renameFlags` array in the tool response, and are embedded
in all export formats.

### Unit normalization
Units are detected automatically from field names and descriptions. Explicit
units (passed via the `units` parameter) take priority. Conflicts between
detected and explicit units are reported in `unitConflicts`.

### Missing value strategies
Claude selects the best strategy per field:
- Numeric fields → mean or median
- Categorical fields → mode
- Sequential fields → forward fill
- Identifier fields → empty string or null

### FAIR scoring
Holistic scoring across all four pillars, weighted to prioritize Interoperability:
- **F** Findability × 0.2
- **A** Accessibility × 0.2
- **I** Interoperability × 0.4  ← priority
- **R** Reusability × 0.2

---

## Module 3 handoff

When `MODULE3_SERVER_PATH` is set, Module 2 automatically spawns Module 3 as a
child process and calls `ingest_dataset` with:
- The harmonized field names (canonical Darwin Core terms)
- The FAIR score calculated by Module 2
- The dataset description including transformation notes
- The upstream source ID

The handoff is fire-and-forget — Module 2 does not wait for Module 3 to finish.
If the handoff fails, the dataset is queued and can be retried via `flush_queue`.

---

## Pipeline

```
Module 1 → discovers + ranks legacy databases
    ↓
Module 2 → harmonizes raw data → AI-ready datasets  ← this module
    ↓ (automatic)
Module 3 → builds knowledge graph
```

---

## Connecting to Module 1

When Module 1 is built, it will call `harmonize_dataset` directly via MCP tool
calls, passing structured metadata descriptions of the legacy databases it
discovers. The `sourceId` field should carry the upstream identifier (DOI,
accession number, or database URL) that Module 1 assigns during discovery.
