from __future__ import annotations

import json

from engine.pipeline import OutputConfig, OutputType, Pipeline, SourceType, VideoSourceConfig
from engine.runtime.gst_adapter import GStreamerPipelineAdapter


def test_pipeline_describe_is_json_serialisable(tmp_path) -> None:
    pipeline = Pipeline()
    sample = tmp_path / "sample.mp4"
    sample.write_text("media")

    pipeline.add_output(OutputConfig(id="screen", type=OutputType.SCREEN))
    pipeline.set_deck_source("a", str(sample))

    snapshot = pipeline.describe()

    # Should not raise
    json.dumps(snapshot, sort_keys=True)


def test_gstreamer_adapter_handles_missing_runtime(tmp_path) -> None:
    pipeline = Pipeline()
    sample = tmp_path / "clip.mp4"
    sample.write_text("media")

    adapter = GStreamerPipelineAdapter(pipeline)

    # Start/stop should succeed even if GStreamer is not available.
    adapter.start()
    pipeline.set_deck_source("a", str(sample))
    pipeline.start()
    adapter.sync()
    adapter.stop()


def test_adapter_extracts_generator_sources() -> None:
    pipeline = Pipeline()
    adapter = GStreamerPipelineAdapter(pipeline)

    source_id = pipeline.source_id_for_deck("a")
    pipeline.add_video_source(
        VideoSourceConfig(id=source_id, type=SourceType.GENERATOR, params={"pattern": "smpte"})
    )
    snapshot = pipeline.describe()

    payloads = adapter._extract_active_decks(snapshot)  # type: ignore[attr-defined]

    assert payloads
    assert payloads[0]["source_type"] == SourceType.GENERATOR.value
