type VideoState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'error';
type VideoEventCallback = (state: VideoState, details?: Record<string, unknown>) => void;

/**
 * Encapsulates lifecycle management for a single `HTMLVideoElement`.
 * Handles source loading, playback retries, rate management and state notifications.
 */
export class VideoMediaManager {
  private videoElement: HTMLVideoElement | null = null;
  private currentSrc: string | null = null;
  private state: VideoState = 'idle';
  private eventListeners: Set<VideoEventCallback> = new Set();
  private playbackRate = 1.0;
  private pendingPlay = false;
  private currentProgress = 0;
  private playAttempts = 0;
  private loadToken = 0;

  registerVideoElement(element: HTMLVideoElement | null) {
    if (this.videoElement === element) {
      return;
    }

    if (this.videoElement) {
      this.cleanupVideoElement(this.videoElement);
    }

    this.videoElement = element;

    if (!element) {
      this.loadToken += 1;
      return;
    }

    this.loadToken += 1;
    this.setupVideoElement(element);

    if (this.currentSrc) {
      void this.loadSource(this.currentSrc);
    }
  }

  async loadSource(src: string | null): Promise<boolean> {
    const token = ++this.loadToken;

    if (!src) {
      await this.cleanupCurrentSource({ resetState: true });
      return true;
    }

    const shouldForceReload =
      this.videoElement != null &&
      this.videoElement.getAttribute('src') !== src &&
      this.videoElement.src !== src;

    if (
      this.currentSrc === src &&
      this.state !== 'idle' &&
      this.state !== 'error' &&
      !shouldForceReload &&
      (this.videoElement?.readyState ?? 0) > 0
    ) {
      return true;
    }

    await this.cleanupCurrentSource();

    if (token !== this.loadToken) {
      return false;
    }

    this.currentSrc = src;
    this.currentProgress = 0;
    this.setState('loading');
    this.playAttempts = 0;

    if (!this.videoElement) {
      return false;
    }

    try {
      await this.loadVideoSourceAsync(src, token);
      return true;
    } catch (error) {
      if (token === this.loadToken) {
        this.pendingPlay = false;
        const loadError = error instanceof Error ? error : new Error(String(error));
        this.setState('error', { videoError: loadError });
      }
      return false;
    }
  }

