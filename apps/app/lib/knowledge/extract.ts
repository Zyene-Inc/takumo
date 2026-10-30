// Text from uploaded documents, page by page. No database: tested on fixtures.

import type { PageText } from "./chunk";
import { DOCUMENT_TYPES } from "./types";

const extension = (name: string) =>
  name.slice(name.lastIndexOf(".")).toLowerCase();

export const extractPages = async (
  name: string,
  bytes: Uint8Array
): Promise<PageText[]> => {
  const ext = extension(name);
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((t, i) => ({ page: i + 1, text: t }));
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({
      buffer: Buffer.from(bytes),
    });
    return [{ page: null, text: value }];
  }
  if ((DOCUMENT_TYPES as readonly string[]).includes(ext)) {
    return [{ page: null, text: new TextDecoder().decode(bytes) }];
  }
  throw new Error(`Takumo reads ${DOCUMENT_TYPES.join(", ")} files.`);
};
