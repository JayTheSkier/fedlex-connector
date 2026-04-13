# Fedlex Connector

MCP server that gives Claude access to Swiss federal legislation from fedlex.admin.ch.

## Build & Run

- `npm run build` — compile TypeScript (always run after editing `src/`)
- `npm start` — run in stdio mode (local Claude Code / Claude Desktop)
- `npm run start:http` — run in HTTP mode on port 3000 (remote deployment)
- `npm run dev` — TypeScript watch mode

## Architecture

Four tools (`search_by_title`, `get_article`, `get_law_text`, `list_amendments`) backed by two data sources:

- **SPARQL** (`src/sparql.ts`) — queries Fedlex's SPARQL endpoint for metadata (RS numbers, consolidation URIs, amendment history)
- **Filestore** (`src/filestore.ts`) — fetches and parses static HTML from Fedlex's filestore for actual law text

Entry point (`src/index.ts`) detects `PORT` env var: if set, runs Express HTTP server; otherwise stdio.

## Code Conventions

- ES modules (`"type": "module"` in package.json) — use `.js` extensions in imports
- TypeScript strict mode — no `any` unless unavoidable
- Shared types live in `src/types.ts`
- SPARQL string literals must be escaped via `escapeSparqlString()` in `sparql.ts`
- SPARQL has rate limiting (10 req/s), filestore has rate limiting (20 req/s) — don't bypass it

## Testing on Claude.ai

To test local changes on Claude.ai without touching production:

The server has an `allowedHosts` whitelist in `src/index.ts` (inside `startHttpServer`).
Only hostnames in that list can connect — requests from other hostnames get 403.
Production uses `mcp.fedlex-connector.ch`. For local testing via a tunnel, you must
temporarily add the tunnel hostname to that list.

1. Start a cloudflared tunnel to get your temporary hostname:
   ```bash
   npx cloudflared tunnel --url http://localhost:3000
   ```
   It prints a random URL like `https://something-something.trycloudflare.com`.

2. Add that hostname to the `allowedHosts` array in `src/index.ts`:
   ```ts
   allowedHosts: ["mcp.fedlex-connector.ch", "localhost", "127.0.0.1", "something-something.trycloudflare.com"],
   ```

3. Build and start the server in HTTP mode:
   ```bash
   npm run build
   PORT=3000 node build/index.js
   ```

4. In Claude.ai → Settings → Integrations → Add MCP Server, paste the tunnel URL.

5. Test your changes. The server logs `duration_ms` to the terminal for each tool call.

6. When done:
   - Ctrl-C cloudflared and the server
   - **Revert the `allowedHosts` change in `src/index.ts`** — the tunnel hostname is
     temporary and must not be committed. Each tunnel run generates a new random hostname.
   - Remove the test connector from Claude.ai settings

The tunnel URL dies when you stop cloudflared. Production (`mcp.fedlex-connector.ch`) is
unaffected throughout — it runs on Railway from the `main` branch.

## External Services

This server queries Swiss government infrastructure. Be respectful:
- Don't increase rate limits
- Don't add retry loops without backoff
- Don't make requests in parallel that could spike load
