import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRealtime } from '../../modules/useRealtime';
import type { MixDeck, RTCSignalMessage } from '../../types/realtime';
import type { DeckKey } from '../../utils/mix';
import { computeDeckMix } from '../../utils/mix';
import type { ModelProvider } from '../../modules/GLSLGenerator';
import { useVideoMedia } from '../../modules/useVideoMedia';
import '../../App.css';
import {
  deckKeys,
  defaultSettings,
} from './constants';
import type { ContentTab, DeckMediaState } from './types';
import {
  clampSensitivityValue,
  mapSliderToSensitivity,
} from './utils';
import { DeckColumn } from './components/DeckColumn';
import { CenterConsole } from './components/CenterConsole';
import { ContentBrowser } from './components/ContentBrowser';

const emptyDeck: MixDeck = { type: null, assetId: null, opacity: 0, enabled: false };

const createDefaultDeckMediaState = (): Record<DeckKey, DeckMediaState> => ({
  a: { isPlaying: false, progress: 0, isLoading: false, error: false, src: null },
  b: { isPlaying: false, progress: 0, isLoading: false, error: false, src: null },
  c: { isPlaying: false, progress: 0, isLoading: false, error: false, src: null },
  d: { isPlaying: false, progress: 0, isLoading: false, error: false, src: null },
});

