import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Music2,
  ListMusic,
  Radio,
  Disc3,
  Wifi,
} from "lucide-react";
import { cn } from "@/lib/utils";
import EngineStatusBadge from "./EngineStatusBadge";

const navItems = [
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/songs", icon: Music2, label: "Song Library" },
  { href: "/setlists", icon: ListMusic, label: "Set Lists" },
  { href: "/dj", icon: Disc3, label: "DJ Decks", accent: true },
  { href: "/live", icon: Radio, label: "Live Screen", accent: true },
];

interface AppLayoutProps {
  children: React.ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps) {
  const [location] = useLocation();

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar — glassy, semi-transparent */}
      <aside
        className="flex flex-col w-56 shrink-0 border-r"
        style={{
          position: "relative",
          zIndex: 10,
          background: "rgba(8, 10, 15, 0.72)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          borderColor: "rgba(0, 180, 255, 0.18)",
        }}
      >
        {/* Logo — ROCKDJ wordmark */}
        <div
          className="border-b px-4 py-5"
          style={{ borderColor: "rgba(123, 44, 207, 0.3)" }}
        >
          <div
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontWeight: 900,
              fontSize: "1.5rem",
              letterSpacing: "0.06em",
              lineHeight: 1,
            }}
          >
            <span style={{ color: "#ffffff" }}>ROCK</span>
            <span
              style={{
                background: "linear-gradient(135deg, #7B2CF9, #B24BFF)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              DJ
            </span>
          </div>
          <div
            className="mt-1"
            style={{
              fontSize: "0.55rem",
              letterSpacing: "0.35em",
              color: "rgba(255,255,255,0.45)",
            }}
          >
            LIVE PERFORMANCE OS
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map(({ href, icon: Icon, label, accent }) => {
            const isActive =
              href === "/" ? location === "/" : location.startsWith(href);
            return (
              <Link key={href} href={href}>
                <div
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded cursor-pointer transition-all duration-150",
                    isActive
                      ? "text-sm font-semibold"
                      : "text-sm hover:opacity-100"
                  )}
                  style={{
                    background: isActive
                      ? accent
                        ? "rgba(255, 45, 120, 0.15)"
                        : "rgba(0, 180, 255, 0.12)"
                      : "transparent",
                    color: isActive
                      ? accent
                        ? "var(--md-magenta)"
                        : "var(--md-blue)"
                      : "var(--md-text-dim)",
                    borderLeft: isActive
                      ? `2px solid ${accent ? "var(--md-magenta)" : "var(--md-blue)"}`
                      : "2px solid transparent",
                  }}
                >
                  <Icon size={16} strokeWidth={isActive ? 2.5 : 2} />
                  <span className="tracking-wide">{label}</span>
                  {label === "Live Screen" && (
                    <span
                      className="ml-auto text-xs px-1.5 py-0.5 rounded"
                      style={{
                        background: "rgba(255, 45, 120, 0.2)",
                        color: "var(--md-magenta)",
                        fontSize: "0.65rem",
                        letterSpacing: "0.1em",
                      }}
                    >
                      LIVE
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Bottom status */}
        <div
          className="px-4 py-4 border-t space-y-3"
          style={{ borderColor: "rgba(0, 180, 255, 0.12)" }}
        >
          <EngineStatusBadge />
          <Link href="/companion">
            <div
              className="flex items-center gap-2 text-xs cursor-pointer transition-opacity hover:opacity-100"
              style={{ color: "var(--md-text-muted)" }}
            >
              <Wifi size={12} />
              <span className="tracking-wide uppercase">iPad Companion</span>
            </div>
          </Link>
        </div>
      </aside>

      {/* Main content */}
      <main
        className="flex-1 overflow-auto"
        style={{ position: "relative", zIndex: 10, background: "transparent" }}
      >
        {children}
      </main>
    </div>
  );
}
