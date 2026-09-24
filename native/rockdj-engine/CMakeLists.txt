# ─────────────────────────────────────────────────────────────────────────────
# ROCKDJ audio engine - headless background service (Milestone 3a)
#
# Builds a single console executable, `rockdj-engine`, that the Electron app
# launches and controls over a local socket. It links only the NON-GUI JUCE
# audio modules, so it has no window and no X11/Cocoa UI dependency.
#
# JUCE is downloaded automatically by CMake (same as the spike). Build with:
#   cmake -B build -DCMAKE_BUILD_TYPE=Release
#   cmake --build build --config Release -j4
# The binary lands at: build/rockdj-engine_artefacts/Release/rockdj-engine
# ─────────────────────────────────────────────────────────────────────────────

cmake_minimum_required(VERSION 3.22)
project(ROCKDJEngine VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(APPLE)
    set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "" FORCE)
endif()

include(FetchContent)
FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        8.0.14
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(JUCE)

# ── Queen Mary DSP library (beat/tempo detection) ────────────────────────────
# The same beat-tracking research Mixxx's analyzer is built on. We compile just
# the sources needed for onset detection + tempo tracking. GPL — fine for
# private use; revisit licensing before commercial distribution.
FetchContent_Declare(
    qmdsp
    GIT_REPOSITORY https://github.com/c4dm/qm-dsp.git
    GIT_TAG        e34a3cc188332ed7c33cd9257ef164de5b587191
)
FetchContent_MakeAvailable(qmdsp)

# ── Ableton Link SDK (vendored) ───────────────────────────────────────────────
# Link is header-only for the timing core. We include its headers directly and
# provide the platform define ourselves. JUCE already brings in ASIO, so we
# add Link's ASIO path separately to avoid the duplicate target error.
set(LINK_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/link)

add_library(qmdsp_core STATIC
    ${qmdsp_SOURCE_DIR}/dsp/onsets/DetectionFunction.cpp
    ${qmdsp_SOURCE_DIR}/dsp/onsets/PeakPicking.cpp
    ${qmdsp_SOURCE_DIR}/dsp/tempotracking/TempoTrackV2.cpp
    ${qmdsp_SOURCE_DIR}/dsp/tempotracking/DownBeat.cpp
    ${qmdsp_SOURCE_DIR}/dsp/transforms/FFT.cpp
    ${qmdsp_SOURCE_DIR}/dsp/phasevocoder/PhaseVocoder.cpp
    ${qmdsp_SOURCE_DIR}/dsp/signalconditioning/DFProcess.cpp
    ${qmdsp_SOURCE_DIR}/dsp/signalconditioning/Filter.cpp
    ${qmdsp_SOURCE_DIR}/dsp/signalconditioning/FiltFilt.cpp
    ${qmdsp_SOURCE_DIR}/dsp/signalconditioning/Framer.cpp
    ${qmdsp_SOURCE_DIR}/dsp/rateconversion/Decimator.cpp
    ${qmdsp_SOURCE_DIR}/maths/MathUtilities.cpp
    ${qmdsp_SOURCE_DIR}/base/Pitch.cpp
    ${qmdsp_SOURCE_DIR}/base/KaiserWindow.cpp
    ${qmdsp_SOURCE_DIR}/base/SincWindow.cpp
    ${qmdsp_SOURCE_DIR}/ext/kissfft/kiss_fft.c
    ${qmdsp_SOURCE_DIR}/ext/kissfft/tools/kiss_fftr.c
)
target_include_directories(qmdsp_core PUBLIC
    ${qmdsp_SOURCE_DIR}
    ${qmdsp_SOURCE_DIR}/ext/kissfft
    ${qmdsp_SOURCE_DIR}/ext/kissfft/tools
)
target_compile_definitions(qmdsp_core PUBLIC kiss_fft_scalar=double)
set_target_properties(qmdsp_core PROPERTIES CXX_STANDARD 17 POSITION_INDEPENDENT_CODE ON)

juce_add_console_app(rockdj-engine
    PRODUCT_NAME "rockdj-engine"
)

target_sources(rockdj-engine PRIVATE
    Source/Main.cpp
    Source/AudioEngine.cpp
    Source/ControlServer.cpp
    Source/BeatDetector.cpp
    Source/LinkService.cpp
)

# Signalsmith Stretch + Linear: vendored (both MIT), pinned, header-only.
# Vendored rather than FetchContent'd on purpose - a gig build must not depend
# on a network fetch succeeding.
target_include_directories(rockdj-engine PRIVATE
    ${LINK_DIR}/include
    ${LINK_DIR}/modules/asio-standalone/asio/include
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/signalsmith-stretch/include/signalsmith-stretch
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/signalsmith-linear/include
)

target_compile_definitions(rockdj-engine PRIVATE
    $<IF:$<BOOL:${APPLE}>,LINK_PLATFORM_MACOSX=1,LINK_PLATFORM_LINUX=1>
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_STANDALONE_APPLICATION=1
)

# Only audio + core modules — deliberately NO juce_gui_* so this stays headless.
target_link_libraries(rockdj-engine PRIVATE
    qmdsp_core
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_basics
    juce::juce_core
    juce::juce_events
    PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)
