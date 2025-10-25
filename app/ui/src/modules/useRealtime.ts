import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ControlSettings,
  DeckMediaStateIntent,
  DeckTimelineState,
  DeckTimelineStateMap,
  FallbackAssets,
  FallbackLayer,
  InboundMessage,
  MixDeck,
  MixState,
  OutboundMessage,
  RTCSignalMessage,
  StartVisualizationPayload,
  ViewerStatus,
} from '../types/realtime';
import { createDefaultDeckTimelineState } from '../types/realtime';
import { MIX_DECK_KEYS, type DeckKey } from '../utils/mix';

const EMPTY_DECK: MixDeck = { type: null, assetId: null, opacity: 0, enabled: false };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const buildBackendOrigin = () => {
  if (typeof window === 'undefined') {
    return '';
  }

  if (import.meta.env.DEV) {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    return `${protocol}//${window.location.hostname}:8080`;
  }

  return window.location.origin;
};

const normaliseAssetUrls = (assets: FallbackAssets): FallbackAssets => {
  const origin = buildBackendOrigin();
  const normaliseUrl = (url: string) => {
    if (!url || !origin) {
      return url;
    }
    try {
      return new URL(url, origin).toString();
    } catch {
      if (url.startsWith('/')) {
        return `${origin}${url}`;
      }
      return url;
    }
  };

  const proxiedUrl = (rawUrl: string) => {
    if (!rawUrl || !origin) {
      return rawUrl;
    }
    try {
      const candidate = new URL(rawUrl, origin);
      const originUrl = new URL(origin);
      if (candidate.origin === originUrl.origin) {
        return candidate.toString();
      }
      return `${origin}/proxy/media?url=${encodeURIComponent(candidate.toString())}`;
    } catch {
      return rawUrl;
    }
  };

  return {
    glsl: assets.glsl ?? [],
    videos: (assets.videos ?? []).map((video) => {
      const resolved = normaliseUrl(video.url);
      return {
        ...video,
        url: proxiedUrl(resolved),
      };
    }),
    overlays: (assets.overlays ?? []).map((overlay) => {
      const resolved = normaliseUrl(overlay.url);
      return {
        ...overlay,
        url: proxiedUrl(resolved),
      };
    }),
  };
};

type ConnectionState = 'connecting' | 'open' | 'closed';

export interface RealtimeHandlers {
  onStartVisualization?: (payload: StartVisualizationPayload) => void;
  onStopVisualization?: () => void;
  onRegenerateShader?: () => void;
  onSetAudioSensitivity?: (value: number) => void;
  onCodeProgress?: (payload: { code: string; isComplete: boolean }) => void;
  onRTCSignal?: (signal: RTCSignalMessage) => void;
}

