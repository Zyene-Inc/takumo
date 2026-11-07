// biome-ignore-all lint/suspicious/noBitwiseOperators: capabilities are bit sets, matching AccessGrant.capabilities and the library.* SQL functions; all bit arithmetic lives in this file.

// What someone may do with a folder or document in the Company Knowledge Hub.
// The same bits are stored in AccessGrant.capabilities and returned by the
// library.* SQL functions. Each one is checked on its own; none implies another.

export const CAPABILITY = {
  view: 1,
  download: 2,
  upload: 4,
  edit: 8,
  delete: 16,
  manage: 32,
} as const;

export type Capability = keyof typeof CAPABILITY;

export const ALL_CAPABILITIES = 63;

/** The combinations people choose from, rather than single bits. */
export const PRESETS = {
  viewer: CAPABILITY.view | CAPABILITY.download,
  contributor: CAPABILITY.view | CAPABILITY.download | CAPABILITY.upload,
  editor:
    CAPABILITY.view |
    CAPABILITY.download |
    CAPABILITY.upload |
    CAPABILITY.edit |
    CAPABILITY.delete,
  manager: ALL_CAPABILITIES,
  // Everyone can hand documents in (receipts, forms) without seeing others'.
  dropBox: CAPABILITY.upload,
} as const;

export const has = (capabilities: number, capability: Capability) =>
  (capabilities & CAPABILITY[capability]) === CAPABILITY[capability];

/** Every bit of `wanted` is in `held`. */
export const covers = (held: number, wanted: number) =>
  (held & wanted) === wanted;

/** Everything any of these allows. */
export const combine = (...sets: number[]) =>
  sets.reduce((all, set) => all | set, 0);

/**
 * Why a set of capabilities can't be granted, or null when it can: a whole
 * number of known bits, and anything beyond uploading needs viewing too
 * (you can't download or edit what you can't see).
 */
export const capabilitiesProblem = (capabilities: number): string | null => {
  if (
    !Number.isInteger(capabilities) ||
    capabilities < 1 ||
    capabilities > ALL_CAPABILITIES
  ) {
    return "Choose what they may do.";
  }
  const beyondUpload = capabilities & ~CAPABILITY.upload;
  if (beyondUpload !== 0 && !has(capabilities, "view")) {
    return "Anyone who may download, edit, delete or manage must be able to view too.";
  }
  return null;
};
