"""
Pipeline orchestration scaffolding.

The goal for the first iteration is to expose a high-level API that mirrors the
specification without committing to the underlying GStreamer implementation.
Subsequent tasks can progressively replace the placeholders with working
pipelines and pad wiring.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional

from .graph import MixerBuilder, PanicSwitch, ShaderChain, SourceFactory, OutputFactory
from .rtc import PreviewBranch


class SourceType(str, Enum):
    """Supported upstream media types."""

    FILE = "file"
    NDI = "ndi"
    CAMERA = "camera"
    GENERATOR = "generator"


class OutputType(str, Enum):
    """Supported downstream consumers."""

    SCREEN = "screen"
    NDI = "ndi"
    FILE = "file"
    WEBRTC = "webrtc"


@dataclass
class VideoSourceConfig:
    id: str
    type: SourceType
    uri: Optional[str] = None
    params: Dict[str, str] = field(default_factory=dict)


@dataclass
class OutputConfig:
    id: str
    type: OutputType
    params: Dict[str, str] = field(default_factory=dict)


@dataclass
class PipelineGraph:
    video_sources: List[VideoSourceConfig] = field(default_factory=list)
    outputs: List[OutputConfig] = field(default_factory=list)
    shaders: List[str] = field(default_factory=list)


class Pipeline:
    """
    Mutable pipeline facade used by the engine runtime.

    Methods currently only update in-memory state; they will eventually wire up
    real GstElements.
    """

    def __init__(self) -> None:
        self.graph = PipelineGraph()
        self._is_running = False
        self.mixer = MixerBuilder()
        self.shader_chain = ShaderChain()
        self.source_factory = SourceFactory()
        self.output_factory = OutputFactory()
        self.preview_branch = PreviewBranch()
        self.panic_switch = PanicSwitch()

    @property
    def is_running(self) -> bool:
        return self._is_running

    def add_video_source(self, config: VideoSourceConfig) -> None:
        self.graph.video_sources.append(config)

    def remove_video_source(self, source_id: str) -> None:
        self.graph.video_sources = [
            source for source in self.graph.video_sources if source.id != source_id
        ]

    def add_output(self, config: OutputConfig) -> None:
        self.graph.outputs.append(config)

    def remove_output(self, output_id: str) -> None:
        self.graph.outputs = [output for output in self.graph.outputs if output.id != output_id]

    def set_shaders(self, shader_sources: List[str]) -> None:
        self.graph.shaders = list(shader_sources)

    def start(self) -> None:
        self._is_running = True

    def stop(self) -> None:
        self._is_running = False

    def describe(self) -> Dict[str, object]:
        """
        Return a serialisable snapshot of the pipeline graph.
        """

        return {
            "running": self._is_running,
            "video_sources": [vars(source) for source in self.graph.video_sources],
            "outputs": [vars(output) for output in self.graph.outputs],
            "shader_passes": [vars(shader_pass) for shader_pass in self.shader_chain.passes],
            "panic": vars(self.panic_switch.state),
        }

