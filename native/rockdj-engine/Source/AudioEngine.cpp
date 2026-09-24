/*
  AudioEngine.cpp - see AudioEngine.h for the big-picture explanation.
*/

#include "AudioEngine.h"
#include "BeatDetector.h"
#include <cmath>
#include <iostream>
#include <functional>

// A tiny juce::Thread subclass that repeatedly calls a std::function. Used for
// the musical clock so authority handoffs / quantized launches fire promptly.
namespace
{
    class FnThread : public juce::Thread
    {
    public:
        FnThread (std::function<void()> fn, int intervalMs)
            : juce::Thread ("rockdj-clock"), tick (std::move (fn)), interval (intervalMs) {}
        void run() override
        {
            while (! threadShouldExit())
            {
                tick();
                wait (interval);
            }
        }
    private:
        std::function<void()> tick;
        int interval;
    };
}

AudioEngine::AudioEngine()
{
    formatManager.registerBasicFormats(); // enables WAV / AIFF / FLAC readers

    // Musical clock thread: advances the DJ grid and fires armed handoffs /
    // launches with ~5 ms resolution. (Sample-accurate launch is a later refinement.)
    clockThread = std::make_unique<FnThread> ([this] { clockTick(); }, 5);
    clockThread->startThread();
}

AudioEngine::~AudioEngine()
{
    if (clockThread != nullptr)
    {
        clockThread->signalThreadShouldExit();
        clockThread->stopThread (1000);
        clockThread.reset();
    }
    deviceManager.removeAudioCallback (this);
    deviceManager.closeAudioDevice();
}

//==============================================================================
// Device lifecycle
//==============================================================================

juce::String AudioEngine::initialise()
{
    // Ask for 0 inputs and 4 outputs. If the current default device only has 2
    // outputs, macOS will still open it with 2 - the user then picks the
    // Focusrite in the device selector to unlock outputs 3-4.
    const int numInputsWanted  = 0;
    // Ask for 8: a 4-out Scarlett still opens with 4, but a macOS Aggregate
    // Device (Scarlett + built-in) exposes 6+, which the routing can then use.
    const int numOutputsWanted = 8;

    juce::String err = deviceManager.initialise (numInputsWanted,
                                                 numOutputsWanted,
                                                 nullptr,   // no saved state
                                                 true);     // select a default device
    if (err.isNotEmpty())
        return err;

    // macOS often hands us the built-in speakers (2 outputs) as the default.
    // Actively switch to a Focusrite/Scarlett if one is present, so the engine
    // always locks onto the real interface even if the system default changes.
    preferMultiOutputDevice();

    deviceManager.addAudioCallback (this);
    return {};
}

void AudioEngine::preferMultiOutputDevice()
{
    // If the current device already exposes 4+ outputs, it's fine — keep it.
    if (auto* dev = deviceManager.getCurrentAudioDevice())
        if (dev->getOutputChannelNames().size() >= 4)
            return;

    // Build the list of name-fragments to look for. An explicit preference wins;
    // otherwise default to the usual Focusrite product names.
    juce::StringArray keywords;
    if (preferredOutputName.isNotEmpty())
        keywords.add (preferredOutputName);
    else
        keywords.addArray ({ "scarlett", "focusrite", "clarett" });

    for (auto* type : deviceManager.getAvailableDeviceTypes())
    {
        type->scanForDevices();
        for (const auto& name : type->getDeviceNames (false)) // false = outputs
        {
            bool matches = false;
            for (const auto& kw : keywords)
                if (name.containsIgnoreCase (kw)) { matches = true; break; }
            if (! matches)
                continue;

            juce::AudioDeviceManager::AudioDeviceSetup setup;
            deviceManager.getAudioDeviceSetup (setup);
            setup.outputDeviceName        = name;
            setup.useDefaultOutputChannels = true;
            const juce::String e = deviceManager.setAudioDeviceSetup (setup, true);
            if (e.isEmpty())
            {
                std::cerr << "[engine] selected preferred output: " << name << std::endl;
                return;
            }
        }
    }
}

juce::String AudioEngine::getDeviceName() const
{
    if (auto* dev = deviceManager.getCurrentAudioDevice())
        return dev->getName();
    return "none";
}

juce::StringArray AudioEngine::listAudioOutputDevices() const
{
    juce::StringArray names;
    auto& dm = const_cast<juce::AudioDeviceManager&> (deviceManager);
    for (auto* type : dm.getAvailableDeviceTypes())
    {
        type->scanForDevices();
        for (const auto& n : type->getDeviceNames (false))
            names.add (n);
    }
    return names;
}

juce::String AudioEngine::setAudioOutputDevice (const juce::String& name)
{
    auto setup = deviceManager.getAudioDeviceSetup();
    setup.outputDeviceName = name;
    setup.useDefaultOutputChannels = true;
    const juce::String err = deviceManager.setAudioDeviceSetup (setup, true);
    if (err.isEmpty())
    {
        std::cerr << "[engine] switched audio output to: " << name << std::endl;
        preferredOutputName = name;
        saveSettings();           // persist so a restart comes back on the right device
    }
    return err;
}

void AudioEngine::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    // Capture the real hardware sample rate and channel count. All our musical
    // maths (samples-per-bar etc.) depends on the true device sample rate.
    currentSampleRate.store (device->getCurrentSampleRate());
    numOutputs.store (device->getActiveOutputChannels().countNumberOfSetBits());

    // Size the per-deck FOH scratch bus generously (never allocate in the audio
    // callback) and reset all EQ/filter state for the new sample rate.
    const int scratch = juce::jmax (8192, device->getCurrentBufferSizeSamples() * 4);
    deckBus.setSize (2, scratch);
    iemBus.setSize (2, scratch);
    stretchOut.setSize (2, scratch);
    // Echo line: pre-sized for 8 beats at 60 BPM so we never allocate on the
    // audio thread. At 44.1kHz that's 8 * 60/60 * 44100 = 352800 samples.
    const int echoLen = (int) (8.0 * currentSampleRate.load()) + 512;  // 8s max delay
    for (int di = 0; di < kNumDecks; ++di)
    {
        Deck& d = decks[di];
        d.echoL.assign ((size_t) echoLen, 0.0f);
        d.echoR.assign ((size_t) echoLen, 0.0f);
        d.echoWritePos = 0;
        // Reverb comb and allpass lines (scaled to current sample rate vs design 44100)
        const double ratio = currentSampleRate.load() / 44100.0;
        for (int k = 0; k < 4; ++k)
        {
            const int sz = (int) (Deck::kCombSizes[k] * ratio);
            d.combL[k].b.assign ((size_t) sz, 0.0f); d.combL[k].pos = 0;
            d.combR[k].b.assign ((size_t) sz, 0.0f); d.combR[k].pos = 0;
        }
        for (int k = 0; k < 2; ++k)
        {
            const int sz = (int) (Deck::kApSizes[k] * ratio);
            d.apL[k].b.assign ((size_t) sz, 0.0f); d.apL[k].pos = 0;
            d.apR[k].b.assign ((size_t) sz, 0.0f); d.apR[k].pos = 0;
        }
    }
    posBuf.assign ((size_t) scratch, 0.0);

    const double sr = currentSampleRate.load();
    for (int di = 0; di < kNumDecks; ++di)
    {
        Deck& d = decks[di];
        d.stretchFoh.presetDefault (2, (float) sr);
        d.stretchIem.presetDefault (2, (float) sr);
        d.stretchFoh.reset();
        d.stretchIem.reset();
        d.stretchPrimed = false;
        d.lastEndPos = -1.0;
    }
    // outputSeek() needs inputLatency + outputLatency samples of pre-roll.
    const int seekLen = juce::jmax (1, decks[0].stretchFoh.outputSeekLength (1.0f)) + 8;
    preRollFoh.setSize (2, seekLen);
    preRollIem.setSize (2, seekLen);

    // Warm the stretchers up so their internal temporaries stop reallocating:
    // process() resizes a scratch vector, and we must never allocate mid-gig.
    {
        juce::AudioBuffer<float> warm (2, scratch);
        warm.clear();
        float* wp[2] = { warm.getWritePointer (0), warm.getWritePointer (1) };
        const int blk = juce::jmax (64, device->getCurrentBufferSizeSamples());
        for (int di = 0; di < kNumDecks; ++di)
            for (int i = 0; i < 8; ++i)
            {
                decks[di].stretchFoh.process (wp, blk, wp, blk);
                decks[di].stretchIem.process (wp, blk, wp, blk);
            }
        for (int di = 0; di < kNumDecks; ++di)
        { decks[di].stretchFoh.reset(); decks[di].stretchIem.reset(); }
    }
    for (int di = 0; di < kNumDecks; ++di)
    {
        decks[di].eqLow.reset(); decks[di].eqMid.reset();
        decks[di].eqHigh.reset(); decks[di].filter.reset();
        decks[di].eqDirty.store (true);
    }
}

void AudioEngine::audioDeviceStopped()
{
    // Device went away (e.g. USB unplugged). Halt transport so we don't keep
    // advancing the playhead into silence. Milestone 1-follow-up will add
    // automatic re-open; for the spike we surface it and stop cleanly.
    playing.store (false);
}

//==============================================================================
// Loading
//==============================================================================

bool AudioEngine::loadStemsFromFolder (const juce::File& folder, juce::String& report)
{
    stop();
    stems.clear();

    auto files = folder.findChildFiles (juce::File::findFiles, false,
                                        "*.wav;*.aiff;*.aif;*.flac");
    files.sort();

    const double deviceSR = currentSampleRate.load();

    for (auto& f : files)
    {
        std::unique_ptr<juce::AudioFormatReader> reader (formatManager.createReaderFor (f));
        if (reader == nullptr)
        {
            report << "  SKIPPED (unreadable): " << f.getFileName() << "\n";
            continue;
        }

        auto s = std::make_unique<Stem>();
        s->name = f.getFileName();

        const int numCh  = (int) reader->numChannels;
        const int numLen = (int) reader->lengthInSamples;

        // Decode the ENTIRE file into RAM. For live use this is deliberate:
        // random access is instant and there is zero disk jitter mid-song.
        // Cost: memory. A 4-minute stereo 48k WAV is ~90 MB. Noted in README.
        s->buffer.setSize (numCh, numLen);
        reader->read (&s->buffer, 0, numLen, 0, true, true);

        // Filename convention picks the INITIAL route only - you can override
        // any stem live in the mixer (the FOH/IEM button per stem).
        auto lower = f.getFileNameWithoutExtension().toLowerCase();
        const bool isCue = lower.contains ("click") || lower.contains ("cue")
                        || lower.contains ("iem")   || lower.contains ("count");
        s->route.store (isCue ? Route::IEM : Route::FOH);

        report << "  " << (isCue ? "[IEM ] " : "[FOH ] ")
               << s->name
               << "  (" << numCh << "ch, "
               << juce::String (reader->sampleRate, 0) << " Hz)";

        // Warn on sample-rate mismatch - this spike does NOT resample, so a
        // 44.1k stem on a 48k device would play ~9% fast. Keep them matched.
        if (deviceSR > 0 && std::abs (reader->sampleRate - deviceSR) > 1.0)
            report << "   ! SAMPLE-RATE MISMATCH vs device "
                   << juce::String (deviceSR, 0) << " Hz";

        report << "\n";
        stems.push_back (std::move (s));
    }

    playhead.store (0);
    return ! stems.empty();
}

void AudioEngine::clearStems()
{
    stop();
    stems.clear();
    playhead.store (0);
}

//==============================================================================
// loadSong - decode + resample each stem to the device sample rate
//==============================================================================

bool AudioEngine::loadSong (const std::vector<StemSpec>& specs, juce::String& report)
{
    stop();
    // Serialise with loadDeck — only one load at a time
    std::lock_guard<std::recursive_mutex> serialLock (loadSerialMutex);
    // Signal audio callback to skip band stems — same 60ms guarantee as loadDeck
    loadingSong.store (true, std::memory_order_release);
    std::this_thread::sleep_for (std::chrono::milliseconds (60));
    stems.clear();

    const double deviceSR = currentSampleRate.load();
    if (deviceSR <= 0.0)
    {
        report << "No audio device open; cannot load.\n";
        return false;
    }

    for (const auto& spec : specs)
    {
        juce::File file (spec.filePath);
        std::unique_ptr<juce::AudioFormatReader> reader (formatManager.createReaderFor (file));
        if (reader == nullptr)
        {
            report << "  SKIPPED (unreadable): " << spec.filePath << "\n";
            continue;
        }

        auto s = std::make_unique<Stem>();
        s->name = spec.name.isNotEmpty() ? spec.name : file.getFileName();
        s->route.store (spec.route);
        s->gain.store  (spec.gain);
        s->muted.store (spec.muted);

        const int    numCh   = (int) reader->numChannels;
        const int64_t fileLen = (int64_t) reader->lengthInSamples;
        const double fileSR  = reader->sampleRate;

        if (std::abs (fileSR - deviceSR) < 1.0)
        {
            // Same rate: read straight in.
            s->buffer.setSize (numCh, (int) fileLen);
            reader->read (&s->buffer, 0, (int) fileLen, 0, true, true);
        }
        else
        {
            // Different rate: decode at the file rate, then resample to device rate
            // with a Lagrange interpolator (good quality, cheap, done once at load).
            juce::AudioBuffer<float> src (numCh, (int) fileLen);
            reader->read (&src, 0, (int) fileLen, 0, true, true);

            const double ratio  = fileSR / deviceSR;                     // input per output sample
            const int    outLen = (int) std::ceil (fileLen / ratio);
            s->buffer.setSize (numCh, outLen);

            for (int ch = 0; ch < numCh; ++ch)
            {
                juce::LagrangeInterpolator interp;
                interp.reset();
                interp.process (ratio,
                                src.getReadPointer (ch),
                                s->buffer.getWritePointer (ch),
                                outLen);
            }
            report << "  (resampled " << juce::String (fileSR, 0) << " -> "
                   << juce::String (deviceSR, 0) << " Hz) ";
        }

        report << (spec.route == Route::IEM ? "[IEM ] " : "[FOH ] ")
               << s->name << "  (" << numCh << "ch)\n";
        stems.push_back (std::move (s));
    }

    playhead.store (0);
    loadingSong.store (false, std::memory_order_release);
    return ! stems.empty();
}

