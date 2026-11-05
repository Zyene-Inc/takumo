// Limits for uploads sent in pieces. Pure, shared by the browser (which cuts
// files into pieces) and the server (which checks them).

/** Under the host's 4.5 MB request cap, with room for the form around it. */
export const MAX_PART_BYTES = 3 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_FILES = 60;
export const UPLOAD_PART_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const UPLOAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PartInput {
  fileIndex: number;
  name: string;
  partIndex: number;
  uploadId: string;
}

export const isUploadId = (value: string) => UPLOAD_ID.test(value);

/** Why a piece can't be kept, or null. */
export const checkPart = (input: PartInput, size: number) => {
  if (!isUploadId(input.uploadId)) {
    return "That upload isn't valid. Try again.";
  }
  const indexes = [input.fileIndex, input.partIndex];
  if (indexes.some((i) => !Number.isInteger(i) || i < 0)) {
    return "That upload isn't valid. Try again.";
  }
  if (input.fileIndex >= MAX_UPLOAD_FILES) {
    return `Upload up to ${MAX_UPLOAD_FILES} files at once, or zip them.`;
  }
  if (input.partIndex * MAX_PART_BYTES >= MAX_UPLOAD_BYTES) {
    return "Upload up to 20 MB at once. Zip the drawings, or email the package to your RFQ address.";
  }
  if (!input.name.trim() || input.name.length > 255) {
    return "That file needs a name.";
  }
  if (size === 0 || size > MAX_PART_BYTES) {
    return "That upload isn't valid. Try again.";
  }
  return null;
};

/** How a file is cut: [start, end) byte ranges of at most MAX_PART_BYTES. */
export const pieces = (size: number, max = MAX_PART_BYTES) => {
  const out: [number, number][] = [];
  for (let start = 0; start < size; start += max) {
    out.push([start, Math.min(size, start + max)]);
  }
  return out;
};
