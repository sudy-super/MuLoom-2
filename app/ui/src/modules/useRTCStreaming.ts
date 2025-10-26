import { useCallback, useEffect, useRef, useState } from 'react';
import type { RTCSignalMessage } from '../types/realtime';

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

interface UseRTCStreamingOptions {
  iceServers?: RTCConfiguration['iceServers'];
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export function useRTCStreaming(
  onSignal?: (signal: RTCSignalMessage) => void,
  options: UseRTCStreamingOptions = {},
) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const remoteMediaRef = useRef<MediaStream | null>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const pendingPlaybackRef = useRef<{ element: HTMLVideoElement; stream: MediaStream } | null>(
    null,
  );
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const frameMonitorRef = useRef<number | null>(null);
  const lastFrameProgressRef = useRef<number>(0);
  const lastVideoTimeRef = useRef<number>(0);
  const stalledRef = useRef(false);
  const onSignalRef = useRef(onSignal);

  onSignalRef.current = onSignal;

  const emitSignal = useCallback((signal: RTCSignalMessage) => {
    if (onSignalRef.current) {
      onSignalRef.current(signal);
    }
  }, []);

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current !== null) {
      return;
    }
    const attempt = reconnectAttemptsRef.current;
    const delay = Math.min(5000, 500 * 2 ** attempt);
    reconnectAttemptsRef.current = attempt + 1;
    reconnectTimeoutRef.current = window.setTimeout(() => {
      reconnectTimeoutRef.current = null;
      emitSignal({
        type: 'rtc-signal',
        rtc: 'request-offer',
        payload: null,
      });
    }, delay);
  }, [emitSignal]);

  const stopFrameMonitor = useCallback(() => {
    if (frameMonitorRef.current !== null) {
      cancelAnimationFrame(frameMonitorRef.current);
      frameMonitorRef.current = null;
    }
  }, []);

  const startFrameMonitor = useCallback(
    (element: HTMLVideoElement) => {
      stopFrameMonitor();
      lastFrameProgressRef.current = performance.now();
      lastVideoTimeRef.current = element.currentTime;
      stalledRef.current = false;

      const check = () => {
        const stream = element.srcObject as MediaStream | null;
        const track = stream?.getVideoTracks()[0];
        const now = performance.now();
        const currentTime = element.currentTime;

        if (Number.isFinite(currentTime) && currentTime > lastVideoTimeRef.current + 0.015) {
          lastVideoTimeRef.current = currentTime;
          lastFrameProgressRef.current = now;
          stalledRef.current = false;
        }

        if (track && track.readyState === 'ended' && !stalledRef.current) {
          stalledRef.current = true;
          scheduleReconnect();
          stopFrameMonitor();
          return;
        }

        if (now - lastFrameProgressRef.current > 3000 && !stalledRef.current) {
          stalledRef.current = true;
          scheduleReconnect();
        }

        frameMonitorRef.current = requestAnimationFrame(check);
      };

      frameMonitorRef.current = requestAnimationFrame(check);
    },
    [scheduleReconnect, stopFrameMonitor],
  );

  const updateConnectionState = useCallback(
    (state: RTCPeerConnectionState) => {
      switch (state) {
        case 'connected': {
          clearReconnectTimeout();
          reconnectAttemptsRef.current = 0;
          stalledRef.current = false;
          setConnectionState('connected');
          break;
        }
        case 'failed':
        case 'disconnected': {
          setConnectionState('disconnected');
          scheduleReconnect();
          break;
        }
        case 'closed': {
          setConnectionState('disconnected');
          break;
        }
        default: {
          setConnectionState('connecting');
        }
      }
    },
    [clearReconnectTimeout, scheduleReconnect],
  );

  const closeConnection = useCallback(() => {
    const pc = peerConnectionRef.current;
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    peerConnectionRef.current = null;
    if (remoteMediaRef.current) {
      remoteMediaRef.current.getTracks().forEach((track) => track.stop());
      remoteMediaRef.current = null;
    }
    pendingPlaybackRef.current = null;
    clearReconnectTimeout();
    stopFrameMonitor();
    stalledRef.current = false;
    reconnectAttemptsRef.current = 0;
    lastFrameProgressRef.current = 0;
    lastVideoTimeRef.current = 0;
    setAutoplayBlocked(false);
    setConnectionState('disconnected');
  }, [clearReconnectTimeout, stopFrameMonitor]);

  const createPeerConnection = useCallback(() => {
    closeConnection();
    const configuration: RTCConfiguration = {
      iceServers: options.iceServers && options.iceServers.length > 0
        ? options.iceServers
        : DEFAULT_ICE_SERVERS,
    };
    const pc = new RTCPeerConnection(configuration);
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        emitSignal({
          type: 'rtc-signal',
          rtc: 'ice-candidate',
          payload: event.candidate.toJSON(),
        });
      }
    };
    pc.onconnectionstatechange = () => {
      updateConnectionState(pc.connectionState);
      if (pc.connectionState === 'failed') {
        closeConnection();
      }
    };
    peerConnectionRef.current = pc;
    setConnectionState('connecting');
    return pc;
  }, [closeConnection, emitSignal, options.iceServers, updateConnectionState]);

  const retryAutoplay = useCallback(async () => {
    const pending = pendingPlaybackRef.current;
    if (!pending) {
      return true;
    }
    try {
      const result = pending.element.play();
      if (result && typeof result.then === 'function') {
        await result;
      }
      pendingPlaybackRef.current = null;
      setAutoplayBlocked(false);
      startFrameMonitor(pending.element);
      return true;
    } catch (error) {
      console.warn('useRTCStreaming: autoplay retry failed.', error);
      setAutoplayBlocked(true);
      return false;
    }
  }, [startFrameMonitor]);

  const initBroadcaster = useCallback(
    async (stream: MediaStream) => {
      if (!stream) {
        return null;
      }
      const pc = createPeerConnection();
      if (!pc) {
        return null;
      }
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        return offer;
      } catch (error) {
        console.error('useRTCStreaming: failed to initialise broadcaster.', error);
        closeConnection();
        return null;
      }
    },
    [createPeerConnection, closeConnection],
  );

  const handleRemoteAnswer = useCallback(async (answer: RTCSessionDescriptionInit) => {
    const pc = peerConnectionRef.current;
    if (!pc) {
      console.warn('useRTCStreaming: cannot apply answer without an active connection.');
      return false;
    }
    try {
      await pc.setRemoteDescription(answer);
      return true;
    } catch (error) {
      console.error('useRTCStreaming: failed to apply remote answer.', error);
      return false;
    }
  }, []);

  const addRemoteIceCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    const pc = peerConnectionRef.current;
    if (!pc || !candidate) {
      return false;
    }
    try {
      await pc.addIceCandidate(candidate);
      return true;
    } catch (error) {
      console.error('useRTCStreaming: failed to add remote ICE candidate.', error);
      return false;
    }
  }, []);

  const initViewer = useCallback(
    async (offer: RTCSessionDescriptionInit, videoElement: HTMLVideoElement) => {
      if (!offer || !videoElement) {
        return null;
      }
      const pc = createPeerConnection();
      if (!pc) {
        return null;
      }
      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream) {
          return;
        }

        remoteMediaRef.current = stream;
        pendingPlaybackRef.current = null;
        reconnectAttemptsRef.current = 0;
        stalledRef.current = false;

        stream.getVideoTracks().forEach((track) => {
          track.onended = () => {
            scheduleReconnect();
            stopFrameMonitor();
          };
          track.onmute = () => {
            stalledRef.current = true;
            scheduleReconnect();
          };
          track.onunmute = () => {
            stalledRef.current = false;
            lastFrameProgressRef.current = performance.now();
            void retryAutoplay();
          };
        });

        // Assigning the stream inside requestAnimationFrame helps avoid
        // "play() request was interrupted" errors on some browsers.
        requestAnimationFrame(() => {
          const currentStream = videoElement.srcObject as MediaStream | null;
          if (currentStream === stream) {
            if (videoElement.paused) {
              try {
                const resume = videoElement.play();
                if (resume && typeof resume.then === 'function') {
                  void resume.then(() => {
                    pendingPlaybackRef.current = null;
                    setAutoplayBlocked(false);
                    startFrameMonitor(videoElement);
                  }).catch((error) => {
                    pendingPlaybackRef.current = { element: videoElement, stream };
                    setAutoplayBlocked(true);
                    console.warn('useRTCStreaming: autoplay blocked when resuming existing stream.', error);
                  });
                } else {
                  pendingPlaybackRef.current = null;
                  setAutoplayBlocked(false);
                  startFrameMonitor(videoElement);
                }
              } catch (error) {
                pendingPlaybackRef.current = { element: videoElement, stream };
                setAutoplayBlocked(true);
                console.warn('useRTCStreaming: resume attempt threw synchronously.', error);
              }
            } else {
              startFrameMonitor(videoElement);
            }
            return;
          }

          videoElement.autoplay = true;
          videoElement.muted = true;
          videoElement.playsInline = true;
          videoElement.srcObject = stream;

          if (typeof videoElement.play === 'function') {
            try {
              const result = videoElement.play();
              if (result && typeof result.then === 'function') {
                result
                  .then(() => {
                    pendingPlaybackRef.current = null;
                    setAutoplayBlocked(false);
                    startFrameMonitor(videoElement);
                  })
                  .catch((error) => {
                    pendingPlaybackRef.current = { element: videoElement, stream };
                    setAutoplayBlocked(true);
                    console.warn('useRTCStreaming: autoplay blocked by browser.', error);
                  });
              } else {
                pendingPlaybackRef.current = null;
                setAutoplayBlocked(false);
                startFrameMonitor(videoElement);
              }
            } catch (error) {
              pendingPlaybackRef.current = { element: videoElement, stream };
              setAutoplayBlocked(true);
              console.warn('useRTCStreaming: autoplay attempt threw synchronously.', error);
            }
          } else {
            pendingPlaybackRef.current = null;
            setAutoplayBlocked(false);
            startFrameMonitor(videoElement);
          }
        });
      };
      try {
        await pc.setRemoteDescription(offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        return answer;
      } catch (error) {
        console.error('useRTCStreaming: failed to initialise viewer.', error);
        closeConnection();
        return null;
      }
    },
    [closeConnection, createPeerConnection, retryAutoplay, scheduleReconnect, startFrameMonitor, stopFrameMonitor],
  );

  useEffect(() => () => {
    closeConnection();
  }, [closeConnection]);

  return {
    connectionState,
    autoplayBlocked,
    initBroadcaster,
    handleRemoteAnswer,
    addRemoteIceCandidate,
    initViewer,
    closeConnection,
    retryAutoplay,
  };
}

export type { ConnectionState };
