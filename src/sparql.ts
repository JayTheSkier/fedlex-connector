import {
  type SearchResult,
  type ConsolidationInfo,
  type Amendment,
  type Language,
  makeFedlexError,
} from "./types.js";

const SPARQL_ENDPOINT = "https://fedlex.data.admin.ch/sparqlendpoint";
const SPARQL_TIMEOUT_MS = 15_000;

const LANG_URI_MAP: Record<Language, string> = {
  fr: "http://publications.europa.eu/resource/authority/language/FRA",
  de: "http://publications.europa.eu/resource/authority/language/DEU",
  it: "http://publications.europa.eu/resource/authority/language/ITA",
};

// Simple rate limiter: max 10 requests per second
let requestTimestamps: number[] = [];
const MAX_REQUESTS_PER_SECOND = 10;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter((t) => now - t < 1000);
  if (requestTimestamps.length >= MAX_REQUESTS_PER_SECOND) {
    const waitTime = 1000 - (now - requestTimestamps[0]!);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }
  requestTimestamps.push(Date.now());
}

interface SparqlBinding {
  [key: string]: { type: string; value: string } | undefined;
}

export async function executeSparql(
  query: string
): Promise<SparqlBinding[]> {
  await rateLimit();

  const response = await fetch(SPARQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/sparql-results+json",
    },
    body: new URLSearchParams({ query }),
    signal: AbortSignal.timeout(SPARQL_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw makeFedlexError(
      "SPARQL_UNAVAILABLE",
      `SPARQL endpoint returned ${response.status}: ${response.statusText}`,
      ["The Fedlex SPARQL endpoint may be temporarily unavailable. Try again in a moment."]
    );
  }

  const data = (await response.json()) as {
    results: { bindings: SparqlBinding[] };
  };
  return data.results.bindings;
}

/**
 * Find the ConsolidationAbstract URI for a given RS number.
 *
 * Older acts store the RS number directly as jolux:historicalLegalId.
 * Newer acts (2024+) store it on a linked legal-taxonomy entry via skos:notation.
 * We query both paths with a UNION to handle all acts.
 */
export async function findWorkByRsNumber(
  rsNumber: string
): Promise<{ work_uri: string } | null> {
  rsNumber = rsNumber.trim();

  // When multiple ConsolidationAbstracts share the same RS number (e.g. an old
  // ordinance replaced by a newer one), pick the one with the most recent
  // consolidation date — that is the currently-in-force version.
  const query = `
    PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    SELECT ?abstract (MAX(?date) AS ?latestDate) WHERE {
      {
        ?abstract a jolux:ConsolidationAbstract ;
                  jolux:historicalLegalId "${escapeSparql(rsNumber)}" .
      } UNION {
        ?taxonomy skos:notation "${escapeSparql(rsNumber)}"^^<https://fedlex.data.admin.ch/vocabulary/notation-type/id-systematique> .
        ?abstract jolux:classifiedByTaxonomyEntry ?taxonomy ;
                  a jolux:ConsolidationAbstract .
      }
      ?consolidation jolux:isMemberOf ?abstract ;
                     jolux:dateApplicability ?date .
    } GROUP BY ?abstract ORDER BY DESC(?latestDate) LIMIT 1
  `;

  const results = await executeSparql(query);
  if (results.length === 0) return null;
  return { work_uri: results[0]!["abstract"]!.value };
}

/**
 * Get the latest consolidation (dated version) for a ConsolidationAbstract.
 * Each consolidation has a dateApplicability and is linked via isMemberOf.
 */
export async function getLatestConsolidation(
  abstractUri: string,
  targetDate?: string
): Promise<ConsolidationInfo | null> {
  const today = targetDate || new Date().toISOString().split("T")[0]!;

  const query = `
    PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    SELECT ?consolidation ?date WHERE {
      ?consolidation jolux:isMemberOf <${abstractUri}> ;
                     jolux:dateApplicability ?date .
      FILTER(?date <= "${today}"^^xsd:date)
    } ORDER BY DESC(?date) LIMIT 1
  `;

  const results = await executeSparql(query);
  if (results.length === 0) return null;

  return {
    uri: results[0]!["consolidation"]!.value,
    date: results[0]!["date"]!.value,
    work_uri: abstractUri,
  };
}

