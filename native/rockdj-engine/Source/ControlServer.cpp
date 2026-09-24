/*
  ControlServer.cpp - see ControlServer.h for the overview.
*/

#include "ControlServer.h"
#include <iostream>
#include <thread>

ControlServer::ControlServer (AudioEngine& engineToControl, LinkService& linkService, int portToUse)
    : juce::Thread ("rockdj-control"),
      engine (engineToControl),
      link (linkService),
      port (portToUse)
{
}

ControlServer::~ControlServer()
{
    running.store (false);
    signalThreadShouldExit();
    listener.close();                 // unblocks waitForNextConnection()
    {
        std::lock_guard<std::mutex> lock (connectionMutex);
        if (connection != nullptr) connection->close();
    }
    if (telemetryThread.joinable())
        telemetryThread.join();
    stopThread (2000);
}

void ControlServer::start()
{
    // Every incoming MIDI message is echoed to the UI so a control can be
    // LEARNED from the hardware instead of guessed. This is the only honest way
    // to support a CDJ we have never had in the room.
    libraryScrollAcc = 0;  // reset accumulator
    engine.setLibraryCallback ([this] (const juce::String& action, int steps)
    {
        auto* o = new juce::DynamicObject();
        if (action == "scroll")
        {
            // Accumulate ticks; fire one event per `libraryScrollDiv` ticks.
            // This makes jog-wheel browsing feel controlled, not a fire hose.
            libraryScrollAcc += steps;
            const int div = libraryScrollDiv.load();
            int fired = 0;
            while (std::abs (libraryScrollAcc) >= div && fired < 6)
            {
                auto* ev = new juce::DynamicObject();
                ev->setProperty ("evt", "libraryNav");
                ev->setProperty ("dir", libraryScrollAcc > 0 ? 1 : -1);
                sendEvent (juce::var (ev));
                libraryScrollAcc += libraryScrollAcc > 0 ? -div : div;
                ++fired;
            }
            delete o;
        }
        else if (action == "up" || action == "down")
        {
            o->setProperty ("evt", "libraryNav");
            o->setProperty ("dir", action == "up" ? -1 : 1);
            sendEvent (juce::var (o));
        }
        else if (action == "select")
        {
            o->setProperty ("evt", "librarySelect");
            sendEvent (juce::var (o));
        }
        else if (action == "load0" || action == "load1")
        {
            o->setProperty ("evt", "libraryLoad");
            o->setProperty ("deck", action == "load0" ? 0 : 1);
            sendEvent (juce::var (o));
        }
        else { delete o; }
    });
    engine.setMidiMonitor ([this] (int status, int channel, int d1, int d2)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("evt", "midi");
        o->setProperty ("status", status);
        o->setProperty ("channel", channel);
        o->setProperty ("data1", d1);
        o->setProperty ("data2", d2);
        sendEvent (juce::var (o));
    });
    running.store (true);
    startThread();                                        // runs run()
    telemetryThread = std::thread ([this] { telemetryLoop(); });
}

//==============================================================================
// Accept + read loop
//==============================================================================

void ControlServer::run()
{
    // Bind to localhost only. If this fails, the port is probably in use.
    if (! listener.createListener (port, "127.0.0.1"))
    {
        std::cerr << "[engine] FAILED to listen on 127.0.0.1:" << port << std::endl;
        return;
    }

    // Electron watches stdout for exactly this line to learn we're ready.
    std::cout << "ROCKDJ_ENGINE_LISTENING " << port << std::endl;
    std::cout.flush();

    while (! threadShouldExit())
    {
        // Blocks until a client connects (or the listener is closed on shutdown).
        std::unique_ptr<juce::StreamingSocket> incoming (listener.waitForNextConnection());
        if (incoming == nullptr)
            continue;

        {
            std::lock_guard<std::mutex> lock (connectionMutex);
            connection = std::move (incoming);
        }

        // Greet the client immediately so it knows the engine is alive.
        {
            juce::DynamicObject::Ptr ready (new juce::DynamicObject());
            ready->setProperty ("evt", "ready");
            ready->setProperty ("version", "0.1.0-m3a");
            sendEvent (juce::var (ready.get()));
        }
        sendEvent (buildStatus());

        // Read newline-delimited JSON until the client goes away.
        std::string accumulator;
        char buffer[4096];

        while (! threadShouldExit())
        {
            juce::StreamingSocket* sock = nullptr;
            { std::lock_guard<std::mutex> lock (connectionMutex); sock = connection.get(); }
            if (sock == nullptr || ! sock->isConnected())
                break;

            const int ready = sock->waitUntilReady (true, 200); // read-ready, 200ms
            if (ready < 0) break;          // error
            if (ready == 0) continue;      // timeout, loop and re-check

            const int got = sock->read (buffer, (int) sizeof (buffer), false);
            if (got <= 0) break;           // 0 or -1 → disconnected

            accumulator.append (buffer, (size_t) got);

            // Pull out each complete line.
            size_t newlinePos;
            while ((newlinePos = accumulator.find ('\n')) != std::string::npos)
            {
                std::string line = accumulator.substr (0, newlinePos);
                accumulator.erase (0, newlinePos + 1);
                if (! line.empty())
                    handleLine (juce::String (line));
            }
        }

        // Client disconnected → drop it and go back to accepting.
        {
            std::lock_guard<std::mutex> lock (connectionMutex);
            if (connection != nullptr) { connection->close(); connection.reset(); }
        }
    }
}

