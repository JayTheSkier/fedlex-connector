---
name: fedlex-law
description: Use Fedlex Connector MCP tools for Swiss federal legislation in the Classified Compilation.
---

# Fedlex Law

Use this skill when the user asks about Swiss federal legislation, SR/RS numbers, Swiss codes, federal acts, ordinances, or recent consolidated law changes.

## Tool Choice

- Use `search` or `search_by_title` when the user knows a law name but not its RS/SR number.
- Use `get_law_text` for legal research, broad questions, or when the relevant article is unknown.
- Use `get_article` only when the exact RS/SR number and article number are already known.
- Use `list_amendments` when the user asks whether a federal act changed recently or asks for consolidation dates.
- Use `fetch` after `search` when working through the ChatGPT-compatible search/fetch retrieval flow.

## Response Requirements

- Always include the RS/SR number, language, consolidation date, and source URL when available.
- Treat returned Fedlex text as source material, not legal advice.
- Mention that only the Federal Chancellery publication is authoritative when precision matters.
- Do not use this connector for cantonal law, court decisions, Federal Gazette material, or non-Swiss law.

## Language

Default to German when the user does not specify a language. Use French or Italian when the user asks in that language or requests it explicitly.
