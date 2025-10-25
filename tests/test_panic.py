"""Tests covering pipeline fallback behaviour and deck bookkeeping."""

from __future__ import annotations

from pathlib import Path

from engine.pipeline import Pipeline


def test_pipeline_describe_contains_deck_entries() -> None:
    pipeline = Pipeline()
    describe = pipeline.describe()
    decks = describe.get("decks")

    assert isinstance(decks, dict)
    for key in ("a", "b", "c", "d"):
        assert key in decks
        entry = decks[key]
        assert entry["state"] == "IDLE"
        assert entry["activeRevision"] == 0
        assert entry["requestedUri"] is None


def test_set_deck_source_tracks_revision(tmp_path: Path) -> None:
    pipeline = Pipeline()
    sample_file = tmp_path / "sample.mp4"
    sample_file.write_text("placeholder")

    revision_1 = pipeline.set_deck_source("a", str(sample_file))
    revision_2 = pipeline.set_deck_source("a", str(sample_file))

    assert revision_1 == 1
    assert revision_2 == 2

    pending = pipeline._deck_pending_requests.get("a")  # type: ignore[attr-defined]
    assert pending is not None
    _, pending_revision = pending
    assert pending_revision == revision_2

    describe = pipeline.describe()
    decks = describe.get("decks", {})
    expected_uri = sample_file.resolve().as_uri()
    assert decks.get("a", {}).get("requestedUri") == expected_uri
