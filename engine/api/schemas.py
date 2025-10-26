"""
Pydantic schemas mirroring the REST/WS contract.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, validator


class DeckModel(BaseModel):
    type: Optional[str] = None
    asset_id: Optional[str] = Field(default=None, alias="assetId")
    opacity: float = 0.0
    enabled: bool = False
    model_config = ConfigDict(populate_by_name=True, validate_by_name=True)

    @validator("opacity", pre=True)
    def _clamp_opacity(cls, value: float) -> float:
        return max(0.0, min(1.0, float(value)))


class MixStateModel(BaseModel):
    crossfaderAB: float = 0.5
    crossfaderAC: float = 0.5
    crossfaderBD: float = 0.5
    crossfaderCD: float = 0.5
    decks: Dict[str, DeckModel] = Field(default_factory=dict)

    @validator("crossfaderAB", "crossfaderAC", "crossfaderBD", "crossfaderCD", pre=True)
    def _clamp(cls, value: float) -> float:
        return max(0.0, min(1.0, float(value)))


class AssetModel(BaseModel):
    id: str
    name: str
    url: Optional[str] = None
    category: Optional[str] = None
    code: Optional[str] = None


class AssetCollection(BaseModel):
    glsl: List[AssetModel] = Field(default_factory=list)
    videos: List[AssetModel] = Field(default_factory=list)
    overlays: List[AssetModel] = Field(default_factory=list)


class ControlSettingsModel(BaseModel):
    modelProvider: str = "gemini"
    audioInputMode: str = "file"
    prompt: str = ""


class ViewerStatusModel(BaseModel):
    isRunning: bool = False
    isGenerating: bool = False
    error: str = ""
    audioSensitivity: float = 1.0

    @validator("audioSensitivity", pre=True)
    def _clamp_audio_sensitivity(cls, value: float) -> float:
        return max(0.0, float(value))


class TransportCommandRequest(BaseModel):
    op: str
    expected_rev: int = Field(
        validation_alias=AliasChoices("expected_rev", "expectedRev", "rev"),
        serialization_alias="expected_rev",
    )
    position_us: Optional[int] = Field(
        default=None,
        validation_alias=AliasChoices("position_us", "positionUs", "pos_us", "posUs", "position"),
    )
    rate: Optional[float] = Field(
        default=None,
        validation_alias=AliasChoices("rate", "value", "playRate", "speed"),
    )

    model_config = ConfigDict(populate_by_name=True, validate_assignment=True)

    @validator("op", pre=True)
    def _normalise_op(cls, value: object) -> str:
        result = str(value or "").strip()
        if not result:
            raise ValueError("op is required")
        return result

    @validator("expected_rev")
    def _validate_expected_rev(cls, value: int) -> int:
        coerced = int(value)
        if coerced < 0:
            raise ValueError("expected_rev must be non-negative")
        return coerced

    @property
    def rev(self) -> int:
        return self.expected_rev


class PrerenderRequest(BaseModel):
    scene: str
    codec: str
    params: Dict[str, str] = Field(default_factory=dict)


class NDIInputRequest(BaseModel):
    sourceName: str


class NDIOutputRequest(BaseModel):
    publishName: str
