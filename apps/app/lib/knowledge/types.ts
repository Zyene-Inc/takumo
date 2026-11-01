// Shared with the browser (the upload input's accept list).
export const IMAGE_TYPES = [".jpg", ".jpeg", ".png", ".webp"] as const;
export const DOCUMENT_TYPES = [
  ".pdf",
  ".docx",
  ".txt",
  ".md",
  ".csv",
  ...IMAGE_TYPES,
] as const;
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
