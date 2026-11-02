import { describe, expect, it } from "vitest";
import { checkPart, MAX_PART_BYTES, pieces } from "../lib/quotes/upload-limits";

const id = "3f2b8c1e-9a4d-4b7e-8c2a-1d5e6f7a8b9c";

describe("uploads in pieces", () => {
  it("cuts a file into pieces under the request cap", () => {
    expect(pieces(0)).toEqual([]);
    expect(pieces(10, 4)).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
    const big = pieces(7 * 1024 * 1024);
    expect(big).toHaveLength(3);
    expect(big.every(([s, e]) => e - s <= MAX_PART_BYTES)).toBe(true);
  });

  it("accepts a normal piece", () => {
    expect(
      checkPart({ uploadId: id, fileIndex: 0, partIndex: 0, name: "a.pdf" }, 10)
    ).toBeNull();
  });

  it("refuses bad ids, indexes, names and sizes", () => {
    const ok = { uploadId: id, fileIndex: 0, partIndex: 0, name: "a.pdf" };
    expect(checkPart({ ...ok, uploadId: "../x" }, 10)).not.toBeNull();
    expect(checkPart({ ...ok, fileIndex: -1 }, 10)).not.toBeNull();
    expect(checkPart({ ...ok, partIndex: 1.5 }, 10)).not.toBeNull();
    expect(checkPart({ ...ok, fileIndex: 60 }, 10)).not.toBeNull();
    expect(checkPart({ ...ok, partIndex: 7 }, 10)).not.toBeNull();
    expect(checkPart({ ...ok, name: " " }, 10)).not.toBeNull();
    expect(checkPart(ok, 0)).not.toBeNull();
    expect(checkPart(ok, MAX_PART_BYTES + 1)).not.toBeNull();
  });
});
