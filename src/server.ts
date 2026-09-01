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

const SERVER_INSTRUCTIONS =
  "Use this server for Swiss federal legislation in the Fedlex Classified Compilation only. Prefer get_law_text for legal research, get_article only when the exact article is known, and always preserve the RS number, language, consolidation date, and source URL. This server provides source text, not legal advice.";

const LEGAL_AUTHORITY_NOTICE =
  "Source: Fedlex (fedlex.admin.ch). This is not an official publication. Only the publication of the Federal Chancellery is authoritative.";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const LANGUAGE_PROPERTY = {
  type: "string",
  enum: ["fr", "de", "it"],
  description: "Language (default: de)",
} as const;

const SUPPORTED_LANGUAGES: Language[] = ["de", "fr", "it"];

const SEARCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
        },
        required: ["id", "title", "url"],
      },
    },
  },
  required: ["results"],
} as const;

const FETCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    text: { type: "string" },
    url: { type: "string" },
    metadata: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["id", "title", "text", "url"],
} as const;

const SEARCH_BY_TITLE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    language: { type: "string" },
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rs_number: { type: "string" },
          title: { type: "string" },
          source_url: { type: "string" },
        },
        required: ["rs_number", "title", "source_url"],
      },
    },
  },
  required: ["query", "language", "results"],
} as const;

const ARTICLE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    rs_number: { type: "string" },
    article: { type: "string" },
    language: { type: "string" },
    consolidation_date: { type: "string" },
    requested_date: { type: ["string", "null"] },
    historical: { type: "boolean" },
    text: { type: "string" },
    source_url: { type: "string" },
    source_urls: { type: "array", items: { type: "string" } },
    warning: { type: ["string", "null"] },
    legal_notice: { type: "string" },
  },
  required: [
    "rs_number",
    "article",
    "language",
    "consolidation_date",
    "historical",
    "text",
    "source_url",
    "source_urls",
    "legal_notice",
  ],
} as const;

const LAW_TEXT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    rs_number: { type: "string" },
    section: { type: ["string", "null"] },
    language: { type: "string" },
    consolidation_date: { type: "string" },
    page: { type: "number" },
    total_pages: { type: "number" },
    text: { type: "string" },
    source_url: { type: "string" },
    source_urls: { type: "array", items: { type: "string" } },
    warning: { type: ["string", "null"] },
    legal_notice: { type: "string" },
  },
  required: [
    "rs_number",
    "language",
    "consolidation_date",
    "page",
    "total_pages",
    "text",
    "source_url",
    "source_urls",
    "legal_notice",
  ],
} as const;

const AMENDMENTS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    rs_number: { type: "string" },
    since: { type: "string" },
    language: { type: "string" },
    amendments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          title: { type: "string" },
          uri: { type: "string" },
        },
        required: ["date", "title", "uri"],
      },
    },
    legal_notice: { type: "string" },
  },
  required: ["rs_number", "since", "language", "amendments", "legal_notice"],
} as const;

export interface FedlexFetchId {
  kind: "law";
  rs_number: string;
  language: Language;
  page: number;
}

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
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  // --- Tool definitions ---

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search",
        title: "Search Fedlex",
        description:
          "Search currently in-force Swiss federal legislation by title across German, French, and Italian. Use this ChatGPT-compatible retrieval tool to find citable Fedlex results, then call fetch with a returned id for law text.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "Search query string.",
            },
          },
          required: ["query"],
        },
        outputSchema: SEARCH_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      {
        name: "fetch",
        title: "Fetch Fedlex Result",
        description:
          "Fetch text for a Fedlex search result by id. Use this ChatGPT-compatible retrieval tool after search. Large laws may be returned page by page, with next_id in metadata.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "Unique result id returned by search.",
            },
          },
          required: ["id"],
        },
        outputSchema: FETCH_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      {
        name: "search_by_title",
        title: "Search Legislation Titles",
        description:
          "Search Swiss federal legislation titles in the Classified Compilation (RS/SR) on Fedlex. Use to find the RS number of a law when you know its name but not its number. Searches titles only, not article content. Returns only acts currently in force.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "Keywords to match against act titles (e.g. 'code civil', 'protection des données')",
            },
            language: {
              ...LANGUAGE_PROPERTY,
              description: "Language for results (default: de)",
            },
          },
          required: ["query"],
        },
        outputSchema: SEARCH_BY_TITLE_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      {
        name: "get_article",
        title: "Get Article",
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
              ...LANGUAGE_PROPERTY,
            },
            date: {
              type: "string",
              description: "Consolidation date in YYYY-MM-DD format. Defaults to the latest available version.",
            },
          },
          required: ["rs_number", "article"],
        },
        outputSchema: ARTICLE_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      {
        name: "get_law_text",
        title: "Get Law Text",
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
              ...LANGUAGE_PROPERTY,
            },
            page: {
              type: "number",
              description: "Page number for paginated results (default: 1). Large acts are split across multiple pages.",
            },
          },
          required: ["rs_number"],
        },
        outputSchema: LAW_TEXT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      {
        name: "list_amendments",
        title: "List Amendments",
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
              ...LANGUAGE_PROPERTY,
              description: "Language for amendment titles (default: de)",
            },
          },
          required: ["rs_number"],
        },
        outputSchema: AMENDMENTS_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
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
        case "search":
          result = await handleSearch(args);
          break;
        case "fetch":
          result = await handleFetch(args);
          break;
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

