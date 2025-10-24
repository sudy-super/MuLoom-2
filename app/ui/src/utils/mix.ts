import type { MixDeck, MixState } from '../types/realtime';

export const MIX_DECK_KEYS = ['a', 'b', 'c', 'd'] as const;
export type DeckKey = (typeof MIX_DECK_KEYS)[number];

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const getDeckVolume = (deck?: MixDeck | null) => {
  if (!deck || !deck.enabled) {
    return 0;
  }
  return clamp01(deck.opacity ?? 0);
};

export interface MixComputation {
  outputs: Record<DeckKey, number>;
  hasEnabledDeck: boolean;
  hasActiveOutput: boolean;
  crossfaders: {
    ab: number;
    ac: number;
    bd: number;
    cd: number;
  };
}

export function computeDeckMix(mixState?: MixState | null): MixComputation {
  const decks = mixState?.decks ?? ({} as Record<DeckKey, MixDeck | undefined>);

  const crossfaderAB = clamp01(mixState?.crossfaderAB ?? 0.5);
  const crossfaderAC = clamp01(mixState?.crossfaderAC ?? 0.5);
  const crossfaderBD = clamp01(mixState?.crossfaderBD ?? 0.5);
  const crossfaderCD = clamp01(mixState?.crossfaderCD ?? 0.5);

  const aBase = getDeckVolume(decks.a);
  const bBase = getDeckVolume(decks.b);
  const cBase = getDeckVolume(decks.c);
  const dBase = getDeckVolume(decks.d);

  const resolveCrossfader = (value: number, primaryActive: boolean, secondaryActive: boolean) => {
    if (primaryActive && !secondaryActive) return 0;
    if (!primaryActive && secondaryActive) return 1;
    return value;
  };

  const effectiveCrossfaderAC = resolveCrossfader(crossfaderAC, aBase > 0, cBase > 0);
  const effectiveCrossfaderBD = resolveCrossfader(crossfaderBD, bBase > 0, dBase > 0);

  const aLeft = aBase > 0 ? aBase * (1 - effectiveCrossfaderAC) : 0;
  const cLeft = cBase > 0 ? cBase * effectiveCrossfaderAC : 0;
  const bRight = bBase > 0 ? bBase * (1 - effectiveCrossfaderBD) : 0;
  const dRight = dBase > 0 ? dBase * effectiveCrossfaderBD : 0;

  const effectiveCrossfaderAB = resolveCrossfader(
    crossfaderAB,
    aLeft + cLeft > 0,
    bRight + dRight > 0,
  );

  let aContribution = aLeft * (1 - effectiveCrossfaderAB);
  let cContribution = cLeft * (1 - effectiveCrossfaderAB);
  let bContribution = bRight * effectiveCrossfaderAB;
  let dContribution = dRight * effectiveCrossfaderAB;

  const cdTotal = cContribution + dContribution;
  if (cdTotal > 0) {
    const effectiveCrossfaderCD = resolveCrossfader(
      crossfaderCD,
      cContribution > 0,
      dContribution > 0,
    );
    const cRatio = 1 - effectiveCrossfaderCD;
    const dRatio = effectiveCrossfaderCD;
    cContribution = cdTotal * cRatio;
    dContribution = cdTotal * dRatio;
  }

  const outputs: Record<DeckKey, number> = {
    a: clamp01(aContribution),
    b: clamp01(bContribution),
    c: clamp01(cContribution),
    d: clamp01(dContribution),
  };

  const hasEnabledDeck = MIX_DECK_KEYS.some((key) => {
    const deck = decks[key];
    return Boolean(deck?.enabled && deck?.type);
  });

  const hasActiveOutput = MIX_DECK_KEYS.some((key) => outputs[key] > 0);

  return {
    outputs,
    hasEnabledDeck,
    hasActiveOutput,
    crossfaders: {
      ab: crossfaderAB,
      ac: crossfaderAC,
      bd: crossfaderBD,
      cd: crossfaderCD,
    },
  };
}