double AudioEngine::getDurationSeconds() const
{
    std::lock_guard<std::recursive_mutex> readLock (loadSerialMutex);
    const double sr = currentSampleRate.load();
    if (sr <= 0.0) return 0.0;
    int longest = 0;
    for (const auto& s : stems)
        longest = juce::jmax (longest, s->buffer.getNumSamples());
    return (double) longest / sr;
}

//==============================================================================
// DJ decks — multi-stem players
//==============================================================================

bool AudioEngine::loadDeck (int deckIndex, const std::vector<DeckStemSpec>& specs,
                            double trackBpm, juce::String& report)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return false;
    Deck& d = decks[deckIndex];
    const juce::String label = deckIndex == 0 ? "A" : "B";

    // Serialise against every other stems user: the other deck's load, loadSong,
    // and — critically — getDeckWaveform, which walks all stem buffers and can
    // take hundreds of ms. Held for the WHOLE function so no reader can be part
    // way through the buffers when we free them below.
    std::lock_guard<std::recursive_mutex> serialLock (loadSerialMutex);

    // Signal the audio callback to skip this deck.  We then sleep long enough
    // to guarantee the callback has seen reloading=true and finished any in-
    // progress iteration (blocks are ~11ms; 60ms covers 5+ blocks with margin).
    d.reloading.store (true, std::memory_order_release);
    d.playing.store (false);
    std::this_thread::sleep_for (std::chrono::milliseconds (60));
    // At this point the audio callback CANNOT be inside d.stems — safe to modify.
    d.playhead.store (0);
    d.cuePoint.store (0);
    d.cuePreview.store (false);
    d.downbeat.store (0);
    d.posFrac = 0.0;
    for (auto& hc : d.hotCues) hc.store (-1);     // new track, new cue points
    d.loopStart.store (-1);
    d.loopEnd.store (-1);
    d.loopActive.store (false);
    d.loopBeats.store (0.0);
    d.bpm.store (juce::jlimit (20.0, 300.0, trackBpm));
    d.stems.clear();
    d.lengthSamples.store (0);

    const double deviceSR = currentSampleRate.load();
    if (deviceSR <= 0.0) { report << "Deck " << label << ": no audio device\n"; return false; }

    int longest = 0;
    for (const auto& spec : specs)
    {
        juce::File file (spec.filePath);
        std::unique_ptr<juce::AudioFormatReader> reader (formatManager.createReaderFor (file));
        if (reader == nullptr)
        {
            report << "  SKIPPED (unreadable): " << spec.filePath << "\n";
            continue;
        }

        auto st = std::make_unique<DeckStem>();
        st->name = spec.name.isNotEmpty() ? spec.name : file.getFileNameWithoutExtension();
        st->gain.store  (spec.gain);
        st->muted.store (spec.muted);
        st->route.store (spec.route);

        const int     numCh   = (int) reader->numChannels;
        const int64_t fileLen = (int64_t) reader->lengthInSamples;
        const double  fileSR  = reader->sampleRate;

        if (std::abs (fileSR - deviceSR) < 1.0)
        {
            st->buffer.setSize (numCh, (int) fileLen);
            reader->read (&st->buffer, 0, (int) fileLen, 0, true, true);
        }
        else
        {
            juce::AudioBuffer<float> src (numCh, (int) fileLen);
            reader->read (&src, 0, (int) fileLen, 0, true, true);
            const double ratio  = fileSR / deviceSR;
            const int    outLen = (int) std::ceil (fileLen / ratio);
            st->buffer.setSize (numCh, outLen);
            for (int ch = 0; ch < numCh; ++ch)
            {
                juce::LagrangeInterpolator interp; interp.reset();
                interp.process (ratio, src.getReadPointer (ch), st->buffer.getWritePointer (ch), outLen);
            }
        }

        longest = juce::jmax (longest, st->buffer.getNumSamples());
        report << "  " << (spec.route == Route::IEM ? "[IEM ] " : "[FOH ] ") << st->name
               << "  (" << numCh << "ch)\n";
        d.stems.push_back (std::move (st));
    }

    if (d.stems.empty()) { report << "Deck " << label << ": no stems loaded\n"; d.reloading.store (false); return false; }
    d.lengthSamples.store (longest);
    report << "Deck " << label << ": " << (int) d.stems.size() << " stems, sample-locked on one playhead\n";

    // ── Release the audio callback BEFORE beat detection ─────────────────────
    // Beat detection can take 1-3 seconds; keeping reloading=true that long would
    // silence the deck for the whole analysis window.  We release it now so the
    // deck can start playing, then update the beat grid atomically once ready.
    d.reloading.store (false, std::memory_order_release);

    // ── Automatic BPM + beatgrid detection (runs AFTER deck is live) ─────────
    {
        juce::AudioBuffer<float> mix (1, longest);
        mix.clear();
        for (const auto& st : d.stems)
        {
            if (st->route.load() != Route::FOH) continue;
            const int len = st->buffer.getNumSamples();
            for (int ch = 0; ch < st->buffer.getNumChannels(); ++ch)
                mix.addFrom (0, 0, st->buffer, ch, 0, len);
        }
        const BeatAnalysis ba = analyzeBeats (mix, deviceSR);
        if (ba.ok)
        {
            d.bpm.store (juce::jlimit (20.0, 300.0, ba.bpm));
            d.downbeat.store ((int64_t) std::llround (ba.firstBeatSec * deviceSR));
            report << "  auto-detected: " << juce::String (ba.bpm, 2) << " BPM, first beat @ "
                   << juce::String (ba.firstBeatSec, 3) << "s (" << ba.numBeats << " beats tracked)\n";
        }
        else
        {
            report << "  auto-detect: not confident; using manual BPM\n";
        }
    }
    return true;
}

void AudioEngine::deckPlay (int deckIndex)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    if (! deckLoaded (deckIndex)) return;
    if (! anyDeckPlaying())
        masterDeck.store (deckIndex);          // the deck the room hears drives the clock
    // CUE+PLAY: pressing PLAY during a cue preview latches into normal playback,
    // so releasing CUE afterwards no longer snaps back to the cue point.
    decks[deckIndex].cuePreview.store (false);
    decks[deckIndex].playing.store (true);
}

void AudioEngine::deckPause (int deckIndex)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    decks[deckIndex].cuePreview.store (false);
    decks[deckIndex].playing.store (false);
}

//==============================================================================
// CDJ-style CUE. All state lives in atomics, so this is safe from the message
// thread while the audio thread plays — same rule as the stem controls.
//==============================================================================

void AudioEngine::deckCueDown (int deckIndex)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    Deck& d = decks[deckIndex];
    if (! deckLoaded (deckIndex)) return;

    if (d.playing.load() && ! d.cuePreview.load())
    {
        // BACK-CUE: pause and snap to the cue point. Holding does NOT preview
        // (matches Pioneer: you must release and press again to stutter).
        d.playing.store (false);
        d.playhead.store (d.cuePoint.load());
        return;
    }

    if (! d.playing.load())
    {
        // Paused: SET the cue point here, then PREVIEW while held.
        d.cuePoint.store (d.playhead.load());
        d.cuePreview.store (true);
        if (! anyDeckPlaying())
            masterDeck.store (deckIndex);
        d.playing.store (true);
    }
}

void AudioEngine::deckCueUp (int deckIndex)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    Deck& d = decks[deckIndex];
    if (d.cuePreview.exchange (false))         // only acts if we were previewing
    {
        d.playing.store (false);
        d.playhead.store (d.cuePoint.load());  // stutter: back to the cue point
    }
}

void AudioEngine::deckCue (int deckIndex)
{
    // Legacy one-shot (kept for compatibility): back-cue to the cue point.
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    Deck& d = decks[deckIndex];
    d.cuePreview.store (false);
    d.playing.store (false);
    d.playhead.store (d.cuePoint.load());
}

void AudioEngine::deckSeek (int deckIndex, double seconds)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    const double sr = currentSampleRate.load();
    decks[deckIndex].playhead.store ((int64_t) std::llround (juce::jmax (0.0, seconds) * sr));
}

void AudioEngine::setDeckGain (int deckIndex, float linearGain)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    decks[deckIndex].gain.store (juce::jlimit (0.0f, 4.0f, linearGain));
}

//==============================================================================
// 3-band EQ + filter, tempo + sync (all atomics — live-safe)
//==============================================================================

void AudioEngine::setDeckEq (int deckIndex, float lowDb, float midDb, float highDb)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    Deck& d = decks[deckIndex];
    d.eqLowDb.store  (juce::jlimit (-26.0f, 6.0f, lowDb));
    d.eqMidDb.store  (juce::jlimit (-26.0f, 6.0f, midDb));
    d.eqHighDb.store (juce::jlimit (-26.0f, 6.0f, highDb));
    d.eqDirty.store (true);
}

void AudioEngine::setDeckFilter (int deckIndex, float position)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    decks[deckIndex].filterPos.store (juce::jlimit (-1.0f, 1.0f, position));
    decks[deckIndex].eqDirty.store (true);
}

float AudioEngine::getDeckEqLow  (int i) const { return i>=0 && i<kNumDecks ? decks[i].eqLowDb.load()  : 0.0f; }
float AudioEngine::getDeckEqMid  (int i) const { return i>=0 && i<kNumDecks ? decks[i].eqMidDb.load()  : 0.0f; }
float AudioEngine::getDeckEqHigh (int i) const { return i>=0 && i<kNumDecks ? decks[i].eqHighDb.load() : 0.0f; }
float AudioEngine::getDeckFilter (int i) const { return i>=0 && i<kNumDecks ? decks[i].filterPos.load() : 0.0f; }

void AudioEngine::setDeckRate (int deckIndex, double rate)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    decks[deckIndex].rate.store (juce::jlimit (0.5, 2.0, rate));
}

double AudioEngine::getDeckRate (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks ? decks[deckIndex].rate.load() : 1.0;
}

void AudioEngine::setDeckBpm (int deckIndex, double bpm)
{
    if (deckIndex >= 0 && deckIndex < kNumDecks && bpm > 20.0 && bpm < 400.0)
        decks[deckIndex].bpm.store (bpm);
}

void AudioEngine::setDeckFxOn (int deckIndex, bool on)
{
    if (deckIndex >= 0 && deckIndex < kNumDecks) decks[deckIndex].fxOn.store (on);
}
bool AudioEngine::getDeckFxOn (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks && decks[deckIndex].fxOn.load();
}
void AudioEngine::setDeckFxDepth (int deckIndex, float depth)
{
    if (deckIndex >= 0 && deckIndex < kNumDecks)
        decks[deckIndex].fxDepth.store (juce::jlimit (0.0f, 1.0f, depth));
}
float AudioEngine::getDeckFxDepth (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks ? decks[deckIndex].fxDepth.load() : 0.0f;
}

void AudioEngine::cycleDeckTempoRange (int deckIndex)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    const int cur = decks[deckIndex].tempoRange.load();
    // Pioneer TEMPO RANGE button sequence: 6 → 10 → 16 → Wide(100) → 6
    const int next = (cur < 10) ? 10 : (cur < 16) ? 16 : (cur < 100) ? 100 : 6;
    decks[deckIndex].tempoRange.store (next);
}

int AudioEngine::getDeckTempoRange (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks ? decks[deckIndex].tempoRange.load() : 8;
}

void AudioEngine::setDeckTempoRange (int deckIndex, int rangePct)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    // Snap to a valid Pioneer step, or accept an arbitrary value (e.g. for save/restore).
    decks[deckIndex].tempoRange.store (juce::jmax (1, rangePct));
}

void AudioEngine::deckSync (int deckIndex)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    const int other = 1 - deckIndex;
    Deck& d = decks[deckIndex];
    Deck& m = decks[other];
    if (d.stems.empty() || m.stems.empty()) return;   // need two loaded decks

    const double myBpm     = d.bpm.load();
    const double targetBpm = m.bpm.load() * m.rate.load();   // other deck's EFFECTIVE tempo
    if (myBpm <= 0.0 || targetBpm <= 0.0) return;

    d.rate.store (juce::jlimit (0.5, 2.0, targetBpm / myBpm));

    // Phase snap: move this deck's playhead (≤ half a beat either way) so its
    // beat phase lines up with the other deck's beat phase.
    const double sr = currentSampleRate.load();
    if (sr <= 0.0) return;
    const double mySpb     = sr * 60.0 / myBpm;               // my beat, in MY samples
    const double otherSpb  = sr * 60.0 / m.bpm.load();
    const double myPhase    = std::fmod ((double) (d.playhead.load() - d.downbeat.load()) / mySpb,    1.0);
    const double otherPhase = std::fmod ((double) (m.playhead.load() - m.downbeat.load()) / otherSpb, 1.0);
    double delta = otherPhase - myPhase;                       // in beats
    if (delta >  0.5) delta -= 1.0;
    if (delta < -0.5) delta += 1.0;
    const int64_t shifted = d.playhead.load() + (int64_t) std::llround (delta * mySpb);
    d.playhead.store (juce::jmax ((int64_t) 0, shifted));
}

//==============================================================================
// RBJ biquad coefficient helpers (Audio EQ Cookbook)
//==============================================================================

static void biquadLowShelf (AudioEngine::Deck::Biquad& q, double sr, double f0, double dB)
{
    const double A = std::pow (10.0, dB / 40.0);
    const double w = 2.0 * juce::MathConstants<double>::pi * f0 / sr;
    const double cw = std::cos (w), sw = std::sin (w);
    const double alpha = sw / 2.0 * std::sqrt (2.0);   // slope S = 1
    const double sq = 2.0 * std::sqrt (A) * alpha;
    const double a0 =            (A+1) + (A-1)*cw + sq;
    q.b0 = (A * ((A+1) - (A-1)*cw + sq)) / a0;
    q.b1 = (2*A * ((A-1) - (A+1)*cw))    / a0;
    q.b2 = (A * ((A+1) - (A-1)*cw - sq)) / a0;
    q.a1 = (-2 * ((A-1) + (A+1)*cw))     / a0;
    q.a2 = ((A+1) + (A-1)*cw - sq)       / a0;
    q.active = std::abs (dB) > 0.01;
}

