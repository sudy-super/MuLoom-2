import type { CSSProperties, ReactNode } from 'react';
import type { MixDeck } from '../../types/realtime';
import type { DeckKey } from '../../utils/mix';

export type ContentTab = 'generative' | 'glsl' | 'footage' | 'overlay';

export type CSSVariableRecord = Record<`--${string}`, string | number | undefined>;
export type CSSVariableProperties = CSSProperties & CSSVariableRecord;

export type DeckMediaState = {
  isPlaying: boolean;
  progress: number;
  isLoading: boolean;
  error: boolean;
  src: string | null;
};

export type DeckColumnOptions = {
  title?: string;
  leftFader?: 'sensitivity' | 'opacity';
  rightFader?: 'sensitivity' | 'opacity';
  leftLabel?: string;
  rightLabel?: string;
  sensitivityMode?: Partial<Record<'left' | 'right', 'global' | 'local'>>;
};

export type DeckColumnProps = {
  deckKey: DeckKey;
  deck: MixDeck;
  deckState: DeckMediaState;
  label: string;
  previewContent: ReactNode;
  previewRef: (element: HTMLDivElement | null) => void;
  previewHeight: number;
  isDropTarget: boolean;
  isGenerative: boolean;
  isGenerating: boolean;
  deckEnabled: boolean;
  selectedAssetValue: string | null;
  localSensitivityValues: Record<DeckKey, number>;
  localDeckOpacityOverrides: Record<DeckKey, number | undefined>;
  audioSensitivity: number;
  options?: DeckColumnOptions;
  onDeckPowerToggle: (deck: DeckKey) => void;
  onRegenerate: () => void;
  onDeckAssetChange: (deck: DeckKey, value: string) => void;
  onDeckPlaybackToggle: (deck: DeckKey) => void;
  onDeckPlaybackScrub: (deck: DeckKey, value: number) => void;
  onDeckOpacity: (deck: DeckKey, value: number) => void;
  onLocalSensitivityChange: (deck: DeckKey, sliderValue: number) => void;
  buildHighlightVars: (positionPercent: number) => CSSVariableRecord;
  mapSliderToSensitivity: (sliderValue: number) => number;
  mapSensitivityToSlider: (value: number) => number;
  clampSensitivityValue: (value: number) => number;
  handleSensitivityFader: (deck: DeckKey, rawValue: number) => void;
};
