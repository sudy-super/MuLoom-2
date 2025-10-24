import type { CSSVariableRecord } from './types';
import { SENSITIVITY_MAX, SENSITIVITY_MIN } from './constants';

export const clampSensitivityValue = (value: number) =>
  Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, value));

export const mapSensitivityToSlider = (value: number) => {
  const clamped = clampSensitivityValue(value);
  if (clamped <= 1) {
    const slider = 100 - clamped * 50;
    return Math.max(0, Math.min(100, slider));
  }
  const upperRatio = (clamped - 1) / 4;
  const slider = 50 - upperRatio * 50;
  return Math.max(0, Math.min(100, slider));
};

export const mapSliderToSensitivity = (sliderValue: number) => {
  const clampedSlider = Math.max(0, Math.min(100, sliderValue));
  if (clampedSlider >= 50) {
    const ratio = (100 - clampedSlider) / 50;
    return clampSensitivityValue(ratio);
  }
  const upperRatio = (50 - clampedSlider) / 50;
  return clampSensitivityValue(1 + upperRatio * 4);
};

export const mergeClassNames = (...classNames: Array<string | undefined>) =>
  classNames.filter(Boolean).join(' ');

export const formatCssNumber = (value: number) => value.toFixed(2);

export const buildHighlightVars = (positionPercent: number): CSSVariableRecord => {
  const clamped = Math.max(0, Math.min(100, positionPercent));
  const midpoint = 50;
  const start = Math.min(clamped, midpoint);
  const end = Math.max(clamped, midpoint);
  return {
    '--fader-highlight-start': formatCssNumber(start),
    '--fader-highlight-end': formatCssNumber(end),
  };
};

