import { describe, expect, it } from "vitest";
import {
  parseLyricCues,
  serialiseLyricCues,
  getActiveCueIndex,
  getKaraokeFill,
} from "../shared/lyricParser";

// ── parseLyricCues ────────────────────────────────────────────────────────────

describe("parseLyricCues", () => {
  it("returns empty array for empty input", () => {
    expect(parseLyricCues("")).toEqual([]);
    expect(parseLyricCues("   ")).toEqual([]);
  });

  it("parses a basic timed cue line", () => {
    const cues = parseLyricCues("[00:18.0] Driving through the midnight rain");
    expect(cues).toHaveLength(1);
    expect(cues[0].startTime).toBeCloseTo(18.0);
    expect(cues[0].text).toBe("Driving through the midnight rain");
    expect(cues[0].chord).toBeUndefined();
    expect(cues[0].endTime).toBeUndefined();
  });

  it("parses a cue with a chord", () => {
    const cues = parseLyricCues("[00:18.0] [Dm] Driving through the midnight rain");
    expect(cues).toHaveLength(1);
    expect(cues[0].chord).toBe("Dm");
    expect(cues[0].text).toBe("Driving through the midnight rain");
  });

  it("parses a cue with start and end time (karaoke fill format)", () => {
    const cues = parseLyricCues("[00:18.0 - 00:22.5] [Dm] Driving through the midnight rain");
    expect(cues).toHaveLength(1);
    expect(cues[0].startTime).toBeCloseTo(18.0);
    expect(cues[0].endTime).toBeCloseTo(22.5);
    expect(cues[0].chord).toBe("Dm");
    expect(cues[0].text).toBe("Driving through the midnight rain");
  });

  it("parses minutes correctly", () => {
    const cues = parseLyricCues("[01:05.0] Long song line");
    expect(cues[0].startTime).toBeCloseTo(65.0);
  });

  it("parses a section marker as an isSection entry", () => {
    const cues = parseLyricCues("[Verse 1]");
    expect(cues).toHaveLength(1);
    expect(cues[0].isSection).toBe(true);
    expect(cues[0].sectionLabel).toBe("Verse 1");
    expect(cues[0].text).toBe("");
  });

  it("attaches section label to the first lyric line after a section marker", () => {
    const raw = `[Verse 1]\n[00:18.0] [Dm] First line\n[00:22.5] [Bb] Second line`;
    const cues = parseLyricCues(raw);
    // section marker + 2 lyric lines
    expect(cues).toHaveLength(3);
    expect(cues[0].isSection).toBe(true);
    expect(cues[1].sectionLabel).toBe("Verse 1");
    expect(cues[2].sectionLabel).toBeUndefined(); // only first line gets it
  });

  it("handles multiple sections", () => {
    const raw = [
      "[Verse 1]",
      "[00:18.0] [Dm] Driving through the midnight rain",
      "[00:22.5] [Bb] City lights are calling again",
      "[Chorus]",
      "[00:52.0] [F] We come alive after dark",
    ].join("\n");
    const cues = parseLyricCues(raw);
    const sections = cues.filter((c) => c.isSection);
    expect(sections).toHaveLength(2);
    expect(sections[0].sectionLabel).toBe("Verse 1");
    expect(sections[1].sectionLabel).toBe("Chorus");
    // Chorus label attached to first lyric line after [Chorus]
    const chorusCue = cues.find((c) => c.text === "We come alive after dark");
    expect(chorusCue?.sectionLabel).toBe("Chorus");
  });

  it("skips lines without timestamps", () => {
    const raw = `[00:18.0] Line one\nThis line has no timestamp\n[00:22.5] Line two`;
    const cues = parseLyricCues(raw);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe("Line one");
    expect(cues[1].text).toBe("Line two");
  });

  it("handles complex chord symbols", () => {
    const cues = parseLyricCues("[00:10.0] [Bb/F] Bass note chord");
    expect(cues[0].chord).toBe("Bb/F");
  });

  it("handles empty lines gracefully", () => {
    const raw = "\n\n[00:18.0] Line one\n\n[00:22.5] Line two\n\n";
    const cues = parseLyricCues(raw);
    expect(cues).toHaveLength(2);
  });
});

