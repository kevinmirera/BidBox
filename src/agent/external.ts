import { McpConnection, type McpToolDef } from "./mcp-client";

/**
 * Optional third-party MCP server (the challenge requires one we did not write).
 * Configured ONLY via env (EXTERNAL_MCP_SERVER_URL, optional EXTERNAL_MCP_AUTH_TOKEN). Nothing is
 * connected unless it is set, so Bid Box never claims an integration it has not made.
 *
 * Intended role: a currency-conversion / FX-rates MCP server (several public ones wrap the ECB-backed
 * Frankfurter API). Bid Box uses it to cross-check how a quoted foreign-currency price converts, which is
 * exactly what the "misleading anomaly" demo case needs. Caveat: ECB reference data covers ~30 currencies and
 * not every African currency (e.g. KES), so for unsupported currencies the tender's own reference rate
 * (tender clause 4.2) remains the authority and the external result is treated as advisory.
 * Rebuilding FX data ourselves would duplicate a maintained data service and add stale-rate risk.
 *
 * External tools are exposed to the model namespaced as ext__<name>, read-only by policy (allow-list below),
 * and every call is mirrored into Bid Box's audit trail because the third party does not write to it.
 */
export const EXT_PREFIX = "ext__";
export const externalConfigured = () => !!process.env.EXTERNAL_MCP_SERVER_URL;
// Only tools whose names look read-only are exposed. Extend deliberately, never by wildcard.
const READ_ONLY = /^(convert|get_|list_|latest|historical|exchange|rate|currenc)/i;

export async function connectExternal(runId: string): Promise<{ conn: McpConnection; tools: McpToolDef[] } | null> {
  if (!externalConfigured()) return null;
  const conn = await new McpConnection("external", process.env.EXTERNAL_MCP_SERVER_URL!, { token: process.env.EXTERNAL_MCP_AUTH_TOKEN, headers: { "x-bidbox-run-id": runId } }).connect();
  const tools = (await conn.listTools()).filter((t) => READ_ONLY.test(t.name)).map((t) => ({ ...t, name: EXT_PREFIX + t.name, description: `[EXTERNAL MCP SERVER, advisory only] ${t.description ?? ""}` }));
  return { conn, tools };
}
