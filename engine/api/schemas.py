"""
Pydantic schemas mirroring the REST/WS contract.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, Field, ConfigDict, validator


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


class PanicRequest(BaseModel):
    on: bool
    card: str = "black"


class PrerenderRequest(BaseModel):
    scene: str
    codec: str
    params: Dict[str, str] = Field(default_factory=dict)


class NDIInputRequest(BaseModel):
    sourceName: str


class NDIOutputRequest(BaseModel):
    publishName: str
