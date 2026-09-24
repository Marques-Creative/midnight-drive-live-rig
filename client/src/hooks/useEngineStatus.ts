import { useEffect, useState } from "react";
import { io, Socket } from "socket.io-client";

/**
 * Subscribes to the native ROCKDJ audio engine's status, relayed by the server
 * over Socket.IO. Used to show a small "engine connected / ready" indicator so
 * you can see at a glance whether the native audio engine is live before a show.
 */
export interface EngineStatus {
  connected: boolean;       // is the server's link to the native engine up?
  device: string;           // audio device name, or "none"
  outputs: number;          // active output channels
  sampleRate: number;
  playing: boolean;
  readyForRouting: boolean; // true when >= 4 outputs (FOH + IEM)
}

const INITIAL: EngineStatus = {
  connected: false,
  device: "none",
  outputs: 0,
  sampleRate: 0,
  playing: false,
  readyForRouting: false,
};

export function useEngineStatus(): EngineStatus {
  const [status, setStatus] = useState<EngineStatus>(INITIAL);

  useEffect(() => {
    const socket: Socket = io(window.location.origin, { path: "/socket.io" });
    socket.on("engineStatus", (s: EngineStatus) => setStatus(s));
    socket.on("disconnect", () => setStatus(INITIAL));
    return () => { socket.disconnect(); };
  }, []);

  return status;
}
