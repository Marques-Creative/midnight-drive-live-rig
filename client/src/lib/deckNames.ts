import { useSyncExternalStore } from "react";

/**
 * deckNames — the track title showing on each deck. Loading from the library
 * sets it; the deck header reads it. Kept outside the components so the browser
 * and the decks stay in step.
 */
let names: [string, string] = ["", ""];
const listeners = new Set<() => void>();

export function setDeckTrackName(deck: number, title: string) {
  const next: [string, string] = [names[0], names[1]];
  next[deck === 1 ? 1 : 0] = title;
  names = next;
  listeners.forEach((l) => l());
}

export function useDeckNames(): [string, string] {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => names,
  );
}
