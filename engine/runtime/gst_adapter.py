"""
GStreamer-backed execution adapter for the declarative MuLoom pipeline.

The adapter listens for state changes emitted by :class:`engine.pipeline.Pipeline`
and mirrors them into an executable GstPipeline.  When the GStreamer runtime is
not available the adapter degrades gracefully and simply logs the attempted
changes, allowing the rest of the system (tests, UI, API) to operate without the
native dependency.
"""

from __future__ import annotations

import json
import logging
import threading
import sys
from typing import Dict, List, Optional, Tuple

from ..pipeline import DeckRuntimeState, OutputType, Pipeline, SourceType

LOG = logging.getLogger(__name__)

IS_DARWIN = sys.platform == "darwin"
_MACOS_INIT_LOCK = threading.RLock()
_MACOS_INITIALISED = False
_GST_INITIALISED = False


def _macos_init_via_gst() -> bool:
    try:
        import ctypes
        import ctypes.util

        library_path = ctypes.util.find_library("gstreamer-1.0")
        if not library_path:
            return False
        gst_lib = ctypes.CDLL(library_path)
        gst_main = getattr(gst_lib, "gst_macos_main", None)
        if gst_main is None:
            return False
        gst_main.restype = None
        gst_main.argtypes = []
        gst_main()
        LOG.info("Initialised macOS NSApplication via gst_macos_main().")
        return True
    except Exception:
        LOG.debug("gst_macos_main() initialisation failed.", exc_info=True)
        return False


def _macos_init_via_pyobjc() -> bool:
    try:  # pragma: no cover - requires PyObjC
        from Cocoa import NSApplication  # type: ignore

        NSApplication.sharedApplication()
        LOG.info("Initialised macOS NSApplication via Cocoa sharedApplication().")
        return True
    except ModuleNotFoundError:
        return False
    except Exception:
        LOG.debug("PyObjC sharedApplication() initialisation failed.", exc_info=True)
        return False


def _macos_init_via_appkit() -> bool:
    try:  # pragma: no cover - requires ctypes access to AppKit
        import ctypes
        import ctypes.util

        appkit_path = ctypes.util.find_library("AppKit")
        if not appkit_path:
            return False
        appkit = ctypes.CDLL(appkit_path)
        if not hasattr(appkit, "NSApplicationLoad"):
            return False
        appkit.NSApplicationLoad.restype = ctypes.c_bool
        appkit.NSApplicationLoad.argtypes = []
        if appkit.NSApplicationLoad():
            LOG.info("Initialised macOS NSApplication via AppKit.NSApplicationLoad().")
            return True
    except Exception:
        LOG.debug("AppKit.NSApplicationLoad() initialisation failed.", exc_info=True)
    return False


def _ensure_macos_app() -> None:
    if not IS_DARWIN:
        return

    global _MACOS_INITIALISED
    with _MACOS_INIT_LOCK:
        if _MACOS_INITIALISED:
            return

        if not _macos_init_via_gst():
            if not _macos_init_via_pyobjc() and not _macos_init_via_appkit():
                LOG.warning(
                    "Unable to initialise NSApplication; some GStreamer GL elements may misbehave on macOS. "
                    "Install PyObjC or update to a GStreamer build with gst_macos_main()."
                )

        _MACOS_INITIALISED = True


def _ensure_gst_initialised() -> None:
    if Gst is None:
        return
    global _GST_INITIALISED
    if _GST_INITIALISED:
        return
    if IS_DARWIN:
        _ensure_macos_app()
    Gst.init(None)
    _GST_INITIALISED = True


try:  # pragma: no cover - availability depends on host environment
    import gi  # type: ignore

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst  # type: ignore
except (ImportError, ValueError) as exc:  # pragma: no cover
    Gst = None  # type: ignore[assignment]
    _GST_IMPORT_ERROR = exc
else:  # pragma: no cover - executed only when GStreamer is present
    _GST_IMPORT_ERROR = None