//==============================================================================
// Command dispatch
//==============================================================================

static AudioEngine::MidiAction midiActionFromString (const juce::String& a) { return AudioEngine::actionFromString (a); }
static juce::String midiActionToString (AudioEngine::MidiAction a) { return AudioEngine::actionToString (a); }

void ControlServer::handleLine (const juce::String& line)
{
    // Build + send a deck's waveform. Resolution scales with track length
    // (~50 buckets/second) so the zoomed beat-grid view has real detail;
    // clamped so short stingers and hour-long sets both stay sane.
    juce::var msg = juce::JSON::parse (line);
    if (! msg.isObject())
        return;

    const juce::String cmd = msg.getProperty ("cmd", juce::var()).toString();

    if (cmd == "ping")
    {
        juce::DynamicObject::Ptr pong (new juce::DynamicObject());
        pong->setProperty ("evt", "pong");
        pong->setProperty ("id", msg.getProperty ("id", juce::var()));
        sendEvent (juce::var (pong.get()));
    }
    else if (cmd == "getStatus")
    {
        sendEvent (buildStatus());
    }
    else if (cmd == "play")
    {
        engine.play();
    }
    else if (cmd == "pause")
    {
        engine.pause();
    }
    else if (cmd == "stop")
    {
        engine.stop();
    }
    else if (cmd == "seek")
    {
        engine.seek ((double) msg.getProperty ("seconds", 0.0));
    }
    else if (cmd == "loadDeck")
    {
        const int di = (int) msg.getProperty ("deck", 0);
        std::vector<AudioEngine::DeckStemSpec> specs;
        if (auto* arr = msg.getProperty ("stems", juce::var()).getArray())
        {
            for (auto& item : *arr)
            {
                AudioEngine::DeckStemSpec sp;
                sp.filePath = item.getProperty ("path", "").toString();
                sp.name     = item.getProperty ("name", "").toString();
                sp.gain     = (float) (double) item.getProperty ("gain", 1.0);
                sp.muted    = (bool) item.getProperty ("muted", false);
                sp.route    = item.getProperty ("route", "foh").toString().equalsIgnoreCase ("iem")
                                  ? AudioEngine::Route::IEM : AudioEngine::Route::FOH;
                specs.push_back (sp);
            }
        }
        const double loadBpm = (double) msg.getProperty ("bpm", 120.0);

        // Extract saved hot cues from the command (sent by the server from DB)
        std::vector<double> savedHotCues;
        if (auto* hcArr = msg.getProperty ("hotCues", juce::var()).getArray())
            for (auto& v : *hcArr)
                savedHotCues.push_back ((double) v);

        // CRITICAL: loadDeck runs beat detection + file resampling, which can take
        // 1-3 seconds for a full multitrack. Running it inline BLOCKS this socket
        // read loop, and any exception here would KILL the loop and drop the
        // connection — clearing BOTH decks. We run it on a detached worker thread
        // and guard it with try/catch so the read loop keeps servicing the other
        // deck and the connection can never die from a bad file.
        std::thread ([this, di, specs = std::move (specs), loadBpm, savedHotCues = std::move (savedHotCues)]() mutable
        {
            try
            {
                juce::String report;
                const bool ok = engine.loadDeck (di, specs, loadBpm, report);

                juce::DynamicObject::Ptr d (new juce::DynamicObject());
                d->setProperty ("evt", "deckLoaded");
                d->setProperty ("deck", di);
                d->setProperty ("ok", ok);
                d->setProperty ("bpm", engine.getDeckBpm (di));
                d->setProperty ("duration", engine.getDeckDurationSeconds (di));
                juce::Array<juce::var> stemArr;
                for (int i = 0; i < engine.getDeckNumStems (di); ++i)
                {
                    juce::DynamicObject::Ptr sd (new juce::DynamicObject());
                    sd->setProperty ("index", i);
                    sd->setProperty ("name", engine.getDeckStemName (di, i));
                    sd->setProperty ("gain", engine.getDeckStemGain (di, i));
                    sd->setProperty ("muted", engine.getDeckStemMuted (di, i));
                    stemArr.add (juce::var (sd.get()));
                }
                d->setProperty ("stems", stemArr);
                sendEvent (juce::var (d.get()));

                if (ok)
                {
                    // Restore hot cues FIRST — before sendDeckWaveform which can take
                    // hundreds of ms on a 9-stem track. Cues must be live the moment
                    // the client receives deckLoaded, not after the waveform is sent.
                    for (int slot = 0; slot < (int) savedHotCues.size() && slot < 8; ++slot)
                        if (savedHotCues[(size_t) slot] >= 0.0)
                            engine.setHotCueDirect (di, slot, savedHotCues[(size_t) slot]);

                    sendDeckWaveform (di);
                }
                std::cerr << "[engine] " << report;
            }
            catch (const std::exception& e)
            {
                std::cerr << "[engine] loadDeck EXCEPTION: " << e.what() << "\n";
                juce::DynamicObject::Ptr d (new juce::DynamicObject());
                d->setProperty ("evt", "deckLoaded");
                d->setProperty ("deck", di);
                d->setProperty ("ok", false);
                sendEvent (juce::var (d.get()));
            }
            catch (...)
            {
                std::cerr << "[engine] loadDeck UNKNOWN EXCEPTION\n";
            }
        }).detach();
    }
    else if (cmd == "getWaveform")
    {
        // The UI can ask for a deck's waveform at any time (the load-time push
        // is one-shot; this makes the UI self-healing if it ever misses it).
        const int di = (int) msg.getProperty ("deck", 0);
        if (engine.deckLoaded (di))
            sendDeckWaveform (di);
    }
    else if (cmd == "deckPlay")  { engine.deckPlay  ((int) msg.getProperty ("deck", 0)); }
    else if (cmd == "deckPause") { engine.deckPause ((int) msg.getProperty ("deck", 0)); }
    else if (cmd == "deckCue")     { engine.deckCue     ((int) msg.getProperty ("deck", 0)); }
    else if (cmd == "deckCueDown") { engine.deckCueDown ((int) msg.getProperty ("deck", 0)); }
    else if (cmd == "deckCueUp")   { engine.deckCueUp   ((int) msg.getProperty ("deck", 0)); }
    else if (cmd == "setDeckEq")
    {
        engine.setDeckEq ((int) msg.getProperty ("deck", 0),
                          (float) (double) msg.getProperty ("low", 0.0),
                          (float) (double) msg.getProperty ("mid", 0.0),
                          (float) (double) msg.getProperty ("high", 0.0));
    }
    else if (cmd == "setDeckFilter")
    {
        engine.setDeckFilter ((int) msg.getProperty ("deck", 0),
                              (float) (double) msg.getProperty ("position", 0.0));
    }
    else if (cmd == "cycleDeckTempoRange")
        engine.cycleDeckTempoRange ((int) msg.getProperty ("deck", 0));
    else if (cmd == "setDeckBpm")
        engine.setDeckBpm ((int) msg.getProperty ("deck", 0), (double) msg.getProperty ("bpm", 120.0));
    else if (cmd == "setDeckFxOn")
        engine.setDeckFxOn ((int) msg.getProperty ("deck", 0), (bool) msg.getProperty ("on", false));
    else if (cmd == "setDeckFxMode")
        engine.setDeckFxMode ((int) msg.getProperty ("deck", 0), (int) msg.getProperty ("mode", 0));
    else if (cmd == "setDeckFxDepth")
        engine.setDeckFxDepth ((int) msg.getProperty ("deck", 0),
                               (float) (double) msg.getProperty ("depth", 0.0));
    else if (cmd == "setDeckTempoRange")
        engine.setDeckTempoRange ((int) msg.getProperty ("deck", 0), (int) msg.getProperty ("range", 8));
    else if (cmd == "setDeckRate")
    {
        engine.setDeckRate ((int) msg.getProperty ("deck", 0),
                            (double) msg.getProperty ("rate", 1.0));
    }
    else if (cmd == "deckSync")    { engine.deckSync ((int) msg.getProperty ("deck", 0)); }
    else if (cmd == "setHotCue")
        engine.setHotCue ((int) msg.getProperty ("deck", 0), (int) msg.getProperty ("slot", 0));
    else if (cmd == "jumpHotCue")
        engine.jumpHotCue ((int) msg.getProperty ("deck", 0), (int) msg.getProperty ("slot", 0));
    else if (cmd == "deleteHotCue")
        engine.deleteHotCue ((int) msg.getProperty ("deck", 0), (int) msg.getProperty ("slot", 0));
    else if (cmd == "deckLoopIn")   { engine.deckLoopIn   ((int) msg.getProperty ("deck", 0)); }
    else if (cmd == "deckLoopOut")  { engine.deckLoopOut  ((int) msg.getProperty ("deck", 0)); }
    else if (cmd == "deckLoopExit") { engine.deckLoopExit ((int) msg.getProperty ("deck", 0)); }
    else if (cmd == "deckReloop")   { engine.deckReloop   ((int) msg.getProperty ("deck", 0)); }
    else if (cmd == "deckLoopBeats")
        engine.deckLoopBeats ((int) msg.getProperty ("deck", 0), (double) msg.getProperty ("beats", 4.0));
    else if (cmd == "setOutputRouting")
    {
        AudioEngine::OutputRouting r;
        r.fohL = (int) msg.getProperty ("fohL", 0);  r.fohR = (int) msg.getProperty ("fohR", 1);
        r.iemL = (int) msg.getProperty ("iemL", 2);  r.iemR = (int) msg.getProperty ("iemR", 3);
        r.cueL = (int) msg.getProperty ("cueL", -1); r.cueR = (int) msg.getProperty ("cueR", -1);
        r.deckAL = (int) msg.getProperty ("deckAL", -1); r.deckAR = (int) msg.getProperty ("deckAR", -1);
        r.deckBL = (int) msg.getProperty ("deckBL", -1); r.deckBR = (int) msg.getProperty ("deckBR", -1);
        engine.setOutputRouting (r);
        engine.saveSettings();
    }
    else if (cmd == "setDeckCue")
        engine.setDeckCueEnabled ((int) msg.getProperty ("deck", 0), (bool) msg.getProperty ("on", false));
    else if (cmd == "setMasterCue")
        engine.setMasterCueEnabled ((bool) msg.getProperty ("on", false));
    else if (cmd == "setDeckDirectRoute")
    {
        const int deck = (int) msg.getProperty ("deck", 0);
        const int L    = (int) msg.getProperty ("L", -1) - 1; // 1-based from UI, -1=none
        const int R    = (int) msg.getProperty ("R", -1) - 1;
        engine.setDeckDirectRoute (deck, L, R);
    }
    else if (cmd == "deckJog")
        engine.deckJog ((int) msg.getProperty ("deck", 0), (double) msg.getProperty ("ticks", 0.0));
    else if (cmd == "setJogSensitivity")
    {
        engine.setJogSensitivity ((double) msg.getProperty ("nudge", 0.004),
                                  (double) msg.getProperty ("search", 0.006),
                                  (double) msg.getProperty ("decay", 0.070));
        engine.saveSettings();
    }
    else if (cmd == "listAudioOutputs")
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("evt", "audioOutputs");
        juce::Array<juce::var> arr;
        for (const auto& n : engine.listAudioOutputDevices())
            arr.add (n);
        o->setProperty ("devices", arr);
        o->setProperty ("current", engine.getDeviceName());
        o->setProperty ("sampleRate", engine.getDeviceSampleRate());
        o->setProperty ("outputs", engine.getNumOutputChannels());
        sendEvent (juce::var (o));
    }
    else if (cmd == "link.enable")
        link.setEnabled ((bool) msg.getProperty ("enabled", false));
    else if (cmd == "link.setQuantum")
        link.setQuantum ((double) msg.getProperty ("quantum", 4.0));
    else if (cmd == "link.setStartStop")
        link.setStartStopSync ((bool) msg.getProperty ("enabled", false));
    else if (cmd == "link.setPolicy")
    {
        const juce::String pol = msg.getProperty ("policy", "accept").toString();
        LinkService::TempoPolicy p = LinkService::TempoPolicy::AcceptExternal;
        if (pol == "warn")    p = LinkService::TempoPolicy::WarnExternal;
        if (pol == "restore") p = LinkService::TempoPolicy::RestoreOnce;
        if (pol == "lock")    p = LinkService::TempoPolicy::LockLocal;
        link.setTempoPolicy (p);
    }
    else if (cmd == "link.snapshot")
    {
        const auto snap = link.snapshotLink();
        juce::DynamicObject::Ptr d (new juce::DynamicObject());
        d->setProperty ("evt",         "linkSnapshot");
        d->setProperty ("enabled",     snap.enabled);
        d->setProperty ("healthy",     snap.healthy);
        d->setProperty ("peers",       snap.peers);
        d->setProperty ("tempo",       snap.tempo);
        d->setProperty ("beat",        snap.beat);
        d->setProperty ("phase",       snap.phase);
        d->setProperty ("quantum",     snap.quantum);
        d->setProperty ("playing",     snap.playing);
        d->setProperty ("timestamp",   snap.timestamp);
        d->setProperty ("tempoSource", juce::String (snap.tempoSource));
        sendEvent (juce::var (d.get()));
    }
        else if (cmd == "midiOpenOut")
    {
        const juce::String err = engine.openMidiOutputDevice (
            msg.getProperty ("device", "").toString());
        auto* r = new juce::DynamicObject();
        r->setProperty ("evt", "midiOutStatus");
        r->setProperty ("ok",  err.isEmpty());
        r->setProperty ("err", err);
        sendEvent (juce::var (r));
    }
    else if (cmd == "midiListOut")
    {
        auto* r = new juce::DynamicObject();
        r->setProperty ("evt", "midiOutDevices");
        juce::Array<juce::var> arr;
        for (const auto& n : engine.getMidiOutputDevices()) arr.add (n);
        r->setProperty ("devices", arr);
        sendEvent (juce::var (r));
    }
    else if (cmd == "sendMidiOut")
        engine.sendMidiOut ((int) msg.getProperty ("status", 0x90),
                            (int) msg.getProperty ("data1",  0),
                            (int) msg.getProperty ("data2",  0));
    // LED feedback: send MIDI back to the controller for button/pad LEDs.
    // Fires every time the DJ presses play, cue, or sets a hot cue.
    else if (cmd == "ledFeedback")
    {
        const int deck  = (int) msg.getProperty ("deck", 0);
        const int note  = (int) msg.getProperty ("note", 0);
        const int vel   = (int) msg.getProperty ("vel",  0);
        const int ch    = deck == 0 ? 1 : 2;  // ch1 = deck1, ch2 = deck2
        engine.sendMidiOut (0x90 + (ch - 1), note, vel);
    }
    else if (cmd == "setMasterGain")
        engine.setMasterGain ((float)(double) msg.getProperty ("gain", 1.0));
    else if (cmd == "setDeckTrim")
        engine.setDeckTrim ((int) msg.getProperty ("deck", 0),
                            (float)(double) msg.getProperty ("db", 0.0));
    else if (cmd == "setAudioOutput")
    {
        const juce::String e = engine.setAudioOutputDevice (msg.getProperty ("device", "").toString());
        auto* o = new juce::DynamicObject();
        o->setProperty ("evt", "audioOutputSet");
        o->setProperty ("device", engine.getDeviceName());
        o->setProperty ("sampleRate", engine.getDeviceSampleRate());
        o->setProperty ("outputs", engine.getNumOutputChannels());
        o->setProperty ("error", e);
        sendEvent (juce::var (o));
    }
    else if (cmd == "setDeckXfAssign")
        engine.setDeckXfAssign ((int) msg.getProperty ("deck", 0),
                                (AudioEngine::XfAssign) (int) msg.getProperty ("assign", 1));
    else if (cmd == "setDeckMasterTempo")
        engine.setDeckMasterTempo ((int) msg.getProperty ("deck", 0), (bool) msg.getProperty ("on", true));
    else if (cmd == "setAutoMaster")
        engine.setAutoMaster ((bool) msg.getProperty ("on", true));
    else if (cmd == "setCueGain")
        engine.setCueGain ((float) (double) msg.getProperty ("gain", 1.0));
    else if (cmd == "midiOpen")
    {
        juce::String e;
        if (const auto* arr = msg.getProperty ("devices", juce::var()).getArray())
        {
            juce::StringArray names;
            for (const auto& v : *arr) names.add (v.toString());
            e = engine.openMidiDevices (names);
        }
        else
        {
            e = engine.openMidiDevice (msg.getProperty ("device", "").toString());
        }
        engine.saveSettings();
        auto* o = new juce::DynamicObject();
        o->setProperty ("evt", "midiOpened");
        o->setProperty ("device", engine.getOpenMidiDevice());
        o->setProperty ("error", e);
        sendEvent (juce::var (o));
    }
    else if (cmd == "midiInject")
        engine.injectMidi ((int) msg.getProperty ("status", 0x90), (int) msg.getProperty ("channel", 1),
                           (int) msg.getProperty ("data1", 0), (int) msg.getProperty ("data2", 127));
    else if (cmd == "getDjSettings")
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("evt", "djSettings");
        auto r = engine.getOutputRouting();
        auto* ro = new juce::DynamicObject();
        ro->setProperty ("fohL", r.fohL); ro->setProperty ("fohR", r.fohR);
        ro->setProperty ("iemL", r.iemL); ro->setProperty ("iemR", r.iemR);
        ro->setProperty ("cueL", r.cueL); ro->setProperty ("cueR", r.cueR);
        ro->setProperty ("deckAL", r.deckAL); ro->setProperty ("deckAR", r.deckAR);
        ro->setProperty ("deckBL", r.deckBL); ro->setProperty ("deckBR", r.deckBR);
        o->setProperty ("routing", juce::var (ro));
        auto* jo = new juce::DynamicObject();
        jo->setProperty ("nudge", engine.getJogNudge());
        jo->setProperty ("search", engine.getJogSearch());
        jo->setProperty ("decay", engine.getJogDecay());
        o->setProperty ("jog", juce::var (jo));
        juce::Array<juce::var> arr;
        for (const auto& b : engine.getMidiBindings())
        {
            auto* bo = new juce::DynamicObject();
            bo->setProperty ("status", b.status);
            bo->setProperty ("channel", b.channel);
            bo->setProperty ("data1", b.data1);
            bo->setProperty ("action", midiActionToString (b.action));
            bo->setProperty ("deck", b.deck);
            bo->setProperty ("param", b.param);
            bo->setProperty ("relMode", b.relMode);
            bo->setProperty ("bit14", b.bit14);
            arr.add (juce::var (bo));
        }
        o->setProperty ("bindings", arr);
        o->setProperty ("midiDevice", engine.getOpenMidiDevice());
        sendEvent (juce::var (o));
    }
    else if (cmd == "setLibraryScrollDiv")
    {
        const int d = juce::jlimit (1, 32, (int) msg.getProperty ("div", 4));
        libraryScrollDiv.store (d);
    }
    else if (cmd == "clearMidiBindings")
    {
        engine.setMidiBindings ({});
        engine.saveSettings();
        auto* o = new juce::DynamicObject();
        o->setProperty ("evt", "midiBindingsSet");
        o->setProperty ("count", 0);
        sendEvent (juce::var (o));
    }
    else if (cmd == "midiList")
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("evt", "midiDevices");
        juce::Array<juce::var> arr;
        for (const auto& n : engine.getMidiDevices()) arr.add (n);
        o->setProperty ("devices", arr);
        o->setProperty ("open", engine.getOpenMidiDevice());
        sendEvent (juce::var (o));
    }
    else if (cmd == "setMidiBindings")
    {
        std::vector<AudioEngine::MidiBinding> out;
        if (const auto* arr = msg.getProperty ("bindings", juce::var()).getArray())
            for (const auto& v : *arr)
            {
                AudioEngine::MidiBinding b;
                b.status  = (int) v.getProperty ("status", 0);
                b.channel = (int) v.getProperty ("channel", 0);
                b.data1   = (int) v.getProperty ("data1", 0);
                b.deck    = (int) v.getProperty ("deck", 0);
                b.param   = (double) v.getProperty ("param", 0.0);
                b.action  = midiActionFromString (v.getProperty ("action", "").toString());
                b.relMode = (int) v.getProperty ("relMode", 0);
                b.bit14   = (bool) v.getProperty ("bit14", false);
                out.push_back (b);
            }
        engine.setMidiBindings (out);
        engine.saveSettings();
        auto* o = new juce::DynamicObject();
        o->setProperty ("evt", "midiBindingsSet");
        o->setProperty ("count", (int) out.size());
        sendEvent (juce::var (o));
    }
    else if (cmd == "deckLoopScale")
        engine.deckLoopScale ((int) msg.getProperty ("deck", 0), (double) msg.getProperty ("factor", 2.0));
    else if (cmd == "deckSeek")  { engine.deckSeek  ((int) msg.getProperty ("deck", 0),
                                                     (double) msg.getProperty ("seconds", 0.0)); }
    else if (cmd == "setDeckGain") { engine.setDeckGain ((int) msg.getProperty ("deck", 0),
                                                         (float) (double) msg.getProperty ("gain", 1.0)); }
    else if (cmd == "setCrossfader") { engine.setCrossfader ((float) (double) msg.getProperty ("position", 0.5)); }
    else if (cmd == "setMasterDeck") { engine.setMasterDeck ((int) msg.getProperty ("deck", 0)); }
    // THE HIDDEN GEM: live stem control of the DJ's playing track.
    else if (cmd == "setDeckStem")
    {
        const int di = (int) msg.getProperty ("deck", 0);
        const int si = (int) msg.getProperty ("stem", -1);
        if (msg.hasProperty ("gain"))  engine.setDeckStemGain (di, si, (float) (double) msg.getProperty ("gain", 1.0));
        if (msg.hasProperty ("muted")) engine.setDeckStemMute (di, si, (bool) msg.getProperty ("muted", false));
        if (msg.hasProperty ("route"))
            engine.setDeckStemRoute (di, si, msg.getProperty ("route", "foh").toString().equalsIgnoreCase ("iem")
                                                 ? AudioEngine::Route::IEM : AudioEngine::Route::FOH);
    }
    else if (cmd == "setBpm")
    {
        engine.setBpm ((double) msg.getProperty ("bpm", 120.0));
    }
    else if (cmd == "setDjBpm")
    {
        engine.setDjBpm ((double) msg.getProperty ("bpm", 120.0));
    }
    else if (cmd == "setDjRunning")
    {
        engine.setDjRunning ((bool) msg.getProperty ("running", false));
    }
    else if (cmd == "tapDownbeat")
    {
        engine.tapDownbeat();
    }
    else if (cmd == "armHandoff")
    {
        const juce::String target = msg.getProperty ("target", "rockdj").toString();
        const double boundary = (double) msg.getProperty ("boundaryBeats", 4.0);
        engine.armHandoff (target.equalsIgnoreCase ("dj") ? AudioEngine::Authority::DjMaster
                                                          : AudioEngine::Authority::RockdjMaster,
                           boundary);
    }
    else if (cmd == "cancelHandoff")
    {
        engine.cancelHandoff();
    }
    else if (cmd == "armLaunch")
    {
        engine.armLaunch ((double) msg.getProperty ("boundaryBeats", 4.0));
    }
    else if (cmd == "cancelLaunch")
    {
        engine.cancelLaunch();
    }
    else if (cmd == "setStem")
    {
        const int idx = (int) msg.getProperty ("index", -1);
        if (msg.hasProperty ("gain"))  engine.setStemGain (idx, (float) (double) msg.getProperty ("gain", 1.0));
        if (msg.hasProperty ("muted")) engine.setStemMute (idx, (bool) msg.getProperty ("muted", false));
        if (msg.hasProperty ("route"))
            engine.setStemRoute (idx, msg.getProperty ("route", "foh").toString().equalsIgnoreCase ("iem")
                                          ? AudioEngine::Route::IEM : AudioEngine::Route::FOH);
    }
    else if (cmd == "loadSong")
    {
        std::vector<AudioEngine::StemSpec> specs;
        if (auto* arr = msg.getProperty ("stems", juce::var()).getArray())
        {
            for (auto& item : *arr)
            {
                AudioEngine::StemSpec spec;
                spec.filePath = item.getProperty ("path", "").toString();
                spec.name     = item.getProperty ("name", "").toString();
                spec.gain     = (float) (double) item.getProperty ("gain", 1.0);
                spec.muted    = (bool) item.getProperty ("muted", false);
                spec.route    = item.getProperty ("route", "foh").toString().equalsIgnoreCase ("iem")
                                    ? AudioEngine::Route::IEM : AudioEngine::Route::FOH;
                specs.push_back (spec);
            }
        }
        const juce::var songIdVar = msg.getProperty ("songId", juce::var());

        // Run on a detached thread — loadSong takes 60ms (sleep) + file I/O + resampling.
        // Keeping it on the message loop thread would block ALL subsequent commands
        // and, critically, would race with the audio callback on the stems vector.
        std::thread ([this, specs = std::move (specs), songIdVar]() mutable
        {
            try
            {
                juce::String report;
                const bool ok = engine.loadSong (specs, report);

                juce::DynamicObject::Ptr loaded (new juce::DynamicObject());
                loaded->setProperty ("evt",      "loaded");
                loaded->setProperty ("ok",       ok);
                loaded->setProperty ("stems",    engine.getNumStems());
                loaded->setProperty ("duration", engine.getDurationSeconds());
                loaded->setProperty ("songId",   songIdVar);
                sendEvent (juce::var (loaded.get()));
                std::cerr << "[engine] loadSong: " << report << std::endl;
            }
            catch (const std::exception& e)
            {
                std::cerr << "[engine] loadSong EXCEPTION: " << e.what() << "\n";
            }
            catch (...)
            {
                std::cerr << "[engine] loadSong UNKNOWN EXCEPTION\n";
            }
        }).detach();
    }
    else
    {
        // Unknown command. Acknowledge clearly rather than silently dropping it.
        juce::DynamicObject::Ptr err (new juce::DynamicObject());
        err->setProperty ("evt", "error");
        err->setProperty ("message", "unknown command: " + cmd);
        sendEvent (juce::var (err.get()));
    }
}

