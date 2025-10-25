type VideoState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'error';
type VideoEventCallback = (state: VideoState, details?: Record<string, unknown>) => void;

type PreparedVideo = {
  video: HTMLVideoElement;
  token: number;
  source: string | MediaStream;
};

type SurfaceId = string;

interface SurfaceDescriptor {
  container: HTMLDivElement | null;
  video: HTMLVideoElement | null;
  stream: MediaStream | null;
  isPrimary: boolean;
}

/**
 * Manages double-buffered <video> playback inside a container element.
 *
 * Videos are prepared off-DOM, warmed up, then swapped atomically so that
 * visible elements never flicker to black during source changes.
 */
export class VideoMediaManager {
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
  private lastPlayPromise: Promise<void> | null = null;
  private errorRecoveryAttempts = 0;
  private static readonly MAX_ERROR_RECOVERY_ATTEMPTS = 3;
  private static readonly FALLBACK_SYNC_INTERVAL_MS = 100;
  private static readonly SAFE_RATE_DEBOUNCE_MS = 150;
  private static readonly PLAYBACK_RATE_MIN = 0;
  private static readonly PLAYBACK_RATE_MAX = 5.0;
  private static readonly MICRO_SEEK_OFFSET = 0.0001;
  private targetPlaybackRate = 1.0;
  private playbackRateRaf: number | null = null;
  private pendingPlaybackRate: number | null = null;
  private playbackRateTimer: number | null = null;
  private decodeErrorCount = 0;
  private surfaces: Map<SurfaceId, SurfaceDescriptor> = new Map();
  private primarySurfaceId: SurfaceId | null = null;
  private captureUnavailable = false;
  private fallbackSyncHandle: number | null = null;

  registerSurface(surfaceId: SurfaceId, element: HTMLDivElement | null, options?: { primary?: boolean }) {
    let surface = this.surfaces.get(surfaceId);
    if (!surface) {
      surface = {
        container: null,
        video: null,
        stream: null,
        isPrimary: false,
      };
      this.surfaces.set(surfaceId, surface);
    }

    const wantsPrimary = Boolean(options?.primary);
    if (wantsPrimary) {
      this.assignPrimarySurface(surfaceId, surface);
    } else if (!this.primarySurfaceId) {
      this.assignPrimarySurface(surfaceId, surface);
    }

    if (surface.container && surface.container !== element) {
      this.detachSurface(surfaceId, { keepVideo: true });
    }

    surface.container = element;
    surface.isPrimary = this.primarySurfaceId === surfaceId;

    if (!element) {
      if (surface.isPrimary) {
        this.clearPrimarySurface(surfaceId);
      }
      this.detachSurface(surfaceId);
      return;
    }

    if (surface.isPrimary && !this.videoElement && this.prepared) {
      const { video, token } = this.prepared;
      this.commitPreparedVideo(video, token);
      return;
    }

    this.mountSurface(surfaceId);
    this.refreshMirrorSurfaces();
  }

  private assignPrimarySurface(surfaceId: SurfaceId, surface: SurfaceDescriptor) {
    if (this.primarySurfaceId === surfaceId) {
      surface.isPrimary = true;
      return;
    }

    const previousPrimaryId = this.primarySurfaceId;
    if (previousPrimaryId) {
      const previousSurface = this.surfaces.get(previousPrimaryId);
      if (previousSurface) {
        previousSurface.isPrimary = false;
        this.detachSurface(previousPrimaryId, { keepVideo: true });
      }
    }

    this.primarySurfaceId = surfaceId;
    surface.isPrimary = true;

    if (previousPrimaryId) {
      const demotedSurface = this.surfaces.get(previousPrimaryId);
      if (demotedSurface?.container) {
        this.mountSurface(previousPrimaryId);
      }
    }
  }

  private clearPrimarySurface(surfaceId: SurfaceId) {
    if (this.primarySurfaceId !== surfaceId) {
      return;
    }
    const surface = this.surfaces.get(surfaceId);
    if (surface) {
      surface.isPrimary = false;
    }
    this.primarySurfaceId = null;
    this.recalculatePrimarySurface(surfaceId);
  }

