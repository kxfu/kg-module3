# Module 1 — Legacy Database Discovery

An MCP server (local, stdio) that searches PubMed for scientific papers,
extracts references to legacy databases, ranks them using FAIR principles
and a legacy score, and hands off approved databases to Module 2 for
harmonization.

---

## What counts as a legacy database

A database must meet **all three** of these criteria to be flagged as legacy:

1. **Pre-relational structure** — flat-file, hierarchical, or network model.
   Not a modern relational/SQL database.
2. **No current MCP or API access** — does not have a known REST API, SOAP
   API, or other modern programmatic data access layer in its current state
   (checked against 2026 knowledge).
3. **Old or abandoned** — typically created or primarily used before the
   relational database era. Dead URLs are logged as abandonment evidence and
   boost the legacy score.

### Examples of legacy databases
- Early flat-file sequence archives (pre-INSDC era GenBank flat files)
- PIR Protein Information Resource (pre-UniProt)
- NBRF Atlas of Protein Sequence and Structure
- Hierarchical chemical databases (early CAS flat exports)
- Abandoned taxonomy flat files (early ITIS text dumps)
- Pre-web ecology datasets stored as fixed-width text files

### Examples that are NOT legacy
- Modern GenBank (NCBI E-utilities API)
- UniProt (REST API)
- KEGG (API)
- PDB (REST API)
- Any PostgreSQL/MySQL database

---

## Architecture

```
Researcher provides keywords + year cutoff
        │
        ▼
┌──────────────────────────────────────────────────┐
│           MCP Server (stdio)                     │
│                                                  │
│  Tool 1: search_pubmed                           │
│    └─ PubMed E-utilities API (multiple queries)  │
│    └─ Claude: extract legacy DB references       │
│    └─ URL fetch: check if database is alive      │
│    └─ Claude: MCP/API readiness check            │
│    └─ Claude: FAIR + legacy scoring              │
│    └─ Deduplication: Jaccard + URL + accession   │
│    └─ Registry: persist canonical entries        │
│                                                  │
│  Tool 2: get_discovery_log (ranked results)      │
│  Tool 3: review_databases (threshold + manual)   │
│  Tool 4: send_to_module2 (approved entries)      │
│  Tool 5: get_session_status                      │
└──────────────────────────────────────────────────┘
        │
        ▼
  data/registry.json  (persisted canonical database registry)
  → Module 2 harmonize_dataset (researcher-approved, then automatic)
```

---

## Setup

### Prerequisites
- Node.js ≥ 18
- `ANTHROPIC_API_KEY` environment variable
- Module 2 path configured (optional — needed for full pipeline)

### Install

```bash
cd kg-module1
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

### Run test client with Module 2 handoff

```bash
ANTHROPIC_API_KEY=sk-... \
MODULE2_SERVER_PATH=/absolute/path/to/kg-module2/src/server.js \
npm run test:with-module2
```

---

## Register with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kg-module1": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/kg-module1/src/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "MODULE2_SERVER_PATH": "/absolute/path/to/kg-module2/src/server.js"
      }
    },
    "kg-module2": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/kg-module2/src/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "MODULE3_SERVER_PATH": "/absolute/path/to/kg-module3/src/server.js"
      }
    },
    "kg-module3": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/kg-module3/src/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

---

## Tools

### `search_pubmed`

Searches PubMed with one or more free-text keyword queries. Results are
combined with OR, so multiple queries broaden the search. Each paper's
abstract is analyzed by Claude to identify explicitly named legacy databases.

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `queries` | array | required | One or more keyword strings |
| `max_results` | number | 100 | Papers to retrieve (10–500) |
| `year_cutoff` | number | none | Only papers published ≤ this year |
| `dedup_threshold` | number | 0.72 | Similarity threshold for deduplication |

**Processing pipeline per paper:**
1. Claude extracts explicitly named databases
2. Each database checked against all three legacy criteria
3. URL fetched if available — dead URL = abandonment evidence
4. Claude checks current MCP/API readiness
5. Databases with confirmed modern APIs are excluded
6. Claude scores FAIR (F/A/I/R) and legacy (0–1)
7. Deduplication: Jaccard name similarity + URL domain + accession patterns
8. Canonical entry written to `data/registry.json`

**Deduplication logic:**
- When a duplicate is found, the entry from the more recent paper wins
- All source PMIDs are accumulated on the canonical entry
- Edges repointed, self-loops removed

---

### `get_discovery_log`

Returns all discovered databases sorted by legacy score (default) or FAIR
score, name, or year. Includes full metadata: field lists, scoring rationale,
abandonment evidence, and improvement suggestions.

| Parameter | Default | Description |
|---|---|---|
| `sort_by` | `legacy_score` | `legacy_score`, `fair_score`, `name`, `year` |
| `min_fair_score` | 0 | Filter by minimum FAIR score |
| `min_legacy_score` | 0 | Filter by minimum legacy score |

---

### `review_databases`

The researcher review step. Two approval paths:

1. **Threshold approval**: set `approve_threshold` (e.g. 0.75) to
   auto-approve all databases with FAIR score ≥ that value
2. **Manual approval**: pass specific database IDs in `approve_ids`

Both can be used together in one call. Approved databases go into the
pending queue for `send_to_module2`. Use `reject_ids` to remove entries
from the queue.

The tool always returns the full ranked list so the researcher can see
everything and decide what else to approve manually.

---

### `send_to_module2`

Sends all approved databases to Module 2's `harmonize_dataset` tool.
Requires `MODULE2_SERVER_PATH` to be set (in env or passed as parameter).

Each database is sent with:
- Confirmed explicit fields from the paper
- Claude-inferred fields tagged as `[inferred]`
- FAIR score from Module 1 as starting `fairScore`
- Source identifier as `urn:pubmed:{pmid}` or the database URL

After a successful send, the database is marked `sentToModule2: true` in
the registry and removed from the pending queue.

---

### `get_session_status`

Returns registry size, approval counts, domain breakdown, FAIR/legacy score
summaries, abandoned URL count, search history, and the last 20 log entries.

---

## FAIR scoring

Each database is scored across all four pillars equally (0.25 weight each):

| Pillar | What is scored |
|---|---|
| Findability | Persistent name, consistent citation, findable today |
| Accessibility | Reachable URL, programmatic access, not paywalled |
| Interoperability | Standard formats, vocabulary alignment |
| Reusability | License, provenance, description quality |

**Legacy score** (separate from FAIR, 0–1): measures how strongly a database
qualifies as legacy. Dead URL, no API, sparse metadata, and pre-relational
structure all contribute to a higher legacy score. Used for ranking — the
most abandoned databases appear first.

---

## Persistence

The registry is stored in `data/registry.json` and persists across server
restarts. Re-discovering the same database in a later search updates the
entry only if the new paper is more recent.

---

## Full pipeline

```
Module 1 → discovers + ranks legacy databases    ← this module
    ↓ (researcher approves, then automatic)
Module 2 → harmonizes raw data → AI-ready datasets
    ↓ (automatic)
Module 3 → builds knowledge graph
```
