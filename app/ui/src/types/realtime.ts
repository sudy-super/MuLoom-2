import type { ModelProvider } from '../modules/GLSLGenerator';
import type { DeckKey } from '../utils/mix';

export type LayerType = 'shader' | 'video';

export interface FallbackLayer {
  id: string;
  type: LayerType;
  name: string;
  opacity: number;
  blendMode?: 'normal' | 'screen' | 'add' | 'multiply' | 'overlay';
  order: number;
}

export interface MixDeck {
  type: LayerType | 'generative' | null;
  assetId: string | null;
  opacity: number;
  enabled: boolean;
}

export interface MixState {
  crossfaderAB: number;
  crossfaderAC: number;
  crossfaderBD: number;
  crossfaderCD: number;
  decks: Record<'a' | 'b' | 'c' | 'd', MixDeck>;
}

export interface FallbackAssets {
  glsl: Array<{
    id: string;
    name: string;
    code: string;
  }>;
  videos: Array<{
    id: string;
    name: string;
    category: string;
    folder?: string;
    url: string;
  }>;
  overlays?: Array<{
    id: string;
    name: string;
    url: string;
    folder?: string;
  }>;
}

export interface ControlSettings {
  modelProvider: ModelProvider;
  audioInputMode: 'file' | 'microphone';
  prompt: string;
}

export interface DeckMediaStatus {
  isPlaying: boolean;
  progress: number;
  isLoading: boolean;
  error: boolean;
  src: string | null;
}

export const createDefaultDeckMediaStatus = (): DeckMediaStatus => ({
  isPlaying: false,
  progress: 0,
  isLoading: false,
  error: false,
  src: null,
});

export type DeckMediaStatusMap = Record<DeckKey, DeckMediaStatus>;

export interface ViewerStatus {
  isRunning: boolean;
  isGenerating: boolean;
  error: string;
  audioSensitivity?: number;
}

export interface StartVisualizationPayload {
  modelProvider: ModelProvider;
  geminiApiKey?: string;
  openaiApiKey?: string;
  audioInputMode: 'file' | 'microphone';
  prompt: string;
}

export interface DeckMediaStateMessagePayload {
  deck: DeckKey;
  state: DeckMediaStatus;
}

export type RTCSignalType = 'offer' | 'answer' | 'ice-candidate' | 'request-offer';

export type RTCSignalMessage =
  | { type: 'rtc-signal'; rtc: 'offer'; payload: RTCSessionDescriptionInit }
  | { type: 'rtc-signal'; rtc: 'answer'; payload: RTCSessionDescriptionInit }
  | { type: 'rtc-signal'; rtc: 'ice-candidate'; payload: RTCIceCandidateInit }
  | { type: 'rtc-signal'; rtc: 'request-offer'; payload: null };

export type OutboundMessage =
  | { type: 'register'; role: 'viewer' | 'controller' }
  | { type: 'update-fallback-layers'; payload: FallbackLayer[] }
  | { type: 'update-control-settings'; payload: Partial<ControlSettings> }
  | { type: 'update-mix-deck'; payload: { deck: 'a' | 'b' | 'c' | 'd'; data: Partial<MixDeck> } }
  | { type: 'update-crossfader'; payload: { target: 'ab' | 'ac' | 'bd' | 'cd'; value: number } }
  | { type: 'start-visualization'; payload: StartVisualizationPayload }
  | { type: 'stop-visualization' }
  | { type: 'regenerate-shader' }
  | { type: 'set-audio-sensitivity'; payload: { value: number } }
  | { type: 'viewer-status'; payload: Partial<ViewerStatus> }
  | { type: 'code-progress'; payload: { code: string; isComplete: boolean } }
  | { type: 'deck-media-state'; payload: DeckMediaStateMessagePayload }
  | RTCSignalMessage;

export type InboundMessage =
  | {
      type: 'init';
      payload: {
        state: {
          fallbackLayers: FallbackLayer[];
          controlSettings: ControlSettings;
          viewerStatus: ViewerStatus;
          mixState: MixState;
          deckMediaStates?: DeckMediaStatusMap;
        };
        assets: FallbackAssets;
      };
    }
  | { type: 'fallback-layers'; payload: FallbackLayer[] }
  | { type: 'control-settings'; payload: ControlSettings }
  | { type: 'mix-state'; payload: MixState }
  | { type: 'update-mix-deck'; payload: { deck: 'a' | 'b' | 'c' | 'd'; data: Partial<MixDeck> } }
  | { type: 'update-crossfader'; payload: { target: 'ab' | 'ac' | 'bd' | 'cd'; value: number } }
  | { type: 'viewer-status'; payload: ViewerStatus }
  | { type: 'code-progress'; payload: { code: string; isComplete: boolean } }
  | { type: 'start-visualization'; payload: StartVisualizationPayload }
  | { type: 'stop-visualization' }
  | { type: 'regenerate-shader' }
  | { type: 'set-audio-sensitivity'; payload: { value: number } }
  | { type: 'deck-media-state'; payload: DeckMediaStateMessagePayload }
  | RTCSignalMessage;
