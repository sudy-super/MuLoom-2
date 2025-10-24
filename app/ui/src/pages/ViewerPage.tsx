import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { CodeEditor } from '../components/CodeEditor';
import { ShaderFallbackLayer, VideoFallbackLayer } from '../components/FallbackLayers';
import { AudioInput, type AudioAnalysis } from '../modules/AudioInput';
import { GLSLGenerator, type ModelProvider } from '../modules/GLSLGenerator';
import { GLSLRenderer } from '../modules/GLSLRenderer';
import { useViewerCapture } from '../modules/useViewerCapture';
import { useRTCStreaming } from '../modules/useRTCStreaming';
import { useRealtime } from '../modules/useRealtime';
import { useVideoMedia } from '../modules/useVideoMedia';
import type { DeckMediaStateIntent, RTCSignalMessage, StartVisualizationPayload } from '../types/realtime';
import { computeDeckMix, type DeckKey, MIX_DECK_KEYS } from '../utils/mix';
import '../App.css';

const MAX_RETRIES = 5;

const ViewerPage = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioInputRef = useRef<AudioInput | null>(null);
  const glslGeneratorRef = useRef<GLSLGenerator | null>(null);
  const rendererRef = useRef<GLSLRenderer | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const retryCountRef = useRef(0);
  const generativeShaderRef = useRef<string>('');

  const geminiApiKeyRef = useRef('');
  const openaiApiKeyRef = useRef('');
  const modelProviderRef = useRef<ModelProvider>('gemini');
  const audioModeRef = useRef<'file' | 'microphone'>('file');
  const promptRef = useRef('');

  const audioSensitivityRef = useRef<number>(1.0);
  const audioFileRef = useRef<File | null>(null);
  const audioUnsubscribeRef = useRef<(() => void) | null>(null);
  const fallbackAudioHandlersRef = useRef<
    Map<string, (data: AudioAnalysis, sensitivity: number) => void>
  >(new Map());

  const [isRunning, setIsRunning] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');
  const [generatedCode, setGeneratedCode] = useState('');
  const [audioSensitivity, setAudioSensitivityState] = useState(1.0);
  const [requiresUserTap, setRequiresUserTap] = useState(false);

  const startVisualizationRef = useRef<(payload: StartVisualizationPayload) => void>(() => {});
  const stopVisualizationRef = useRef<() => void>(() => {});
  const regenerateShaderRef = useRef<() => void>(() => {});
  const setSensitivityRef = useRef<(value: number) => void>(() => {});

  const rtcSignalHandlersRef = useRef<{
    handleRemoteAnswer: (answer: RTCSessionDescriptionInit) => Promise<boolean>;
    addRemoteIceCandidate: (candidate: RTCIceCandidateInit) => Promise<boolean>;
  }>({
    handleRemoteAnswer: async () => false,
    addRemoteIceCandidate: async () => false,
  });
  const startStreamingRef = useRef<() => Promise<void>>(async () => {});

  const { assets, mixState, deckMediaStates, send, requestDeckState } = useRealtime('viewer', {
    onStartVisualization: (payload) => startVisualizationRef.current(payload),
    onStopVisualization: () => stopVisualizationRef.current(),
    onRegenerateShader: () => regenerateShaderRef.current(),
    onSetAudioSensitivity: (value) => setSensitivityRef.current(value),
    onRTCSignal: async (signal: RTCSignalMessage) => {
      switch (signal.rtc) {
        case 'answer': {
          await rtcSignalHandlersRef.current.handleRemoteAnswer(signal.payload);
          break;
        }
        case 'ice-candidate': {
          await rtcSignalHandlersRef.current.addRemoteIceCandidate(signal.payload);
          break;
        }
        case 'request-offer': {
          await startStreamingRef.current();
          break;
        }
        default: {
          break;
        }
      }
    },
  });

  const {
    registerVideo: registerManagedVideo,
    loadSource: loadManagedSource,
    play: playManagedVideo,
    pause: pauseManagedVideo,
    seekToPercent: seekManagedToPercent,
    setPlaybackRate: setManagedPlaybackRate,
    addEventListener: addManagedEventListener,
    getState: getManagedState,
  } = useVideoMedia();

  const { startCapture, stopCapture } = useViewerCapture({ frameRate: 30, quality: 0.85 });

  const sendRTCSignal = useCallback(
    (signal: RTCSignalMessage) => {
      send(signal);
    },
    [send],
  );

  const {
    connectionState: rtcConnectionState,
    initBroadcaster,
    handleRemoteAnswer,
    addRemoteIceCandidate,
    closeConnection,
  } = useRTCStreaming(sendRTCSignal);

  const isStartingStreamRef = useRef(false);
  const hasConnectedStreamRef = useRef(false);

  const deckDurationsRef = useRef<Record<DeckKey, number>>({
    a: 0,
    b: 0,
    c: 0,
    d: 0,
  });

  const lastDeckBroadcastRef = useRef<Record<DeckKey, number>>({
    a: 0,
    b: 0,
    c: 0,
    d: 0,
  });

  const lastDeckSnapshotRef = useRef<Record<DeckKey, {
    state: string;
    position: number;
    src: string | null;
    playRate: number;
  }>>({
    a: { state: 'idle', position: 0, src: null, playRate: 1 },
    b: { state: 'idle', position: 0, src: null, playRate: 1 },
    c: { state: 'idle', position: 0, src: null, playRate: 1 },
    d: { state: 'idle', position: 0, src: null, playRate: 1 },
  });

  const viewerVideoRefCallbacks = useMemo(
    () =>
      MIX_DECK_KEYS.reduce((accumulator, key) => {
        accumulator[key] = (element: HTMLVideoElement | null) => {
          registerManagedVideo(`viewer-${key}`, element);
        };
        return accumulator;
      }, {} as Record<DeckKey, (element: HTMLVideoElement | null) => void>),
    [registerManagedVideo],
  );

  const resolveDeckAssetSrc = useCallback(
    (deckKey: DeckKey): string | null => {
      const deck = mixState?.decks?.[deckKey];
      if (!deck || deck.type !== 'video' || !deck.assetId) {
        return null;
      }
      const asset =
        assets.videos.find((item) => item.id === deck.assetId) ??
        assets.overlays?.find((item) => item.id === deck.assetId);
      if (asset && 'url' in asset && typeof asset.url === 'string') {
        return asset.url;
      }
      return null;
    },
    [assets.overlays, assets.videos, mixState?.decks],
  );

  const handleUserTap = useCallback(() => {
    setRequiresUserTap(false);
    MIX_DECK_KEYS.forEach((deckKey) => {
      playManagedVideo(`viewer-${deckKey}`);
    });
  }, [playManagedVideo]);

  const handleUserTapKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleUserTap();
      }
    },
    [handleUserTap],
  );

  rtcSignalHandlersRef.current = {
    handleRemoteAnswer,
    addRemoteIceCandidate,
  };

  useEffect(() => {
    const unsubscribes = MIX_DECK_KEYS.map((deckKey) => {
      const managerKey = `viewer-${deckKey}`;
      return addManagedEventListener(managerKey, (mediaState, details) => {
        const managerSnapshot = getManagedState(managerKey);
        const durationDetail =
          typeof details?.duration === 'number' && Number.isFinite(details.duration)
            ? details.duration
            : undefined;
        if (durationDetail && durationDetail > 0) {
          deckDurationsRef.current[deckKey] = durationDetail;
        }

        const durationSeconds =
          durationDetail ?? deckDurationsRef.current[deckKey] ?? null;
        const progressPercent =
          typeof details?.progress === 'number' && Number.isFinite(details.progress)
            ? Math.max(0, Math.min(100, details.progress))
            : typeof managerSnapshot.progress === 'number'
              ? Math.max(0, Math.min(100, managerSnapshot.progress))
              : 0;
        const currentTimeSeconds =
          typeof details?.currentTime === 'number' && Number.isFinite(details.currentTime)
            ? Math.max(0, details.currentTime)
            : durationSeconds && durationSeconds > 0
              ? (progressPercent / 100) * durationSeconds
              : 0;

        const now = performance.now();
        const lastSnapshot = lastDeckSnapshotRef.current[deckKey];
        const didStateChange = lastSnapshot.state !== mediaState;
        const elapsedSinceBroadcast = now - lastDeckBroadcastRef.current[deckKey];
        const throttleInterval = 250;

        const effectiveSrc = managerSnapshot.src ?? resolveDeckAssetSrc(deckKey);
        const effectiveRate = Number.isFinite(managerSnapshot.playbackRate)
          ? managerSnapshot.playbackRate
          : 1;

        if (mediaState === 'playing') {
          setRequiresUserTap(false);
        } else if (mediaState === 'paused' || mediaState === 'error') {
          const rawError =
            (details && (details as Record<string, unknown>).error) ??
            (details && (details as Record<string, unknown>).videoError) ??
            null;
          const errorName =
            rawError && typeof rawError === 'object' && 'name' in rawError
              ? String((rawError as { name?: unknown }).name ?? '')
              : '';
          const isAutoplayBlock =
            typeof errorName === 'string' && errorName.toLowerCase().includes('notallowed');
          if (isAutoplayBlock || mediaState === 'error') {
            setRequiresUserTap(true);
          }
        }

        const shouldBroadcast =
          didStateChange ||
          elapsedSinceBroadcast >= throttleInterval ||
          Math.abs(lastSnapshot.position - currentTimeSeconds) > 0.25 ||
          lastSnapshot.src !== effectiveSrc ||
          Math.abs(lastSnapshot.playRate - effectiveRate) > 0.01;

        if (!shouldBroadcast) {
          return;
        }

        const payload: DeckMediaStateIntent = {
          intent: 'state',
          value: {
            isPlaying: mediaState === 'playing',
            basePosition: currentTimeSeconds,
            position: currentTimeSeconds,
            playRate: effectiveRate,
            src: effectiveSrc ?? null,
            isLoading: mediaState === 'loading',
            error: mediaState === 'error',
          },
        };

        if (durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0) {
          payload.value.duration = durationSeconds;
        }

        requestDeckState(deckKey, payload);
        lastDeckBroadcastRef.current[deckKey] = now;
        lastDeckSnapshotRef.current[deckKey] = {
          state: mediaState,
          position: currentTimeSeconds,
          src: effectiveSrc ?? null,
          playRate: effectiveRate,
        };
      });
    });
    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, [
    addManagedEventListener,
    getManagedState,
    requestDeckState,
    resolveDeckAssetSrc,
  ]);

  useEffect(() => {
    const nowSeconds = Date.now() / 1000;
    MIX_DECK_KEYS.forEach((deckKey) => {
      const managerKey = `viewer-${deckKey}`;
      const state = deckMediaStates?.[deckKey];
      const managerState = getManagedState(managerKey);
      const targetSrc = state?.src ?? resolveDeckAssetSrc(deckKey);

      if (targetSrc) {
        if (managerState.src !== targetSrc) {
          void loadManagedSource(managerKey, targetSrc);
        }
      } else if (managerState.src) {
        void loadManagedSource(managerKey, null);
      }

      if (!state) {
        pauseManagedVideo(managerKey);
        return;
      }

      if (state.duration && Number.isFinite(state.duration) && state.duration > 0) {
        deckDurationsRef.current[deckKey] = state.duration;
      }

      const desiredRate = Number.isFinite(state.playRate) ? state.playRate : 1;
      if (Math.abs((managerState.playbackRate ?? 1) - desiredRate) > 0.01) {
        setManagedPlaybackRate(managerKey, desiredRate);
      }

      const duration =
        deckDurationsRef.current[deckKey] ||
        (state.duration && Number.isFinite(state.duration) ? state.duration : null);
      if (duration && Number.isFinite(duration) && duration > 0) {
        const elapsed = state.isPlaying ? Math.max(0, nowSeconds - state.updatedAt) : 0;
        const basePosition = Number.isFinite(state.basePosition) ? state.basePosition : 0;
        const playRate = Number.isFinite(state.playRate) ? state.playRate : 1;
        const hasExplicitPosition =
          typeof state.position === 'number' && Number.isFinite(state.position);
        const position = hasExplicitPosition
          ? Math.max(0, state.position)
          : basePosition + elapsed * playRate;
        const targetPercent = Math.max(0, Math.min(100, (position / duration) * 100));
        if (
          typeof managerState.progress === 'number' &&
          Math.abs(managerState.progress - targetPercent) > 1.5
        ) {
          seekManagedToPercent(managerKey, targetPercent);
        }
      }

      const shouldPlay = state.isPlaying && Boolean(targetSrc);
      if (shouldPlay) {
        playManagedVideo(managerKey);
      } else if (managerState.state === 'playing' || managerState.pendingPlay) {
        pauseManagedVideo(managerKey);
      }
    });
  }, [
    assets.overlays,
    assets.videos,
    deckMediaStates,
    getManagedState,
    loadManagedSource,
    pauseManagedVideo,
    playManagedVideo,
    resolveDeckAssetSrc,
    seekManagedToPercent,
    setManagedPlaybackRate,
  ]);

  const startStreaming = useCallback(async () => {
    if (isStartingStreamRef.current) {
      return;
    }
    isStartingStreamRef.current = true;
    try {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      if (!rendererRef.current) {
        rendererRef.current = new GLSLRenderer(canvas);
      }
      if (!rendererRef.current) {
        return;
      }
      hasConnectedStreamRef.current = false;
      closeConnection();
      stopCapture();
      const stream = await startCapture(canvas);
      if (!stream) {
        return;
      }
      const offer = await initBroadcaster(stream);
      if (!offer) {
        return;
      }
      sendRTCSignal({
        type: 'rtc-signal',
        rtc: 'offer',
        payload: offer,
      });
    } catch (error) {
      console.error('ViewerPage: failed to start RTC streaming.', error);
    } finally {
      isStartingStreamRef.current = false;
    }
  }, [closeConnection, initBroadcaster, sendRTCSignal, startCapture, stopCapture]);

  startStreamingRef.current = startStreaming;

  const registerFallbackAudioHandler = useCallback(
    (key: string, handler: (data: AudioAnalysis, sensitivity: number) => void) => {
      fallbackAudioHandlersRef.current.set(key, handler);
      return () => {
        fallbackAudioHandlersRef.current.delete(key);
      };
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (glslGeneratorRef.current) {
        glslGeneratorRef.current.destroy();
        glslGeneratorRef.current = null;
      }
      if (rendererRef.current) {
        rendererRef.current.destroy();
        rendererRef.current = null;
      }
      if (audioElementRef.current) {
        audioElementRef.current.pause();
        audioElementRef.current = null;
      }
      if (audioInputRef.current) {
        audioInputRef.current.stop();
        audioInputRef.current = null;
      }
      if (audioUnsubscribeRef.current) {
        audioUnsubscribeRef.current();
        audioUnsubscribeRef.current = null;
      }
      stopCapture();
      closeConnection();
      isStartingStreamRef.current = false;
      hasConnectedStreamRef.current = false;
    };
  }, [closeConnection, stopCapture]);

  useEffect(() => {
    let cancelled = false;

    const attemptStart = () => {
      if (cancelled) {
        return;
      }
      if (!canvasRef.current) {
        requestAnimationFrame(attemptStart);
        return;
      }
      void startStreaming();
    };

    attemptStart();

    return () => {
      cancelled = true;
    };
  }, [startStreaming]);

  useEffect(() => {
    if (rtcConnectionState === 'connected') {
      hasConnectedStreamRef.current = true;
      return;
    }
    if (rtcConnectionState === 'disconnected' && hasConnectedStreamRef.current) {
      void startStreaming();
    }
  }, [rtcConnectionState, startStreaming]);

  useEffect(() => {
    send({
      type: 'viewer-status',
      payload: {
        isRunning,
        isGenerating,
        error,
        audioSensitivity,
      },
    });
  }, [send, isRunning, isGenerating, error, audioSensitivity]);

  const updateAudioSensitivity = useCallback(
    (value: number) => {
      audioSensitivityRef.current = value;
      setAudioSensitivityState(value);
      send({
        type: 'viewer-status',
        payload: { audioSensitivity: value },
      });
    },
    [send],
  );

  setSensitivityRef.current = updateAudioSensitivity;

  const attachAudioInput = useCallback(async () => {
    if (audioInputRef.current) {
      audioInputRef.current.stop();
      audioInputRef.current = null;
    }
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current = null;
    }

    if (audioModeRef.current === 'file') {
      const file = audioFileRef.current;
      if (!file) {
        throw new Error('Viewer: audio file not selected. Please choose a file locally.');
      }

      const audio = new Audio(URL.createObjectURL(file));
      audio.loop = true;
      audioElementRef.current = audio;

      audioInputRef.current = new AudioInput();
      audioInputRef.current.initAudioElement(audio);
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioInputRef.current = new AudioInput();
      audioInputRef.current.initMicrophone(stream);
    }
  }, []);

  const attachGenerator = useCallback((apiKey: string) => {
    if (glslGeneratorRef.current) {
      glslGeneratorRef.current.destroy();
      glslGeneratorRef.current = null;
    }

    glslGeneratorRef.current = new GLSLGenerator({
      apiKey,
      audioFile: audioModeRef.current === 'file' ? audioFileRef.current ?? undefined : undefined,
      prompt: audioModeRef.current === 'microphone' ? promptRef.current : undefined,
      modelProvider: modelProviderRef.current,
      model: modelProviderRef.current === 'openai' ? 'gpt-4o' : 'gemini-2.5-flash',
    });

    glslGeneratorRef.current.subscribeProgress((progress) => {
      setGeneratedCode(progress.code);
      setIsGenerating(!progress.isComplete);
      send({
        type: 'code-progress',
        payload: progress,
      });
    });

    glslGeneratorRef.current.subscribe(async (glslCode) => {
      if (!rendererRef.current) {
        return;
      }

      const success = await rendererRef.current.updateShader(glslCode);

      if (!success) {
        retryCountRef.current += 1;
        if (retryCountRef.current < MAX_RETRIES && glslGeneratorRef.current) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await glslGeneratorRef.current.generateGLSL();
        } else {
          setError(`Shader compilation failed after ${MAX_RETRIES} attempts.`);
          setIsGenerating(false);
          if (glslGeneratorRef.current) {
            await glslGeneratorRef.current.rollbackToPreviousShader();
          }
        }
      } else {
        retryCountRef.current = 0;
        generativeShaderRef.current = glslCode;
        if (audioElementRef.current) {
          audioElementRef.current.play().catch(() => {});
        }
      }
    });
  }, [send]);

  const startVisualization = useCallback(
    async (payload: StartVisualizationPayload) => {
      modelProviderRef.current = payload.modelProvider;
      audioModeRef.current = payload.audioInputMode;
      promptRef.current = payload.prompt || '';

      if (payload.geminiApiKey) {
        geminiApiKeyRef.current = payload.geminiApiKey;
      }
      if (payload.openaiApiKey) {
        openaiApiKeyRef.current = payload.openaiApiKey;
      }

      const activeApiKey =
        modelProviderRef.current === 'gemini' ? geminiApiKeyRef.current : openaiApiKeyRef.current;

      if (!activeApiKey) {
        setError('Missing API key on viewer. Please provide it via the control panel.');
        return;
      }

      if (audioModeRef.current === 'microphone' && !promptRef.current.trim()) {
        setError('Prompt not provided. Please configure it from the control panel.');
        return;
      }

      try {
        setError('');
        await attachAudioInput();

        if (!rendererRef.current) {
          throw new Error('Renderer not initialised.');
        }

        attachGenerator(activeApiKey);

        if (audioInputRef.current) {
          if (audioUnsubscribeRef.current) {
            audioUnsubscribeRef.current();
          }
          audioUnsubscribeRef.current = audioInputRef.current.subscribe((audioData) => {
            if (rendererRef.current) {
              rendererRef.current.updateAudioData(audioData, audioSensitivityRef.current);
            }
            fallbackAudioHandlersRef.current.forEach((handler) =>
              handler(audioData, audioSensitivityRef.current),
            );
          });
        }

        setIsRunning(true);
        await glslGeneratorRef.current?.generateGLSL();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start visualisation.');
      }
    },
    [attachAudioInput, attachGenerator],
  );

  startVisualizationRef.current = startVisualization;

  const stopVisualization = useCallback(() => {
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current = null;
    }

    if (glslGeneratorRef.current) {
      glslGeneratorRef.current.destroy();
      glslGeneratorRef.current = null;
    }

    if (audioInputRef.current) {
      audioInputRef.current.stop();
      audioInputRef.current = null;
    }

    if (audioUnsubscribeRef.current) {
      audioUnsubscribeRef.current();
      audioUnsubscribeRef.current = null;
    }

    setIsRunning(false);
    setIsGenerating(false);
    setError('');
    send({
      type: 'viewer-status',
      payload: {
        isRunning: false,
        isGenerating: false,
        error: '',
      },
    });
  }, [send]);

  stopVisualizationRef.current = stopVisualization;

  const regenerateShader = useCallback(async () => {
    if (glslGeneratorRef.current && !isGenerating) {
      await glslGeneratorRef.current.generateGLSL();
    }
  }, [isGenerating]);

  regenerateShaderRef.current = regenerateShader;

  const toggleFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else if (document.exitFullscreen) {
      await document.exitFullscreen();
    }
  }, []);

  const { outputs: deckOutputs, hasActiveOutput } = computeDeckMix(mixState);

  const renderDeckLayer = (deckKey: DeckKey) => {
    const deck = mixState?.decks?.[deckKey];
    const effectiveOpacity = deckOutputs[deckKey] ?? 0;
    if (!deck || !deck.type || effectiveOpacity <= 0) {
      return null;
    }

    const blendMode = deckKey === 'b' || deckKey === 'd' ? 'add' : 'screen';

    if (deck.type === 'generative') {
      if (!generativeShaderRef.current) return null;
      return (
        <ShaderFallbackLayer
          key={`deck-${deckKey}-generative`}
          layerKey={`mix-deck-${deckKey}`}
          shaderCode={generativeShaderRef.current}
          opacity={effectiveOpacity}
          blendMode={blendMode}
          registerAudioHandler={registerFallbackAudioHandler}
        />
      );
    }

    if (deck.type === 'shader' && deck.assetId) {
      const shader = assets.glsl.find((item) => item.id === deck.assetId);
      if (!shader) return null;
      return (
        <ShaderFallbackLayer
          key={`deck-${deckKey}-${deck.assetId}`}
          layerKey={`mix-deck-${deckKey}`}
          shaderCode={shader.code}
          opacity={effectiveOpacity}
          blendMode={blendMode}
          registerAudioHandler={registerFallbackAudioHandler}
        />
      );
    }

    if (deck.type === 'video' && deck.assetId) {
      const video = assets.videos.find((item) => item.id === deck.assetId);
      if (!video) return null;
      return (
        <VideoFallbackLayer
          key={`deck-${deckKey}-${deck.assetId}`}
          id={`mix-video-${deckKey}`}
          src={video.url}
          opacity={effectiveOpacity}
          blendMode={blendMode}
          mediaState={deckMediaStates?.[deckKey]}
          registerVideo={viewerVideoRefCallbacks[deckKey]}
        />
      );
    }

    return null;
  };
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        toggleFullscreen().catch(() => {});
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleFullscreen]);

  return (
    <div className="app viewer-app">
      <canvas
        ref={canvasRef}
        className="glsl-canvas"
        style={{ opacity: hasActiveOutput ? 0 : 1, pointerEvents: hasActiveOutput ? 'none' : 'auto' }}
        aria-hidden={hasActiveOutput}
      />
      <CodeEditor code={generatedCode} isVisible={isGenerating} />
      <div className="mix-layer-stack">
        {MIX_DECK_KEYS.map((key) => renderDeckLayer(key))}
      </div>
      {requiresUserTap ? (
        <div
          className="viewer-autoplay-overlay"
          role="button"
          tabIndex={0}
          onClick={handleUserTap}
          onKeyDown={handleUserTapKeyDown}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.65)',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              maxWidth: '28rem',
              textAlign: 'center',
              padding: '1.5rem',
              lineHeight: 1.5,
            }}
          >
            <strong>Click to start playback</strong>
            <p style={{ marginTop: '0.5rem' }}>
              The browser blocked autoplay on the viewer. Click or press Enter to resume all decks.
            </p>
          </div>
        </div>
      ) : null}

    </div>
  );
};

export default ViewerPage;