async function handleSearch(args: Record<string, unknown>) {
  const query = args["query"] as string;

  if (!query || query.trim().length === 0) {
    return jsonResponse({ results: [] });
  }

  const wordCount = query.split(/\s+/).filter(Boolean).length;
  if (wordCount > 20) {
    return jsonResponse({ results: [] });
  }

  const results = [];
  for (const language of SUPPORTED_LANGUAGES) {
    const languageResults = await searchByTitle(query, language);
    for (const result of languageResults) {
      results.push({
        id: encodeFedlexFetchId({
          kind: "law",
          rs_number: result.rs_number,
          language,
          page: 1,
        }),
        title: `RS ${result.rs_number} (${language.toUpperCase()}) - ${result.title}`,
        url: fedlexWebUrl(result.work_uri, language),
      });
    }
  }

  return jsonResponse({ results: results.slice(0, 20) });
}

async function handleFetch(args: Record<string, unknown>) {
  const id = args["id"] as string;
  if (!id) {
    return errorResponse(
      makeFedlexError("INVALID_INPUT", "The 'id' parameter is required.", [
        "Pass an id returned by the search tool.",
      ])
    );
  }

  const parsed = parseFedlexFetchId(id);
  if (!parsed) {
    return errorResponse(
      makeFedlexError("INVALID_INPUT", `Invalid Fedlex fetch id: "${id}".`, [
        "Call search first and pass one of the returned result ids to fetch.",
      ])
    );
  }

  const work = await findWorkByRsNumber(parsed.rs_number);
  if (!work) {
    return errorResponse(
      makeFedlexError("RS_NOT_FOUND", `No act found with RS number ${parsed.rs_number}.`, [
        "Call search again to find a current result id.",
      ])
    );
  }

  const consolidation = await getLatestConsolidation(work.work_uri);
  if (!consolidation) {
    return errorResponse(
      makeFedlexError("FILESTORE_ERROR", `No consolidation found for RS ${parsed.rs_number}.`, [
        "This act may not have any consolidated version available.",
      ])
    );
  }

  const htmlUrls = await getFilestoreHtmlUrls(consolidation.uri, parsed.language);
  if (htmlUrls.length === 0) {
    return errorResponse(
      makeFedlexError(
        "FILESTORE_ERROR",
        `No HTML version found for RS ${parsed.rs_number} (${consolidation.date}) in ${parsed.language.toUpperCase()}. Fedlex generally only provides HTML for consolidations from 2021 onwards.`,
        ["Try a different result or use one of the dedicated Fedlex tools."]
      )
    );
  }

  const { html, sourceUrls, warning } = await fetchAllHtmlParts(htmlUrls);
  const rawText = extractFullText(html);
  const paginated = paginateText(rawText, parsed.page);
  const sourceUrl = fedlexWebUrl(consolidation.uri, parsed.language);
  const nextId =
    paginated.page < paginated.totalPages
      ? encodeFedlexFetchId({ ...parsed, page: paginated.page + 1 })
      : null;

  const text =
    `RS ${parsed.rs_number} (${parsed.language.toUpperCase()})\n` +
    `Consolidation date: ${consolidation.date}\n` +
    `Page ${paginated.page} of ${paginated.totalPages}\n\n` +
    paginated.text +
    (warning ? `\n\n${warning}` : "") +
    `\n\n${LEGAL_AUTHORITY_NOTICE}`;

  return jsonResponse({
    id,
    title: `RS ${parsed.rs_number} (${parsed.language.toUpperCase()})`,
    text,
    url: sourceUrl,
    metadata: {
      rs_number: parsed.rs_number,
      language: parsed.language,
      consolidation_date: consolidation.date,
      page: paginated.page,
      total_pages: paginated.totalPages,
      next_id: nextId,
      source_urls: sourceUrls,
      warning: warning ?? null,
      legal_notice: LEGAL_AUTHORITY_NOTICE,
    },
  });
}

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

  // Each word becomes a SPARQL CONTAINS filter; cap to bound upstream query cost.
  const wordCount = query.split(/\s+/).filter(Boolean).length;
  if (wordCount > 20) {
    return errorResponse(
      makeFedlexError("INVALID_INPUT", `Too many search terms (${wordCount}); use up to 20.`, [
        "Narrow your search to the most distinctive keywords.",
      ])
    );
  }

  const results = await searchByTitle(query, language);

  if (results.length === 0) {
    return textResponse(
      `No acts found matching "${query}" in ${language.toUpperCase()}.\n\n` +
        `Try different keywords or a different language (fr, de, it).`,
      { query, language, results: [] }
    );
  }

  const structuredResults = results.map((r) => ({
    rs_number: r.rs_number,
    title: r.title,
    source_url: fedlexWebUrl(r.work_uri, language),
  }));

  const formatted = results
    .map((r) => `RS ${r.rs_number} — ${r.title}`)
    .join("\n");

  return textResponse(
    `Found ${results.length} act(s) matching "${query}":\n\n${formatted}`,
    { query, language, results: structuredResults }
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

  const { html, sourceUrls, warning } = await fetchAllHtmlParts(htmlUrls);
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
  const historical = Boolean(date && date !== consolidation.date);
  if (date && date !== consolidation.date) {
    response += `\n⚠ HISTORICAL VERSION: You are viewing the version as of ${consolidation.date}, not the current version.\n`;
  }
  response += `\n${articleText}`;
  if (warning) response += `\n\n${warning}`;
  response += LEGAL_AUTHORITY_FOOTER;

  return textResponse(response, {
    rs_number: rsNumber,
    article,
    language,
    consolidation_date: consolidation.date,
    requested_date: date ?? null,
    historical,
    text: articleText,
    source_url: fedlexWebUrl(consolidation.uri, language),
    source_urls: sourceUrls,
    warning: warning ?? null,
    legal_notice: LEGAL_AUTHORITY_NOTICE,
  });
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

  const { html, sourceUrls, warning } = await fetchAllHtmlParts(htmlUrls);

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
  const sourceUrl = fedlexWebUrl(consolidation.uri, language);

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

  return textResponse(response, {
    rs_number: rsNumber,
    section: section ?? null,
    language,
    consolidation_date: consolidation.date,
    page: paginated.page,
    total_pages: paginated.totalPages,
    text: paginated.text,
    source_url: sourceUrl,
    source_urls: sourceUrls,
    warning: warning ?? null,
    legal_notice: LEGAL_AUTHORITY_NOTICE,
  });
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
      `No amendments found for RS ${rsNumber} since ${since}.` + LEGAL_AUTHORITY_FOOTER,
      {
        rs_number: rsNumber,
        since,
        language,
        amendments: [],
        legal_notice: LEGAL_AUTHORITY_NOTICE,
      }
    );
  }

  const formatted = amendments
    .map((a) => `${a.date} — ${a.title}`)
    .join("\n");

  return textResponse(
    `Amendments to RS ${rsNumber} since ${since}:\n\n${formatted}` + LEGAL_AUTHORITY_FOOTER,
    {
      rs_number: rsNumber,
      since,
      language,
      amendments,
      legal_notice: LEGAL_AUTHORITY_NOTICE,
    }
  );
}

