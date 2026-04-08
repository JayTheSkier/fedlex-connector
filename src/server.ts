import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  findWorkByRsNumber,
  getLatestConsolidation,
  getFilestoreHtmlUrls,
  searchByTitle,
  listAmendments,
} from "./sparql.js";
import {
  fetchAllHtmlParts,
  extractArticle,
  extractSection,
  extractFullText,
  paginateText,
  listArticleIds,
} from "./filestore.js";
import {
  type Language,
  type FedlexError,
  LEGAL_AUTHORITY_FOOTER,
  makeFedlexError,
} from "./types.js";

/**
 * Create a configured Fedlex Connector server instance.
 * Called once for stdio mode, or per-request for stateless HTTP mode.
 */
export function createFedlexServer(): Server {
  const server = new Server(
    {
      name: "fedlex-connector",
      version: "1.0.0",
      icons: [
        {
          src: "https://fedlex-connector.ch/logo.svg",
          mimeType: "image/svg+xml",
          sizes: ["any"],
        },
        {
          src: "https://fedlex-connector.ch/apple-touch-icon.png",
          mimeType: "image/png",
          sizes: ["180x180"],
        },
        {
          src: "https://fedlex-connector.ch/favicon-32.png",
          mimeType: "image/png",
          sizes: ["32x32"],
        },
        {
          src: "https://fedlex-connector.ch/favicon-16.png",
          mimeType: "image/png",
          sizes: ["16x16"],
        },
      ],
    },
    { capabilities: { tools: {} } }
  );

  // --- Tool definitions ---

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_by_title",
        description:
          "Search Swiss federal legislation titles in the Classified Compilation (RS/SR) on Fedlex. Use to find the RS number of a law when you know its name but not its number. Searches titles only, not article content.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "Keywords to match against act titles (e.g. 'code civil', 'protection des données')",
            },
            language: {
              type: "string",
              enum: ["fr", "de", "it"],
              description: "Language for results (default: fr)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_article",
        description:
          "Retrieve a single article when you already know the EXACT article number (e.g. from a cross-reference). Do NOT call this tool repeatedly to search for provisions — use get_law_text instead to fetch the full act or a section and locate relevant articles in the text.",
        inputSchema: {
          type: "object" as const,
          properties: {
            rs_number: {
              type: "string",
              description: "RS/SR number (e.g. '210' for CC, '220' for CO, '311.0' for CP)",
            },
            article: {
              type: "string",
              description: "Article number (e.g. '3', '28a', '41')",
            },
            language: {
              type: "string",
              enum: ["fr", "de", "it"],
              description: "Language (default: fr)",
            },
            date: {
              type: "string",
              description: "Consolidation date in YYYY-MM-DD format. Defaults to the latest available version.",
            },
          },
          required: ["rs_number", "article"],
        },
      },
      {
        name: "get_law_text",
        description:
          "Retrieve the official consolidated text of a Swiss federal act (or a specific title/chapter) directly from Fedlex (fedlex.admin.ch). This is the PRIMARY tool for answering Swiss law questions — always start here. Fetch the full act or a specific section, then locate relevant provisions in the returned text. Prefer this over get_article unless you already know the exact article number.",
        inputSchema: {
          type: "object" as const,
          properties: {
            rs_number: {
              type: "string",
              description: "RS/SR number (e.g. '210' for CC, '220' for CO)",
            },
            section: {
              type: "string",
              description: "Limit to a specific title, chapter, or part (e.g. 'Titre huitième', 'Zweiter Teil'). If omitted, returns the full act.",
            },
            language: {
              type: "string",
              enum: ["fr", "de", "it"],
              description: "Language (default: fr)",
            },
            page: {
              type: "number",
              description: "Page number for paginated results (default: 1). Large acts are split across multiple pages.",
            },
          },
          required: ["rs_number"],
        },
      },
      {
        name: "list_amendments",
        description:
          "List consolidation version dates for a Swiss federal act. Returns the dates each consolidated version took effect.",
        inputSchema: {
          type: "object" as const,
          properties: {
            rs_number: {
              type: "string",
              description: "RS/SR number",
            },
            since: {
              type: "string",
              description: "Start date in YYYY-MM-DD format (default: 1 year ago)",
            },
            language: {
              type: "string",
              enum: ["fr", "de", "it"],
              description: "Language for amendment titles (default: fr)",
            },
          },
          required: ["rs_number"],
        },
      },
    ],
  }));

  // --- Tool handlers ---

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const start = Date.now();

    try {
      let result;
      switch (name) {
        case "search_by_title":
          result = await handleSearchByTitle(args);
          break;
        case "get_article":
          result = await handleGetArticle(args);
          break;
        case "get_law_text":
          result = await handleGetLawText(args);
          break;
        case "list_amendments":
          result = await handleListAmendments(args);
          break;
        default:
          result = errorResponse(makeFedlexError("INVALID_INPUT", `Unknown tool: ${name}`));
      }

      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        tool: name,
        args: sanitizeArgs(args),
        duration_ms: Date.now() - start,
        ok: !("isError" in result),
      }));

      return result;
    } catch (e) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        tool: name,
        args: sanitizeArgs(args),
        duration_ms: Date.now() - start,
        ok: false,
        error: (e as Error).message,
      }));

      if (isFedlexError(e)) {
        return errorResponse(e);
      }
      return errorResponse(
        makeFedlexError("SPARQL_UNAVAILABLE", `Unexpected error: ${(e as Error).message}`, [
          "This may be a temporary issue. Try again.",
        ])
      );
    }
  });

  return server;
}

