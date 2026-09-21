const SATURATION = 55;
const LIGHTNESS = 45;

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The All-projects view belongs to no project, so it gets no hue. */
export const NEUTRAL_ACCENT = '#6f6860';

/**
 * The hues a project may be given, as [start, end) arcs. What is missing is
 * missing on purpose: reds read as an error and yellow-greens through greens
 * read as a pass, and a colour whose only job is to say WHICH PROJECT must not
 * also look like a verdict. Three tiles side by side in red, red and
 * yellow-green is what this replaces.
 */
const BANDS: readonly (readonly [number, number])[] = [[25, 60], [170, 340]];
const SPAN = BANDS.reduce((total, [start, end]) => total + (end - start), 0);

/**
 * How far inside a band's edge an assigned hue has to stay. A band's ends are
 * EXCLUSIVE, but the hue is stored as #rrggbb, and one 8-bit step is about
 * 0.48 degrees of hue: a hue picked at 339.9 comes back out of the hex as
 * 340.0, which is red, and one picked at 25.0 comes back as 24.76, which is
 * also red. Measured over every tenth of a degree, the worst round trip is
 * 0.4, so one degree of inset is the whole of it and then some.
 */
const EDGE_GUARD = 1;

/** Indigo, so a store with one project gets the accent the proofs were shot in. */
const FIRST_POSITION = 115;

/** Warm near-black, a shade under the page's light-theme ink (#16150f). */
const DARK_INK = '#141210';
const WHITE_INK = '#ffffff';

/**
 * The accent for a project being registered now, given every accent the store
 * already holds. It lands in the widest gap between them, so each new project
 * is as far from the others as the allowed hues allow.
 *
 * Not a hash of the slug: a hash is uniform over the whole wheel, which is how
 * two projects ended up a few degrees apart and how a third landed in the red
 * band. Not a golden-angle step over a counter either, because a counter
 * ignores a deleted project and an accent chosen by hand with --accent, and
 * walks back over both.
 */
export function accentForRegistration(taken: Iterable<string>): string {
  const used = [...taken]
    .filter((accent) => HEX.test(accent))
    .map((accent) => toPosition(hexToHsl(accent.toLowerCase())[0]))
    .sort((first, second) => first - second);

  if (used.length === 0) return hslToHex(toHue(FIRST_POSITION), SATURATION, LIGHTNESS);

  let widest = 0;
  let at = used[0] ?? 0;
  for (let index = 0; index < used.length; index += 1) {
    const here = used[index] ?? 0;
    const next = index + 1 === used.length ? (used[0] ?? 0) + SPAN : (used[index + 1] ?? 0);
    if (next - here > widest) {
      widest = next - here;
      at = here + (next - here) / 2;
    }
  }

  return hslToHex(toHue(at % SPAN), SATURATION, LIGHTNESS);
}

/** A position along the assignable hues, 0 to SPAN, back into a hue. */
function toHue(position: number): number {
  let left = position;
  for (const [start, end] of BANDS) {
    if (left < end - start) {
      return Math.min(Math.max(start + left, start + EDGE_GUARD), end - EDGE_GUARD);
    }
    left -= end - start;
  }
  return (BANDS[0]?.[0] ?? 0) + EDGE_GUARD;
}

/**
 * A hue back into a position. A hue outside the bands (only reachable through
 * --accent) folds onto the nearest band edge, so a hand-picked red still
 * pushes the next automatic accent away from it.
 */
function toPosition(hue: number): number {
  const wrapped = ((hue % 360) + 360) % 360;
  let offset = 0;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [start, end] of BANDS) {
    const clamped = Math.min(Math.max(wrapped, start), end);
    const distance = Math.min(
      Math.abs(wrapped - clamped),
      360 - Math.abs(wrapped - clamped),
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = offset + (clamped - start);
    }
    offset += end - start;
  }
  return best;
}

/** Anything that is not #rrggbb never reaches the page's CSS. */
export function safeAccent(value: string | null | undefined): string {
  return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : NEUTRAL_ACCENT;
}

/** Black or white on this accent, whichever WCAG contrast is higher. */
export function accentInk(accent: string): string {
  const own = luminance(safeAccent(accent));
  return contrast(own, luminance(WHITE_INK)) >= contrast(own, luminance(DARK_INK))
    ? WHITE_INK
    : DARK_INK;
}

/**
 * Both themes keep the project's hue and saturation and move only its
 * lightness, until the accent clears these luminances. Below LIGHT_MAX white
 * text on the accent clears 4.5:1; above DARK_MIN the page's ink does. The
 * band between them is the dead zone where NEITHER ink reaches AA, and a
 * stored accent can land in it, so the page never paints a stored hex
 * directly: it paints the variant for the theme in front of it.
 */
const LIGHT_MAX = 0.175;
const DARK_MIN = 0.215;

/** The accent darkened until white text on it, and it on the light page, both read. */
export function accentOnLight(accent: string): string {
  const [hue, saturation, lightness] = hexToHsl(safeAccent(accent));
  let level = lightness;
  let hex = hslToHex(hue, saturation, level);
  while (luminance(hex) > LIGHT_MAX && level > 0) {
    level -= 1;
    hex = hslToHex(hue, saturation, level);
  }
  return hex;
}

/** The accent lifted until the page's ink on it, and it on the dark page, both read. */
export function accentOnDark(accent: string): string {
  const [hue, saturation, lightness] = hexToHsl(safeAccent(accent));
  let level = lightness;
  let hex = hslToHex(hue, saturation, level);
  while (luminance(hex) < DARK_MIN && level < 100) {
    level += 1;
    hex = hslToHex(hue, saturation, level);
  }
  return hex;
}

function contrast(first: number, second: number): number {
  const [high, low] = first >= second ? [first, second] : [second, first];
  return (high + 0.05) / (low + 0.05);
}

function luminance(hex: string): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  const [red, green, blue] = toRgb(hex);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function toRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hexToHsl(hex: string): [number, number, number] {
  const [red, green, blue] = toRgb(hex).map((value) => value / 255) as [number, number, number];
  const high = Math.max(red, green, blue);
  const low = Math.min(red, green, blue);
  const span = high - low;
  const lightness = (high + low) / 2;

  if (span === 0) return [0, 0, lightness * 100];

  const saturation = span / (1 - Math.abs(2 * lightness - 1));
  const hue =
    high === red
      ? ((green - blue) / span + (green < blue ? 6 : 0))
      : high === green
        ? (blue - red) / span + 2
        : (red - green) / span + 4;

  return [hue * 60, saturation * 100, lightness * 100];
}

function hslToHex(hue: number, saturationPercent: number, lightnessPercent: number): string {
  const saturation = saturationPercent / 100;
  const lightness = lightnessPercent / 100;
  const amplitude = saturation * Math.min(lightness, 1 - lightness);

  const channel = (offset: number): string => {
    const k = (offset + hue / 30) % 12;
    const value = lightness - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * value)
      .toString(16)
      .padStart(2, '0');
  };

  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