// --- Helpers ---

export function encodeFedlexFetchId(payload: FedlexFetchId): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `fedlex:${encoded}`;
}

export function parseFedlexFetchId(id: string): FedlexFetchId | null {
  if (!id.startsWith("fedlex:")) return null;

  try {
    const decoded = JSON.parse(
      Buffer.from(id.slice("fedlex:".length), "base64url").toString("utf8")
    ) as {
      kind?: unknown;
      rs_number?: unknown;
      language?: unknown;
      page?: unknown;
    };

    if (
      decoded.kind !== "law" ||
      typeof decoded.rs_number !== "string" ||
      !isLanguage(decoded.language)
    ) {
      return null;
    }

    const page =
      typeof decoded.page === "number" && Number.isInteger(decoded.page) && decoded.page > 0
        ? decoded.page
        : 1;

    return {
      kind: "law",
      rs_number: decoded.rs_number,
      language: decoded.language,
      page,
    };
  } catch {
    return null;
  }
}

export function fedlexWebUrl(resourceUri: string, language: Language): string {
  const webUri = resourceUri.replace(
    /^https:\/\/fedlex\.data\.admin\.ch/,
    "https://www.fedlex.admin.ch"
  );
  const cleanUri = webUri.replace(/\/+$/, "");

  return cleanUri.endsWith(`/${language}`) ? cleanUri : `${cleanUri}/${language}`;
}

function validateLanguage(lang: string | undefined): Language {
  if (!lang) return "de";
  const normalized = lang.toLowerCase().trim();
  if (isLanguage(normalized)) {
    return normalized;
  }
  return "de";
}

function isLanguage(value: unknown): value is Language {
  return value === "fr" || value === "de" || value === "it";
}

function textResponse(text: string, structuredContent?: Record<string, unknown>) {
  const response: {
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: Record<string, unknown>;
  } = { content: [{ type: "text", text }] };

  if (structuredContent) {
    response.structuredContent = structuredContent;
  }

  return response;
}

function jsonResponse(structuredContent: Record<string, unknown>) {
  return {
    structuredContent,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
  };
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