static void biquadHighShelf (AudioEngine::Deck::Biquad& q, double sr, double f0, double dB)
{
    const double A = std::pow (10.0, dB / 40.0);
    const double w = 2.0 * juce::MathConstants<double>::pi * f0 / sr;
    const double cw = std::cos (w), sw = std::sin (w);
    const double alpha = sw / 2.0 * std::sqrt (2.0);
    const double sq = 2.0 * std::sqrt (A) * alpha;
    const double a0 =            (A+1) - (A-1)*cw + sq;
    q.b0 = (A * ((A+1) + (A-1)*cw + sq)) / a0;
    q.b1 = (-2*A * ((A-1) + (A+1)*cw))   / a0;
    q.b2 = (A * ((A+1) + (A-1)*cw - sq)) / a0;
    q.a1 = (2 * ((A-1) - (A+1)*cw))      / a0;
    q.a2 = ((A+1) - (A-1)*cw - sq)       / a0;
    q.active = std::abs (dB) > 0.01;
}

static void biquadPeak (AudioEngine::Deck::Biquad& q, double sr, double f0, double Q, double dB)
{
    const double A = std::pow (10.0, dB / 40.0);
    const double w = 2.0 * juce::MathConstants<double>::pi * f0 / sr;
    const double alpha = std::sin (w) / (2.0 * Q);
    const double a0 = 1 + alpha / A;
    q.b0 = (1 + alpha * A) / a0;
    q.b1 = (-2 * std::cos (w)) / a0;
    q.b2 = (1 - alpha * A) / a0;
    q.a1 = q.b1;
    q.a2 = (1 - alpha / A) / a0;
    q.active = std::abs (dB) > 0.01;
}

static void biquadLowPass (AudioEngine::Deck::Biquad& q, double sr, double f0, double Q)
{
    const double w = 2.0 * juce::MathConstants<double>::pi * f0 / sr;
    const double alpha = std::sin (w) / (2.0 * Q);
    const double cw = std::cos (w);
    const double a0 = 1 + alpha;
    q.b0 = ((1 - cw) / 2) / a0;
    q.b1 = (1 - cw) / a0;
    q.b2 = q.b0;
    q.a1 = (-2 * cw) / a0;
    q.a2 = (1 - alpha) / a0;
    q.active = true;
}

static void biquadHighPass (AudioEngine::Deck::Biquad& q, double sr, double f0, double Q)
{
    const double w = 2.0 * juce::MathConstants<double>::pi * f0 / sr;
    const double alpha = std::sin (w) / (2.0 * Q);
    const double cw = std::cos (w);
    const double a0 = 1 + alpha;
    q.b0 = ((1 + cw) / 2) / a0;
    q.b1 = (-(1 + cw)) / a0;
    q.b2 = q.b0;
    q.a1 = (-2 * cw) / a0;
    q.a2 = (1 - alpha) / a0;
    q.active = true;
}

/** Recompute a deck's EQ + filter coefficients (audio thread, on eqDirty). */
static void refreshDeckEq (AudioEngine::Deck& d, double sr)
{
    biquadLowShelf  (d.eqLow,  sr, 100.0,  (double) d.eqLowDb.load());
    biquadPeak      (d.eqMid,  sr, 1000.0, 0.7, (double) d.eqMidDb.load());
    biquadHighShelf (d.eqHigh, sr, 10000.0, (double) d.eqHighDb.load());

    const double p = (double) d.filterPos.load();
    if (p < -0.05)        // low-pass: 20 kHz → ~120 Hz, exponential sweep
        biquadLowPass  (d.filter, sr, 20000.0 * std::pow (120.0 / 20000.0, -p), 0.9);
    else if (p > 0.05)    // high-pass: 20 Hz → ~8 kHz
        biquadHighPass (d.filter, sr, 20.0 * std::pow (8000.0 / 20.0, p), 0.9);
    else
        d.filter.active = false;
}

//==============================================================================
// Hot cues + loops. All state is atomic, so the DJ can hit these mid-playback
// from the message thread while the audio thread reads. Positions are samples.
//==============================================================================

void AudioEngine::setHotCue (int deckIndex, int slot)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    if (slot < 0 || slot >= Deck::kNumHotCues) return;
    if (! deckLoaded (deckIndex)) return;
    decks[deckIndex].hotCues[slot].store (decks[deckIndex].playhead.load());
}

void AudioEngine::jumpHotCue (int deckIndex, int slot)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    if (slot < 0 || slot >= Deck::kNumHotCues) return;
    Deck& d = decks[deckIndex];
    const int64_t p = d.hotCues[slot].load();
    if (p < 0) return;                       // empty slot: do nothing
    d.playhead.store (p);
    d.posFrac = 0.0;
    // Pioneer behaviour: a hot cue press plays from that point, whatever the
    // deck was doing. Clears any cue preview so releasing CUE can't snap back.
    d.cuePreview.store (false);
    if (! anyDeckPlaying()) masterDeck.store (deckIndex);
    d.playing.store (true);
}

void AudioEngine::deleteHotCue (int deckIndex, int slot)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    if (slot < 0 || slot >= Deck::kNumHotCues) return;
    decks[deckIndex].hotCues[slot].store (-1);
}

double AudioEngine::getHotCueSeconds (int deckIndex, int slot) const
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return -1.0;
    if (slot < 0 || slot >= Deck::kNumHotCues) return -1.0;
    const int64_t p = decks[deckIndex].hotCues[slot].load();
    const double sr = currentSampleRate.load();
    return (p < 0 || sr <= 0) ? -1.0 : (double) p / sr;
}

void AudioEngine::deckLoopIn (int deckIndex)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    Deck& d = decks[deckIndex];
    d.loopStart.store (d.playhead.load());
    d.loopBeats.store (0.0);            // manual loop: no musical length
    d.loopActive.store (false);         // not looping until OUT is set
}

void AudioEngine::deckLoopOut (int deckIndex)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    Deck& d = decks[deckIndex];
    const int64_t in = d.loopStart.load();
    const int64_t out = d.playhead.load();
    if (in < 0 || out <= in) return;    // need a valid IN first, and forward motion
    d.loopEnd.store (out);
    d.loopBeats.store (0.0);
    d.loopActive.store (true);          // loop engages immediately
}

void AudioEngine::deckLoopExit (int deckIndex)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    decks[deckIndex].loopActive.store (false);   // points are kept for RELOOP
}

void AudioEngine::deckReloop (int deckIndex)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    Deck& d = decks[deckIndex];
    const int64_t in = d.loopStart.load(), out = d.loopEnd.load();
    if (in < 0 || out <= in) return;
    d.playhead.store (in);
    d.posFrac = 0.0;
    d.loopActive.store (true);
}

void AudioEngine::deckLoopBeats (int deckIndex, double beats)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    if (beats <= 0.0) return;
    Deck& d = decks[deckIndex];
    if (d.stems.empty()) return;
    const double sr = currentSampleRate.load();
    const double bpm = d.bpm.load();
    if (sr <= 0.0 || bpm <= 0.0) return;

    const double spb = sr * 60.0 / bpm;                     // samples per beat
    // Snap the loop start to the nearest beat of the detected grid, so an
    // auto-loop is always musically square.
    const int64_t db = d.downbeat.load();
    const double  beatsFromDownbeat = ((double) (d.playhead.load() - db)) / spb;
    const int64_t start = db + (int64_t) std::llround (std::round (beatsFromDownbeat) * spb);
    const int64_t end   = start + (int64_t) std::llround (beats * spb);
    if (start < 0 || end <= start) return;

    d.loopStart.store (start);
    d.loopEnd.store (end);
    d.loopBeats.store (beats);
    d.loopActive.store (true);
    // If the playhead sits outside the new loop, pull it in so the loop is
    // heard immediately rather than on the next pass.
    const int64_t p = d.playhead.load();
    if (p < start || p >= end) { d.playhead.store (start); d.posFrac = 0.0; }
}

void AudioEngine::deckLoopScale (int deckIndex, double factor)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    if (factor <= 0.0) return;
    Deck& d = decks[deckIndex];
    const int64_t in = d.loopStart.load(), out = d.loopEnd.load();
    if (in < 0 || out <= in) return;

    // Scale around the loop IN point (CDJ behaviour), minimum ~1 ms.
    const int64_t len = (int64_t) std::llround ((double) (out - in) * factor);
    const int64_t minLen = (int64_t) juce::jmax (48.0, currentSampleRate.load() * 0.001);
    if (len < minLen) return;
    d.loopEnd.store (in + len);
    const double lb = d.loopBeats.load();
    if (lb > 0.0) d.loopBeats.store (lb * factor);

    // Keep the playhead inside the (possibly shorter) loop.
    const int64_t p = d.playhead.load();
    if (d.loopActive.load() && (p < in || p >= in + len))
    { d.playhead.store (in); d.posFrac = 0.0; }
}

bool AudioEngine::isDeckLooping (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks && decks[deckIndex].loopActive.load();
}

double AudioEngine::getDeckLoopStartSeconds (int deckIndex) const
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return -1.0;
    const int64_t p = decks[deckIndex].loopStart.load();
    const double sr = currentSampleRate.load();
    return (p < 0 || sr <= 0) ? -1.0 : (double) p / sr;
}

double AudioEngine::getDeckLoopEndSeconds (int deckIndex) const
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return -1.0;
    const int64_t p = decks[deckIndex].loopEnd.load();
    const double sr = currentSampleRate.load();
    return (p < 0 || sr <= 0) ? -1.0 : (double) p / sr;
}

double AudioEngine::getDeckLoopBeats (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks ? decks[deckIndex].loopBeats.load() : 0.0;
}


//==============================================================================
// Output routing, PFL cue bus, MIDI control surface
//==============================================================================

void AudioEngine::setOutputRouting (const OutputRouting& r)
{
    routeFohL.store (r.fohL); routeFohR.store (r.fohR);
    routeIemL.store (r.iemL); routeIemR.store (r.iemR);
    routeCueL.store (r.cueL); routeCueR.store (r.cueR);
    routeDeckAL.store (r.deckAL); routeDeckAR.store (r.deckAR);
    routeDeckBL.store (r.deckBL); routeDeckBR.store (r.deckBR);
}

AudioEngine::OutputRouting AudioEngine::getOutputRouting() const
{
    OutputRouting r;
    r.deckAL = routeDeckAL.load(); r.deckAR = routeDeckAR.load();
    r.deckBL = routeDeckBL.load(); r.deckBR = routeDeckBR.load();
    r.fohL = routeFohL.load(); r.fohR = routeFohR.load();
    r.iemL = routeIemL.load(); r.iemR = routeIemR.load();
    r.cueL = routeCueL.load(); r.cueR = routeCueR.load();
    return r;
}

void AudioEngine::setDeckCueEnabled (int deckIndex, bool shouldCue)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    decks[deckIndex].cueEnabled.store (shouldCue);
}

bool AudioEngine::isDeckCueEnabled (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks && decks[deckIndex].cueEnabled.load();
}

void AudioEngine::setCueGain (float g) { cueGain.store (juce::jlimit (0.0f, 4.0f, g)); }

juce::File AudioEngine::getSettingsFile()
{
    return juce::File::getSpecialLocation (juce::File::userHomeDirectory)
             .getChildFile ("MidnightDrive")
             .getChildFile ("rockdj-dj-settings.json");
}

void AudioEngine::saveSettings() const
{
    auto* root = new juce::DynamicObject();

    auto r = getOutputRouting();
    auto* ro = new juce::DynamicObject();
    ro->setProperty ("fohL", r.fohL); ro->setProperty ("fohR", r.fohR);
    ro->setProperty ("iemL", r.iemL); ro->setProperty ("iemR", r.iemR);
    ro->setProperty ("cueL", r.cueL); ro->setProperty ("cueR", r.cueR);
    root->setProperty ("routing", juce::var (ro));

    auto* jo = new juce::DynamicObject();
    jo->setProperty ("nudge",  jogNudgePerTick.load());
    jo->setProperty ("search", jogSearchPerTick.load());
    jo->setProperty ("decay",  jogDecaySeconds.load());
    root->setProperty ("jog", juce::var (jo));

    juce::Array<juce::var> arr;
    for (const auto& b : getMidiBindings())
    {
        auto* bo = new juce::DynamicObject();
        bo->setProperty ("status", b.status);
        bo->setProperty ("channel", b.channel);
        bo->setProperty ("data1", b.data1);
        bo->setProperty ("action", actionToString (b.action));
        bo->setProperty ("deck", b.deck);
        bo->setProperty ("param", b.param);
        bo->setProperty ("relMode", b.relMode);
        bo->setProperty ("bit14", b.bit14);
        arr.add (juce::var (bo));
    }
    root->setProperty ("bindings", arr);
    root->setProperty ("midiDevice", openMidiNames.joinIntoString (", "));
    root->setProperty ("preferredOutput", preferredOutputName);
    // Persist tempo ranges so the DJ doesn't have to re-set them after a restart
    juce::Array<juce::var> ranges;
    for (int di = 0; di < kNumDecks; ++di) ranges.add (decks[di].tempoRange.load());
    root->setProperty ("tempoRanges", ranges);

    const juce::var v (root);
    auto f = getSettingsFile();
    f.getParentDirectory().createDirectory();
    f.replaceWithText (juce::JSON::toString (v, true));
}

