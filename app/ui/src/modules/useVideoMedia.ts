import { useCallback, useEffect, useRef } from 'react';
import { VideoMediaManager } from './VideoMediaManager';

type RegisterOptions = {
  primary?: boolean;
};

const parseVideoKey = (key: string): { deckKey: string; surfaceKey: string } => {
  if (!key.includes('-')) {
    return { deckKey: key, surfaceKey: 'primary' };
  }
  const parts = key.split('-');
  const deckKey = parts[parts.length - 1];
  const surfaceKey = parts.slice(0, parts.length - 1).join('-') || 'primary';
  return { deckKey, surfaceKey };
};

export function useVideoMedia() {
  const managersRef = useRef<Record<string, VideoMediaManager>>({});

  useEffect(() => {
    return () => {
      Object.values(managersRef.current).forEach((manager) => {
        manager.dispose();
      });
      managersRef.current = {};
    };
  }, []);

  const getManager = useCallback((deckKey: string) => {
    if (!managersRef.current[deckKey]) {
      managersRef.current[deckKey] = new VideoMediaManager();
    }
    return managersRef.current[deckKey];
  }, []);

  const registerContainer = useCallback(
    (key: string, element: HTMLDivElement | null, options?: RegisterOptions) => {
      const { deckKey, surfaceKey } = parseVideoKey(key);
      const manager = getManager(deckKey);
      manager.registerSurface(surfaceKey, element, options);
    },
    [getManager],
  );

  const loadSource = useCallback(
    (key: string, src: string | null): Promise<boolean> => {
      const { deckKey } = parseVideoKey(key);
      const manager = getManager(deckKey);
      return manager.loadSource(src);
    },
    [getManager],
  );

  const prepare = useCallback(
    (key: string, source: string | MediaStream) => {
      const { deckKey } = parseVideoKey(key);
      const manager = getManager(deckKey);
      return manager.prepare(source);
    },
    [getManager],
  );

  const play = useCallback(
    (key: string) => {
      const { deckKey } = parseVideoKey(key);
      const manager = getManager(deckKey);
      return manager.play();
    },
    [getManager],
  );

  const pause = useCallback(
    (key: string) => {
      const { deckKey } = parseVideoKey(key);
      const manager = getManager(deckKey);
      manager.pause();
    },
    [getManager],
  );

  const seekToPercent = useCallback(
    (key: string, percent: number) => {
      const { deckKey } = parseVideoKey(key);
      const manager = getManager(deckKey);
      manager.seekToPercent(percent);
    },
    [getManager],
  );

  const setPlaybackRate = useCallback(
    (key: string, rate: number) => {
      const { deckKey } = parseVideoKey(key);
      const manager = getManager(deckKey);
      return manager.setPlaybackRate(rate);
    },
    [getManager],
  );

  const addEventListener = useCallback(
    (key: string, callback: (state: string, details?: Record<string, unknown>) => void) => {
      const { deckKey } = parseVideoKey(key);
      const manager = getManager(deckKey);
      manager.addEventListener(callback);

      return () => {
        manager.removeEventListener(callback);
      };
    },
    [getManager],
  );

  const getState = useCallback(
    (key: string) => {
      const { deckKey } = parseVideoKey(key);
      const manager = getManager(deckKey);
      return manager.getState();
    },
    [getManager],
  );

  return {
    registerContainer,
    loadSource,
    prepare,
    play,
    pause,
    seekToPercent,
    setPlaybackRate,
    addEventListener,
    getState,
  };
}