//==============================================================================
// Sending
//==============================================================================

void ControlServer::sendDeckWaveform (int di)
{
    const double dur = engine.getDeckDurationSeconds (di);
    const int numBuckets = juce::jlimit (1600, 20000, (int) std::lround (dur * 50.0));
    std::vector<float> peaks;
    engine.getDeckWaveform (di, peaks, numBuckets);
    juce::Array<juce::var> arr;
    for (float pk : peaks) arr.add ((int) std::lround (pk * 100.0f));
    juce::DynamicObject::Ptr w (new juce::DynamicObject());
    w->setProperty ("evt", "deckWaveform");
    w->setProperty ("deck", di);
    w->setProperty ("peaks", arr);
    w->setProperty ("duration", dur);
    w->setProperty ("bpm", engine.getDeckBpm (di));
    w->setProperty ("downbeat", engine.getDeckDownbeatSeconds (di));
    sendEvent (juce::var (w.get()));
}

void ControlServer::sendEvent (const juce::var& message)
{
    const juce::String json = juce::JSON::toString (message, true) + "\n"; // compact + newline

    std::lock_guard<std::mutex> lock (writeMutex);
    std::lock_guard<std::mutex> clock (connectionMutex);
    if (connection != nullptr && connection->isConnected())
    {
        const auto utf8 = json.toRawUTF8();
        connection->write (utf8, (int) std::strlen (utf8));
    }
}