void AudioEngine::loadSettings()
{
    auto f = getSettingsFile();
    if (! f.existsAsFile()) return;
    juce::var v;
    if (juce::JSON::parse (f.loadFileAsString(), v).failed()) return;

    if (auto* ro = v.getProperty ("routing", {}).getDynamicObject())
    {
        OutputRouting r;
        r.fohL = (int) ro->getProperty ("fohL"); r.fohR = (int) ro->getProperty ("fohR");
        r.iemL = (int) ro->getProperty ("iemL"); r.iemR = (int) ro->getProperty ("iemR");
        r.cueL = (int) ro->getProperty ("cueL"); r.cueR = (int) ro->getProperty ("cueR");
        setOutputRouting (r);
    }
    if (auto* jo = v.getProperty ("jog", {}).getDynamicObject())
        setJogSensitivity ((double) jo->getProperty ("nudge"),
                           (double) jo->getProperty ("search"),
                           (double) jo->getProperty ("decay"));

    std::vector<MidiBinding> out;
    if (const auto* arr = v.getProperty ("bindings", {}).getArray())
        for (const auto& bv : *arr)
        {
            MidiBinding b;
            b.status  = (int) bv.getProperty ("status", 0);
            b.channel = (int) bv.getProperty ("channel", 0);
            b.data1   = (int) bv.getProperty ("data1", 0);
            {
                // Support both old format (integer) and current format (string).
                // Old files have integers that no longer map correctly after enum
                // additions. Detect them and skip — the user needs to reload the preset.
                const juce::var av = bv.getProperty ("action", "");
                if (av.isString() && av.toString().isNotEmpty() && !av.toString().containsOnly ("0123456789"))
                    b.action = actionFromString (av.toString());
                else
                    b.action = MidiAction::None;   // old integer format: skip (stale)
            }
            b.deck    = (int) bv.getProperty ("deck", 0);
            b.param   = (double) bv.getProperty ("param", 0.0);
            b.relMode = (int) bv.getProperty ("relMode", 0);
            b.bit14   = (bool) bv.getProperty ("bit14", false);
            out.push_back (b);
        }
    if (! out.empty()) setMidiBindings (out);

    // Reopen the controller the DJ was last using, so a restart mid-gig comes
    // back with hands-on control rather than a dead deck.
    if (const auto* arr = v.getProperty ("tempoRanges", {}).getArray())
        for (int di = 0; di < kNumDecks && di < arr->size(); ++di)
            decks[di].tempoRange.store ((int) (*arr)[di]);

    const juce::String prefOut = v.getProperty ("preferredOutput", "").toString();
    if (prefOut.isNotEmpty()) preferredOutputName = prefOut;

    // Open all available MIDI inputs automatically (supports multi-port controllers like CDJ-3000)
    for (auto& m : midiIns) { m->stop(); }
    midiIns.clear();
    openMidiNames.clear();
    for (const auto& d : juce::MidiInput::getAvailableDevices())
    {
        auto m = juce::MidiInput::openDevice (d.identifier, this);
        if (m != nullptr) { m->start(); openMidiNames.add (d.name); midiIns.push_back (std::move (m)); }
    }
}

float AudioEngine::getDeckGain (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks ? decks[deckIndex].gain.load() : 0.0f;
}

juce::String AudioEngine::actionToString (MidiAction a)
{
    using A = MidiAction;
    switch (a)
    {
        case A::PlayPause:     return "playPause";
        case A::Play:          return "play";
        case A::Pause:         return "pause";
        case A::CueButton:     return "cue";
        case A::Sync:          return "sync";
        case A::CueEnable:     return "cueEnable";
        case A::HotCue:        return "hotCue";
        case A::LoopIn:        return "loopIn";
        case A::LoopOut:       return "loopOut";
        case A::LoopBeats:     return "loopBeats";
        case A::LoopExit:      return "loopExit";
        case A::Reloop:        return "reloop";
        case A::Rate:          return "rate";
        case A::TempoRange:    return "tempoRange";
        case A::Crossfader:    return "crossfader";
        case A::EqLow:         return "eqLow";
        case A::EqMid:         return "eqMid";
        case A::EqHigh:        return "eqHigh";
        case A::Filter:        return "filter";
        case A::DeckGain:      return "deckGain";
        case A::Jog:           return "jog";
        case A::JogScratch:    return "jogScratch";
        case A::MasterGain:    return "masterGain";
        case A::DeckTrim:      return "deckTrim";
        case A::FxOn:          return "fxOn";
        case A::FxDepth:       return "fxDepth";
        case A::ClearHotCue:   return "clearHotCue";
        case A::Pad1: return "pad1"; case A::Pad2: return "pad2";
        case A::Pad3: return "pad3"; case A::Pad4: return "pad4";
        case A::Pad5: return "pad5"; case A::Pad6: return "pad6";
        case A::Pad7: return "pad7"; case A::Pad8: return "pad8";
        case A::XfAssign:      return "xfAssign";
        case A::LibraryUp:     return "libraryUp";
        case A::LibraryDown:   return "libraryDown";
        case A::LibrarySelect: return "librarySelect";
        case A::LibraryLoad0:  return "libraryLoad0";
        case A::LibraryLoad1:  return "libraryLoad1";
        case A::None: default: return "";
    }
}

AudioEngine::MidiAction AudioEngine::actionFromString (const juce::String& a)
{
    using A = MidiAction;
    if (a == "playPause")   return A::PlayPause;
    if (a == "play")        return A::Play;
    if (a == "pause")       return A::Pause;
    if (a == "cue")         return A::CueButton;
    if (a == "sync")        return A::Sync;
    if (a == "cueEnable")   return A::CueEnable;
    if (a == "hotCue")      return A::HotCue;
    if (a == "loopIn")      return A::LoopIn;
    if (a == "loopOut")     return A::LoopOut;
    if (a == "loopBeats")   return A::LoopBeats;
    if (a == "loopExit")    return A::LoopExit;
    if (a == "reloop")      return A::Reloop;
    if (a == "rate")        return A::Rate;
    if (a == "tempoRange")  return A::TempoRange;
    if (a == "crossfader")  return A::Crossfader;
    if (a == "eqLow")       return A::EqLow;
    if (a == "eqMid")       return A::EqMid;
    if (a == "eqHigh")      return A::EqHigh;
    if (a == "filter")      return A::Filter;
    if (a == "deckGain")    return A::DeckGain;
    if (a == "jog")         return A::Jog;
    if (a == "jogScratch")  return A::JogScratch;
    if (a == "masterGain")  return A::MasterGain;
    if (a == "deckTrim")    return A::DeckTrim;
    if (a == "fxOn")        return A::FxOn;
    if (a == "fxDepth")     return A::FxDepth;
    if (a == "clearHotCue") return A::ClearHotCue;
    if (a == "pad1") return A::Pad1; if (a == "pad2") return A::Pad2;
    if (a == "pad3") return A::Pad3; if (a == "pad4") return A::Pad4;
    if (a == "pad5") return A::Pad5; if (a == "pad6") return A::Pad6;
    if (a == "pad7") return A::Pad7; if (a == "pad8") return A::Pad8;
    if (a == "xfAssign")    return A::XfAssign;
    if (a == "libraryUp")   return A::LibraryUp;
    if (a == "libraryDown") return A::LibraryDown;
    if (a == "librarySelect") return A::LibrarySelect;
    if (a == "libraryLoad0") return A::LibraryLoad0;
    if (a == "libraryLoad1") return A::LibraryLoad1;
    return A::None;
}

int AudioEngine::decodeRelative (int v, int relMode)
{
    switch (relMode)
    {
        case 1:  return v - 64;                                        // binary offset
        case 2:  return (v & 0x40) ? -(v & 0x3F) : (v & 0x3F);         // signed bit
        case 0:
        default: return v < 64 ? v : v - 128;                          // two's complement
    }
}

void AudioEngine::setHotCueDirect (int deckIndex, int slot, double seconds)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    if (slot < 0 || slot >= Deck::kNumHotCues) return;
    const double sr = currentSampleRate.load();
    if (sr <= 0.0) return;
    const int64_t samplePos = (int64_t) std::llround (seconds * sr);
    decks[deckIndex].hotCues[slot].store (juce::jmax ((int64_t) 0, samplePos));
}

bool AudioEngine::isHotCueSet (int deckIndex, int slot) const
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return false;
    if (slot < 0 || slot >= Deck::kNumHotCues) return false;
    return decks[deckIndex].hotCues[slot].load() >= 0;
}

void AudioEngine::deckScratch (int deckIndex, double ticks)
{
    // VINYL platter scrub: move the playhead directly whether playing or not.
    // While playing this is audibly scratchy (position jumps between blocks),
    // which is exactly the point of a vinyl-mode platter.
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    if (ticks == 0.0) return;
    Deck& d = decks[deckIndex];
    if (d.stems.empty()) return;
    const double sr = currentSampleRate.load();
    if (sr <= 0.0) return;
    const int64_t delta = (int64_t) std::llround (ticks * jogSearchPerTick.load() * sr);
    const int64_t p = d.playhead.load() + delta;
    d.playhead.store (juce::jlimit ((int64_t) 0, (int64_t) juce::jmax (0, d.lengthSamples.load() - 1), p));
    d.posFrac = 0.0;
}

void AudioEngine::deckJog (int deckIndex, double ticks)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    if (ticks == 0.0) return;
    Deck& d = decks[deckIndex];
    if (d.stems.empty()) return;

    if (d.playing.load())
    {
        // NUDGE. Top up a temporary bend; the audio thread decays it back to
        // zero when the DJ stops pushing. Clamped so a fast spin can't send the
        // deck to a silly rate mid-set.
        const double next = d.jogBend.load() + ticks * jogNudgePerTick.load();
        d.jogBend.store (juce::jlimit (-0.6, 0.6, next));
    }
    else
    {
        // SEARCH. Move the playhead directly; no bend, no decay.
        const double sr = currentSampleRate.load();
        if (sr <= 0.0) return;
        const int64_t delta = (int64_t) std::llround (ticks * jogSearchPerTick.load() * sr);
        const int64_t p = d.playhead.load() + delta;
        d.playhead.store (juce::jlimit ((int64_t) 0, (int64_t) juce::jmax (0, d.lengthSamples.load() - 1), p));
        d.posFrac = 0.0;
    }
}

void AudioEngine::setJogSensitivity (double nudgePerTick, double searchSecondsPerTick, double decaySeconds)
{
    jogNudgePerTick.store (juce::jlimit (0.0001, 0.05, nudgePerTick));
    jogSearchPerTick.store (juce::jlimit (0.0001, 0.2, searchSecondsPerTick));
    jogDecaySeconds.store (juce::jlimit (0.005, 60.0, decaySeconds));
}

double AudioEngine::getJogNudge() const  { return jogNudgePerTick.load(); }
double AudioEngine::getJogSearch() const { return jogSearchPerTick.load(); }
double AudioEngine::getJogDecay() const  { return jogDecaySeconds.load(); }

double AudioEngine::getDeckJogBend (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks ? decks[deckIndex].jogBend.load() : 0.0;
}
float AudioEngine::getCueGain() const  { return cueGain.load(); }

juce::StringArray AudioEngine::getMidiDevices() const
{
    juce::StringArray names;
    for (const auto& d : juce::MidiInput::getAvailableDevices())
        names.add (d.name);
    return names;
}

juce::String AudioEngine::openMidiDevice (const juce::String& name)
{
    for (auto& m : midiIns) { m->stop(); }
    midiIns.clear();
    openMidiNames.clear();
    if (name.isEmpty()) return {};

    for (const auto& d : juce::MidiInput::getAvailableDevices())
        if (d.name == name)
        {
            auto m = juce::MidiInput::openDevice (d.identifier, this);
            if (m == nullptr) return "could not open MIDI device: " + name;
            m->start();
            openMidiNames.add (name);
            midiIns.push_back (std::move (m));
            return {};
        }
    return "MIDI device not found: " + name;
}

juce::String AudioEngine::openMidiDevices (const juce::StringArray& names)
{
    for (auto& m : midiIns) { m->stop(); }
    midiIns.clear();
    openMidiNames.clear();
    if (names.isEmpty()) return {};

    juce::StringArray errors;
    for (const auto& name : names)
    {
        bool found = false;
        for (const auto& d : juce::MidiInput::getAvailableDevices())
        {
            if (d.name == name)
            {
                found = true;
                auto m = juce::MidiInput::openDevice (d.identifier, this);
                if (m == nullptr) { errors.add ("could not open: " + name); continue; }
                m->start();
                openMidiNames.add (name);
                midiIns.push_back (std::move (m));
                break;
            }
        }
        if (!found) errors.add ("not found: " + name);
    }
    return errors.joinIntoString (", ");
}

juce::String AudioEngine::getOpenMidiDevice() const { return openMidiNames.joinIntoString (", "); }

void AudioEngine::setMidiBindings (const std::vector<MidiBinding>& b)
{
    const juce::ScopedLock sl (midiLock);
    midiBindings = b;
}

std::vector<AudioEngine::MidiBinding> AudioEngine::getMidiBindings() const
{
    const juce::ScopedLock sl (midiLock);
    return midiBindings;
}

void AudioEngine::setMidiMonitor (std::function<void (int, int, int, int)> fn)
{
    const juce::ScopedLock sl (midiLock);
    midiMonitor = std::move (fn);
}

float AudioEngine::getDeckPeak (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks ? decks[deckIndex].peakLevel.load() : 0.0f;
}
float AudioEngine::getMasterPeak() const { return masterPeak.load(); }
void  AudioEngine::resetPeaks()
{
    for (auto& d : decks) d.peakLevel.store (0.0f);
    masterPeak.store (0.0f);
}

// ── MIDI output ──
juce::StringArray AudioEngine::getMidiOutputDevices() const
{
    juce::StringArray names;
    for (const auto& d : juce::MidiOutput::getAvailableDevices())
        names.add (d.name);
    return names;
}
juce::String AudioEngine::openMidiOutputDevice (const juce::String& name)
{
    midiOut.reset();
    openMidiOutName.clear();
    if (name.isEmpty()) return {};
    for (const auto& d : juce::MidiOutput::getAvailableDevices())
        if (d.name == name)
        {
            midiOut = juce::MidiOutput::openDevice (d.identifier);
            if (! midiOut) return "could not open MIDI output: " + name;
            openMidiOutName = name;
            return {};
        }
    return "MIDI output not found: " + name;
}
juce::String AudioEngine::getOpenMidiOutputDevice() const { return openMidiOutName; }
void AudioEngine::sendMidiOut (int status, int data1, int data2)
{
    if (midiOut)
        midiOut->sendMessageNow (juce::MidiMessage (status, data1, data2));
}

void AudioEngine::setDeckFxMode (int deckIndex, int mode)
{
    if (deckIndex >= 0 && deckIndex < kNumDecks)
        decks[deckIndex].fxMode.store (juce::jlimit (0, 1, mode));
}

int AudioEngine::getDeckFxMode (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks ? decks[deckIndex].fxMode.load() : 0;
}

void AudioEngine::setLibraryCallback (std::function<void (const juce::String&, int)> fn)
{
    const juce::ScopedLock sl (midiLock);
    libraryCallback = std::move (fn);
}

void AudioEngine::injectMidi (int status, int channel, int d1, int d2)
{
    const int ch = juce::jlimit (1, 16, channel);
    juce::MidiMessage m = status == 0xB0 ? juce::MidiMessage::controllerEvent (ch, d1, d2)
                        : d2 > 0         ? juce::MidiMessage::noteOn (ch, d1, (juce::uint8) d2)
                                         : juce::MidiMessage::noteOff (ch, d1);
    handleIncomingMidiMessage (nullptr, m);
}

