"""
GStreamer pipeline orchestration.

The previous iteration only kept an in-memory description of the intended
graph.  This revision materialises a single GStreamer pipeline that owns the
render graph and fans out to the WebRTC preview branch and the program output
branch.  UI components no longer run independent replay loops; the engine is
the single source of truth for timing.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Sequence, Tuple, TYPE_CHECKING

try:
    import gi  # type: ignore

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst  # type: ignore
except (ImportError, ValueError) as exc:  # pragma: no cover - runtime guard
    Gst = None  # type: ignore[assignment]
    _GST_IMPORT_ERROR = exc
else:  # pragma: no cover - initialisation only hits at runtime
    Gst.init(None)
    _GST_IMPORT_ERROR = None

from .graph.mixers import MixerLayer
from .graph import PanicSwitch, ShaderChain
from .rtc import PreviewBranch

if TYPE_CHECKING:  # pragma: no cover - typing aid
    from gi.repository import Gst as GstModule
else:
    GstModule = Any

LOG = logging.getLogger(__name__)


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


def _require_gstreamer() -> None:
    if Gst is None:  # pragma: no cover - runtime guard
        raise RuntimeError(
            "GStreamer runtime is not available. Install PyGObject/GStreamer "
            "1.20+ to enable pipeline execution."
        ) from _GST_IMPORT_ERROR


class Pipeline:
    """
    Mutable pipeline facade used by the engine runtime.

    The instance owns both the static graph description (for API inspection)
    and the live GstPipeline when :meth:`start` is invoked.
    """

    def __init__(self) -> None:
        self.graph = PipelineGraph()
        self._is_running = False
        self.preview_branch = PreviewBranch()
        self.shader_chain = ShaderChain()
        self.panic_switch = PanicSwitch()
        self._pipeline: Optional[GstModule.Pipeline] = None
        self._bus: Optional[GstModule.Bus] = None
        self._bus_watch_id: Optional[int] = None
        self._mixer: Optional[GstModule.Element] = None
        self._tee: Optional[GstModule.Element] = None
        self._mixer_sink_pads: Dict[str, GstModule.Pad] = {}
        self._pad_added_handlers: List[Tuple[GstModule.Element, int]] = []
        self._mixer_layers: List[MixerLayer] = []
        self._needs_rebuild = True
        self._deck_sources: Dict[str, str] = {}

    # --------------------------------------------------------------------- API

    @property
    def is_running(self) -> bool:
        return self._is_running

    def add_video_source(self, config: VideoSourceConfig) -> None:
        self._upsert_video_source_config(config)

    def remove_video_source(self, source_id: str) -> None:
        self.graph.video_sources = [
            source for source in self.graph.video_sources if source.id != source_id
        ]
        self._needs_rebuild = True

    def add_output(self, config: OutputConfig) -> None:
        self.graph.outputs.append(config)
        self._needs_rebuild = True

    def remove_output(self, output_id: str) -> None:
        self.graph.outputs = [output for output in self.graph.outputs if output.id != output_id]
        self._needs_rebuild = True

    def set_shaders(self, shader_sources: List[str]) -> None:
        self.graph.shaders = list(shader_sources)
        self._needs_rebuild = True

    def set_mixer_layers(self, layers: Sequence[MixerLayer]) -> None:
        self._mixer_layers = list(layers)
        self._apply_mixer_layers()

    def set_deck_source(self, deck_key: str, uri: Optional[str]) -> None:
        source_id = self.source_id_for_deck(deck_key)
        clean_uri = uri.strip() if isinstance(uri, str) else None
        if clean_uri:
            config = VideoSourceConfig(id=source_id, type=SourceType.FILE, uri=clean_uri)
            self._deck_sources[deck_key] = clean_uri
            self._upsert_video_source_config(config)
        else:
            self._deck_sources.pop(deck_key, None)
            self.remove_video_source(source_id)
        try:
            self.start()
        except Exception:  # pragma: no cover - defensive
            LOG.exception("Failed to (re)start pipeline after updating deck '%s'", deck_key)

    def start(self) -> None:
        _require_gstreamer()

        if self._pipeline and not self._needs_rebuild:
            if not self._is_running:
                self._set_state(Gst.State.PLAYING)
            return

        if self._pipeline:
            self.stop()

        self._pipeline = self._build_pipeline()
        self._needs_rebuild = False
        self._set_state(Gst.State.PLAYING)
        self._is_running = True

    def stop(self) -> None:
        if not self._pipeline:
            self._is_running = False
            return

        try:
            self._pipeline.set_state(Gst.State.NULL)
        except Exception:  # pragma: no cover - defensive
            LOG.exception("Failed to set pipeline to NULL during shutdown")

        if self._bus and self._bus_watch_id is not None:
            try:
                self._bus.disconnect(self._bus_watch_id)
            except Exception:  # pragma: no cover - defensive
                LOG.debug("Bus disconnect failed during stop", exc_info=True)
            self._bus.remove_signal_watch()

        for element, handler in self._pad_added_handlers:
            try:
                element.disconnect(handler)
            except Exception:  # pragma: no cover - defensive
                LOG.debug("Failed to disconnect pad-added handler", exc_info=True)
        self._pad_added_handlers.clear()

        if self._mixer:
            for pad in self._mixer_sink_pads.values():
                try:
                    self._mixer.release_request_pad(pad)
                except Exception:  # pragma: no cover - defensive
                    LOG.debug("Failed to release mixer pad", exc_info=True)
        self._mixer_sink_pads.clear()

        self._pipeline = None
        self._bus = None
        self._bus_watch_id = None
        self._mixer = None
        self._tee = None
        self._is_running = False
        self._needs_rebuild = True

    def describe(self) -> Dict[str, object]:
        """
        Return a serialisable snapshot of the pipeline graph and runtime state.
        """

        return {
            "running": self._is_running,
            "video_sources": [vars(source) for source in self.graph.video_sources],
            "outputs": [vars(output) for output in self.graph.outputs],
            "shader_passes": [vars(shader_pass) for shader_pass in self.shader_chain.passes],
            "panic": vars(self.panic_switch.state),
            "mixer_layers": [vars(layer) for layer in self._mixer_layers],
        }

    # ----------------------------------------------------------------- plumbing

    def _set_state(self, state: GstModule.State) -> None:
        if not self._pipeline:
            return
        result = self._pipeline.set_state(state)
        if result == Gst.StateChangeReturn.FAILURE:
            raise RuntimeError(f"Failed to set pipeline state to {state}.")
        if result == Gst.StateChangeReturn.ASYNC and not self._bus_watch_id:
            # Ensure we react to async failures emitted on the bus.
            self._install_bus_watch(self._pipeline)

    def _install_bus_watch(self, pipeline: GstModule.Pipeline) -> None:
        bus = pipeline.get_bus()
        if not bus:
            return
        bus.add_signal_watch()
        self._bus = bus
        self._bus_watch_id = bus.connect("message", self._on_bus_message)

    def _on_bus_message(self, _bus: GstModule.Bus, message: GstModule.Message) -> None:
        message_type = message.type
        if message_type == Gst.MessageType.ERROR:
            err, debug = message.parse_error()
            LOG.error("Pipeline error: %s (%s)", err, debug)
            self.stop()
        elif message_type == Gst.MessageType.EOS:
            LOG.info("Pipeline reached EOS")
            self.stop()

    # -------------------------------------------------------------- construction

    def _build_pipeline(self) -> GstModule.Pipeline:
        _require_gstreamer()

        pipeline = Gst.Pipeline.new("muloom")
        if not pipeline:
            raise RuntimeError("Failed to create GstPipeline instance.")

        self._install_bus_watch(pipeline)

        mixer = self._make_element("glvideomixer", "master_mixer")
        mixer.set_property("background", 1)  # transparent black
        pipeline.add(mixer)
        self._mixer = mixer

        tee = self._make_element("tee", "master_tee")
        pipeline.add(tee)
        self._tee = tee

        mixer_queue = self._make_queue("master_mixer_queue")
        pipeline.add(mixer_queue)
        if not mixer.link(mixer_queue):
            raise RuntimeError("Failed to link glvideomixer to mixer queue.")
        if not mixer_queue.link(tee):
            raise RuntimeError("Failed to link mixer queue to tee.")

        self._mixer_sink_pads.clear()
        for config in self.graph.video_sources:
            try:
                self._attach_video_source(pipeline, mixer, config)
            except Exception:
                LOG.exception("Failed to attach video source '%s'", config.id)

        self._build_preview_branch(pipeline, tee)
        self._build_program_branch(pipeline, tee)
        self._apply_mixer_layers()

        return pipeline

    def _attach_video_source(
        self,
        pipeline: GstModule.Pipeline,
        mixer: GstModule.Element,
        config: VideoSourceConfig,
    ) -> None:
        if config.type != SourceType.FILE:
            LOG.warning("Source type '%s' is not yet implemented; skipping.", config.type)
            return

        uri = config.uri or config.params.get("uri")
        if not uri:
            raise ValueError(f"File source '{config.id}' is missing a URI.")

        sanitize = self._sanitize(config.id)
        decode = self._make_element("uridecodebin", f"decode_{sanitize}")
        decode.set_property("uri", uri)

        convert = self._make_element("videoconvert", f"convert_{sanitize}")
        upload = self._make_element("glupload", f"glupload_{sanitize}")
        queue = self._make_queue(f"queue_{sanitize}")

        for element in (decode, convert, upload, queue):
            pipeline.add(element)

        if not convert.link(upload):
            raise RuntimeError(f"Failed to link videoconvert for source '{config.id}'.")
        if not upload.link(queue):
            raise RuntimeError(f"Failed to link glupload for source '{config.id}'.")

        mixer_pad = mixer.get_request_pad("sink_%u")
        if mixer_pad is None:
            raise RuntimeError("Failed to request sink pad from glvideomixer.")
        mixer_pad.set_property("alpha", 0.0)

        queue_src_pad = queue.get_static_pad("src")
        if not queue_src_pad:
            raise RuntimeError("Queue source pad not available.")
        if queue_src_pad.link(mixer_pad) != Gst.PadLinkReturn.OK:
            raise RuntimeError(f"Failed to link queue to mixer for source '{config.id}'.")
        self._mixer_sink_pads[config.id] = mixer_pad

        def _on_pad_added(bin_: GstModule.Element, pad: GstModule.Pad, target: GstModule.Element) -> None:
            caps = pad.get_current_caps() or pad.get_allowed_caps()
            if not caps:
                return
            structure = caps.get_structure(0)
            if not structure:
                return
            media_type = structure.get_name()
            if not media_type.startswith("video/"):
                return
            sink_pad = target.get_static_pad("sink")
            if not sink_pad or sink_pad.is_linked():
                return
            if pad.link(sink_pad) != Gst.PadLinkReturn.OK:
                LOG.error("Failed to link decodebin video pad for '%s'.", config.id)

        handler_id = decode.connect("pad-added", _on_pad_added, convert)
        self._pad_added_handlers.append((decode, handler_id))

    def _build_preview_branch(self, pipeline: GstModule.Pipeline, tee: GstModule.Element) -> None:
        queue = self._make_queue("preview_queue")
        gldownload = self._make_element("gldownload", "preview_gldownload")
        convert = self._make_element("videoconvert", "preview_convert")
        encoder = self._make_element(self.preview_branch.encoder, "preview_encoder")
        payloader = self._make_element(self.preview_branch.payloader, "preview_payloader")
        sink = self._make_element("webrtcsink", "preview_webrtcsink", required=False)

        if sink is None:
            LOG.warning("webrtcsink not available; falling back to fakesink preview.")
            sink = self._make_element("fakesink", "preview_fallback")
            sink.set_property("sync", False)
        else:
            if hasattr(sink.props, "stun_server") and not sink.props.stun_server:
                sink.set_property("stun-server", "stun://stun.l.google.com:19302")

        self._apply_element_params(encoder, self.preview_branch.encoder_params)
        payloader.set_property("pt", 96)

        for element in (queue, gldownload, convert, encoder, payloader, sink):
            pipeline.add(element)

        if not tee.link(queue):
            raise RuntimeError("Failed to link tee to preview queue.")
        if not queue.link(gldownload):
            raise RuntimeError("Failed to link preview queue to gldownload.")
        if not gldownload.link(convert):
            raise RuntimeError("Failed to link preview gldownload to videoconvert.")
        if not convert.link(encoder):
            raise RuntimeError("Failed to link preview convert to encoder.")
        if not encoder.link(payloader):
            raise RuntimeError("Failed to link preview encoder to payloader.")
        if not payloader.link(sink):
            raise RuntimeError("Failed to link preview payloader to sink.")

    def _build_program_branch(self, pipeline: GstModule.Pipeline, tee: GstModule.Element) -> None:
        queue = self._make_queue("program_queue")
        gldownload = self._make_element("gldownload", "program_gldownload")
        convert = self._make_element("videoconvert", "program_convert")
        sink = self._make_element("osxvideosink", "program_osxvideosink", required=False)

        if sink is None:
            LOG.warning("osxvideosink not available; using autovideosink fallback.")
            sink = self._make_element("autovideosink", "program_autosink")
        else:
            if sink.find_property("sync"):
                sink.set_property("sync", True)

        for element in (queue, gldownload, convert, sink):
            pipeline.add(element)

        if not tee.link(queue):
            raise RuntimeError("Failed to link tee to program queue.")
        if not queue.link(gldownload):
            raise RuntimeError("Failed to link program queue to gldownload.")
        if not gldownload.link(convert):
            raise RuntimeError("Failed to link program gldownload to videoconvert.")
        if not convert.link(sink):
            raise RuntimeError("Failed to link program convert to sink.")

    # -------------------------------------------------------------- helpers/util

    def _apply_mixer_layers(self) -> None:
        if not self._mixer:
            return

        active_sources = {layer.source_id: layer for layer in self._mixer_layers}
        for source_id, pad in self._mixer_sink_pads.items():
            layer = active_sources.get(source_id)
            opacity = layer.opacity if layer else 0.0
            try:
                pad.set_property("alpha", float(opacity))
            except Exception:  # pragma: no cover - defensive
                LOG.debug("Failed to set alpha on mixer pad '%s'", source_id, exc_info=True)

    @staticmethod
    def _sanitize(value: str) -> str:
        cleaned = re.sub(r"[^0-9A-Za-z_]+", "_", value)
        return cleaned or "source"

    def source_id_for_deck(self, deck_key: str) -> str:
        return f"deck_{self._sanitize(deck_key)}"

    def _upsert_video_source_config(self, config: VideoSourceConfig) -> None:
        for index, existing in enumerate(self.graph.video_sources):
            if existing.id == config.id:
                self.graph.video_sources[index] = config
                break
        else:
            self.graph.video_sources.append(config)
        self._needs_rebuild = True

    @staticmethod
    def _coerce_param(value: Any) -> Any:
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"true", "false"}:
                return lowered == "true"
            try:
                if "." in lowered:
                    return float(lowered)
                return int(lowered, 0)
            except ValueError:
                return value
        return value

    def _apply_element_params(self, element: GstModule.Element, params: Dict[str, Any]) -> None:
        for key, value in params.items():
            try:
                element.set_property(key, self._coerce_param(value))
            except Exception:  # pragma: no cover - defensive
                LOG.debug(
                    "Failed to set property '%s' on element '%s'",
                    key,
                    element.get_name(),
                    exc_info=True,
                )

    def _make_element(
        self,
        factory: str,
        name: Optional[str] = None,
        *,
        required: bool = True,
    ) -> Optional[GstModule.Element]:
        element = Gst.ElementFactory.make(factory, name)
        if element:
            return element
        if required:
            raise RuntimeError(f"GStreamer element factory '{factory}' is not available.")
        return None

    @staticmethod
    def _make_queue(name: str) -> GstModule.Element:
        queue = Gst.ElementFactory.make("queue", name)
        if not queue:
            raise RuntimeError("Failed to create queue element.")
        queue.set_property("leaky", 2)
        queue.set_property("max-size-buffers", 0)
        queue.set_property("max-size-bytes", 0)
        queue.set_property("max-size-time", 100_000_000)  # 100ms
        return queue
