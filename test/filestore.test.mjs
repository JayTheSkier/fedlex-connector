import assert from "node:assert/strict";
import test from "node:test";
import { extractArticle, extractFullText, extractSection } from "../build/filestore.js";

// Markup shape from the German ZGB consolidation dated 2026-07-01.
// The prose is synthetic; no network access is needed to reproduce the bug.
const article = `<article id="art_28"><h6 class="heading"><a href="#art_28"><b>Art. 28</b></a><sup><a href="#fn-note30" id="fnbck-note30">30</a></sup></h6>
<div class="collapseable"><p class="absatz"><sup>1</sup>&nbsp;Paragraph <a href="#art_41">Art. 41</a><sup><a href="#fn-note31">31</a></sup>.</p>
<p class="absatz"><sup>2</sup>&nbsp;Area: m<sup>2</sup>.</p>
<table><tr><td>Value<sup><a href="#fn-note31">31</a></sup></td><td>42</td></tr></table>
<div class="footnotes"><p id="fn-note30"><sup><a href="#fnbck-note30">30</a></sup>Amendment <a href="https://example.org">AS <b>1984</b> 778</a>.</p>
<p id="fn-note31"><sup><a href="#fnbck-note31">31</a></sup>Another note.</p></div></div></article>`;
const html = `<div id="lawcontent"><section id="chapter">${article}</section></div>`;

for (const [name, extract] of [
  ["article", (input) => extractArticle(input, "28")],
  ["section", (input) => extractSection(input, "chapter")],
  ["full act", extractFullText],
  ["body fallback", (input) => extractFullText(input.replace('id="lawcontent"', 'id="other"'))],
]) {
  test(`${name}: footnotes stay distinct from article and paragraph numbers`, () => {
    const text = extract(html);
    assert.match(text, /Art\. 28 \[footnote 30\]/);
    assert.doesNotMatch(text, /Art\. 2830/);
    assert.match(text, /1\u00a0Paragraph Art\. 41 \[footnote 31\] \./);
    assert.match(text, /2\u00a0Area: m2\./);
    assert.match(text, /Value \[footnote 31\] \| 42/);
    assert.match(text, /Footnotes:\n\[footnote 30\] Amendment AS 1984 778\./);
    assert.match(text, /\[footnote 31\] Another note\./);
  });
}

test("legacy footnotes and nested superscripts are marked once", () => {
  const text = extractArticle(`<article id="art_1"><h6>Art. 1<sup><sup><a href="#fn-n">7</a></sup></sup></h6><p class="absatz">Text<sup class="fn">8</sup>.</p><p>More<sup class="fn"><a href="#fn-m">9</a></sup></p></article>`, "1");
  assert.match(text, /Art\. 1 \[footnote 7\]/);
  assert.match(text, /Text \[footnote 8\] \./);
  assert.equal((text.match(/\[footnote 9\]/g) || []).length, 1);
});

test("articles without footnotes retain their existing output", () => {
  assert.equal(extractArticle('<article id="art_3"><h6>Art. 3</h6><p class="absatz"><sup>1</sup>&nbsp;Text.</p></article>', "3"), "Art. 3\n\n1\u00a0Text.");
});
