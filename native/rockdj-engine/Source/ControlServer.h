/*
  ══════════════════════════════════════════════════════════════════════════════
  ControlServer.h - the boundary between the Electron app and this audio engine.

  HOW IT WORKS
  ------------
  This opens a TCP socket that listens ONLY on 127.0.0.1 (localhost) - it is
  never reachable from the network, so nothing on the venue Wi-Fi can talk to the
  audio engine. The Electron app connects to it.

  Messages are plain JSON, one per line (newline-delimited). That format is
  chosen on purpose: you can literally watch the traffic with a tool like `nc`
  while debugging. Nothing about the protocol is hidden or binary.

  Commands come DOWN from Electron:
      {"cmd":"ping","id":7}
      {"cmd":"play"}                 (wired in a later milestone)
  Events go UP to Electron:
      {"evt":"ready","version":"..."}          (sent as soon as it connects)
      {"evt":"pong","id":7}
      {"evt":"status","device":"Scarlett 2i4","outputs":4,"sampleRate":48000,...}

  For Milestone 3a (plumbing) the only real command is ping/pong plus the
  periodic status heartbeat. Transport commands land in the next milestone.

  Audio timing NEVER depends on this socket. The engine keeps its own
  sample-accurate clock; this channel only carries control + display info.
  ══════════════════════════════════════════════════════════════════════════════
*/

#pragma once

#include <juce_core/juce_core.h>
#include "AudioEngine.h"
#include "LinkService.h"
#include <atomic>
#include <mutex>
#include <thread>

class ControlServer : private juce::Thread
{
public:
    ControlServer (AudioEngine& engineToControl, LinkService& linkService, int portToUse);
    ~ControlServer() override;

    /** Begin listening + accepting connections (on a background thread). */
    void start();

    int getPort() const { return port; }

private:
    std::atomic<int> libraryScrollDiv { 1 };
    int libraryScrollAcc { 0 };
    // Background thread: listen, accept one client, read commands until it
    // disconnects, then go back to accepting.
    void run() override;

    void handleLine (const juce::String& line);
    void sendEvent  (const juce::var& message);          // thread-safe
    void sendDeckWaveform (int di);                       // thread-safe
    void telemetryLoop();                                // periodic status

    juce::var buildStatus() const;

    AudioEngine& engine;
    LinkService& link;
    const int    port;

    juce::StreamingSocket listener;
    std::unique_ptr<juce::StreamingSocket> connection;   // current client (or null)

    std::mutex   writeMutex;                             // guards socket writes
    std::mutex   connectionMutex;                        // guards `connection`
    std::atomic<bool> running { false };
    std::thread  telemetryThread;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ControlServer)
};
