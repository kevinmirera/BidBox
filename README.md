# Bid Box

Agentic procurement **analysis** for a human procurement committee. Bid Box observes, calibrates, investigates, verifies and documents. It **never awards a tender**: there is no `award_tender`, `select_winner` or approve tool anywhere, and the `evaluations` table has a `CHECK (award_decisions_made = 0)`.

```
User -> Web UI -> /api/runs -> LangGraph -> ModelProvider (Claude now; open-weights later)
                                   |
                                   v
                               MCP client --(Streamable HTTP)--> Bid Box MCP server (/api/mcp)
                                   |                               |-- automatic audit middleware
                                   +--> optional external MCP      |-- calibration engine (deterministic)
                                                                   |-- evidence/verification (deterministic)
                                                                   '-- PostgreSQL (Supabase)
```

## What has and has not been verified (read this first)

| Area | Status |
|---|---|
| MCP server over Streamable HTTP: handshake, tool discovery, tool calls, structured results, errors, resources | **Tested** (`npm run test:mcp`, 19 protocol checks, local) |
| Domain logic (calibration, extraction, triggers, audit immutability, provider translation) | **Tested** (`npm test`, 24 unit tests) |
| Full LangGraph workflow over real MCP calls, 20 bids, all demo scenarios | **Tested with a scripted test-double model** (not an LLM) |
| Failure handling (model outage mid-run) | **Tested** with the test double; see EVALS.md |
| `next build` (production) | **Tested** locally; production-mode auth fails closed |
| ClaudeProvider against the live Anthropic API | **NOT tested** (no API key in the build environment). Message translation is unit-tested only |
| OpenWeightsProvider | **NOT tested against a real model.** Translation + parsing tested against a stubbed HTTP layer; unconfigured by default |
| External MCP server | **Plumbing implemented, NOT verified against a real third-party server** |
| Supabase / real Postgres | **NOT tested.** All runs used in-process PGlite (real Postgres in WASM). SQL is standard; `pgvector` migration is optional and was skipped under PGlite |
| Vercel deployment | **NOT performed.** Build passes locally; deployed URL derivation is implemented but unexercised on Vercel |

## MCP transport (verified against current docs)

The current remote transport is **Streamable HTTP**. This repo uses Vercel's `mcp-handler@2` on top of `@modelcontextprotocol/server@2` (SDK v2), which serves the 2026-07-28 spec and falls back to stateless Streamable HTTP for 2025-era clients. The route is `src/app/api/mcp/route.ts`, so the endpoint is `/api/mcp` (also rewritten from `/mcp`). HTTP+SSE is not used.

## Local development

```bash
npm install
npm run dev            # http://localhost:3000  (no DATABASE_URL needed locally)
```

With no `DATABASE_URL`, the app uses in-memory Postgres (PGlite) auto-seeded with the demo tender. It is refused in production. Because that DB is in-process, run the agent through the web app (`Run analysis` button or `POST /api/runs`), not the CLI, in this mode.

```bash
npm test               # unit tests (no server needed)
npm run test:mcp       # MCP protocol test (server must be running)
curl localhost:3000/api/health
# Demo without any LLM key (test double, NOT an LLM):
curl -X POST localhost:3000/api/runs -H 'content-type: application/json' \
  -d '{"tender_id":"TND-2026-014","provider":"scripted","batch_size":25}'
```

Open http://localhost:3000, press **Run analysis**.

## Database (Supabase)

1. Supabase -> Project Settings -> Database -> copy the **connection string** (for Vercel use the pooled Transaction string, port 6543).
2. `export DATABASE_URL='postgresql://...'`
3. `npm run migrate` then `npm run seed` (both idempotent; they refuse to run without `DATABASE_URL`).
4. Optional pgvector: enable the `vector` extension in Supabase (Database -> Extensions); `002_vector.sql` creates `document_chunks`. Nothing depends on it yet.

## Environment variables

