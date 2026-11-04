import { describe, expect, test } from "vitest";
import {
  formatDays,
  formatShift,
  parseClock,
  parseDays,
  readShift,
  shiftHours,
} from "../shifts";

describe("shift times and days from ERP exports", () => {
  test("clock times in every common spelling", () => {
    expect(parseClock("7")).toBe("07:00");
    expect(parseClock("07:00")).toBe("07:00");
    expect(parseClock("3:30 PM")).toBe("15:30");
    expect(parseClock("12:00 a.m.")).toBe("00:00");
    expect(parseClock("12 pm")).toBe("12:00");
    expect(parseClock("1530")).toBe("15:30");
    expect(parseClock("24:00")).toBe("24:00");
    expect(parseClock("25:00")).toBeNull();
    expect(parseClock("13 PM")).toBeNull();
    expect(parseClock("noonish")).toBeNull();
  });

  test("days as ranges, lists and words, ISO numbered", () => {
    expect(parseDays("Mon-Fri")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays("M-F")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays("Mon, Wed, Fri")).toEqual([1, 3, 5]);
    expect(parseDays("Tue thru Sat")).toEqual([2, 3, 4, 5, 6]);
    expect(parseDays("Fri-Mon")).toEqual([1, 5, 6, 7]);
    expect(parseDays("weekdays")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays("Sat & Sun")).toEqual([6, 7]);
    // Never a guess.
    expect(parseDays("Mon-Funday")).toBeNull();
    expect(parseDays("")).toBeNull();
  });

  test("hours a shift lasts, overnight included", () => {
    expect(shiftHours({ start: "07:00", end: "15:30" })).toBe(8.5);
    expect(shiftHours({ start: "15:30", end: "24:00" })).toBe(8.5);
    expect(shiftHours({ start: "22:00", end: "06:30" })).toBe(8.5);
  });

  test("a stored shift is read back, Mon-Fri by default", () => {
    expect(readShift({ start: "7:00", end: "15:30" })).toEqual({
      start: "07:00",
      end: "15:30",
      days: [1, 2, 3, 4, 5],
    });
    expect(readShift({ start: "x", end: "15:30" })).toBeNull();
    expect(readShift(null)).toBeNull();
  });

  test("days and shifts back to words, round-tripping", () => {
    expect(formatDays([1, 2, 3, 4, 5])).toBe("Mon-Fri");
    expect(formatDays([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(formatDays([6, 7])).toBe("Sat, Sun");
    expect(parseDays(formatDays([2, 3, 4, 5, 6]))).toEqual([2, 3, 4, 5, 6]);
    expect(formatShift({ start: "15:30", end: "24:00", days: [1, 2, 3, 4, 5] })).toBe(
      "Mon-Fri 15:30–24:00"
    );
  });
});
