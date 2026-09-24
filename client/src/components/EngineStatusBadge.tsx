import { Cpu } from "lucide-react";
import { useEngineStatus } from "@/hooks/useEngineStatus";

/**
 * Sidebar badge showing the native audio engine's state:
 *   - grey  = not connected (engine not running / not built)
 *   - amber = connected but fewer than 4 outputs (no separate FOH/IEM yet)
 *   - green = connected and ready for separate FOH/IEM routing
 */
export default function EngineStatusBadge() {
  const s = useEngineStatus();

  const color = !s.connected
    ? "var(--md-text-muted)"
    : s.readyForRouting
    ? "#38d39f"
    : "#f0a53a";

  const label = !s.connected
    ? "Audio engine offline"
    : s.readyForRouting
    ? `${s.device} · FOH+IEM ready`
    : s.device !== "none"
    ? `${s.device} · ${s.outputs} out`
    : "Engine connected";

  return (
    <div
      className="flex items-center gap-2 text-xs"
      style={{ color }}
      title={
        s.connected
          ? `Native audio engine: ${s.device}, ${s.outputs} outputs @ ${s.sampleRate} Hz`
          : "Native audio engine is not connected"
      }
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
          boxShadow: s.connected ? `0 0 6px ${color}` : "none",
          flexShrink: 0,
        }}
      />
      <Cpu size={12} />
      <span className="tracking-wide truncate">{label}</span>
    </div>
  );
}
