import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

serveStdio(() => {
  const server = new McpServer(
    { name: "himawari-qualified-echo", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "echo",
    {
      description: "Echo a value for MCP SDK qualification",
      inputSchema: z.object({ value: z.string() }),
    },
    async ({ value }) => ({ content: [{ type: "text", text: value }] }),
  );

  return server;
});
