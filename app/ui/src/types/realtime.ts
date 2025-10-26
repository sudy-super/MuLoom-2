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

export interface TransportSnapshot {
  rev: number;
  playing: boolean;
  rate: number;
  pos_us: number;
  t0_us: number;
}

export const createDefaultTransportSnapshot = (): TransportSnapshot => ({
  rev: 0,
  playing: false,
  rate: 1,
  pos_us: 0,
  t0_us: 0,
});

export interface TransportTickPayload {
  rev: number;
  mono_us: number;
  playing: boolean;
  rate: number;
  pos_us: number;
  t0_us: number;
}

export interface DeckTimelineState {
  src: string | null;
  isPlaying: boolean;
  basePosition: number;
  position: number;
  playRate: number;
  updatedAt: number;
  version: number;
  isLoading: boolean;
  error: boolean;
  duration: number | null;
  commandId?: string | null;
}

export const createDefaultDeckTimelineState = (): DeckTimelineState => ({
  src: null,
  isPlaying: false,
  basePosition: 0,
  position: 0,
  playRate: 1,
  updatedAt: 0,
  version: 0,
  isLoading: false,
  error: false,
  duration: null,
  commandId: null,
});

export type DeckTimelineStateMap = Record<DeckKey, DeckTimelineState>;

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

export type DeckMediaStateIntent = (
  | { intent: 'toggle'; isPlaying?: boolean }
  | { intent: 'play' }
  | { intent: 'pause' }
  | { intent: 'seek'; position?: number; value?: number; resume?: boolean }
  | { intent: 'rate' | 'speed'; value: number }
  | {
      intent: 'source' | 'src';
      src?: string | null;
      value?: string | null;
      reload?: boolean;
      forceReload?: boolean;
    }
  | { intent: 'state'; value: Partial<DeckTimelineState> }
  | Partial<DeckTimelineState>
) & { commandId?: string };

export interface DeckMediaStateMessagePayload<TState = DeckTimelineState> {
  deck: DeckKey;
  state: TState;
}

export type TransportCommandPayload = {
  op: string;
  rev?: number;
  position_us?: number;
  positionUs?: number;
  positionSeconds?: number;
  position?: number;
  rate?: number;
  value?: number;
  playRate?: number;
  speed?: number;
};

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
  | { type: 'deck-media-state'; payload: DeckMediaStateMessagePayload<DeckMediaStateIntent> }
  | { type: 'transport-command'; payload: TransportCommandPayload & { commandId?: string } }
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
          deckMediaStates?: DeckTimelineStateMap;
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
  | {
      type: 'transport-error';
      commandId?: string;
      payload: { code: string; message: string; transport?: TransportSnapshot };
    }
  | { type: 'transport'; payload: TransportSnapshot; commandId?: string }
  | { type: 'transport-tick'; payload: TransportTickPayload }
  | RTCSignalMessage;
