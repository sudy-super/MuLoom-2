import type { ReactNode } from 'react';
import type { MixDeck } from '../../../types/realtime';
import type { DeckKey } from '../../../utils/mix';
import { assetDragMimeType, deckLabels, deckSensitivityModes } from '../constants';
import {
  buildHighlightVars,
  clampSensitivityValue,
  formatCssNumber,
  mapSensitivityToSlider,
  mapSliderToSensitivity,
} from '../utils';
import type { CSSVariableProperties, DeckColumnOptions, DeckMediaState } from '../types';

type DeckColumnProps = {
  deckKey: DeckKey;
  position: 'left' | 'right';
  deck: MixDeck;
  deckState: DeckMediaState;
  resolvedOpacity: number;
  audioSensitivity: number;
  localSensitivityValue: number;
  isGenerating: boolean;
  isGenerativeDeck: boolean;
  isDropTarget: boolean;
  previewContent: ReactNode;
  onDropTargetChange: (deckKey: DeckKey | null) => void;
  onDeckPowerToggle: (deckKey: DeckKey) => void;
  onRegenerate: () => void;
  onGlobalSensitivityChange: (value: number) => void;
  onLocalSensitivityChange: (deckKey: DeckKey, sliderValue: number) => void;
  onDeckOpacitySliderChange: (deckKey: DeckKey, sliderValue: number) => void;
  onDeckPlaybackToggle: (deckKey: DeckKey) => void;
  onDeckPlaybackScrub: (deckKey: DeckKey, value: number) => void;
  onDeckAssetChange: (deckKey: DeckKey, value: string) => void;
  getDeckAssetLabel: (deck?: MixDeck) => string;
  options?: DeckColumnOptions;
};

