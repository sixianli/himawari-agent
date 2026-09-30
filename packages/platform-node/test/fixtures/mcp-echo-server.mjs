import { markMcpStartup } from "./mcp-startup-preload.mjs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

markMcpStartup("module_loaded");

serveStdio(() => {
  markMcpStartup("server_created");
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
    async ({ value }) => {
      markMcpStartup("tool_called");
      return { content: [{ type: "text", text: value }] };
    },
  );

  return server;
});