juce::var ControlServer::buildStatus() const
{
    juce::DynamicObject::Ptr s (new juce::DynamicObject());
    s->setProperty ("evt", "status");
    s->setProperty ("device", engine.getDeviceName());
    s->setProperty ("outputs", engine.getNumOutputChannels());
    s->setProperty ("sampleRate", (int) engine.getDeviceSampleRate());
    s->setProperty ("playing", engine.isPlaying());
    s->setProperty ("readyForRouting", engine.getNumOutputChannels() >= 4);
    return juce::var (s.get());
}

void ControlServer::telemetryLoop()
{
    // ~30 Hz playhead stream while connected, so the app clock and companion
    // sync run off the engine's authoritative playhead. Device status is sent
    // once a second (it changes rarely).
    int tick = 0;
    while (running.load())
    {
        bool haveClient = false;
        { std::lock_guard<std::mutex> lock (connectionMutex);
          haveClient = (connection != nullptr && connection->isConnected()); }

        if (haveClient)
        {
            const auto ms = engine.getMusicalState();
            auto authorityName = [] (AudioEngine::Authority a) -> const char*
            {
                switch (a)
                {
                    case AudioEngine::Authority::DjMaster:      return "dj";
                    case AudioEngine::Authority::HandoffArmed:  return "handoff";
                    case AudioEngine::Authority::RockdjMaster:  return "rockdj";
                }
                return "rockdj";
            };

            juce::DynamicObject::Ptr p (new juce::DynamicObject());
            p->setProperty ("evt", "playhead");
            p->setProperty ("seconds", engine.getPlayheadSeconds());
            p->setProperty ("samples", (juce::int64) engine.getPlayheadSamples());
            p->setProperty ("duration", engine.getDurationSeconds());
            p->setProperty ("playing", engine.isPlaying());
            // Clock authority + musical position (DJ-integration).
            p->setProperty ("authority", authorityName (ms.authority));
            p->setProperty ("handoffTarget", authorityName (ms.handoffTarget));
            p->setProperty ("bpm", ms.bpm);
            link.setTempo (ms.bpm);
            p->setProperty ("bar", ms.bar);
            p->setProperty ("beat", ms.beat);
            p->setProperty ("phase", ms.phase);
            p->setProperty ("djRunning", ms.djRunning);
            p->setProperty ("beatsUntilHandoff", ms.beatsUntilHandoff);
            p->setProperty ("beatsUntilLaunch", ms.beatsUntilLaunch);
            // DJ deck state (A and B) + mixer.
            for (int di = 0; di < AudioEngine::kNumDecks; ++di)
            {
                const juce::String k = di == 0 ? "deckA" : "deckB";
                p->setProperty (k + "Playing",  engine.isDeckPlaying (di));
                p->setProperty (k + "Loaded",   engine.deckLoaded (di));
                p->setProperty (k + "Seconds",  engine.getDeckSeconds (di));
                p->setProperty (k + "Duration", engine.getDeckDurationSeconds (di));
                p->setProperty (k + "Bpm",      engine.getDeckBpm (di));
                p->setProperty (k + "Cue",        engine.getDeckCueSeconds (di));
                p->setProperty (k + "CuePreview", engine.isDeckCuePreviewing (di));
                p->setProperty (k + "Downbeat", engine.getDeckDownbeatSeconds (di));
                p->setProperty (k + "Rate",       engine.getDeckRate (di));
                p->setProperty (k + "TempoRange", engine.getDeckTempoRange (di));
                p->setProperty (k + "EqLow",    engine.getDeckEqLow (di));
                p->setProperty (k + "EqMid",    engine.getDeckEqMid (di));
                p->setProperty (k + "EqHigh",   engine.getDeckEqHigh (di));
                p->setProperty (k + "Filter",   engine.getDeckFilter (di));
                p->setProperty (k + "Looping",    engine.isDeckLooping (di));
                p->setProperty (k + "LoopStart",  engine.getDeckLoopStartSeconds (di));
                p->setProperty (k + "LoopEnd",    engine.getDeckLoopEndSeconds (di));
                p->setProperty (k + "LoopBeats",  engine.getDeckLoopBeats (di));
                p->setProperty (k + "CueEnabled", engine.isDeckCueEnabled (di));
                p->setProperty (k + "JogBend",    engine.getDeckJogBend (di));
                p->setProperty (k + "Gain",       engine.getDeckGain (di));
                p->setProperty (k + "Trim",       engine.getDeckTrim (di));
                p->setProperty (k + "XfAssign",   (int) engine.getDeckXfAssign (di));
                p->setProperty (k + "Audible",    engine.getDeckAudibleLevel (di));
                p->setProperty (k + "MasterTempo", engine.getDeckMasterTempo (di));
                p->setProperty (k + "FxOn",        engine.getDeckFxOn (di));
                p->setProperty (k + "FxDepth",     engine.getDeckFxDepth (di));
                p->setProperty (k + "FxMode",      engine.getDeckFxMode (di));
                p->setProperty (k + "Peak",        engine.getDeckPeak (di));
                juce::Array<juce::var> hc;
                for (int h = 0; h < AudioEngine::Deck::kNumHotCues; ++h)
                    hc.add (engine.getHotCueSeconds (di, h));
                p->setProperty (k + "HotCues", hc);
            }
            p->setProperty ("masterDeck", engine.getMasterDeck());
    p->setProperty ("masterGain", engine.getMasterGain());
    p->setProperty ("masterPeak", engine.getMasterPeak());
    p->setProperty ("masterCue", engine.getMasterCueEnabled());
    // ── Ableton Link snapshot (low cost — just reads atomics) ──
    {
        const auto lsnap = link.snapshotLink();
        p->setProperty ("linkEnabled",     lsnap.enabled);
        p->setProperty ("linkPeers",       lsnap.peers);
        p->setProperty ("linkTempo",       lsnap.tempo);
        p->setProperty ("linkBeat",        lsnap.beat);
        p->setProperty ("linkPhase",       lsnap.phase);
        p->setProperty ("linkQuantum",     lsnap.quantum);
        p->setProperty ("linkPlaying",     lsnap.playing);
        p->setProperty ("linkTempoSource", juce::String (lsnap.tempoSource));
    }
            p->setProperty ("autoMaster", engine.isAutoMaster());
            p->setProperty ("crossfader", engine.getCrossfader());
            // Live stem state per deck (drives the Band Master mixer UI).
            for (int di = 0; di < AudioEngine::kNumDecks; ++di)
            {
                juce::Array<juce::var> stemArr;
                for (int i = 0; i < engine.getDeckNumStems (di); ++i)
                {
                    juce::DynamicObject::Ptr sd (new juce::DynamicObject());
                    sd->setProperty ("index", i);
                    sd->setProperty ("name", engine.getDeckStemName (di, i));
                    sd->setProperty ("gain", engine.getDeckStemGain (di, i));
                    sd->setProperty ("muted", engine.getDeckStemMuted (di, i));
                    sd->setProperty ("route", engine.isDeckStemIem (di, i) ? "iem" : "foh");
                    stemArr.add (juce::var (sd.get()));
                }
                p->setProperty (di == 0 ? "deckAStems" : "deckBStems", stemArr);
            }
            sendEvent (juce::var (p.get()));

            if (++tick >= 30) { tick = 0; sendEvent (buildStatus()); }
        }

        std::this_thread::sleep_for (std::chrono::milliseconds (33));
    }
}