/**
 * Get filestore HTML URL(s) for a consolidation in a given language.
 * Follows: Consolidation → Expression (lang) → Manifestation (html) → Filestore URL
 */
export async function getFilestoreHtmlUrls(
  consolidationUri: string,
  language: Language
): Promise<string[]> {
  const query = `
    PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
    SELECT ?url WHERE {
      <${consolidationUri}/${language}> jolux:isEmbodiedBy ?manif .
      ?manif jolux:userFormat <https://fedlex.data.admin.ch/vocabulary/user-format/html> ;
             jolux:isExemplifiedBy ?url .
    }
  `;

  const results = await executeSparql(query);
  return results.map((r) => r["url"]!.value).sort();
}


/**
 * Search for acts by title keywords.
 * Queries ConsolidationAbstract resources that have titles matching the keywords.
 *
 * RS numbers are resolved via the legal-taxonomy (skos:notation) which works for
 * both older and newer acts, unlike jolux:historicalLegalId which is absent on 2024+ acts.
 */
export async function searchByTitle(
  keywords: string,
  language: Language
): Promise<SearchResult[]> {
  const langUri = LANG_URI_MAP[language];
  const words = keywords.toLowerCase().split(/\s+/).filter(Boolean);
  const filters = words
    .map((w) => `FILTER(CONTAINS(LCASE(STR(?title)), "${escapeSparql(w)}"))`)
    .join("\n      ");

  const query = `
    PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    SELECT DISTINCT ?abstract ?title ?rsId WHERE {
      ?abstract a jolux:ConsolidationAbstract ;
                jolux:classifiedByTaxonomyEntry ?taxonomy ;
                jolux:isRealizedBy ?expr .
      ?taxonomy skos:notation ?rsId .
      FILTER(DATATYPE(?rsId) = <https://fedlex.data.admin.ch/vocabulary/notation-type/id-systematique>)
      ?expr jolux:title ?title ;
            jolux:language <${langUri}> .
      ${filters}
    } ORDER BY ?rsId LIMIT 50
  `;

  const results = await executeSparql(query);
  return results.map((r) => ({
    rs_number: r["rsId"]!.value,
    title: stripHtmlTags(r["title"]!.value),
    work_uri: r["abstract"]!.value,
  }));
}

/**
 * List consolidation versions for an act (each version = an amendment took effect).
 * Since OC→CC links don't exist in the SPARQL graph, we list the consolidation dates.
 */
const AMENDMENT_LABELS: Record<Language, {
  fromTo: (from: string, to: string) => string;
  fromCurrent: (from: string) => string;
}> = {
  fr: {
    fromTo: (from, to) => `Version en vigueur du ${from} au ${to}`,
    fromCurrent: (from) => `Version en vigueur depuis le ${from} (actuelle)`,
  },
  de: {
    fromTo: (from, to) => `Fassung in Kraft vom ${from} bis ${to}`,
    fromCurrent: (from) => `Fassung in Kraft seit dem ${from} (aktuell)`,
  },
  it: {
    fromTo: (from, to) => `Versione in vigore dal ${from} al ${to}`,
    fromCurrent: (from) => `Versione in vigore dal ${from} (attuale)`,
  },
};

export async function listAmendments(
  abstractUri: string,
  since: string,
  language: Language
): Promise<Amendment[]> {
  const query = `
    PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    SELECT DISTINCT ?consolidation ?dateStart ?dateEnd WHERE {
      ?consolidation jolux:isMemberOf <${abstractUri}> ;
                     jolux:dateApplicability ?dateStart .
      OPTIONAL { ?consolidation jolux:dateEndApplicability ?dateEnd }
      FILTER(?dateStart >= "${since}"^^xsd:date)
    } ORDER BY DESC(?dateStart) LIMIT 50
  `;

  const results = await executeSparql(query);
  const labels = AMENDMENT_LABELS[language];
  return results.map((r) => ({
    uri: r["consolidation"]!.value,
    date: r["dateStart"]!.value,
    title: r["dateEnd"]?.value
      ? labels.fromTo(r["dateStart"]!.value, r["dateEnd"]!.value)
      : labels.fromCurrent(r["dateStart"]!.value),
  }));
}

function escapeSparql(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function stripHtmlTags(str: string): string {
  return str.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
