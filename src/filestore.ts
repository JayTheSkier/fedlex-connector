import * as cheerio from "cheerio";
import { makeFedlexError } from "./types.js";

// Rate limiter shared with SPARQL (separate bucket for filestore)
let filestoreTimestamps: number[] = [];
const MAX_REQUESTS_PER_SECOND = 10;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  filestoreTimestamps = filestoreTimestamps.filter((t) => now - t < 1000);
  if (filestoreTimestamps.length >= MAX_REQUESTS_PER_SECOND) {
    const waitTime = 1000 - (now - filestoreTimestamps[0]!);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }
  filestoreTimestamps.push(Date.now());
}

export async function fetchHtml(url: string): Promise<string> {
  await rateLimit();

  const response = await fetch(url, {
    headers: { Accept: "text/html" },
    redirect: "follow",
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw makeFedlexError(
        "FILESTORE_ERROR",
        `HTML file not found at ${url}. The consolidation may not exist for the given date.`,
        ["Try without specifying a date to get the latest version."]
      );
    }
    throw makeFedlexError(
      "FILESTORE_ERROR",
      `Filestore returned ${response.status}: ${response.statusText}`,
      ["The Fedlex filestore may be temporarily unavailable. Try again in a moment."]
    );
  }

  return response.text();
}

/**
 * Like fetchHtml, but returns null for 404 instead of throwing.
 * Used by multipart fetching where 404 is a normal end-of-parts signal.
 */
async function tryFetchHtml(url: string): Promise<string | null> {
  await rateLimit();

  const response = await fetch(url, {
    headers: { Accept: "text/html" },
    redirect: "follow",
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    throw makeFedlexError(
      "FILESTORE_ERROR",
      `Filestore returned ${response.status}: ${response.statusText}`,
      ["The Fedlex filestore may be temporarily unavailable. Try again in a moment."]
    );
  }

  return response.text();
}

// Size thresholds for placeholder detection.
// Fedlex returns 200 for non-existent parts but serves an SPA placeholder (~9KB).
// Real content parts are much larger (typically 100KB+).
const DEFINITE_PLACEHOLDER_SIZE = 5_000;
const SUSPECT_PLACEHOLDER_SIZE = 20_000;

/**
 * Detect whether an HTML response is a Fedlex SPA placeholder rather than real content.
 * Uses a two-tier check: very small pages are definitely placeholders; medium-sized pages
 * are checked for legal content markers before being dismissed.
 */
function isPlaceholder(html: string): boolean {
  if (html.length < DEFINITE_PLACEHOLDER_SIZE) return true;
  if (html.length >= SUSPECT_PLACEHOLDER_SIZE) return false;
  return !html.includes('id="lawcontent"') && !html.includes('class="absatz"');
}

export async function fetchAllHtmlParts(urls: string[]): Promise<{ html: string; warning?: string }> {
  if (urls.length === 0) {
    throw makeFedlexError("FILESTORE_ERROR", "No HTML URLs found for this consolidation.", [
      "Try a different consolidation date or language.",
    ]);
  }

  // SPARQL typically returns a single URL (often the last part like -4.html).
  // We need to discover all parts by probing from -1.html upward.
  const url = urls[0]!;
  const multiPartMatch = url.match(/^(.+)-(\d+)(\.html)$/);

  if (multiPartMatch) {
    return fetchMultiPart(multiPartMatch[1]!, multiPartMatch[3]!);
  }

  // No part number suffix — single file
  return { html: await fetchHtml(url) };
}

async function fetchMultiPart(baseUrl: string, extension: string): Promise<{ html: string; warning?: string }> {
  const parts: string[] = [];
  let partNum = 1;
  let warning: string | undefined;

  while (true) {
    const url = `${baseUrl}-${partNum}${extension}`;
    let html: string | null;
    try {
      html = await tryFetchHtml(url);
    } catch {
      // Non-404 error (500, network failure, etc.)
      if (parts.length > 0) {
        warning = `WARNING: The text may be incomplete. An error occurred while fetching part ${partNum}. Parts 1\u2013${parts.length} were retrieved successfully.`;
        break;
      }
      throw makeFedlexError("FILESTORE_ERROR", "No HTML content found in filestore.", [
        "The HTML files may not be available for this consolidation.",
      ]);
    }

    // null = 404 (legitimate end of parts)
    if (html === null || isPlaceholder(html)) {
      break;
    }

    parts.push(html);
    partNum++;
  }

  if (parts.length === 0) {
    throw makeFedlexError("FILESTORE_ERROR", "No HTML content found in filestore.", [
      "The HTML files may not be available for this consolidation.",
    ]);
  }

  return { html: parts.join("\n"), warning };
}

export function extractArticle(html: string, articleNumber: string): string | null {
  const $ = cheerio.load(html);

  // Normalize article number: "28a" → "28_a", "28bis" → "28_bis"
  const normalizedNum = articleNumber.trim().toLowerCase();
  // Insert underscore between digits and letters: "28a" → "28_a"
  const withUnderscore = normalizedNum.replace(/(\d)([a-z])/gi, "$1_$2");

  // Try multiple ID patterns used by Fedlex
  const selectors = [
    `#art_${withUnderscore}`,
    `#art_${normalizedNum}`,
    `[id$="/art_${withUnderscore}"]`,
    `[id$="/art_${normalizedNum}"]`,
    `[id*="art_${withUnderscore}"]`,
  ];

  for (const selector of selectors) {
    const el = $(selector).first();
    if (el.length > 0) {
      // The article element and all its content
      return elementToText($, el);
    }
  }

  // Fallback: search for article heading text like "Art. 3" or "Art. 28a"
  const headingPattern = new RegExp(`^\\s*Art\\.?\\s*${escapeRegex(normalizedNum)}\\b`, "i");
  let found: cheerio.Cheerio<any> | null = null;

  $("h1, h2, h3, h4, h5, h6, .heading, .article-heading, .man-art").each((_, el) => {
    if (found) return;
    const text = $(el).text().trim();
    if (headingPattern.test(text)) {
      // Walk up to find the containing article/section element
      const parent = $(el).closest("article, section, div[id*='art']");
      if (parent.length > 0) {
        found = parent;
      } else {
        found = $(el);
      }
    }
  });

  if (found) {
    return elementToText($, found);
  }

  return null;
}

export function extractSection(html: string, sectionPath: string): string | null {
  const $ = cheerio.load(html);

  // Try to match section by ID or heading text
  const normalized = sectionPath.trim().toLowerCase();

  // Try ID-based lookup first
  const sectionSelectors = [
    `[id*="${normalized.replace(/\s+/g, "_")}"]`,
    `[id*="${normalized.replace(/\s+/g, "")}"]`,
  ];

  for (const selector of sectionSelectors) {
    const el = $(selector).first();
    if (el.length > 0) {
      return elementToText($, el);
    }
  }

  // Try heading-text matching
  const headingPattern = new RegExp(escapeRegex(sectionPath.trim()), "i");
  let sectionEl: cheerio.Cheerio<any> | null = null;

  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    if (sectionEl) return;
    const text = $(el).text().trim();
    if (headingPattern.test(text)) {
      const parent = $(el).closest("section, div[id]");
      if (parent.length > 0) {
        sectionEl = parent;
      }
    }
  });

  if (sectionEl) {
    return elementToText($, sectionEl);
  }

  return null;
}

