/**
 * Midnight Drive — Lyric Cue Parser
 *
 * Supported formats:
 *   [MM:SS.s] [Chord] Line text
 *   [MM:SS.s - MM:SS.s] [Chord] Line text   (with optional end time for karaoke fill)
 *   [Section Label]                          (section markers, no timestamp)
 *
 * Examples:
 *   [00:18.0] [Dm] Driving through the midnight rain
 *   [00:18.0 - 00:22.5] [Dm] Driving through the midnight rain
 *   [Verse 1]
 *   [Chorus]
 */

export interface LyricCue {
  /** Start time in seconds */
  startTime: number;
  /** Optional end time in seconds (enables karaoke fill progress) */
  endTime?: number;
  /** Chord symbol, e.g. "Dm", "Bb/F" */
  chord?: string;
  /** The lyric line text */
  text: string;
  /** Section label that precedes this line, e.g. "Verse 1", "Chorus" */
  sectionLabel?: string;
  /** True if this entry is purely a section marker (no lyric text) */
  isSection?: boolean;
}

// Matches: [MM:SS.s] or [MM:SS.s - MM:SS.s]
const TIME_RE = /^\[(\d{1,2}):(\d{2}(?:\.\d+)?)(?:\s*-\s*(\d{1,2}):(\d{2}(?:\.\d+)?))?\]/;
// Matches: [ChordSymbol] — chord is letters/numbers/# /b / (no colon, no space-dash-space)
const CHORD_RE = /^\[([A-G][^\]]*)\]/;
// Matches a pure section marker line: [Verse 1], [Chorus], [Bridge], etc. (no timestamp)
const SECTION_RE = /^\[([^\]]+)\]\s*$/;

function toSeconds(min: string, sec: string): number {
  return parseInt(min, 10) * 60 + parseFloat(sec);
}

export function parseLyricCues(raw: string): LyricCue[] {
  if (!raw || !raw.trim()) return [];

  const lines = raw.split("\n");
  const cues: LyricCue[] = [];
  let currentSection: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // ── Section marker (no timestamp) ──────────────────────────────────────
    if (SECTION_RE.test(line) && !TIME_RE.test(line)) {
      const match = line.match(SECTION_RE)!;
      currentSection = match[1].trim();
      cues.push({
        startTime: cues.length > 0 ? cues[cues.length - 1].startTime : 0,
        text: "",
        sectionLabel: currentSection,
        isSection: true,
      });
      continue;
    }

    // ── Timed cue line ─────────────────────────────────────────────────────
    const timeMatch = line.match(TIME_RE);
    if (!timeMatch) continue; // skip lines without timestamps

    const startTime = toSeconds(timeMatch[1], timeMatch[2]);
    const endTime =
      timeMatch[3] !== undefined && timeMatch[4] !== undefined
        ? toSeconds(timeMatch[3], timeMatch[4])
        : undefined;

    let rest = line.slice(timeMatch[0].length).trim();

    // Optional chord
    let chord: string | undefined;
    const chordMatch = rest.match(CHORD_RE);
    if (chordMatch) {
      chord = chordMatch[1].trim();
      rest = rest.slice(chordMatch[0].length).trim();
    }

    const cue: LyricCue = {
      startTime,
      ...(endTime !== undefined ? { endTime } : {}),
      ...(chord ? { chord } : {}),
      text: rest,
    };

    // Attach section label to the first cue after a section marker
    if (currentSection) {
      cue.sectionLabel = currentSection;
      currentSection = undefined; // only attach to the first line of the section
    }

    cues.push(cue);
  }

  return cues;
}

/**
 * Serialise an array of LyricCue objects back to the raw text format.
 * Section-only entries are emitted as bare [Section] lines.
 */
export function serialiseLyricCues(cues: LyricCue[]): string {
  return cues
    .map((cue) => {
      if (cue.isSection) return `[${cue.sectionLabel}]`;
      const mm = String(Math.floor(cue.startTime / 60)).padStart(2, "0");
      const ss = (cue.startTime % 60).toFixed(1).padStart(4, "0");
      let ts = `[${mm}:${ss}`;
      if (cue.endTime !== undefined) {
        const emm = String(Math.floor(cue.endTime / 60)).padStart(2, "0");
        const ess = (cue.endTime % 60).toFixed(1).padStart(4, "0");
        ts += ` - ${emm}:${ess}`;
      }
      ts += "]";
      const chord = cue.chord ? ` [${cue.chord}]` : "";
      return `${ts}${chord} ${cue.text}`.trimEnd();
    })
    .join("\n");
}

/**
 * Given a playback position (seconds) and a sorted cue array,
 * returns the index of the currently active cue (-1 if before first cue).
 */
export function getActiveCueIndex(cues: LyricCue[], currentTime: number): number {
  let active = -1;
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].isSection) continue;
    if (cues[i].startTime <= currentTime) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}

/**
 * Returns the karaoke fill progress (0–1) for the current cue.
 * If the cue has no endTime, returns 0 (no fill animation).
 */
export function getKaraokeFill(cue: LyricCue, currentTime: number): number {
  if (cue.endTime === undefined || cue.endTime <= cue.startTime) return 0;
  const elapsed = currentTime - cue.startTime;
  const duration = cue.endTime - cue.startTime;
  return Math.min(1, Math.max(0, elapsed / duration));
}
