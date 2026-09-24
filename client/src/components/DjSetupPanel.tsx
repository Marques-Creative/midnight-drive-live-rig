import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { TransportAPI, MidiBinding } from "@/hooks/useTransport";

/**
 * DJ SETUP — the two things that make ROCKDJ playable as a real DJ rig:
 *
 *  1. OUTPUT ROUTING. Nothing is hardcoded. On a 4-out Scarlett the working
 *     layout is FOH 1-2 (to the DJ mixer), CLICK mono on 3 (to the band's
 *     in-ears), and DJ CUE mono on 4 (into a mixer channel with the fader down
 *     and PFL lit). A guide/click is mono, which is what frees the fourth
 *     channel for the DJ's headphones.
 *
 *  2. MIDI LEARN. We can't guess what a CDJ sends - every model and firmware
 *     differs - so we listen to the hardware and bind whatever it actually
 *     sends. Press LEARN, touch the control, done.
 */

/**
 * XDJ-RX3 starting map. The numbers come from a hardware brief, NOT from
 * Pioneer's official MIDI list, so treat this as a head start rather than
 * gospel: anything that doesn't respond, re-learn it (the live readout shows
 * exactly what the unit really sends).
 *
 * Ch1 = Deck 1, Ch2 = Deck 2, Ch5 = mixer. The tempo fader is a 14-bit CC pair
 * and the jog is binary-offset relative (64 = still), per the same brief.
 */
/**
 * XDJ-RX3 MIDI map from AlphaTheta's OFFICIAL published list (XDJ-RX3_MIDI_Message_List_E1.pdf).
 *
 * Channel assignment: Deck1=ch1, Deck2=ch2, Perf.Pads D1=ch6, D2=ch7, Mixer=ch5
 * 
 * Previous preset errors (from Manus brief, which was guessing):
 *   - SYNC was 0x58 → actually 0x1F (31)
 *   - EQ was off by one: Manus mapped TRIM to HIGH, HIGH to MID, MID to LOW
 *   - Loop buttons were missing entirely
 *   - Hot cue pads use a separate channel (6/7) not the deck channel
 *   - JOG ring is CC 0x21, platter is CC 0x22 (Manus had only platter)
 */