export function extractFullText(html: string): string {
  const $ = cheerio.load(html);

  // Try #lawcontent first (main content container)
  const lawContent = $("#lawcontent");
  if (lawContent.length > 0) {
    return elementToText($, lawContent);
  }

  // Fallback: extract from body, skipping script/style
  $("script, style, nav, footer, header").remove();
  return $("body").text().replace(/\n{3,}/g, "\n\n").trim();
}

export function listArticleIds(html: string): string[] {
  const $ = cheerio.load(html);
  const ids: string[] = [];

  $("[id*='art_'], article[id]").each((_, el) => {
    const id = $(el).attr("id");
    if (id) {
      const match = id.match(/art_(\w+)/);
      if (match) ids.push(match[1]!);
    }
  });

  return [...new Set(ids)];
}

const APPROX_TOKENS_PER_CHAR = 0.25; // rough estimate for multilingual text
const TARGET_TOKENS_PER_PAGE = 4000;
const TARGET_CHARS_PER_PAGE = TARGET_TOKENS_PER_PAGE / APPROX_TOKENS_PER_CHAR;

export function paginateText(text: string, page: number): { text: string; page: number; totalPages: number } {
  if (text.length <= TARGET_CHARS_PER_PAGE) {
    return { text, page: 1, totalPages: 1 };
  }

  // Split at article boundaries (lines starting with "Art." or "Art ")
  const lines = text.split("\n");
  const pages: string[] = [];
  let currentPage = "";

  for (const line of lines) {
    const isArticleBoundary = /^\s*Art\.?\s+\d/.test(line);

    if (isArticleBoundary && currentPage.length >= TARGET_CHARS_PER_PAGE) {
      pages.push(currentPage.trim());
      currentPage = "";
    }

    currentPage += line + "\n";
  }

  if (currentPage.trim()) {
    pages.push(currentPage.trim());
  }

  // If no article boundaries were found, split by character count
  if (pages.length <= 1 && text.length > TARGET_CHARS_PER_PAGE) {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += TARGET_CHARS_PER_PAGE) {
      chunks.push(text.slice(i, i + TARGET_CHARS_PER_PAGE));
    }
    const requestedPage = Math.max(1, Math.min(page, chunks.length));
    return { text: chunks[requestedPage - 1]!, page: requestedPage, totalPages: chunks.length };
  }

  const totalPages = pages.length;
  const requestedPage = Math.max(1, Math.min(page, totalPages));

  return {
    text: pages[requestedPage - 1]!,
    page: requestedPage,
    totalPages,
  };
}

function elementToText(
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<any>
): string {
  // Clone and clean up
  const clone = el.clone();
  clone.find("script, style").remove();

  // Convert to readable text preserving structure
  const lines: string[] = [];
  processNode($, clone, lines, 0);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function processNode(
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<any>,
  lines: string[],
  depth: number
): void {
  el.contents().each((_, node) => {
    if (node.type === "text") {
      const text = $(node).text().trim();
      if (text) {
        lines.push(text);
      }
    } else if (node.type === "tag") {
      const tagName = (node as any).tagName?.toLowerCase();
      const child = $(node);

      if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(tagName)) {
        lines.push("");
        lines.push(child.text().trim());
        lines.push("");
      } else if (tagName === "br") {
        lines.push("");
      } else if (tagName === "p" || tagName === "div") {
        const cls = child.attr("class") || "";
        if (cls.includes("absatz") || cls.includes("artikel")) {
          lines.push(child.text().trim());
        } else {
          processNode($, child, lines, depth + 1);
        }
      } else if (tagName === "table") {
        // Render tables as plain text
        child.find("tr").each((_, tr) => {
          const cells: string[] = [];
          $(tr)
            .find("td, th")
            .each((__, td) => {
              cells.push($(td).text().trim());
            });
          lines.push(cells.join(" | "));
        });
      } else if (tagName === "sup" && child.hasClass("fn")) {
        // Footnote reference — skip inline
      } else {
        processNode($, child, lines, depth + 1);
      }
    }
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