void AudioEngine::handleIncomingMidiMessage (juce::MidiInput*, const juce::MidiMessage& m)
{
    // Called on the MIDI thread - never the audio thread - so a short lock is
    // fine here. Everything it touches downstream is atomic.
    int status = 0, d1 = 0, d2 = 0;
    if (m.isNoteOnOrOff())        { status = 0x90; d1 = m.getNoteNumber();       d2 = m.getVelocity(); }
    else if (m.isController())    { status = 0xB0; d1 = m.getControllerNumber(); d2 = m.getControllerValue(); }
    else if (m.isPitchWheel())    { status = 0xE0; d1 = 0;                       d2 = m.getPitchWheelValue() >> 7; }
    else return;                  // clock/sysex etc: not mappable

    const int chan = m.getChannel();
    // Cache MSBs so a 14-bit pair can be reassembled when the LSB lands.
    if (status == 0xB0 && d1 < 32 && chan >= 1 && chan <= 16)
        ccMsb[chan - 1][d1].store (d2);

    std::function<void (int, int, int, int)> monitor;
    std::vector<MidiBinding> snapshot;
    {
        const juce::ScopedLock sl (midiLock);
        monitor  = midiMonitor;
        snapshot = midiBindings;
    }
    if (monitor) monitor (status, chan, d1, d2);   // feeds the learn UI

    for (const auto& b : snapshot)
    {
        if (b.status != status) continue;
        if (! (b.channel == 0 || b.channel == chan)) continue;
        // A 14-bit control answers to BOTH its MSB and its LSB controller.
        const bool direct = (b.data1 == d1);
        const bool lsbOf14 = (b.bit14 && status == 0xB0 && d1 == b.data1 + 32);
        if (! direct && ! lsbOf14) continue;
        applyMidiBinding (b, m);
    }
}

void AudioEngine::applyMidiBinding (const MidiBinding& b, const juce::MidiMessage& m)
{
    // Notes: act on press. A note-on with velocity 0 is a release (running status).
    const bool isNote    = m.isNoteOnOrOff();
    const bool pressed   = m.isNoteOn() && m.getVelocity() > 0;
    const bool released  = isNote && ! pressed;
    // Continuous controls: 7-bit (0..127) or a 14-bit CC pair (0..16383).
    // Bipolar controls (pitch fader, EQ, filter) must read EXACTLY zero at the
    // centre detent: 64 is the centre of 0..127, and 64/127 is NOT 0.5. Getting
    // this wrong leaves a pitch fader parked at +0.06% - inaudible on its own,
    // but it pulls a mix apart over the length of a song.
    double norm = 0.0, bip = 0.0;
    if (b.bit14 && m.isController())
    {
        const int ch  = juce::jlimit (1, 16, m.getChannel());
        const int msb = ccMsb[ch - 1][juce::jlimit (0, 31, b.data1)].load();
        const int lsb = (m.getControllerNumber() == b.data1 + 32) ? m.getControllerValue() : 0;
        const int v   = (msb << 7) | lsb;                 // 0..16383
        norm = v / 16383.0;
        bip  = v < 8192 ? (v - 8192) / 8192.0 : (v - 8192) / 8191.0;
    }
    else if (m.isController())
    {
        const int cc = m.getControllerValue();
        norm = cc / 127.0;
        bip  = cc < 64 ? (cc - 64) / 64.0 : (cc - 64) / 63.0;
    }
    else if (m.isPitchWheel())
    {
        const int v = m.getPitchWheelValue();
        norm = v / 16383.0;
        bip  = v < 8192 ? (v - 8192) / 8192.0 : (v - 8192) / 8191.0;
    }

    switch (b.action)
    {
        case MidiAction::PlayPause:
            if (pressed)
            {
                // CUE+PLAY: while previewing, PLAY latches into normal playback.
                const bool previewing = b.deck >= 0 && b.deck < kNumDecks
                                      && decks[b.deck].cuePreview.load();
                if (previewing || ! isDeckPlaying (b.deck)) deckPlay (b.deck);
                else deckPause (b.deck);
            }
            break;
        case MidiAction::Play:   if (pressed) deckPlay (b.deck);  break;
        case MidiAction::Pause:  if (pressed) deckPause (b.deck); break;
        case MidiAction::CueButton:
            if (pressed)  deckCueDown (b.deck);
            if (released) deckCueUp (b.deck);
            break;
        case MidiAction::Sync:      if (pressed) deckSync (b.deck); break;
        case MidiAction::CueEnable: if (pressed) setDeckCueEnabled (b.deck, ! isDeckCueEnabled (b.deck)); break;

        // Hot cue pads: EMPTY → SET (record position, pad lights); SET → JUMP.
        // Holding SHIFT + pad = CLEAR (separate clearHotCue binding).
        // The pad lights on the RX3 will NOT update without HID mode, but
        // the cue points work and are shown on the ROCKDJ waveform.
        case MidiAction::HotCue:
            if (pressed)
            {
                const int slot = (int) b.param;
                if (isHotCueSet (b.deck, slot)) jumpHotCue  (b.deck, slot);
                else                            setHotCue   (b.deck, slot);
            }
            break;
        case MidiAction::Pad1: case MidiAction::Pad2: case MidiAction::Pad3:
        case MidiAction::Pad4: case MidiAction::Pad5: case MidiAction::Pad6:
        case MidiAction::Pad7: case MidiAction::Pad8:
        {
            // Slot = 0..7 derived from the action enum offset.
            const int slot = (int)b.action - (int)MidiAction::Pad1;
            if (pressed)
            {
                if (isHotCueSet (b.deck, slot)) jumpHotCue  (b.deck, slot);
                else                            setHotCue   (b.deck, slot);
            }
            break;
        }
        case MidiAction::ClearHotCue:
            if (pressed) deleteHotCue (b.deck, (int) b.param);
            break;

        case MidiAction::LoopIn:    if (pressed) deckLoopIn (b.deck);      break;
        case MidiAction::LoopOut:   if (pressed) deckLoopOut (b.deck);     break;
        case MidiAction::LoopBeats: if (pressed) deckLoopBeats (b.deck, b.param); break;
        case MidiAction::LoopExit:  if (pressed) deckLoopExit (b.deck);    break;
        case MidiAction::Reloop:
            if (pressed)
            {
                // RELOOP/EXIT on hardware is one button: exit if looping, reloop if not.
                if (isDeckLooping (b.deck)) deckLoopExit (b.deck);
                else                        deckReloop (b.deck);
            }
            break;

        case MidiAction::Rate:
        {
            const int stored = getDeckTempoRange (b.deck);
            const double range = (b.param > 0.0) ? b.param : (double) stored;
            setDeckRate (b.deck, 1.0 + bip * (range / 100.0));
            break;
        }
        case MidiAction::TempoRange:
            if (pressed) cycleDeckTempoRange (b.deck);
            break;

        case MidiAction::Crossfader: setCrossfader ((float) norm); break;
        case MidiAction::DeckGain:   setDeckGain (b.deck, (float) norm); break;
        case MidiAction::MasterGain: setMasterGain ((float) (norm * 2.0)); break;
        case MidiAction::DeckTrim:   setDeckTrim (b.deck, (float) (bip * 12.0)); break;
        case MidiAction::Filter:     setDeckFilter (b.deck, (float) bip); break;
        case MidiAction::EqLow:
        case MidiAction::EqMid:
        case MidiAction::EqHigh:
        {
            const float dB = (float) (bip < 0.0 ? bip * 26.0 : bip * 6.0);
            const float lo = b.action == MidiAction::EqLow  ? dB : getDeckEqLow  (b.deck);
            const float mi = b.action == MidiAction::EqMid  ? dB : getDeckEqMid  (b.deck);
            const float hi = b.action == MidiAction::EqHigh ? dB : getDeckEqHigh (b.deck);
            setDeckEq (b.deck, lo, mi, hi);
            break;
        }

        case MidiAction::Jog:          // ring: nudge while playing, search while paused
        {
            if (! m.isController()) break;
            const int ticks = decodeRelative (m.getControllerValue(), b.relMode);
            deckJog (b.deck, ticks * (b.param > 0.0 ? b.param : 1.0));
            break;
        }
        case MidiAction::JogScratch:   // platter, VINYL mode: scrub the playhead
        {
            if (! m.isController()) break;
            const int ticks = decodeRelative (m.getControllerValue(), b.relMode);
            deckScratch (b.deck, ticks * (b.param > 0.0 ? b.param : 1.0));
            break;
        }

        case MidiAction::FxOn:
            // When b.deck == -1 (global binding), apply to the master deck.
            // For per-deck use, b.deck is 0 or 1 as normal.
            if (pressed)
            {
                const int d = (b.deck < 0) ? masterDeck.load() : b.deck;
                setDeckFxOn (d, ! getDeckFxOn (d));
            }
            break;
        case MidiAction::FxDepth:
        {
            const int d = (b.deck < 0) ? masterDeck.load() : b.deck;
            setDeckFxDepth (d, (float) norm);
            break;
        }

        // ── Library: forwarded to the UI (the engine has no song database) ──
        // CF ASSIGN switch: ONE physical switch sends ONE CC whose value encodes
        // the position. The switch above the crossfader on the XDJ-RX3 uses:
        //   0-42   → A    (deck assigned to crossfader side A)
        //   43-84  → THRU (crossfader bypassed; mix on the channel fader)
        //   85-127 → B    (deck assigned to crossfader side B)
        // This fires for both notes (pressed) AND CC messages (any value).
        case MidiAction::XfAssign:
        {
            XfAssign assign = XfAssign::Thru;
            if (m.isController())
            {
                const int v = m.getControllerValue();
                assign = v < 43 ? XfAssign::A : v < 85 ? XfAssign::Thru : XfAssign::B;
            }
            else if (pressed)
            {
                // Note-based: use param to specify 0=A, 1=Thru, 2=B
                assign = b.param < 0.5 ? XfAssign::A
                       : b.param < 1.5 ? XfAssign::Thru
                       :                 XfAssign::B;
            }
            if (pressed || m.isController())
            {
                // b.deck == -1 means "both decks" (switch above the crossfader
                // is global — it assigns ALL channels simultaneously)
                if (b.deck < 0)
                    for (int di = 0; di < kNumDecks; ++di) setDeckXfAssign (di, assign);
                else
                    setDeckXfAssign (b.deck, assign);
            }
            break;
        }
        case MidiAction::LibraryUp:
        case MidiAction::LibraryDown:
        {
            std::function<void (const juce::String&, int)> cb;
            { const juce::ScopedLock sl (midiLock); cb = libraryCallback; }
            if (! cb) break;
            if (m.isController())
            {
                const int ticks = decodeRelative (m.getControllerValue(), b.relMode);
                if (ticks != 0) cb ("scroll", ticks);
            }
            else if (pressed)
                cb (b.action == MidiAction::LibraryUp ? "up" : "down", 1);
            break;
        }
        case MidiAction::LibrarySelect:
            if (pressed)
            { std::function<void (const juce::String&, int)> cb; { const juce::ScopedLock sl (midiLock); cb = libraryCallback; } if (cb) cb ("select", 0); }
            break;
        case MidiAction::LibraryLoad0:
            if (pressed)
            { std::function<void (const juce::String&, int)> cb; { const juce::ScopedLock sl (midiLock); cb = libraryCallback; } if (cb) cb ("load0", 0); }
            break;
        case MidiAction::LibraryLoad1:
            if (pressed)
            { std::function<void (const juce::String&, int)> cb; { const juce::ScopedLock sl (midiLock); cb = libraryCallback; } if (cb) cb ("load1", 0); }
            break;

        case MidiAction::None: default: break;
    }
}

void AudioEngine::setMasterGain (float linear)
{
    masterGain.store (juce::jlimit (0.0f, 2.0f, linear));
}

float AudioEngine::getMasterGain() const { return masterGain.load(); }

void AudioEngine::setDeckTrim (int deckIndex, float dB)
{
    if (deckIndex >= 0 && deckIndex < kNumDecks)
        deckTrim[deckIndex].store (juce::jlimit (-12.0f, 12.0f, dB));
}

float AudioEngine::getDeckTrim (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks ? deckTrim[deckIndex].load() : 0.0f;
}

void AudioEngine::setCrossfader (float position01)
{
    crossfader.store (juce::jlimit (0.0f, 1.0f, position01));
}

void AudioEngine::setMasterDeck (int deckIndex)
{
    if (deckIndex >= 0 && deckIndex < kNumDecks)
    {
        masterDeck.store (deckIndex);
        autoMaster.store (false);      // an explicit choice pins it
    }
}

void AudioEngine::setAutoMaster (bool shouldAuto) { autoMaster.store (shouldAuto); }

void AudioEngine::setDeckMasterTempo (int deckIndex, bool on)
{
    if (deckIndex >= 0 && deckIndex < kNumDecks) decks[deckIndex].masterTempo.store (on);
}

bool AudioEngine::getDeckMasterTempo (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks && decks[deckIndex].masterTempo.load();
}

void AudioEngine::setDeckXfAssign (int deckIndex, XfAssign a)
{
    if (deckIndex >= 0 && deckIndex < kNumDecks) xfAssign[deckIndex].store (a);
}

AudioEngine::XfAssign AudioEngine::getDeckXfAssign (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks ? xfAssign[deckIndex].load() : XfAssign::Thru;
}

float AudioEngine::getDeckAudibleLevel (int deckIndex) const
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return 0.0f;
    const Deck& d = decks[deckIndex];
    if (! d.playing.load() || d.stems.empty()) return 0.0f;
    const float x = crossfader.load();
    float xf = 1.0f;
    switch (xfAssign[deckIndex].load())
    {
        case XfAssign::A:    xf = std::cos (x * juce::MathConstants<float>::halfPi); break;
        case XfAssign::B:    xf = std::sin (x * juce::MathConstants<float>::halfPi); break;
        case XfAssign::Thru: xf = 1.0f; break;   // crossfader bypassed
    }
    return d.gain.load() * xf;
}

//==============================================================================
// Live stem control (Band Master) — atomics, safe while playing
//==============================================================================

static bool validStem (const std::vector<std::unique_ptr<AudioEngine::DeckStem>>& v, int i)
{
    return i >= 0 && i < (int) v.size();
}

void AudioEngine::setDeckStemGain (int deckIndex, int stemIndex, float linearGain)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    auto& v = decks[deckIndex].stems;
    if (validStem (v, stemIndex)) v[(size_t) stemIndex]->gain.store (juce::jlimit (0.0f, 4.0f, linearGain));
}

