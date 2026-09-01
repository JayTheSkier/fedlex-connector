# ChatGPT Compatibility

This project exposes a read-only MCP server for Swiss federal legislation. The ChatGPT-compatible endpoint is:

```text
https://mcp.fedlex-connector.ch/mcp
```

The original root endpoint remains available for existing clients:

```text
https://mcp.fedlex-connector.ch/
```

## Local Development

Install dependencies and build:

```bash
npm ci
npm run build
```

Run the HTTP server locally:

```bash
npm run start:http
```

The local MCP endpoint is:

```text
http://localhost:3000/mcp
```

If you expose the local server through a tunnel or deploy it under another hostname, set `ALLOWED_HOSTS`:

```bash
PORT=3000 ALLOWED_HOSTS=localhost,127.0.0.1,your-domain.example node build/index.js
```

## ChatGPT Desktop And Developer Mode

For ChatGPT development, register an MCP-backed app in ChatGPT Developer Mode and point it at the `/mcp` endpoint. Use the public endpoint for normal testing, or a tunnelled local endpoint while developing.

The MCP server exposes two standard retrieval tools:

- `search(query)`: searches currently in-force Swiss federal legislation titles across German, French, and Italian.
- `fetch(id)`: fetches the selected law text page by page and returns citable Fedlex URLs.

It also keeps the domain-specific tools:

- `search_by_title`
- `get_article`
- `get_law_text`
- `list_amendments`

## Plugin Bundle

The repo-local plugin bundle lives at:

```text
plugins/fedlex-connector/
```

Important files:

- `.codex-plugin/plugin.json`: plugin metadata.
- `.mcp.json`: direct MCP server binding.
- `.app.json`: app binding file.
- `skills/fedlex-law/SKILL.md`: usage guidance for Swiss federal law research.

The committed `.app.json` is intentionally empty because ChatGPT Developer Mode generates the real app id. After registration, bind it like this:

```json
{
  "apps": {
    "fedlex": {
      "id": "asdk_app_your_generated_id",
      "required": true
    }
  }
}
```

Do not publish a placeholder app id. Commit only a real id when the app has been registered.

## Verification

Run:

```bash
npm test
```

The tests avoid live Fedlex network calls and cover the compatibility helpers, URL generation, article extraction, and pagination behavior.
