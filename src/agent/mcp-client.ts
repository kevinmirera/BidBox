import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export type McpToolDef = { name: string; description?: string; inputSchema: Record<string, any> };
export type McpResult = { isError: boolean; data: any; raw: any };

/**
 * Thin wrapper over the official MCP client (Streamable HTTP). Used for BOTH the Bid Box server and any
 * external MCP server, so adding a third-party server is configuration, not new plumbing.
 */
export class McpConnection {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  constructor(public readonly label: string, url: string, opts: { token?: string; headers?: Record<string, string>; timeoutMs?: number } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    this.transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
    this.client = new Client({ name: `bid-box-agent:${label}`, version: "0.1.0" });
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }
  private timeoutMs: number;
  async connect() { await this.client.connect(this.transport); return this; }
  async listTools(): Promise<McpToolDef[]> { return (await this.client.listTools()).tools as any; }
  async callTool(name: string, args: Record<string, unknown>): Promise<McpResult> {
    const res: any = await this.client.callTool({ name, arguments: args }, { timeout: this.timeoutMs } as any);
    let data = res.structuredContent;
    if (!data) { const t = res.content?.find((c: any) => c.type === "text")?.text; try { data = t ? JSON.parse(t) : t; } catch { data = t; } }
    return { isError: !!res.isError, data, raw: res };
  }
  async listResources() { return this.client.listResourceTemplates(); }
  async readResource(uri: string) { return this.client.readResource({ uri }); }
  async close() { try { await this.client.close(); } catch { /* ignore */ } }
}
