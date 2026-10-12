/**
 * Minimal terminal colouring for log output. Replaces `chalk`, whose
 * transitive dependencies (supports-color, has-flag, ansi-styles, ...) pull in
 * an unmaintained package and add supply-chain surface for a few log colours.
 *
 * Colour is used only on a terminal, and is turned off by NO_COLOR or
 * TERM=dumb, or turned on by FORCE_COLOR, following the same conventions chalk
 * followed.
 */

type Env = Record<string, string | undefined>;
export type Painter = (text: string) => string;

export interface Colors {
  gray: Painter;
  red: Painter;
  green: Painter;
  yellow: Painter;
  blue: Painter;
  cyan: Painter;
}

// [open, close] SGR codes.
const CODES = {
  gray: [90, 39],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  cyan: [36, 39]
} as const;

function colorEnabled(env: Env, isTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return isTTY;
}

/** Build the colour functions for a given environment and output stream. */
export function createColors(env: Env, isTTY: boolean): Colors {
  const enabled = colorEnabled(env, isTTY);
  const paint =
    ([open, close]: readonly [number, number]): Painter =>
    (text) =>
      enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;

  return {
    gray: paint(CODES.gray),
    red: paint(CODES.red),
    green: paint(CODES.green),
    yellow: paint(CODES.yellow),
    blue: paint(CODES.blue),
    cyan: paint(CODES.cyan)
  };
}

/** Colours for the process's stdout. */
export const colors: Colors = createColors(
  process.env,
  Boolean(process.stdout.isTTY)
);