void AudioEngine::setDeckStemMute (int deckIndex, int stemIndex, bool muted)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    auto& v = decks[deckIndex].stems;
    if (validStem (v, stemIndex)) v[(size_t) stemIndex]->muted.store (muted);
}

void AudioEngine::setDeckStemRoute (int deckIndex, int stemIndex, Route r)
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    auto& v = decks[deckIndex].stems;
    if (validStem (v, stemIndex)) v[(size_t) stemIndex]->route.store (r);
}

int AudioEngine::getDeckNumStems (int deckIndex) const
{
    std::lock_guard<std::recursive_mutex> readLock (loadSerialMutex);
    if (deckIndex < 0 || deckIndex >= kNumDecks) return 0;
    return (int) decks[deckIndex].stems.size();
}

juce::String AudioEngine::getDeckStemName (int deckIndex, int stemIndex) const
{
    std::lock_guard<std::recursive_mutex> readLock (loadSerialMutex);
    if (deckIndex < 0 || deckIndex >= kNumDecks) return {};
    const auto& v = decks[deckIndex].stems;
    return validStem (v, stemIndex) ? v[(size_t) stemIndex]->name : juce::String();
}

float AudioEngine::getDeckStemGain (int deckIndex, int stemIndex) const
{
    std::lock_guard<std::recursive_mutex> readLock (loadSerialMutex);
    if (deckIndex < 0 || deckIndex >= kNumDecks) return 1.0f;
    const auto& v = decks[deckIndex].stems;
    return validStem (v, stemIndex) ? v[(size_t) stemIndex]->gain.load() : 1.0f;
}

bool AudioEngine::getDeckStemMuted (int deckIndex, int stemIndex) const
{
    std::lock_guard<std::recursive_mutex> readLock (loadSerialMutex);
    if (deckIndex < 0 || deckIndex >= kNumDecks) return false;
    const auto& v = decks[deckIndex].stems;
    return validStem (v, stemIndex) ? v[(size_t) stemIndex]->muted.load() : false;
}

bool AudioEngine::isDeckStemIem (int deckIndex, int stemIndex) const
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return false;
    const auto& v = decks[deckIndex].stems;
    return validStem (v, stemIndex) && v[(size_t) stemIndex]->route.load() == Route::IEM;
}

bool AudioEngine::isDeckPlaying (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks && decks[deckIndex].playing.load();
}

bool AudioEngine::deckLoaded (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks && ! decks[deckIndex].stems.empty();
}

double AudioEngine::getDeckSeconds (int deckIndex) const
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return 0.0;
    const double sr = currentSampleRate.load();
    return sr > 0 ? (double) decks[deckIndex].playhead.load() / sr : 0.0;
}

double AudioEngine::getDeckCueSeconds (int deckIndex) const
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return 0.0;
    const double sr = currentSampleRate.load();
    return sr > 0 ? (double) decks[deckIndex].cuePoint.load() / sr : 0.0;
}

bool AudioEngine::isDeckCuePreviewing (int deckIndex) const
{
    return deckIndex >= 0 && deckIndex < kNumDecks && decks[deckIndex].cuePreview.load();
}

double AudioEngine::getDeckDownbeatSeconds (int deckIndex) const
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return 0.0;
    const double sr = currentSampleRate.load();
    return sr > 0 ? (double) decks[deckIndex].downbeat.load() / sr : 0.0;
}

double AudioEngine::getDeckDurationSeconds (int deckIndex) const
{
    std::lock_guard<std::recursive_mutex> readLock (loadSerialMutex);
    if (deckIndex < 0 || deckIndex >= kNumDecks) return 0.0;
    const double sr = currentSampleRate.load();
    return sr > 0 ? (double) decks[deckIndex].lengthSamples.load() / sr : 0.0;
}

double AudioEngine::getDeckBpm (int deckIndex) const
{
    if (deckIndex < 0 || deckIndex >= kNumDecks) return 120.0;
    return decks[deckIndex].bpm.load();
}

double AudioEngine::deckBeatsNow() const
{
    const int m = masterDeck.load();
    const Deck& d = decks[m];
    const double sr = currentSampleRate.load();
    if (sr <= 0.0) return 0.0;
    const double spb = sr * 60.0 / d.bpm.load();
    return spb > 0.0 ? (double) (d.playhead.load() - d.downbeat.load()) / spb : 0.0;
}

void AudioEngine::getDeckWaveform (int deckIndex, std::vector<float>& dest, int numBuckets) const
{
    std::lock_guard<std::recursive_mutex> readLock (loadSerialMutex);
    dest.clear();
    if (deckIndex < 0 || deckIndex >= kNumDecks) return;
    const Deck& d = decks[deckIndex];
    const int total = d.lengthSamples.load();
    if (total <= 0 || numBuckets <= 0 || d.stems.empty()) return;

    dest.resize ((size_t) numBuckets, 0.0f);
    const int per = juce::jmax (1, total / numBuckets);
    for (int b = 0; b < numBuckets; ++b)
    {
        const int start = b * per;
        const int end   = juce::jmin (total, start + per);
        float peak = 0.0f;
        for (const auto& st : d.stems)                 // waveform of the whole track
        {
            const int len = st->buffer.getNumSamples();
            for (int i = start; i < juce::jmin (end, len); ++i)
                for (int c = 0; c < st->buffer.getNumChannels(); ++c)
                    peak = juce::jmax (peak, std::abs (st->buffer.getSample (c, i)));
        }
        dest[(size_t) b] = juce::jmin (1.0f, peak);
    }
}

bool AudioEngine::loadSample (const juce::File& file)
{
    stop();
    std::unique_ptr<juce::AudioFormatReader> reader (formatManager.createReaderFor (file));
    if (reader == nullptr)
        return false;

    const int numCh  = (int) reader->numChannels;
    const int numLen = (int) reader->lengthInSamples;
    sampleBuffer.setSize (numCh, numLen);
    reader->read (&sampleBuffer, 0, numLen, 0, true, true);

    sampleFireAt.store (-1);
    samplePlayPos.store (-1);
    return true;
}

//==============================================================================
// Transport
//==============================================================================

void AudioEngine::play()
{
    // Reset the sample launcher's armed/playing state on a fresh start.
    if (! playing.load())
    {
        sampleFireAt.store (-1);
        samplePlayPos.store (-1);
    }
    playing.store (true);
}

void AudioEngine::pause()
{
    // Hold position: stop advancing but leave the playhead where it is, so
    // play() resumes from the same spot.
    playing.store (false);
}

void AudioEngine::stop()
{
    playing.store (false);
    playhead.store (0);
    sampleFireAt.store (-1);
    samplePlayPos.store (-1);
}

void AudioEngine::seek (double seconds)
{
    const double sr = currentSampleRate.load();
    const int64_t target = (int64_t) std::llround (juce::jmax (0.0, seconds) * sr);
    playhead.store (target);
}

//==============================================================================
// Per-stem routing
//==============================================================================

void AudioEngine::setStemRoute (int index, Route r)
{
    if (index >= 0 && index < (int) stems.size())
        stems[(size_t) index]->route.store (r); // atomic - safe while playing
}

void AudioEngine::setStemGain (int index, float linearGain)
{
    if (index >= 0 && index < (int) stems.size())
        stems[(size_t) index]->gain.store (juce::jlimit (0.0f, 4.0f, linearGain));
}

void AudioEngine::setStemMute (int index, bool muted)
{
    if (index >= 0 && index < (int) stems.size())
        stems[(size_t) index]->muted.store (muted);
}

AudioEngine::Route AudioEngine::getStemRoute (int index) const
{
    if (index >= 0 && index < (int) stems.size())
        return stems[(size_t) index]->route.load();
    return Route::FOH;
}

juce::String AudioEngine::getStemName (int index) const
{
    if (index >= 0 && index < (int) stems.size())
        return stems[(size_t) index]->name;
    return {};
}

//==============================================================================
// Quantized launch
//==============================================================================

void AudioEngine::triggerSampleQuantized()
{
    if (sampleBuffer.getNumSamples() == 0)
        return;

    const int64_t now = playhead.load();
    const double  spb = samplesPerBar();
    if (spb <= 0.0)
        return;

    // Which bar are we in, and where is the NEXT bar line?
    const int64_t currentBar   = (int64_t) std::floor ((double) now / spb);
    const int64_t nextBoundary = (int64_t) std::llround ((double) (currentBar + 1) * spb);

    samplePlayPos.store (-1);           // not playing yet, just armed
    sampleFireAt.store (nextBoundary);  // fire exactly on the bar line
}

//==============================================================================
// Status readers (message thread)
//==============================================================================

double AudioEngine::getPlayheadSeconds() const
{
    const double sr = currentSampleRate.load();
    return sr > 0 ? (double) playhead.load() / sr : 0.0;
}

double AudioEngine::getBeatsUntilSampleFires() const
{
    const int64_t fireAt = sampleFireAt.load();
    if (fireAt < 0 || samplePlayPos.load() >= 0)
        return -1.0; // nothing armed, or already firing

    const int64_t now = playhead.load();
    const double  spBeat = samplesPerBeat();
    return spBeat > 0 ? (double) (fireAt - now) / spBeat : -1.0;
}

//==============================================================================
// THE REAL-TIME AUDIO CALLBACK
//
// This runs on a high-priority thread hundreds of times per second. Two rules:
//   * never allocate memory or lock here,
//   * never block.
// Everything below only reads pre-loaded buffers and does arithmetic.
//==============================================================================