export function useRealtime(role: 'viewer' | 'controller', handlers: RealtimeHandlers = {}) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [fallbackLayers, setFallbackLayers] = useState<FallbackLayer[]>([]);
  const [controlSettings, setControlSettings] = useState<ControlSettings>({
    modelProvider: 'gemini',
    audioInputMode: 'file',
    prompt: '',
  });
  const [viewerStatus, setViewerStatus] = useState<ViewerStatus>({
    isRunning: false,
    isGenerating: false,
    error: '',
  });
  const [assets, setAssets] = useState<FallbackAssets>(() =>
    normaliseAssetUrls({
      glsl: [],
      videos: [],
      overlays: [],
    }),
  );
  const createDefaultDeckMediaStates = useCallback((): DeckTimelineStateMap => {
    const map = {} as DeckTimelineStateMap;
    MIX_DECK_KEYS.forEach((key) => {
      map[key] = createDefaultDeckTimelineState();
    });
    return map;
  }, []);

  const resolveDeckTimelineState = useCallback((source?: Partial<DeckTimelineState> | null): DeckTimelineState => {
    const defaults = createDefaultDeckTimelineState();
    if (!source) {
      return { ...defaults };
    }

    const nowSeconds = Date.now() / 1000;
    const normaliseNumber = (value: unknown, fallback: number, clampNonNegative = true) => {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) {
        return clampNonNegative ? Math.max(0, fallback) : fallback;
      }
      return clampNonNegative ? Math.max(0, numeric) : numeric;
    };

    const src =
      typeof source.src === 'string' && source.src.trim().length > 0 ? source.src.trim() : null;
    const playRate = Math.min(8, Math.max(0, normaliseNumber(source.playRate, defaults.playRate)));
    const basePosition = normaliseNumber(source.basePosition, defaults.basePosition);
    const updatedAt = normaliseNumber(source.updatedAt, nowSeconds, false);
    const isPlaying = Boolean(source.isPlaying);
    const durationRaw = typeof source.duration === 'number' ? source.duration : Number(source.duration);
    const duration =
      Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;
    const isLoading = Boolean(source.isLoading);
    const error = Boolean(source.error);
    const version =
      typeof source.version === 'number' && Number.isFinite(source.version) && source.version >= 0
        ? Number(source.version)
        : defaults.version;
    const explicitPositionRaw =
      typeof source.position === 'number' ? source.position : Number(source.position);
    const explicitPosition =
      Number.isFinite(explicitPositionRaw) && explicitPositionRaw >= 0 ? explicitPositionRaw : null;
    const elapsed = isPlaying ? Math.max(0, nowSeconds - updatedAt) : 0;
    const computedPosition = basePosition + elapsed * playRate;
    const commandId = typeof (source as any).commandId === 'string' ? (source as any).commandId : null;

    return {
      src,
      isPlaying,
      basePosition,
      position: explicitPosition ?? Math.max(0, computedPosition),
      playRate,
      updatedAt,
      version,
      isLoading,
      error,
      duration,
      commandId,
    };
  }, []);

  const normaliseMixState = useCallback((incoming?: Partial<MixState> | null): MixState => {
    const source = incoming ?? {};
    const decks = (source.decks ?? {}) as Partial<Record<DeckKey, MixDeck>>;
    const normalisedDecks = {} as Record<DeckKey, MixDeck>;
    MIX_DECK_KEYS.forEach((key) => {
      normalisedDecks[key] = { ...EMPTY_DECK, ...(decks[key] ?? {}) };
    });

    return {
      crossfaderAB: clamp01((source as any).crossfaderAB ?? (source as any).crossfader ?? 0.5),
      crossfaderAC: clamp01((source as any).crossfaderAC ?? 0.5),
      crossfaderBD: clamp01((source as any).crossfaderBD ?? 0.5),
      crossfaderCD: clamp01((source as any).crossfaderCD ?? 0.5),
      decks: normalisedDecks,
    };
  }, []);

  const [mixState, setMixState] = useState<MixState>(() => normaliseMixState());
  const [deckMediaStates, setDeckMediaStates] = useState<DeckTimelineStateMap>(
    () => createDefaultDeckMediaStates(),
  );

  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(handlers);
  const commandCounterRef = useRef(0);
  const latestCommandIdsRef = useRef<Record<DeckKey, string | null>>({ a: null, b: null, c: null, d: null });

  const nextCommandId = useCallback((): string => {
    commandCounterRef.current += 1;
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${commandCounterRef.current}`;
  }, []);

  handlersRef.current = handlers;

  const send = useCallback(
    (message: OutboundMessage) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    },
    [],
  );

  const requestDeckState = useCallback(
    (deck: DeckKey, state: DeckMediaStateIntent) => {
      if (role !== 'controller') {
        return;
      }
      const commandId = nextCommandId();
      const stateWithCommand = { ...state, commandId } as DeckMediaStateIntent;
      latestCommandIdsRef.current[deck] = commandId;
      send({
        type: 'deck-media-state',
        commandId,
        payload: {
          deck,
          state: stateWithCommand,
        },
      });
    },
    [nextCommandId, send],
  );

  const requestDeckToggle = useCallback(
    (deck: DeckKey, override?: boolean) => {
      requestDeckState(deck, { intent: 'toggle', isPlaying: override });
    },
    [requestDeckState],
  );

  const requestDeckPlay = useCallback(
    (deck: DeckKey) => {
      requestDeckState(deck, { intent: 'play' });
    },
    [requestDeckState],
  );

  const requestDeckPause = useCallback(
    (deck: DeckKey) => {
      requestDeckState(deck, { intent: 'pause' });
    },
    [requestDeckState],
  );

  const requestDeckSeek = useCallback(
    (deck: DeckKey, positionSeconds: number, options?: { resume?: boolean }) => {
      requestDeckState(deck, {
        intent: 'seek',
        position: Math.max(0, positionSeconds),
        resume: options?.resume,
      });
    },
    [requestDeckState],
  );

  const requestDeckRate = useCallback(
    (deck: DeckKey, rate: number) => {
      requestDeckState(deck, { intent: 'rate', value: Math.max(0, rate) });
    },
    [requestDeckState],
  );

  const requestDeckSource = useCallback(
    (deck: DeckKey, src: string | null, options?: { reload?: boolean }) => {
      const state: DeckMediaStateIntent = options?.reload
        ? { intent: 'source', src, reload: true, forceReload: true }
        : { intent: 'source', src };
      requestDeckState(deck, state);
    },
    [requestDeckState],
  );

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const isDev = import.meta.env.DEV;
    const host = isDev
      ? `${window.location.hostname}:8080`
      : window.location.host;
    const wsUrl = `${protocol}://${host}/realtime`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setConnectionState('connecting');

    ws.onopen = () => {
      setConnectionState('open');
      ws.send(
        JSON.stringify({
          type: 'register',
          role,
        }),
      );
    };

    ws.onclose = () => {
      setConnectionState('closed');
    };

    ws.onmessage = (event) => {
      try {
        const message: InboundMessage = JSON.parse(event.data);
        if (message.type === 'ping') {
          try {
            ws.send(
              JSON.stringify({
                type: 'pong',
                ts: typeof (message as any).ts === 'number' ? (message as any).ts : Date.now() / 1000,
              }),
            );
          } catch (err) {
            console.warn('Failed to reply pong', err);
          }
          return;
        }
        if (message.type === 'pong') {
          return;
        }
        if (message.type === 'rtc-signal') {
          handlersRef.current.onRTCSignal?.(message);
          return;
        }
        switch (message.type) {
          case 'init': {
            setFallbackLayers(message.payload.state.fallbackLayers);
            setControlSettings(message.payload.state.controlSettings);
            setViewerStatus(message.payload.state.viewerStatus);
            setAssets(normaliseAssetUrls(message.payload.assets));
            if (message.payload.state.mixState) {
              setMixState(normaliseMixState(message.payload.state.mixState));
            }
            setDeckMediaStates(() => {
              const next = createDefaultDeckMediaStates();
              const incomingStates = message.payload.state.deckMediaStates as
                | Partial<Record<DeckKey, Partial<DeckTimelineState>>>
                | undefined;
              MIX_DECK_KEYS.forEach((key) => {
                const resolved = resolveDeckTimelineState(incomingStates?.[key]);
                next[key] = resolved;
                latestCommandIdsRef.current[key] = resolved.commandId ?? null;
              });
              return next;
            });
            break;
          }
          case 'fallback-layers': {
            setFallbackLayers(message.payload);
            break;
          }
          case 'control-settings': {
            setControlSettings(message.payload);
            break;
          }
          case 'mix-state': {
            setMixState(normaliseMixState(message.payload));
            break;
          }
          case 'deck-media-state': {
            const deckKey = message.payload.deck;
            const incoming = resolveDeckTimelineState(message.payload.state);
            setDeckMediaStates((previous) => {
              const previousState = previous[deckKey] ?? createDefaultDeckTimelineState();
              const expectedCommand = latestCommandIdsRef.current[deckKey];
              if (incoming.commandId && expectedCommand && incoming.commandId !== expectedCommand) {
                return previous;
              }
              if (previousState.version > incoming.version) {
                return previous;
              }
              if (previousState.version === incoming.version) {
                const keysToCompare: Array<keyof DeckTimelineState> = [
                  'src',
                  'isPlaying',
                  'basePosition',
                  'playRate',
                  'isLoading',
                  'error',
                  'duration',
                  'commandId',
                ];
                const unchanged = keysToCompare.every(
                  (key) => previousState[key] === incoming[key],
                );
                if (unchanged) {
                  return previous;
                }
              }
              if (incoming.commandId) {
                latestCommandIdsRef.current[deckKey] = incoming.commandId;
              }
              return {
                ...previous,
                [deckKey]: incoming,
              };
            });
            break;
          }
          case 'update-mix-deck': {
            setMixState((prev) => {
              const targetKey = message.payload.deck;
              const prevDeck = prev.decks[targetKey];
              if (!prevDeck) return prev;
              const updatedDeck: MixDeck = {
                ...prevDeck,
                ...message.payload.data,
              };
              if (!['shader', 'video', 'generative'].includes((updatedDeck.type as string) || '')) {
                updatedDeck.type = null;
              }
              if (updatedDeck.type === 'generative') {
                updatedDeck.assetId = null;
              }
              return normaliseMixState({
                crossfaderAB: prev.crossfaderAB,
                crossfaderAC: prev.crossfaderAC,
                crossfaderBD: prev.crossfaderBD,
                crossfaderCD: prev.crossfaderCD,
                decks: {
                  ...prev.decks,
                  [targetKey]: updatedDeck,
                },
              });
            });
            break;
          }
          case 'update-crossfader': {
            setMixState((prev) =>
              normaliseMixState({
                decks: prev.decks,
                crossfaderAB:
                  message.payload.target === 'ab' ? message.payload.value : prev.crossfaderAB,
                crossfaderAC:
                  message.payload.target === 'ac' ? message.payload.value : prev.crossfaderAC,
                crossfaderBD:
                  message.payload.target === 'bd' ? message.payload.value : prev.crossfaderBD,
                crossfaderCD:
                  message.payload.target === 'cd' ? message.payload.value : prev.crossfaderCD,
              }),
            );
            break;
          }
          case 'viewer-status': {
            setViewerStatus(message.payload);
            break;
          }
          case 'code-progress': {
            handlersRef.current.onCodeProgress?.(message.payload);
            break;
          }
          case 'start-visualization': {
            handlersRef.current.onStartVisualization?.(message.payload);
            break;
          }
          case 'stop-visualization': {
            handlersRef.current.onStopVisualization?.();
            break;
          }
          case 'regenerate-shader': {
            handlersRef.current.onRegenerateShader?.();
            break;
          }
          case 'set-audio-sensitivity': {
            handlersRef.current.onSetAudioSensitivity?.(message.payload.value);
            break;
          }
          default: {
            break;
          }
        }
      } catch (err) {
        console.error('Failed to handle realtime message:', err);
      }
    };

    return () => {
      const socket = wsRef.current;
      wsRef.current = null;

      if (!socket) {
        setConnectionState('closed');
        return;
      }

      const closeSafely = () => {
        if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
          return;
        }
        try {
          socket.close(1000, 'cleanup');
        } catch {
          // Ignore close errors triggered during tear down.
        }
      };

      if (socket.readyState === WebSocket.CONNECTING) {
        const abort = () => closeSafely();
        socket.addEventListener('open', abort, { once: true });
        socket.addEventListener('error', abort, { once: true });
      } else if (socket.readyState === WebSocket.OPEN) {
        closeSafely();
      }

      setConnectionState('closed');
    };
  }, [role, normaliseMixState, createDefaultDeckMediaStates, resolveDeckTimelineState]);

  return {
    connectionState,
    fallbackLayers,
    controlSettings,
    viewerStatus,
    assets,
    mixState,
    deckMediaStates,
    send,
    requestDeckState,
    requestDeckToggle,
    requestDeckPlay,
    requestDeckPause,
    requestDeckSeek,
    requestDeckRate,
    requestDeckSource,
  };
}
