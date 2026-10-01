# Architecture

```
                      +---------------------------+
   Human committee <--|  Committee Review (UI)    |  export needs recorded human approval
   (final authority)  +-------------+-------------+
                                    |
 Browser UI  --->  Next.js app (Vercel)   /api/runs  /api/dashboard  /api/approvals
                                    |
                           +--------v---------+
                           |    LangGraph     |  state + branching (no fixed pipeline)
                           +--------+---------+
                                    |
                           +--------v---------+      Claude now / open-weights later
                           |  ModelProvider   |<---- ClaudeProvider | OpenWeightsProvider | (test double)
                           +--------+---------+
                                    |  tool calls chosen by the model
                           +--------v---------+     Streamable HTTP, bearer auth
                           |    MCP client    |-----------------------------+
                           +--------+---------+                             |
                                    | /api/mcp                              v
                    +---------------v---------------+            +-------------------------+
                    |      Bid Box MCP server       |            | External MCP server     |
                    |  audit middleware (all tools) |            | (optional, advisory)    |
                    |  tools: load_tender ingest_bid|            +-------------------------+
                    |  compare_bid verify_evidence  |
                    |  generate_committee_file      |
                    |  log_action   + 6 resources   |
                    +---------------+---------------+
                                    |
              +---------------------+----------------------+
              |                     |                      |
      Calibration engine     Evidence layer          PostgreSQL (Supabase)
      (pure functions)    (extract + verify)   tenders bids documents evidence investigations
                                                agent_runs calibration_states evaluations
                                                human_approvals tool_calls (append-only)
```

## Why each piece exists

- **Claude = reasoning.** It decides which tool to call next from earlier results and writes the plan. It never does arithmetic, never mints citations, never writes the audit log.
- **LangGraph = state/orchestration.** Explicit state (`tender_id, bid_ids, current_bid, calibration_size, calibration_complete, reference_distribution, calibration_stability, findings, evidence, investigation_queue, tool_calls, errors, recovery_attempts, committee_file, human_review_required`) and conditional edges driven by tool results: `load_tender -> make_plan -> calibrate -> process_bid -> decide_investigation -> (investigate -> verify_check | next_bid | recover) -> ... -> generate_committee_file -> human_review`. Runs execute in batches and persist to `agent_runs`.
- **MCP = capability interface.** Real MCP over Streamable HTTP, so any compliant client (not just our agent) can use the same tools, and swapping the model changes nothing server-side.
- **Calibration engine = deterministic maths.** `src/domain/calibration.ts`: no I/O, no model.
- **Database = persistent state.** Needed because serverless instances are stateless.
- **Human committee = final authority.** No award capability exists in code, schema or UI.

## Model abstraction

The graph imports only `ModelProvider` (`step({system, messages, tools}) -> {text, toolCalls}`). History is stored in a neutral canonical format; each provider translates at its edge. `ClaudeProvider` (Anthropic SDK), `OpenWeightsProvider` (OpenAI-compatible HTTP; unconfigured by default and throws `not_configured`), `FailoverProvider` (switches only on 429/5xx/timeouts), and `ScriptedProvider` (a test double used for offline runs; it is not an LLM and says nothing about model quality; refused in production).

## Calibration ("secretary-inspired") mechanism

An **experimental investigation-allocation heuristic**, not a procurement rule, legal threshold or scoring formula. Bids are processed in submission order. The first `round(n/e)` (20 bids -> 7) form a reference set: not rejected, not ranked. From them: median and robust scale (MAD with a 5% floor) for price (USD-normalised) and delivery time, plus completeness/compliance ratios. A stability score (leave-one-out shift of the median, scaled, damped when fewer than 5 bids) gives phases OBSERVING -> CALIBRATING -> PROVISIONAL (>= 5 bids and stability >= 0.8) -> CALIBRATED. Later bids trigger investigation if |robust z| >= 2.5 or |deviation| >= 25%. Objective facts (missing mandatory document, requirement mismatch, contradictory delivery, supplier inconsistency, unsupported claim, injection text) are flagged regardless of role. A flag means "investigate", never "reject" or "prefer". Calibration bids get factual checks only; deviation checks are suppressed for them because they define the reference. Output contains no rank, score or winner field (asserted in tests).

Nuance: the classic 37% rule is about choosing one best candidate under random order; here it only bounds how much data is seen before declaring something "unusual". The heuristic is also sensitive to submission order and to a calibration set that happens to be unrepresentative.

## Evidence layer

Extraction is rule-based and returns every value with `{document, page, section, excerpt}`. `verify_evidence` re-reads stored page text, and before reporting `verified: true` asserts the cited excerpt exists on the cited page; otherwise it downgrades to `EVIDENCE_MISSING` ("Insufficient evidence - requires human review."). Verification can also resolve a flag (e.g. a price that looks 14,000% high is a KES quote; converting at the tender's reference rate removes the anomaly). Excerpts are wrapped as untrusted text.

## Audit

`withAudit` wraps every tool, so every call is recorded (success, flagged, validation error, exception, timeout) whether or not the model calls `log_action`. Records carry run, tender, bid, tool, input, output, status, error, actor (model identity from the `x-bidbox-actor` header), duration, human-approval state. `tool_calls` and `human_approvals` reject UPDATE/DELETE via DB trigger, and rows are hash-chained per run (`verifyChain`). Caveat: a database superuser could still alter the table; the hash chain makes that detectable, not impossible. `log_action` entries are marked `_agent_reported`.

## Human approval gate

`generate_committee_file` stores the package with `COMMITTEE_REVIEW_REQUIRED` and a `PENDING` approval row. Export (`/api/evaluations/:id/export`) requires an `APPROVED` row with a named approver, created through `/api/approvals`, an operator route that is deliberately **not** an MCP tool.

## External MCP server

Plumbing: `src/agent/external.ts` + `McpConnection`. Chosen role: a currency-conversion MCP server, because FX normalisation is a maintained data service we should not rebuild (stale rates are a real risk) and it directly supports the misleading-anomaly case. Tools are namespaced `ext__*`, read-only by name allow-list, advisory only, and mirrored into Bid Box's audit trail. Limitation found during research: ECB-based services do not cover every African currency (e.g. KES), so the tender reference rate stays authoritative. Not connected or tested against a live server.

## Deployment architecture and what cannot run on Vercel

Runs on Vercel: Next.js UI, `/api/mcp`, operator routes, the graph in batched invocations, Claude calls. Does **not** run there: (1) an open-weights model (needs GPU hosting; reach it via `OPENWEIGHTS_ENDPOINT_URL`), (2) heavy PDF/OCR/ML processing (move behind the same ingest interface to a worker), (3) PGlite (dev/test only), (4) long uninterrupted runs on short function limits (hence batching).

## Known limitations

See README. Additionally: the MCP server stores no per-client identity; auth is a shared bearer token. Streamable HTTP is stateless here, so server-initiated messages are unused.
