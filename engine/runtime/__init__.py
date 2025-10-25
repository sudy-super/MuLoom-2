"""
Runtime adapters bridging the declarative pipeline to executable backends.
"""

from __future__ import annotations

from .gst_adapter import GStreamerPipelineAdapter, PipelineAdapter

__all__ = [
    "PipelineAdapter",
    "GStreamerPipelineAdapter",
]
