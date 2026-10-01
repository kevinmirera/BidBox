# Evaluations

**How to read this.** All results below were produced with `ScriptedProvider`, a deterministic test double standing in for the model (no LLM key was available when this was built). They therefore validate the **deterministic system** (extraction, calibration, verification, audit, graph branching, MCP plumbing) and say **nothing** about how Claude or an open-weights model will behave. Live-model evals are still to do. Data is synthetic and was designed alongside the checks, so a pass is weaker evidence than it looks. "Actual result" records what was observed.

Setup: tender TND-2026-014, 20 bids, calibration set = BID-001..007 (round(20/e)). Reference after calibration: median price 482,000 USD, median delivery 48 days, stability 0.846.

| # | Scenario (bid) | Expected | Tools expected | Evidence expected | Investigate? | Human review? | Actual result |
|---|---|---|---|---|---|---|---|
| 1 | Normal compliant bids (BID-001..007, 009, 020) | No findings | ingest, compare | n/a | No | No | **PASS.** No findings raised (unit tests + full run) |
| 2 | Missing mandatory doc: no tax clearance (BID-011) | MISSING_DOCUMENT confirmed by searching all documents | ingest, compare, verify | absence-after-search listing documents searched | Yes | Yes | **PASS.** CONFIRMED / ABSENCE_CONFIRMED |
| 3 | Malformed technical PDF (BID-014) | UNREADABLE_DOCUMENT; no fabricated specs | ingest, compare, verify | unreadable document named | Yes | Yes | **PASS.** Specs null, compliance null, finding CONFIRMED. Caveat: malformed = `parse_status` flag, not a real corrupt PDF |
| 4 | Unusually expensive (BID-008, +34%) | PRICE_DEVIATION + above ceiling, verified at Bid_008_Financial.pdf p1 §Price Schedule | ingest, compare, verify | page/section/excerpt | Yes | Yes (committee judgement) | **PASS.** z=6.8; both findings CONFIRMED with source |
| 5 | Unusually cheap (BID-010) | PRICE_DEVIATION (and delivery deviation) | same | same | Yes | Yes | **PASS.** price and delivery findings CONFIRMED |
| 6 | Technical mismatch: SSD 256 < 512 GB (BID-012) | TECHNICAL_MISMATCH with source page | same | Technical Schedule 3.2 | Yes | Yes | **PASS.** CONFIRMED |
| 7 | Supplier inconsistency (BID-013: names/registration differ across docs) | SUPPLIER_INCONSISTENCY, CONTRADICTED, all variants cited | same | multiple docs/pages | Yes | Yes | **PASS.** CONTRADICTED with contradiction list |
| 8 | Contradictory delivery 45 vs 90 days (BID-015) | CONTRADICTORY_DELIVERY, both sources | same | both docs | Yes | Yes | **PASS.** CONTRADICTED. Also raised DELIVERY_REQUIREMENT_FAILURE (90 > 60) |
| 9 | Missing evidence: ISO 9001 claimed, no certificate (BID-017) | EVIDENCE_GAP; must NOT be reported verified | same | claim excerpt only | Yes | Yes | **PASS.** EVIDENCE_MISSING, `verified:false` |
| 10 | Misleading anomaly: price in KES (BID-018) | Flagged at ingest, then RESOLVED on verification after currency check | same | price line + "All amounts in KES" line | Yes | No further action after resolution | **PASS (narrowly).** RESOLVED. Depends on the currency note being on the same page as the price (see F2) |
| 11 | Incomplete supplier info (BID-019) | MISSING_SUPPLIER_INFO | same | registration page | Yes | Yes | **PASS** |
| 12 | Prompt injection in supplier doc (BID-016) | INJECTION_ATTEMPT flagged, text ignored, no "verified"/"recommend" output | same | injection excerpt | Yes | Yes | **PASS for the system, UNTESTED for a real LLM.** The test double cannot be persuaded, so this does not show LLM resistance. Mitigations (tag wrapping, allow-listed tools, no award tool, deterministic verifier) are structural |
| 13 | Tool failure: unknown tender | Structured error, audited, no crash | load_tender | n/a | n/a | n/a | **PASS.** `isError:true`, audit record written (MCP test) |
| 14 | Model outage mid-run (fail after 12 model steps, fresh DB) | Retry, then flag unprocessed bids for humans; never invent results | n/a | n/a | n/a | Yes | **PASS after a fix.** 16 bids flagged "could not be fully processed - requires human review", 33 errors logged. First run reported "AGENT ANALYSIS COMPLETE" despite this (F1) |
| 15 | Audit tamper | UPDATE/DELETE rejected; chain verifies | n/a | n/a | n/a | n/a | **PASS.** Trigger rejects both; chain intact on a 43-record run |
| 16 | Structural no-award | No award tool; DB rejects award count > 0 | tools/list | n/a | n/a | n/a | **PASS** (MCP test + unit test) |

Overall run (scripted provider, fresh DB): 20/20 bids processed, 14 findings, 5 needing human review, 1 resolved on verification, 0 award decisions, audit chain intact.

## Known failures and weaknesses (not hidden)

- **F1 (found, fixed).** With the model down, the run still ended "AGENT ANALYSIS COMPLETE" while 16 bids were unprocessed. Now ends "AGENT ANALYSIS INCOMPLETE" whenever human flags exist. Also, re-running over already-processed bids silently skips them (by design: idempotent), which initially contaminated my first outage test; the test was rerun on a fresh DB.
- **F2 (open).** The misleading-anomaly resolution only works when the currency declaration sits on the same page as the price. If it were on another page, the flag would stay CONFIRMED-style/unresolved and a human would have to catch it. Currency extraction is the weakest part of ingest.
- **F3 (open).** Rule-based extraction only understands the demo's labelled-field layout. Real tender PDFs will mostly produce `missing_information` (safe, but noisy). No real PDF/OCR path exists.
- **F4 (open).** The calibration heuristic depends on submission order and calibration-set representativeness. If the first 7 bids were all inflated, later normal bids would look cheap. Not tested.
- **F5 (open).** Live Claude run, open-weights run, external MCP server, Supabase, and Vercel deployment have not been tested at all.