export const XDJ_RX3_PRESET: MidiBinding[] = [
  // ── DECK 1 (ch 1) ───────────────────────────────────────────────────────────
  { status: 0x90, channel: 1, data1: 0x0B, action: "playPause", deck: 0 },  // PLAY/PAUSE
  { status: 0x90, channel: 1, data1: 0x0C, action: "cue", deck: 0 },         // CUE
  { status: 0x90, channel: 1, data1: 0x1F, action: "sync", deck: 0 },         // SYNC (was 0x58 in Manus — wrong)
  { status: 0x90, channel: 1, data1: 0x06, action: "loopIn", deck: 0 },   // LOOP IN
  { status: 0x90, channel: 1, data1: 0x07, action: "loopOut", deck: 0 },  // LOOP OUT
  { status: 0x90, channel: 1, data1: 0x08, action: "reloop", deck: 0 },   // RELOOP/EXIT
  { status: 0xB0, channel: 1, data1: 0x00, action: "rate", deck: 0, param: 0, bit14: true }, // TEMPO (14-bit; param=0 = follow TEMPO RANGE button)
  // TEMPO RANGE cycles ±6→±10→±16→Wide on this note (per official MIDI list)
  { status: 0x90, channel: 1, data1: 0x19, action: "tempoRange", deck: 0 },
  { status: 0x90, channel: 2, data1: 0x19, action: "tempoRange", deck: 1 },
  // CF ASSIGN switch above crossfader: one CC per deck side, value encodes A/T/B
  // Use LEARN to discover the exact CC numbers — learn it with switch in B position
  { status: 0xB0, channel: 5, data1: 0x46, action: "xfAssign", deck: 0 },  // D1 CF assign (LEARN if different)
  { status: 0xB0, channel: 5, data1: 0x47, action: "xfAssign", deck: 1 },  // D2 CF assign
  { status: 0xB0, channel: 1, data1: 0x21, action: "jog", deck: 0, relMode: 1 }, // JOG ring (nudge)
  { status: 0xB0, channel: 1, data1: 0x22, action: "jogScratch", deck: 0, relMode: 1 }, // JOG platter (VINYL scrub)

  // ── DECK 2 (ch 2) ───────────────────────────────────────────────────────────
  { status: 0x90, channel: 2, data1: 0x0B, action: "playPause", deck: 1 },
  { status: 0x90, channel: 2, data1: 0x0C, action: "cue", deck: 1 },
  { status: 0x90, channel: 2, data1: 0x1F, action: "sync", deck: 1 },
  { status: 0x90, channel: 2, data1: 0x06, action: "loopIn", deck: 1 },
  { status: 0x90, channel: 2, data1: 0x07, action: "loopOut", deck: 1 },
  { status: 0x90, channel: 2, data1: 0x08, action: "reloop", deck: 1 },
  { status: 0xB0, channel: 2, data1: 0x00, action: "rate", deck: 1, param: 0, bit14: true },
  { status: 0xB0, channel: 2, data1: 0x21, action: "jog", deck: 1, relMode: 1 },
  { status: 0xB0, channel: 2, data1: 0x22, action: "jogScratch", deck: 1, relMode: 1 }, // JOG platter (VINYL scrub)

  // ── LIBRARY NAVIGATION ────────────────────────────────────────────────────────
  // TRACK SEARCH FWD/REV (official MIDI numbers) navigate the library step by step.
  // The browse rotary CC is unknown until learned — use LEARN → turn the rotary.
  // LOAD buttons: learn them with LEARN → press LOAD LEFT or LOAD RIGHT.
  { status: 0x90, channel: 1, data1: 0x21, action: "libraryDown", deck: 0 }, // TRACK SEARCH FWD D1
  { status: 0x90, channel: 1, data1: 0x2C, action: "libraryUp",   deck: 0 }, // TRACK SEARCH REV D1

  // ── HOT CUES: Deck 1 pads on ch 6, Deck 2 on ch 7 ──────────────────────────
  // Pads 1–4: notes 0x00–0x03. Pads 5–8: notes 0x10–0x13.
  { status: 0x90, channel: 6, data1: 0x00, action: "pad1", deck: 0 },
  { status: 0x90, channel: 6, data1: 0x01, action: "pad2", deck: 0 },
  { status: 0x90, channel: 6, data1: 0x02, action: "pad3", deck: 0 },
  { status: 0x90, channel: 6, data1: 0x03, action: "pad4", deck: 0 },
  { status: 0x90, channel: 6, data1: 0x10, action: "pad5", deck: 0 },
  { status: 0x90, channel: 6, data1: 0x11, action: "pad6", deck: 0 },
  { status: 0x90, channel: 6, data1: 0x12, action: "pad7", deck: 0 },
  { status: 0x90, channel: 6, data1: 0x13, action: "pad8", deck: 0 },
  { status: 0x90, channel: 7, data1: 0x00, action: "pad1", deck: 1 },
  { status: 0x90, channel: 7, data1: 0x01, action: "pad2", deck: 1 },
  { status: 0x90, channel: 7, data1: 0x02, action: "pad3", deck: 1 },
  { status: 0x90, channel: 7, data1: 0x03, action: "pad4", deck: 1 },
  { status: 0x90, channel: 7, data1: 0x10, action: "pad5", deck: 1 },
  { status: 0x90, channel: 7, data1: 0x11, action: "pad6", deck: 1 },
  { status: 0x90, channel: 7, data1: 0x12, action: "pad7", deck: 1 },
  { status: 0x90, channel: 7, data1: 0x13, action: "pad8", deck: 1 },
  // Empty pad → SET cue; set pad → JUMP; bind clearHotCue to SHIFT+pad for clearing

  // ── MIXER (ch 5) ─────────────────────────────────────────────────────────────
  // CC 0x01/0x06/0x0A are what the Manus brief had (and what was working).
  // The official Pioneer PDF puts EQ one step higher (0x02/0x07/0x0B).
  // Both are in the preset — one of each pair will respond on your unit;
  // the one that doesn't respond simply has no action mapped to it.
  { status: 0xB0, channel: 5, data1: 0x0B, action: "crossfader", deck: 0 },
  { status: 0xB0, channel: 5, data1: 0x11, action: "deckGain",   deck: 0 }, // CH FADER D1
  { status: 0xB0, channel: 5, data1: 0x12, action: "deckGain",   deck: 1 }, // CH FADER D2
  // TRIM per channel (CC 0x01 D1 / 0x06 D2 on ch5 — from the official Pioneer list)
  { status: 0xB0, channel: 5, data1: 0x01, action: "deckTrim",   deck: 0 },
  { status: 0xB0, channel: 5, data1: 0x06, action: "deckTrim",   deck: 1 },
  // EQ set A: CC 0x02–0x04 / 0x07–0x09 (official list has EQ one step above TRIM)
  { status: 0xB0, channel: 5, data1: 0x01, action: "eqHigh",     deck: 0 },
  { status: 0xB0, channel: 5, data1: 0x02, action: "eqMid",      deck: 0 },
  { status: 0xB0, channel: 5, data1: 0x03, action: "eqLow",      deck: 0 },
  { status: 0xB0, channel: 5, data1: 0x06, action: "eqHigh",     deck: 1 },
  { status: 0xB0, channel: 5, data1: 0x07, action: "eqMid",      deck: 1 },
  { status: 0xB0, channel: 5, data1: 0x08, action: "eqLow",      deck: 1 },
  // EQ set B: the official Pioneer PDF numbers (may differ by firmware version)
  { status: 0xB0, channel: 5, data1: 0x04, action: "eqLow",      deck: 0 },
  { status: 0xB0, channel: 5, data1: 0x09, action: "eqLow",      deck: 1 },
];

