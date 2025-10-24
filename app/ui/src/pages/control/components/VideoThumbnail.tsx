import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from 'react';

type ThumbnailStatus = 'loading' | 'ready' | 'error' | 'playing';

const computePreviewTimestamp = (video: HTMLVideoElement) => {
  const duration = Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0;
  if (duration === 0) {
    return 0;
  }
  const candidate = Math.min(Math.max(duration * 0.1, 0.2), Math.max(duration - 0.2, 0.2));
  return Number.isFinite(candidate) ? candidate : Math.min(duration * 0.1, duration);
};

const seekToPreviewFrame = (video: HTMLVideoElement) => {
  const targetTime = computePreviewTimestamp(video);
  if (Math.abs(video.currentTime - targetTime) < 0.01) {
    return 'noop' as const;
  }
  try {
    video.currentTime = targetTime;
    return 'set' as const;
  } catch {
    return 'error' as const;
  }
};

const markVideoThumbnailLoading = (video: HTMLVideoElement) => {
  video.dataset.previewReady = 'loading';
  video.dataset.thumbnailStatus = 'loading';
};

const markVideoThumbnailReady = (video: HTMLVideoElement) => {
  video.dataset.previewReady = 'true';
  video.dataset.thumbnailStatus = 'ready';
  try {
    video.pause();
  } catch {
    // ignore pause failures
  }
};

const markVideoThumbnailPlaying = (video: HTMLVideoElement) => {
  video.dataset.previewReady = 'true';
  video.dataset.thumbnailStatus = 'playing';
};

const markVideoThumbnailError = (video: HTMLVideoElement) => {
  video.dataset.previewReady = 'error';
  video.dataset.thumbnailStatus = 'error';
  try {
    video.pause();
  } catch {
    // ignore pause failures
  }
};

export type VideoThumbnailProps = {
  src: string;
  alt?: string;
  className?: string;
};

export const VideoThumbnail = ({ src, alt, className }: VideoThumbnailProps) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<ThumbnailStatus>('loading');

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setStatus('loading');
    markVideoThumbnailLoading(video);
    try {
      video.currentTime = 0;
      video.pause();
    } catch {
      // ignore reset failures
    }
    video.load();
  }, [src]);

  const markReady = useCallback((video: HTMLVideoElement) => {
    markVideoThumbnailReady(video);
    setStatus('ready');
  }, []);

  const handleLoadStart = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    markVideoThumbnailLoading(video);
    setStatus('loading');
  }, []);

  const handleLoadedMetadata = useCallback(
    (event: SyntheticEvent<HTMLVideoElement>) => {
      const video = event.currentTarget;
      const result = seekToPreviewFrame(video);
      if (result === 'noop') {
        markReady(video);
      } else if (result === 'set') {
        video
          .play()
          .catch(() => {
            markReady(video);
          });
      } else {
        video
          .play()
          .catch(() => {
            markReady(video);
          });
      }
    },
    [markReady],
  );

  const handleCanPlay = useCallback(
    (event: SyntheticEvent<HTMLVideoElement>) => {
      const video = event.currentTarget;
      if (video.dataset.previewReady === 'true') {
        return;
      }
      const result = seekToPreviewFrame(video);
      if (result === 'noop' || result === 'error') {
        markReady(video);
      }
    },
    [markReady],
  );

  const handleSeeked = useCallback(
    (event: SyntheticEvent<HTMLVideoElement>) => {
      const video = event.currentTarget;
      markReady(video);
    },
    [markReady],
  );

  const handleError = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    markVideoThumbnailError(video);
    setStatus('error');
  }, []);

  return (
    <>
      <video
        key={src}
        ref={videoRef}
        src={src}
        muted
        loop
        playsInline
        preload="metadata"
        className={className}
        data-thumbnail-status={status}
        aria-label={alt}
        onLoadStart={handleLoadStart}
        onLoadedMetadata={handleLoadedMetadata}
        onCanPlay={handleCanPlay}
        onSeeked={handleSeeked}
        onError={handleError}
        onMouseEnter={(event) => {
          const video = event.currentTarget;
          if (video.dataset.previewReady !== 'true') {
            return;
          }
          markVideoThumbnailPlaying(video);
          setStatus('playing');
          const playPromise = video.play();
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(() => {
              markVideoThumbnailReady(video);
              setStatus('ready');
            });
          }
        }}
        onMouseLeave={(event) => {
          const video = event.currentTarget;
          video.pause();
          const result = seekToPreviewFrame(video);
          if (result === 'noop' || result === 'error') {
            markVideoThumbnailReady(video);
            setStatus('ready');
          } else {
            setStatus('ready');
          }
        }}
        onFocus={(event) => {
          const video = event.currentTarget;
          if (video.dataset.previewReady !== 'true') {
            return;
          }
          markVideoThumbnailPlaying(video);
          setStatus('playing');
          const playPromise = video.play();
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(() => {
              markVideoThumbnailReady(video);
              setStatus('ready');
            });
          }
        }}
        onBlur={(event) => {
          const video = event.currentTarget;
          video.pause();
          const result = seekToPreviewFrame(video);
          if (result === 'noop' || result === 'error') {
            markVideoThumbnailReady(video);
            setStatus('ready');
          }
        }}
      />
      {status === 'loading' && <div className="content-browser-thumbnail-loading" aria-hidden="true" />}
      {status === 'error' && (
        <div className="content-browser-thumbnail-fallback" aria-hidden="true">
          {alt ? <span className="content-browser-thumbnail-fallback-label">{alt}</span> : null}
        </div>
      )}
    </>
  );
};

