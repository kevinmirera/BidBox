-- Lock down Bid Box's own tables for Supabase's public REST API (PostgREST).
-- With RLS enabled and NO policies, the anon/publishable and authenticated roles can read/write nothing.
-- The app connects as the database owner through DATABASE_URL, which bypasses RLS, so it keeps working.
ALTER TABLE IF EXISTS bids               ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS documents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS evidence           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS investigations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS agent_runs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS calibration_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS evaluations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS human_approvals    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS tool_calls         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS document_chunks    ENABLE ROW LEVEL SECURITY;
