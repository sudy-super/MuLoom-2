"""Quick demo script for the GStreamer execution adapter.

This utility allows developers to verify the end-to-end flow between the
declarative pipeline state store and the GStreamer-backed runtime adapter.

Examples
--------
Play a local MP4 file on deck A and preview the default outputs::

    python scripts/demo_gst_adapter.py --uri file:///path/to/video.mp4

Generate a colour bars test pattern instead of a file::

    python scripts/demo_gst_adapter.py --generator smpte

Multiple inputs can be provided; they will be mapped to decks a, b, c, d::

    python scripts/demo_gst_adapter.py \
        --uri file:///path/to/a.mp4 \
        --uri file:///path/to/b.mp4

Press Ctrl+C to terminate playback.
"""

from __future__ import annotations

import argparse
import signal
import sys
import time
from typing import Iterable

from engine.graph.mixers import MixerLayer
from engine.pipeline import Pipeline, SourceType, VideoSourceConfig
from engine.runtime.gst_adapter import GStreamerPipelineAdapter


DEFAULT_DECK_KEYS = ("a", "b", "c", "d")


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MuLoom GStreamer adapter demo")
    parser.add_argument(
        "--uri",
        action="append",
        default=[],
        help="Media URI to load (mapped to decks a/b/c/d in order).",
    )
    parser.add_argument(
        "--generator",
        action="append",
        default=[],
        help="Use a generator pattern instead of a file (e.g. smpte, snow).",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=0.0,
        help="Optional duration in seconds; 0 means run until interrupted.",
    )
    return parser.parse_args(argv)


def apply_sources(pipeline: Pipeline, uris: list[str], generators: list[str]) -> None:
    layers: list[MixerLayer] = []
    for index, key in enumerate(DEFAULT_DECK_KEYS):
        if index < len(uris):
            pipeline.set_deck_source(key, uris[index])
            layers.append(MixerLayer(source_id=pipeline.source_id_for_deck(key), opacity=1.0))
        elif index < len(uris) + len(generators):
            generator_index = index - len(uris)
            source_id = pipeline.source_id_for_deck(key)
            pipeline.add_video_source(
                VideoSourceConfig(
                    id=source_id,
                    type=SourceType.GENERATOR,
                    params={"pattern": generators[generator_index]},
                )
            )
            layers.append(MixerLayer(source_id=source_id, opacity=1.0))
        else:
            pipeline.set_deck_source(key, None)
    pipeline.set_mixer_layers(layers)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)

    pipeline = Pipeline()
    adapter = GStreamerPipelineAdapter(pipeline)

    apply_sources(pipeline, args.uri, args.generator)

    adapter.start()
    pipeline.start()

    stop_requested = False

    def _handle_signal(signum, frame):  # type: ignore[override]
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    try:
        start_time = time.monotonic()
        while not stop_requested:
            time.sleep(0.1)
            if args.duration > 0 and time.monotonic() - start_time >= args.duration:
                break
    finally:
        adapter.stop()
        pipeline.stop()

    return 0


if __name__ == "__main__":
    sys.exit(main())