class PipelineAdapter:
    """
    Base class for execution adapters.
    """

    def __init__(self, pipeline: Pipeline) -> None:
        self._pipeline = pipeline
        self._subscription_id: Optional[int] = None
        self._lock = threading.RLock()
        self._last_snapshot: Optional[str] = None

    def start(self) -> None:
        """
        Begin observing pipeline updates.
        """

        if self._subscription_id is not None:
            return
        self._subscription_id = self._pipeline.subscribe(self._on_pipeline_event)
        self.sync()

    def stop(self) -> None:
        """
        Stop observing pipeline updates and tear down any backing resources.
        """

        if self._subscription_id is not None:
            self._pipeline.unsubscribe(self._subscription_id)
            self._subscription_id = None
        self._teardown()
        with self._lock:
            self._last_snapshot = None

    def sync(self) -> None:
        """
        Reconcile the adapter with the current pipeline description.
        """

        snapshot = self._pipeline.describe()
        serialised = json.dumps(snapshot, sort_keys=True, separators=(",", ":"), default=str)
        with self._lock:
            if serialised == self._last_snapshot:
                return
            self._last_snapshot = serialised

        try:
            self._apply_snapshot(snapshot)
        except Exception:  # pragma: no cover - subclasses handle specifics
            LOG.exception("Pipeline adapter failed while applying snapshot.")

    # ------------------------------------------------------------------ helpers

    def _on_pipeline_event(self, _pipeline: Pipeline, event: str, payload: Dict[str, object]) -> None:
        LOG.debug("Pipeline event: %s %s", event, payload)
        self.sync()

    def _apply_snapshot(self, snapshot: Dict[str, object]) -> None:
        raise NotImplementedError

    def _teardown(self) -> None:
        """
        Release backing resources.  Subclasses should override when required.
        """


