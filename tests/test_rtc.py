"""Tests covering WebRTC preview branch configuration."""

from engine.rtc.preview_branch import PreviewBranch


def test_preview_branch_iter_sink_properties() -> None:
    branch = PreviewBranch(
        turn_server="turn://turn.example.com",
        latency_ms=150,
        extra_properties={"bundle-policy": "max-bundle"},
    )

    props = branch.iter_sink_properties()

    assert props["latency"] == 150
    assert props["bundle-policy"] == "max-bundle"
    assert props["signaller::uri"] == branch.signaller_uri
    assert props["turn-server"] == "turn://turn.example.com"