void AudioEngine::audioDeviceIOCallbackWithContext (const float* const* /*inputChannelData*/,
                                                    int /*numInputChannels*/,
                                                    float* const* outputChannelData,
                                                    int numOutputChannels,
                                                    int numSamples,
                                                    const juce::AudioIODeviceCallbackContext& /*context*/)
{
    // 1. Start every output channel from silence.
    for (int ch = 0; ch < numOutputChannels; ++ch)
        if (outputChannelData[ch] != nullptr)
            juce::FloatVectorOperations::clear (outputChannelData[ch], numSamples);

    // Physical channel map (see header). Guarded below in case the device
    // only exposes 2 outputs.
    // Routing is configurable at run time; -1 = bus not connected. Every write
    // below is bounds-checked against the device's real channel count.
    const int FOH_L = routeFohL.load(), FOH_R = routeFohR.load();
    const int IEM_L = routeIemL.load(), IEM_R = routeIemR.load();
    const int CUE_L = routeCueL.load(), CUE_R = routeCueR.load();
    const int DA_L  = routeDeckAL.load(), DA_R  = routeDeckAR.load();
    const int DB_L  = routeDeckBL.load(), DB_R  = routeDeckBR.load();
    const float cueG = cueGain.load();
    const float mGain = masterGain.load();
    float masterBlockPeak = 0.0f;
    const bool doMasterCue = masterCueEnabled.load() && (CUE_L >= 0 || CUE_R >= 0);
    auto out = [&] (int ch, int n, float v)
    {
        if (ch >= 0 && ch < numOutputChannels)
        {
            const float scaled = v * mGain;
            outputChannelData[ch][n] += scaled;
            if (ch == FOH_L || ch == FOH_R)
                masterBlockPeak = std::max (masterBlockPeak, std::abs (scaled));
        }
    };

    // ── DJ decks (independent of the band transport) ─────────────────────────
    // Each deck plays ALL its stems at ONE shared playhead (sample-locked by
    // construction), applying per-stem gain/mute (the Band Master's live
    // control) and per-stem route: FOH stems go to the room through the deck
    // fader + equal-power crossfader; IEM stems (e.g. a click) go straight to
    // the in-ears, unaffected by the crossfader so musicians never lose them.
    {
        const float x = crossfader.load();
        // Per-deck crossfader assign (DJM behaviour). THRU takes the crossfader
        // out of the path so a fader-mixing DJ can actually reach unity.
        float xfGain[2];
        for (int i = 0; i < kNumDecks; ++i)
            switch (xfAssign[i].load())
            {
                case XfAssign::A:    xfGain[i] = std::cos (x * juce::MathConstants<float>::halfPi); break;
                case XfAssign::B:    xfGain[i] = std::sin (x * juce::MathConstants<float>::halfPi); break;
                case XfAssign::Thru:
                default:             xfGain[i] = 1.0f; break;
            }

        // ── Follow the DJ's hands ────────────────────────────────────────────
        // The master deck is whatever the ROOM is hearing, because that is the
        // song the band is playing and the song the Band Master must ride. With
        // fader mixing there is no crossfader position to read it from, so it
        // comes from each deck's audible contribution.
        //
        // Hysteresis matters: during a blend both decks are up and the levels
        // cross slowly. Requiring the challenger to be meaningfully louder for
        // a sustained moment stops the lyrics flickering between two songs at
        // the crossover - which would be worse than useless on stage.
        if (autoMaster.load())
        {
            const float lvl[2] = { getDeckAudibleLevel (0), getDeckAudibleLevel (1) };
            const int cur = juce::jlimit (0, kNumDecks - 1, masterDeck.load());
            const int oth = 1 - cur;
            const double sr = currentSampleRate.load();
            const double blockSec = sr > 0.0 ? (double) numSamples / sr : 0.0;

            if (lvl[cur] <= 0.0001f && lvl[oth] > 0.0001f)
            {
                masterDeck.store (oth);          // current deck silent: take over now
                masterSwitchAccum = 0.0;
            }
            else if (lvl[oth] > lvl[cur] * 1.25f && lvl[oth] > 0.05f)
            {
                masterSwitchAccum += blockSec;   // challenger ~2dB louder
                if (masterSwitchAccum >= 0.25)   // ...and has held it
                {
                    masterDeck.store (oth);
                    masterSwitchAccum = 0.0;
                }
            }
            else
            {
                masterSwitchAccum = 0.0;
            }
        }

        // Read one stem channel at a fractional position (linear interpolation).
        auto readAt = [] (const juce::AudioBuffer<float>& buf, int ch, double p, int len) -> float
        {
            const int i = (int) p;
            if (i < 0 || i >= len) return 0.0f;
            const float a = buf.getSample (ch, i);
            const float b = (i + 1 < len) ? buf.getSample (ch, i + 1) : a;
            return a + (float) (p - (double) i) * (b - a);
        };

        const bool busReady = deckBus.getNumSamples() >= numSamples
                              && (int) posBuf.size() >= numSamples;

        for (int di = 0; di < kNumDecks; ++di)
        {
            Deck& d = decks[di];
            // CRITICAL: skip this deck while its stems vector is being modified.
            // reloading=true is set BEFORE stems.clear() with a 60ms sleep to ensure
            // this check has been seen at least 5 times (blocks are ~11ms each).
            if (d.reloading.load (std::memory_order_acquire)) continue;
            if (! d.playing.load() || d.stems.empty())
                continue;
            if (! busReady) continue;   // scratch not sized yet: stay silent

            // The pitch bend rides on top of the deck's tempo. This reuses the
            // variable-rate playback built for SYNC - a nudge is just a brief
            // tempo change, so it costs nothing extra.
            const double bend  = d.jogBend.load();
            const double rate  = d.rate.load() * (1.0 + bend);
            const double start = (double) d.playhead.load() + d.posFrac;
            const int    len   = d.lengthSamples.load();
            const float  deckG = d.gain.load();
            const float  fohG  = deckG * xfGain[di];

            // ── Position sequence for this block ─────────────────────────────
            // Computed ONCE per deck and shared by every stem, so a loop wrap
            // can never desynchronise the stems from each other — the same
            // guarantee the single playhead gives us everywhere else.
            const bool  looping  = d.loopActive.load();
            const int64_t lStart = d.loopStart.load();
            const int64_t lEnd   = d.loopEnd.load();
            const bool  loopOk   = looping && lStart >= 0 && lEnd > lStart;
            const double loopLen = loopOk ? (double) (lEnd - lStart) : 0.0;

            double p = start;
            if (loopOk && p >= (double) lEnd)     // loop shrank under the playhead
                p = (double) lStart;
            for (int n = 0; n < numSamples; ++n)
            {
                if (loopOk)
                {
                    // Wrap, keeping the sub-sample remainder so the loop stays
                    // sample-exact at any tempo (no drift over long holds).
                    while (p >= (double) lEnd) p -= loopLen;
                }
                posBuf[n] = p;
                p += rate;
            }

            // Recompute EQ/filter coefficients if a knob moved (cheap math, no
            // allocation — safe on the audio thread).
            if (d.eqDirty.exchange (false))
                refreshDeckEq (d, currentSampleRate.load());
            const bool anyEq = busReady && (d.eqLow.active || d.eqMid.active
                                            || d.eqHigh.active || d.filter.active);

            // ── Stems → two buses (room + in-ears) ───────────────────────────
            // Both buses are mixed from the SAME posBuf and, when Master Tempo
            // is on, pitch-corrected by IDENTICAL stretchers - so the click can
            // never drift away from the music.
            if (busReady)
            {
                deckBus.clear (0, 0, numSamples);
                deckBus.clear (1, 0, numSamples);
                iemBus.clear (0, 0, numSamples);
                iemBus.clear (1, 0, numSamples);
                float* busL = deckBus.getWritePointer (0);
                float* busR = deckBus.getWritePointer (1);
                float* iemL = iemBus.getWritePointer (0);
                float* iemR = iemBus.getWritePointer (1);

                for (const auto& stPtr : d.stems)
                {
                    const DeckStem& st = *stPtr;
                    if (st.muted.load()) continue;
                    const bool toIem = st.route.load() == Route::IEM;
                    float* dstL = toIem ? iemL : busL;
                    float* dstR = toIem ? iemR : busR;
                    const float sg   = st.gain.load();
                    const int   sLen = st.buffer.getNumSamples();
                    const int   ch   = st.buffer.getNumChannels();
                    for (int n = 0; n < numSamples; ++n)
                    {
                        const double pos = posBuf[n];
                        if (pos >= sLen) continue;
                        const float l = readAt (st.buffer, 0, pos, sLen) * sg;
                        dstL[n] += l;
                        dstR[n] += (ch > 1 ? readAt (st.buffer, 1, pos, sLen) * sg : l);
                    }
                }

                // ── Master Tempo ─────────────────────────────────────────────
                // We already changed tempo by resampling (which moved the key
                // too). Shifting back by 1/rate restores the original key and
                // leaves the new tempo. Compensating d.rate but NOT the jog
                // bend is deliberate: sync holds its key, a nudge still bends.
                if (d.masterTempo.load())
                {
                    const double baseRate = d.rate.load();
                    const float  transpose = (float) (baseRate > 0.0 ? 1.0 / baseRate : 1.0);

                    // Any jump in the playhead (cue, hot cue, seek, reloop) makes
                    // the stretcher's history wrong. outputSeek() re-primes it
                    // from the new spot AND pre-computes the latency's worth of
                    // output, so playback resumes with no added delay - which is
                    // what keeps the CUE stutter feeling instant.
                    const bool jumped = (! d.stretchPrimed)
                                     || d.lastEndPos < 0.0
                                     || std::abs (start - d.lastEndPos) > 2.0;
                    if (jumped)
                    {
                        const int need = juce::jmin (preRollFoh.getNumSamples(),
                                                     d.stretchFoh.outputSeekLength (1.0f));
                        preRollFoh.clear(); preRollIem.clear();
                        float* pf[2] = { preRollFoh.getWritePointer (0), preRollFoh.getWritePointer (1) };
                        float* pi[2] = { preRollIem.getWritePointer (0), preRollIem.getWritePointer (1) };
                        for (const auto& stPtr : d.stems)
                        {
                            const DeckStem& st = *stPtr;
                            if (st.muted.load()) continue;
                            const bool toIem = st.route.load() == Route::IEM;
                            float** dst = toIem ? pi : pf;
                            const float sg = st.gain.load();
                            const int sLen = st.buffer.getNumSamples();
                            const int ch = st.buffer.getNumChannels();
                            for (int n = 0; n < need; ++n)
                            {
                                const double pos = start - (double) (need - n) * rate;
                                if (pos < 0.0 || pos >= sLen) continue;
                                const float l = readAt (st.buffer, 0, pos, sLen) * sg;
                                dst[0][n] += l;
                                dst[1][n] += (ch > 1 ? readAt (st.buffer, 1, pos, sLen) * sg : l);
                            }
                        }
                        d.stretchFoh.setTransposeFactor (transpose);
                        d.stretchIem.setTransposeFactor (transpose);
                        d.stretchFoh.outputSeek (pf, need);
                        d.stretchIem.outputSeek (pi, need);
                        d.stretchPrimed = true;
                    }
                    else
                    {
                        d.stretchFoh.setTransposeFactor (transpose);
                        d.stretchIem.setTransposeFactor (transpose);
                    }

                    // Equal in/out sample counts = pure pitch shift, no time change.
                    // Output MUST go to a separate buffer, then be copied back.
                    float* fohIn[2]  = { busL, busR };
                    float* iemIn[2]  = { iemL, iemR };
                    float* outP[2]   = { stretchOut.getWritePointer (0), stretchOut.getWritePointer (1) };

                    d.stretchFoh.process (fohIn, numSamples, outP, numSamples);
                    juce::FloatVectorOperations::copy (busL, outP[0], numSamples);
                    juce::FloatVectorOperations::copy (busR, outP[1], numSamples);

                    d.stretchIem.process (iemIn, numSamples, outP, numSamples);
                    juce::FloatVectorOperations::copy (iemL, outP[0], numSamples);
                    juce::FloatVectorOperations::copy (iemR, outP[1], numSamples);
                }
                else
                {
                    d.stretchPrimed = false;   // force a re-prime if MT comes back on
                }

                // TRIM: applied pre-EQ so it matches levels before the mix,
                // exactly like the TRIM/GAIN knob on a real mixer channel.
                const float trimLinear = std::pow (10.0f, deckTrim[di].load() / 20.0f);
                if (std::abs (trimLinear - 1.0f) > 0.001f)
                    for (int n = 0; n < numSamples; ++n)
                    { busL[n] *= trimLinear; busR[n] *= trimLinear; }

                if (anyEq)
                    for (int n = 0; n < numSamples; ++n)
                        for (int c = 0; c < 2; ++c)
                        {
                            float* bus = c == 0 ? busL : busR;
                            float v = bus[n];
                            if (d.eqLow.active)   v = d.eqLow.process   (c, v);
                            if (d.eqMid.active)   v = d.eqMid.process   (c, v);
                            if (d.eqHigh.active)  v = d.eqHigh.process  (c, v);
                            if (d.filter.active)  v = d.filter.process  (c, v);
                            bus[n] = v;
                        }

                // ── BEAT FX (echo or reverb) — BEFORE the FOH write ────────────
                // The previous build had the echo AFTER the output write — the
                // processed signal was modifying busL/busR that had already been
                // sent to the hardware. Fixed here.
                const bool fxActive = d.fxOn.load();
                const float fxWet   = d.fxDepth.load();
                const int   fxMode  = d.fxMode.load();

                if (! d.echoL.empty())
                {
                    if (fxMode == 0)
                    {
                        // ── Echo: beat-synced delay ──────────────────────────
                        const double bpmNow  = d.bpm.load() * d.rate.load();
                        const double beatsec = bpmNow > 0.0 ? 60.0 / bpmNow : 0.5;
                        const int delaySmp   = juce::jlimit (512, (int) d.echoL.size() - numSamples - 1,
                                                             (int) (beatsec * currentSampleRate.load()));
                        const float wet = fxActive ? fxWet : 0.0f;
                        const float fb  = 0.48f;
                        const int   eLen = (int) d.echoL.size();
                        for (int n = 0; n < numSamples; ++n)
                        {
                            const int rp = (d.echoWritePos - delaySmp + eLen) % eLen;
                            const float dl = d.echoL[rp], dr = d.echoR[rp];
                            d.echoL[d.echoWritePos] = busL[n] + dl * fb;
                            d.echoR[d.echoWritePos] = busR[n] + dr * fb;
                            busL[n] += dl * wet;
                            busR[n] += dr * wet;
                            d.echoWritePos = (d.echoWritePos + 1) % eLen;
                        }
                    }
                    else if (fxMode == 1 && fxActive && ! d.combL[0].b.empty())
                    {
                        // ── Reverb: Schroeder plate (4 comb + 2 allpass) ─────
                        // roomSize 0..1 controls comb feedback; 0.85 is a medium
                        // hall. damping softens HF so it sounds like a real room.
                        const float room   = 0.75f + fxWet * 0.20f;  // 0.75..0.95
                        const float damp   = 0.4f;
                        const float wet    = fxWet * 0.35f;           // keep it subtle
                        for (int n = 0; n < numSamples; ++n)
                        {
                            const float inL = busL[n], inR = busR[n];
                            float revL = 0.0f, revR = 0.0f;
                            // Comb filters in parallel (standard Schroeder, stable)
                            for (int k = 0; k < 4; ++k)
                            {
                                auto& cL = d.combL[k]; auto& cR = d.combR[k];
                                const int szL = (int) cL.b.size(), szR = (int) cR.b.size();
                                const float oL = cL.b[cL.pos], oR = cR.b[cR.pos];
                                // Damping: lowpass on the feedback path keeps HF from ringing.
                                // Uses a static per-filter last_damp value; approximated here
                                // as simple one-pole: filtered_fb = fb * (1-damp) + prev * damp.
                                // For simplicity: fb = room, gentle HF rolloff via coefficient.
                                cL.b[cL.pos] = inL + oL * room * (1.0f - damp * 0.5f);
                                cR.b[cR.pos] = inR + oR * room * (1.0f - damp * 0.5f);
                                if (++cL.pos >= szL) cL.pos = 0;
                                if (++cR.pos >= szR) cR.pos = 0;
                                revL += oL; revR += oR;
                            }
                            revL *= 0.25f; revR *= 0.25f;
                            // Allpass filters in series
                            for (int k = 0; k < 2; ++k)
                            {
                                auto& aL = d.apL[k]; auto& aR = d.apR[k];
                                const int szL = (int) aL.b.size(), szR = (int) aR.b.size();
                                const float oL = aL.b[aL.pos], oR = aR.b[aR.pos];
                                aL.b[aL.pos] = revL + oL * 0.5f;
                                aR.b[aR.pos] = revR + oR * 0.5f;
                                if (++aL.pos >= szL) aL.pos = 0;
                                if (++aR.pos >= szR) aR.pos = 0;
                                revL = oL - revL * 0.5f;
                                revR = oR - revR * 0.5f;
                            }
                            busL[n] += revL * wet;
                            busR[n] += revR * wet;
                        }
                    }
                }

                // FOH write + peak tracking for the clip meter
                float blockPeak = 0.0f;
                for (int n = 0; n < numSamples; ++n)
                {
                    const float sL = busL[n] * fohG, sR = busR[n] * fohG;
                    out (FOH_L, n, sL);
                    out (FOH_R, n, sR);
                    blockPeak = std::max (blockPeak, std::max (std::abs (sL), std::abs (sR)));
                }
                // Fast drop when silent, slow peak-hold during music
                const float old = d.peakLevel.load();
                float np;
                if (blockPeak > old) np = blockPeak;
                else if (blockPeak < 0.0001f) np = old * 0.92f;
                else np = old * 0.9975f;
                d.peakLevel.store (np < 0.0001f ? 0.0f : np);

                // ── Deck direct output: pre-crossfader feed for external mixer ──
                // Uses its own write path so it never accumulates with FOH.
                {
                    const int DL = (di == 0) ? DA_L : DB_L;
                    const int DR = (di == 0) ? DA_R : DB_R;
                    if (DL >= 0 || DR >= 0)
                        for (int n = 0; n < numSamples; ++n)
                        {
                            const float dL = busL[n] * mGain;
                            const float dR = busR[n] * mGain;
                            if (DL >= 0 && DL < numOutputChannels)
                                outputChannelData[DL][n] += dL;
                            if (DR >= 0 && DR < numOutputChannels)
                                outputChannelData[DR][n] += dR;
                        }
                }

                // ── PFL: the DJ's headphones ─────────────────────────────────
                if (d.cueEnabled.load() && (CUE_L >= 0 || CUE_R >= 0))
                    for (int n = 0; n < numSamples; ++n)
                    {
                        out (CUE_L, n, busL[n] * cueG);
                        out (CUE_R, n, busR[n] * cueG);
                    }

                // ── IEM bus (click) → the in-ears. NO EQ, NO filter: a filter
                // sweep must never take the drummer's click away.
                for (int n = 0; n < numSamples; ++n)
                {
                    const float l = iemL[n] * deckG;
                    const float r = iemR[n] * deckG;
                    // Mono click: when iemR is -1 the sides are summed so a
                    // stereo guide still reaches a single in-ear channel.
                    if (IEM_R < 0) { out (IEM_L, n, (l + r) * 0.5f); }
                    else           { out (IEM_L, n, l); out (IEM_R, n, r); }
                }
            }

    // ── Master CUE: read the already-rendered FOH channels and copy to headphone output ──
    if (doMasterCue)
    {
        const float cueG = 0.7f;
        const float* fohL = (FOH_L >= 0 && FOH_L < numOutputChannels) ? outputChannelData[FOH_L] : nullptr;
        const float* fohR = (FOH_R >= 0 && FOH_R < numOutputChannels) ? outputChannelData[FOH_R] : fohL;
        if (fohL)
            for (int n = 0; n < numSamples; ++n)
            {
                out (CUE_L, n, fohL[n] * cueG);
                out (CUE_R, n, (fohR ? fohR[n] : fohL[n]) * cueG);
            }
    }

    // ── Master peak: fast decay when silent, slow release when signal present ──
    {
        const float oldMp = masterPeak.load();
        float newMp;
        if (masterBlockPeak > oldMp)
            newMp = masterBlockPeak;                // instant attack
        else if (masterBlockPeak < 0.0001f)
            newMp = oldMp * 0.92f;                 // fast drop when truly silent (~0.5s)
        else
            newMp = oldMp * 0.9975f;               // slow peak-hold during music
        masterPeak.store (newMp < 0.0001f ? 0.0f : newMp);
    }
    // ── Decay the jog bend ───────────────────────────────────────────
            // Exponential ease-out: while the DJ keeps pushing, MIDI keeps
            // topping the bend up; the moment they let go it falls back to the
            // deck's real tempo. tau ~70ms reads as "springy but not sloppy".
            if (bend != 0.0)
            {
                const double sr = currentSampleRate.load();
                const double blockSec = sr > 0.0 ? (double) numSamples / sr : 0.0;
                double next = bend * std::exp (-blockSec / jogDecaySeconds.load());
                if (std::abs (next) < 1e-5) next = 0.0;     // settle exactly
                d.jogBend.store (next);
            }

            // ── Advance the shared playhead ──────────────────────────────────
            // `p` already carries every loop wrap from the sequence above.
            const int64_t whole = (int64_t) p;
            d.posFrac = p - (double) whole;
            d.lastEndPos = p;              // next block should continue from here
            d.playhead.store (whole);
            // A looping deck never runs off the end — that's the point of a loop.
            if (! loopOk && whole >= len) d.playing.store (false);   // track ended
        }
    }

    if (! playing.load())
        return; // band transport stopped -> deck (if any) already mixed above

    const int64_t blockStart = playhead.load();

    // Snapshot launch state into locals for this block.
    int64_t       fireAt    = sampleFireAt.load();
    int64_t       samplePos = samplePlayPos.load();
    const int     sampleLen = sampleBuffer.getNumSamples();
    const int     sampleCh  = sampleBuffer.getNumChannels();

    // Walk the block one sample at a time. Per-sample is the clearest way to see
    // that everything is locked to `absolute`. With a handful of stems at 48 kHz
    // this is trivially cheap; production can block-copy for efficiency.
    for (int n = 0; n < numSamples; ++n)
    {
        const int64_t absolute = blockStart + n;

        // -- Mix every stem at the SAME absolute position ------------------
        // Skip if loadSong() is currently modifying the stems vector
        if (loadingSong.load (std::memory_order_acquire)) continue;
        for (const auto& stemPtr : stems)
        {
            const Stem& stem = *stemPtr;
            if (stem.muted.load())
                continue;                       // muted stems contribute nothing

            const int len = stem.buffer.getNumSamples();
            if (absolute >= len)
                continue; // this stem has already ended

            const float g  = stem.gain.load();
            const int   ch = stem.buffer.getNumChannels();
            const float mono = stem.buffer.getSample (0, (int) absolute);
            const float l  = mono * g;
            const float r  = (ch > 1 ? stem.buffer.getSample (1, (int) absolute) : mono) * g;

            if (stem.route.load() == Route::FOH)
            {
                out (FOH_L, n, l);
                out (FOH_R, n, r);
            }
            else // IEM
            {
                if (IEM_R < 0) { out (IEM_L, n, (l + r) * 0.5f); }
                else           { out (IEM_L, n, l); out (IEM_R, n, r); }
            }
        }

        // -- Quantized one-shot: begin exactly on the armed bar line -------
        if (samplePos < 0 && fireAt >= 0 && absolute >= fireAt)
            samplePos = 0; // cross the bar line -> start playing this sample

        if (samplePos >= 0 && samplePos < sampleLen)
        {
            const float sl = sampleBuffer.getSample (0, (int) samplePos);
            const float sr = sampleCh > 1 ? sampleBuffer.getSample (1, (int) samplePos) : sl;

            // The demo sample plays out FOH so the room hears the launch.
            out (FOH_L, n, sl);
            out (FOH_R, n, sr);

            ++samplePos;
            if (samplePos >= sampleLen)
            {
                samplePos = -1; // finished
                fireAt    = -1; // disarm
            }
        }
    }

    // Advance the authoritative clock and publish launch state for the UI.
    playhead.store (blockStart + numSamples);
    samplePlayPos.store (samplePos);
    sampleFireAt.store (fireAt);
}

