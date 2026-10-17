/**
 * The street's sky follows the visitor's real clock (owner, 2026-10-17: "at night the
 * sun really goes down in real time, streetlights come up, the night crowd comes out").
 *
 * Pure: no DOM, no timers. `skyAt(date)` answers what the sky looks like at that instant;
 * the renderer only paints it. Sunrise and sunset come from the visitor's latitude and
 * longitude when the host passes them, otherwise from a fixed 06:30 / 18:30 local day.
 */

export type SkyPhase = 'night' | 'dawn' | 'day' | 'dusk';

export interface SkyOptions {
  /** Degrees north. With `lon`, gives real sunrise and sunset for that place. */
  lat?: number;
  /** Degrees east. */
  lon?: number;
  /** Local hours used when no location is given. */
  fallbackSunrise?: number;
  fallbackSunset?: number;
}

export interface Sky {
  phase: SkyPhase;
  /** 0 = full night, 1 = full day; smooth through dawn and dusk. */
  daylight: number;
  /** Gradient stops for the sky, top then horizon, as CSS hex colours. */
  top: string;
  horizon: string;
  /** Star layer opacity, 0..1. */
  starAlpha: number;
  /** Sun (by day) or moon (by night) position across the sky, 0 = left, 1 = right. */
  bodyX: number;
  /** Height of that body above the skyline, 0..1. */
  bodyY: number;
  body: 'sun' | 'moon';
  /** Streetlights and neon signs at full glow. */
  lightsOn: boolean;
  /** Lit-window and neon intensity, 0..1 (rises as daylight falls). */
  glow: number;
  /** How busy the street is, 0..1: a quiet morning, a working day, the night crowd. */
  crowd: number;
  /** Local sunrise and sunset in decimal hours, as used for this answer. */
  sunrise: number;
  sunset: number;
}

const TWILIGHT_H = 0.75; // the dawn/dusk window either side of sunrise/sunset

const PALETTE = {
  night: { top: '#0b0420', horizon: '#2a0f4a' },
  dawn: { top: '#3b2a6b', horizon: '#ff8fa3' },
  day: { top: '#3fa3ff', horizon: '#bfe7ff' },
  dusk: { top: '#2b1055', horizon: '#ff4fa0' },
};

/** Local decimal hours of `date` (0..24). */
export function localHours(date: Date): number {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

/**
 * Sunrise and sunset in LOCAL decimal hours for a place, using the NOAA approximation
 * (accurate to a few minutes, plenty for streetlights). Polar day/night clamp to 0/24.
 */
export function sunTimes(date: Date, lat: number, lon: number): { sunrise: number; sunset: number } {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const today = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const doy = Math.round((today - start) / 86400000);
  const g = ((2 * Math.PI) / 365) * (doy - 1);
  const eqtime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const rad = (lat * Math.PI) / 180;
  const cosH = (Math.cos((90.833 * Math.PI) / 180) - Math.sin(rad) * Math.sin(decl)) / (Math.cos(rad) * Math.cos(decl));
  const tzHours = -date.getTimezoneOffset() / 60;
  if (cosH >= 1) return { sunrise: 12, sunset: 12 }; // polar night: the sun never rises
  if (cosH <= -1) return { sunrise: 0, sunset: 24 }; // polar day
  const ha = (Math.acos(cosH) * 180) / Math.PI;
  const noonUtcMin = 720 - 4 * lon - eqtime;
  const sunrise = (noonUtcMin - 4 * ha) / 60 + tzHours;
  const sunset = (noonUtcMin + 4 * ha) / 60 + tzHours;
  return { sunrise: ((sunrise % 24) + 24) % 24, sunset: ((sunset % 24) + 24) % 24 };
}

function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => {
    const va = (pa >> shift) & 255;
    const vb = (pb >> shift) & 255;
    return Math.round(va + (vb - va) * t);
  };
  return `#${[16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

/** How busy the street is at a local hour: quiet at 5, steady by day, peak 21-01. */
export function crowdAt(hours: number): number {
  const h = ((hours % 24) + 24) % 24;
  if (h < 5) return 0.55 - (h / 5) * 0.45; // after midnight the crowd thins
  if (h < 8) return 0.1 + ((h - 5) / 3) * 0.25;
  if (h < 17) return 0.4;
  if (h < 21) return 0.4 + ((h - 17) / 4) * 0.6; // evening fills up
  return 1 - ((h - 21) / 8) * 0.45;
}

export function skyAt(date: Date, options: SkyOptions = {}): Sky {
  const { sunrise, sunset } =
    typeof options.lat === 'number' && typeof options.lon === 'number'
      ? sunTimes(date, options.lat, options.lon)
      : { sunrise: options.fallbackSunrise ?? 6.5, sunset: options.fallbackSunset ?? 18.5 };
  const h = localHours(date);

  // daylight: 0 before dawn, ramps across [sunrise - T, sunrise + T], 1 by day, ramps down at dusk
  const up = smooth((h - (sunrise - TWILIGHT_H)) / (2 * TWILIGHT_H));
  const down = 1 - smooth((h - (sunset - TWILIGHT_H)) / (2 * TWILIGHT_H));
  const daylight = sunset > sunrise ? Math.min(up, down) : 0;

  let phase: SkyPhase;
  if (Math.abs(h - sunrise) <= TWILIGHT_H) phase = 'dawn';
  else if (Math.abs(h - sunset) <= TWILIGHT_H) phase = 'dusk';
  else if (h > sunrise && h < sunset) phase = 'day';
  else phase = 'night';

  let top: string;
  let horizon: string;
  if (phase === 'dawn' || phase === 'dusk') {
    const p = PALETTE[phase];
    // blend the twilight palette toward night or day by how far daylight has come
    const toward = daylight > 0.5 ? PALETTE.day : PALETTE.night;
    const t = daylight > 0.5 ? (daylight - 0.5) * 2 : (0.5 - daylight) * 2;
    top = mix(p.top, toward.top, t * 0.6);
    horizon = mix(p.horizon, toward.horizon, t * 0.6);
  } else {
    top = PALETTE[phase].top;
    horizon = PALETTE[phase].horizon;
  }

  const isDay = h >= sunrise && h <= sunset;
  let bodyX: number;
  let bodyY: number;
  if (isDay) {
    const t = (h - sunrise) / Math.max(0.01, sunset - sunrise);
    bodyX = t;
    bodyY = Math.sin(Math.PI * t);
  } else {
    const nightLen = 24 - (sunset - sunrise);
    const since = (((h - sunset) % 24) + 24) % 24;
    const t = since / Math.max(0.01, nightLen);
    bodyX = t;
    bodyY = Math.sin(Math.PI * t) * 0.85;
  }

  const glow = 1 - daylight;
  return {
    phase,
    daylight,
    top,
    horizon,
    starAlpha: smooth((0.35 - daylight) / 0.35),
    bodyX,
    bodyY,
    body: isDay ? 'sun' : 'moon',
    lightsOn: daylight < 0.45,
    glow,
    crowd: crowdAt(h),
    sunrise,
    sunset,
  };
}