class GStreamerPipelineAdapter(PipelineAdapter):
    """
    Realise the declarative pipeline using GStreamer primitives.

    The initial implementation focuses on file-based deck playback.  Each deck
    with a valid URI becomes an individual `playbin` driving a `fakesink`, which
    is sufficient for verifying that the multimedia stack is working.  Future
    iterations can evolve this into the full render graph described by the
    pipeline state.
    """

    def __init__(self, pipeline: Pipeline) -> None:
        super().__init__(pipeline)
        self._gst_pipeline: Optional["Gst.Pipeline"] = None
        self._started = False
        self._deck_handlers: List[Tuple["Gst.Element", int]] = []
        self._deck_sink_pads: List["Gst.Pad"] = []
        self._tee_pads: List["Gst.Pad"] = []

    @property
    def is_available(self) -> bool:
        return Gst is not None

    def start(self) -> None:
        if Gst is None:
            LOG.warning(
                "GStreamer runtime is not available; execution adapter disabled. (%s)",
                _GST_IMPORT_ERROR,
            )
            return
        _ensure_gst_initialised()
        LOG.info("GStreamer runtime detected; execution adapter is active.")
        self._started = True
        super().start()

    def stop(self) -> None:
        if Gst is None or not self._started:
            return
        super().stop()
        self._started = False

    # ------------------------------------------------------------------ overrides

    def _apply_snapshot(self, snapshot: Dict[str, object]) -> None:
        if Gst is None:
            return

        deck_payloads = self._extract_active_decks(snapshot)
        if not deck_payloads:
            LOG.debug("No active deck sources; GStreamer pipeline not started.")
            with self._lock:
                self._teardown_locked()
            return

        mixer_layers = self._extract_mixer_layers(snapshot)
        outputs = snapshot.get("outputs", [])

        with self._lock:
            self._teardown_locked()

            pipeline = Gst.Pipeline.new("muloom-runtime")
            if not pipeline:
                LOG.error("Failed to create GStreamer pipeline instance.")
                return

            compositor = Gst.ElementFactory.make("compositor", "muloom_compositor")
            if not compositor:
                compositor = Gst.ElementFactory.make("videomixer", "muloom_compositor")
            if not compositor:
                LOG.error("Neither compositor nor videomixer is available in GStreamer.")
                return
            if compositor.find_property("background") is not None:
                compositor.set_property("background", 1)
            pipeline.add(compositor)

            mix_queue = self._make_queue("muloom_mixer_queue")
            pipeline.add(mix_queue)
            if not compositor.link(mix_queue):
                LOG.error("Failed to link compositor to mixer queue.")
                return

            tee = Gst.ElementFactory.make("tee", "muloom_output_tee")
            if not tee:
                LOG.error("Failed to create tee element.")
                return
            pipeline.add(tee)
            if not mix_queue.link(tee):
                LOG.error("Failed to link mixer queue to tee.")
                return

            # Build deck branches
            for zorder, payload in enumerate(deck_payloads):
                self._build_deck_branch(
                    pipeline=pipeline,
                    compositor=compositor,
                    payload=payload,
                    alpha=mixer_layers.get(payload["source_id"], 0.0),
                    zorder=zorder,
                )

            # Add program / preview branches
            branches_built = self._build_output_branches(pipeline, tee, outputs)
            if not branches_built:
                self._build_default_outputs(pipeline, tee)

            self._gst_pipeline = pipeline

        self._activate_pipeline()

    def _teardown(self) -> None:
        if Gst is None:
            return
        with self._lock:
            self._teardown_locked()

    # ------------------------------------------------------------------ internal

    def _activate_pipeline(self) -> None:
        if Gst is None:
            return
        pipeline = self._gst_pipeline
        if not pipeline:
            return
        result = pipeline.set_state(Gst.State.PLAYING)
        if result == Gst.StateChangeReturn.FAILURE:
            LOG.error("Failed to set GStreamer pipeline to PLAYING state.")
            pipeline.set_state(Gst.State.NULL)

    def _teardown_locked(self) -> None:
        if Gst is None:
            return
        pipeline = self._gst_pipeline
        if not pipeline:
            return
        try:
            pipeline.set_state(Gst.State.NULL)
        except Exception:  # pragma: no cover - defensive
            LOG.exception("Error while stopping GStreamer pipeline.")

        for element, handler_id in self._deck_handlers:
            try:
                element.disconnect(handler_id)
            except Exception:  # pragma: no cover - defensive
                LOG.debug("Failed to disconnect handler on %s", element, exc_info=True)
        self._deck_handlers.clear()

        for pad in self._deck_sink_pads:
            try:
                parent = pad.get_parent_element()
                if parent and parent.get_factory().get_name() == "compositor":
                    parent.release_request_pad(pad)
            except Exception:  # pragma: no cover - defensive
                LOG.debug("Failed to release compositor sink pad", exc_info=True)
        self._deck_sink_pads.clear()

        for tee_pad in self._tee_pads:
            try:
                parent = tee_pad.get_parent_element()
                if parent and parent.get_factory().get_name() == "tee":
                    parent.release_request_pad(tee_pad)
            except Exception:  # pragma: no cover - defensive
                LOG.debug("Failed to release tee pad", exc_info=True)
        self._tee_pads.clear()

        self._gst_pipeline = None

    # -------------------------------------------------------------- deck builds

    def _extract_active_decks(self, snapshot: Dict[str, object]) -> List[Dict[str, object]]:
        decks = snapshot.get("decks", {})
        video_sources = snapshot.get("video_sources", [])
        source_map = {}
        if isinstance(video_sources, list):
            for source in video_sources:
                if isinstance(source, dict) and "id" in source:
                    source_map[source["id"]] = source

        payloads: List[Dict[str, object]] = []
        if isinstance(decks, dict):
            for deck_key, data in decks.items():
                if not isinstance(data, dict):
                    continue
                state = data.get("state")
                if state == DeckRuntimeState.ERROR.value:
                    continue
                source_id = f"deck_{deck_key}"
                source_config = source_map.get(source_id, {})
                source_type = source_config.get("type") or SourceType.FILE.value
                uri = data.get("requestedUri") or data.get("currentUri")
                if source_type == SourceType.FILE.value and not uri:
                    continue
                payloads.append(
                    {
                        "deck": deck_key,
                        "source_id": source_id,
                        "source_type": source_type,
                        "uri": uri,
                        "params": source_config.get("params", {}),
                    }
                )
        return payloads

    @staticmethod
    def _extract_mixer_layers(snapshot: Dict[str, object]) -> Dict[str, float]:
        layers = {}
        mixer_layers = snapshot.get("mixer_layers", [])
        if isinstance(mixer_layers, list):
            for entry in mixer_layers:
                if not isinstance(entry, dict):
                    continue
                source_id = entry.get("source_id")
                if not source_id:
                    continue
                opacity = float(entry.get("opacity", 0.0))
                layers[source_id] = max(0.0, min(1.0, opacity))
        return layers

    def _build_deck_branch(
        self,
        *,
        pipeline: "Gst.Pipeline",
        compositor: "Gst.Element",
        payload: Dict[str, object],
        alpha: float,
        zorder: int,
    ) -> None:
        source_type = payload["source_type"]
        deck_name = payload["deck"]

        queue = self._make_queue(f"deck_{deck_name}_queue")
        convert = Gst.ElementFactory.make("videoconvert", f"deck_{deck_name}_convert")
        scale = Gst.ElementFactory.make("videoscale", f"deck_{deck_name}_scale")

        for element in (queue, scale, convert):
            if not element:
                raise RuntimeError(f"Failed to create deck element for '{deck_name}'.")
            pipeline.add(element)

        if not queue.link(scale) or not scale.link(convert):
            raise RuntimeError(f"Failed to link preprocessing chain for deck '{deck_name}'.")

        sink_pad = compositor.get_request_pad("sink_%u")
        if not sink_pad:
            raise RuntimeError("Failed to request sink pad from compositor.")
        sink_pad.set_property("alpha", float(alpha))
        sink_pad.set_property("zorder", int(zorder))
        self._deck_sink_pads.append(sink_pad)

        convert_src = convert.get_static_pad("src")
        if convert_src.link(sink_pad) != Gst.PadLinkReturn.OK:
            raise RuntimeError(f"Failed to link deck '{deck_name}' into compositor.")

        if source_type == SourceType.GENERATOR.value:
            generator = self._make_generator_source(deck_name, payload.get("params", {}))
            pipeline.add(generator)
            if not generator.link(queue):
                raise RuntimeError(f"Failed to link generator for deck '{deck_name}'.")
            return

        uri = payload.get("uri")
        if not uri:
            raise RuntimeError(f"Deck '{deck_name}' is missing URI.")

        decodebin = Gst.ElementFactory.make("uridecodebin", f"deck_{deck_name}_decode")
        if not decodebin:
            raise RuntimeError("Failed to create uridecodebin.")
        decodebin.set_property("uri", uri)
        handler_id = decodebin.connect("pad-added", self._on_decodebin_pad_added, queue)
        self._deck_handlers.append((decodebin, handler_id))
        pipeline.add(decodebin)

    def _make_generator_source(self, deck_name: str, params: Dict[str, object]):
        pattern = params.get("pattern", "smpte")
        element = Gst.ElementFactory.make("videotestsrc", f"deck_{deck_name}_generator")
        if not element:
            raise RuntimeError("Failed to create videotestsrc for generator deck.")
        element.set_property("is-live", True)
        try:
            if isinstance(pattern, str) and pattern.isdigit():
                element.set_property("pattern", int(pattern))
            else:
                element.set_property("pattern", pattern)
        except Exception:
            LOG.debug("Unsupported generator pattern '%s'; using default.", pattern)
        return element

    def _on_decodebin_pad_added(self, decodebin, pad, queue):
        try:
            caps = pad.get_current_caps()
        except Exception:
            caps = None
        if not caps or not caps.to_string().startswith("video/"):
            return
        sink_pad = queue.get_static_pad("sink")
        if sink_pad.is_linked():
            return
        try:
            pad.link(sink_pad)
        except Exception:  # pragma: no cover - defensive
            LOG.exception("Failed to link decodebin pad for %s", decodebin)

    # ------------------------------------------------------------ output builds

    def _build_output_branches(
        self,
        pipeline: "Gst.Pipeline",
        tee: "Gst.Element",
        outputs: object,
    ) -> bool:
        built = False
        if not isinstance(outputs, list):
            return False

        for entry in outputs:
            if not isinstance(entry, dict):
                continue
            output_type = entry.get("type")
            params = entry.get("params", {}) or {}
            if output_type == OutputType.SCREEN.value:
                branch = self._build_screen_branch(pipeline, tee, params, name_suffix=entry.get("id"))
            elif output_type == OutputType.FILE.value:
                branch = self._build_file_branch(pipeline, tee, params, name_suffix=entry.get("id"))
            else:
                branch = self._build_fallback_branch(pipeline, tee, name_suffix=entry.get("id"))
            built = branch or built
        return built

    def _build_default_outputs(self, pipeline: "Gst.Pipeline", tee: "Gst.Element") -> None:
        # Program output
        self._build_screen_branch(pipeline, tee, {}, name_suffix="program")
        # Preview output (silent)
        self._build_fallback_branch(pipeline, tee, name_suffix="preview")

    def _build_screen_branch(
        self,
        pipeline: "Gst.Pipeline",
        tee: "Gst.Element",
        params: Dict[str, object],
        *,
        name_suffix: Optional[str],
    ) -> bool:
        queue = self._make_queue(f"screen_{name_suffix or 'out'}_queue")
        convert = Gst.ElementFactory.make("videoconvert", f"screen_{name_suffix or 'out'}_convert")
        sink = Gst.ElementFactory.make("autovideosink", f"screen_{name_suffix or 'out'}_sink")
        if not sink:
            sink = Gst.ElementFactory.make("fakesink", f"screen_{name_suffix or 'out'}_sink")
            if sink:
                sink.set_property("sync", False)
        if not all([queue, convert, sink]):
            return False
        sink.set_property("sync", False)

        for element in (queue, convert, sink):
            pipeline.add(element)

        if not queue.link(convert) or not convert.link(sink):
            LOG.error("Failed to link screen output branch.")
            return False

        return self._link_branch_to_tee(tee, queue)

    def _build_file_branch(
        self,
        pipeline: "Gst.Pipeline",
        tee: "Gst.Element",
        params: Dict[str, object],
        *,
        name_suffix: Optional[str],
    ) -> bool:
        location = params.get("location")
        if not location:
            LOG.warning("File output requested without 'location'; falling back to fakesink.")
        else:
            LOG.info(
                "File output is not yet fully supported; discarding request for '%s'.",
                location,
            )
        return self._build_fallback_branch(pipeline, tee, name_suffix=name_suffix)

    def _build_fallback_branch(
        self,
        pipeline: "Gst.Pipeline",
        tee: "Gst.Element",
        *,
        name_suffix: Optional[str],
    ) -> bool:
        queue = self._make_queue(f"fallback_{name_suffix or 'out'}_queue")
        sink = Gst.ElementFactory.make("fakesink", f"fallback_{name_suffix or 'out'}_sink")
        if not sink or not queue:
            return False
        sink.set_property("sync", False)
        sink.set_property("async", False)
        pipeline.add(queue)
        pipeline.add(sink)
        if not queue.link(sink):
            LOG.error("Failed to link fallback output branch.")
            return False
        return self._link_branch_to_tee(tee, queue)

    def _link_branch_to_tee(self, tee: "Gst.Element", queue: "Gst.Element") -> bool:
        pipeline = tee.get_parent()
        if not pipeline:
            return False
        sink_pad = queue.get_static_pad("sink")
        tee_pad = tee.get_request_pad("src_%u")
        if not tee_pad:
            LOG.error("Failed to request tee src pad.")
            return False
        if sink_pad.is_linked():
            return True
        if tee_pad.link(sink_pad) != Gst.PadLinkReturn.OK:
            LOG.error("Failed to link tee to branch.")
            return False
        self._tee_pads.append(tee_pad)
        return True

    def _make_queue(self, name: str) -> "Gst.Element":
        queue = Gst.ElementFactory.make("queue", name)
        if not queue:
            raise RuntimeError("Failed to create queue element.")
        queue.set_property("max-size-buffers", 0)
        queue.set_property("max-size-bytes", 0)
        queue.set_property("max-size-time", 5 * Gst.SECOND)
        queue.set_property("leaky", 2)
        return queue
