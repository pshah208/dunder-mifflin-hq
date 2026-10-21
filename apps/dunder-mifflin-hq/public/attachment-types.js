export const IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
export const DOCUMENT_TYPES = Object.freeze({
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
});
export const TEXT_EXTENSIONS = Object.freeze(
  ".txt .md .markdown .csv .tsv .json .jsonl .xml .yaml .yml .log .js .jsx .ts .tsx .py .sql .cs .java .go .rs .css .html .htm .sh .ps1 .rb .c .h .cpp .hpp .ini .toml .cfg .ipynb .r .vue .svelte".split(" "),
);
export const FILE_ACCEPT = [...IMAGE_TYPES, ...Object.keys(DOCUMENT_TYPES), ...TEXT_EXTENSIONS].join(",");
export const fileExtension = name => /\.[a-z0-9]+$/i.exec(String(name || ""))?.[0].toLowerCase() || "";
export function referenceMime(name) {
  const ext = fileExtension(name);
  return DOCUMENT_TYPES[ext] || (TEXT_EXTENSIONS.includes(ext) ? "text/plain" : null);
}
export function isImageAttachment(file) {
  return IMAGE_TYPES.includes(file.mimeType || file.type);
}
export const supportsAttachment = file => isImageAttachment(file) || !!referenceMime(file.name);
