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
## External Services

This server queries Swiss government infrastructure. Be respectful:
- Don't increase rate limits
- Don't add retry loops without backoff
- Don't make requests in parallel that could spike load