// --- Tool handler implementations ---

async function handleSearchByTitle(args: Record<string, unknown>) {
  const query = args["query"] as string;
  const language = validateLanguage(args["language"] as string | undefined);

  if (!query || query.trim().length === 0) {
    return errorResponse(
      makeFedlexError("INVALID_INPUT", "The 'query' parameter is required.", [
        "Provide keywords to search for, e.g. 'code civil' or 'Datenschutz'.",
      ])
    );
  }

  const results = await searchByTitle(query, language);

  if (results.length === 0) {
    return textResponse(
      `No acts found matching "${query}" in ${language.toUpperCase()}.\n\n` +
        `Try different keywords or a different language (fr, de, it).`
    );
  }

  const formatted = results
    .map((r) => `RS ${r.rs_number} — ${r.title}`)
    .join("\n");

  return textResponse(
    `Found ${results.length} act(s) matching "${query}":\n\n${formatted}`
  );
}

async function handleGetArticle(args: Record<string, unknown>) {
  const rsNumber = args["rs_number"] as string;
  const article = args["article"] as string;
  const language = validateLanguage(args["language"] as string | undefined);
  const date = args["date"] as string | undefined;

  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return errorResponse(
      makeFedlexError("INVALID_INPUT", `Invalid date format: "${date}". Expected YYYY-MM-DD.`, [
        "Provide a date in YYYY-MM-DD format, e.g. '2024-01-15'.",
      ])
    );
  }

  if (!rsNumber) {
    return errorResponse(
      makeFedlexError("INVALID_INPUT", "The 'rs_number' parameter is required.")
    );
  }
  if (!article) {
    return errorResponse(
      makeFedlexError("INVALID_INPUT", "The 'article' parameter is required.")
    );
  }

  const work = await findWorkByRsNumber(rsNumber);
  if (!work) {
    return errorResponse(
      makeFedlexError("RS_NOT_FOUND", `No act found with RS number ${rsNumber}.`, [
        "Verify the RS number or use search_by_title to find the correct number.",
      ])
    );
  }

  const consolidation = await getLatestConsolidation(work.work_uri, date);
  if (!consolidation) {
    return errorResponse(
      makeFedlexError(
        "FILESTORE_ERROR",
        `No consolidation found for RS ${rsNumber}${date ? ` at date ${date}` : ""}.`,
        date
          ? ["Try without specifying a date to get the latest version."]
          : ["This act may not have any consolidated version available."]
      )
    );
  }

  const htmlUrls = await getFilestoreHtmlUrls(consolidation.uri, language);
  if (htmlUrls.length === 0) {
    return errorResponse(
      makeFedlexError(
        "FILESTORE_ERROR",
        `No HTML version found for RS ${rsNumber} (${consolidation.date}) in ${language.toUpperCase()}. Fedlex generally only provides HTML for consolidations from 2021 onwards.`,
        ["Try without a date parameter to get the latest version, or use a date from 2021 onwards."]
      )
    );
  }

  const { html, warning } = await fetchAllHtmlParts(htmlUrls);
  const articleText = extractArticle(html, article);

  if (!articleText) {
    const availableIds = listArticleIds(html);
    const nearby = availableIds.slice(0, 10);
    return errorResponse(
      makeFedlexError(
        "ARTICLE_NOT_FOUND",
        `Article ${article} not found in RS ${rsNumber}.`,
        nearby.length > 0
          ? [`Available articles include: ${nearby.join(", ")}. The article may have been repealed or the number may be different.`]
          : ["The article number may be incorrect. Try using get_law_text to browse the act."]
      )
    );
  }

  let response = `RS ${rsNumber}, Art. ${article} (${language.toUpperCase()})\n`;
  response += `Consolidation date: ${consolidation.date}\n`;
  if (date && date !== consolidation.date) {
    response += `\n⚠ HISTORICAL VERSION: You are viewing the version as of ${consolidation.date}, not the current version.\n`;
  }
  response += `\n${articleText}`;
  if (warning) response += `\n\n${warning}`;
  response += LEGAL_AUTHORITY_FOOTER;

  return textResponse(response);
}

