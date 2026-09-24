/**
 * MidiPatchEditor — configure MIDI messages to auto-send when a song loads.
 *
 * Supports three patch types:
 *   bank+pc  → CC0 (bankMSB), CC32 (bankLSB), then Program Change — for Helix
 *   pc       → Program Change only — for simple patch switching
 *   cc       → Control Change — for toggling effects on/off, sending values
 *
 * Messages fire in order with a configurable gap (default 20ms) so older
 * hardware (Helix, TC-Helicon) has time to process each message.
 */
import { useState } from "react";
import { trpc } from "../lib/trpc";

export interface MidiPatch {
  id: string;
  label: string;
  channel: number;       // 1-16
  type: "bank+pc" | "pc" | "cc";
  program?: number;      // 0-127
  bankMSB?: number;      // 0-127  (for bank+pc)
  bankLSB?: number;      // 0-127  (for bank+pc)
  cc?: number;           // 0-127  (for cc)
  value?: number;        // 0-127  (for cc)
  delayMs?: number;      // ms between this and next message, default 20
}

const PATCH_DEFAULTS: Record<string, Partial<MidiPatch>> = {
  "bank+pc": { bankMSB: 0, bankLSB: 0, program: 0, delayMs: 30 },
  "pc":      { program: 0, delayMs: 20 },
  "cc":      { cc: 0, value: 127, delayMs: 20 },
};

function newPatch(type: MidiPatch["type"]): MidiPatch {
  return { id: Math.random().toString(36).slice(2), label: "", channel: 1, type, ...PATCH_DEFAULTS[type] };
}

function Row({ patch, onChange, onRemove }: {
  patch: MidiPatch;
  onChange: (p: MidiPatch) => void;
  onRemove: () => void;
}) {
  const set = (k: keyof MidiPatch, v: unknown) => onChange({ ...patch, [k]: v });
  const num = (v: string, min = 0, max = 127) => Math.max(min, Math.min(max, parseInt(v) || 0));

  const inputStyle = {
    background: "#0a0a12", border: "1px solid rgba(255,255,255,0.12)",
    color: "#fff", borderRadius: 4, padding: "2px 6px", fontSize: 11,
    width: 50,
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px",
      background: "rgba(255,255,255,0.03)", borderRadius: 5,
      border: "1px solid rgba(255,255,255,0.07)" }}>

      {/* Label */}
      <input value={patch.label} placeholder="label…"
        onChange={(e) => set("label", e.target.value)}
        style={{ ...inputStyle, width: 100, flex: "0 0 100px" }} />

      {/* Type */}
      <select value={patch.type} onChange={(e) => onChange({ ...patch, type: e.target.value as MidiPatch["type"], ...PATCH_DEFAULTS[e.target.value] })}
        style={{ ...inputStyle, width: 80 }}>
        <option value="bank+pc">Bank+PC</option>
        <option value="pc">PC only</option>
        <option value="cc">CC</option>
      </select>

      {/* Ch */}
      <label style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", display: "flex", alignItems: "center", gap: 3 }}>
        Ch
        <input type="number" min={1} max={16} value={patch.channel}
          onChange={(e) => set("channel", num(e.target.value, 1, 16))}
          style={{ ...inputStyle, width: 36 }} />
      </label>

      {/* Type-specific fields */}
      {patch.type === "bank+pc" && (<>
        <label style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", display: "flex", alignItems: "center", gap: 3 }}>
          MSB<input type="number" min={0} max={127} value={patch.bankMSB ?? 0}
            onChange={(e) => set("bankMSB", num(e.target.value))} style={inputStyle} />
        </label>
        <label style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", display: "flex", alignItems: "center", gap: 3 }}>
          LSB<input type="number" min={0} max={127} value={patch.bankLSB ?? 0}
            onChange={(e) => set("bankLSB", num(e.target.value))} style={inputStyle} />
        </label>
        <label style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", display: "flex", alignItems: "center", gap: 3 }}>
          PC<input type="number" min={0} max={127} value={patch.program ?? 0}
            onChange={(e) => set("program", num(e.target.value))} style={inputStyle} />
        </label>
      </>)}

      {patch.type === "pc" && (
        <label style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", display: "flex", alignItems: "center", gap: 3 }}>
          PC<input type="number" min={0} max={127} value={patch.program ?? 0}
            onChange={(e) => set("program", num(e.target.value))} style={inputStyle} />
        </label>
      )}

      {patch.type === "cc" && (<>
        <label style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", display: "flex", alignItems: "center", gap: 3 }}>
          CC#<input type="number" min={0} max={127} value={patch.cc ?? 0}
            onChange={(e) => set("cc", num(e.target.value))} style={inputStyle} />
        </label>
        <label style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", display: "flex", alignItems: "center", gap: 3 }}>
          Val<input type="number" min={0} max={127} value={patch.value ?? 127}
            onChange={(e) => set("value", num(e.target.value))} style={inputStyle} />
        </label>
      </>)}

      {/* Delay */}
      <label style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", display: "flex", alignItems: "center", gap: 3 }}>
        +<input type="number" min={0} max={500} value={patch.delayMs ?? 20}
          onChange={(e) => set("delayMs", num(e.target.value, 0, 500))}
          style={{ ...inputStyle, width: 40 }} />ms
      </label>

      {/* Remove */}
      <button onClick={onRemove}
        style={{ marginLeft: "auto", background: "none", border: "none", color: "rgba(255,85,85,0.7)", cursor: "pointer", fontSize: 14 }}>
        ×
      </button>
    </div>
  );
}