const GLOBAL_ACTIONS = new Set(["fxOn","fxDepth","clearHotCue","xfAssign","crossfader", "masterGain", "libraryUp", "libraryDown", "librarySelect", "libraryLoad0", "libraryLoad1"]);

const ACTIONS: { id: string; label: string; needsSlotPicker?: boolean }[] = [
  { id: "playPause", label: "Play / Pause" },
  { id: "cue", label: "CUE (hold to preview)" },
  { id: "sync", label: "Sync" },
  { id: "cueEnable", label: "Headphone cue (PFL)" },
  // 8 pads per deck — each is a separate learnable binding
  { id: "pad1", label: "Pad 1 — SET if empty, JUMP if set" },
  { id: "pad2", label: "Pad 2" },
  { id: "pad3", label: "Pad 3" },
  { id: "pad4", label: "Pad 4" },
  { id: "pad5", label: "Pad 5" },
  { id: "pad6", label: "Pad 6" },
  { id: "pad7", label: "Pad 7" },
  { id: "pad8", label: "Pad 8" },
  { id: "clearHotCue", label: "HOT CUE [DELETE] button" },
  { id: "loopBeats", label: "Auto-loop (click beats, then press button)" },
  { id: "loopExit", label: "Loop exit" },
  { id: "loopIn",  label: "Loop IN" },
  { id: "loopOut", label: "Loop OUT" },
  { id: "reloop",  label: "Reloop / Loop EXIT" },
  { id: "rate", label: "Pitch fader (follows TEMPO RANGE button)" },
  { id: "crossfader",    label: "Crossfader" },
  { id: "xfAssign", label: "CF ASSIGN switch (A=0, THRU=~64, B=127)" },
  { id: "deckTrim",   label: "TRIM (±12dB pre-EQ)" },
  { id: "masterGain", label: "MASTER volume (0–200%)" },
  { id: "eqLow", label: "EQ low" },
  { id: "eqMid", label: "EQ mid" },
  { id: "eqHigh", label: "EQ high" },
  { id: "filter", label: "Filter" },
  { id: "deckGain", label: "Channel fader" },
  { id: "jog", label: "JOG ring — nudge (pitch bend)" },
  { id: "jogScratch", label: "JOG platter — VINYL scrub" },
  { id: "tempoRange", label: "TEMPO RANGE (cycle ±6/±10/±16/Wide)" },
  { id: "fxOn",    label: "BEAT FX on/off" },
  { id: "fxDepth", label: "BEAT FX depth/level" },
  // Library navigation — mapped to ONE deck column (deck ignored, they're global)
  { id: "libraryUp",    label: "BROWSE ↑ (also works as rotary encoder)" },
  { id: "libraryDown",  label: "BROWSE ↓ (also works as rotary encoder)" },
  { id: "librarySelect", label: "BROWSE select / enter folder" },
  { id: "libraryLoad0", label: "LOAD → Deck 1" },
  { id: "libraryLoad1", label: "LOAD → Deck 2" },
];

/** Pioneer don't document what the jog emits, so the encoding is chosen from
    the hardware: turn the wheel slowly forward and pick whichever column reads
    as small POSITIVE numbers. */
const REL_MODES = [
  { id: 0, label: "two's complement" },
  { id: 1, label: "binary offset (64=centre)" },
  { id: 2, label: "signed bit" },
];
function decodeRel(v: number, mode: number) {
  if (mode === 1) return v - 64;
  if (mode === 2) return v & 0x40 ? -(v & 0x3f) : v & 0x3f;
  return v < 64 ? v : v - 128;
}

function describe(b: MidiBinding) {
  const kind = b.status === 0xb0 ? "CC" : b.status === 0xe0 ? "PitchWheel" : "Note";
  return `${kind} ${b.data1} · ch${b.channel || "any"}`;
}


