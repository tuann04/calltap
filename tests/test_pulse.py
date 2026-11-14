from calltap.pulse import (
    is_browser_capturing_mic,
    parse_source_outputs,
    parse_sources_short,
)

SOURCES_SHORT = """\
0\taudio_output.monitor\tmodule-null-sink.c\ts16le 2ch 48000Hz\tRUNNING
1\taudio_input.monitor\tmodule-null-sink.c\ts16le 2ch 48000Hz\tIDLE
2\tmicrophone\tmodule-virtual-source.c\ts16le 2ch 48000Hz\tRUNNING
"""

SOURCE_OUTPUTS_ACTIVE = """\
Source Output #41
\tDriver: protocol-native.c
\tSource: 2
\tCorked: no
\tProperties:
\t\tapplication.name = "Google Chrome"
\t\tapplication.process.binary = "chrome"

Source Output #42
\tDriver: protocol-native.c
\tSource: 1
\tCorked: no
\tProperties:
\t\tapplication.name = "Lavf61.7.100"
\t\tapplication.process.binary = "ffmpeg"
"""

SOURCE_OUTPUTS_IDLE = """\
Source Output #41
\tDriver: protocol-native.c
\tSource: 2
\tCorked: yes
\tProperties:
\t\tapplication.name = "Google Chrome"
\t\tapplication.process.binary = "chrome"

Source Output #42
\tDriver: protocol-native.c
\tSource: 1
\tCorked: no
\tProperties:
\t\tapplication.name = "Lavf61.7.100"
\t\tapplication.process.binary = "ffmpeg"
"""


def test_parse_sources_short() -> None:
    mapping = parse_sources_short(SOURCES_SHORT)
    assert mapping == {
        0: "audio_output.monitor",
        1: "audio_input.monitor",
        2: "microphone",
    }


def test_detects_chrome_and_ignores_ffmpeg() -> None:
    sources = parse_sources_short(SOURCES_SHORT)
    outputs = parse_source_outputs(SOURCE_OUTPUTS_ACTIVE, sources)
    hit = is_browser_capturing_mic(
        outputs,
        mic_source_names=["microphone", "audio_input.monitor"],
        browser_hints=["chrome", "chromium", "firefox"],
    )
    assert hit is not None
    assert hit.index == 41
    assert hit.source_name == "microphone"


def test_ignores_corked_chrome_and_active_ffmpeg() -> None:
    sources = parse_sources_short(SOURCES_SHORT)
    outputs = parse_source_outputs(SOURCE_OUTPUTS_IDLE, sources)
    hit = is_browser_capturing_mic(
        outputs,
        mic_source_names=["microphone", "audio_input.monitor"],
        browser_hints=["chrome", "chromium", "firefox"],
    )
    assert hit is None
