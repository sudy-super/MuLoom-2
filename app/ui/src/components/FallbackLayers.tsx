import { useCallback, useEffect, useRef } from 'react';
import GlslCanvas from 'glslCanvas';
import type { AudioAnalysis } from '../modules/AudioInput';
import type { CSSProperties } from 'react';
import type { DeckTimelineState } from '../types/realtime';

type BlendMode = 'normal' | 'screen' | 'add' | 'multiply' | 'overlay';

const blendModeMap: Record<BlendMode, CSSProperties['mixBlendMode'] | undefined> = {
  normal: undefined,
  screen: 'screen',
  add: 'plus-lighter',
  multiply: 'multiply',
  overlay: 'overlay',
};

interface VideoLayerProps {
  id: string;
  src: string;
  opacity: number;
  blendMode?: BlendMode;
  mediaState?: DeckTimelineState;
  registerContainer?: (element: HTMLDivElement | null) => void;
}

export function VideoFallbackLayer({
  id,
  src,
  opacity,
  blendMode,
  mediaState,
  registerContainer,
}: VideoLayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleVideoRef = useCallback(
    (element: HTMLDivElement | null) => {
      containerRef.current = element;
      registerContainer?.(element);
    },
    [registerContainer],
  );
  const mixBlend =
    blendMode && (blendModeMap[blendMode] ?? (blendMode as CSSProperties['mixBlendMode']));
  const resolvedSrc = mediaState?.src ?? src;
  const shouldPlay = opacity > 0.001 && (mediaState ? mediaState.isPlaying : true);

  useEffect(() => {
    const container = containerRef.current;
    const video = container?.querySelector('video') ?? null;
    if (!video) {
      return;
    }

    const attemptPlay = () => {
      try {
        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {
            // Ignore autoplay errors; the layer will retry on next opacity change.
          });
        }
      } catch {
        // Ignore synchronous play errors triggered by autoplay policies.
      }
    };

    const handleCanPlay = () => {
      video.removeEventListener('canplay', handleCanPlay);
      attemptPlay();
    };

    if (shouldPlay) {
      if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        attemptPlay();
      } else {
        video.addEventListener('canplay', handleCanPlay);
      }
    } else {
      video.pause();
    }

    return () => {
      video.removeEventListener('canplay', handleCanPlay);
    };
  }, [resolvedSrc, shouldPlay]);

  useEffect(() => {
    const container = containerRef.current;
    const video = container?.querySelector('video') ?? null;
    if (!video || !mediaState) {
      return;
    }

    if (!mediaState.isPlaying || !shouldPlay) {
      try {
        video.pause();
      } catch {
        // ignore pause failures
      }
    }
  }, [mediaState, shouldPlay]);

  useEffect(() => {
    const container = containerRef.current;
    const video = container?.querySelector('video') ?? null;
    if (!video || !mediaState) {
      return;
    }

    const nowSeconds = Date.now() / 1000;
    const basePosition = Number.isFinite(mediaState.basePosition)
      ? mediaState.basePosition
      : 0;
    const playRate = Number.isFinite(mediaState.playRate) ? mediaState.playRate : 1;
    const updatedAt = Number.isFinite(mediaState.updatedAt) ? mediaState.updatedAt : nowSeconds;
    const elapsed = mediaState.isPlaying ? Math.max(0, nowSeconds - updatedAt) : 0;
    const fallbackPosition = Number.isFinite(mediaState.position) ? mediaState.position : 0;
    const targetSeconds = mediaState.isPlaying
      ? Math.max(0, basePosition + elapsed * playRate)
      : Math.max(0, fallbackPosition);

    const syncCurrentTime = () => {
      const duration = video.duration;
      if (Number.isFinite(duration) && duration > 0) {
        const clampedTarget = Math.min(targetSeconds, duration);
        const tolerance = Math.max(0.2, duration * 0.02);
        if (Math.abs(video.currentTime - clampedTarget) > tolerance) {
          try {
            video.currentTime = clampedTarget;
          } catch {
            // ignore seek errors
          }
        }
      } else {
        try {
          video.currentTime = targetSeconds;
        } catch {
          // ignore seek errors
        }
      }
    };

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      syncCurrentTime();
      return;
    }

    const handleLoadedMetadata = () => {
      syncCurrentTime();
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
    };
  }, [mediaState, resolvedSrc]);

  useEffect(() => {
    const container = containerRef.current;
    const video = container?.querySelector('video') ?? null;
    if (!video || !mediaState) {
      return;
    }

    const desiredRate = Number.isFinite(mediaState.playRate) ? mediaState.playRate : 1;
    if (Math.abs(video.playbackRate - desiredRate) > 0.01) {
      try {
        video.playbackRate = desiredRate;
      } catch {
        // ignore playback rate errors
      }
    }
  }, [mediaState, resolvedSrc]);

  return (
    <div
      ref={handleVideoRef}
      className="fallback-layer"
      id={id}
      data-video-src={resolvedSrc}
      style={{
        opacity,
        mixBlendMode: mixBlend,
      }}
    />
  );
}

