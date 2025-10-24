import { useEffect, useRef, type CSSProperties } from 'react';
import { useRTCStreaming } from '../../../modules/useRTCStreaming';
import type { FallbackAssets, MixDeck, RTCSignalMessage } from '../../../types/realtime';
import type { ViewerStatus } from '../../../types/realtime';
import type { DeckKey } from '../../../utils/mix';
import { deckLabels, masterPreviewOrder } from '../constants';
import type { CSSVariableProperties } from '../types';
import { buildHighlightVars, formatCssNumber } from '../utils';

type CenterConsoleProps = {
  decks: Record<DeckKey, MixDeck>;
  deckMixOutputs: Record<DeckKey, number>;
  assets: FallbackAssets;
  viewerStatus: ViewerStatus;
  selectedAssetValue: string | null;
  onLoadDeck: (deckKey: DeckKey) => void;
  crossfaderValue: number;
  onCrossfaderChange: (value: number) => void;
  masterPreviewRefs: Record<DeckKey, (element: HTMLVideoElement | null) => void>;
  rtcSignal: RTCSignalMessage | null;
  onSendRTCSignal: (signal: RTCSignalMessage) => void;
  onConsumeRTCSignal: () => void;
};

const renderMasterPreviewLayer = (
  deckKey: DeckKey,
  decks: Record<DeckKey, MixDeck>,
  deckMixOutputs: Record<DeckKey, number>,
  assets: FallbackAssets,
  masterPreviewRefs: Record<DeckKey, (element: HTMLVideoElement | null) => void>,
) => {
  const deck = decks[deckKey];
  const effectiveOpacity = Math.max(0, Math.min(1, deckMixOutputs[deckKey] ?? 0));

  if (!deck || !deck.enabled || !deck.type || effectiveOpacity <= 0) {
    return null;
  }

  const layerDepth = deckKey === 'a' || deckKey === 'b' ? 3 : 2;
  const blendMode =
    deckKey === 'b' || deckKey === 'd' ? ('plus-lighter' as CSSProperties['mixBlendMode']) : 'screen';
  const commonStyle: CSSProperties = {
    opacity: effectiveOpacity,
    zIndex: layerDepth,
    mixBlendMode: blendMode,
  };

  if (deck.type === 'video' && deck.assetId) {
    const video = assets.videos.find((item) => item.id === deck.assetId);
    if (!video) {
      return null;
    }
    const videoKey = `master-mix-${deckKey}-${video.id}`;
    return (
      <video
        key={videoKey}
        className="master-preview-layer"
        muted
        playsInline
        preload="auto"
        ref={masterPreviewRefs[deckKey]}
        style={commonStyle}
      />
    );
  }

  let sourceLabel = 'Generative Shader';
  if (deck.type === 'shader' && deck.assetId) {
    const shader = assets.glsl.find((item) => item.id === deck.assetId);
    sourceLabel = shader?.name ?? 'GLSL Shader';
  } else if (deck.type === 'video') {
    const video = assets.videos.find((item) => item.id === deck.assetId);
    sourceLabel = video?.name ?? 'Video';
  }

  return (
    <div
      key={`master-mix-${deckKey}-placeholder`}
      className="master-preview-layer master-preview-layer-placeholder"
      style={commonStyle}
    >
      <span className="master-preview-layer-deck">{deckLabels[deckKey]}</span>
      <span className="master-preview-layer-title">{sourceLabel}</span>
    </div>
  );
};

