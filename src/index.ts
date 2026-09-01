#!/usr/bin/env node

import type { Request, Response } from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { createFedlexServer } from "./server.js";

const PORT = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : undefined;
const DEFAULT_ALLOWED_HOSTS = ["mcp.fedlex-connector.ch", "localhost", "127.0.0.1"];
const activeHttpServers: ReturnType<ReturnType<typeof createMcpExpressApp>["listen"]>[] = [];

async function main() {
  if (PORT) {
    await startHttpServer(PORT);
  } else {
    await startStdioServer();
  }
}

/**
 * Stdio mode: single server instance, used by Claude Code and Claude Desktop.
 */
async function startStdioServer() {
  const server = createFedlexServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * HTTP mode: stateless Streamable HTTP, used by claude.ai and remote clients.
 * Each request gets a fresh server+transport pair (no session state).
 */
async function startHttpServer(port: number) {
  const app = createMcpExpressApp({
    host: "0.0.0.0",
    allowedHosts: getAllowedHosts(),
  });

  const handleMcpPost = async (req: Request, res: Response) => {
    const server = createFedlexServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }

    res.on("close", () => {
      transport.close();
      server.close();
    });
  };

  app.post("/", handleMcpPost);
  app.post("/mcp", handleMcpPost);

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      })
    );
  };

  app.get("/", methodNotAllowed);
  app.get("/mcp", methodNotAllowed);
  app.delete("/", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", server: "fedlex-connector", version: "1.0.0" });
  });

  const httpServer = app.listen(port, "0.0.0.0", () => {
    console.log(`Fedlex Connector listening on http://0.0.0.0:${port}`);
  });
  activeHttpServers.push(httpServer);
}

function getAllowedHosts(): string[] {
  const configured = process.env["ALLOWED_HOSTS"]?.split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return configured && configured.length > 0 ? configured : DEFAULT_ALLOWED_HOSTS;
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
