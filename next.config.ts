import type { NextConfig } from "next";

const config: NextConfig = {
  // Native/WASM Postgres drivers must not be bundled by webpack/turbopack.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  // Convenience alias: /mcp -> /api/mcp
  async rewrites() {
    return [{ source: "/mcp", destination: "/api/mcp" }];
  },
};
export default config;
