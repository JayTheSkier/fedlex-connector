export interface SearchResult {
  rs_number: string;
  title: string;
  work_uri: string;
}

export interface ConsolidationInfo {
  uri: string;
  date: string;
  work_uri: string;
}


export interface Amendment {
  uri: string;
  date: string;
  title: string;
}

export type ErrorCode =
  | "RS_NOT_FOUND"
  | "ARTICLE_NOT_FOUND"
  | "SPARQL_UNAVAILABLE"
  | "FILESTORE_ERROR"
  | "INVALID_INPUT"
  | "PARSE_ERROR";

export interface FedlexError {
  error: true;
  code: ErrorCode;
  message: string;
  suggestions: string[];
}

export function makeFedlexError(
  code: ErrorCode,
  message: string,
  suggestions: string[] = []
): FedlexError {
  return { error: true, code, message, suggestions };
}

export type Language = "fr" | "de" | "it";

export const LANGUAGE_CODES: Record<Language, string> = {
  fr: "FRA",
  de: "DEU",
  it: "ITA",
};

export const LEGAL_AUTHORITY_FOOTER =
  "\n\n---\nSource: Fedlex (fedlex.admin.ch). Note: Only the official version published in the Official Compilation (RO/AS) is legally authoritative.";
