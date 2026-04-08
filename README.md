# Fedlex Connector

**Access Swiss Federal Law from Claude**

A connector that gives Claude direct access to the official text of Swiss federal legislation on [Fedlex](https://www.fedlex.admin.ch), built on the [Model Context Protocol](https://modelcontextprotocol.io) (MCP). Covers all acts in the Classified Compilation (RS/SR) in French, German, and Italian.

---

## Why This Exists

Swiss federal law is published exclusively on Fedlex, but the frontend is a JavaScript single-page application that Claude's built-in web tools cannot render. However, Fedlex exposes two machine-readable interfaces that work without JavaScript:

- A **SPARQL endpoint** (`fedlex.data.admin.ch/sparqlendpoint`) for metadata queries
- A **static HTML filestore** (`fedlex.admin.ch/filestore/...`) serving consolidated legislation

This MCP server bridges the gap: it queries SPARQL for metadata (RS numbers, consolidation dates, amendment history), fetches and parses the HTML for the actual legislative text, and returns it to Claude in a structured format. No proprietary database, no cache -- just a stateless bridge to Fedlex's open data infrastructure.

---

## Setup

The server supports two transports: **stdio** for local use (Claude Code, Claude Desktop) and **HTTP** for remote use (claude.ai, mobile). You can use one or both.

The server is hosted at:

```
https://mcp.fedlex-connector.ch
```

**claude.ai / Claude Desktop / Claude mobile:**

1. Go to [claude.ai](https://claude.ai)
2. Click your profile icon → **Customize**
3. Scroll to **Connectors** → **Add custom connector**
4. Enter the URL: `https://mcp.fedlex-connector.ch`

The connector syncs across claude.ai, Claude Desktop, and the Claude mobile app.

**Claude Code:**

```bash
claude mcp add --transport http fedlex https://mcp.fedlex-connector.ch
```

Once connected, Claude can answer questions like *"What does art. 1 of the Swiss Civil Code say?"* by pulling the text directly from Fedlex.

### Deploying Your Own Instance

The server includes a `Dockerfile` for deploying to any cloud platform that supports Docker containers (Railway, Fly.io, Render, etc.). Set the `PORT` environment variable and the server runs in HTTP mode. Without `PORT`, it runs in stdio mode for local use.

Your MCP endpoint will be at `https://your-domain`. Verify with:

```bash
curl https://your-domain/health
```

---

## Tools

### `search_by_title`

Search Swiss federal legislation titles in the Classified Compilation (RS/SR). Returns only acts currently in force.

| Parameter  | Type              | Required | Description                          |
|------------|-------------------|----------|--------------------------------------|
| `query`    | string            | Yes      | Keywords to match against act titles |
| `language` | `fr` `de` `it`    | No       | Language for results (default: `fr`) |

**Example:** Find the RS number for the data protection act.

```
search_by_title(query="protection des données")
→ RS 235.1 — Loi fédérale sur la protection des données (LPD)
```

### `get_article`

Retrieve the official consolidated text of a specific article.

| Parameter   | Type              | Required | Description                                      |
|-------------|-------------------|----------|--------------------------------------------------|
| `rs_number` | string            | Yes      | RS number (e.g. `"210"` for CC, `"220"` for CO)  |
| `article`   | string            | Yes      | Article number (e.g. `"3"`, `"28a"`, `"260bis"`) |
| `language`  | `fr` `de` `it`    | No       | Language (default: `fr`)                          |
| `date`      | string            | No       | Consolidation date (YYYY-MM-DD); defaults to latest |

**Example:** Retrieve art. 1 CC in German.

```
get_article(rs_number="210", article="1", language="de")
→ Art. 1: Das Gesetz findet auf alle Rechtsfragen Anwendung...
```

### `get_law_text`

Retrieve the full text of an act or a specific title/chapter. This is the primary tool for reading and analysing legislation from the source.

| Parameter   | Type              | Required | Description                                          |
|-------------|-------------------|----------|------------------------------------------------------|
| `rs_number` | string            | Yes      | RS number                                             |
| `section`   | string            | No       | Limit to a title/chapter (e.g. `"Titre huitième"`)   |
| `language`  | `fr` `de` `it`    | No       | Language (default: `fr`)                               |
| `page`      | number            | No       | Page for paginated results (default: 1)                |

Large acts are paginated automatically (splitting at article boundaries). Each response includes the total page count.

**Example:** Retrieve Swiss tenancy law (CO, Title 8).

```
get_law_text(rs_number="220", section="Titre huitième", language="fr")
→ [Full text of tenancy provisions, art. 253 onwards]
```

### `list_amendments`

List recent amendments (consolidation versions) for a given act.

| Parameter   | Type              | Required | Description                                |
|-------------|-------------------|----------|--------------------------------------------|
| `rs_number` | string            | Yes      | RS number                                   |
| `since`     | string            | No       | Start date, YYYY-MM-DD (default: 1 year ago)|
| `language`  | `fr` `de` `it`    | No       | Language for titles (default: `fr`)          |

**Example:** Check recent changes to the CO.

```
list_amendments(rs_number="220", since="2024-01-01")
→ 2026-01-01 — Version in force from 2026-01-01 (current)
  2025-10-01 — Version in force from 2025-10-01 to 2025-12-31
  ...
```

---

## How It Works

```
Claude  ──MCP──>  Fedlex Connector  ──SPARQL──>  fedlex.data.admin.ch
                                      ──HTTP───>   fedlex.admin.ch/filestore/...
```

**Metadata path (SPARQL):** The server queries Fedlex's SPARQL endpoint (JOLux ontology) to resolve RS numbers to internal URIs, find the latest consolidation date, discover HTML file URLs, and list amendment history.

**Text path (HTML filestore):** Once the server knows which HTML file(s) to fetch, it retrieves them from the static filestore, parses the DOM with Cheerio, and extracts the requested article, section, or full text. Large acts (like the CO with 1,100+ articles) are split across multiple HTML files which the server discovers and stitches together automatically.

**Data flow for a typical request:**

1. Claude calls `get_article(rs_number="210", article="3")`
2. Server queries SPARQL: RS 210 → ConsolidationAbstract URI
3. Server queries SPARQL: latest consolidation date for that URI
4. Server queries SPARQL: HTML filestore URL(s) for that consolidation
5. Server fetches HTML, parses it, extracts art. 3
6. Server returns the article text to Claude with consolidation date and legal caveat

Every response includes a footer noting that only the Official Compilation (RO/AS) published by the Federal Chancellery is legally authoritative.

---

## Development

### Project Structure

```
src/
  index.ts       # Entry point: picks stdio or HTTP transport based on PORT env var
  server.ts      # MCP server factory: tool definitions and request handlers
  types.ts       # TypeScript interfaces, error types, constants
  sparql.ts      # SPARQL endpoint queries (metadata, RS resolution, amendments)
  filestore.ts   # HTML fetching, parsing, article/section extraction, pagination
build/           # Compiled JavaScript (generated by tsc)
Dockerfile       # Container build for cloud deployment
```

### Scripts

| Command              | Description                              |
|----------------------|------------------------------------------|
| `npm run build`      | Compile TypeScript to `./build`          |
| `npm start`          | Run the MCP server (stdio mode)          |
| `npm run start:http` | Run locally in HTTP mode on port 3000    |
| `npm run dev`        | Watch mode (auto-recompile on changes)   |

### Dependencies

| Package                       | Purpose                                       |
|-------------------------------|-----------------------------------------------|
| `@modelcontextprotocol/sdk`   | MCP server SDK (tool registration, stdio transport) |
| `cheerio`                     | HTML parsing for extracting legislative text   |

### Error Codes

The server returns structured errors with codes and actionable suggestions:

| Code               | Meaning                                          |
|--------------------|--------------------------------------------------|
| `RS_NOT_FOUND`     | RS number not found in the SPARQL graph          |
| `ARTICLE_NOT_FOUND`| Article does not exist in the act (with nearby IDs listed) |
| `SPARQL_UNAVAILABLE`| SPARQL endpoint is down or returned an error    |
| `FILESTORE_ERROR`  | HTML file not found or fetch failed              |
| `INVALID_INPUT`    | Missing or malformed parameters                  |
| `PARSE_ERROR`      | HTML parsing failure                             |

---

## Known Limitations

- **HTML availability:** Fedlex generally only provides HTML for consolidations from 2021 onwards. Older versions are only available as PDF or DOC on the Fedlex platform. The server returns a clear error with guidance when HTML is unavailable for a requested date.

- **Rate limiting:** The SPARQL endpoint and filestore are public Swiss government services. The server limits itself to 10 requests/second per endpoint to be a responsible client.

- **Section filtering:** The `section` parameter in `get_law_text` uses heading-text matching which works well for standard section names but may not match unusual headings. When filtering fails, the full act text is returned with a note.

- **Language coverage:** Supports French (FR), German (DE), and Italian (IT). Romansch is not available. Not all acts have versions in all three languages.

- **Scope:** Covers federal law in the Classified Compilation only. Cantonal law, the Federal Gazette, and court decisions are out of scope.

---

## License

MIT