// ── serialiseLyricCues ────────────────────────────────────────────────────────

describe("serialiseLyricCues", () => {
  it("round-trips a simple cue", () => {
    const raw = "[00:18.0] [Dm] Driving through the midnight rain";
    const cues = parseLyricCues(raw);
    const out = serialiseLyricCues(cues);
    expect(out).toBe(raw);
  });

  it("round-trips a cue with end time", () => {
    const raw = "[00:18.0 - 00:22.5] [Dm] Driving through the midnight rain";
    const cues = parseLyricCues(raw);
    const out = serialiseLyricCues(cues);
    expect(out).toBe(raw);
  });

  it("serialises a section marker as a bare bracket line", () => {
    const raw = "[Verse 1]\n[00:18.0] [Dm] Line one";
    const cues = parseLyricCues(raw);
    const out = serialiseLyricCues(cues);
    expect(out).toContain("[Verse 1]");
  });
});

// ── getActiveCueIndex ─────────────────────────────────────────────────────────

describe("getActiveCueIndex", () => {
  const cues = parseLyricCues(
    "[00:18.0] [Dm] Line one\n[00:22.5] [Bb] Line two\n[00:27.0] [F] Line three"
  );

  it("returns -1 before the first cue", () => {
    expect(getActiveCueIndex(cues, 0)).toBe(-1);
    expect(getActiveCueIndex(cues, 17.9)).toBe(-1);
  });

  it("returns the first cue index at its exact start time", () => {
    expect(getActiveCueIndex(cues, 18.0)).toBe(0);
  });

  it("returns the second cue index between first and third", () => {
    expect(getActiveCueIndex(cues, 23.0)).toBe(1);
  });

  it("returns the last cue index after the last timestamp", () => {
    expect(getActiveCueIndex(cues, 60.0)).toBe(2);
  });

  it("skips section-only entries", () => {
    const withSection = parseLyricCues(
      "[Verse 1]\n[00:18.0] [Dm] Line one\n[00:22.5] [Bb] Line two"
    );
    // index 0 = section marker, index 1 = Line one, index 2 = Line two
    expect(getActiveCueIndex(withSection, 19.0)).toBe(1);
  });

  it("returns -1 for empty cue array", () => {
    expect(getActiveCueIndex([], 10)).toBe(-1);
  });
});

// ── getKaraokeFill ────────────────────────────────────────────────────────────

describe("getKaraokeFill", () => {
  const cue = { startTime: 18.0, endTime: 22.5, text: "Line", chord: "Dm" };

  it("returns 0 before the cue starts", () => {
    expect(getKaraokeFill(cue, 17.0)).toBe(0);
  });

  it("returns 0 at the exact start time", () => {
    expect(getKaraokeFill(cue, 18.0)).toBe(0);
  });

  it("returns ~0.5 at the midpoint", () => {
    expect(getKaraokeFill(cue, 20.25)).toBeCloseTo(0.5);
  });

  it("returns 1 at the end time", () => {
    expect(getKaraokeFill(cue, 22.5)).toBe(1);
  });

  it("clamps to 1 after end time", () => {
    expect(getKaraokeFill(cue, 30.0)).toBe(1);
  });

  it("returns 0 when no endTime is set", () => {
    const noEnd = { startTime: 18.0, text: "Line" };
    expect(getKaraokeFill(noEnd, 20.0)).toBe(0);
  });

  it("returns 0 when endTime equals startTime", () => {
    const zeroLen = { startTime: 18.0, endTime: 18.0, text: "Line" };
    expect(getKaraokeFill(zeroLen, 18.0)).toBe(0);
  });
});
