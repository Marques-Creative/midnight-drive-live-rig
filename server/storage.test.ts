import { describe, expect, it } from "vitest";
import path from "path";
import { storageKeyToPath } from "./storage";

/**
 * SECURITY regression tests — storage keys arrive from HTTP requests
 * (GET /local-storage/<key>), so they must never resolve outside the data dir.
 * These lock down the fix for the path-traversal hole found in the audit.
 */
describe("storageKeyToPath traversal protection", () => {
  it("resolves a normal key inside the files dir", () => {
    const p = storageKeyToPath("stems/song1/vocals.wav");
    expect(p.includes("..")).toBe(false);
    expect(p.endsWith(path.join("stems", "song1", "vocals.wav"))).toBe(true);
  });

  it("strips leading slashes rather than treating the key as absolute", () => {
    const p = storageKeyToPath("///stems/a.wav");
    expect(p.endsWith(path.join("stems", "a.wav"))).toBe(true);
  });

  it("rejects the classic ../ escape", () => {
    expect(() => storageKeyToPath("../../../../etc/passwd")).toThrow();
  });

  it("rejects escapes hidden mid-path", () => {
    expect(() => storageKeyToPath("stems/../../../../etc/passwd")).toThrow();
  });

  it("rejects escapes that begin with a valid-looking prefix", () => {
    expect(() => storageKeyToPath("stems/../..")).toThrow();
  });

  it("allows dotdot that stays inside the files dir", () => {
    const p = storageKeyToPath("stems/sub/../a.wav");
    expect(p.endsWith(path.join("stems", "a.wav"))).toBe(true);
  });
});
