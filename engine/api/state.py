"""
Shared engine state container.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict

from ..graph.mixers import MixerLayer
from ..pipeline import Pipeline

ALLOWED_DECK_TYPES = {"shader", "video", "generative"}
DECK_KEYS = ("a", "b", "c", "d")


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


@dataclass
class DeckState:
    type: str | None = None
    asset_id: str | None = None
    opacity: float = 0.0
    enabled: bool = False

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "assetId": self.asset_id,
            "opacity": clamp01(self.opacity),
            "enabled": bool(self.enabled),
        }

    def apply(self, payload: dict) -> None:
        if "type" in payload:
            candidate = payload.get("type")
            candidate_str = str(candidate) if candidate is not None else None
            self.type = candidate_str if candidate_str in ALLOWED_DECK_TYPES else None
        if "assetId" in payload or "asset_id" in payload:
            self.asset_id = payload.get("assetId")
            if "asset_id" in payload:
                self.asset_id = payload.get("asset_id")
        if "opacity" in payload:
            value = payload.get("opacity")
            try:
                numeric = float(value if value is not None else 0.0)
            except (TypeError, ValueError):
                numeric = 0.0
            self.opacity = clamp01(numeric)
        if "enabled" in payload:
            self.enabled = bool(payload.get("enabled"))

        if self.type == "generative":
            self.asset_id = None
        elif not self.type or not self.asset_id:
            self.type = None
            self.asset_id = None


@dataclass
class MixState:
    crossfader_ab: float = 0.5
    crossfader_ac: float = 0.5
    crossfader_bd: float = 0.5
    crossfader_cd: float = 0.5
    decks: Dict[str, DeckState] = field(
        default_factory=lambda: {key: DeckState() for key in DECK_KEYS}
    )

    def to_dict(self) -> dict:
        return {
            "crossfaderAB": clamp01(self.crossfader_ab),
            "crossfaderAC": clamp01(self.crossfader_ac),
            "crossfaderBD": clamp01(self.crossfader_bd),
            "crossfaderCD": clamp01(self.crossfader_cd),
            "decks": {key: deck.to_dict() for key, deck in self.decks.items()},
        }


@dataclass
class ControlSettings:
    model_provider: str = "gemini"
    audio_input_mode: str = "file"
    prompt: str = ""

    def to_dict(self) -> dict:
        return {
            "modelProvider": self.model_provider,
            "audioInputMode": self.audio_input_mode,
            "prompt": self.prompt,
        }

    def update(self, payload: dict) -> None:
        if "modelProvider" in payload:
            self.model_provider = str(payload.get("modelProvider") or "gemini")
        if "audioInputMode" in payload:
            mode = str(payload.get("audioInputMode") or "file")
            self.audio_input_mode = mode if mode in {"file", "microphone"} else "file"
        if "prompt" in payload:
            self.prompt = str(payload.get("prompt") or "")


@dataclass
class ViewerStatus:
    is_running: bool = False
    is_generating: bool = False
    error: str = ""
    audio_sensitivity: float = 1.0

    def to_dict(self) -> dict:
        return {
            "isRunning": bool(self.is_running),
            "isGenerating": bool(self.is_generating),
            "error": self.error,
            "audioSensitivity": max(0.0, float(self.audio_sensitivity)),
        }

    def update(self, payload: dict) -> None:
        if "isRunning" in payload:
            self.is_running = bool(payload.get("isRunning"))
        if "isGenerating" in payload:
            self.is_generating = bool(payload.get("isGenerating"))
        if "error" in payload:
            self.error = str(payload.get("error") or "")
        if "audioSensitivity" in payload:
            value = payload.get("audioSensitivity")
            try:
                numeric = float(value if value is not None else 0.0)
            except (TypeError, ValueError):
                numeric = 0.0
            self.audio_sensitivity = max(0.0, numeric)


@dataclass
class DeckMediaState:
    is_playing: bool = False
    progress: float = 0.0
    is_loading: bool = False
    error: bool = False
    src: str | None = None

    def to_dict(self) -> dict:
        return {
            "isPlaying": bool(self.is_playing),
            "progress": max(0.0, min(100.0, float(self.progress))),
            "isLoading": bool(self.is_loading),
            "error": bool(self.error),
            "src": self.src,
        }

    def update(self, payload: dict) -> None:
        if "isPlaying" in payload:
            self.is_playing = bool(payload.get("isPlaying"))
        if "progress" in payload:
            value = payload.get("progress")
            try:
                numeric = float(value if value is not None else 0.0)
            except (TypeError, ValueError):
                numeric = 0.0
            self.progress = max(0.0, min(100.0, numeric))
        if "isLoading" in payload:
            self.is_loading = bool(payload.get("isLoading"))
        if "error" in payload:
            self.error = bool(payload.get("error"))
        if "src" in payload:
            src = payload.get("src")
            if isinstance(src, str):
                src = src.strip() or None
            else:
                src = None
            self.src = src


@dataclass
class EngineState:
    """
    Aggregated state shared between the API and the pipeline orchestrator.
    """

    pipeline: Pipeline = field(default_factory=Pipeline)
    mix: MixState = field(default_factory=MixState)
    panic: bool = False
    panic_card: str = "black"
    active_profile: str = "default"
    control_settings: ControlSettings = field(default_factory=ControlSettings)
    viewer_status: ViewerStatus = field(default_factory=ViewerStatus)
    fallback_layers: list = field(default_factory=list)
    deck_media_states: Dict[str, DeckMediaState] = field(
        default_factory=lambda: {key: DeckMediaState() for key in DECK_KEYS}
    )

    def snapshot(self) -> dict:
        return {
            "fallbackLayers": list(self.fallback_layers),
            "controlSettings": self.control_settings.to_dict(),
            "viewerStatus": self.viewer_status.to_dict(),
            "mixState": self.mix.to_dict(),
            "deckMediaStates": {
                key: state.to_dict() for key, state in self.deck_media_states.items()
            },
        }

    def rebuild_mixer_layers(self) -> None:
        self.pipeline.mixer.clear()
        for key, deck in self.mix.decks.items():
            if not deck.enabled or not (deck.asset_id or deck.type):
                continue
            source_id = deck.asset_id or f"deck-{key}"
            self.pipeline.mixer.add_layer(
                MixerLayer(source_id=source_id, opacity=clamp01(deck.opacity))
            )

    def apply_deck_update(self, deck_key: str, payload: dict) -> bool:
        deck = self.mix.decks.get(deck_key)
        if not deck:
            return False
        deck.apply(payload or {})
        return True

    def apply_crossfader_update(self, payload: dict) -> bool:
        if not payload:
            return False
        target = str(payload.get("target") or "").lower()
        try:
            value = clamp01(float(payload.get("value") or 0.0))
        except (TypeError, ValueError):
            return False
        field_map = {
            "main": "crossfader_ab",
            "ab": "crossfader_ab",
            "ac": "crossfader_ac",
            "bd": "crossfader_bd",
            "cd": "crossfader_cd",
        }
        field_name = field_map.get(target)
        if not field_name:
            return False
        setattr(self.mix, field_name, value)
        return True

    def update_deck_media_state(self, deck_key: str, payload: dict) -> bool:
        state = self.deck_media_states.get(deck_key)
        if not state:
            return False
        state.update(payload or {})
        return True

    def mixer_layers(self) -> Dict[str, MixerLayer]:
        layers = {}
        for key, deck in self.mix.decks.items():
            layers[key] = MixerLayer(source_id=deck.asset_id or key, opacity=deck.opacity)
        return layers
