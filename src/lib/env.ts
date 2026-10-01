// Central, server-only environment access. Never import this from client components.
export const env = {
  get databaseUrl() { return process.env.DATABASE_URL || ""; },
  get anthropicKey() { return process.env.ANTHROPIC_API_KEY || ""; },
  get modelProvider() { return (process.env.MODEL_PROVIDER || "claude").toLowerCase(); },
  get claudeModel() { return process.env.CLAUDE_MODEL || "claude-sonnet-5-5"; },
  get mcpAuthToken() { return process.env.MCP_AUTH_TOKEN || ""; },
  get adminToken() { return process.env.ADMIN_API_TOKEN || ""; },
  get isProd() { return process.env.NODE_ENV === "production"; },
  get toolTimeoutMs() { return Number(process.env.TOOL_TIMEOUT_MS || 30000); },
};

/**
 * Resolve the URL of the Bid Box MCP endpoint without hard-coding a project name.
 * Order: MCP_SERVER_URL > NEXT_PUBLIC_APP_URL > VERCEL_PROJECT_PRODUCTION_URL / VERCEL_URL > localhost.
 */
export function resolveMcpUrl(): string {
  if (process.env.MCP_SERVER_URL) return process.env.MCP_SERVER_URL;
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`) ||
    (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
    `http://localhost:${process.env.PORT || 3000}`;
  return `${base.replace(/\/$/, "")}/api/mcp`;
}
