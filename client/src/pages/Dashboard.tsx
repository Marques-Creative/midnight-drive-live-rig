import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Music2, ListMusic, Radio, Wifi, ChevronRight, Clock } from "lucide-react";

function formatDuration(seconds: number | null | undefined) {
  if (!seconds) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Dashboard() {
  const { data: songs } = trpc.songs.list.useQuery();
  const { data: setLists } = trpc.setLists.list.useQuery();

  const recentSongs = songs?.slice(0, 5) ?? [];
  const latestSetList = setLists?.[0];

  return (
    <div className="animate-slide-up" style={{ position: "relative", minHeight: "100vh" }}>

      {/* Hero banner — edge-to-edge, no heading above it, matches reference */}
      <div style={{
        position: "relative",
        width: "100%",
        overflow: "hidden",
        marginBottom: 32,
      }}>
        <img
          src="/rockdj-hero.png"
          alt="ROCKDJ Live Performance OS"
          style={{ width: "100%", display: "block", height: 380, objectFit: "cover", objectPosition: "center 25%" }}
        />
        {/* Bottom fade into page background */}
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0, height: 80,
          background: "linear-gradient(transparent, var(--md-black))",
          pointerEvents: "none",
        }} />
      </div>

      {/* Everything below hero gets normal padding */}
      <div className="px-8 max-w-5xl mx-auto">

      {/* Quick action cards */}
      <div className="grid grid-cols-3 gap-4 mb-10">
        {/* Live Screen — magenta accent */}
        <Link href="/live">
          <div
            className="p-6 rounded cursor-pointer transition-all duration-200 hover:scale-[1.02] group"
            style={{
              background: "linear-gradient(135deg, rgba(255,45,120,0.14), rgba(0,180,255,0.06))",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              border: "1px solid rgba(255,45,120,0.35)",
              borderRadius: "var(--radius)",
            }}
          >
            <div className="flex items-center justify-between mb-4">
              <div
                className="w-10 h-10 rounded flex items-center justify-center"
                style={{ background: "rgba(255,45,120,0.2)" }}
              >
                <Radio size={20} style={{ color: "var(--md-magenta)" }} />
              </div>
              <span
                className="text-xs font-bold tracking-widest uppercase px-2 py-1 rounded animate-pulse-glow"
                style={{
                  background: "rgba(255,45,120,0.2)",
                  color: "var(--md-magenta)",
                }}
              >
                GO LIVE
              </span>
            </div>
            <div className="font-bold text-lg" style={{ color: "var(--md-text)" }}>
              Live Screen
            </div>
            <div className="text-xs mt-1" style={{ color: "var(--md-text-dim)" }}>
              Launch performance mode
            </div>
          </div>
        </Link>

        {/* Song Library — blue accent */}
        <Link href="/songs">
          <div
            className="p-6 rounded cursor-pointer transition-all duration-200 hover:scale-[1.02]"
            style={{
              background: "rgba(8,10,15,0.55)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              border: "1px solid rgba(0,180,255,0.25)",
              borderRadius: "var(--radius)",
            }}
          >
            <div className="flex items-center justify-between mb-4">
              <div
                className="w-10 h-10 rounded flex items-center justify-center"
                style={{ background: "rgba(0,180,255,0.15)" }}
              >
                <Music2 size={20} style={{ color: "var(--md-blue)" }} />
              </div>
              <span className="text-2xl font-bold" style={{ color: "var(--md-blue)" }}>
                {songs?.length ?? 0}
              </span>
            </div>
            <div className="font-bold text-lg" style={{ color: "var(--md-text)" }}>
              Song Library
            </div>
            <div className="text-xs mt-1" style={{ color: "var(--md-text-dim)" }}>
              {songs?.length === 1 ? "1 song" : `${songs?.length ?? 0} songs`} in library
            </div>
          </div>
        </Link>

        {/* Set Lists — blue accent */}
        <Link href="/setlists">
          <div
            className="p-6 rounded cursor-pointer transition-all duration-200 hover:scale-[1.02]"
            style={{
              background: "rgba(8,10,15,0.55)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              border: "1px solid rgba(0,180,255,0.25)",
              borderRadius: "var(--radius)",
            }}
          >
            <div className="flex items-center justify-between mb-4">
              <div
                className="w-10 h-10 rounded flex items-center justify-center"
                style={{ background: "rgba(0,180,255,0.15)" }}
              >
                <ListMusic size={20} style={{ color: "var(--md-blue)" }} />
              </div>
              <span className="text-2xl font-bold" style={{ color: "var(--md-blue)" }}>
                {setLists?.length ?? 0}
              </span>
            </div>
            <div className="font-bold text-lg" style={{ color: "var(--md-text)" }}>
              Set Lists
            </div>
            <div className="text-xs mt-1" style={{ color: "var(--md-text-dim)" }}>
              {setLists?.length === 1 ? "1 set list" : `${setLists?.length ?? 0} set lists`} saved
            </div>
          </div>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Recent songs */}
        <div
          className="p-5 rounded"
          style={{
            background: "rgba(8,10,15,0.55)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            border: "1px solid rgba(0,180,255,0.2)",
            borderRadius: "var(--radius)",
          }}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold tracking-widest uppercase" style={{ color: "var(--md-text-dim)" }}>
              Recent Songs
            </h2>
            <Link href="/songs">
              <span className="text-xs cursor-pointer hover:opacity-80" style={{ color: "var(--md-blue)" }}>
                View all
              </span>
            </Link>
          </div>
          {recentSongs.length === 0 ? (
            <div className="text-center py-8">
              <Music2 size={32} className="mx-auto mb-3 opacity-20" />
              <p className="text-sm" style={{ color: "var(--md-text-muted)" }}>
                No songs yet
              </p>
              <Link href="/songs/new">
                <span
                  className="text-xs mt-2 inline-block cursor-pointer"
                  style={{ color: "var(--md-blue)" }}
                >
                  Add your first song →
                </span>
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {recentSongs.map((song) => (
                <Link key={song.id} href={`/songs/${song.id}`}>
                  <div
                    className="flex items-center justify-between px-3 py-2.5 rounded cursor-pointer transition-colors"
                    style={{ background: "rgba(0,180,255,0.06)", border: "1px solid rgba(0,180,255,0.1)" }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: "var(--md-blue)" }}
                      />
                      <span className="text-sm truncate" style={{ color: "var(--md-text)" }}>
                        {song.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-2">
                      {song.bpm && (
                        <span className="text-xs" style={{ color: "var(--md-text-muted)" }}>
                          {song.bpm} BPM
                        </span>
                      )}
                      {song.key && (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded"
                          style={{
                            background: "rgba(0,180,255,0.1)",
                            color: "var(--md-blue)",
                          }}
                        >
                          {song.key}
                        </span>
                      )}
                      <ChevronRight size={12} style={{ color: "var(--md-text-muted)" }} />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Latest set list */}
        <div
          className="p-5 rounded"
          style={{
            background: "rgba(8,10,15,0.55)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            border: "1px solid rgba(0,180,255,0.2)",
            borderRadius: "var(--radius)",
          }}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold tracking-widest uppercase" style={{ color: "var(--md-text-dim)" }}>
              Latest Set List
            </h2>
            <Link href="/setlists">
              <span className="text-xs cursor-pointer hover:opacity-80" style={{ color: "var(--md-blue)" }}>
                View all
              </span>
            </Link>
          </div>
          {!latestSetList ? (
            <div className="text-center py-8">
              <ListMusic size={32} className="mx-auto mb-3 opacity-20" />
              <p className="text-sm" style={{ color: "var(--md-text-muted)" }}>
                No set lists yet
              </p>
              <Link href="/setlists">
                <span
                  className="text-xs mt-2 inline-block cursor-pointer"
                  style={{ color: "var(--md-blue)" }}
                >
                  Create a set list →
                </span>
              </Link>
            </div>
          ) : (
            <Link href={`/setlists/${latestSetList.id}`}>
              <div
                className="p-4 rounded cursor-pointer transition-colors"
                style={{
                  background: "rgba(0,180,255,0.06)",
                  border: "1px solid rgba(0,180,255,0.15)",
                }}
              >
                <div className="font-bold text-base mb-1" style={{ color: "var(--md-text)" }}>
                  {latestSetList.name}
                </div>
                {latestSetList.description && (
                  <div className="text-xs mb-3" style={{ color: "var(--md-text-dim)" }}>
                    {latestSetList.description}
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs" style={{ color: "var(--md-text-muted)" }}>
                  <Clock size={11} />
                  <span>
                    Updated {new Date(latestSetList.updatedAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </Link>
          )}

          {/* iPad companion link */}
          <div
            className="mt-4 p-3 rounded flex items-center gap-3"
            style={{
              background: "rgba(0,180,255,0.06)",
              border: "1px solid rgba(0,180,255,0.15)",
            }}
          >
            <Wifi size={14} style={{ color: "var(--md-blue)" }} />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold" style={{ color: "var(--md-blue)" }}>
                iPad Companion
              </div>
              <div className="text-xs" style={{ color: "var(--md-text-muted)" }}>
                Connect via Live Screen → QR Code
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