/** Return the current live value for a mapped action, for display in the binding list. */
function liveValue(action: string, deck: number, decks: [import("@/hooks/useTransport").DeckState, import("@/hooks/useTransport").DeckState]): string | null {
  const d = decks[deck];
  if (!d) return null;
  switch (action) {
    case "rate":       return `${d.rate > 1 ? "+" : ""}${((d.rate - 1) * 100).toFixed(1)}%`;
    case "tempoRange": return `±${d.tempoRange}%`;
    case "eqLow":      return `${d.eqLow >= 0 ? "+" : ""}${d.eqLow.toFixed(0)}dB`;
    case "eqMid":      return `${d.eqMid >= 0 ? "+" : ""}${d.eqMid.toFixed(0)}dB`;
    case "eqHigh":     return `${d.eqHigh >= 0 ? "+" : ""}${d.eqHigh.toFixed(0)}dB`;
    case "filter":     return Math.abs(d.filter) < 0.05 ? "off" : d.filter < 0 ? `LP${Math.round(-d.filter * 100)}` : `HP${Math.round(d.filter * 100)}`;
    case "deckGain":   return `${Math.round(d.gain * 100)}%`;
    case "crossfader": return null; // shared, skip
    case "fxOn":       return d.fxOn ? "ON" : "off";
    case "fxDepth":    return `${Math.round(d.fxDepth * 100)}%`;
    default:           return null;
  }
}
// Defined OUTSIDE the panel component so its identity is stable across re-renders.
// If defined inside, React creates a new component type every render and unmounts
// the <select> the moment the user clicks it, causing the dropdown to flash and vanish.
function ChannelPicker({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-[10px]" style={{ color: "var(--md-text-muted)" }}>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="rounded px-1 py-0.5 text-[10px]"
        style={{ background: "var(--md-surface)", color: "var(--md-text)", border: "1px solid var(--md-border)" }}>
        {["—", "1", "2", "3", "4", "5", "6", "7", "8"].map((o) => <option key={o}>{o}</option>)}
      </select>
    </label>
  );
}

