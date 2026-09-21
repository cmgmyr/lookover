import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accentForRegistration, accentInk, accentOnDark, accentOnLight, NEUTRAL_ACCENT, safeAccent } from './accent.ts';

function hue(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const [red, green, blue] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((raw) => raw / 255) as [number, number, number];
  const high = Math.max(red, green, blue);
  const span = high - Math.min(red, green, blue);
  if (span === 0) return 0;
  const raw =
    high === red ? ((green - blue) / span + (green < blue ? 6 : 0))
      : high === green ? (blue - red) / span + 2
        : (red - green) / span + 4;
  return raw * 60;
}

/** The bands accentForRegistration may not use, as the page's own reason for them. */
function readsAsAVerdict(accent: string): boolean {
  const value = hue(accent);
  return value < 25 || value >= 340 || (value >= 60 && value < 170);
}

test('the first project registered gets a valid accent that is not a verdict colour', () => {
  const first = accentForRegistration([]);

  assert.equal(first, accentForRegistration([]));
  assert.match(first, /^#[0-9a-f]{6}$/);
  assert.equal(readsAsAVerdict(first), false, `${first} is in the red or green band`);
});

// Vacuous without the band check: an assignment that spread hues evenly over
// the whole wheel would still pass a spacing-only test and still hand the
// fourth project a red.
test('twelve projects registered in a row are all far apart and none reads as a verdict', () => {
  const accents: string[] = [];
  for (let index = 0; index < 12; index += 1) accents.push(accentForRegistration(accents));

  for (const accent of accents) {
    assert.equal(readsAsAVerdict(accent), false, `${accent} is in the red or green band`);
  }

  const hues = accents.map(hue).sort((first, second) => first - second);
  for (let index = 1; index < hues.length; index += 1) {
    const gap = (hues[index] ?? 0) - (hues[index - 1] ?? 0);
    assert.ok(gap >= 12, `${hues[index - 1]} and ${hues[index]} are ${gap.toFixed(1)} degrees apart`);
  }
});

// STOPPING AT TWELVE IS WHY THIS WAS MISSED. The spacing test above never
// reaches a band edge, and the fifteenth project is the first that lands on
// one: it came out #b2345e, hue exactly 340.000, inside the red band the
// comment on BANDS says is excluded. The hue is stored as #rrggbb, so it
// survives a round trip through eight bits per channel, not as the float it
// was picked as. Forty is past every edge the bisection reaches in practice.
test('the fortieth project registered is still not a verdict colour', () => {
  const accents: string[] = [];
  for (let index = 0; index < 40; index += 1) accents.push(accentForRegistration(accents));

  for (const [index, accent] of accents.entries()) {
    assert.equal(
      readsAsAVerdict(accent),
      false,
      `project ${index + 1} got ${accent}, hue ${hue(accent).toFixed(3)}, inside the red or green band`,
    );
  }
});

// The old hash put alpha-app on #3634b2 and quiet-tool on #3499b2, two blues a
// glance cannot tell apart. Registration order, not the name, decides now.
test('two projects registered one after the other are nowhere near each other', () => {
  const first = accentForRegistration([]);
  const second = accentForRegistration([first]);
  const apart = Math.abs(hue(first) - hue(second));

  assert.ok(Math.min(apart, 360 - apart) >= 60, `${first} and ${second} are ${apart.toFixed(1)} degrees apart`);
});

// --accent is the override, and a hand-picked red is still a colour the next
// automatic accent has to stay away from.
test('an accent chosen by hand still pushes the next one away, even outside the bands', () => {
  const next = accentForRegistration(['#cc2222', 'not a colour']);

  assert.match(next, /^#[0-9a-f]{6}$/);
  assert.equal(readsAsAVerdict(next), false);
  const apart = Math.abs(hue('#cc2222') - hue(next));
  assert.ok(Math.min(apart, 360 - apart) >= 60, `${next} sits next to the hand-picked red`);
});

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (raw: number): number => {
    const scaled = raw / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
}

/** The stored saturation and lightness at one hue, which is every accent the page can be handed. */
function hslHex(degree: number): string {
  const amplitude = 0.55 * Math.min(0.45, 0.55);
  const channel = (offset: number): string => {
    const k = (offset + degree / 30) % 12;
    return Math.round(255 * (0.45 - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

function contrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return a >= b ? (a + 0.05) / (b + 0.05) : (b + 0.05) / (a + 0.05);
}

test('safeAccent passes #rrggbb through and turns anything else into the neutral', () => {
  assert.equal(safeAccent('#336699'), '#336699');
  assert.equal(safeAccent('#AABBCC'), '#aabbcc');
  assert.equal(safeAccent('red'), NEUTRAL_ACCENT);
  assert.equal(safeAccent('#fff'), NEUTRAL_ACCENT);
  assert.equal(safeAccent('#336699;}body{display:none'), NEUTRAL_ACCENT);
  assert.equal(safeAccent(undefined), NEUTRAL_ACCENT);
  assert.equal(safeAccent(null), NEUTRAL_ACCENT);
});

// Vacuous if the sample misses the hues that land in the dead zone between the
// two inks: sampling every hue is what makes the worst case real.
test('every accent a project can be given clears WCAG AA for pill text in both themes', () => {
  const accents = new Set<string>();
  // Every hue, not only the assignable bands: --accent takes any #rrggbb.
  for (let degree = 0; degree < 360; degree += 1) accents.add(hslHex(degree));
  assert.ok(accents.size >= 300, `only ${accents.size} distinct accents sampled`);

  for (const accent of accents) {
    const light = accentOnLight(accent);
    const dark = accentOnDark(accent);
    assert.ok(contrast(accentInk(light), light) >= 4.5, `${accentInk(light)} on ${light} is too weak`);
    assert.ok(contrast(accentInk(dark), dark) >= 4.5, `${accentInk(dark)} on ${dark} is too weak`);
  }
});

test('the accent stays visible as a rule against the page it is drawn on', () => {
  const board = { light: '#e8e6e1', dark: '#131211' };
  for (let degree = 0; degree < 360; degree += 1) {
    const accent = hslHex(degree);
    assert.ok(contrast(accentOnLight(accent), board.light) >= 3, `${accentOnLight(accent)} vanishes on the light page`);
    assert.ok(contrast(accentOnDark(accent), board.dark) >= 3, `${accentOnDark(accent)} vanishes on the dark page`);
  }
});

test('both theme variants keep the accent a valid hex, including for grey and for black', () => {
  for (const accent of ['#6f6860', '#000000', '#ffffff', '#808080']) {
    assert.match(accentOnLight(accent), /^#[0-9a-f]{6}$/);
    assert.match(accentOnDark(accent), /^#[0-9a-f]{6}$/);
  }
});
