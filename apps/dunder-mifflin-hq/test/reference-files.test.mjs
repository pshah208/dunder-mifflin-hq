import test from "node:test";
import assert from "node:assert/strict";
import { extractReference } from "../reference-files.mjs";
import { validateAttachments } from "../public/ui-logic.js";
import { officeFixtures, pdfFixture, zipFixture } from "./reference-fixtures.mjs";

test("reference picker accepts documents and source files, including empty or inconsistent browser MIME", () => {
  const files = ["brief.PDF", "doc.docx", "table.xlsx", "deck.pptx"].map(name => ({ name, size: 100, type: "" }));
  assert.equal(validateAttachments([], files).accepted.length, 4);
  assert.equal(validateAttachments([], [{ name: "code.ts", size: 100, type: "video/mp2t" }]).accepted.length, 1);
  for (const name of ["run.exe", "archive.zip", "macro.xlsm", "old.doc"]) {
    assert.equal(validateAttachments([], [{ name, size: 100, type: "text/plain" }]).accepted.length, 0);
  }
});

test("text extraction preserves UTF-8 and UTF-16 and rejects empty/binary or oversized text", async () => {
  assert.equal((await extractReference(Buffer.from("Customer,Amount\nSynthetic,42\n"), "budget.csv")).text, "Customer,Amount\nSynthetic,42\n");
  assert.equal((await extractReference(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("reference", "utf16le")]), "notes.txt")).text, "reference");
  await assert.rejects(extractReference(Buffer.from([0, 1, 2]), "fake.txt"), /binary/);
  await assert.rejects(extractReference(Buffer.from("   "), "empty.md"), /No readable text/);
  await assert.rejects(extractReference(Buffer.alloc(1_000_001, 65), "large.txt"), /1,000,000/);
});

test("Office and PDF references yield actual text, not just an attachment filename", async () => {
  for (const [name, data] of Object.entries(officeFixtures)) {
    const result = await extractReference(data, name);
    assert.match(result.text, /reference/i, name);
    if (name.endsWith(".xlsx")) assert.match(result.text, /42/);
  }
  assert.match((await extractReference(pdfFixture(), "brief.pdf")).text, /Reference PDF text/);
});

test("invalid, renamed, macro-bearing and oversized Office archives fail explicitly", async () => {
  await assert.rejects(extractReference(Buffer.from("not a PDF"), "fake.pdf"), /match a PDF/);
  await assert.rejects(extractReference(officeFixtures["brief.docx"], "wrong.xlsx"), /do not match/);
  await assert.rejects(extractReference(Buffer.from("not a ZIP"), "fake.docx"), /Invalid Office/);
  await assert.rejects(extractReference(zipFixture({
    "[Content_Types].xml": "<Types/>", "word/document.xml": "<doc/>", "word/vbaProject.bin": "macro",
  }), "macro.docx"), /Macro/);
  await assert.rejects(extractReference(zipFixture({
    "[Content_Types].xml": "<Types/>", "word/document.xml": "a".repeat(16 * 1024 * 1024 + 1),
  }), "big.docx"), /too large when expanded/);
});
