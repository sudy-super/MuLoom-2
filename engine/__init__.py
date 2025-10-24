"""
MuLoom Render Engine package.

This package hosts the realtime video rendering engine described in
``muloom_a_plan_impl_spec_ja.md``.  The initial implementation focuses on
providing strongly typed scaffolding so the rest of the application can iterate
incrementally while the GStreamer integration is brought online.
"""

from __future__ import annotations

__all__ = [
    "EngineConfig",
    "RuntimeState",
]


class EngineConfig:
    """Placeholder for top level engine configuration."""

    def __init__(self, profile: str = "default") -> None:
        self.profile = profile


class RuntimeState:
    """
    Shared in-memory state representation used by the control API and
    orchestration layer.
    """

    def __init__(self) -> None:
        self.running = False
        self.current_scene: str | None = None