  private cleanupCurrentSource(options: { resetState?: boolean } = {}): Promise<void> {
    const { resetState = false } = options;
    const video = this.videoElement;

    if (resetState) {
      this.pendingPlay = false;
      this.currentProgress = 0;
      this.playAttempts = 0;
    }

    this.currentSrc = null;

    if (!video) {
      if (resetState && this.state !== 'idle') {
        this.setState('idle');
      }
      return Promise.resolve();
    }

    try {
      video.pause();
    } catch {
      // ignore pause errors
    }

    try {
      video.removeAttribute('src');
    } catch {
      // ignore attribute removal errors
    }

    try {
      video.load();
    } catch {
      // ignore load errors
    }

    if (resetState && this.state !== 'idle') {
      this.setState('idle');
    }

    return new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  private loadVideoSourceAsync(src: string, token: number): Promise<void> {
    const video = this.videoElement;

    if (!video) {
      return Promise.reject(new Error('No video element available'));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        video.removeEventListener('loadeddata', handleLoadedData);
        video.removeEventListener('error', handleError);
        clearTimeout(timeoutId);
      };

      const resolveSafely = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };

      const rejectSafely = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const handleLoadedData = () => {
        if (token !== this.loadToken) {
          resolveSafely();
          return;
        }
        resolveSafely();
      };

      const handleError = () => {
        const videoError = video.error ?? new Error('Unknown video error');
        if (token !== this.loadToken) {
          resolveSafely();
          return;
        }
        const error = videoError instanceof Error ? videoError : new Error(String(videoError));
        rejectSafely(error);
      };

      video.addEventListener('loadeddata', handleLoadedData, { once: true });
      video.addEventListener('error', handleError, { once: true });

      timeoutId = setTimeout(() => {
        if (token !== this.loadToken) {
          resolveSafely();
          return;
        }
        rejectSafely(new Error('Timed out while loading video source'));
      }, 10000);

      try {
        video.src = src;
        video.load();

        if (this.playbackRate !== 1.0) {
          this.applyPlaybackRate(this.playbackRate);
        }

        if (video.readyState >= 2) {
          handleLoadedData();
        }
      } catch (error) {
        const loadError = error instanceof Error ? error : new Error(String(error));
        rejectSafely(loadError);
      }
    });
  }

  play() {
    this.pendingPlay = true;

    if (!this.videoElement || !this.currentSrc) {
      return false;
    }

    if (this.state === 'loading') {
      return true;
    }

    if (this.playbackRate <= 0.0001) {
      this.pendingPlay = false;
      this.setState('paused');
      return false;
    }

    this.attemptPlayback();
    return true;
  }

  pause() {
    this.pendingPlay = false;

    if (!this.videoElement) {
      return;
    }

    try {
      this.videoElement.pause();
      this.setState('paused');
    } catch {
      // ignore pause errors
    }
  }

  setPlaybackRate(rate: number) {
    const clampedRate = Math.max(0, Math.min(4, rate));
    this.playbackRate = clampedRate;
    this.applyPlaybackRate(clampedRate);

    if (clampedRate <= 0.0001 && this.state === 'playing') {
      this.pause();
    } else if (this.pendingPlay && this.state === 'paused') {
      this.play();
    }

    return clampedRate;
  }

  seekToPercent(percent: number) {
    if (!this.videoElement) {
      return;
    }

    const duration = this.videoElement.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }

    const clampedPercent = Math.max(0, Math.min(100, percent));
    const targetTime = (clampedPercent / 100) * duration;

    try {
      this.videoElement.currentTime = targetTime;
      this.currentProgress = clampedPercent;
    } catch {
      // ignore seek errors
    }
  }

  addEventListener(callback: VideoEventCallback) {
    this.eventListeners.add(callback);
    callback(this.state, {
      progress: this.currentProgress,
      src: this.currentSrc,
      playbackRate: this.playbackRate,
    });
  }

  removeEventListener(callback: VideoEventCallback) {
    this.eventListeners.delete(callback);
  }

  dispose() {
    this.loadToken += 1;

    if (this.videoElement) {
      this.cleanupVideoElement(this.videoElement);
    }
    this.videoElement = null;
    this.currentSrc = null;
    this.state = 'idle';
    this.eventListeners.clear();
    this.pendingPlay = false;
  }

  getState() {
    return {
      state: this.state,
      src: this.currentSrc,
      progress: this.currentProgress,
      playbackRate: this.playbackRate,
      pendingPlay: this.pendingPlay,
    };
  }

  private setState(state: VideoState, details?: Record<string, unknown>) {
    if (this.state === state) {
      return;
    }

    this.state = state;
    const fullDetails = {
      ...details,
      progress: this.currentProgress,
      src: this.currentSrc,
      playbackRate: this.playbackRate,
    };

    this.eventListeners.forEach((listener) => {
      try {
        listener(state, fullDetails);
      } catch (error) {
        console.error('Video event listener error', error);
      }
    });
  }

  private attemptPlayback() {
    if (!this.videoElement || this.state === 'playing') {
      return;
    }

    this.playAttempts += 1;

    try {
      const playPromise = this.videoElement.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => {
            this.setState('playing');
            this.playAttempts = 0;
          })
          .catch((error) => {
            console.warn('Video play attempt failed', error);
            if (this.pendingPlay && this.playAttempts <= 5) {
              setTimeout(() => {
                if (this.pendingPlay) {
                  this.attemptPlayback();
                }
              }, 200 * this.playAttempts);
            } else {
              this.pendingPlay = false;
              this.setState('paused', { error });
            }
          });
      } else {
        this.setState('playing');
      }
    } catch (error) {
      console.warn('Video play attempt error', error);
      this.setState('paused', { error });
    }
  }

  private setupVideoElement(element: HTMLVideoElement) {
    element.muted = true;
    element.loop = true;
    element.playsInline = true;
    element.preload = 'auto';

    element.addEventListener('loadedmetadata', this.handleLoadedMetadata);
    element.addEventListener('loadeddata', this.handleLoadedData);
    element.addEventListener('canplay', this.handleCanPlay);
    element.addEventListener('play', this.handlePlay);
    element.addEventListener('pause', this.handlePause);
    element.addEventListener('timeupdate', this.handleTimeUpdate);
    element.addEventListener('waiting', this.handleWaiting);
    element.addEventListener('stalled', this.handleWaiting);
    element.addEventListener('error', this.handleError);
    element.addEventListener('ended', this.handleEnded);
  }

  private cleanupVideoElement(element: HTMLVideoElement) {
    element.removeEventListener('loadedmetadata', this.handleLoadedMetadata);
    element.removeEventListener('loadeddata', this.handleLoadedData);
    element.removeEventListener('canplay', this.handleCanPlay);
    element.removeEventListener('play', this.handlePlay);
    element.removeEventListener('pause', this.handlePause);
    element.removeEventListener('timeupdate', this.handleTimeUpdate);
    element.removeEventListener('waiting', this.handleWaiting);
    element.removeEventListener('stalled', this.handleWaiting);
    element.removeEventListener('error', this.handleError);
    element.removeEventListener('ended', this.handleEnded);

    try {
      element.pause();
      element.removeAttribute('src');
      element.load();
    } catch {
      // ignore cleanup errors
    }
  }

  private applyPlaybackRate(rate: number) {
    if (!this.videoElement) {
      return;
    }

    try {
      this.videoElement.playbackRate = rate <= 0.0001 ? 0.0001 : rate;
    } catch {
      // ignore playback rate errors
    }
  }

  private handleLoadedMetadata = (event: Event) => {
    const video = event.target as HTMLVideoElement;
    if (video !== this.videoElement) {
      return;
    }

    if (this.currentProgress > 0) {
      this.seekToPercent(this.currentProgress);
    }
  };

  private handleLoadedData = (event: Event) => {
    const video = event.target as HTMLVideoElement;
    if (video !== this.videoElement) {
      return;
    }

    this.setState('ready');

    if (this.pendingPlay) {
      this.attemptPlayback();
    }
  };

  private handleCanPlay = (event: Event) => {
    const video = event.target as HTMLVideoElement;
    if (video !== this.videoElement) {
      return;
    }

    if (this.state === 'loading') {
      this.setState('ready');
    }

    if (this.pendingPlay && this.state !== 'playing') {
      this.attemptPlayback();
    }
  };

  private handlePlay = (event: Event) => {
    const video = event.target as HTMLVideoElement;
    if (video === this.videoElement) {
      this.setState('playing');
    }
  };

  private handlePause = (event: Event) => {
    const video = event.target as HTMLVideoElement;
    if (video !== this.videoElement) {
      return;
    }

    if (this.pendingPlay && this.state === 'playing') {
      setTimeout(() => {
        if (this.pendingPlay && this.state !== 'playing') {
          this.attemptPlayback();
        }
      }, 100);
      return;
    }

    this.setState('paused');
  };

  private handleTimeUpdate = (event: Event) => {
    const video = event.target as HTMLVideoElement;
    if (video !== this.videoElement) {
      return;
    }

    if (Number.isFinite(video.duration) && video.duration > 0) {
      this.currentProgress = (video.currentTime / video.duration) * 100;
      this.eventListeners.forEach((listener) => {
        try {
          listener(this.state, {
            progress: this.currentProgress,
            currentTime: video.currentTime,
            duration: video.duration,
          });
        } catch (error) {
          console.error('Video event listener error', error);
        }
      });
    }
  };

  private handleWaiting = (event: Event) => {
    const video = event.target as HTMLVideoElement;
    if (video !== this.videoElement) {
      return;
    }

    if (this.pendingPlay && this.state === 'playing') {
      setTimeout(() => {
        if (this.pendingPlay && this.state !== 'playing') {
          this.attemptPlayback();
        }
      }, 100);
    }
  };

  private handleError = (event: Event) => {
    const video = event.target as HTMLVideoElement;
    if (video !== this.videoElement) {
      return;
    }

    const mediaError = video.error;
    let errorMessage = 'Unknown video error';

    if (mediaError) {
      const maybeMessage = (mediaError as MediaError & { message?: string }).message;
      errorMessage =
        typeof maybeMessage === 'string' && maybeMessage.length > 0
          ? maybeMessage
          : `Media error code ${mediaError.code}`;
    }

    console.error('Video error', mediaError);
    this.pendingPlay = false;
    this.setState('error', {
      videoError: mediaError ?? null,
      errorCode: mediaError?.code,
      errorMessage,
    });
  };

  private handleEnded = (event: Event) => {
    const video = event.target as HTMLVideoElement;
    if (video !== this.videoElement) {
      return;
    }

    if (!video.loop) {
      this.pendingPlay = false;
      this.setState('paused');
    }
  };
}