interface ShaderLayerProps {
  layerKey: string;
  shaderCode: string;
  opacity: number;
  blendMode?: BlendMode;
  registerAudioHandler: (
    key: string,
    handler: (data: AudioAnalysis, sensitivity: number) => void,
  ) => () => void;
}

function ensurePrecision(code: string): string {
  if (code.includes('precision')) {
    return code;
  }
  return `#ifdef GL_ES
precision mediump float;
#endif

${code}`;
}

function getFrequencyBandEnergy(frequencyData: Uint8Array, startRatio: number, endRatio: number) {
  const start = Math.floor(frequencyData.length * startRatio);
  const end = Math.floor(frequencyData.length * endRatio);
  if (end <= start) return 0;

  let sum = 0;
  for (let i = start; i < end; i += 1) {
    sum += frequencyData[i];
  }
  return (sum / (end - start)) / 255;
}

export function ShaderFallbackLayer({
  layerKey,
  shaderCode,
  opacity,
  blendMode,
  registerAudioHandler,
}: ShaderLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sandboxRef = useRef<GlslCanvas | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    resize();
    window.addEventListener('resize', resize);

    const sandbox = new GlslCanvas(canvas);
    sandboxRef.current = sandbox;
    sandbox.load(ensurePrecision(shaderCode));

    let unregister = () => {};
    unregister = registerAudioHandler(layerKey, (audioData, sensitivity) => {
      const clamp = (value: number) => Math.min(1.0, Math.max(0.0, value * sensitivity));
      try {
        sandboxRef.current?.setUniform('u_volume', clamp(audioData.volume));
        sandboxRef.current?.setUniform(
          'u_bass',
          clamp(getFrequencyBandEnergy(audioData.frequencyData, 0, 0.1)),
        );
        sandboxRef.current?.setUniform(
          'u_mid',
          clamp(getFrequencyBandEnergy(audioData.frequencyData, 0.1, 0.5)),
        );
        sandboxRef.current?.setUniform(
          'u_high',
          clamp(getFrequencyBandEnergy(audioData.frequencyData, 0.5, 1.0)),
        );

        const spectrum = Array.from(audioData.frequencyData.slice(0, 32)).map((value) =>
          clamp(value / 255),
        );
        sandboxRef.current?.setUniform('u_spectrum', spectrum);
      } catch (err) {
        console.error('Failed to update fallback shader uniforms:', err);
      }
    });

    return () => {
      unregister();
      sandbox.destroy();
      sandboxRef.current = null;
      window.removeEventListener('resize', resize);
    };
  }, [layerKey, shaderCode, registerAudioHandler]);

  useEffect(() => {
    if (!sandboxRef.current) return;
    try {
      sandboxRef.current.load(ensurePrecision(shaderCode));
    } catch (err) {
      console.error('Failed to load fallback shader:', err);
    }
  }, [shaderCode]);

  return (
    <canvas
      ref={canvasRef}
      className="fallback-layer"
      style={{
        opacity,
        mixBlendMode:
          blendMode && (blendModeMap[blendMode] ?? (blendMode as CSSProperties['mixBlendMode'])),
      }}
    />
  );
}
