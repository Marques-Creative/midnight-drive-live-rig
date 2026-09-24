/*
  BeatDetector.h — automatic BPM + beatgrid detection for DJ tracks.

  Built on the Queen Mary DSP library (qm-dsp) — the same beat-tracking
  research that powers Mixxx's analyzer:

    1. A DetectionFunction (complex spectral difference) turns the audio into
       an "onset strength" curve — spikes where drum hits / note attacks occur.
    2. TempoTrackV2 dynamic-programming beat tracking finds the most likely
       sequence of beat positions through that curve.
    3. From the beat positions we derive:
         - BPM        = 60 / median inter-beat interval
         - firstBeat  = the first confidently tracked beat (grid anchor)

  Analysis runs OFF the real-time audio thread (called during loadDeck, which
  already runs on the control thread). The DJ can still re-anchor the bar
  phase live with TAP DOWNBEAT; detection supplies tempo + a solid beat grid.
*/

#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

struct BeatAnalysis
{
    bool    ok            = false;
    double  bpm           = 0.0;   // detected tempo
    double  firstBeatSec  = 0.0;   // seconds offset of the first tracked beat
    int     numBeats      = 0;     // how many beats were tracked (confidence hint)
};

/** Analyze a decoded track (any channel count) at the given sample rate.
    Heavy — call off the audio thread. */
BeatAnalysis analyzeBeats (const juce::AudioBuffer<float>& audio, double sampleRate);
