/*
  Main.cpp - headless entry point for the ROCKDJ audio engine service.

  This is a background process with no window. The Electron app launches it,
  passing a --port, and talks to it over the local control socket (ControlServer).

  For Milestone 3a this proves the plumbing: the engine starts, opens the audio
  device if one is available, listens for the Electron connection, and answers
  ping/pong + status. Actual transport (play/stop/load) is wired next.
*/

#include <juce_core/juce_core.h>
#include "AudioEngine.h"
#include "ControlServer.h"
#include "LinkService.h"

#include <csignal>
#include <iostream>
#include <cstring>
#include <unistd.h>
#include <atomic>
#include <thread>
#include <chrono>

// ── Crash signal handler ─────────────────────────────────────────────────────
// Writes a minimal crash notice to stderr before the process dies.
// The Electron main process captures stderr and writes it to the crash log.
static void crashHandler (int sig)
{
    const char* name = "UNKNOWN";
    switch (sig) {
        case SIGSEGV: name = "SIGSEGV (memory access violation)"; break;
        case SIGABRT: name = "SIGABRT (abort/assertion)"; break;
        case SIGBUS:  name = "SIGBUS  (bus error)"; break;
        case SIGILL:  name = "SIGILL  (illegal instruction)"; break;
        case SIGFPE:  name = "SIGFPE  (floating point error)"; break;
    }
    // Use async-signal-safe write, not std::cerr
    const char prefix[] = "\n[ROCKDJ ENGINE CRASH] Signal: ";
    write (STDERR_FILENO, prefix, sizeof(prefix)-1);
    write (STDERR_FILENO, name, strlen(name));
    const char suffix[] = "\n[ROCKDJ ENGINE CRASH] Check ~/Library/Logs/ROCKDJ/engine-crash.log\n";
    write (STDERR_FILENO, suffix, sizeof(suffix)-1);
    // Re-raise with default handler to produce a proper core dump / exit code
    signal (sig, SIG_DFL);
    raise (sig);
}

namespace
{
    std::atomic<bool> gShouldQuit { false };

    void handleSignal (int) { gShouldQuit.store (true); }

    int parsePort (int argc, char* argv[], int fallback)
    {
        for (int i = 1; i < argc - 1; ++i)
            if (juce::String (argv[i]) == "--port")
                return juce::String (argv[i + 1]).getIntValue();
        return fallback;
    }

    juce::String parseDevice (int argc, char* argv[])
    {
        for (int i = 1; i < argc - 1; ++i)
            if (juce::String (argv[i]) == "--device")
                return juce::String (argv[i + 1]);
        return {};
    }
}

int main (int argc, char* argv[])
{
    // Clean shutdown when Electron kills us (SIGTERM) or on Ctrl-C (SIGINT).
    std::signal (SIGINT,  handleSignal);
    std::signal (SIGTERM, handleSignal);

    const int port = parsePort (argc, argv, 47822);
    const juce::String preferredDevice = parseDevice (argc, argv);

    // Set up JUCE's message manager (needed by the audio device layer on macOS).
    // We do NOT run its dispatch loop - our own threads drive everything - so
    // this is safe on a headless machine.
    // Register crash signal handlers so the log captures the signal name
    signal (SIGSEGV, crashHandler);
    signal (SIGABRT, crashHandler);
    signal (SIGBUS,  crashHandler);
    signal (SIGILL,  crashHandler);
    signal (SIGFPE,  crashHandler);

    juce::ScopedJuceInitialiser_GUI juceInit;

    AudioEngine engine;
    if (preferredDevice.isNotEmpty())
        engine.setPreferredOutputDevice (preferredDevice);
    LinkService link (120.0);   // initialise at 120 BPM; DJ tempo takes over when engine starts
        engine.setPreferredOutputDevice (preferredDevice);

    // Try to open an audio device. On a machine with no audio hardware (e.g. a
    // build server) this returns an error; that's fine for the plumbing - the
    // control server still runs so ping/pong and status work.
    const juce::String audioErr = engine.initialise();
    if (audioErr.isNotEmpty())
        std::cerr << "[engine] audio device not opened: " << audioErr
                  << " (control channel still available)" << std::endl;
    else
        std::cerr << "[engine] audio device: " << engine.getDeviceName()
                  << " (" << engine.getNumOutputChannels() << " outs @ "
                  << (int) engine.getDeviceSampleRate() << " Hz)" << std::endl;
    link.setTempo (120.0);

    // Restore the DJ's routing, MIDI mapping and jog feel BEFORE anything else
    // connects. This is deliberately engine-side: the mapping has to be live
    // the moment the app starts, whether or not anyone opens the settings page.
    engine.loadSettings();
    if (AudioEngine::getSettingsFile().existsAsFile())
        std::cerr << "[engine] DJ settings restored from "
                  << AudioEngine::getSettingsFile().getFullPathName() << std::endl;

    ControlServer control (engine, link, port);
    control.start();

    // Idle until asked to quit. All real work happens on the control/audio threads.
    while (! gShouldQuit.load())
        std::this_thread::sleep_for (std::chrono::milliseconds (100));

    std::cerr << "[engine] shutting down" << std::endl;
    return 0;
}
