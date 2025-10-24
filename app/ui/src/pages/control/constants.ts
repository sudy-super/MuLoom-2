import type { ControlSettings } from '../../types/realtime';
import { MIX_DECK_KEYS, type DeckKey } from '../../utils/mix';
import type { ContentTab } from './types';

export const defaultSettings: ControlSettings = {
  modelProvider: 'gemini',
  audioInputMode: 'file',
  prompt: '',
};

export const deckLabels: Record<DeckKey, string> = {
  a: 'Deck A',
  b: 'Deck B',
  c: 'Deck C',
  d: 'Deck D',
};

export const deckKeys: DeckKey[] = [...MIX_DECK_KEYS];
export const masterPreviewOrder: DeckKey[] = ['c', 'd', 'a', 'b'];

export const deckSensitivityModes: Record<DeckKey, 'local' | 'global'> = {
  a: 'local',
  b: 'local',
  c: 'local',
  d: 'local',
};

export const SENSITIVITY_MIN = 0;
export const SENSITIVITY_MAX = 5;
export const STOP_RATE_THRESHOLD = 0.0001;

export const assetDragMimeType = 'application/x-deck-asset';

export const contentTabConfig: Array<{ id: ContentTab; label: string }> = [
  { id: 'generative', label: 'Generative' },
  { id: 'glsl', label: 'GLSL Shaders' },
  { id: 'footage', label: 'Footage' },
  { id: 'overlay', label: 'Overlay' },
];

