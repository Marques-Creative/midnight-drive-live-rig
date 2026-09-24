export type StemState = {
  id: number;
  name: string;
  volume: number;
  muted: boolean;
  outputRoute: string;
};

export type LyricCueSummary = {
  startTime: number;
  endTime?: number;
  chord?: string;
  text: string;
  sectionLabel?: string;
  isSection?: boolean;
};

// ── Transport commands (companion → host) ─────────────────────────────
export type TransportCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "stop" }
  | { type: "next" }
  | { type: "prev" }
  | { type: "seek"; time: number };

export type PlaybackState = {
  songId: number | null;
  songTitle: string;
  artist: string;
  bpm: number | null;
  key: string | null;
  duration: number | null;
  isPlaying: boolean;
  isPaused: boolean;
  currentTime: number;
  setListId: number | null;
  setListName: string;
  currentIndex: number;
  totalSongs: number;
  nextSongTitle: string;
  nextSongArtist: string;
  nextSongBpm: number | null;
  nextSongKey: string | null;
  lyrics: string;
  lyricsScrollPosition: number;
  stems: StemState[];
  connectedCompanions: number;
  // Karaoke lyric cue state
  lyricCues: LyricCueSummary[];
  activeCueIndex: number;
  lyricViewMode: "karaoke" | "chart" | "set";
};
