import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fileExtension, referenceMime } from "./public/attachment-types.js";

const MAX_TEXT = 1_000_000;
const fail = message => Object.assign(new Error(message), { status: 415 });

function decodeText(bytes) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw fail("Text references must use UTF-8 or BOM-marked UTF-16 encoding."); }
  if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw fail("The reference contains binary data, not readable text.");
  return checkedText(text);
}
function checkedText(text) {
  if (!text?.trim()) throw fail("No readable text found. For scanned PDFs or image-only documents, attach screenshots instead.");
  if (text.length > MAX_TEXT) throw fail("Reference exceeds 1,000,000 extracted characters. Split it into smaller files.");
  return text;
}

async function checkOfficeArchive(bytes, extension) {
  const { default: yauzl } = await import("yauzl");
  const expected = { ".docx": "word/document.xml", ".xlsx": "xl/workbook.xml", ".pptx": "ppt/presentation.xml" }[extension];
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(fail("Invalid Office file. Use a valid DOCX, XLSX or PPTX document."));
      let count = 0, total = 0;
      const names = new Set();
      const stop = message => { zip.close(); reject(fail(message)); };
      zip.on("error", reject);
      zip.on("entry", entry => {
        total += entry.uncompressedSize;
        if (++count > 2000 || total > 40 * 1024 * 1024 || entry.uncompressedSize > 16 * 1024 * 1024)
          return stop("Office document is too large when expanded. Split it into smaller files.");
        if (entry.generalPurposeBitFlag & 1) return stop("Password-protected documents are not supported.");
        if (/vbaProject\.bin$/i.test(entry.fileName)) return stop("Macro-enabled documents are not supported.");
        if (names.has(entry.fileName)) return stop("Office archive contains duplicate entries.");
        names.add(entry.fileName);
        zip.readEntry();
      });
      zip.on("end", () => names.has(expected) && names.has("[Content_Types].xml")
        ? resolve() : reject(fail("Office file contents do not match its filename extension.")));
      zip.readEntry();
    });
  });
}

export async function extractReference(bytes, name) {
  const mimeType = referenceMime(name);
  if (!mimeType) throw fail("Unsupported reference file. Use PDF, DOCX, XLSX, PPTX, text, CSV or source-code files.");
  if (mimeType === "text/plain") return { mimeType, text: decodeText(bytes) };
  const extension = fileExtension(name);
  if (extension === ".pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
    throw fail("File contents do not match a PDF document.");
  // Parsing untrusted documents is isolated from the HTTP server and bounded in time and heap.
  return new Promise((resolve, reject) => {
    const worker = fork(fileURLToPath(import.meta.url), ["--reference-parser-child"], {
      execArgv: ["--max-old-space-size=128"], serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let settled = false;
    const finish = (err, text) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      worker.kill();
      if (err) reject(fail(err.message || String(err)));
      else resolve({ mimeType, text });
    };
    const timer = setTimeout(() => finish(new Error("Document parsing timed out. Try a smaller or text-only file.")), 20_000);
    worker.once("message", result => finish(result.error ? new Error(result.error) : null, result.text));
    worker.once("error", err => finish(err));
    worker.once("exit", code => { if (!settled) finish(new Error(`Document parser stopped before returning text (exit ${code}).`)); });
    worker.send({ bytes, extension }, error => { if (error) finish(error); });
  });
}

if (process.argv[2] === "--reference-parser-child") {
  process.once("message", async ({ bytes, extension }) => {
    try {
      if (extension !== ".pdf") await checkOfficeArchive(bytes, extension);
      const { parseOffice } = await import("officeparser");
      const ast = await parseOffice(bytes, {
        fileType: extension.slice(1), ocr: false, extractAttachments: false, includeRawContent: false,
        ignoreNotes: false,
        decompressionLimits: {
          maxUncompressedBytes: 40 * 1024 * 1024, maxZipEntries: 2000,
          maxTableCells: 100_000, maxXmlElements: 200_000, maxRepeatedContent: MAX_TEXT,
        },
      });
      const hasText = nodes => nodes.some(node =>
        (node.type !== "image" && typeof node.text === "string" && node.text.trim()) || hasText(node.children || []));
      if (!hasText(ast.content)) checkedText("");
      const result = await ast.to("text", { includeImages: "none" });
      const warnings = [...(ast.warnings || []), ...(result.warnings || [])];
      if (warnings.some(w => w.type === "error" || String(w.code).includes("LIMIT_EXCEEDED")))
        throw fail("Document extraction is incomplete or exceeded parser limits. Split the file or export it as text.");
      const warningText = warnings.length ? `Parser warnings: ${warnings.slice(0, 10).map(w => w.message).join("; ")}\n\n` : "";
      const text = checkedText(warningText + result.value);
      process.send({ text });
    } catch (error) {
      process.send({ error: `Cannot read reference: ${error.message || error}` });
    }
  });
}
