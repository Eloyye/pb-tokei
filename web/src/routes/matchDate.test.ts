import { describe, expect, it } from "vitest";
import { isValidMatchDate } from "./matchDate";

describe("isValidMatchDate", () => {
  it.each([
    ["2026-04-12", true],
    ["2024-02-29", true],
    ["1000-01-01", true],
    ["2025-02-29", false],
    ["2026-02-30", false],
    ["2026-13-01", false],
    ["0999-12-31", false],
    ["0002-04-12", false],
    ["2026-4-5", false],
    ["20260412", false],
    ["", false],
    ["not-a-date", false],
  ])("validates %s as %s", (value, expected) => {
    expect(isValidMatchDate(value)).toBe(expected);
  });
});
