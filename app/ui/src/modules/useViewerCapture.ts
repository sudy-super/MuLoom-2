import { useCallback, useEffect, useState } from 'react';

interface ViewerCaptureOptions {
  frameRate?: number;
  quality?: number;
}

type CaptureTarget = HTMLElement & {
  captureStream?: (frameRate?: number) => MediaStream;
  mozCaptureStream?: (frameRate?: number) => MediaStream;
  contentHint?: string;
};

type TrackContentHint = 'detail' | 'motion' | 'text';

const getContentHint = (quality: number): TrackContentHint => {
  if (quality >= 0.9) {
    return 'detail';
  }
  if (quality >= 0.6) {
    return 'motion';
  }
  return 'motion';
};

export function useViewerCapture(options: ViewerCaptureOptions = {}) {
  const [captureStream, setCaptureStream] = useState<MediaStream | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  const frameRate = options.frameRate ?? 30;
  const quality = Math.max(0, Math.min(1, options.quality ?? 0.8));

  const stopCapture = useCallback(() => {
    setIsCapturing(false);
    setCaptureStream((previous) => {
      if (previous) {
        previous.getTracks().forEach((track) => track.stop());
      }
      return null;
    });
  }, []);

  const startCapture = useCallback(
    async (targetElement: HTMLElement) => {
      if (!targetElement) {
        console.error('useViewerCapture: target element not provided.');
        return null;
      }

      const element = targetElement as CaptureTarget;
      const captureFn = typeof element.captureStream === 'function'
        ? element.captureStream.bind(element)
        : typeof element.mozCaptureStream === 'function'
          ? element.mozCaptureStream.bind(element)
          : null;

      if (!captureFn) {
        console.error('useViewerCapture: captureStream API is not supported on the provided element.');
        return null;
      }

      try {
        const stream = captureFn(frameRate);
        if (!stream) {
          throw new Error('Stream capture returned null or undefined.');
        }

        const videoTracks = stream.getVideoTracks();
        await Promise.all(
          videoTracks.map((track) => {
            const constraints: MediaTrackConstraints = {
              frameRate: { ideal: frameRate },
            };
            return track.applyConstraints(constraints).catch(() => undefined);
          }),
        );

        const contentHint = getContentHint(quality);
        videoTracks.forEach((track) => {
          if ('contentHint' in track && contentHint) {
            try {
              (track as MediaStreamTrack & { contentHint?: TrackContentHint }).contentHint = contentHint;
            } catch {
              // Ignore if browser rejects the assignment.
            }
          }
        });

        setCaptureStream(stream);
        setIsCapturing(true);
        return stream;
      } catch (error) {
        console.error('useViewerCapture: failed to capture viewer output.', error);
        stopCapture();
        return null;
      }
    },
    [frameRate, quality, stopCapture],
  );

  useEffect(
    () => () => {
      stopCapture();
    },
    [stopCapture],
  );

  return {
    captureStream,
    isCapturing,
    startCapture,
    stopCapture,
  };
}
