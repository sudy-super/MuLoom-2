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
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
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

BUS_POLL_INTERVAL_NS = 100_000_000  # 100ms


class PipelineUnavailableError(RuntimeError):
    """Raised when the pipeline cannot be materialised due to missing dependencies."""


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
        raise PipelineUnavailableError(
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
        self._bus_thread: Optional[threading.Thread] = None
        self._bus_stop = threading.Event()
        self._buffering = False
        self._mixer: Optional[GstModule.Element] = None
        self._tee: Optional[GstModule.Element] = None
        self._mixer_sink_pads: Dict[str, GstModule.Pad] = {}
        self._pad_added_handlers: List[Tuple[GstModule.Element, int]] = []
        self._mixer_layers: List[MixerLayer] = []
        self._needs_rebuild = True
        self._deck_sources: Dict[str, str] = {}
        self._loop_on_eos = True
        self._last_error: Optional[str] = None

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
        if self._pipeline and not self._needs_rebuild:
            if not self._is_running:
                self._set_state(Gst.State.PLAYING)
                self._is_running = True
            return

        if self._pipeline:
            self.stop()

        self._last_error = None

        try:
            pipeline = self._build_pipeline()
        except PipelineUnavailableError as exc:
            self._last_error = str(exc)
            LOG.warning("Pipeline start skipped: %s", exc)
            self._is_running = False
            self._needs_rebuild = True
            return
        except Exception as exc:  # pragma: no cover - defensive
            self._last_error = str(exc)
            LOG.exception("Failed to build GStreamer pipeline")
            self._is_running = False
            self._needs_rebuild = True
            return

        self._pipeline = pipeline
        self._needs_rebuild = False
        self._buffering = False

        pause_result = self._set_state(Gst.State.PAUSED)
        if pause_result == Gst.StateChangeReturn.ASYNC:
            try:
                self._wait_for_state(pipeline, Gst.State.PAUSED, timeout=10.0)
                self._wait_for_async_done(pipeline, timeout=10.0)
            except TimeoutError:
                LOG.warning("Timed out while prerolling pipeline.")
            except RuntimeError:
                LOG.exception("Pipeline reported an error during preroll.")
                raise
        elif pause_result == Gst.StateChangeReturn.NO_PREROLL:
            LOG.debug("Pipeline preroll skipped (live sources detected).")

        self._start_bus_monitor(pipeline)

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

        self._stop_bus_monitor()
        self._buffering = False

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
            "last_error": self._last_error,
        }

    # ----------------------------------------------------------------- plumbing

    def _set_state(self, state: GstModule.State) -> Gst.StateChangeReturn:
        if not self._pipeline:
            raise RuntimeError("Pipeline is not initialised.")
        result = self._pipeline.set_state(state)
        if result == Gst.StateChangeReturn.FAILURE:
            raise RuntimeError(f"Failed to set pipeline state to {state}.")
        return result

    def _start_bus_monitor(self, pipeline: GstModule.Pipeline) -> None:
        if self._bus_thread and self._bus_thread.is_alive():
            return

        bus = pipeline.get_bus()
        if not bus:
            LOG.warning("Pipeline bus is not available; skipping bus monitoring.")
            return

        self._bus_stop.clear()
        mask = (
            Gst.MessageType.ERROR
            | Gst.MessageType.EOS
            | Gst.MessageType.WARNING
            | Gst.MessageType.BUFFERING
            | Gst.MessageType.ASYNC_DONE
            | Gst.MessageType.STATE_CHANGED
        )

        def _loop() -> None:
            while not self._bus_stop.is_set():
                message = bus.timed_pop_filtered(BUS_POLL_INTERVAL_NS, mask)
                if message is None:
                    continue
                self._handle_bus_message(message)

        thread = threading.Thread(target=_loop, name="muloom-gst-bus", daemon=True)
        thread.start()
        self._bus_thread = thread

    def _stop_bus_monitor(self) -> None:
        self._bus_stop.set()
        thread = self._bus_thread
        if thread and thread.is_alive() and threading.current_thread() is not thread:
            thread.join(timeout=1.0)
        self._bus_thread = None

    def _handle_bus_message(self, message: GstModule.Message) -> None:
        msg_type = message.type
        if msg_type == Gst.MessageType.ERROR:
            self._on_bus_error(message)
        elif msg_type == Gst.MessageType.EOS:
            self._on_bus_eos(message)
        elif msg_type == Gst.MessageType.WARNING:
            self._on_bus_warning(message)
        elif msg_type == Gst.MessageType.BUFFERING:
            self._on_bus_buffering(message)
        elif msg_type == Gst.MessageType.ASYNC_DONE:
            self._on_bus_async_done(message)
        elif msg_type == Gst.MessageType.STATE_CHANGED:
            self._on_bus_state_changed(message)

    def _wait_for_state(
        self,
        pipeline: GstModule.Pipeline,
        target_state: GstModule.State,
        *,
        timeout: Optional[float] = None,
    ) -> None:
        bus = pipeline.get_bus()
        if not bus:
            raise RuntimeError("GStreamer bus unavailable while waiting for state change.")

        deadline = time.monotonic() + timeout if timeout is not None else None
        mask = Gst.MessageType.ERROR | Gst.MessageType.EOS | Gst.MessageType.STATE_CHANGED

        while True:
            wait_ns = self._remaining_ns(deadline)
            message = bus.timed_pop_filtered(wait_ns, mask)
            if message is None:
                raise TimeoutError(f"Pipeline did not reach state {target_state!s} in time.")

            msg_type = message.type
            if msg_type == Gst.MessageType.ERROR:
                err, debug = message.parse_error()
                raise RuntimeError(f"GStreamer error during state change: {err} ({debug})")
            if msg_type == Gst.MessageType.EOS:
                raise RuntimeError("Pipeline reached EOS while awaiting state change.")
            if msg_type == Gst.MessageType.STATE_CHANGED and message.src == pipeline:
                _old, new_state, _pending = message.parse_state_changed()
                if new_state == target_state:
                    return

    def _wait_for_async_done(
        self,
        pipeline: GstModule.Pipeline,
        *,
        timeout: Optional[float] = None,
    ) -> None:
        bus = pipeline.get_bus()
        if not bus:
            raise RuntimeError("GStreamer bus unavailable while waiting for ASYNC_DONE.")

        deadline = time.monotonic() + timeout if timeout is not None else None
        mask = Gst.MessageType.ERROR | Gst.MessageType.EOS | Gst.MessageType.ASYNC_DONE

        while True:
            wait_ns = self._remaining_ns(deadline)
            message = bus.timed_pop_filtered(wait_ns, mask)
            if message is None:
                raise TimeoutError("Timed out while waiting for ASYNC_DONE.")

            msg_type = message.type
            if msg_type == Gst.MessageType.ERROR:
                err, debug = message.parse_error()
                raise RuntimeError(f"GStreamer error during preroll: {err} ({debug})")
            if msg_type == Gst.MessageType.EOS:
                raise RuntimeError("Pipeline reached EOS before completing preroll.")
            if msg_type == Gst.MessageType.ASYNC_DONE:
                return

    @staticmethod
    def _remaining_ns(deadline: Optional[float]) -> int:
        if deadline is None:
            return BUS_POLL_INTERVAL_NS
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return 0
        return int(remaining * 1_000_000_000)

    def _restart_playback(self) -> None:
        pipeline = self._pipeline
        if not pipeline:
            return

        flags = Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT | Gst.SeekFlags.ACCURATE
        if not pipeline.seek_simple(Gst.Format.TIME, flags, 0):
            LOG.error("Failed to restart pipeline loop via seek_simple.")
            return

        try:
            self._set_state(Gst.State.PLAYING)
        except RuntimeError:
            LOG.exception("Failed to resume pipeline after loop seek.")

    # --------------------------------------------------------- bus message cbs

    def _on_bus_error(self, message: GstModule.Message) -> None:
        err, debug = message.parse_error()
        error_message = f"{err} ({debug})"
        self._last_error = error_message
        LOG.error("Pipeline error: %s", error_message)
        self.stop()

    def _on_bus_eos(self, _message: GstModule.Message) -> None:
        if not self._pipeline:
            return
        if self._loop_on_eos:
            LOG.info("Pipeline reached EOS; restarting for loop playback")
            self._restart_playback()
        else:
            LOG.info("Pipeline reached EOS; stopping")
            self.stop()

    def _on_bus_warning(self, message: GstModule.Message) -> None:
        warn, debug = message.parse_warning()
        LOG.warning("Pipeline warning: %s (%s)", warn, debug)

    def _on_bus_buffering(self, message: GstModule.Message) -> None:
        if not self._pipeline:
            return
        percent = message.parse_buffering()
        if percent < 100:
            if not self._buffering:
                LOG.debug("Pipeline buffering: %d%%", percent)
            self._buffering = True
            self._pipeline.set_state(Gst.State.PAUSED)
        else:
            if self._buffering:
                LOG.debug("Pipeline buffering complete")
            self._buffering = False
            if self._is_running:
                self._pipeline.set_state(Gst.State.PLAYING)

    def _on_bus_async_done(self, _message: GstModule.Message) -> None:
        LOG.debug("Pipeline reported ASYNC_DONE")

    def _on_bus_state_changed(self, message: GstModule.Message) -> None:
        if message.src != self._pipeline:
            return
        _old, new, _pending = message.parse_state_changed()
        LOG.debug("Pipeline state changed to %s", Gst.Element.state_get_name(new))

    # -------------------------------------------------------------- construction

    def _build_pipeline(self) -> GstModule.Pipeline:
        _require_gstreamer()

        pipeline = Gst.Pipeline.new("muloom")
        if not pipeline:
            raise RuntimeError("Failed to create GstPipeline instance.")

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
            LOG.warning(
                "Source type '%s' not yet implemented; substituting placeholder for '%s'.",
                config.type,
                config.id,
            )
            self._last_error = f"Source '{config.id}' type '{config.type}' not implemented; using placeholder."
            self._attach_placeholder_video(pipeline, mixer, config.id)
            return

        raw_uri = config.uri or config.params.get("uri")
        resolved_uri = self._resolve_uri(raw_uri)
        if not resolved_uri:
            LOG.warning(
                "File source '%s' has no usable URI '%s'; substituting placeholder.",
                config.id,
                raw_uri,
            )
            self._last_error = f"Source '{config.id}' missing usable URI; using placeholder."
            self._attach_placeholder_video(pipeline, mixer, config.id)
            return

        config.uri = resolved_uri
        sanitize = self._sanitize(config.id)
        decode = self._make_element("uridecodebin", f"decode_{sanitize}")
        decode.set_property("uri", resolved_uri)

        buffer_queue = self._make_element("queue2", f"buffer_{sanitize}")
        buffer_queue.set_property("use-buffering", True)
        buffer_queue.set_property("max-size-buffers", 0)
        buffer_queue.set_property("max-size-bytes", 0)
        buffer_queue.set_property("max-size-time", 0)

        convert = self._make_element("videoconvert", f"convert_{sanitize}")
        upload = self._make_element("glupload", f"glupload_{sanitize}")
        queue = self._make_queue(f"queue_{sanitize}")

        elements: Sequence[Optional[GstModule.Element]] = (
            decode,
            buffer_queue,
            convert,
            upload,
            queue,
        )

        for element in elements:
            if element is None:
                continue
            pipeline.add(element)

        mixer_pad: Optional[GstModule.Pad] = None

        try:
            if not buffer_queue.link(convert):
                raise RuntimeError(f"Failed to link buffer queue for source '{config.id}'.")
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
        except Exception as exc:
            LOG.warning(
                "Falling back to placeholder for source '%s' due to pipeline error: %s",
                config.id,
                exc,
            )
            self._last_error = f"Source '{config.id}' fell back to placeholder: {exc}"
            if mixer_pad is not None:
                try:
                    mixer.release_request_pad(mixer_pad)
                except Exception:  # pragma: no cover - defensive
                    LOG.debug("Failed to release mixer pad during fallback", exc_info=True)
            self._remove_elements(pipeline, elements)
            self._attach_placeholder_video(pipeline, mixer, config.id)
            return

        def _on_pad_added(
            bin_: GstModule.Element, pad: GstModule.Pad, target: GstModule.Element
        ) -> None:
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

        handler_id = decode.connect("pad-added", _on_pad_added, buffer_queue)
        self._pad_added_handlers.append((decode, handler_id))

    def _attach_placeholder_video(
        self,
        pipeline: GstModule.Pipeline,
        mixer: GstModule.Element,
        source_id: str,
    ) -> None:
        sanitize = self._sanitize(source_id)
        src = self._make_element("videotestsrc", f"placeholder_src_{sanitize}", required=False)
        if src is None:
            LOG.warning("videotestsrc not available; skipping placeholder for '%s'.", source_id)
            self._last_error = f"videotestsrc unavailable; could not provide placeholder for '{source_id}'."
            return

        if src.find_property("is-live"):
            src.set_property("is-live", True)
        if src.find_property("pattern"):
            try:
                src.set_property("pattern", 18)  # snow pattern to highlight placeholder
            except Exception:  # pragma: no cover - defensive
                LOG.debug("Failed to set placeholder pattern for '%s'", source_id, exc_info=True)

        convert = self._make_element("videoconvert", f"placeholder_convert_{sanitize}", required=False)
        upload = self._make_element("glupload", f"placeholder_glupload_{sanitize}", required=False)
        queue = self._make_queue(f"placeholder_queue_{sanitize}")

        elements: List[Optional[GstModule.Element]] = [src]
        if convert:
            elements.append(convert)
        if upload:
            elements.append(upload)
        elements.append(queue)

        for element in elements:
            if element is None:
                continue
            pipeline.add(element)

        if not self._link_elements(elements):
            LOG.warning("Failed to link placeholder branch for '%s'; removing chain.", source_id)
            self._remove_elements(pipeline, elements)
            return

        mixer_pad = mixer.get_request_pad("sink_%u")
        if mixer_pad is None:
            LOG.warning("Failed to request mixer pad for placeholder '%s'.", source_id)
            self._remove_elements(pipeline, elements)
            return
        mixer_pad.set_property("alpha", 0.0)

        queue_src_pad = queue.get_static_pad("src")
        if not queue_src_pad or queue_src_pad.link(mixer_pad) != Gst.PadLinkReturn.OK:
            LOG.warning("Failed to link placeholder queue to mixer for '%s'.", source_id)
            mixer.release_request_pad(mixer_pad)
            self._remove_elements(pipeline, elements)
            return

        self._mixer_sink_pads[source_id] = mixer_pad

    def _build_preview_branch(self, pipeline: GstModule.Pipeline, tee: GstModule.Element) -> None:
        queue = self._make_queue("preview_queue")
        gldownload = self._make_element("gldownload", "preview_gldownload")
        convert = self._make_element("videoconvert", "preview_convert")
        sink = self._make_element(
            self.preview_branch.sink_factory, "preview_webrtcsink", required=False
        )

        if sink is None:
            LOG.warning("webrtcsink not available; falling back to fakesink preview.")
            sink = self._make_element("fakesink", "preview_fallback")
            sink.set_property("sync", False)
        else:
            for key, value in self.preview_branch.iter_sink_properties().items():
                try:
                    sink.set_property(key, self._coerce_param(value))
                except Exception:  # pragma: no cover - defensive
                    LOG.debug(
                        "Failed to set preview property '%s' on webrtcsink",
                        key,
                        exc_info=True,
                    )

        for element in (queue, gldownload, convert, sink):
            pipeline.add(element)

        if not tee.link(queue):
            raise RuntimeError("Failed to link tee to preview queue.")
        if not queue.link(gldownload):
            raise RuntimeError("Failed to link preview queue to gldownload.")
        if not gldownload.link(convert):
            raise RuntimeError("Failed to link preview gldownload to videoconvert.")
        if not convert.link(sink):
            raise RuntimeError("Failed to link preview convert to sink.")

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

    @staticmethod
    def _resolve_uri(candidate: Optional[str]) -> Optional[str]:
        if candidate is None:
            return None
        trimmed = str(candidate).strip()
        if not trimmed:
            return None
        if "://" in trimmed or trimmed.startswith("file:"):
            return trimmed
        path = Path(trimmed).expanduser()
        try:
            resolved = path.resolve(strict=True)
        except FileNotFoundError:
            return None
        except RuntimeError:  # pragma: no cover - defensive
            LOG.debug("Failed to resolve path '%s' for URI coercion", trimmed, exc_info=True)
            return None
        return resolved.as_uri()

    @staticmethod
    def _link_elements(elements: Sequence[Optional[GstModule.Element]]) -> bool:
        previous: Optional[GstModule.Element] = None
        linked = False
        for element in elements:
            if element is None:
                continue
            if previous is not None:
                if not previous.link(element):
                    return False
            previous = element
            linked = True
        return linked

    @staticmethod
    def _remove_elements(
        pipeline: GstModule.Pipeline, elements: Sequence[Optional[GstModule.Element]]
    ) -> None:
        for element in elements:
            if element is None:
                continue
            try:
                pipeline.remove(element)
            except Exception:  # pragma: no cover - defensive
                LOG.debug(
                    "Failed to remove element '%s' during cleanup",
                    element.get_name() if hasattr(element, "get_name") else element,
                    exc_info=True,
                )

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

    def _make_element(
        self,
        factory: str,
        name: Optional[str] = None,
        *,
        required: bool = True,
    ) -> Optional[GstModule.Element]:
        _require_gstreamer()
        element = Gst.ElementFactory.make(factory, name)
        if element:
            return element
        if required:
            raise RuntimeError(f"GStreamer element factory '{factory}' is not available.")
        return None

    @staticmethod
    def _make_queue(name: str) -> GstModule.Element:
        _require_gstreamer()
        queue = Gst.ElementFactory.make("queue", name)
        if not queue:
            raise RuntimeError("Failed to create queue element.")
        queue.set_property("leaky", 2)
        queue.set_property("max-size-buffers", 0)
        queue.set_property("max-size-bytes", 0)
        queue.set_property("max-size-time", 100_000_000)  # 100ms
        return queue
