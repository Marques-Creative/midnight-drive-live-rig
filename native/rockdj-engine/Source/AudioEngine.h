/*
  ==============================================================================
  AudioEngine.h - ROCKDJ Milestone 2 spike

  This is the piece that replaces the old Web Audio engine. Read this file first;
  it is the whole idea in ~120 lines.

  THE CORE CONCEPT - one authoritative clock
  ------------------------------------------
  The reason the old engine drifted is that every stem had its OWN clock (each
  HTMLAudioElement counted time independently). Here, there is exactly ONE
  counter: `playhead`, measured in SAMPLES (not seconds). Every stem is read at
  the same `playhead` position on every audio block. Because they share the
  counter, they are sample-aligned *by construction* - they physically cannot
  drift apart. That single design change is what makes multitrack reliable.

  ROUTING - FOH vs IEM
  --------------------
  A real audio interface exposes its physical outputs as channels:
      output channel 0 -> physical output 1      FOH  (goes to the DJ mixer /
      output channel 1 -> physical output 2            front of house)
      output channel 2 -> physical output 3      IEM  (goes to in-ear monitors:
      output channel 3 -> physical output 4            click + cues live here)
  Each stem carries a `route`. In the audio callback we simply write it to the
  FOH pair or the IEM pair. Click/cue audio written only to 3-4 can never leak
  into 1-2, so front-of-house never hears the click. That is priority #2, solved
  at the routing layer instead of hoped for.

  QUANTIZED LAUNCH
  ----------------
  Given the tempo, we know how many samples long one bar is. When you hit
  "trigger", we compute the sample index of the NEXT bar line and arm the
  one-shot to begin exactly there - accurate to a single sample.
  ==============================================================================
*/

#pragma once

// Headless engine: we deliberately include only the audio modules, NOT
// juce_audio_utils / juce_gui_*, so this process has no GUI dependency and can
// run as a background service (and build on headless machines).
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <atomic>
#include <mutex>
#include <vector>

#include <cstring>                 // the vendored FFT relies on this transitively
#include "signalsmith-stretch.h"    // MIT, vendored in third_party/

