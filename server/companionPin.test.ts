import { describe, expect, it } from "vitest";
import { COMPANION_PIN, isSocketAuthorized } from "./socket";

describe("companion PIN gate", () => {
  it("lets the host UI in without a PIN", () => {
    expect(isSocketAuthorized({})).toBe(true);
    expect(isSocketAuthorized({ role: "host" })).toBe(true);
  });

  it("rejects a companion with no PIN", () => {
    expect(isSocketAuthorized({ role: "companion" })).toBe(false);
  });

  it("rejects a companion with the wrong PIN", () => {
    expect(isSocketAuthorized({ role: "companion", pin: "0000" === COMPANION_PIN ? "9999" : "0000" })).toBe(false);
  });

  it("accepts a companion with the right PIN", () => {
    expect(isSocketAuthorized({ role: "companion", pin: COMPANION_PIN })).toBe(true);
  });

  it("rejects non-string PIN shapes (arrays from repeated query params)", () => {
    expect(isSocketAuthorized({ role: "companion", pin: [COMPANION_PIN] })).toBe(false);
  });

  it("generates a 4-digit PIN by default", () => {
    expect(COMPANION_PIN).toMatch(/^\d{4,8}$/);
  });
});