  private recalculatePrimarySurface(excludeId?: SurfaceId) {
    if (this.primarySurfaceId) {
      const currentSurface = this.surfaces.get(this.primarySurfaceId);
      if (currentSurface && currentSurface.container) {
        return;
      }
    }

    this.primarySurfaceId = null;
    for (const [candidateId, candidate] of this.surfaces) {
      if (excludeId && candidateId === excludeId) {
        candidate.isPrimary = false;
        continue;
      }
      if (!candidate.container) {
        candidate.isPrimary = false;
        continue;
      }
      this.assignPrimarySurface(candidateId, candidate);
      this.mountSurface(candidateId);
      this.refreshMirrorSurfaces();
      return;
    }
  }

  private detachSurface(surfaceId: SurfaceId, options?: { keepVideo?: boolean }) {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) {
      return;
    }
    const container = surface.container;
    const node = surface.isPrimary ? this.videoElement : surface.video;
    if (container && node && node.parentElement === container) {
      container.removeChild(node);
    }
    if (!surface.isPrimary) {
      if (!options?.keepVideo && surface.video) {
        this.disposeVideo(surface.video);
        surface.video = null;
      }
      if (!options?.keepVideo) {
        this.stopSurfaceStream(surface);
      }
    }
  }

  private mountSurface(surfaceId: SurfaceId) {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) {
      return;
    }
    const container = surface.container;
    if (!container) {
      return;
    }

    container.replaceChildren();

    if (surface.isPrimary) {
      if (this.videoElement) {
        container.appendChild(this.videoElement);
      }
      return;
    }

    if (!surface.video) {
      surface.video = this.createMirrorVideo();
    }

    container.appendChild(surface.video);
    this.syncMirrorSurface(surfaceId);
  }

  private createMirrorVideo(): HTMLVideoElement {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.autoplay = true;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.controls = false;
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'cover';
    return video;
  }

  private syncMirrorSurface(surfaceId: SurfaceId) {
    const surface = this.surfaces.get(surfaceId);
    if (!surface || surface.isPrimary) {
      return;
    }

    const mirrorVideo = surface.video;
    if (!mirrorVideo) {
      return;
    }

    const primary = this.videoElement;
    if (!primary) {
      this.stopSurfaceStream(surface);
      mirrorVideo.srcObject = null;
      mirrorVideo.removeAttribute('src');
      return;
    }

    const stream = this.obtainCaptureStream(primary);
    if (stream) {
      if (surface.stream !== stream) {
        this.stopSurfaceStream(surface);
        surface.stream = stream;
      }
      try {
        mirrorVideo.srcObject = stream;
        mirrorVideo.removeAttribute('src');
      } catch {
        mirrorVideo.srcObject = null;
      }
      const playPromise = mirrorVideo.play();
      if (playPromise && typeof playPromise.then === 'function') {
        void playPromise.catch((error) => {
          if (!this.isBenignPlayError(error)) {
            console.warn('Mirror video play failed', error);
          }
        });
      }
      this.stopFallbackSync();
    } else if (this.currentSrc) {
      this.stopSurfaceStream(surface);
      mirrorVideo.srcObject = null;
      if (mirrorVideo.src !== this.currentSrc) {
        mirrorVideo.src = this.currentSrc;
        mirrorVideo.load();
      }
      const playPromise = mirrorVideo.play();
      if (playPromise && typeof playPromise.then === 'function') {
        void playPromise.catch((error) => {
          if (!this.isBenignPlayError(error)) {
            console.warn('Mirror video play failed', error);
          }
        });
      }
      this.startFallbackSync();
    }
  }

  private obtainCaptureStream(video: HTMLVideoElement): MediaStream | null {
    if (this.captureUnavailable) {
      return null;
    }
    const candidate = video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
      webkitCaptureStream?: () => MediaStream;
    };
    try {
      if (typeof candidate.captureStream === 'function') {
        return candidate.captureStream();
      }
      if (typeof candidate.mozCaptureStream === 'function') {
        return candidate.mozCaptureStream();
      }
      if (typeof candidate.webkitCaptureStream === 'function') {
        return candidate.webkitCaptureStream();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      const name = (error as { name?: string }).name ?? '';
      const isSecurityError =
        name === 'SecurityError' ||
        message.toLowerCase().includes('securityerror') ||
        message.toLowerCase().includes('cross-origin');
      if (isSecurityError) {
        this.captureUnavailable = true;
        console.info(
          'captureStream disabled for this deck due to cross-origin restrictions; falling back to direct source duplication.',
        );
        this.startFallbackSync();
      } else {
        console.warn('Failed to capture stream from video', error);
      }
    }
    return null;
  }

  private stopSurfaceStream(surface: SurfaceDescriptor) {
    if (surface.stream) {
      surface.stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore track stop errors
        }
      });
      surface.stream = null;
    }
  }

  private refreshMirrorSurfaces() {
    for (const [surfaceId, surface] of this.surfaces) {
      if (!surface.isPrimary) {
        this.syncMirrorSurface(surfaceId);
      }
    }
  }

  private resetMirrorSurfaces() {
    for (const surface of this.surfaces.values()) {
      if (surface.isPrimary) {
        continue;
      }
      if (surface.video) {
        surface.video.srcObject = null;
        surface.video.removeAttribute('src');
      }
      this.stopSurfaceStream(surface);
    }
  }

  private startFallbackSync() {
    if (!this.captureUnavailable) {
      return;
    }
    if (this.fallbackSyncHandle !== null) {
      return;
    }
    const sync = () => {
      if (!this.captureUnavailable) {
        this.stopFallbackSync();
        return;
      }
      this.synchroniseMirrorsFromPrimary();
      this.fallbackSyncHandle = window.setTimeout(sync, VideoMediaManager.FALLBACK_SYNC_INTERVAL_MS);
    };
    this.fallbackSyncHandle = window.setTimeout(sync, VideoMediaManager.FALLBACK_SYNC_INTERVAL_MS);
  }

  private stopFallbackSync() {
    if (this.fallbackSyncHandle !== null) {
      window.clearTimeout(this.fallbackSyncHandle);
      this.fallbackSyncHandle = null;
    }
  }

  private synchroniseMirrorsFromPrimary() {
    const primary = this.videoElement;
    if (!primary) {
      return;
    }

    const targetTime = primary.currentTime;
    const playbackRate = primary.playbackRate || 1;
    const targetPaused = primary.paused;

    for (const surface of this.surfaces.values()) {
      if (surface.isPrimary || !surface.video) {
        continue;
      }
      const mirror = surface.video;

      if (mirror.readyState >= HTMLMediaElement.HAVE_METADATA) {
        if (Math.abs(mirror.currentTime - targetTime) > 0.2) {
          try {
            const fastSeek = (mirror as HTMLMediaElement & { fastSeek?: (time: number) => void }).fastSeek;
            if (typeof fastSeek === 'function') {
              fastSeek.call(mirror, targetTime);
            } else {
              mirror.currentTime = targetTime;
            }
          } catch {
            // ignore seek errors
          }
        }
      }

      if (Math.abs(mirror.playbackRate - playbackRate) > 0.005) {
        try {
          mirror.playbackRate = playbackRate;
        } catch {
          // ignore playback rate errors
        }
      }

      if (!targetPaused) {
        if (mirror.paused) {
          const playPromise = mirror.play();
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch((error) => {
              if (!this.isBenignPlayError(error)) {
                console.warn('Mirror video play failed', error);
              }
            });
          }
        }
      } else if (!mirror.paused) {
        try {
          mirror.pause();
        } catch {
          // ignore pause errors
        }
      }
    }
  }

  private isBenignPlayError(error: unknown): boolean {
    if (!error) {
      return true;
    }
    const message = typeof error === 'string' ? error : (error as Error).message ?? '';
    const name = (error as Error & { name?: string }).name ?? '';
    const lower = message.toLowerCase();
    return (
      name === 'AbortError' ||
      lower.includes('interrupted by a call to pause') ||
      lower.includes('interrupted by a new load request') ||
      lower.includes('the play() request was interrupted')
    );
  }

  async loadSource(src: string | null): Promise<boolean> {
    const token = ++this.loadToken;

    if (!src) {
      await this.cleanupCurrentSource({ resetState: true });
      this.currentSrc = null;
      this.errorRecoveryAttempts = 0;
      return true;
    }

    if (
      this.currentSrc === src &&
      this.videoElement &&
      this.state !== 'idle' &&
      this.state !== 'error'
    ) {
      if (!this.videoElement.paused && this.playbackRate !== this.targetPlaybackRate) {
        this.schedulePlaybackRateUpdate();
      }
      this.pendingPlay = true;
      this.refreshMirrorSurfaces();
      return true;
    }

    await this.cleanupPreparedVideo();

    const isNewSource = this.currentSrc !== src;
    this.currentSrc = src;
    if (isNewSource) {
      this.errorRecoveryAttempts = 0;
      this.captureUnavailable = false;
      this.stopFallbackSync();
    }
    this.setState('loading');

    try {
      const preparedVideo = await this.createPreparedVideo(src, token);
      if (token !== this.loadToken) {
        this.disposeVideo(preparedVideo);
        return false;
      }

      this.prepared = { video: preparedVideo, token, source: src };
      const primarySurface = this.primarySurfaceId ? this.surfaces.get(this.primarySurfaceId) : null;
      if (primarySurface?.container) {
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

    const pauseVideo = () => {
      try {
        this.videoElement!.pause();
        this.setState('paused');
      } catch {
        // ignore pause errors
      }
    };

    if (this.lastPlayPromise) {
      this.lastPlayPromise
        .catch(() => {
          // ignore errors from the previous play attempt
        })
        .finally(() => {
          pauseVideo();
        });
      this.lastPlayPromise = null;
      return;
    }

    try {
      this.videoElement.pause();
      this.setState('paused');
    } catch {
      // ignore pause errors
    }
  }

  private queueSafePlaybackRate(rate: number) {
    this.pendingPlaybackRate = rate;

    const video = this.videoElement;
    if (!video || video.srcObject) {
      return;
    }

    if (this.playbackRateTimer !== null) {
      window.clearTimeout(this.playbackRateTimer);
    }

    this.playbackRateTimer = window.setTimeout(() => {
      this.playbackRateTimer = null;
      this.applyPendingPlaybackRate();
    }, VideoMediaManager.SAFE_RATE_DEBOUNCE_MS);
  }

  private applyPendingPlaybackRate() {
    if (this.playbackRateTimer !== null) {
      window.clearTimeout(this.playbackRateTimer);
      this.playbackRateTimer = null;
    }

    const video = this.videoElement;
    const rate = this.pendingPlaybackRate;
    if (!video || rate == null) {
      return;
    }

    this.pendingPlaybackRate = null;

    if (rate <= 0.0001) {
      this.playbackRate = rate;
      this.targetPlaybackRate = rate;
      return;
    }

    if (video.srcObject) {
      this.targetPlaybackRate = this.playbackRate;
      return;
    }

    const targetRate = Math.max(
      VideoMediaManager.PLAYBACK_RATE_MIN,
      Math.min(VideoMediaManager.PLAYBACK_RATE_MAX, rate),
    );

    const applyWithFallback = () => {
      const wasPaused = video.paused;
      const shouldResume = this.pendingPlay || !wasPaused;

      const updateStateAndMirrors = () => {
        const actualRate = video.playbackRate;
        this.playbackRate = actualRate;
        if (Math.abs(actualRate - targetRate) <= 0.001) {
          this.targetPlaybackRate = targetRate;
        } else {
          console.warn(
            '[Video] playbackRate mismatch after apply',
            { requested: targetRate, actual: actualRate },
          );
          this.targetPlaybackRate = actualRate;
        }
        this.refreshMirrorSurfaces();

        if (shouldResume && video.paused) {
          const playPromise = video.play();
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch((error) => {
              if (!this.isBenignPlayError(error)) {
                console.warn('Video play after rate change failed', error);
              }
            });
          }
        }
      };

      const simpleApplied = (() => {
        try {
          video.playbackRate = targetRate;
          return Math.abs(video.playbackRate - targetRate) <= 0.001;
        } catch (error) {
          console.warn('[Video] playbackRate apply failed, retrying with resync', error);
          return false;
        }
      })();

      if (simpleApplied) {
        updateStateAndMirrors();
        return;
      }

      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : null;

      try {
        if (!wasPaused) {
          try {
            video.pause();
          } catch (error) {
            console.warn('[Video] pause during rate resync failed', error);
          }
        }

        try {
          video.playbackRate = 1.0;
        } catch {
          // ignore reset errors
        }

        if (currentTime !== null) {
          try {
            const fallbackTime = Math.max(0, currentTime - VideoMediaManager.MICRO_SEEK_OFFSET);
            if (fallbackTime !== currentTime) {
              video.currentTime = fallbackTime;
            }
            video.currentTime = currentTime;
          } catch (error) {
            console.warn('[Video] currentTime restore during rate resync failed', error);
          }
        }

        video.playbackRate = targetRate;
      } catch (error) {
        console.error('[Video] playbackRate apply failed after resync attempt', error);
      }

      updateStateAndMirrors();
    };

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      const onLoadedData = () => {
        video.removeEventListener('loadeddata', onLoadedData);
        applyWithFallback();
      };
      video.addEventListener('loadeddata', onLoadedData, { once: true });
      return;
    }

    applyWithFallback();
  }

  setPlaybackRate(rate: number) {
    if (rate <= 0.0001) {
      if (this.state === 'playing') {
        this.pause();
      } else {
        this.pendingPlay = false;
        this.setState('paused');
      }
      this.targetPlaybackRate = 0;
      this.playbackRate = 0;
      this.pendingPlaybackRate = null;
      if (this.playbackRateTimer !== null) {
        window.clearTimeout(this.playbackRateTimer);
        this.playbackRateTimer = null;
      }
      return 0;
    }

    const clampedRate = Math.max(
      VideoMediaManager.PLAYBACK_RATE_MIN,
      Math.min(VideoMediaManager.PLAYBACK_RATE_MAX, rate),
    );
    this.targetPlaybackRate = clampedRate;

    if (!this.videoElement) {
      this.pendingPlaybackRate = clampedRate;
      this.playbackRate = clampedRate;
      return clampedRate;
    }

    if (this.videoElement.srcObject) {
      console.warn('[Video] playbackRate ignored for MediaStream srcObject');
      this.targetPlaybackRate = this.playbackRate;
      return this.playbackRate;
    }

    this.queueSafePlaybackRate(clampedRate);

    if (this.pendingPlay && this.state === 'paused') {
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

    for (const surfaceId of Array.from(this.surfaces.keys())) {
      this.detachSurface(surfaceId);
      const surface = this.surfaces.get(surfaceId);
      if (surface) {
        if (surface.video) {
          this.disposeVideo(surface.video);
          surface.video = null;
        }
        this.stopSurfaceStream(surface);
        surface.container = null;
        surface.isPrimary = false;
      }
    }
    this.surfaces.clear();
    this.primarySurfaceId = null;

    this.currentSrc = null;
    this.state = 'idle';
    this.eventListeners.clear();
    this.captureUnavailable = false;
    this.stopFallbackSync();
    if (this.playbackRateRaf !== null) {
      window.cancelAnimationFrame(this.playbackRateRaf);
      this.playbackRateRaf = null;
    }
    if (this.playbackRateTimer !== null) {
      window.clearTimeout(this.playbackRateTimer);
      this.playbackRateTimer = null;
    }
    this.pendingPlaybackRate = null;
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

    this.resetMirrorSurfaces();

    if (resetState && this.state !== 'idle') {
      this.setState('idle');
    }

    this.captureUnavailable = false;
    this.stopFallbackSync();
    if (this.playbackRateRaf !== null) {
      window.cancelAnimationFrame(this.playbackRateRaf);
      this.playbackRateRaf = null;
    }
    if (this.playbackRateTimer !== null) {
      window.clearTimeout(this.playbackRateTimer);
      this.playbackRateTimer = null;
    }
    this.pendingPlaybackRate = null;
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
    video.crossOrigin = 'anonymous';
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

    if (!this.primarySurfaceId) {
      this.recalculatePrimarySurface();
    }

    if (this.primarySurfaceId) {
      this.mountSurface(this.primarySurfaceId);
    }

    this.pendingPlay = true;
    this.playAttempts = 0;
    this.errorRecoveryAttempts = 0;
    this.setState('ready');
    this.attemptPlayback();
    this.refreshMirrorSurfaces();
    this.schedulePlaybackRateUpdate();
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
    const video = this.videoElement;
    if (!video) {
      return;
    }

    if (rate <= 0.0001) {
      this.playbackRate = rate;
      return;
    }

    if (video.srcObject) {
      return;
    }

    const safeRate = Math.max(
      VideoMediaManager.PLAYBACK_RATE_MIN,
      Math.min(VideoMediaManager.PLAYBACK_RATE_MAX, rate),
    );

    try {
      video.playbackRate = safeRate;
      this.playbackRate = safeRate;
    } catch {
      // ignore playback rate errors
    }
  }

  private schedulePlaybackRateUpdate() {
    if (this.playbackRateRaf !== null) {
      return;
    }
    this.playbackRateRaf = window.requestAnimationFrame(() => {
      this.playbackRateRaf = null;

      const desiredRate = this.pendingPlaybackRate ?? this.targetPlaybackRate;
      if (desiredRate == null || desiredRate <= 0.0001) {
        this.playbackRate = desiredRate ?? this.playbackRate;
        return;
      }

      if (!this.videoElement || this.videoElement.srcObject) {
        return;
      }

      this.queueSafePlaybackRate(desiredRate);
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
        this.lastPlayPromise = playPromise
          .then(() => {
            this.lastPlayPromise = null;
            if (this.pendingPlay || !this.videoElement?.paused) {
              this.setState('playing');
            }
            this.playAttempts = 0;
          })
          .catch((error) => {
            this.lastPlayPromise = null;
            if (this.isBenignAbort(error)) {
              if (this.pendingPlay) {
                setTimeout(() => {
                  if (this.pendingPlay) {
                    this.attemptPlayback();
                  }
                }, 100);
              }
              return;
            }

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

  private isBenignAbort(error: unknown): boolean {
    if (!error) {
      return false;
    }
    const message = typeof error === 'string' ? error : (error as Error).message ?? '';
    const name = (error as Error & { name?: string }).name ?? '';
    const normalisedMessage = message.toLowerCase();
    return (
      name === 'AbortError' ||
      normalisedMessage.includes('interrupted by a call to pause') ||
      normalisedMessage.includes('play() request was interrupted')
    );
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
    if (mediaError?.code === MediaError.MEDIA_ERR_DECODE) {
      console.warn('[Video] MEDIA_ERR_DECODE detected -> soft recovery');
      this.recoverFromDecodeError();
      return;
    }

    let errorMessage = 'Unknown video error';
    if (mediaError) {
      const maybeMessage = (mediaError as MediaError & { message?: string }).message;
      errorMessage =
        typeof maybeMessage === 'string' && maybeMessage.length > 0
          ? maybeMessage
          : `Media error code ${mediaError.code}`;
    }

    console.error('Video error', mediaError);
    const wasPendingPlay = this.pendingPlay || (this.state === 'playing' && !video.paused);
    this.pendingPlay = false;
    this.setState('error', {
      videoError: mediaError ?? null,
      errorCode: mediaError?.code,
      errorMessage,
    });

    const shouldAttemptRecovery =
      !!this.currentSrc && this.errorRecoveryAttempts < VideoMediaManager.MAX_ERROR_RECOVERY_ATTEMPTS;

    if (!shouldAttemptRecovery) {
      return;
    }

    const attemptNumber = ++this.errorRecoveryAttempts;
    const resumePlayback = wasPendingPlay;
    const targetSrc = this.currentSrc;
    const snapshotPlaybackRate = this.targetPlaybackRate;
    const safePlaybackRate = Math.min(snapshotPlaybackRate, 2);
    this.targetPlaybackRate = safePlaybackRate;
    this.playbackRate = safePlaybackRate;
    this.applyPlaybackRate(safePlaybackRate);

    setTimeout(() => {
      if (!targetSrc || targetSrc !== this.currentSrc) {
        return;
      }

      void this.loadSource(targetSrc).then((loaded) => {
        if (!loaded) {
          return;
        }
        this.setPlaybackRate(snapshotPlaybackRate);
        if (resumePlayback) {
          this.pendingPlay = true;
          this.play();
        }
      });
    }, Math.min(2000, 300 * attemptNumber));
  };

  private recoverFromDecodeError() {
    const video = this.videoElement;
    if (!video) {
      return;
    }

    if (video.srcObject) {
      console.warn('[Video] Decode recovery skipped for MediaStream source');
      return;
    }

    const resolvedSrc =
      video.currentSrc ||
      video.src ||
      (this.currentSrc ? this.buildCacheBustedUrl(this.currentSrc, this.loadToken) : null);
    if (!resolvedSrc) {
      console.warn('[Video] Decode recovery aborted: missing media source');
      return;
    }

    const resumePlayback = this.pendingPlay || !video.paused;
    const snapshotTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const snapshotVolume = Number.isFinite(video.volume) ? video.volume : 1;
    const wasMuted = video.muted;
    const desiredRate =
      this.targetPlaybackRate > 0.0001
        ? this.targetPlaybackRate
        : this.playbackRate > 0.0001
          ? this.playbackRate
          : 1.0;

    this.decodeErrorCount += 1;
    const enforceNormalRate = this.decodeErrorCount >= 2;
    const rateToRestore = enforceNormalRate
      ? 1.0
      : Math.max(
          VideoMediaManager.PLAYBACK_RATE_MIN,
          Math.min(VideoMediaManager.PLAYBACK_RATE_MAX, desiredRate),
        );
    if (enforceNormalRate) {
      console.warn('[Video] repeated decode error -> reset playback rate to 1.0');
      this.decodeErrorCount = 0;
    }

    this.pendingPlaybackRate = null;
    if (this.playbackRateTimer !== null) {
      window.clearTimeout(this.playbackRateTimer);
      this.playbackRateTimer = null;
    }

    try {
      video.pause();
    } catch {
      // ignore pause errors
    }

    try {
      video.src = '';
      video.load();
      video.src = resolvedSrc;
      video.load();
    } catch (error) {
      console.error('[Video] Failed to reload media source after decode error', error);
      return;
    }

    video.muted = true;
    this.pendingPlay = resumePlayback;

    let metadataTimer: number | null = null;
    const handleLoadedMetadata = () => {
      if (metadataTimer !== null) {
        window.clearTimeout(metadataTimer);
        metadataTimer = null;
      }
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);

      if (Number.isFinite(snapshotTime)) {
        try {
          const fallbackTime = Math.max(0, snapshotTime - VideoMediaManager.MICRO_SEEK_OFFSET);
          if (fallbackTime !== snapshotTime) {
            video.currentTime = fallbackTime;
          }
          video.currentTime = snapshotTime;
        } catch (error) {
          console.warn('[Video] currentTime restore during decode recovery failed', error);
        }
      }

      video.volume = snapshotVolume;

      this.pendingPlaybackRate = rateToRestore;
      this.targetPlaybackRate = rateToRestore;
      this.applyPendingPlaybackRate();

      const restoreMuteAndVolume = () => {
        video.muted = wasMuted;
        video.volume = snapshotVolume;
      };

      if (resumePlayback) {
        let restoreTimer: number | null = null;
        const onPlaying = () => {
          if (restoreTimer !== null) {
            window.clearTimeout(restoreTimer);
          }
          restoreMuteAndVolume();
        };
        restoreTimer = window.setTimeout(() => {
          video.removeEventListener('playing', onPlaying);
          restoreMuteAndVolume();
        }, 1500);
        video.addEventListener('playing', onPlaying, { once: true });
      } else {
        restoreMuteAndVolume();
      }

      this.refreshMirrorSurfaces();
      this.errorRecoveryAttempts = 0;
      this.decodeErrorCount = 0;
    };

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      handleLoadedMetadata();
    } else {
      metadataTimer = window.setTimeout(() => {
        console.warn('[Video] decode recovery continuing without loadedmetadata event');
        handleLoadedMetadata();
      }, 3000);
      video.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true });
    }
  }

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
