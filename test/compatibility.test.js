import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeFedlexFetchId,
  fedlexWebUrl,
  parseFedlexFetchId,
} from "../build/server.js";
import {
  extractArticle,
  extractFullText,
  paginateText,
} from "../build/filestore.js";

test("Fedlex fetch ids round-trip law lookup state", () => {
  const id = encodeFedlexFetchId({
    kind: "law",
    rs_number: "220",
    language: "fr",
    page: 3,
  });

  assert.match(id, /^fedlex:/);
  assert.deepEqual(parseFedlexFetchId(id), {
    kind: "law",
    rs_number: "220",
    language: "fr",
    page: 3,
  });
});

test("Fedlex fetch id parser rejects invalid ids", () => {
  assert.equal(parseFedlexFetchId("not-fedlex"), null);
  assert.equal(parseFedlexFetchId("fedlex:not-base64-json"), null);
});

test("Fedlex data URIs become language-specific web URLs", () => {
  assert.equal(
    fedlexWebUrl("https://fedlex.data.admin.ch/eli/cc/24/233_245_233", "de"),
    "https://www.fedlex.admin.ch/eli/cc/24/233_245_233/de"
  );

  assert.equal(
    fedlexWebUrl("https://www.fedlex.admin.ch/eli/cc/24/233_245_233/fr", "fr"),
    "https://www.fedlex.admin.ch/eli/cc/24/233_245_233/fr"
  );
});

test("Article extraction supports Fedlex-style article ids", () => {
  const html = `
    <main id="lawcontent">
      <section id="https://fedlex.data.admin.ch/example/art_28_a">
        <h2>Art. 28a</h2>
        <p class="absatz">Protection de la personnalite</p>
      </section>
    </main>
  `;

  const text = extractArticle(html, "28a");

  assert.ok(text);
  assert.match(text, /Art\. 28a/);
  assert.match(text, /Protection de la personnalite/);
});

test("Full text extraction prefers the lawcontent container", () => {
  const html = `
    <header>Navigation</header>
    <main id="lawcontent">
      <h1>RS 210</h1>
      <p class="absatz">Official text</p>
    </main>
  `;

  assert.match(extractFullText(html), /Official text/);
  assert.doesNotMatch(extractFullText(html), /Navigation/);
});

test("Pagination keeps large laws bounded and page-addressable", () => {
  const text = Array.from({ length: 10 }, (_, index) =>
    `Art. ${index + 1}\n${"x".repeat(5000)}`
  ).join("\n");

  const firstPage = paginateText(text, 1);
  const secondPage = paginateText(text, 2);

  assert.ok(firstPage.totalPages > 1);
  assert.equal(firstPage.page, 1);
  assert.equal(secondPage.page, 2);
  assert.notEqual(firstPage.text, secondPage.text);
});