See `.env.example`. Required in production: `DATABASE_URL`, `MCP_AUTH_TOKEN`, `ADMIN_API_TOKEN`, and `ANTHROPIC_API_KEY` (for `MODEL_PROVIDER=claude`). Production fails closed: `/api/mcp` returns 401 and operator routes return 503 when tokens are unset. Never commit `.env`.

## Deploy to Vercel

1. Push the repo to GitHub; Vercel -> Add New Project -> import it (framework auto-detected as Next.js; no `vercel.json` is needed).
2. Add the environment variables above (Project -> Settings -> Environment Variables).
3. Deploy. Vercel gives the project a URL such as `https://<project-name>.vercel.app` (shown on the project dashboard under **Domains**; the name is whatever *you* chose, nothing is hard-coded).
4. **Your MCP endpoint is `https://<project-name>.vercel.app/api/mcp`.** The app also derives this at runtime (`resolveMcpUrl()`): `MCP_SERVER_URL` > `NEXT_PUBLIC_APP_URL` > `VERCEL_PROJECT_PRODUCTION_URL` > `VERCEL_URL` > localhost. `GET /api/health` returns the derived `mcp_endpoint`.
5. Test remotely:
   ```bash
   MCP_URL=https://<project-name>.vercel.app/api/mcp MCP_AUTH_TOKEN=<token> npm run test:mcp
   ```
6. Connect a Claude/MCP client: URL above with header `Authorization: Bearer <MCP_AUTH_TOKEN>`. (Clients that cannot send custom headers will not be able to connect to a token-protected endpoint; note that some hosted MCP integrations expect OAuth, which this version does not implement.)

Vercel Hobby functions are short-lived. Runs are processed in **batches** (`batch_size`) and state persists in `agent_runs`, so a run can be resumed by posting the returned `run_id` again. Set `maxDuration` according to your plan.

## Using the agent against a real model

`MODEL_PROVIDER=claude` + `ANTHROPIC_API_KEY`. `CLAUDE_MODEL` defaults to `claude-sonnet-5-5`. Not yet exercised live: expect to tune prompts.

## Activating an open-weights model later

Provide any OpenAI-compatible chat-completions endpoint with tool-calling support (vLLM, TGI, a hosted provider): set `OPENWEIGHTS_ENDPOINT_URL` (base URL ending `/v1`), `OPENWEIGHTS_MODEL`, optionally `OPENWEIGHTS_API_KEY`, then `MODEL_PROVIDER=openweights`. If both Claude and open-weights are configured, `/api/runs` fails over from Claude to open-weights on 429/5xx/timeouts only. The model cannot run inside Vercel; host it as a separate GPU service. **The challenge's open-weights requirement is not yet met** until a real model completes a run.

## External MCP server

Set `EXTERNAL_MCP_SERVER_URL` (+ optional `EXTERNAL_MCP_AUTH_TOKEN`). Candidate: a currency-conversion MCP server (several public ones wrap ECB/Frankfurter data). Caveat: ECB data omits some African currencies, so the tender's reference rate stays authoritative. See ARCHITECTURE.md. Not verified against a live server.

## Security notes

Bearer auth on MCP and operator routes; Zod validation and strict ID patterns on every tool; size/page limits on documents; supplier text is wrapped in `<untrusted_supplier_document_excerpt>` and matched against injection patterns; only a fixed tool allow-list per graph node; audit table is append-only (DB trigger) and hash-chained; export of the committee file needs a recorded human approval. No file upload or real PDF parsing exists yet (see limitations).

## Known limitations

- Documents are stored as pre-extracted page text; there is **no real PDF parser or upload path** yet. "Malformed PDF" is modelled as `parse_status=MALFORMED`. Extraction is rule-based on labelled fields, so differently formatted documents yield `missing_information`, not guesses.
- 20-bid demo data is synthetic and was designed alongside the checks, so passing it is weak evidence about real tenders.
- The calibration mechanism is an experimental heuristic, not a procurement rule.
- Auth is static bearer tokens, not per-user identity; "human approver" is a name typed by the operator.