export default function MidiPatchEditor({ songId, initialPatches }: {
  songId: number;
  initialPatches?: string | null;
}) {
  const [patches, setPatches] = useState<MidiPatch[]>(() => {
    try { return JSON.parse(initialPatches ?? "[]") as MidiPatch[]; }
    catch { return []; }
  });
  const [saved, setSaved] = useState(true);
  const utils = trpc.useUtils();
  const save = trpc.songs.saveMidiPatches.useMutation({
    onSuccess: () => { setSaved(true); utils.songs.list.invalidate(); },
  });

  const update = (next: MidiPatch[]) => { setPatches(next); setSaved(false); };

  return (
    <div style={{ color: "#fff", fontSize: 11 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div>
          <span style={{ fontWeight: 700, letterSpacing: "0.1em", color: "#b24bff" }}>MIDI PATCHES</span>
          <span style={{ marginLeft: 8, color: "rgba(255,255,255,0.35)", fontSize: 10 }}>
            auto-fired when this song loads onto a deck
          </span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {/* Add buttons */}
          {(["bank+pc", "pc", "cc"] as const).map((t) => (
            <button key={t} onClick={() => update([...patches, newPatch(t)])}
              style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid rgba(178,75,255,0.4)",
                background: "rgba(178,75,255,0.1)", color: "#b24bff", cursor: "pointer", fontSize: 10, fontWeight: 700 }}>
              + {t.toUpperCase()}
            </button>
          ))}
          {/* Save */}
          <button onClick={() => save.mutate({ songId, patches: JSON.stringify(patches) })}
            disabled={saved}
            style={{ padding: "3px 10px", borderRadius: 4, border: "none", cursor: saved ? "default" : "pointer",
              background: saved ? "rgba(255,255,255,0.06)" : "#b24bff",
              color: saved ? "rgba(255,255,255,0.3)" : "#fff", fontWeight: 700, fontSize: 10 }}>
            {save.isPending ? "Saving…" : saved ? "Saved" : "Save"}
          </button>
        </div>
      </div>

      {patches.length === 0 ? (
        <p style={{ color: "rgba(255,255,255,0.25)", fontSize: 10, margin: "8px 0" }}>
          No patches — add Bank+PC for Helix preset switching, PC for simple patch changes, or CC for effect toggles.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {patches.map((patch, i) => (
            <Row key={patch.id} patch={patch}
              onChange={(p) => update(patches.map((x, j) => j === i ? p : x))}
              onRemove={() => update(patches.filter((_, j) => j !== i))} />
          ))}
          <p style={{ color: "rgba(255,255,255,0.25)", fontSize: 9, margin: "4px 0 0" }}>
            Messages fire top-to-bottom. Delay = ms gap before the NEXT message.
            Helix Bank+PC: use MSB 0, set LSB for the bank (0=bank A, 1=bank B…), PC=preset number.
          </p>
        </div>
      )}
    </div>
  );
}