async function handleGetLawText(args: Record<string, unknown>) {
  const rsNumber = args["rs_number"] as string;
  const section = args["section"] as string | undefined;
  const language = validateLanguage(args["language"] as string | undefined);
  const page = Math.max(1, (args["page"] as number) || 1);

  if (!rsNumber) {
    return errorResponse(
      makeFedlexError("INVALID_INPUT", "The 'rs_number' parameter is required.")
    );
  }

  const work = await findWorkByRsNumber(rsNumber);
  if (!work) {
    return errorResponse(
      makeFedlexError("RS_NOT_FOUND", `No act found with RS number ${rsNumber}.`, [
        "Verify the RS number or use search_by_title to find the correct number.",
      ])
    );
  }

  const consolidation = await getLatestConsolidation(work.work_uri);
  if (!consolidation) {
    return errorResponse(
      makeFedlexError("FILESTORE_ERROR", `No consolidation found for RS ${rsNumber}.`, [
        "This act may not have any consolidated version available.",
      ])
    );
  }

  const htmlUrls = await getFilestoreHtmlUrls(consolidation.uri, language);
  if (htmlUrls.length === 0) {
    return errorResponse(
      makeFedlexError(
        "FILESTORE_ERROR",
        `No HTML version found for RS ${rsNumber} (${consolidation.date}) in ${language.toUpperCase()}. Fedlex generally only provides HTML for consolidations from 2021 onwards.`,
        ["Try without a date parameter to get the latest version, or use a date from 2021 onwards."]
      )
    );
  }

  const { html, warning } = await fetchAllHtmlParts(htmlUrls);

  let rawText: string;
  if (section) {
    const sectionText = extractSection(html, section);
    if (!sectionText) {
      rawText = extractFullText(html);
      rawText = `Note: Could not isolate section "${section}". Returning full act text.\n\n${rawText}`;
    } else {
      rawText = sectionText;
    }
  } else {
    rawText = extractFullText(html);
  }

  const paginated = paginateText(rawText, page);

  let response = `RS ${rsNumber}`;
  if (section) response += ` — ${section}`;
  response += ` (${language.toUpperCase()})\n`;
  response += `Consolidation date: ${consolidation.date}\n`;
  if (paginated.totalPages > 1) {
    response += `Page ${paginated.page} of ${paginated.totalPages}\n`;
  }
  response += `\n${paginated.text}`;
  if (paginated.totalPages > 1 && paginated.page < paginated.totalPages) {
    response += `\n\n[Page ${paginated.page} of ${paginated.totalPages}. Use page=${paginated.page + 1} to continue reading.]`;
  }
  if (warning) response += `\n\n${warning}`;
  response += LEGAL_AUTHORITY_FOOTER;

  return textResponse(response);
}

async function handleListAmendments(args: Record<string, unknown>) {
  const rsNumber = args["rs_number"] as string;
  const language = validateLanguage(args["language"] as string | undefined);

  if (!rsNumber) {
    return errorResponse(
      makeFedlexError("INVALID_INPUT", "The 'rs_number' parameter is required.")
    );
  }

  const sinceRaw = args["since"] as string | undefined;
  if (sinceRaw && !/^\d{4}-\d{2}-\d{2}$/.test(sinceRaw)) {
    return errorResponse(
      makeFedlexError("INVALID_INPUT", `Invalid date format: "${sinceRaw}". Expected YYYY-MM-DD.`, [
        "Provide a date in YYYY-MM-DD format, e.g. '2024-01-15'.",
      ])
    );
  }
  const since = sinceRaw ||
    new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;

  const work = await findWorkByRsNumber(rsNumber);
  if (!work) {
    return errorResponse(
      makeFedlexError("RS_NOT_FOUND", `No act found with RS number ${rsNumber}.`, [
        "Verify the RS number or use search_by_title to find the correct number.",
      ])
    );
  }

  const amendments = await listAmendments(work.work_uri, since, language);

  if (amendments.length === 0) {
    return textResponse(
      `No amendments found for RS ${rsNumber} since ${since}.` + LEGAL_AUTHORITY_FOOTER
    );
  }

  const formatted = amendments
    .map((a) => `${a.date} — ${a.title}`)
    .join("\n");

  return textResponse(
    `Amendments to RS ${rsNumber} since ${since}:\n\n${formatted}` + LEGAL_AUTHORITY_FOOTER
  );
}

// --- Helpers ---

function validateLanguage(lang: string | undefined): Language {
  if (!lang) return "fr";
  const normalized = lang.toLowerCase().trim();
  if (normalized === "fr" || normalized === "de" || normalized === "it") {
    return normalized;
  }
  return "fr";
}

function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResponse(error: FedlexError) {
  let text = `Error: ${error.message}`;
  if (error.suggestions.length > 0) {
    text += "\n\nSuggestions:\n" + error.suggestions.map((s) => `- ${s}`).join("\n");
  }
  return { content: [{ type: "text" as const, text }], isError: true };
}

function isFedlexError(e: unknown): e is FedlexError {
  return typeof e === "object" && e !== null && "error" in e && (e as any).error === true;
}

/** Keep only short, useful args for logging (exclude large text payloads if any). */
function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.length > 200) {
      out[k] = v.slice(0, 200) + "…";
    } else {
      out[k] = v;
    }
  }
  return out;
}
