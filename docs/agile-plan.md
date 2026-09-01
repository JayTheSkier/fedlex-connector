# Agile Plan: ChatGPT MCP Compatibility

## Feature: GitFlow Setup

User story: As a maintainer, I want isolated development so `main` stays stable.

Tasks:
- Create feature branch `codex/chatgpt-mcp-compat`.
- Keep implementation commits focused and documented.
- Run build and tests before final handoff.

Status: Complete.

## Feature: ChatGPT MCP Endpoint

User story: As a ChatGPT user, I want a stable remote MCP endpoint so ChatGPT can connect reliably.

Tasks:
- Add `POST /mcp`.
- Keep existing `POST /` for Claude compatibility.
- Keep `/health`.
- Add `ALLOWED_HOSTS` configuration for deployment domains.

Status: Complete.

## Feature: MCP Metadata Upgrade

User story: As ChatGPT, I need clear tool metadata so I can choose tools correctly.

Tasks:
- Add server instructions.
- Add tool titles.
- Add read-only annotations.
- Add output schemas.

Status: Complete.

## Feature: Structured Tool Results

User story: As a plugin/API client, I want structured results, not only prose.

Tasks:
- Return `structuredContent` alongside text content.
- Include RS number, language, consolidation date, source URL, warning, and legal notice metadata.
- Preserve existing text responses for current users.

Status: Complete.

## Feature: OpenAI Search/Fetch Compatibility

User story: As a ChatGPT retrieval user, I want standard `search` and `fetch` tools.

Tasks:
- Add `search(query)`.
- Add `fetch(id)`.
- Use opaque Fedlex IDs that include RS number, language, and page.
- Return citable URLs and pagination metadata.

Status: Complete.

## Feature: Plugin Package

User story: As a developer, I want an installable plugin bundle that points to the MCP server.

Tasks:
- Add `plugins/fedlex-connector/.codex-plugin/plugin.json`.
- Add `plugins/fedlex-connector/.mcp.json`.
- Add `plugins/fedlex-connector/.app.json` as an empty app binding file.
- Add a Fedlex usage skill.

Status: Complete.

## Feature: Tests And Docs

User story: As a maintainer, I want confidence and clear setup instructions.

Tasks:
- Add network-free compatibility tests.
- Add `npm test`.
- Document ChatGPT Desktop and plugin development workflow.

Status: Complete.
