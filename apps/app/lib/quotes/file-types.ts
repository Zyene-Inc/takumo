// File types an RFQ package can hold. Constants only, so the browser can use
// them too (the upload input's accept list).

export const MODEL_TYPES = [
  ".step",
  ".stp",
  ".iges",
  ".igs",
  ".x_t",
  ".x_b",
  ".sldprt",
  ".sldasm",
  ".stl",
  ".sat",
  ".3mf",
  ".jt",
] as const;
export const IMAGE_TYPES = [
  ".png",
  ".jpg",
  ".jpeg",
  ".tif",
  ".tiff",
  ".webp",
  ".gif",
  ".bmp",
] as const;
export const DOCUMENT_TYPES = [
  ".docx",
  ".doc",
  ".txt",
  ".md",
  ".rtf",
  ".xlsx",
  ".xls",
  ".csv",
] as const;
/** Everything an RFQ package can hold (the upload input's accept list). */
export const PACKAGE_TYPES = [
  ".pdf",
  ".eml",
  ".zip",
  ...DOCUMENT_TYPES,
  ...IMAGE_TYPES,
  ...MODEL_TYPES,
  ".dxf",
  ".dwg",
] as const;
