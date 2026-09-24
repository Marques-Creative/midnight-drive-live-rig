#pragma once
/**
 * LinkService — Ableton Link integration for RockDJ
 *
 * Runs a Link session alongside the JUCE audio engine.  The engine remains
 * the TEMPO AUTHORITY (it publishes BPM to Link), but it can optionally
 * accept tempo changes from peers.
 *
 * All Link API calls happen on a dedicated commit thread or the Link
 * callback thread — never on the audio callback thread directly.
 *
 * Thread safety:
 *   – snapshotLink() can be called from any thread
 *   – setEnabled/setTempo/setQuantum are safe from any thread
 *   – the tempo-change callback runs on a Link internal thread
 */

#include <ableton/Link.hpp>
#include <atomic>
#include <functional>
#include <mutex>
#include <string>

class LinkService
{
public:
    // ── Tempo policy: what happens when a Link peer changes tempo ─────────────
    enum class TempoPolicy
    {
        AcceptExternal,   // follow peer tempo changes
        WarnExternal,     // callback fires, tempo not applied
        RestoreOnce,      // apply once then revert to DJ tempo
        LockLocal,        // ignore all external tempo changes
    };

    // ── Snapshot: everything the UI needs, cheap to copy ─────────────────────
    struct Snapshot
    {
        bool   enabled    = false;
        bool   healthy    = false;
        int    peers      = 0;
        double tempo      = 120.0;
        double beat       = 0.0;
        double phase      = 0.0;
        double quantum    = 4.0;
        bool   playing    = false;
        double timestamp  = 0.0;      // host time µs
        std::string tempoSource = "dj"; // "dj" | "link"
    };

    using TempoChangeCb = std::function<void(double newBpm, std::string_view source)>;
    using PeerChangeCb  = std::function<void(int peerCount)>;

    explicit LinkService (double initialBpm = 120.0);
    ~LinkService();

    // ── Control ───────────────────────────────────────────────────────────────
    void setEnabled        (bool on);
    bool isEnabled         () const { return link_.isEnabled(); }

    void setTempo          (double bpm);          // DJ pushes tempo to Link
    void setQuantum        (double quantum);
    void setStartStopSync  (bool on);
    void setTempoPolicy    (TempoPolicy p);
    void setPlaying        (bool playing);        // for start/stop sync

    // ── Snapshot ──────────────────────────────────────────────────────────────
    Snapshot snapshotLink  () const;

    // ── Callbacks (set before enabling) ──────────────────────────────────────
    void onTempoChange (TempoChangeCb cb) { tempoCb_ = std::move(cb); }
    void onPeerChange  (PeerChangeCb  cb) { peerCb_  = std::move(cb); }

private:
    mutable ableton::Link link_;

    std::atomic<double>       quantum_     { 4.0 };
    std::atomic<bool>         startStop_   { false };
    std::atomic<TempoPolicy>  policy_      { TempoPolicy::AcceptExternal };
    std::atomic<double>       djTempo_     { 120.0 };   // last DJ-set tempo
    std::atomic<bool>         restoredOnce_{ false };

    TempoChangeCb tempoCb_;
    PeerChangeCb  peerCb_;
    mutable std::mutex cbMutex_;
};