export const CenterConsole = ({
  decks,
  deckMixOutputs,
  assets,
  viewerStatus,
  selectedAssetValue,
  onLoadDeck,
  crossfaderValue,
  onCrossfaderChange,
  masterPreviewRefs,
  rtcSignal,
  onSendRTCSignal,
  onConsumeRTCSignal,
}: CenterConsoleProps) => {
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const {
    connectionState: rtcConnectionState,
    initViewer,
    addRemoteIceCandidate,
    closeConnection,
  } = useRTCStreaming(onSendRTCSignal);
  const isStreamConnected = rtcConnectionState === 'connected';
  const isStreamConnecting = rtcConnectionState === 'connecting';

  useEffect(() => {
    const videoElement = previewVideoRef.current;
    return () => {
      if (videoElement) {
        videoElement.srcObject = null;
      }
      closeConnection();
    };
  }, [closeConnection]);

  useEffect(() => {
    if (!rtcSignal) {
      return;
    }

    const processSignal = async () => {
      let shouldConsume = true;
      try {
        if (rtcSignal.rtc === 'offer') {
          const videoElement = previewVideoRef.current;
          if (!videoElement) {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
          }
          const resolvedVideoElement = previewVideoRef.current;
          if (!resolvedVideoElement) {
            shouldConsume = false;
            return;
          }
          const answer = await initViewer(rtcSignal.payload, resolvedVideoElement);
          if (answer) {
            onSendRTCSignal({ type: 'rtc-signal', rtc: 'answer', payload: answer });
          }
        } else if (rtcSignal.rtc === 'ice-candidate') {
          await addRemoteIceCandidate(rtcSignal.payload);
        }
      } catch (error) {
        console.error('CenterConsole: failed to process RTC signal.', error);
      } finally {
        if (shouldConsume) {
          onConsumeRTCSignal();
        }
      }
    };

    void processSignal();
  }, [rtcSignal, initViewer, addRemoteIceCandidate, onSendRTCSignal, onConsumeRTCSignal]);

  const hasMixDeckEnabled = Object.values(decks).some((deck) => deck?.enabled);
  const hasActiveMixOutput = Object.values(deckMixOutputs).some((value) => value > 0.001);

  const previewBadge = isStreamConnected
    ? 'VIEWER FEED'
    : viewerStatus.isRunning
      ? 'LIVE MIX'
      : hasMixDeckEnabled
        ? 'PREVIEW'
        : 'STANDBY';
  const previewMessage = isStreamConnected
    ? 'Displaying live viewer output'
    : isStreamConnecting
      ? 'Connecting to viewer feed'
      : viewerStatus.isRunning
        ? 'Streaming to viewer output'
        : hasActiveMixOutput
          ? 'Currently mixing active decks'
          : 'Start to render generative mix';

  const crossfaderPercent = Math.max(0, Math.min(100, crossfaderValue * 100));
  const crossfaderStyle: CSSVariableProperties = {
    '--fader-value': formatCssNumber(crossfaderPercent),
    ...buildHighlightVars(crossfaderPercent),
  };

  return (
    <div className="dj-center-console control-card">
      <div className="dj-center-preview">
        <div className="master-preview-window">
          <video
            ref={previewVideoRef}
            className="master-preview-stream"
            autoPlay
            playsInline
            muted
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: isStreamConnected ? 1 : 0,
              zIndex: isStreamConnected ? 2 : 0,
              pointerEvents: 'none',
              transition: 'opacity 120ms ease',
            }}
          />
          <div className={`master-preview-screen ${viewerStatus.isRunning ? 'live' : 'idle'}`}>
            {!isStreamConnected && (
              <div className="master-preview-layers" aria-hidden="true">
                {masterPreviewOrder.map((key) =>
                  renderMasterPreviewLayer(key, decks, deckMixOutputs, assets, masterPreviewRefs),
                )}
              </div>
            )}
            <div className="master-preview-status sr-only">
              <span className="master-badge">{previewBadge}</span>
              <span className="master-preview-message">{previewMessage}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="dj-center-faders">
        <div className="dj-center-load-column is-left">
          {(['a', 'b'] as DeckKey[]).map((key) => (
            <button
              key={key}
              type="button"
              disabled={!selectedAssetValue}
              onClick={() => selectedAssetValue && onLoadDeck(key)}
            >
              LOAD {key.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="dj-center-middle">
          <div className="dj-crossfader">
            <div className="crossfader-heading" aria-hidden="true" />
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={crossfaderValue}
              onChange={(event) => onCrossfaderChange(Number(event.target.value))}
              style={crossfaderStyle}
            />
          </div>
          <div className="dj-center-status">
            <span>Status: {viewerStatus.isRunning ? 'Running' : 'Idle'}</span>
            <span>Generating: {viewerStatus.isGenerating ? 'Yes' : 'No'}</span>
            <span>
              Viewer Link:{' '}
              {isStreamConnected ? 'Connected' : isStreamConnecting ? 'Negotiating' : 'Waiting'}
            </span>
            {viewerStatus.error && <span className="control-error">{viewerStatus.error}</span>}
          </div>
        </div>
        <div className="dj-center-load-column is-right">
          {(['c', 'd'] as DeckKey[]).map((key) => (
            <button
              key={key}
              type="button"
              disabled={!selectedAssetValue}
              onClick={() => selectedAssetValue && onLoadDeck(key)}
            >
              LOAD {key.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