class AudioEngine : public juce::AudioIODeviceCallback,
                    private juce::MidiInputCallback
{
public:
    // Where a stem's audio is sent.
    enum class Route { FOH, IEM };

    AudioEngine();
    ~AudioEngine() override;

    //==========================================================================
    // Device lifecycle
    //==========================================================================

    /** Opens the audio device (asking for 4 outputs so IEM channels exist).
        Returns an empty string on success, or an error message. */
    juce::String initialise();

    /** Prefer an output device whose name contains this text (case-insensitive),
        e.g. "Scarlett" or "Focusrite". Call before initialise(). When empty, the
        engine still auto-prefers a Focusrite/Scarlett over the built-in output. */
    void setPreferredOutputDevice (const juce::String& nameContains) { preferredOutputName = nameContains; }

    /** The device picker UI binds to this. */
    juce::AudioDeviceManager& getDeviceManager() { return deviceManager; }

    /** Sample rate the hardware is currently running at (0 until device starts). */
    double getDeviceSampleRate() const { return currentSampleRate.load(); }

    /** Name of the open audio device, or "none" if no device is open. */
    juce::String getDeviceName() const;
    /** List every output device currently visible to JUCE. */
    juce::StringArray listAudioOutputDevices() const;
    /** Switch to a named output device live (no restart needed).
        On success returns empty string. Persists into the DJ settings file. */
    juce::String setAudioOutputDevice (const juce::String& name);

    /** How many output channels the current device actually gave us. We need >= 4
        for separate FOH/IEM. If this is 2, the selected device (e.g. MacBook
        built-in) can't do IEM routing - pick the Focusrite in the device picker. */
    int getNumOutputChannels() const { return numOutputs.load(); }

    //==========================================================================
    // Loading (only call while stopped)
    //==========================================================================

    /** Loads every .wav/.aiff/.flac in a folder as a stem.
        Route is chosen by filename: anything containing "click", "cue" or "iem"
        goes to the IEM bus; everything else goes to FOH. `report` is filled with
        a human-readable summary (name, route, sample-rate warnings). */
    bool loadStemsFromFolder(const juce::File& folder, juce::String& report);

    /** Loads a single one-shot sample used to demo quantized launching. */
    bool loadSample(const juce::File& file);

    /** Removes all loaded stems (stops transport first). */
    void clearStems();

    // -- Load a full song from explicit specs (this is what the app uses) --
    // Each stem is decoded and RESAMPLED to the current device sample rate, so a
    // 44.1k stem on a 48k device (or vice-versa) plays at the correct pitch/speed.
    struct StemSpec
    {
        juce::String filePath;   // absolute path on disk
        juce::String name;
        Route  route = Route::FOH;
        float  gain  = 1.0f;
        bool   muted = false;
    };

    /** Replace all stems with this set. Returns false if nothing loaded.
        `report` receives a human-readable summary. */
    bool loadSong (const std::vector<StemSpec>& specs, juce::String& report);

    /** Longest stem length, in seconds (the song's playable duration). */
    double getDurationSeconds() const;

    //==========================================================================
    // DJ decks — MULTI-STEM players (the heart of ROCKDJ)
    //==========================================================================
    // The DJ mixes two decks (A=0, B=1) through an equal-power crossfader to FOH
    // exactly as they would in any DJ software. The difference: each deck plays
    // a track's STEMS, not a stereo file — so the Band Master can pull the vocal
    // for the live singer, drop the guitar, mute the drums for a breakdown,
    // INSIDE the DJ's playing track, live. No sync problem exists: the stems ARE
    // the track, sharing one playhead. The MASTER deck drives the musical grid.

    static constexpr int kNumDecks = 2;

    // ── DJ decks ─────────────────────────────────────────────────────────────
    // A deck is a MULTI-STEM player: the DJ's track is its stems (vocals,
    // drums, bass, guitar, keys, fx...), all read at ONE shared playhead so
    // they are sample-locked by construction. The DJ mixes the deck normally;
    // the Band Master rides the individual stems live. Stems can be routed to
    // FOH (the room) or IEM (e.g. a click stem for the musicians only).
    struct DeckStem
    {
        juce::AudioBuffer<float> buffer;
        std::atomic<float> gain  { 1.0f };
        std::atomic<bool>  muted { false };
        std::atomic<Route> route { Route::FOH };
        juce::String name;
    };
    struct Deck
    {
        std::vector<std::unique_ptr<DeckStem>> stems;   // edited only while stopped
        std::atomic<bool>    playing  { false };
        std::atomic<int64_t> playhead { 0 };            // THE shared clock for all stems
        std::atomic<int64_t> cuePoint { 0 };            // DJ cue point (samples)
        std::atomic<bool>    cuePreview { false };      // playing only while CUE is held
        std::atomic<int64_t> downbeat { 0 };            // sample offset that is "beat 1"

        // ── Hot cues: 8 slots, -1 = empty. Positions in samples. ─────────────
        static constexpr int kNumHotCues = 8;
        std::atomic<int64_t> hotCues[kNumHotCues];

        Deck() { for (auto& hc : hotCues) hc.store (-1); }   // -1 = empty slot

        // ── Loop: a sample range the playhead wraps inside while active. ─────
        std::atomic<int64_t> loopStart { -1 };
        std::atomic<int64_t> loopEnd   { -1 };
        std::atomic<bool>    loopActive { false };
        /** Loop length in beats when set by auto-loop (0 = manual in/out). Kept
            so HALVE/DOUBLE can report a musical length back to the UI. */
        std::atomic<double>  loopBeats { 0.0 };
        std::atomic<double>  bpm      { 120.0 };
        std::atomic<float>   gain     { 1.0f };         // deck fader (DJ)
        std::atomic<int>     lengthSamples { 0 };       // longest stem

        // ── Vinyl-style tempo (auto-sync) ────────────────────────────────────
        // Playback rate multiplier, like a turntable pitch fader: 1.0 = recorded
        // tempo, 1.02 = +2% faster (and ~+2% higher in pitch). The audio thread
        // advances the playhead by `rate` per output sample and reads the stems
        // with linear interpolation at the fractional position.
        std::atomic<double>  rate { 1.0 };
        std::atomic<int>     tempoRange { 6 };  // pitch fader range in percent; first Pioneer step
        double posFrac = 0.0;   // sub-sample remainder — audio thread only

        // ── Jog wheel ────────────────────────────────────────────────────────
        // jogBend is a TEMPORARY rate offset added on top of `rate`: push the
        // ring forward and the track runs fast while you push, then eases back
        // when you let go. It decays in the audio callback, which is what makes
        // a nudge feel like a nudge rather than a permanent tempo change.
        std::atomic<double> jogBend { 0.0 };

        // ── Master Tempo (pitch-preserving tempo) ────────────────────────────
        // Playing a deck faster also raises its pitch - fine for a club DJ,
        // useless for us: a live guitarist and singer cannot retune mid-song
        // because the DJ synced +4%. So we resample for tempo (as before) and
        // pitch-shift back by 1/rate to restore the original key.
        //
        // Deliberately compensates the DECK RATE only, not the jog bend: sync
        // and the pitch fader hold their key, while a nudge still bends
        // audibly, which is what a nudge is supposed to feel like.
        std::atomic<bool> masterTempo { true };
        signalsmith::stretch::SignalsmithStretch<float> stretchFoh, stretchIem;
        double lastEndPos = -1.0;        // audio thread: continuity detection
        bool   stretchPrimed = false;    // audio thread

        // ── 3-band EQ + filter (FOH bus only; the IEM click is untouched) ────
        // Gains in dB (0 = flat, -26 ≈ kill, +6 max boost). filterPos is the
        // DJM-style single knob: -1 = full low-pass, 0 = off, +1 = full high-pass.
        std::atomic<float> eqLowDb  { 0.0f };
        std::atomic<float> eqMidDb  { 0.0f };
        std::atomic<float> eqHighDb { 0.0f };
        std::atomic<float> filterPos { 0.0f };
        std::atomic<bool>  eqDirty { true };  // coefficients need recomputing
        std::atomic<bool>  reloading { false }; // true while stems are being replaced
        // stems is protected by the reloading atomic flag + 60ms sleep in loadDeck
        // stems is protected by the reloading atomic flag + 60ms sleep in loadDeck
        // Peak level meter — updated every audio block, decays over time.
        // Stored as linear gain so 1.0 = 0 dBFS.  Clip = > 1.0.
        std::atomic<float> peakLevel { 0.0f };
        std::atomic<bool>  cueEnabled { false };   // in the DJ's headphones (PFL)

        // ── Beat FX (Echo + Reverb) ─────────────────────────────────────────
        std::atomic<bool>  fxOn    { false };
        std::atomic<float> fxDepth { 0.0f };  // 0..1 = wet level
        std::atomic<int>   fxMode  { 0 };     // 0 = echo, 1 = reverb
        // Echo delay line
        std::vector<float> echoL, echoR;
        int echoWritePos = 0;
        // Schroeder reverb: 4 comb filters (L+R) + 2 allpass, audio thread only.
        // Buffer sizes chosen to be mutually prime (avoids resonant comb).
        static constexpr int kCombSizes[4] = { 1116, 1188, 1277, 1356 };
        static constexpr int kApSizes[2]   = { 556, 441 };
        struct CombLine  { std::vector<float> b; int pos=0; };
        struct AllPass   { std::vector<float> b; int pos=0; };
        CombLine combL[4], combR[4];
        AllPass  apL[2],   apR[2];

        // Biquad runtime state — audio thread only.
        struct Biquad
        {
            double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;   // coefficients
            double z1[2] = {0,0}, z2[2] = {0,0};              // per-channel state
            bool   active = false;
            inline float process (int ch, float x)
            {
                const double y = b0 * x + z1[ch];
                z1[ch] = b1 * x - a1 * y + z2[ch];
                z2[ch] = b2 * x - a2 * y;
                return (float) y;
            }
            void reset() { z1[0]=z1[1]=z2[0]=z2[1]=0; }
        };
        Biquad eqLow, eqMid, eqHigh, filter;
    };

    /** One stem of a DJ track (as sent by the app). */
    struct DeckStemSpec
    {
        juce::String filePath;
        juce::String name;       // "Vocals", "Drums", "Click"...
        Route  route = Route::FOH;
        float  gain  = 1.0f;
        bool   muted = false;
    };

    /** Load a DJ track's STEMS into deck 0 (A) or 1 (B). All stems share one
        playhead, so they are sample-locked. trackBpm is a fallback; the engine
        auto-detects tempo/beatgrid from the mix. */
    bool loadDeck (int deckIndex, const std::vector<DeckStemSpec>& specs, double trackBpm, juce::String& report);

    void deckPlay  (int deckIndex);
    void deckPause (int deckIndex);
    void deckSeek  (int deckIndex, double seconds);

    // ── CDJ-style CUE (Pioneer semantics) ────────────────────────────────────
    // deckCueDown (button press):
    //   • playing      → BACK-CUE: pause and snap the playhead to the cue point.
    //   • paused       → SET the cue point at the current position, then PREVIEW
    //                    (play while the button is held).
    // deckCueUp (button release):
    //   • if previewing → return to the cue point, paused. (The classic stutter.)
    //   • if PLAY was pressed during the preview, the deck latched into normal
    //     playback (deckPlay clears the preview flag) and release does nothing.
    // deckCue is the legacy one-shot: back-cue to the cue point.
    void deckCueDown (int deckIndex);
    void deckCueUp   (int deckIndex);
    void deckCue     (int deckIndex);        // back-cue: pause + return to cue point
    void setDeckGain (int deckIndex, float linearGain);   // the DJ's deck fader
    float getDeckGain (int deckIndex) const;

    // ── Hot cues (Pioneer semantics: a hot cue press jumps AND plays) ────────
    void setHotCue    (int deckIndex, int slot);   // store the current position
    void jumpHotCue   (int deckIndex, int slot);   // jump there and play
    void deleteHotCue (int deckIndex, int slot);
    /** Restore a hot cue at a specific time (seconds) without seeking. */
    void setHotCueDirect (int deckIndex, int slot, double seconds);
    bool isHotCueSet  (int deckIndex, int slot) const;
    double getHotCueSeconds (int deckIndex, int slot) const;   // -1 when empty

    // ── Loops ───────────────────────────────────────────────────────────────
    void deckLoopIn   (int deckIndex);             // set loop start here
    void deckLoopOut  (int deckIndex);            // set loop end here + activate
    void deckLoopExit (int deckIndex);             // release (keeps the points)
    void deckReloop   (int deckIndex);             // jump back in + reactivate
    /** Auto-loop: an exact N-beat loop starting at the nearest beat to the
        playhead, using the detected grid. The band's "hold this section" tool. */
    void deckLoopBeats (int deckIndex, double beats);
    void deckLoopScale (int deckIndex, double factor);   // 0.5 = halve, 2 = double
    bool   isDeckLooping (int deckIndex) const;
    double getDeckLoopStartSeconds (int deckIndex) const;
    double getDeckLoopEndSeconds (int deckIndex) const;
    double getDeckLoopBeats (int deckIndex) const;

    // ── 3-band EQ + filter (per deck, live-safe) ─────────────────────────────
    void setDeckEq (int deckIndex, float lowDb, float midDb, float highDb);
    void setDeckFilter (int deckIndex, float position);   // -1 LPF … 0 off … +1 HPF
    float getDeckEqLow  (int deckIndex) const;
    float getDeckEqMid  (int deckIndex) const;
    float getDeckEqHigh (int deckIndex) const;
    float getDeckFilter (int deckIndex) const;

    // ── Tempo + auto-sync (vinyl-style) ──────────────────────────────────────
    void setDeckRate (int deckIndex, double rate);        // 1.0 = recorded tempo
    double getDeckRate (int deckIndex) const;
    /** Cycle the tempo range: 6→10→16→100→6 (matching the RX3 TEMPO RANGE button). */
    void   cycleDeckTempoRange (int deckIndex);
    int    getDeckTempoRange (int deckIndex) const;
    /** Set an absolute range (percent). Snaps to 6/10/16/100. */
    void   setDeckTempoRange (int deckIndex, int rangePct);
    /** Manually override the detected BPM (grid + sync + FX all follow). */
    void   setDeckBpm (int deckIndex, double bpm);
    void   setDeckFxOn (int deckIndex, bool on);
    bool   getDeckFxOn (int deckIndex) const;
    void   setDeckFxDepth (int deckIndex, float depth);
    float  getDeckFxDepth (int deckIndex) const;
    void   setDeckFxMode (int deckIndex, int mode);   // 0 = echo, 1 = reverb
    float  getDeckPeak (int deckIndex) const;
    float  getMasterPeak() const;
    void   resetPeaks();
    int    getDeckFxMode (int deckIndex) const;
    /** One-shot SYNC: match this deck's tempo to the other playing/loaded deck's
        EFFECTIVE tempo (its detected BPM × its rate) and snap the beat phase to
        the nearest beat. Safe to press live. */
    void deckSync (int deckIndex);

    void setCrossfader (float position01);   // 0 = full A, 1 = full B (equal-power)
    void setMasterGain (float linear);        // 0..2; UI shows 0..200%
    float getMasterGain() const;
    /** Trim in dB, applied pre-EQ to match levels between tracks. ±12 dB. */
    void  setDeckTrim (int deckIndex, float dB);
    float getDeckTrim (int deckIndex) const;

    //==========================================================================
    // Crossfader assign, per deck - exactly like a DJM. Most club DJs mix with
    // the CHANNEL FADERS and EQ and want the crossfader out of the path
    // entirely; with an equal-power curve, a crossfader parked at centre pins
    // both decks to -3dB and unity becomes unreachable. THRU fixes that.
    //==========================================================================
    enum class XfAssign { A = 0, Thru = 1, B = 2 };
    void setDeckXfAssign (int deckIndex, XfAssign a);
    XfAssign getDeckXfAssign (int deckIndex) const;

    //==========================================================================
    // Master deck = the song the ROOM is hearing, and therefore the song the
    // Live Screen shows and the Band Master rides. When a DJ blends with
    // faders there is no crossfader position to infer it from, so we derive it
    // from each deck's audible contribution and follow the DJ's hands.
    //==========================================================================
    /** Auto-follow the audible deck (default). Pressing MASTER pins it. */
    /** Master Tempo: keep the track's key when the tempo changes. */
    void setDeckMasterTempo (int deckIndex, bool on);
    bool getDeckMasterTempo (int deckIndex) const;
    void setAutoMaster (bool shouldAuto);
    bool isAutoMaster() const { return autoMaster.load(); }
    /** playing x channel fader x crossfader: what the room actually hears. */
    float getDeckAudibleLevel (int deckIndex) const;

    //==========================================================================
    // Output routing. Nothing is hardcoded: every bus is assigned to hardware
    // channels at run time, so the same build works on a 4-out Scarlett or a
    // big interface. A channel index of -1 means "not connected".
    //   FOH  - the room (stereo)
    //   IEM  - the band's click/guide (mono is normal: set iemR = -1)
    //   CUE  - the DJ's pre-fader listen; feed a mixer channel with the fader
    //          down and PFL on. Optional (set both to -1 if unused).
    //==========================================================================
    struct OutputRouting
    {
        int fohL = 0, fohR = 1;
        int iemL = 2, iemR = 3;
        int cueL = -1, cueR = -1;
        // Per-deck direct outs — feed each deck into its own external mixer channel
        int deckAL = -1, deckAR = -1;
        int deckBL = -1, deckBR = -1;
    };
    void setOutputRouting (const OutputRouting& r);
    OutputRouting getOutputRouting() const;

    /** Pre-fader listen: put a deck in the DJ's headphones without the room
        hearing it. Post-EQ, pre-fader, pre-crossfader (DJM behaviour). */
    void setDeckCueEnabled (int deckIndex, bool shouldCue);
    bool isDeckCueEnabled (int deckIndex) const;
    void setCueGain (float linearGain);
    float getCueGain() const;

    // ── Jog wheel ───────────────────────────────────────────────────────────
    /** Feed a jog movement. Playing -> nudge (temporary pitch bend, the gesture
        a DJ uses to tighten a mix by hand). Paused -> search through the track. */
    void deckJog (int deckIndex, double ticks);
    /** VINYL mode: scrub the playhead directly, even while playing. Crude but
        audible scratch - the playhead jumps and the audio follows. */
    void deckScratch (int deckIndex, double ticks);
    /** nudge: bend per tick. search: seconds per tick. Both need tuning against
        real hardware - jog resolution differs wildly between models. */
    /** decaySeconds is the "feel" of a nudge: how long the bend takes to ease
        back to the deck's real tempo after the DJ lets go. Short = tight and
        springy, long = loose and vinyl-like. Worth a knob; DJs disagree. */
    void setJogSensitivity (double nudgePerTick, double searchSecondsPerTick, double decaySeconds);
    double getJogNudge() const;
    double getJogSearch() const;
    double getJogDecay() const;
    double getDeckJogBend (int deckIndex) const;

    //==========================================================================
    // MIDI control surface (CDJs in MIDI mode, or any controller).
    // Mappings are learned from the hardware rather than guessed, and are held
    // in the ENGINE so a button press acts immediately - no round trip through
    // the UI. Persisted next to the audio data so a gig survives a restart.
    //==========================================================================
    enum class MidiAction
    {
        None, PlayPause, Play, Pause, CueButton, Sync, CueEnable,
        HotCue, LoopIn, LoopOut, LoopBeats, LoopExit, Reloop,
        Rate, TempoRange, Crossfader, EqLow, EqMid, EqHigh, Filter, DeckGain,
        Jog, JogScratch, FxOn, FxDepth,
        LibraryUp, LibraryDown, LibrarySelect, LibraryLoad0, LibraryLoad1,
        MasterGain, DeckTrim,
        ClearHotCue,
        Pad1, Pad2, Pad3, Pad4, Pad5, Pad6, Pad7, Pad8,
        XfAssign
    };
    struct MidiBinding
    {
        int  status  = 0;      // 0x90 note-on, 0xB0 CC (channel nibble stripped)
        int  channel = 0;      // 1-16
        int  data1   = 0;      // note number / CC number
        MidiAction action = MidiAction::None;
        int    deck  = 0;
        double param = 0.0;    // hot cue slot, loop beats, etc.
        /** Relative-encoder decoding for jog wheels. Manufacturers disagree and
            Pioneer don't document it, so this is chosen from the hardware in
            the learn UI rather than assumed:
              0 = two's complement (1..63 forward, 127..65 back)
              1 = binary offset    (64 = centre)
              2 = signed bit       (bit 6 = direction) */
        int relMode = 0;
        /** 14-bit CC pair (MSB on data1, LSB on data1+32) - the XDJ-RX3's tempo
            fader is 14-bit, and 7-bit would give a pro DJ only 128 steps across
            the whole pitch range. */
        bool bit14 = false;
    };
    /** Decode a relative-encoder value to a signed tick delta. */
    static int decodeRelative (int value, int relMode);
    /** Action ↔ string conversion (stored in settings so must survive enum reorders). */
    static juce::String    actionToString (MidiAction a);
    static MidiAction      actionFromString (const juce::String& s);
    juce::StringArray getMidiDevices() const;
    juce::String openMidiDevice (const juce::String& name);   // "" = close
    juce::String openMidiDevices (const juce::StringArray& names); // open multiple
    juce::String getOpenMidiDevice() const;
    void setMidiBindings (const std::vector<MidiBinding>& b);
    std::vector<MidiBinding> getMidiBindings() const;
    /** Raw MIDI passthrough for the learn UI. Set null to stop listening. */
    void setMidiMonitor (std::function<void (int status, int channel, int d1, int d2)> fn);
    /** Library navigation callback. Called from the MIDI thread with:
        "up"/"down"  — scroll by N steps
        "select"     — enter/expand
        "load0"/"load1" — load to deck */
    void setLibraryCallback (std::function<void (const juce::String& action, int steps)> fn);
    // ── MIDI OUTPUT: send LED feedback to the hardware ──────────────────
    // Sends MIDI back to the controller so buttons/pads light up.
    // Note: not all controllers act on MIDI out; Pioneer CDJs/XDJ do.
    juce::StringArray getMidiOutputDevices() const;
    juce::String openMidiOutputDevice (const juce::String& name);
    juce::String getOpenMidiOutputDevice() const;
    void sendMidiOut (int status, int data1, int data2);

    /** Feed a MIDI message as if it arrived from hardware. Lets a mapping be
        tested (and demoed) with no controller plugged in. */
    void injectMidi (int status, int channel, int d1, int d2);

    //==========================================================================
    // Settings persistence. The ENGINE owns this, not the UI: a mapping must
    // survive a restart and must load whether or not anyone has opened the
    // settings page. Stored beside the audio data in ~/MidnightDrive.
    //==========================================================================
    static juce::File getSettingsFile();
    void saveSettings() const;
    void loadSettings();
    void setMasterDeck (int deckIndex);      // which deck drives the band clock
    int  getMasterDeck() const { return masterDeck.load(); }
    float getCrossfader() const { return crossfader.load(); }

    // ── The hidden gem: live stem control (Band Master) ──────────────────────
    // Ride the individual stems OF THE DJ'S PLAYING TRACK, live, while the DJ
    // mixes normally. Safe to call at any time, including mid-playback.
    void setDeckStemGain  (int deckIndex, int stemIndex, float linearGain);
    void setDeckStemMute  (int deckIndex, int stemIndex, bool muted);
    void setDeckStemRoute (int deckIndex, int stemIndex, Route r);
    int  getDeckNumStems  (int deckIndex) const;
    juce::String getDeckStemName (int deckIndex, int stemIndex) const;
    float getDeckStemGain (int deckIndex, int stemIndex) const;
    bool  getDeckStemMuted (int deckIndex, int stemIndex) const;
    bool  isDeckStemIem (int deckIndex, int stemIndex) const;

    bool isDeckPlaying (int deckIndex) const;
    bool deckLoaded (int deckIndex) const;
    double getDeckCueSeconds (int deckIndex) const;      // cue point position
    bool isDeckCuePreviewing (int deckIndex) const;      // true while CUE is held
    double getDeckDownbeatSeconds (int deckIndex) const; // beat-1 anchor of the detected grid
    double getDeckSeconds (int deckIndex) const;
    double getDeckDurationSeconds (int deckIndex) const;
    double getDeckBpm (int deckIndex) const;

    /** Fill `dest` with `numBuckets` peak magnitudes (0..1) across a deck's
        track (summed stems) — a downsampled overview for drawing the waveform. */
    void getDeckWaveform (int deckIndex, std::vector<float>& dest, int numBuckets) const;

    //==========================================================================
    // Transport
    //==========================================================================

    void play();
    void pause();                        // stop playing but KEEP the playhead position
    void stop();
    void seek (double seconds);          // move the playhead (samples = seconds * sampleRate)
    bool isPlaying() const { return playing.load(); }

    //==========================================================================
    // Per-stem mix + routing (all safe to call live, while playing)
    //==========================================================================

    /** Send stem #index to FOH (out 1-2) or IEM (out 3-4). */
    void setStemRoute (int index, Route r);
    void setStemGain  (int index, float linearGain);
    void setStemMute  (int index, bool muted);
    Route getStemRoute (int index) const;
    juce::String getStemName (int index) const;

    //==========================================================================
    // Musical parameters
    //==========================================================================

    void setBpm(double newBpm)      { bpm.store(newBpm); }
    double getBpm() const           { return bpm.load(); }

    //==========================================================================
    // Clock authority + DJ musical clock (the DJ-integration core)
    //==========================================================================
    // Exactly ONE authority is master at a time. In RockdjMaster the engine's
    // own transport is the timeline. In DjMaster an external DJ tempo grid is
    // authoritative and the engine follows it. HandoffArmed means the current
    // master keeps running while the next master is prepared; authority flips
    // only when the authoritative grid crosses the armed musical boundary.
    // Two systems are NEVER master simultaneously.
    enum class Authority { RockdjMaster, DjMaster, HandoffArmed };

    Authority getAuthority() const { return (Authority) authority.load(); }

    // DJ clock source (stage 3: manual BPM + tapped downbeat). The DJ grid runs
    // on a monotonic wall clock so it keeps time even when no band audio plays.
    void setDjBpm (double bpmValue) { djBpm.store (juce::jlimit (20.0, 300.0, bpmValue)); }
    void setDjRunning (bool running);
    void tapDownbeat();                          // anchor DJ phase (beat 1) to now

    // Deliberate, quantized authority change. boundaryBeats: 1=next beat, 4=next
    // bar (4/4), 16=next 4 bars, 32=next 8 bars, etc. Flips at that boundary.
    void armHandoff (Authority target, double boundaryBeats);
    void cancelHandoff();

    // Arm band transport to START on the next musical boundary of the
    // authoritative grid (quantized launch). boundaryBeats as above.
    void armLaunch (double boundaryBeats);
    void cancelLaunch();

    // Snapshot of the authoritative musical position + pending transitions.
    struct MusicalState
    {
        Authority authority      = Authority::RockdjMaster;
        Authority handoffTarget  = Authority::RockdjMaster;
        double bpm               = 120.0;   // authoritative tempo
        int    bar               = 1;       // 1-based
        int    beat              = 1;       // 1-based within bar
        double phase             = 0.0;     // 0..1 within the current beat
        bool   djRunning         = false;
        double beatsUntilHandoff = -1.0;    // -1 if none armed
        double beatsUntilLaunch  = -1.0;    // -1 if none armed
    };
    MusicalState getMusicalState() const;

    /** Arm the one-shot sample to fire on the next bar boundary. */
    void triggerSampleQuantized();

    //==========================================================================
    // Status (safe to read from the UI/message thread)
    //==========================================================================

    double getPlayheadSeconds() const;
    int64_t getPlayheadSamples() const { return playhead.load(); }
    /** Beats remaining until the armed sample fires; -1 if nothing is armed. */
    double getBeatsUntilSampleFires() const;
    int getNumStems() const  { return (int) stems.size(); }
    bool hasSample() const   { return sampleBuffer.getNumSamples() > 0; }

    //==========================================================================
    // AudioIODeviceCallback - the real-time audio thread
    //==========================================================================

    void audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                           int numInputChannels,
                                           float* const* outputChannelData,
                                           int numOutputChannels,
                                           int numSamples,
                                           const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceAboutToStart (juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;
    void setDeckDirectRoute (int deck, int L, int R)
    {
        if (deck == 0) { routeDeckAL.store (L); routeDeckAR.store (R); }
        else           { routeDeckBL.store (L); routeDeckBR.store (R); }
    }
    int getDeckDirectL (int deck) const { return deck == 0 ? routeDeckAL.load() : routeDeckBL.load(); }
    int getDeckDirectR (int deck) const { return deck == 0 ? routeDeckAR.load() : routeDeckBR.load(); }
    void setMasterCueEnabled (bool on) { masterCueEnabled.store (on); }
    bool getMasterCueEnabled () const   { return masterCueEnabled.load(); }

private:
    // -- One loaded stem: its samples in RAM, plus where it should be sent --
    // `route` is atomic because the UI thread can change it live while the
    // audio thread is reading it. We store stems as unique_ptrs so the Stem
    // objects never move in memory (an atomic can't be moved) even as the
    // vector grows during loading.
    struct Stem
    {
        juce::AudioBuffer<float> buffer;   // whole file decoded into memory (at device sample rate)
        std::atomic<Route>       route { Route::FOH };
        std::atomic<float>       gain  { 1.0f };   // linear 0..1+ (UI thread can change live)
        std::atomic<bool>        muted { false };
        juce::String             name;
    };

    juce::AudioDeviceManager deviceManager;
    juce::AudioFormatManager formatManager;

    std::vector<std::unique_ptr<Stem>> stems;  // audio thread reads; edited only while stopped (except route, which is live)
    juce::AudioBuffer<float> sampleBuffer;  // the one-shot

    Deck decks[kNumDecks];
    // Scratch stereo bus for one deck's FOH mix (stems summed here, then EQ'd,
    // then routed out). Sized generously in audioDeviceAboutToStart; audio
    // thread only.
    juce::AudioBuffer<float> deckBus { 2, 0 };
    /** Per-block source positions for ONE deck, shared by all its stems (this
        is what keeps stems locked through a loop wrap). Audio thread only;
        sized in audioDeviceAboutToStart so we never allocate in the callback. */
    std::vector<double> posBuf;
    /** Second scratch bus so the band's click can be pitch-corrected through an
        IDENTICAL stretcher to the music. If only the music were shifted, the
        click would drift 60ms away from it and the whole sample-lock premise
        would break. */
    juce::AudioBuffer<float> iemBus { 2, 0 };
    /** Pre-roll fed to outputSeek() so a cue jump resumes with no added delay. */
    juce::AudioBuffer<float> preRollFoh { 2, 0 }, preRollIem { 2, 0 };
    /** Stretcher output scratch. process() must NOT be given the same buffer as
        input and output - an STFT reads its input while writing output, so
        in-place corrupts it (it came out an octave low). */
    juce::AudioBuffer<float> stretchOut { 2, 0 };

    std::atomic<int> routeFohL { 0 }, routeFohR { 1 };
    std::atomic<int> routeIemL { 2 }, routeIemR { 3 };
    std::atomic<int> routeCueL { -1 }, routeCueR { -1 };
    // Per-deck direct outputs — feed each deck into a separate mixer channel
    std::atomic<int> routeDeckAL { -1 }, routeDeckAR { -1 };
    std::atomic<int> routeDeckBL { -1 }, routeDeckBR { -1 };
    std::atomic<float> cueGain { 1.0f };
    std::atomic<double> jogNudgePerTick { 0.004 };    // 0.4% bend per tick
    std::atomic<double> jogSearchPerTick { 0.001 };   // seconds per tick when paused — 1ms/tick = fine cue control
    std::atomic<double> jogDecaySeconds { 0.070 };    // nudge ease-out time constant

    std::vector<std::unique_ptr<juce::MidiInput>> midiIns;
    std::unique_ptr<juce::MidiOutput> midiOut;
    juce::String openMidiOutName;
    juce::StringArray openMidiNames;
    std::vector<MidiBinding> midiBindings;
    juce::CriticalSection midiLock;          // guards bindings (MIDI thread reads)
    std::function<void (int, int, int, int)> midiMonitor;
    std::function<void (const juce::String&, int)> libraryCallback;
    /** Most-significant bytes of 14-bit CC pairs, per channel. MIDI thread. */
    std::atomic<int> ccMsb[16][32] {};
    void handleIncomingMidiMessage (juce::MidiInput*, const juce::MidiMessage&) override;
    void applyMidiBinding (const MidiBinding& b, const juce::MidiMessage& m);
    std::atomic<int>   masterDeck { 0 };        // which deck drives the DJ grid
    std::atomic<bool>  autoMaster { true };     // follow the audible deck
    std::atomic<AudioEngine::XfAssign> xfAssign[2] { XfAssign::Thru, XfAssign::Thru };
    double masterSwitchAccum = 0.0;             // hysteresis timer, audio thread
    std::atomic<float> crossfader   { 0.5f };    // 0 = full A .. 1 = full B
    std::atomic<float> masterGain   { 1.0f };    // 0..2 master output level
    std::atomic<float> masterPeak   { 0.0f };    // post-master peak for metering
    std::atomic<float> deckTrim[2]  { {0.0f}, {0.0f} };  // per-deck trim in dB
    bool anyDeckPlaying() const { return decks[0].playing.load() || decks[1].playing.load(); }

private:    // Guards EVERY non-audio-thread access to the stems vectors.
    //
    // Two classes of caller take this lock:
    //   1. Writers  — loadDeck / loadSong (clear + repopulate the vector)
    //   2. Readers  — getDeckWaveform, duration/stem accessors (walk the buffers)
    //
    // Without it, getDeckWaveform (which reads ~100M samples on a 9-stem track and
    // takes hundreds of ms) can be walking buffers that a concurrent load frees.
    // Recursive so that any nested getter call inside a locked region can't deadlock.
    // The AUDIO THREAD never takes this lock — it uses the reloading/loadingSong
    // atomic flags instead, so there is no priority inversion.
    std::atomic<bool> loadingSong    { false }; // true while loadSong() modifies band stems
    std::atomic<bool> masterCueEnabled { false }; // M button: route FOH to headphone CUE out
    mutable std::recursive_mutex loadSerialMutex;
    double deckBeatsNow() const;                // MASTER deck beat position (for the DJ grid)

    // Musical / device state. Atomics because the audio thread and the UI thread
    // both touch them. (A spike-level approximation; production uses a lock-free
    // command queue - noted in the README.)
    std::atomic<double>  currentSampleRate { 48000.0 };
    std::atomic<int>     numOutputs        { 0 };
    juce::String         preferredOutputName;   // e.g. "Scarlett"; set before initialise()

    // After the default device opens, switch to a preferred multi-output
    // interface (by name) if the current one can't do separate FOH/IEM.
    void preferMultiOutputDevice();
    std::atomic<double>  bpm               { 120.0 };
    int                  beatsPerBar       = 4;

    std::atomic<bool>    playing  { false };
    std::atomic<int64_t> playhead { 0 };   // THE authoritative clock, in samples

    // ── Clock authority + DJ musical grid ───────────────────────────────────
    std::atomic<int>     authority     { (int) Authority::RockdjMaster };
    std::atomic<int>     handoffTarget { (int) Authority::RockdjMaster };
    std::atomic<int>     handoffFrom   { (int) Authority::RockdjMaster };
    std::atomic<double>  djBpm         { 120.0 };
    std::atomic<bool>    djRunning     { false };
    std::atomic<double>  djAnchorMs    { 0.0 };   // wall-clock ms of DJ beat 1
    std::atomic<double>  djBeatsAtStop { 0.0 };   // beats elapsed when DJ paused

    // Armed transitions: absolute beat count (on the authoritative grid) at which
    // the action fires. -1 = not armed.
    std::atomic<double>  handoffAtBeat { -1.0 };
    std::atomic<double>  launchAtBeat  { -1.0 };

    // Dedicated clock thread advances the DJ grid, streams nothing itself, but
    // executes armed handoffs/launches promptly (~5 ms resolution).
    std::unique_ptr<juce::Thread> clockThread;
    void clockTick();                         // called repeatedly by clockThread

    double authoritativeBeats() const;        // current beat count on the master grid
    double djBeatsNow() const;                // DJ grid beat count right now
    double rockdjBeatsNow() const;            // engine grid beat count right now
    void   applyMaster (Authority target);    // switch master now (with tempo/anchor setup)

    // Quantized-launch state.
    std::atomic<int64_t> sampleFireAt  { -1 }; // absolute sample to start firing (-1 = not armed)
    std::atomic<int64_t> samplePlayPos { -1 }; // read position within sampleBuffer (-1 = idle)

    // Helpers - how many samples in one beat / one bar at the current tempo.
    double samplesPerBeat() const { return currentSampleRate.load() * 60.0 / bpm.load(); }
    double samplesPerBar()  const { return samplesPerBeat() * (double) beatsPerBar; }

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (AudioEngine)
};