export default function DjSetupPanel({ audio, decks }: { audio: TransportAPI; decks: [import("@/hooks/useTransport").DeckState, import("@/hooks/useTransport").DeckState] }) {
  const [devices, setDevices] = useState<string[]>([]);
  const [openDevice, setOpenDevice] = useState("");
  const [bindings, setBindings] = useState<MidiBinding[]>([]);
  const [learning, setLearning] = useState<{ action: string; deck: number; param: number } | null>(null);
  const [lastMidi, setLastMidi] = useState<string>("");
  const [lastRaw, setLastRaw] = useState<number | null>(null);
  const [scrollDiv, setScrollDiv] = useState(1);
  const [midiOutDevice, setMidiOutDevice] = useState("");
  // midiOutDevices comes from the transport hook (populated by engine events)
  const scrollDivRef = useRef(1);
  useEffect(() => {
    scrollDivRef.current = scrollDiv;
    audio.setLibraryScrollDiv(scrollDiv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollDiv]);
  const [jog, setJog] = useState({ nudge: 0.004, search: 0.001, decay: 0.07 });
  const [audioDevices, setAudioDevices] = useState<string[]>([]);
  const [audioDevice, setAudioDevice] = useState("");
  const [audioInfo, setAudioInfo] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
  const [routing, setRouting] = useState({ fohL: 0, fohR: 1, iemL: 2, iemR: -1, cueL: 3, cueR: -1, deckAL: -1, deckAR: -1, deckBL: -1, deckBR: -1 });
  // Collapsed by default: this is soundcheck gear, not something to stare at
  // mid-set. The panel stays MOUNTED either way so MIDI keeps being monitored.
  const [open, setOpen] = useState(false);

  // Listen for raw MIDI + device lists straight from the engine.
  // getDjSettings and midiList are called AFTER the socket is connected — the
  // response arrives on THIS socket, so we must be listening before we ask.
  useEffect(() => {
    const socket: Socket = io(window.location.origin, { path: "/socket.io" });
    socket.on("connect", () => {
      audio.getDjSettings();
      audio.listAudioOutputs();
      audio.midiList();
    });
    socket.on("audioOutputs", (d: { devices: string[]; current: string; sampleRate: number; outputs: number }) => {
      setAudioDevices(d.devices ?? []);
      setAudioDevice(d.current ?? "");
      setAudioInfo(`${d.outputs} outs @ ${Math.round(d.sampleRate/1000)}kHz`);
    });
    socket.on("audioOutputSet", (d: { device: string; sampleRate: number; outputs: number; error: string }) => {
      setAudioDevice(d.device ?? "");
      setAudioInfo(d.error ? `error: ${d.error}` : `${d.outputs} outs @ ${Math.round(d.sampleRate/1000)}kHz`);
      if (!d.error) { setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2000); }
    });
    socket.on("djSettings", (d: {
      routing: typeof routing | null;
      jog: { nudge: number; search: number; decay: number } | null;
      bindings: MidiBinding[];
      midiDevice: string;
    }) => {
      if (d.routing) {
      setRouting((prev) => ({ ...prev, ...d.routing }));
    }
      if (d.jog) setJog(d.jog);
      setBindings((d.bindings ?? []).filter((b) => b.action));
      if (d.midiDevice) setOpenDevice(d.midiDevice);
    });
    socket.on("midiDevices", (d: { devices: string[]; open: string }) => {
      setDevices(d.devices ?? []);
      setOpenDevice(d.open ?? "");
    });
    socket.on("midiOpened", (d: { device: string; error: string }) => {
      setOpenDevice(d.device ?? "");
      if (d.error) setLastMidi(`error: ${d.error}`);
    });
    socket.on("midi", (m: { status: number; channel: number; data1: number; data2: number }) => {
      const kind = m.status === 0xb0 ? "CC" : m.status === 0xe0 ? "PitchWheel" : "Note";
      setLastMidi(`${kind} ${m.data1} · ch${m.channel} · val ${m.data2}`);
      if (m.status === 0xb0) setLastRaw(m.data2);
      setLearning((pending) => {
        if (!pending) return null;
        // Ignore note-offs while learning so a button binds on the press.
        if (m.status === 0x90 && m.data2 === 0) return pending;
        const next: MidiBinding = {
          status: m.status, channel: m.channel, data1: m.data1,
          action: pending.action, deck: pending.deck, param: pending.param,
        };
        setBindings((prev) => {
          // One physical control does one job: replace any existing binding.
          const cleaned = prev.filter(
            (b) => !(b.status === next.status && b.data1 === next.data1 && b.channel === next.channel),
          );
          const updated = [...cleaned, next];
          audio.setMidiBindings(updated);   // engine saves to disk itself
          setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1500);
          return updated;
        });
        return null;
      });
    });
    return () => { socket.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeBinding = (i: number) => {
    const updated = bindings.filter((_, n) => n !== i);
    setBindings(updated);
    audio.setMidiBindings(updated);
  };

  const chip = "px-2 py-1 rounded text-[10px] font-bold";
  const chan = (v: number) => (v < 0 ? "—" : String(v + 1));

  const setChannel = (key: keyof typeof routing, raw: string) => {
    const v = raw === "—" ? -1 : parseInt(raw, 10) - 1;
    const next = { ...routing, [key]: v };
    setRouting(next);
    audio.setOutputRouting(next);
    setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1500);
  };

  // ChannelPicker defined outside component to avoid remount-on-render

  // One-line summary for the collapsed state: enough to confirm the rig is
  // right at a glance, without opening anything mid-set.
  const ch1 = (v: number) => (v < 0 ? "—" : String(v + 1));
  const summary = `FOH ${ch1(routing.fohL)}/${ch1(routing.fohR)} · CLICK ${ch1(routing.iemL)}`
    + `${routing.iemR >= 0 ? `/${ch1(routing.iemR)}` : " (mono)"} · CUE `
    + `${routing.cueL < 0 ? "off" : ch1(routing.cueL)}`;

  return (
    <div className="rounded-xl mt-4" style={{ background: "var(--md-surface)", border: "1px solid var(--md-border)" }}>
      {/* ── Collapsed header: always visible, always mounted ── */}
      <button onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left"
        style={{ background: "transparent" }}>
        <span style={{ color: "var(--md-text-muted)", fontSize: 10, width: 10 }}>{open ? "▾" : "▸"}</span>
        <span className="text-[11px] tracking-[0.25em]" style={{ color: "var(--md-text-muted)" }}>
          DJ SETUP
        </span>
        {!open && (
          <span className="text-[10px] font-mono truncate" style={{ color: "var(--md-text-muted)", opacity: 0.75 }}>
            {summary}
            {"  ·  "}
            <span style={{ color: openDevice ? "#38d39f" : "#ff8c1a" }}>
              {openDevice ? `${openDevice} · ${bindings.length} mapped` : "no MIDI device"}
            </span>
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[9px]" style={{ color: "var(--md-text-muted)" }}>
          {open ? "hide" : "show"}
        </span>
      </button>

      {!open ? null : (
      <div className="px-4 pb-4" style={{ maxHeight: "42vh", overflowY: "scroll", paddingBottom: 32, WebkitOverflowScrolling: "touch" }}>

      {/* ── Audio device (the root problem when RX3 steals the default) ── */}
      <div className="flex items-center gap-3 flex-wrap mb-3 pb-3"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
        <span className="text-[10px] w-14" style={{ color: "var(--md-text)" }}>AUDIO OUT</span>
        <select value={audioDevice}
          onChange={(e) => { audio.setAudioOutput(e.target.value); setAudioDevice(e.target.value); }}
          className="rounded px-2 py-1 text-[11px]"
          style={{ background: "var(--md-bg)", color: "var(--md-text)", border: "1px solid var(--md-border)", minWidth: 240 }}>
          {audioDevices.length === 0 && <option value={audioDevice}>{audioDevice || "loading..."}</option>}
          {audioDevices.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <button onClick={() => audio.listAudioOutputs()} className={chip}
          style={{ background: "#1a1a22", color: "var(--md-text)", border: "1px solid var(--md-border)" }}>
          RESCAN
        </button>
        <span className="text-[10px] font-mono" style={{ color: "var(--md-text-muted)" }}>{audioInfo}</span>
        {savedFlash && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded"
            style={{ background: "#38d39f22", color: "#38d39f", border: "1px solid #38d39f55" }}>
            ✓ Saved
          </span>
        )}
      </div>

      {/* ── Routing ── */}
      <div className="flex items-center gap-4 flex-wrap mb-2">
        <span className="text-[10px] w-14" style={{ color: "var(--md-text)" }}>FOH</span>
        <ChannelPicker label="L" value={chan(routing.fohL)} onChange={(v) => setChannel("fohL", v)} />
        <ChannelPicker label="R" value={chan(routing.fohR)} onChange={(v) => setChannel("fohR", v)} />
        <span className="text-[9px]" style={{ color: "var(--md-text-muted)" }}>→ the room</span>
      </div>
      <div className="flex items-center gap-4 flex-wrap mb-2">
        <span className="text-[10px] w-14" style={{ color: "var(--md-text)" }}>CLICK</span>
        <ChannelPicker label="L" value={chan(routing.iemL)} onChange={(v) => setChannel("iemL", v)} />
        <ChannelPicker label="R" value={chan(routing.iemR)} onChange={(v) => setChannel("iemR", v)} />
        <span className="text-[9px]" style={{ color: "var(--md-text-muted)" }}>
          → band in-ears (set R to — for mono; a guide track doesn't need stereo)
        </span>
      </div>
      <div className="flex items-center gap-4 flex-wrap mb-3">
        <span className="text-[10px] w-14" style={{ color: "var(--md-text)" }}>DJ CUE</span>
        <ChannelPicker label="L" value={chan(routing.cueL)} onChange={(v) => setChannel("cueL", v)} />
        <ChannelPicker label="R" value={chan(routing.cueR)} onChange={(v) => setChannel("cueR", v)} />
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[10px] w-14" style={{ color: "var(--md-accent)" }}>DECK A</span>
        <ChannelPicker label="L" value={chan(routing.deckAL)} onChange={(v) => setChannel("deckAL", v)} />
        <ChannelPicker label="R" value={chan(routing.deckAR)} onChange={(v) => setChannel("deckAR", v)} />
        <span className="text-[9px] ml-1" style={{ color: "var(--md-text-muted)" }}>→ mixer CH1</span>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[10px] w-14" style={{ color: "#b48aff" }}>DECK B</span>
        <ChannelPicker label="L" value={chan(routing.deckBL)} onChange={(v) => setChannel("deckBL", v)} />
        <ChannelPicker label="R" value={chan(routing.deckBR)} onChange={(v) => setChannel("deckBR", v)} />
        <span className="text-[9px] ml-1" style={{ color: "var(--md-text-muted)" }}>→ mixer CH2</span>
        <span className="text-[9px]" style={{ color: "var(--md-text-muted)" }}>
          → a mixer channel with the fader DOWN and PFL on
        </span>
      </div>

      {/* ── MIDI device ── */}
      <div className="flex items-center gap-3 flex-wrap pt-3"
        style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}>
        <span className="text-[10px] w-14" style={{ color: "var(--md-text)" }}>MIDI IN</span>
        <select value={openDevice} onChange={(e) => audio.midiOpen(e.target.value)}
          className="rounded px-2 py-1 text-[11px]"
          style={{ background: "var(--md-bg)", color: "var(--md-text)", border: "1px solid var(--md-border)", minWidth: 200 }}>
          <option value="">— none —</option>
          {devices.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <button onClick={() => audio.midiList()} className={chip}
          style={{ background: "#1a1a22", color: "var(--md-text)", border: "1px solid var(--md-border)" }}>
          RESCAN
        </button>
        <button
          onClick={() => {
            audio.clearMidiBindings();
            setBindings([]);
            setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1500);
          }}
          className={chip}
          title="Clear all MIDI bindings (use after a software update if controls stop responding)"
          style={{ background: "#ff555522", color: "#ff5555", border: "1px solid #ff555555" }}>
          CLEAR ALL
        </button>
        <button
          onClick={() => {
            if (bindings.length && !window.confirm("Replace the current mapping with the XDJ-RX3 preset?")) return;
            setBindings(XDJ_RX3_PRESET);
            audio.setMidiBindings(XDJ_RX3_PRESET);
          }}
          className={chip}
          title="Load the XDJ-RX3 starting map (verify each control; re-learn any that don't respond)"
          style={{ background: "#00b4ff", color: "#000", border: "1px solid #00b4ff" }}>
          LOAD XDJ-RX3 PRESET
        </button>
        <span className="text-[10px] font-mono" style={{ color: lastMidi ? "#38d39f" : "var(--md-text-muted)" }}>
          {lastMidi || "— no MIDI received yet —"}
        </span>
      </div>

      {/* ── MIDI OUT — Helix / vocal effects units ── */}
      <div className="mt-3 pt-3" style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[10px] w-14" style={{ color: "var(--md-text)" }}>MIDI OUT</span>
          <select
            value={midiOutDevice}
            onChange={(e) => {
              setMidiOutDevice(e.target.value);
              if (e.target.value) audio.midiOpenOut(e.target.value);
            }}
            className="flex-1 rounded text-[11px] py-1 px-2"
            style={{ background: "var(--md-bg)", color: "var(--md-text)", border: "1px solid var(--md-border)", minWidth: 180 }}>
            <option value="">— select output device —</option>
            {(audio.midiOutDeviceList ?? []).map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <button
            onClick={() => audio.midiListOut()}
            className="px-2 py-1 rounded text-[10px]"
            style={{ background: "#1a1a22", color: "var(--md-text-muted)", border: "1px solid var(--md-border)" }}>
            RESCAN
          </button>
          <span className="text-[10px] font-mono" style={{ color: midiOutDevice ? "#38d39f" : "var(--md-text-muted)" }}>
            {midiOutDevice ? `✓ open: ${midiOutDevice}` : "— not connected —"}
          </span>
        </div>
        <p className="text-[9px] mt-1" style={{ color: "var(--md-text-muted)", lineHeight: 1.5 }}>
          Used for Helix preset switching and vocal FX control. Configure patches per song in{" "}
          <strong style={{ color: "var(--md-text)" }}>Song Editor → MIDI Patches tab</strong>.
        </p>
      </div>

      {/* ── Jog calibration ── */}
      <div className="mt-3 pt-3" style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}>
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-[10px] w-14" style={{ color: "var(--md-text)" }}>JOG FEEL</span>
          {([
            ["nudge", "NUDGE", 0.0005, 0.02, 0.0005, (v: number) => `${(v * 100).toFixed(2)}%/tick`],
            ["search", "SEARCH", 0.0005, 0.05, 0.0005, (v: number) => `${(v * 1000).toFixed(1)}ms/tick`],
            ["decay", "EASE-OUT", 0.01, 0.5, 0.005, (v: number) => `${(v * 1000).toFixed(0)}ms`],
          ] as const).map(([k, label, min, max, step, fmt]) => (
            <label key={k} className="flex items-center gap-2 text-[10px]" style={{ color: "var(--md-text-muted)" }}>
              {label}
              <input type="range" min={min} max={max} step={step} value={jog[k]}
                onChange={(e) => {
                  const next = { ...jog, [k]: parseFloat(e.target.value) };
                  setJog(next);
                  audio.setJogSensitivity(next.nudge, next.search, next.decay);
                }}
                style={{ width: 90, accentColor: "#7B2CF9" }} />
              <span className="font-mono w-16" style={{ color: "var(--md-text)" }}>{fmt(jog[k])}</span>
            </label>
          ))}
        </div>
        {/* Library scroll speed — the jog wheel is too fast by default */}
      <div className="flex items-center gap-2 mt-2 text-[10px]" style={{ color: "var(--md-text-muted)" }}>
        <span>SCROLL DIV</span>
        <input type="range" min={1} max={16} step={1} value={scrollDiv}
          onChange={(e) => setScrollDiv(parseInt(e.target.value))}
          style={{ width: 80, accentColor: "#7B2CF9" }} />
        <span className="font-mono" style={{ color: "var(--md-text)" }}>1 scroll per {scrollDiv} tick{scrollDiv > 1 ? "s" : ""}</span>
        <span style={{ fontSize: 9 }}>— keep at 1 for the browse rotary; raise only if using the jog WHEEL for browsing</span>
      </div>

      {lastRaw !== null && (
          <div className="text-[10px] mt-2 font-mono" style={{ color: "var(--md-text-muted)" }}>
            jog calibration — last CC value <b style={{ color: "var(--md-text)" }}>{lastRaw}</b> decodes as:{" "}
            {REL_MODES.map((m) => (
              <span key={m.id} className="mr-3">
                {m.label} = <b style={{ color: "#38d39f" }}>{decodeRel(lastRaw, m.id) > 0 ? "+" : ""}{decodeRel(lastRaw, m.id)}</b>
              </span>
            ))}
            <div style={{ color: "var(--md-text-muted)" }}>
              Turn the wheel slowly FORWARD, then pick the mode showing small positive numbers.
            </div>
          </div>
        )}
      </div>

      {/* ── Learn ── */}
      <div className="mt-3">
        {learning && (
          <div className="text-[11px] mb-2 px-2 py-1 rounded inline-block"
            style={{ background: "#ff8c1a22", color: "#ff8c1a", border: "1px solid #ff8c1a" }}>
            Now move the control on the CDJ you want for “{ACTIONS.find((a) => a.id === learning.action)?.label}”
            {" "}(deck {learning.deck === 0 ? "A" : "B"}) — or press ESC to cancel
          </div>
        )}
        <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(230px,1fr))" }}>
          {ACTIONS.map((a) =>
            (GLOBAL_ACTIONS.has(a.id) ? [0] : [0, 1]).map((deck) => {
              const bound = bindings.find((b) => b.action === a.id && b.deck === deck);
              return (
                <div key={`${a.id}-${deck}`} className="flex items-center gap-2 text-[10px] py-0.5">
                  <span className="w-4 font-bold" style={{ color: GLOBAL_ACTIONS.has(a.id) ? "var(--md-text-muted)" : deck === 0 ? "#7B2CF9" : "#00b4ff" }}>
                    {GLOBAL_ACTIONS.has(a.id) ? "·" : deck === 0 ? "A" : "B"}
                  </span>
                  <span className="flex-1 truncate" style={{ color: "var(--md-text)" }}>{a.label}</span>
                  {bound ? (
                    <>
                      <span className="font-mono" style={{ color: "#38d39f" }}>{describe(bound)}</span>
                      {(() => { const v = liveValue(a.id, deck, decks); return v ? (
                        <span className="font-mono text-[10px] px-1 rounded"
                          style={{ background: "rgba(56,211,159,0.12)", color: "#38d39f" }}>{v}</span>
                      ) : null; })()}
                      {a.id === "jog" && (
                        <select value={bound.relMode ?? 0}
                          onChange={(e) => {
                            const updated = bindings.map((b) =>
                              b === bound ? { ...b, relMode: parseInt(e.target.value, 10) } : b);
                            setBindings(updated);
                            audio.setMidiBindings(updated);
                          }}
                          className="rounded text-[9px]"
                          style={{ background: "var(--md-bg)", color: "var(--md-text)", border: "1px solid var(--md-border)" }}>
                          {REL_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                        </select>
                      )}
                      <button onClick={() => removeBinding(bindings.indexOf(bound))}
                        className="px-1 rounded" style={{ color: "#ff5555" }} title="Clear">✕</button>
                    </>
                  ) : (
                    <button
                      onClick={() => {
                        if (a.id === "hotCue") {
                          // Slot picker shown inline — handled below, just set state without param yet
                          setLearning({ action: a.id, deck, param: -1 });
                          return;
                        }
                        setLearning({ action: a.id, deck, param: 0 });
                      }}
                      className="px-2 rounded"
                      style={{ background: "#1a1a22", color: "var(--md-text-muted)", border: "1px solid var(--md-border)" }}>
                      LEARN
                    </button>
                  )}
                </div>
              );
            }),
          )}
        </div>
      </div>

      </div>
      )}
    </div>
  );
}
