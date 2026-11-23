import { describe, expect, it } from "vitest";
import { parseGoto } from "./goto";

describe("parseGoto", () => {
  it("reads a bare number as a frame number", () => {
    expect(parseGoto("1234")).toBe(1234);
    expect(parseGoto("0")).toBe(0);
    expect(parseGoto("  77 ")).toBe(77);
  });

  it("reads m:ss as the first frame of that second", () => {
    expect(parseGoto("0:01")).toBe(60);
    expect(parseGoto("2:30")).toBe(150 * 60);
    expect(parseGoto("75:00")).toBe(75 * 60 * 60);
  });

  it("reads h:mm:ss.sss as the frame on screen at that time", () => {
    expect(parseGoto("1:02:03.500")).toBe((3723 + 0.5) * 60);
    expect(parseGoto("0:00:00.016")).toBe(0);
    expect(parseGoto("0:00:00.017")).toBe(1);
    expect(parseGoto("0:00:01")).toBe(60);
    expect(parseGoto("0:00:01.5")).toBe(90);
  });

  it("accepts a fraction on m:ss", () => {
    expect(parseGoto("0:01.25")).toBe(75);
  });

  it.each(["", "abc", "1:2", "1:60", "1:60:00", "1:5:00", "-3", "1.5", "1:00:00.1234", "1:2:3:4"])(
    "rejects %j",
    (input) => {
      expect(parseGoto(input)).toBeNull();
    },
  );
});
