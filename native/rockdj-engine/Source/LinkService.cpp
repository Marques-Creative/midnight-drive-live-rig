#include "LinkService.h"
#include <chrono>
#include <cmath>

LinkService::LinkService (double initialBpm)
    : link_ (initialBpm), djTempo_ (initialBpm)
{
    // Register peer-count callback — fires on Link's internal thread.
    link_.setNumPeersCallback ([this] (std::size_t peers)
    {
        std::lock_guard<std::mutex> lk (cbMutex_);
        if (peerCb_) peerCb_ (static_cast<int> (peers));
    });

    // Register tempo-change callback — fires when a PEER changes tempo.
    link_.setTempoCallback ([this] (double bpm)
    {
        const auto policy = policy_.load();

        if (policy == TempoPolicy::LockLocal)
            return;   // ignore peer tempo changes entirely

        if (policy == TempoPolicy::RestoreOnce && restoredOnce_.exchange (true))
        {
            // Already applied once; subsequent changes are ignored.
            return;
        }

        // Apply the new tempo to the Link session
        auto session = link_.captureAppSessionState();
        session.setTempo (bpm, link_.clock().micros());
        link_.commitAppSessionState (session);

        {
            std::lock_guard<std::mutex> lk (cbMutex_);
            if (tempoCb_) tempoCb_ (bpm, "link");
        }
    });

    link_.enable (false);   // start disabled; UI enables explicitly
}

LinkService::~LinkService()
{
    link_.enable (false);
}

void LinkService::setEnabled (bool on)
{
    link_.enable (on);
    if (on)
    {
        // Push current DJ tempo into the session when enabling.
        auto s = link_.captureAppSessionState();
        s.setTempo (djTempo_.load(), link_.clock().micros());
        link_.commitAppSessionState (s);
    }
}

void LinkService::setTempo (double bpm)
{
    djTempo_.store (bpm);
    restoredOnce_.store (false);   // allow RestoreOnce to fire again on DJ tempo set

    if (! link_.isEnabled()) return;

    // Avoid feedback: only push if the session tempo differs by >0.01 BPM.
    auto s   = link_.captureAppSessionState();
    auto now = link_.clock().micros();
    const double current = s.tempo();
    if (std::abs (current - bpm) > 0.01)
    {
        s.setTempo (bpm, now);
        link_.commitAppSessionState (s);
    }
}

void LinkService::setQuantum (double quantum)
{
    quantum_.store (quantum);
}

void LinkService::setStartStopSync (bool on)
{
    link_.enableStartStopSync (on);
    startStop_.store (on);
}

void LinkService::setTempoPolicy (TempoPolicy p)
{
    policy_.store (p);
    restoredOnce_.store (false);
}

void LinkService::setPlaying (bool playing)
{
    if (! startStop_.load()) return;
    auto s   = link_.captureAppSessionState();
    auto now = link_.clock().micros();
    s.setIsPlaying (playing, now);
    link_.commitAppSessionState (s);
}

LinkService::Snapshot LinkService::snapshotLink() const
{
    Snapshot snap;
    snap.enabled = link_.isEnabled();
    snap.peers   = static_cast<int> (link_.numPeers());
    snap.healthy = snap.enabled;   // healthy = enabled + functional (no deeper check needed)

    auto now = link_.clock().micros();
    auto s   = link_.captureAppSessionState();
    const double q = quantum_.load();

    snap.tempo   = s.tempo();
    snap.beat    = s.beatAtTime (now, q);
    snap.phase   = s.phaseAtTime (now, q);
    snap.quantum = q;
    snap.playing = s.isPlaying();
    snap.timestamp = static_cast<double> (now.count());

    // Report whether the most recent tempo change came from a Link peer
    const double djT = djTempo_.load();
    snap.tempoSource = (std::abs (snap.tempo - djT) < 0.5) ? "dj" : "link";

    return snap;
}