export const DeckColumn = ({
  deckKey,
  position,
  deck,
  deckState,
  resolvedOpacity,
  audioSensitivity,
  localSensitivityValue,
  isGenerating,
  isGenerativeDeck,
  isDropTarget,
  previewContent,
  onDropTargetChange,
  onDeckPowerToggle,
  onRegenerate,
  onGlobalSensitivityChange,
  onLocalSensitivityChange,
  onDeckOpacitySliderChange,
  onDeckPlaybackToggle,
  onDeckPlaybackScrub,
  onDeckAssetChange,
  getDeckAssetLabel,
  options,
}: DeckColumnProps) => {
  const isDeckEnabled = deck?.enabled ?? false;
  const globalSliderValue = mapSensitivityToSlider(audioSensitivity);
  const sensitivityHighlight = buildHighlightVars(globalSliderValue);
  const sensitivityStyle: CSSVariableProperties = {
    '--fader-value': formatCssNumber(100 - globalSliderValue),
    ...sensitivityHighlight,
  };

  const opacityPercent = Math.round(resolvedOpacity * 100);
  const clampedOpacityPercent = Math.max(0, Math.min(100, opacityPercent));
  const opacitySliderValue = 100 - clampedOpacityPercent;
  const clampedOpacitySlider = Math.max(0, Math.min(100, opacitySliderValue));
  const opacityStyle: CSSVariableProperties = {
    '--fader-value': formatCssNumber(clampedOpacityPercent),
    '--fader-highlight-start': formatCssNumber(clampedOpacitySlider),
    '--fader-highlight-end': formatCssNumber(100),
  };

  const handleGlobalSensitivitySlider = (sliderPosition: number) => {
    if (Number.isNaN(sliderPosition)) {
      return;
    }
    const clamped = Math.max(0, Math.min(100, sliderPosition));
    const nextValue = mapSliderToSensitivity(clamped);
    onGlobalSensitivityChange(Number(nextValue.toFixed(2)));
  };

  const handleOpacitySlider = (sliderValue: number) => {
    if (Number.isNaN(sliderValue)) {
      return;
    }
    onDeckOpacitySliderChange(deckKey, sliderValue);
  };

  const getDefaultLabel = (variant: 'sensitivity' | 'opacity') =>
    variant === 'sensitivity' ? 'SENSITIVITY' : 'opacity';

  const createFader = (
    variant: 'sensitivity' | 'opacity',
    slot: 'left' | 'right',
    label?: string,
  ) => {
    const baseLabel = label ?? getDefaultLabel(variant);
    const labelContent =
      variant === 'sensitivity' ? (
        <>
          {baseLabel}
          <br />
          TEMPO
        </>
      ) : (
        baseLabel
      );
    const clampMultiplier = (value: number) => clampSensitivityValue(value);
    const formatMultiplier = (value: number) => `×${clampMultiplier(value).toFixed(1)}`;
    const renderMultiplier = (value: number) => (
      <span className="dj-fader-value">{formatMultiplier(value)}</span>
    );

    if (variant === 'sensitivity') {
      const mode = options?.sensitivityMode?.[slot] ?? deckSensitivityModes[deckKey] ?? 'global';
      if (mode === 'local') {
        const sliderValue = localSensitivityValue;
        const sliderHighlight = buildHighlightVars(sliderValue);
        const sliderStyle: CSSVariableProperties = {
          '--fader-value': formatCssNumber(100 - sliderValue),
          ...sliderHighlight,
        };
        const localMultiplier = clampSensitivityValue(mapSliderToSensitivity(sliderValue));
        return (
          <div className="dj-fader-stack" key={`sensitivity-${slot}`}>
            {renderMultiplier(localMultiplier)}
            <div className="dj-fader">
              <input
                type="range"
                min="0"
                max="100"
                value={sliderValue}
                onChange={(event) => {
                  const raw = Number(event.target.value);
                  if (Number.isNaN(raw)) {
                    return;
                  }
                  const clamped = Math.max(0, Math.min(100, raw));
                  onLocalSensitivityChange(deckKey, clamped);
                }}
                className="dj-vertical-fader deck-fader"
                style={sliderStyle}
              />
            </div>
            <span className="dj-fader-label">{labelContent}</span>
          </div>
        );
      }
      const globalMultiplier = clampMultiplier(audioSensitivity);
      return (
        <div className="dj-fader-stack" key={`sensitivity-${slot}`}>
          {renderMultiplier(globalMultiplier)}
          <div className="dj-fader">
            <input
              type="range"
              min="0"
              max="100"
              value={globalSliderValue}
              onChange={(event) => handleGlobalSensitivitySlider(Number(event.target.value))}
              className="dj-vertical-fader deck-fader"
              style={sensitivityStyle}
            />
          </div>
          <span className="dj-fader-label">{labelContent}</span>
        </div>
      );
    }

    return (
      <div className="dj-fader-stack" key={`opacity-${slot}`}>
        <div className="dj-fader">
          <input
            type="range"
            min="0"
            max="100"
            value={clampedOpacitySlider}
            onChange={(event) => handleOpacitySlider(Number(event.target.value))}
            className="dj-vertical-fader opacity-fader"
            style={opacityStyle}
          />
        </div>
        <span className="dj-fader-label">{labelContent}</span>
      </div>
    );
  };

  const leftVariant = options?.leftFader ?? 'sensitivity';
  const rightVariant = options?.rightFader ?? 'opacity';
  const leftLabel = options?.leftLabel ?? getDefaultLabel(leftVariant);
  const rightLabel = options?.rightLabel ?? getDefaultLabel(rightVariant);
  const targetFaderVariant: 'sensitivity' | 'opacity' =
    deckKey === 'a' || deckKey === 'c' ? 'sensitivity' : 'opacity';
  const playbackButtonColumn = (() => {
    if (position === 'left') {
      if (leftVariant === targetFaderVariant) return '1';
      if (rightVariant === targetFaderVariant) return '3';
    } else {
      if (rightVariant === targetFaderVariant) return '1';
      if (leftVariant === targetFaderVariant) return '3';
    }
    return position === 'left' ? '1' : '3';
  })();

  const leftFader = createFader(leftVariant, 'left', leftLabel);
  const rightFader = createFader(rightVariant, 'right', rightLabel);
  const playbackProgress = Math.max(0, Math.min(100, deckState.progress));
  const canControlPlayback = deck?.type === 'video' && Boolean(deck.assetId);

  const previewClassName = `deck-preview-frame${isDropTarget ? ' is-drop-target' : ''}`;
  const playbackButtonStyle: CSSVariableProperties = {
    '--deck-playback-button-column': playbackButtonColumn,
  };
  const playbackProgressStyle: CSSVariableProperties = {
    '--deck-playback-progress': `${playbackProgress}%`,
  };

  return (
    <div className={`dj-deck control-card deck-${deckKey} deck-${position}`} key={deckKey}>
      <header className="dj-deck-header">
        <div className="dj-deck-title">
          <span className="deck-name">{options?.title ?? deckLabels[deckKey]}</span>
          <span className="deck-asset">{getDeckAssetLabel(deck)}</span>
        </div>
        <div className="deck-action-buttons">
          <button
            type="button"
            className={`deck-button on-air${isDeckEnabled ? ' is-active' : ''}`}
            onClick={() => onDeckPowerToggle(deckKey)}
          >
            On Air
          </button>
          <button
            type="button"
            className="deck-button gen"
            onClick={onRegenerate}
            disabled={!isGenerativeDeck || isGenerating}
            aria-disabled={!isGenerativeDeck}
            title={
              isGenerativeDeck
                ? isGenerating
                  ? 'Regeneration in progress'
                  : 'Regenerate shader'
                : 'Available for generative sources'
            }
          >
            Gen
          </button>
        </div>
      </header>

      <div className={`deck-preview-block deck-preview-block-${position}`}>
        {position === 'left' ? (
          <>
            {leftFader}
            <div
              className={previewClassName}
              onDragOver={(event) => {
                if (Array.from(event.dataTransfer.types).includes(assetDragMimeType)) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                  onDropTargetChange(deckKey);
                }
              }}
              onDragEnter={(event) => {
                if (Array.from(event.dataTransfer.types).includes(assetDragMimeType)) {
                  event.preventDefault();
                  onDropTargetChange(deckKey);
                }
              }}
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget as Node | null;
                if (nextTarget && event.currentTarget.contains(nextTarget)) {
                  return;
                }
                onDropTargetChange(null);
              }}
              onDrop={(event) => {
                if (!Array.from(event.dataTransfer.types).includes(assetDragMimeType)) {
                  return;
                }
                event.preventDefault();
                const payload =
                  event.dataTransfer.getData(assetDragMimeType) ||
                  event.dataTransfer.getData('text/plain');
                onDropTargetChange(null);
                if (payload) {
                  onDeckAssetChange(deckKey, payload);
                }
              }}
            >
              {previewContent}
            </div>
            {rightFader}
          </>
        ) : (
          <>
            {rightFader}
            <div
              className={previewClassName}
              onDragOver={(event) => {
                if (Array.from(event.dataTransfer.types).includes(assetDragMimeType)) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                  onDropTargetChange(deckKey);
                }
              }}
              onDragEnter={(event) => {
                if (Array.from(event.dataTransfer.types).includes(assetDragMimeType)) {
                  event.preventDefault();
                  onDropTargetChange(deckKey);
                }
              }}
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget as Node | null;
                if (nextTarget && event.currentTarget.contains(nextTarget)) {
                  return;
                }
                onDropTargetChange(null);
              }}
              onDrop={(event) => {
                if (!Array.from(event.dataTransfer.types).includes(assetDragMimeType)) {
                  return;
                }
                event.preventDefault();
                const payload =
                  event.dataTransfer.getData(assetDragMimeType) ||
                  event.dataTransfer.getData('text/plain');
                onDropTargetChange(null);
                if (payload) {
                  onDeckAssetChange(deckKey, payload);
                }
              }}
            >
              {previewContent}
            </div>
            {leftFader}
          </>
        )}
      </div>

      <div className="dj-deck-lower">
        <div className="deck-playback-row" style={playbackButtonStyle}>
          <button
            type="button"
            className={`deck-playback-button${deckState.isPlaying ? ' is-active' : ''}${
              deckState.isLoading ? ' is-loading' : ''
            }${deckState.error ? ' has-error' : ''}`}
            onClick={() => {
              if (!canControlPlayback) {
                return;
              }
              onDeckPlaybackToggle(deckKey);
            }}
            aria-label={
              canControlPlayback
                ? deckState.isPlaying
                  ? 'Pause playback'
                  : 'Start playback'
                : 'Playback controls unavailable'
            }
            disabled={!canControlPlayback}
          >
            {deckState.isPlaying ? (
              <svg
                className="deck-playback-icon deck-playback-icon-pause"
                viewBox="0 0 24 24"
                role="presentation"
                focusable="false"
              >
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg
                className="deck-playback-icon deck-playback-icon-play"
                viewBox="0 0 24 24"
                role="presentation"
                focusable="false"
              >
                <polygon points="7,4 19,12 7,20" />
              </svg>
            )}
          </button>
          <div className="deck-playback-track" style={playbackProgressStyle}>
            <input
              type="range"
              min="0"
              max="100"
              value={playbackProgress}
              onChange={(event) => {
                if (!canControlPlayback) {
                  return;
                }
                onDeckPlaybackScrub(deckKey, Number(event.target.value));
              }}
              className="deck-playback-slider"
              aria-label={`${deckLabels[deckKey]} playback position`}
              disabled={!canControlPlayback}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

