/*
  BeatDetector.cpp — see BeatDetector.h for the approach.
*/

#include "BeatDetector.h"

#include <dsp/onsets/DetectionFunction.h>
#include <dsp/tempotracking/TempoTrackV2.h>

#include <algorithm>
#include <cmath>
#include <vector>

namespace
{
    // Frame sizes matching common analyzer practice (and Mixxx's use of qm-dsp):
    // ~11.6 ms hops at 44.1k. We keep the track's own sample rate.
    constexpr int kFrameSize = 1024;
    constexpr int kHopSize   = 512;
}

BeatAnalysis analyzeBeats (const juce::AudioBuffer<float>& audio, double sampleRate)
{
    BeatAnalysis result;
    const int totalSamples = audio.getNumSamples();
    const int numCh        = audio.getNumChannels();
    if (totalSamples < kFrameSize * 8 || sampleRate <= 0.0)
        return result;

    // 1. Mono downmix into double precision (qm-dsp works in doubles).
    std::vector<double> mono ((size_t) totalSamples, 0.0);
    for (int ch = 0; ch < numCh; ++ch)
    {
        const float* src = audio.getReadPointer (ch);
        for (int i = 0; i < totalSamples; ++i)
            mono[(size_t) i] += src[i];
    }
    const double invCh = 1.0 / (double) juce::jmax (1, numCh);
    for (auto& v : mono) v *= invCh;

    // 2. Onset detection function (complex spectral difference).
    DFConfig config;
    config.DFType         = DF_COMPLEXSD;
    config.stepSize       = kHopSize;
    config.frameLength    = kFrameSize;
    config.dbRise         = 3;
    config.adaptiveWhitening = false;
    config.whiteningRelaxCoeff = -1;
    config.whiteningFloor = -1;

    DetectionFunction df (config);

    std::vector<double> detectionCurve;
    detectionCurve.reserve ((size_t) (totalSamples / kHopSize + 1));

    std::vector<double> frame ((size_t) kFrameSize, 0.0);
    for (int pos = 0; pos + kFrameSize <= totalSamples; pos += kHopSize)
    {
        for (int i = 0; i < kFrameSize; ++i)
            frame[(size_t) i] = mono[(size_t) (pos + i)];
        detectionCurve.push_back (df.processTimeDomain (frame.data()));
    }

    if (detectionCurve.size() < 64)
        return result;

    // 3. Beat tracking. TempoTrackV2 expects the detection curve minus its
    // first few (transient) values, per the library's own usage pattern.
    const size_t nonZeroStart = 2 < detectionCurve.size() ? 2 : 0;
    std::vector<double> dfCut (detectionCurve.begin() + (long) nonZeroStart, detectionCurve.end());

    std::vector<double> beatPeriods (dfCut.size(), 0.0);
    std::vector<double> tempi;

    TempoTrackV2 tt ((float) sampleRate, kHopSize);
    tt.calculateBeatPeriod (dfCut, beatPeriods, tempi);

    std::vector<double> beats; // beat positions in detection-function frames
    tt.calculateBeats (dfCut, beatPeriods, beats);

    if (beats.size() < 8)
        return result; // not enough confident beats to build a grid

    // 4. Derive BPM. Median inter-beat interval is robust but frame-quantized
    // (whole hops), which can be off by ~1 BPM. So: use the median to reject
    // outlier intervals (tracking glitches), then average the SPAN of the
    // remaining consistent beats — sub-frame precision for steady tempos.
    std::vector<double> intervals;
    intervals.reserve (beats.size() - 1);
    for (size_t i = 1; i < beats.size(); ++i)
        intervals.push_back (beats[i] - beats[i - 1]);

    std::vector<double> sorted = intervals;
    std::nth_element (sorted.begin(), sorted.begin() + (long) (sorted.size() / 2), sorted.end());
    const double medianFrames = sorted[sorted.size() / 2];
    if (medianFrames <= 0.0)
        return result;

    double sum = 0.0; int kept = 0;
    for (double iv : intervals)
        if (std::abs (iv - medianFrames) <= medianFrames * 0.1) { sum += iv; ++kept; }
    const double avgFrames = kept > 0 ? sum / (double) kept : medianFrames;

    const double secondsPerBeat = avgFrames * (double) kHopSize / sampleRate;
    double bpm = 60.0 / secondsPerBeat;

    // Fold into the usual DJ range (e.g. 75 -> 150 stays, 260 -> 130, 55 -> 110).
    while (bpm > 200.0) bpm /= 2.0;
    while (bpm < 60.0)  bpm *= 2.0;

    result.ok           = true;
    result.bpm          = bpm;
    result.firstBeatSec = (beats.front() + (double) nonZeroStart) * (double) kHopSize / sampleRate;
    result.numBeats     = (int) beats.size();
    return result;
}
