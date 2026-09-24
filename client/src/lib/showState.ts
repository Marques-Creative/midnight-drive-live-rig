import { useSyncExternalStore } from "react";

/**
 * showState — the live show's selection (which set list, which song), held
 * OUTSIDE any page component so it survives navigating between Live Screen,
 * DJ Decks, and everywhere else. Also persisted to localStorage so the show
 * state survives an app restart mid-rehearsal.
 */

export interface ShowState {
  setListId: number | null;
  songIndex: number;
  /** "setlist" = follow the chosen set list. "dj" = mirror whatever the DJ has
      on the master deck (track, lyrics, chords, stem mixer). */
  mode: "setlist" | "dj";
}

const STORAGE_KEY = "rockdj.showState.v1";

function load(): ShowState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        setListId: typeof parsed.setListId === "number" ? parsed.setListId : null,
        songIndex: typeof parsed.songIndex === "number" ? parsed.songIndex : 0,
        mode: parsed.mode === "dj" ? "dj" : "setlist",
      };
    }
  } catch {
    /* corrupted storage — fall through to defaults */
  }
  return { setListId: null, songIndex: 0, mode: "setlist" };
}

let state: ShowState = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — state still lives in memory */
  }
}

export function setShowState(patch: Partial<ShowState>) {
  state = { ...state, ...patch };
  persist();
  listeners.forEach((l) => l());
}

export function updateSongIndex(updater: (prev: number) => number) {
  setShowState({ songIndex: Math.max(0, updater(state.songIndex)) });
}

export function useShowState(): ShowState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}