//==============================================================================
// Clock authority + DJ musical grid
//==============================================================================
//
// Two grids exist:
//   * DJ grid       — a wall-clock tempo grid (djBpm + tapped downbeat anchor).
//                     Runs continuously so the DJ's musical position is always
//                     known, even when no band audio is playing.
//   * ROCKDJ grid   — the band transport: band beats = playhead / samplesPerBeat.
//
// Exactly one is "authoritative" at a time (see Authority). Handoffs and
// quantized launches are scheduled as an absolute beat count on the
// authoritative grid, and executed by clockTick() when that beat is reached.

static double nowMs() { return juce::Time::getMillisecondCounterHiRes(); }

double AudioEngine::djBeatsNow() const
{
    // If the DJ is playing a track in the deck, THAT is the DJ clock — the band
    // locks to the deck's beatgrid. Otherwise fall back to the manual wall-clock
    // grid (tapped BPM), which is the safe source when no deck is loaded.
    if (anyDeckPlaying())
        return deckBeatsNow();

    if (! djRunning.load())
        return djBeatsAtStop.load();                 // frozen while paused
    const double elapsedSec = (nowMs() - djAnchorMs.load()) / 1000.0;
    return djBeatsAtStop.load() + elapsedSec * (djBpm.load() / 60.0);
}

double AudioEngine::rockdjBeatsNow() const
{
    const double spb = samplesPerBeat();
    return spb > 0.0 ? (double) playhead.load() / spb : 0.0;
}

double AudioEngine::authoritativeBeats() const
{
    // During a handoff the OUTGOING master keeps running, so the authoritative
    // position comes from whichever grid is presently master.
    const Authority a = (Authority) authority.load();
    if (a == Authority::DjMaster)     return djBeatsNow();
    if (a == Authority::RockdjMaster) return rockdjBeatsNow();

    // HandoffArmed: use the explicitly-recorded outgoing master's grid.
    const Authority from = (Authority) handoffFrom.load();
    return (from == Authority::DjMaster) ? djBeatsNow() : rockdjBeatsNow();
}

void AudioEngine::applyMaster (Authority target)
{
    if (target == Authority::DjMaster)
    {
        // Ensure the DJ grid is running & anchored.
        if (! djRunning.load()) { djAnchorMs.store (nowMs()); djBeatsAtStop.store (0.0); djRunning.store (true); }
    }
    else // RockdjMaster
    {
        // Engine takes over at the tempo we were following.
        bpm.store (djBpm.load());
    }
    authority.store ((int) target);
}

void AudioEngine::setDjRunning (bool running)
{
    const bool was = djRunning.load();
    if (running && ! was)
    {
        // Resume: re-anchor so the grid continues from where it paused.
        djAnchorMs.store (nowMs());
        djRunning.store (true);
    }
    else if (! running && was)
    {
        // Pause: freeze the current beat count.
        djBeatsAtStop.store (djBeatsNow());
        djRunning.store (false);
    }
}

void AudioEngine::tapDownbeat()
{
    // Define "now" as beat 1. If the deck is playing, anchor to the deck's
    // current position (so the grid locks to the track); otherwise anchor the
    // manual wall-clock grid.
    if (anyDeckPlaying())
    {
        Deck& m = decks[masterDeck.load()];
        m.downbeat.store (m.playhead.load());
        return;
    }
    djAnchorMs.store (nowMs());
    djBeatsAtStop.store (0.0);
    djRunning.store (true);
}

static double nextBoundary (double currentBeats, double boundaryBeats)
{
    if (boundaryBeats <= 0.0) return currentBeats;
    const double n = std::floor (currentBeats / boundaryBeats) + 1.0;
    return n * boundaryBeats;
}

void AudioEngine::armHandoff (Authority target, double boundaryBeats)
{
    if ((Authority) authority.load() == Authority::HandoffArmed)
        cancelHandoff();                         // reset any in-flight handoff first

    const Authority cur = (Authority) authority.load();
    if (cur == target)
        return;                                  // already there

    // Is the OUTGOING master's grid actually advancing? If not (e.g. band
    // stopped, or DJ clock not running), there's no boundary to wait for —
    // switch immediately. This is the "DJ starts the show" case.
    const bool djAdvancing = anyDeckPlaying() || djRunning.load();
    const bool advancing = (cur == Authority::DjMaster) ? djAdvancing
                                                        : playing.load();
    if (! advancing)
    {
        applyMaster (target);
        std::cerr << "[engine] handoff immediate -> " << (target == Authority::DjMaster ? "DJ" : "ROCKDJ") << std::endl;
        return;
    }

    const double fromBeats = (cur == Authority::DjMaster) ? djBeatsNow() : rockdjBeatsNow();
    handoffFrom.store   ((int) cur);
    handoffTarget.store ((int) target);
    handoffAtBeat.store (nextBoundary (fromBeats, boundaryBeats));
    authority.store     ((int) Authority::HandoffArmed);
    std::cerr << "[engine] handoff armed -> " << (target == Authority::DjMaster ? "DJ" : "ROCKDJ")
              << " at beat " << handoffAtBeat.load() << std::endl;
}

void AudioEngine::cancelHandoff()
{
    if ((Authority) authority.load() == Authority::HandoffArmed)
        authority.store (handoffFrom.load());    // revert to the outgoing master
    handoffAtBeat.store (-1.0);
}

void AudioEngine::armLaunch (double boundaryBeats)
{
    launchAtBeat.store (nextBoundary (authoritativeBeats(), boundaryBeats));
    std::cerr << "[engine] launch armed at beat " << launchAtBeat.load() << std::endl;
}

void AudioEngine::cancelLaunch() { launchAtBeat.store (-1.0); }

void AudioEngine::clockTick()
{
    const double beats = authoritativeBeats();

    // Safe fallback: if we're DJ-master but the DJ grid stopped unexpectedly
    // (no deck playing AND manual clock not running), hand authority to the
    // engine at the last tempo so the band never dies.
    if ((Authority) authority.load() == Authority::DjMaster
        && ! anyDeckPlaying() && ! djRunning.load())
    {
        bpm.store (djBpm.load());
        authority.store ((int) Authority::RockdjMaster);
        std::cerr << "[engine] DJ clock lost -> fell back to ROCKDJ master" << std::endl;
    }

    // Execute an armed quantized launch.
    const double la = launchAtBeat.load();
    if (la >= 0.0 && beats >= la)
    {
        launchAtBeat.store (-1.0);
        playhead.store (0);
        play();                                   // band transport starts on the boundary
    }

    // Robustness: if a handoff is armed but the OUTGOING grid has stalled (band
    // stopped, or DJ clock lost), the boundary can never arrive — execute the
    // handoff immediately rather than hang. On stage this guarantees control
    // always resolves to a live master.
    if ((Authority) authority.load() == Authority::HandoffArmed)
    {
        const Authority from = (Authority) handoffFrom.load();
        const bool advancing = (from == Authority::DjMaster) ? (anyDeckPlaying() || djRunning.load())
                                                             : playing.load();
        if (! advancing)
        {
            handoffAtBeat.store (-1.0);
            applyMaster ((Authority) handoffTarget.load());
            std::cerr << "[engine] outgoing grid stalled -> handoff executed early" << std::endl;
        }
    }

    // Execute an armed handoff.
    const double ha = handoffAtBeat.load();
    if (ha >= 0.0 && beats >= ha && (Authority) authority.load() == Authority::HandoffArmed)
    {
        handoffAtBeat.store (-1.0);
        applyMaster ((Authority) handoffTarget.load());
        std::cerr << "[engine] handoff executed -> "
                  << ((Authority) handoffTarget.load() == Authority::DjMaster ? "DJ" : "ROCKDJ") << std::endl;
    }
}

AudioEngine::MusicalState AudioEngine::getMusicalState() const
{
    MusicalState s;
    s.authority     = (Authority) authority.load();
    s.handoffTarget = (Authority) handoffTarget.load();
    s.djRunning     = djRunning.load();

    // Authoritative tempo: DJ tempo when DJ leads, else engine tempo.
    const Authority runningMaster = (s.authority == Authority::HandoffArmed)
                                        ? (Authority) handoffFrom.load()
                                        : s.authority;
    const bool djLeads = (runningMaster == Authority::DjMaster);
    // When a deck is driving the DJ grid, the authoritative tempo is the MASTER
    // deck's tempo; otherwise the manual grid tempo (or engine tempo).
    s.bpm = djLeads ? (anyDeckPlaying() ? decks[masterDeck.load()].bpm.load()
                                            * decks[masterDeck.load()].rate.load()
                                        : djBpm.load())
                    : bpm.load();

    const double beats = authoritativeBeats();
    const int    beatsPerBarLocal = beatsPerBar;
    const int    totalBeats = (int) std::floor (beats);
    s.bar   = (totalBeats / beatsPerBarLocal) + 1;
    s.beat  = (totalBeats % beatsPerBarLocal) + 1;
    s.phase = beats - std::floor (beats);

    const double ha = handoffAtBeat.load();
    s.beatsUntilHandoff = (ha >= 0.0) ? juce::jmax (0.0, ha - beats) : -1.0;
    const double la = launchAtBeat.load();
    s.beatsUntilLaunch = (la >= 0.0) ? juce::jmax (0.0, la - beats) : -1.0;
    return s;
}