const ControlPage = () => {
  const {
    registerVideo,
    loadSource,
    play: playVideo,
    pause: pauseVideo,
    seekToPercent,
    setPlaybackRate,
    addEventListener,
    getState,
  } = useVideoMedia();

  const [modelProvider, setModelProvider] = useState<ModelProvider>(defaultSettings.modelProvider);
  const [audioInputMode, setAudioInputMode] = useState<'file' | 'microphone'>(
    defaultSettings.audioInputMode,
  );
  const [prompt, setPrompt] = useState(defaultSettings.prompt);
  const [geminiApiKey, setGeminiApiKey] = useState(() => localStorage.getItem('gemini-api-key') || '');
  const [openaiApiKey, setOpenaiApiKey] = useState(() => localStorage.getItem('openai-api-key') || '');
  const [latestCode, setLatestCode] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [audioSensitivity, setAudioSensitivity] = useState(1.0);
  const [deckStates, setDeckStates] = useState<Record<DeckKey, DeckMediaState>>(
    createDefaultDeckMediaState,
  );
  const [localSensitivityValues, setLocalSensitivityValues] = useState<Record<DeckKey, number>>({
    a: 50,
    b: 50,
    c: 50,
    d: 50,
  });
  const [pendingDeckOpacities, setPendingDeckOpacities] = useState<Record<DeckKey, number | null>>({
    a: null,
    b: null,
    c: null,
    d: null,
  });
  const [desiredDeckPlayback, setDesiredDeckPlayback] = useState<Record<DeckKey, boolean>>({
    a: false,
    b: false,
    c: false,
    d: false,
  });
  const desiredDeckPlaybackRef = useRef(desiredDeckPlayback);
  const [dropTargetDeck, setDropTargetDeck] = useState<DeckKey | null>(null);
  const [activeContentTab, setActiveContentTab] = useState<ContentTab>('generative');
  const [selectedAssetValue, setSelectedAssetValue] = useState<string | null>(null);
  const [rtcSignalQueue, setRtcSignalQueue] = useState<RTCSignalMessage[]>([]);

  const { connectionState, viewerStatus, send, controlSettings, assets, mixState } = useRealtime('controller', {
    onCodeProgress: (progress) => {
      setLatestCode(progress.code);
      setIsGenerating(!progress.isComplete);
    },
    onRTCSignal: (signal) => {
      if (signal.rtc === 'offer' || signal.rtc === 'ice-candidate') {
        setRtcSignalQueue((previous) => [...previous, signal]);
      }
    },
  });

  const decks: Record<DeckKey, MixDeck> = {
    a: mixState?.decks?.a ?? { ...emptyDeck },
    b: mixState?.decks?.b ?? { ...emptyDeck },
    c: mixState?.decks?.c ?? { ...emptyDeck },
    d: mixState?.decks?.d ?? { ...emptyDeck },
  };

  const currentRtcSignal = rtcSignalQueue.length > 0 ? rtcSignalQueue[0] : null;

  useEffect(() => {
    if (connectionState !== 'open') {
      return;
    }
    send({
      type: 'rtc-signal',
      rtc: 'request-offer',
      payload: null,
    });
  }, [connectionState, send]);

  const deckHasVideo = useMemo(
    () => ({
      a: decks.a.type === 'video' && Boolean(decks.a.assetId),
      b: decks.b.type === 'video' && Boolean(decks.b.assetId),
      c: decks.c.type === 'video' && Boolean(decks.c.assetId),
      d: decks.d.type === 'video' && Boolean(decks.d.assetId),
    }),
    [
      decks.a.type,
      decks.a.assetId,
      decks.b.type,
      decks.b.assetId,
      decks.c.type,
      decks.c.assetId,
      decks.d.type,
      decks.d.assetId,
    ],
  );

  const deckVideoRefCallbacks = useMemo(
    () =>
      deckKeys.reduce((accumulator, key) => {
        accumulator[key] = (element: HTMLVideoElement | null) => {
          registerVideo(`deck-${key}`, element);
          if (element && desiredDeckPlaybackRef.current[key]) {
            void playVideo(`deck-${key}`);
          }
        };
        return accumulator;
      }, {} as Record<DeckKey, (element: HTMLVideoElement | null) => void>),
    [playVideo, registerVideo],
  );

  const masterPreviewVideoRefCallbacks = useMemo(
    () =>
      deckKeys.reduce((accumulator, key) => {
        accumulator[key] = (element: HTMLVideoElement | null) => {
          registerVideo(`master-${key}`, element);
          if (element && desiredDeckPlaybackRef.current[key]) {
            void playVideo(`master-${key}`);
          }
        };
        return accumulator;
      }, {} as Record<DeckKey, (element: HTMLVideoElement | null) => void>),
    [playVideo, registerVideo],
  );

  const broadcastDeckMediaState = useCallback(
    (deckKey: DeckKey, state: DeckMediaState) => {
      send({
        type: 'deck-media-state',
        payload: {
          deck: deckKey,
          state: {
            ...state,
            src: state.src ?? null,
          },
        },
      });
    },
    [send],
  );

  const consumeRtcSignal = useCallback(() => {
    setRtcSignalQueue((previous) => {
      if (previous.length === 0) {
        return previous;
      }
      return previous.slice(1);
    });
  }, []);

  const handleSendRtcSignal = useCallback(
    (signal: RTCSignalMessage) => {
      send(signal);
    },
    [send],
  );

  useEffect(() => {
    localStorage.setItem('gemini-api-key', geminiApiKey);
  }, [geminiApiKey]);

  useEffect(() => {
    localStorage.setItem('openai-api-key', openaiApiKey);
  }, [openaiApiKey]);

  useEffect(() => {
    setModelProvider(controlSettings.modelProvider);
    setAudioInputMode(controlSettings.audioInputMode);
    setPrompt(controlSettings.prompt);
  }, [controlSettings]);

  useEffect(() => {
    setIsGenerating(viewerStatus.isGenerating);
    setAudioSensitivity(viewerStatus.audioSensitivity ?? 1.0);
  }, [viewerStatus]);

  useEffect(() => {
    desiredDeckPlaybackRef.current = desiredDeckPlayback;
  }, [desiredDeckPlayback]);

  useEffect(() => {
    const unsubscribes = deckKeys.map((deckKey) => {
      const deckId = `deck-${deckKey}`;
      const masterId = `master-${deckKey}`;

      return addEventListener(deckId, (state, details) => {
        let nextStateForBroadcast: DeckMediaState | null = null;
        setDeckStates((previous) => {
          const current = previous[deckKey] ?? createDefaultDeckMediaState()[deckKey];
          const progressDetail =
            typeof details?.progress === 'number' ? (details.progress as number) : current.progress;
          const clampedProgress = Math.max(0, Math.min(100, progressDetail));
          const normalizeSrc = (value: unknown) => {
            if (typeof value !== 'string') {
              return null;
            }
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : null;
          };
          const detailSrc = normalizeSrc(details?.src);
          const managerState = getState(deckId);
          const managerSrc = normalizeSrc(managerState.src);
          const currentSrc = normalizeSrc(current.src);
          const nextSrc = detailSrc ?? managerSrc ?? currentSrc ?? null;
          const nextState: DeckMediaState = {
            isPlaying: state === 'playing',
            progress: clampedProgress,
            isLoading: state === 'loading',
            error: state === 'error',
            src: nextSrc,
          };
          if (
            current.isPlaying === nextState.isPlaying &&
            Math.abs(current.progress - nextState.progress) < 0.01 &&
            current.isLoading === nextState.isLoading &&
            current.error === nextState.error &&
            current.src === nextState.src
          ) {
            return previous;
          }
          nextStateForBroadcast = nextState;
          return {
            ...previous,
            [deckKey]: nextState,
          };
        });

        if (nextStateForBroadcast) {
          broadcastDeckMediaState(deckKey, nextStateForBroadcast);
        }

        if (state === 'ready' && desiredDeckPlaybackRef.current[deckKey]) {
          void playVideo(deckId);
          void playVideo(masterId);
        }

        if (state === 'playing' || state === 'paused') {
          const progressDetail =
            typeof details?.progress === 'number'
              ? (details.progress as number)
              : getState(deckId).progress;
          const clampedProgress = Math.max(0, Math.min(100, progressDetail));
          seekToPercent(masterId, clampedProgress);
          if (state === 'playing') {
            void playVideo(masterId);
          } else {
            pauseVideo(masterId);
          }
        }

        if (state === 'playing') {
          setDesiredDeckPlayback((previous) =>
            previous[deckKey] ? previous : { ...previous, [deckKey]: true },
          );
        }
      });
    });

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, [addEventListener, broadcastDeckMediaState, getState, pauseVideo, playVideo, seekToPercent]);

  useEffect(() => {
    let cancelled = false;

    const loadDecks = async () => {
      for (const deckKey of deckKeys) {
        const deck = decks[deckKey];
        const deckId = `deck-${deckKey}`;
        const masterId = `master-${deckKey}`;

        try {
          if (deck?.type === 'video' && deck.assetId) {
            const video =
              assets.videos.find((item) => item.id === deck.assetId) ??
              assets.overlays?.find((item) => item.id === deck.assetId);

            if (video && 'url' in video) {
              const shouldPlay = desiredDeckPlaybackRef.current[deckKey];

              if (shouldPlay) {
                void playVideo(deckId);
                void playVideo(masterId);
              }

              await loadSource(deckId, video.url);
              if (cancelled) return;
              await loadSource(masterId, video.url);
              if (cancelled) return;

              if (shouldPlay) {
                const deckManagerState = getState(deckId);
                const masterManagerState = getState(masterId);

                if (deckManagerState.state !== 'playing' && !deckManagerState.pendingPlay) {
                  void playVideo(deckId);
                }
                if (masterManagerState.state !== 'playing' && !masterManagerState.pendingPlay) {
                  void playVideo(masterId);
                }
              } else {
                pauseVideo(deckId);
                pauseVideo(masterId);
              }
              continue;
            }
          }

          await loadSource(deckId, null);
          if (cancelled) return;
          await loadSource(masterId, null);
          if (cancelled) return;
          pauseVideo(deckId);
          pauseVideo(masterId);
        } catch (error) {
          console.error(`Error loading deck ${deckKey}`, error);
        }

        if (cancelled) {
          return;
        }
      }
    };

    void loadDecks();

    return () => {
      cancelled = true;
    };
  }, [assets.overlays, assets.videos, decks, getState, loadSource, pauseVideo, playVideo]);

  useEffect(() => {
    deckKeys.forEach((deckKey) => {
      const deck = decks[deckKey];
      const shouldPlay = desiredDeckPlayback[deckKey];
      const deckId = `deck-${deckKey}`;
      const masterId = `master-${deckKey}`;

      if (!deck || deck.type !== 'video' || !deck.assetId) {
        pauseVideo(deckId);
        pauseVideo(masterId);
        return;
      }

      const deckManagerState = getState(deckId);
      const masterManagerState = getState(masterId);

      if (shouldPlay) {
        if (deckManagerState.state !== 'playing' && !deckManagerState.pendingPlay) {
          void playVideo(deckId);
        }
        if (masterManagerState.state !== 'playing' && !masterManagerState.pendingPlay) {
          void playVideo(masterId);
        }
      } else {
        if (deckManagerState.state === 'playing' || deckManagerState.pendingPlay) {
          pauseVideo(deckId);
        }
        if (masterManagerState.state === 'playing' || masterManagerState.pendingPlay) {
          pauseVideo(masterId);
        }
      }
    });
  }, [decks, desiredDeckPlayback, getState, pauseVideo, playVideo]);

  useEffect(() => {
    setDesiredDeckPlayback((previous) => {
      let didChange = false;
      const next: Record<DeckKey, boolean> = { ...previous };
      deckKeys.forEach((deckKey) => {
        if (!deckHasVideo[deckKey]) {
          if (next[deckKey]) {
            next[deckKey] = false;
            didChange = true;
          }
        }
      });
      return didChange ? next : previous;
    });
  }, [deckHasVideo]);

  useEffect(() => {
    deckKeys.forEach((deckKey) => {
      const deck = decks[deckKey];
      if (!deck || deck.type !== 'video' || !deck.assetId) {
        return;
      }
      const localSlider = localSensitivityValues[deckKey] ?? 50;
      const multiplier =
        mapSliderToSensitivity(localSlider) ?? clampSensitivityValue(audioSensitivity);
      setPlaybackRate(`deck-${deckKey}`, multiplier);
      setPlaybackRate(`master-${deckKey}`, multiplier);
    });
  }, [audioSensitivity, decks, localSensitivityValues, setPlaybackRate]);

  const mixComputation = useMemo(() => computeDeckMix(mixState), [mixState]);
  const { outputs: deckMixOutputs } = mixComputation;

  const crossfaderValue = mixState?.crossfaderAB ?? 0.5;
  const [crossfaderDisplayValue, setCrossfaderDisplayValue] = useState(crossfaderValue);

  useEffect(() => {
    setCrossfaderDisplayValue(crossfaderValue);
  }, [crossfaderValue]);

  useEffect(() => {
    setPendingDeckOpacities((previous) => {
      let didChange = false;
      const next: Record<DeckKey, number | null> = { ...previous };
      deckKeys.forEach((deckKey) => {
        const pending = previous[deckKey];
        if (pending == null) {
          return;
        }
        const serverValue = Math.max(0, Math.min(1, decks[deckKey]?.opacity ?? 0));
        if (Math.abs(serverValue - pending) < 0.01) {
          next[deckKey] = null;
          didChange = true;
        }
      });
      return didChange ? next : previous;
    });
  }, [decks.a.opacity, decks.b.opacity, decks.c.opacity, decks.d.opacity]);

  const handleRegenerate = useCallback(() => {
    send({ type: 'regenerate-shader' });
  }, [send]);

  const handleAudioSensitivity = useCallback(
    (value: number) => {
      const clampedValue = clampSensitivityValue(value);
      setAudioSensitivity(clampedValue);
      send({ type: 'set-audio-sensitivity', payload: { value: clampedValue } });
      deckKeys.forEach((deckKey) => {
        setPlaybackRate(`deck-${deckKey}`, clampedValue);
        setPlaybackRate(`master-${deckKey}`, clampedValue);
      });
    },
    [send, setPlaybackRate],
  );

  const sendDeckUpdate = useCallback(
    (deck: DeckKey, data: Partial<MixDeck>) => {
      send({ type: 'update-mix-deck', payload: { deck, data } });
    },
    [send],
  );

  const handleDeckAssetChange = useCallback(
    (deck: DeckKey, value: string) => {
      if (!value) {
        sendDeckUpdate(deck, { type: null, assetId: null, opacity: 0 });
        return;
      }

      if (value === 'generative') {
        sendDeckUpdate(deck, { type: 'generative', assetId: null, opacity: 1 });
        return;
      }

      const [type, assetId] = value.split(':', 2);
      if (type === 'glsl' && assetId) {
        sendDeckUpdate(deck, { type: 'shader', assetId, opacity: 1 });
        return;
      }

      if (type === 'video' && assetId) {
        sendDeckUpdate(deck, { type: 'video', assetId, opacity: 1 });
        return;
      }
    },
    [sendDeckUpdate],
  );

  const handleDeckOpacitySliderChange = useCallback(
    (deck: DeckKey, sliderValue: number) => {
      const clamped = Math.min(100, Math.max(0, sliderValue));
      const inverted = 100 - clamped;
      const nextOpacity = Math.max(0, Math.min(1, inverted / 100));
      setPendingDeckOpacities((previous) => ({
        ...previous,
        [deck]: nextOpacity,
      }));
      sendDeckUpdate(deck, { opacity: Number(nextOpacity.toFixed(3)) });
    },
    [sendDeckUpdate],
  );

  const handleDeckPowerToggle = (deckKey: DeckKey) => {
    const deck = decks[deckKey];
    const willEnable = !(deck?.enabled ?? false);
    sendDeckUpdate(deckKey, { enabled: willEnable });
  };

  const handleProviderChange = useCallback(
    (provider: ModelProvider) => {
      setModelProvider(provider);
      send({
        type: 'update-control-settings',
        payload: {
          modelProvider: provider,
        },
      });
      if (provider === 'openai') {
        setAudioInputMode('microphone');
        send({
          type: 'update-control-settings',
          payload: {
            audioInputMode: 'microphone',
          },
        });
      }
    },
    [send],
  );

  const handleAudioModeChange = useCallback(
    (mode: 'file' | 'microphone') => {
      setAudioInputMode(mode);
      send({
        type: 'update-control-settings',
        payload: {
          audioInputMode: mode,
        },
      });
    },
    [send],
  );

  const handleCrossfaderChange = useCallback(
    (value: number) => {
      setCrossfaderDisplayValue(value);
      send({ type: 'update-crossfader', payload: { target: 'ab', value } });
    },
    [send],
  );

  const handleDeckPlaybackToggle = useCallback(
    (deckKey: DeckKey) => {
      const deck = decks[deckKey];
      if (!deck || deck.type !== 'video' || !deck.assetId) {
        return;
      }

      const deckId = `deck-${deckKey}`;
      const masterId = `master-${deckKey}`;
      const isPlaying = deckStates[deckKey]?.isPlaying ?? false;
      const willPlay = !isPlaying;

      setDesiredDeckPlayback((previous) => ({
        ...previous,
        [deckKey]: willPlay,
      }));

      if (willPlay) {
        void playVideo(deckId);
        void playVideo(masterId);
      } else {
        pauseVideo(deckId);
        pauseVideo(masterId);
      }
    },
    [deckStates, decks, pauseVideo, playVideo],
  );

  const handleDeckPlaybackScrub = useCallback(
    (deckKey: DeckKey, value: number) => {
      const deck = decks[deckKey];
      if (!deck || deck.type !== 'video') {
        return;
      }

      const clamped = Math.max(0, Math.min(100, value));
      const deckId = `deck-${deckKey}`;
      const masterId = `master-${deckKey}`;

      seekToPercent(deckId, clamped);
      seekToPercent(masterId, clamped);

      setDeckStates((previous) => {
        const prevState = previous[deckKey] ?? createDefaultDeckMediaState()[deckKey];
        if (Math.abs(prevState.progress - clamped) < 0.01) {
          return previous;
        }
        return {
          ...previous,
          [deckKey]: {
            ...prevState,
            progress: clamped,
          },
        };
      });
    },
    [decks, seekToPercent],
  );

  const handleLocalSensitivityChange = useCallback(
    (deckKey: DeckKey, sliderValue: number) => {
      const clampedSlider = Math.max(0, Math.min(100, sliderValue));
      setLocalSensitivityValues((prev) => ({
        ...prev,
        [deckKey]: clampedSlider,
      }));
      const nextMultiplier = clampSensitivityValue(mapSliderToSensitivity(clampedSlider));
      setPlaybackRate(`deck-${deckKey}`, nextMultiplier);
      setPlaybackRate(`master-${deckKey}`, nextMultiplier);
    },
    [setPlaybackRate],
  );

  const handleAssetLoad = useCallback(
    (deckKey: DeckKey) => {
      if (!selectedAssetValue) return;
      handleDeckAssetChange(deckKey, selectedAssetValue);
    },
    [handleDeckAssetChange, selectedAssetValue],
  );

  const getDeckAssetLabel = useCallback(
    (deck?: MixDeck) => {
      if (!deck?.type) return 'No source';
      if (deck.type === 'generative') return 'Generative shader';
      if (!deck.assetId) return 'No source';
      if (deck.type === 'shader') {
        const shader = assets.glsl.find((item) => item.id === deck.assetId);
        return shader ? shader.name : deck.assetId;
      }
      const video =
        assets.videos.find((item) => item.id === deck.assetId) ??
        assets.overlays?.find((item) => item.id === deck.assetId);
      if (video) {
        const category = 'category' in video ? video.category : '';
        return category ? `${category}/${video.name}` : video.name;
      }
      return deck.assetId;
    },
    [assets.glsl, assets.overlays, assets.videos],
  );

  const renderDeckPreviewContent = (deckKey: DeckKey) => {
    const deck = decks[deckKey];
    const effectiveOpacity =
      pendingDeckOpacities[deckKey] ?? Math.max(0, Math.min(1, deck?.opacity ?? 0));

    if (!deck || effectiveOpacity <= 0) {
      return <div className="deck-preview-placeholder">Deck muted</div>;
    }

    if (deck.type === 'generative') {
      return <div className="deck-preview-placeholder">Generative shader</div>;
    }

    if (deck.type === 'video' && deck.assetId) {
      const video =
        assets.videos.find((item) => item.id === deck.assetId) ??
        assets.overlays?.find((item) => item.id === deck.assetId);
      if (video && 'url' in video) {
        const deckState = deckStates[deckKey] ?? createDefaultDeckMediaState()[deckKey];
        if (deckState.error) {
          return <div className="deck-preview-placeholder">Video error</div>;
        }
        const videoKey = `${deckKey}-${video.id}`;
        const resolvedSrc =
          (typeof deckState.src === 'string' && deckState.src.length > 0 ? deckState.src : undefined) ||
          (typeof video.url === 'string' && video.url.length > 0 ? video.url : undefined);
        return (
          <video
            key={videoKey}
            src={resolvedSrc}
            muted
            loop
            playsInline
            preload="auto"
            className="deck-preview-video"
            ref={deckVideoRefCallbacks[deckKey]}
            style={{
              opacity: effectiveOpacity,
              filter: deckState.isLoading ? 'brightness(0.5)' : 'none',
            }}
          />
        );
      }
    }

    if (deck.type === 'shader' && deck.assetId) {
      const shader = assets.glsl.find((item) => item.id === deck.assetId);
      if (shader) {
        const snippet = shader.code.split('\n').slice(0, 12).join('\n');
        return <pre className="deck-preview-shader">{snippet}</pre>;
      }
    }

    return <div className="deck-preview-placeholder">Select a source</div>;
  };

  return (
    <div className="control-app">
      <div className="dj-surface">
        <section className="dj-console-row">
          <DeckColumn
            deckKey="a"
            position="left"
            deck={decks.a}
            deckState={deckStates.a}
            resolvedOpacity={pendingDeckOpacities.a ?? Math.max(0, Math.min(1, decks.a.opacity ?? 0))}
            audioSensitivity={audioSensitivity}
            localSensitivityValue={localSensitivityValues.a}
            isGenerating={isGenerating}
            isGenerativeDeck={decks.a.type === 'generative'}
            isDropTarget={dropTargetDeck === 'a'}
            previewContent={renderDeckPreviewContent('a')}
            onDropTargetChange={setDropTargetDeck}
            onDeckPowerToggle={handleDeckPowerToggle}
            onRegenerate={handleRegenerate}
            onGlobalSensitivityChange={handleAudioSensitivity}
            onLocalSensitivityChange={handleLocalSensitivityChange}
            onDeckOpacitySliderChange={handleDeckOpacitySliderChange}
            onDeckPlaybackToggle={handleDeckPlaybackToggle}
            onDeckPlaybackScrub={handleDeckPlaybackScrub}
            onDeckAssetChange={handleDeckAssetChange}
            getDeckAssetLabel={getDeckAssetLabel}
            options={{
              sensitivityMode: { left: 'local' },
            }}
          />
          <CenterConsole
            decks={decks}
            deckMixOutputs={deckMixOutputs}
            assets={assets}
            viewerStatus={viewerStatus}
            selectedAssetValue={selectedAssetValue}
            onLoadDeck={handleAssetLoad}
            crossfaderValue={crossfaderDisplayValue}
            onCrossfaderChange={handleCrossfaderChange}
            masterPreviewRefs={masterPreviewVideoRefCallbacks}
            rtcSignal={currentRtcSignal}
            onSendRTCSignal={handleSendRtcSignal}
            onConsumeRTCSignal={consumeRtcSignal}
          />
          <DeckColumn
            deckKey="b"
            position="right"
            deck={decks.b}
            deckState={deckStates.b}
            resolvedOpacity={pendingDeckOpacities.b ?? Math.max(0, Math.min(1, decks.b.opacity ?? 0))}
            audioSensitivity={audioSensitivity}
            localSensitivityValue={localSensitivityValues.b}
            isGenerating={isGenerating}
            isGenerativeDeck={decks.b.type === 'generative'}
            isDropTarget={dropTargetDeck === 'b'}
            previewContent={renderDeckPreviewContent('b')}
            onDropTargetChange={setDropTargetDeck}
            onDeckPowerToggle={handleDeckPowerToggle}
            onRegenerate={handleRegenerate}
            onGlobalSensitivityChange={handleAudioSensitivity}
            onLocalSensitivityChange={handleLocalSensitivityChange}
            onDeckOpacitySliderChange={handleDeckOpacitySliderChange}
            onDeckPlaybackToggle={handleDeckPlaybackToggle}
            onDeckPlaybackScrub={handleDeckPlaybackScrub}
            onDeckAssetChange={handleDeckAssetChange}
            getDeckAssetLabel={getDeckAssetLabel}
            options={{
              sensitivityMode: { left: 'local' },
            }}
          />
        </section>

        <section className="dj-overlay-row">
          <DeckColumn
            deckKey="c"
            position="left"
            deck={decks.c}
            deckState={deckStates.c}
            resolvedOpacity={pendingDeckOpacities.c ?? Math.max(0, Math.min(1, decks.c.opacity ?? 0))}
            audioSensitivity={audioSensitivity}
            localSensitivityValue={localSensitivityValues.c}
            isGenerating={isGenerating}
            isGenerativeDeck={decks.c.type === 'generative'}
            isDropTarget={dropTargetDeck === 'c'}
            previewContent={renderDeckPreviewContent('c')}
            onDropTargetChange={setDropTargetDeck}
            onDeckPowerToggle={handleDeckPowerToggle}
            onRegenerate={handleRegenerate}
            onGlobalSensitivityChange={handleAudioSensitivity}
            onLocalSensitivityChange={handleLocalSensitivityChange}
            onDeckOpacitySliderChange={handleDeckOpacitySliderChange}
            onDeckPlaybackToggle={handleDeckPlaybackToggle}
            onDeckPlaybackScrub={handleDeckPlaybackScrub}
            onDeckAssetChange={handleDeckAssetChange}
            getDeckAssetLabel={getDeckAssetLabel}
            options={{
              leftFader: 'sensitivity',
              rightFader: 'opacity',
              title: 'Deck C',
              leftLabel: 'SENSITIVITY',
              rightLabel: 'OPACITY',
              sensitivityMode: { left: 'local' },
            }}
          />
          <ContentBrowser
            assets={assets}
            activeTab={activeContentTab}
            selectedAssetValue={selectedAssetValue}
            onTabChange={setActiveContentTab}
            onSelectAsset={setSelectedAssetValue}
            onDragEnd={() => setDropTargetDeck(null)}
          />
          <DeckColumn
            deckKey="d"
            position="right"
            deck={decks.d}
            deckState={deckStates.d}
            resolvedOpacity={pendingDeckOpacities.d ?? Math.max(0, Math.min(1, decks.d.opacity ?? 0))}
            audioSensitivity={audioSensitivity}
            localSensitivityValue={localSensitivityValues.d}
            isGenerating={isGenerating}
            isGenerativeDeck={decks.d.type === 'generative'}
            isDropTarget={dropTargetDeck === 'd'}
            previewContent={renderDeckPreviewContent('d')}
            onDropTargetChange={setDropTargetDeck}
            onDeckPowerToggle={handleDeckPowerToggle}
            onRegenerate={handleRegenerate}
            onGlobalSensitivityChange={handleAudioSensitivity}
            onLocalSensitivityChange={handleLocalSensitivityChange}
            onDeckOpacitySliderChange={handleDeckOpacitySliderChange}
            onDeckPlaybackToggle={handleDeckPlaybackToggle}
            onDeckPlaybackScrub={handleDeckPlaybackScrub}
            onDeckAssetChange={handleDeckAssetChange}
            getDeckAssetLabel={getDeckAssetLabel}
            options={{
              leftFader: 'sensitivity',
              rightFader: 'opacity',
              title: 'Deck D',
              leftLabel: 'SENSITIVITY',
              rightLabel: 'OPACITY',
              sensitivityMode: { left: 'local' },
            }}
          />
        </section>

        <section className="dj-bottom-row">
          <aside className="dj-side-panels">
            <div className="control-card model-card">
              <h2>Model &amp; Audio</h2>
              <div className="input-group">
                <label>LLM Provider</label>
                <div className="radio-group">
                  <label>
                    <input
                      type="radio"
                      value="gemini"
                      checked={modelProvider === 'gemini'}
                      onChange={() => handleProviderChange('gemini')}
                    />
                    Gemini
                  </label>
                  <label>
                    <input
                      type="radio"
                      value="openai"
                      checked={modelProvider === 'openai'}
                      onChange={() => handleProviderChange('openai')}
                    />
                    GPT
                  </label>
                </div>
              </div>

              {modelProvider === 'gemini' ? (
                <div className="input-group">
                  <label htmlFor="geminiApiKey">Gemini API Key</label>
                  <input
                    id="geminiApiKey"
                    type="password"
                    value={geminiApiKey}
                    onChange={(event) => setGeminiApiKey(event.target.value)}
                    placeholder="Enter your Gemini API key"
                    autoComplete="off"
                  />
                </div>
              ) : (
                <div className="input-group">
                  <label htmlFor="openaiApiKey">OpenAI API Key</label>
                  <input
                    id="openaiApiKey"
                    type="password"
                    value={openaiApiKey}
                    onChange={(event) => setOpenaiApiKey(event.target.value)}
                    placeholder="Enter your OpenAI API key"
                    autoComplete="off"
                  />
                </div>
              )}

              <div className="input-group">
                <label>Audio Input</label>
                <div className="radio-group">
                  <label>
                    <input
                      type="radio"
                      value="file"
                      checked={audioInputMode === 'file'}
                      onChange={() => handleAudioModeChange('file')}
                      disabled={modelProvider === 'openai'}
                    />
                    Audio File {modelProvider === 'openai' && '(Gemini only)'}
                  </label>
                  <label>
                    <input
                      type="radio"
                      value="microphone"
                      checked={audioInputMode === 'microphone'}
                      onChange={() => handleAudioModeChange('microphone')}
                    />
                    Microphone
                  </label>
                </div>
              </div>

              {audioInputMode === 'microphone' && (
                <div className="input-group">
                  <label htmlFor="prompt">Prompt</label>
                  <textarea
                    id="prompt"
                    value={prompt}
                    onChange={(event) => {
                      const value = event.target.value;
                      setPrompt(value);
                      send({
                        type: 'update-control-settings',
                        payload: { prompt: value },
                      });
                    }}
                    rows={4}
                    placeholder="Describe the visual you want..."
                  />
                </div>
              )}
            </div>

            <div className="control-card code-card">
              <h2>Shader Stream</h2>
              <pre className="control-code-preview">
                {latestCode || '// Awaiting shader output...'}
              </pre>
            </div>
          </aside>
        </section>
      </div>
    </div>
  );
};

export default ControlPage;
