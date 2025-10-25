type VideoState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'error';
type VideoEventCallback = (state: VideoState, details?: Record<string, unknown>) => void;

type PreparedVideo = {
  video: HTMLVideoElement;
  token: number;
  source: string | MediaStream;
};

/**
 * Manages double-buffered <video> playback inside a container element.
 *
 * Videos are prepared off-DOM, warmed up, then swapped atomically so that
 * visible elements never flicker to black during source changes.
 */
export class VideoMediaManager {
  private container: HTMLDivElement | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private prepared: PreparedVideo | null = null;
  private currentSrc: string | null = null;
  private state: VideoState = 'idle';
  private eventListeners: Set<VideoEventCallback> = new Set();
  private playbackRate = 1.0;
  private pendingPlay = false;
  private currentProgress = 0;
  private playAttempts = 0;
  private loadToken = 0;

  registerContainer(element: HTMLDivElement | null) {
    if (this.container === element) {
      return;
    }

    if (this.container && this.videoElement && this.videoElement.parentElement === this.container) {
      this.container.removeChild(this.videoElement);
    }

    this.container = element;

    if (!element) {
      return;
    }

    element.replaceChildren();

    if (this.videoElement) {
      element.appendChild(this.videoElement);
      return;
    }

    if (this.prepared) {
      const { video, token } = this.prepared;
      this.commitPreparedVideo(video, token);
    }
  }

  async loadSource(src: string | null): Promise<boolean> {
    const token = ++this.loadToken;

    if (!src) {
      await this.cleanupCurrentSource({ resetState: true });
      this.currentSrc = null;
      return true;
    }

    await this.cleanupPreparedVideo();

    this.currentSrc = src;
    this.setState('loading');

    try {
      const preparedVideo = await this.createPreparedVideo(src, token);
      if (token !== this.loadToken) {
        this.disposeVideo(preparedVideo);
        return false;
      }

      this.prepared = { video: preparedVideo, token, source: src };
      if (this.container) {
        this.commitPreparedVideo(preparedVideo, token);
      }
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

  async prepare(source: string | MediaStream): Promise<HTMLVideoElement> {
    return this.createPreparedVideo(source, this.loadToken + 1);
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
    this.pendingPlay = false;

    if (this.prepared) {
      this.disposeVideo(this.prepared.video);
      this.prepared = null;
    }

    if (this.videoElement) {
      this.cleanupVideoElement(this.videoElement);
      this.disposeVideo(this.videoElement);
      this.videoElement = null;
    }

    this.container = null;
    this.currentSrc = null;
    this.state = 'idle';
    this.eventListeners.clear();
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

  private async cleanupCurrentSource(options: { resetState?: boolean } = {}) {
    const { resetState = false } = options;

    if (this.prepared) {
      this.disposeVideo(this.prepared.video);
      this.prepared = null;
    }

    const video = this.videoElement;
    this.videoElement = null;

    if (!video) {
      if (resetState && this.state !== 'idle') {
        this.setState('idle');
      }
      return;
    }

    this.cleanupVideoElement(video);
    if (video.parentElement) {
      video.parentElement.removeChild(video);
    }
    this.disposeVideo(video);

    if (resetState && this.state !== 'idle') {
      this.setState('idle');
    }
  }

  private async cleanupPreparedVideo() {
    if (!this.prepared) {
      return;
    }
    this.disposeVideo(this.prepared.video);
    this.prepared = null;
  }

  private async createPreparedVideo(
    source: string | MediaStream,
    token: number,
  ): Promise<HTMLVideoElement> {
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.controls = false;
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'cover';

    return new Promise<HTMLVideoElement>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        video.removeEventListener('canplay', handleCanPlay);
        video.removeEventListener('error', handleError);
      };

      const resolveSafely = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(video);
      };

      const rejectSafely = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const handleCanPlay = () => {
        if (token !== this.loadToken + 1 && token !== this.loadToken) {
          resolveSafely();
          return;
        }
        resolveSafely();
      };

      const handleError = () => {
        const mediaError = video.error ?? new Error('Unknown video error');
        const error =
          mediaError instanceof Error ? mediaError : new Error(String(mediaError));
        rejectSafely(error);
      };

      video.addEventListener('canplay', handleCanPlay, { once: true });
      video.addEventListener('error', handleError, { once: true });

      timeoutId = setTimeout(() => {
        rejectSafely(new Error('Timed out while preparing video source'));
      }, 10000);

      try {
        if (typeof source === 'string') {
          const url = this.buildCacheBustedUrl(source, token);
          video.src = url;
          video.load();
        } else {
          video.srcObject = source;
        }
      } catch (error) {
        const loadError = error instanceof Error ? error : new Error(String(error));
        rejectSafely(loadError);
      }
    }).then(async (preparedVideo) => {
      try {
        const result = preparedVideo.play();
        if (result && typeof result.then === 'function') {
          await result;
        }
      } catch {
        // The commit phase will retry playback; ignore pre-roll failures.
      }
      try {
        preparedVideo.pause();
        preparedVideo.currentTime = 0;
      } catch {
        // ignore pause errors during preparation
      }
      return preparedVideo;
    });
  }

  private commitPreparedVideo(video: HTMLVideoElement, token: number) {
    if (token !== this.loadToken) {
      this.disposeVideo(video);
      return;
    }

    this.prepared = null;

    const previousVideo = this.videoElement;
    if (previousVideo) {
      this.cleanupVideoElement(previousVideo);
      if (previousVideo.parentElement) {
        previousVideo.parentElement.removeChild(previousVideo);
      }
      this.disposeVideo(previousVideo);
    }

    this.videoElement = video;
    this.applyPlaybackRate(this.playbackRate);
    this.setupVideoElement(video);

    if (this.container && video.parentElement !== this.container) {
      this.container.appendChild(video);
    }

    this.pendingPlay = true;
    this.playAttempts = 0;
    this.setState('ready');
    this.attemptPlayback();
  }

  private disposeVideo(video: HTMLVideoElement) {
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
      video.srcObject = null;
    } catch {
      // ignore srcObject reset errors
    }

    try {
      video.load();
    } catch {
      // ignore load errors
    }
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
    element.controls = false;

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

    const hasActiveSource = Boolean(video.currentSrc || video.src || this.currentSrc);
    if (!hasActiveSource) {
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

  private buildCacheBustedUrl(src: string, token: number): string {
    const stamp = `${Date.now()}-${token}`;
    if (/^(blob:|data:)/i.test(src)) {
      return src;
    }
    try {
      const base = typeof window !== 'undefined' ? window.location.href : undefined;
      const url = base ? new URL(src, base) : new URL(src);
      url.searchParams.set('_ts', stamp);
      return url.toString();
    } catch {
      const separator = src.includes('?') ? '&' : '?';
      return `${src}${separator}_ts=${stamp}`;
    }
  }
}
