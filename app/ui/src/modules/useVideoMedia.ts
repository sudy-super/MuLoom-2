import { useCallback, useEffect, useRef } from 'react';
import { VideoMediaManager } from './VideoMediaManager';

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

  const getManager = useCallback((key: string) => {
    if (!managersRef.current[key]) {
      managersRef.current[key] = new VideoMediaManager();
    }
    return managersRef.current[key];
  }, []);

  const registerVideo = useCallback(
    (key: string, element: HTMLVideoElement | null) => {
      const manager = getManager(key);
      manager.registerVideoElement(element);
    },
    [getManager],
  );

  const loadSource = useCallback(
    (key: string, src: string | null): Promise<boolean> => {
      const manager = getManager(key);
      return manager.loadSource(src);
    },
    [getManager],
  );

  const play = useCallback(
    (key: string) => {
      const manager = getManager(key);
      return manager.play();
    },
    [getManager],
  );

  const pause = useCallback(
    (key: string) => {
      const manager = getManager(key);
      manager.pause();
    },
    [getManager],
  );

  const seekToPercent = useCallback(
    (key: string, percent: number) => {
      const manager = getManager(key);
      manager.seekToPercent(percent);
    },
    [getManager],
  );

  const setPlaybackRate = useCallback(
    (key: string, rate: number) => {
      const manager = getManager(key);
      return manager.setPlaybackRate(rate);
    },
    [getManager],
  );

  const addEventListener = useCallback(
    (key: string, callback: (state: string, details?: Record<string, unknown>) => void) => {
      const manager = getManager(key);
      manager.addEventListener(callback);

      return () => {
        manager.removeEventListener(callback);
      };
    },
    [getManager],
  );

  const getState = useCallback(
    (key: string) => {
      const manager = getManager(key);
      return manager.getState();
    },
    [getManager],
  );

  return {
    registerVideo,
    loadSource,
    play,
    pause,
    seekToPercent,
    setPlaybackRate,
    addEventListener,
    getState,
  };
}
