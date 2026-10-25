'use client';

import { CSSProperties, useEffect, useRef } from 'react';

export type BalloonPhase = 'flying' | 'igniting' | 'crashing' | 'crashed';

export interface HotAirBalloonProps {
  /** Recolour the envelope only; undefined leaves the painted pixels untouched. */
  color?: string;
  /** Multiplier on the basket→sandbag rope length (0.5–1.6, default 1). */
  ropeLength?: number;
  /** Heads peeking over the basket rim (0–4). */
  people?: number;
  /** Whether the burner flame is lit. */
  burning?: boolean;
  /** Continuous burn time in ms before the envelope ignites. Default 60_000. */
  burnLimitMs?: number;
  /** Change this value to reset the balloon to its flying state. */
  resetKey?: unknown;
  onPhaseChange?: (phase: BalloonPhase) => void;
  onIgnite?: () => void;
  onCrash?: () => void;
  balloonSrc?: string;
  sacksSrc?: string;
  width?: number | string;
  className?: string;
  style?: CSSProperties;
}

/* ---------- geometry: Figma "Balloon - weighed down (v2 level)" units ------ */
/* Ported 1:1 from the different.ai hero rig (__dfxBalloon).                  */

const BAL = {
  nw: 1147,
  nh: 1371,
  cx: 360.667,
  cy: 415.649,
  w: 619.181,
  h: 740.148,
  ix: -9.04,
  iy: 1.554,
  iw: 619.429,
  ih: 740.148,
  rot: -5,
};

interface Sack {
  cx: number;
  cy: number;
  w: number;
  h: number;
  ox: number;
  sw: number;
  rot: number;
  kx: number;
  ky: number;
}
const SACKS: Sack[] = [
  { cx: 425.63, cy: 1143.13, w: 61.277, h: 125.324, ox: -184.52, sw: 375.97, rot: -3.6, kx: 417.3, ky: 1120.8 },
  { cx: 536.88, cy: 1131.09, w: 70.261, h: 137.857, ox: -343.31, sw: 413.57, rot: -9.81, kx: 525.5, ky: 1118.2 },
  { cx: 383.25, cy: 1168.5, w: 64.705, h: 131.591, ox: -71.43, sw: 394.77, rot: -2.8, kx: 381.8, ky: 1145.5 },
  { cx: 491.86, cy: 1156.56, w: 71.43, h: 131.591, ox: 0, sw: 394.77, rot: -16.2, kx: 499.8, ky: 1132.1 },
  { cx: 451.92, cy: 1178.06, w: 72.927, h: 137.857, ox: -270.38, sw: 413.57, rot: -8.8, kx: 447.8, ky: 1153.6 },
  { cx: 583.93, cy: 1165.51, w: 54.873, h: 125.324, ox: -129.65, sw: 375.97, rot: -30.55, kx: 566.3, ky: 1141.9 },
];
const KNOTS = SACKS.slice().sort((a, b) => a.kx - b.kx);
const SLACK = [1.004, 1.006, 1.003, 1.005, 1.003, 1.005];
const EASE_OFF = 1.035;
const P0 = SACKS.reduce((a, k) => [a[0] + k.cx / 6, a[1] + k.cy / 6], [0, 0]);

// basket-floor rope anchors in natural image px (x spread, y = floor line)
const anchorX = (i: number) => 532 + ((606 - 532) * i) / 5;
const ANCHOR_Y = 1290;

/* ------- measured pixel facts about the balloon bitmap (1147×1371) -------- */
const ENV_MAX_Y = 1130; // envelope skirt: nothing above this line is basket
const FLAME_BOX = { x0: 532, y0: 965, x1: 602, y1: 1105 };
const MOUTH_BOTTOM = 1035; // flame pixels above → mouth interior, below → erased
const MOUTH_FILL = { x0: 510, x1: 545 }; // maroon mouth-interior sample band
const BASKET_FRONT = { x0: 505, y0: 1182, x1: 625, y1: 1302 }; // rim occluder
const RIM_Y = 1178; // heads peek over this line
const BASKET_BOTTOM_NY = 1300; // natural y of the basket floor
// scale group-units ↔ natural px inside the balloon element
const KX = BAL.iw / BAL.nw;
const KY = BAL.ih / BAL.nh;
// group-unit y of the basket floor (what hits the ground)
const BASKET_FLOOR_G = BAL.cy - BAL.h / 2 + BAL.iy + BASKET_BOTTOM_NY * KY; // ≈ 703.7

/* stage (group units): contains rest pose at ropeLength 1.6 plus crash room */
const STAGE = { x0: -60, y0: -10, w: 800, h: 1610 };
const GROUND = 1570;

const SRC_HUE = 15 / 360;
const SRC_SAT = 0.68;
const SRC_LIT = 0.82;

const MAX_PARTICLES = 46;
const ROPE_N = 40;

const SKIN = ['#e9b98c', '#c98e5f', '#8c5a34', '#f2cfae'];
const HAIR = ['#3a2a1c', '#191008', '#7a4a22', '#5c5348'];

/* ------------------------------ math helpers ----------------------------- */

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (t: number) => t * t * (3 - 2 * t);

interface Spring {
  p: number;
  v: number;
}
const mkSpring = (p = 0): Spring => ({ p, v: 0 });
function spring(m: Spring, target: number, k: number, c: number, dt: number) {
  const a = (target - m.p) * k - m.v * c;
  m.v += a * dt;
  m.p += m.v * dt;
}

interface Rope {
  x: Float32Array;
  y: Float32Array;
}
// exact catenary through two points for a rope of length L (screen y down)
function catenary(R: Rope, x1: number, y1: number, x2: number, y2: number, L: number) {
  let h = x2 - x1;
  const dir = h < 0 ? -1 : 1;
  h = Math.max(Math.abs(h), 2);
  const v = y1 - y2;
  const d = Math.sqrt(h * h + v * v);
  L = clamp(L, d * 1.0005, d * 1.6);
  const rr = Math.sqrt(L * L - v * v) / h;
  let xi = rr < 3 ? Math.sqrt(6 * (rr - 1)) : Math.log(2 * rr) + 1;
  for (let k = 0; k < 40; k++) {
    const f = Math.sinh(xi) - rr * xi;
    const df = Math.cosh(xi) - rr;
    const nx = xi - f / df;
    if (!(nx > 1e-7)) {
      xi *= 0.5;
      continue;
    }
    if (Math.abs(nx - xi) < 1e-9) {
      xi = nx;
      break;
    }
    xi = nx;
  }
  const a = h / (2 * xi);
  const xm = h / 2 - a * Math.atanh(clamp(v / L, -0.999999, 0.999999));
  const c = -a * Math.cosh(-xm / a);
  for (let i = 0; i < ROPE_N; i++) {
    const x = (h * i) / (ROPE_N - 1);
    R.x[i] = x1 + dir * x;
    R.y[i] = y1 - (a * Math.cosh((x - xm) / a) + c);
  }
  R.x[ROPE_N - 1] = x2;
  R.y[ROPE_N - 1] = y2;
}

function hexToHsl(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = 0;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (mx === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 1) + 1) % 1;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = 0;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (mx === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

/* ------------------------------ sim state -------------------------------- */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  r: number;
  smoke: boolean;
}

interface SackState {
  off: number; // vertical offset added by falling (group units)
  v: number;
  grounded: boolean;
  bounced: boolean;
  rot: number; // extra rotation once down
}

interface Sim {
  phase: BalloonPhase;
  loadX: Spring;
  loadY: Spring;
  bx: Spring;
  by: Spring;
  lean: Spring;
  duck: Spring;
  flame: Spring;
  envFire: Spring;
  scorch: Spring;
  char: Spring;
  deflate: Spring;
  squash: Spring;
  sacks: SackState[];
  burnMs: number;
  igniteT: number;
  crashVx: number;
  side: number;
  emitAcc: number;
  emberT: number;
  particles: Particle[];
  fired: { ignite: boolean; crash: boolean };
}

const freshSim = (): Sim => ({
  phase: 'flying',
  loadX: mkSpring(),
  loadY: mkSpring(),
  bx: mkSpring(),
  by: mkSpring(),
  lean: mkSpring(),
  duck: mkSpring(),
  flame: mkSpring(),
  envFire: mkSpring(),
  scorch: mkSpring(),
  char: mkSpring(),
  deflate: mkSpring(),
  squash: mkSpring(),
  sacks: SACKS.map(() => ({ off: 0, v: 0, grounded: false, bounced: false, rot: 0 })),
  burnMs: 0,
  igniteT: 0,
  crashVx: 0,
  side: 1,
  emitAcc: 0,
  emberT: 0,
  particles: [],
  fired: { ignite: false, crash: false },
});

/* --------------------------- bitmap preparation -------------------------- */

interface Prepared {
  bmp: HTMLCanvasElement; // full balloon bitmap: flame erased, recoloured
  upper: HTMLCanvasElement; // rows 0..ENV_MAX_Y (deflates)
  lower: HTMLCanvasElement; // rows ENV_MAX_Y..nh (basket, never recoloured)
  mask: HTMLCanvasElement; // envelope alpha (for scorch/char clipping)
  front: HTMLCanvasElement; // basket-front crop that occludes the people
  heads: HTMLCanvasElement | null;
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

function isFlame(r: number, g: number, b: number, a: number) {
  return a > 100 && r > 195 && g > 110 && b < 150 && r - b > 80 && g - b > 20;
}

function prepare(img: HTMLImageElement, color: string | undefined, people: number): Prepared {
  const W = BAL.nw;
  const H = BAL.nh;
  const base = document.createElement('canvas');
  base.width = W;
  base.height = H;
  const bctx = base.getContext('2d')!;
  bctx.drawImage(img, 0, 0, W, H);
  const data = bctx.getImageData(0, 0, W, H);
  const d = data.data;

  // -- envelope region: per column, the contiguous opaque run from the top --
  const envEnd = new Int32Array(W).fill(-1);
  for (let x = 0; x < W; x++) {
    let started = false;
    let end = -1;
    let gap = 0;
    for (let y = 0; y < H; y++) {
      const a = d[(y * W + x) * 4 + 3];
      if (a > 110) {
        started = true;
        end = y;
        gap = 0;
      } else if (started) {
        if (++gap > 10) break;
      }
    }
    envEnd[x] = end;
  }

  // -- erase the painted flame --
  const mouthCol = { r: 110, g: 32, b: 62 };
  for (let y = FLAME_BOX.y0; y <= FLAME_BOX.y1; y++) {
    for (let x = FLAME_BOX.x0; x <= FLAME_BOX.x1; x++) {
      const i = (y * W + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const a = d[i + 3];
      if (!isFlame(r, g, b, a)) continue;
      if (y < MOUTH_BOTTOM) {
        // inside the dark mouth opening → mouth interior colour
        for (let sx = x - 1; sx >= MOUTH_FILL.x0; sx--) {
          const j = (y * W + sx) * 4;
          if (d[j + 3] > 200 && d[j] < 170 && d[j + 1] < 80) {
            mouthCol.r = d[j];
            mouthCol.g = d[j + 1];
            mouthCol.b = d[j + 2];
            break;
          }
        }
        d[i] = mouthCol.r;
        d[i + 1] = mouthCol.g;
        d[i + 2] = mouthCol.b;
      } else {
        d[i + 3] = 0; // below the mouth → transparent
      }
    }
  }

  // -- recolour envelope pixels --
  const target = color ? hexToHsl(color) : null;
  if (target) {
    const dh = target[0] - SRC_HUE;
    const sMul = SRC_SAT > 0.05 ? clamp(target[1] / SRC_SAT, 0, 2.2) : 0;
    const lShift = (target[2] - SRC_LIT) * 0.5;
    for (let x = 0; x < W; x++) {
      const end = envEnd[x];
      if (end < 0) continue;
      for (let y = 0; y <= Math.min(end, ENV_MAX_Y + 8); y++) {
        const i = (y * W + x) * 4;
        if (d[i + 3] === 0) continue;
        const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
        const ns = clamp(s * sMul, 0, 1);
        const nl = clamp(l + lShift * (s > 0.05 ? 1 : 0), 0, 1);
        // compress the painted hue spread (maroon shadows ↔ orange lights) around the target
        // so shadows stay a deep shade of the chosen colour instead of rotating off to another hue
        const off = ((((h - SRC_HUE) % 1) + 1.5) % 1) - 0.5;
        const [r, g, b] = hslToRgb(SRC_HUE + dh + off * 0.2, ns, nl);
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
      }
    }
  }
  bctx.putImageData(data, 0, 0);

  // envelope alpha mask (for scorch/char clipping) — region pixels only
  const mask = document.createElement('canvas');
  mask.width = W;
  mask.height = H;
  const mctx = mask.getContext('2d')!;
  const md = mctx.createImageData(W, H);
  for (let x = 0; x < W; x++) {
    const end = Math.min(envEnd[x], ENV_MAX_Y + 8);
    for (let y = 0; y <= end; y++) {
      const i = (y * W + x) * 4;
      md.data[i + 3] = d[i + 3];
    }
  }
  mctx.putImageData(md, 0, 0);

  // upper / lower slices
  const mk = (y0: number, y1: number) => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = y1 - y0;
    c.getContext('2d')!.drawImage(base, 0, y0, W, y1 - y0, 0, 0, W, y1 - y0);
    return c;
  };
  const upper = mk(0, ENV_MAX_Y);
  const lower = mk(ENV_MAX_Y, H);

  // basket-front occluder (original pixels — never recoloured, never deflated)
  const front = document.createElement('canvas');
  front.width = BASKET_FRONT.x1 - BASKET_FRONT.x0;
  front.height = BASKET_FRONT.y1 - BASKET_FRONT.y0;
  front
    .getContext('2d')!
    .drawImage(
      img,
      BASKET_FRONT.x0,
      BASKET_FRONT.y0,
      front.width,
      front.height,
      0,
      0,
      front.width,
      front.height,
    );

  // heads peeking over the rim (natural px; canvas top-left = (x0, RIM_Y-34))
  let heads: HTMLCanvasElement | null = null;
  const n = clamp(Math.round(people), 0, 4);
  if (n > 0) {
    const top = RIM_Y - 34;
    heads = document.createElement('canvas');
    heads.width = BASKET_FRONT.x1 - BASKET_FRONT.x0;
    heads.height = BASKET_FRONT.y0 - top + 4;
    const hc = heads.getContext('2d')!;
    const cx = (BASKET_FRONT.x0 + BASKET_FRONT.x1) / 2;
    for (let i = 0; i < n; i++) {
      const hx = cx + (i - (n - 1) / 2) * 22 + (i % 2 ? 3 : -3);
      const hy = RIM_Y - (i % 2) * 4;
      drawHead(hc, hx - BASKET_FRONT.x0, hy - top, 15, SKIN[i % SKIN.length], HAIR[i % HAIR.length]);
    }
  }

  return { bmp: base, upper, lower, mask, front, heads };
}
function drawHead(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  skin: string,
  hair: string,
) {
  c.save();
  c.translate(x, y);
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.fillStyle = skin;
  c.fill();
  c.lineWidth = 1.6;
  c.strokeStyle = 'rgba(60,35,18,.55)';
  c.stroke();
  c.beginPath(); // hair cap
  c.arc(0, 0, r - 1, Math.PI * 1.05, Math.PI * 1.95);
  c.lineTo(-r + 1, -2);
  c.closePath();
  c.fillStyle = hair;
  c.fill();
  c.restore();
}

/* ------------------------------- component ------------------------------- */

export function HotAirBalloon({
  color,
  ropeLength = 1,
  people = 0,
  burning = false,
  burnLimitMs = 60_000,
  resetKey,
  onPhaseChange,
  onIgnite,
  onCrash,
  balloonSrc = '/dfx/balloon.webp',
  sacksSrc = '/dfx/sacks.webp',
  width = '100%',
  className,
  style,
}: HotAirBalloonProps) {
  const ropeMul = clamp(ropeLength, 0.5, 1.6);
  const headCount = clamp(Math.round(people), 0, 4);

  const rootRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const upperRef = useRef<HTMLCanvasElement>(null);
  const lowerRef = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<HTMLCanvasElement>(null);
  const headsRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);
  const ropeCvRef = useRef<HTMLCanvasElement>(null);
  const sackRefs = useRef<(HTMLDivElement | null)[]>([]);

  const propsRef = useRef({ burning, burnLimitMs, ropeMul, onPhaseChange, onIgnite, onCrash });
  propsRef.current = { burning, burnLimitMs, ropeMul, onPhaseChange, onIgnite, onCrash };

  // prepared bitmap lives in a ref so the rAF loop can reach it
  const prepRef = useRef<Prepared | null>(null);

  // paint prepared canvases into the DOM canvases whenever inputs change
  useEffect(() => {
    let live = true;
    loadImg(balloonSrc)
      .then((img) => {
        if (!live) return;
        const p = prepare(img, color, headCount);
        prepRef.current = p;
        const paint = (cv: HTMLCanvasElement | null, src: HTMLCanvasElement) => {
          if (!cv) return;
          cv.width = src.width;
          cv.height = src.height;
          cv.getContext('2d')!.clearRect(0, 0, src.width, src.height);
          cv.getContext('2d')!.drawImage(src, 0, 0);
        };
        paint(upperRef.current, p.upper);
        paint(lowerRef.current, p.lower);
        paint(frontRef.current, p.front);
        const hd = headsRef.current;
        if (hd) {
          if (p.heads) paint(hd, p.heads);
          else hd.getContext('2d')!.clearRect(0, 0, hd.width, hd.height);
        }
        if (fxRef.current) {
          fxRef.current.width = BAL.nw;
          fxRef.current.height = BAL.nh;
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [balloonSrc, color, headCount, resetKey]);

  // layout: scale with container width
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let s = 1;
    const apply = () => {
      s = root.clientWidth / STAGE.w;
      const group = groupRef.current;
      if (group) {
        group.style.width = BAL.iw * s + 'px';
        group.style.height = BAL.ih * s + 'px';
        group.style.transformOrigin = `${(BAL.w / 2 - BAL.ix) * s}px ${(BAL.h / 2 - BAL.iy) * s}px`;
      }
      const kx = KX * s;
      const ky = KY * s;
      // full-box canvases inside the group, expressed in natural-px coords
      for (const ref of [upperRef, lowerRef, fxRef]) {
        const cv = ref.current;
        if (!cv) continue;
        cv.style.position = 'absolute';
        cv.style.width = BAL.iw * s + 'px';
      }
      if (upperRef.current) upperRef.current.style.height = ENV_MAX_Y * ky + 'px';
      if (lowerRef.current) {
        lowerRef.current.style.height = (BAL.nh - ENV_MAX_Y) * ky + 'px';
        lowerRef.current.style.top = ENV_MAX_Y * ky + 'px';
      }
      if (fxRef.current) fxRef.current.style.height = BAL.ih * s + 'px';
      if (frontRef.current) {
        const f = frontRef.current;
        f.style.position = 'absolute';
        f.style.left = BASKET_FRONT.x0 * kx + 'px';
        f.style.top = BASKET_FRONT.y0 * ky + 'px';
        f.style.width = (BASKET_FRONT.x1 - BASKET_FRONT.x0) * kx + 'px';
        f.style.height = (BASKET_FRONT.y1 - BASKET_FRONT.y0) * ky + 'px';
      }
      if (headsRef.current) {
        const hd = headsRef.current;
        hd.style.position = 'absolute';
        hd.style.left = BASKET_FRONT.x0 * kx + 'px';
        hd.style.top = (RIM_Y - 34) * ky + 'px';
        hd.style.width = (BASKET_FRONT.x1 - BASKET_FRONT.x0) * kx + 'px';
        hd.style.height = (BASKET_FRONT.y0 - (RIM_Y - 34) + 4) * ky + 'px';
      }
      // sacks
      SACKS.forEach((k, i) => {
        const el = sackRefs.current[i];
        if (!el) return;
        const im = el.firstElementChild as HTMLElement | null;
        el.style.width = k.w * s + 'px';
        el.style.height = k.h * s + 'px';
        if (im) {
          im.style.width = k.sw * s + 'px';
          im.style.height = k.h * s + 'px';
          im.style.left = k.ox * s + 'px';
        }
      });
      const cv = ropeCvRef.current;
      if (cv) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        cv.width = Math.round(STAGE.w * s * dpr);
        cv.height = Math.round(STAGE.h * s * dpr);
        cv.style.width = STAGE.w * s + 'px';
        cv.style.height = STAGE.h * s + 'px';
        cv.dataset.dpr = String(dpr);
        cv.dataset.s = String(s);
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(root);
    return () => ro.disconnect();
  }, [resetKey]);

  /* ------------------------------ animation ------------------------------ */
  useEffect(() => {
    const st = freshSim();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = 0;
    let pI = 0;
    const ropes: Rope[] = Array.from({ length: 6 }, () => ({
      x: new Float32Array(ROPE_N),
      y: new Float32Array(ROPE_N),
    }));

    // rest rope lengths, honouring the ropeLength multiplier (load moved
    // along the basket-floor→load vector)
    const ropeL = (mul: number) => {
      const A0 = (BAL.rot * Math.PI) / 180;
      const c0 = Math.cos(A0);
      const s0 = Math.sin(A0);
      const floorY = (() => {
        let acc = 0;
        for (let i = 0; i < 6; i++) {
          const ly = BAL.iy + ANCHOR_Y * KY - BAL.h / 2;
          acc += BAL.cy + ly * c0; // sin term cancels on average
        }
        return acc / 6;
      })();
      const dy = (P0[1] - floorY) * (mul - 1);
      const out: number[] = [];
      for (let i = 0; i < 6; i++) {
        const nx = anchorX(i);
        const lx = BAL.ix + nx * KX - BAL.w / 2;
        const ly = BAL.iy + ANCHOR_Y * KY - BAL.h / 2;
        const qx = BAL.cx + lx * c0 - ly * s0;
        const qy = BAL.cy + lx * s0 + ly * c0;
        const K = KNOTS[i];
        out.push(Math.hypot(K.kx - qx, K.ky + dy - qy) * SLACK[i]);
      }
      return { L: out, dy };
    };

    const setPhase = (phase: BalloonPhase) => {
      if (st.phase === phase) return;
      st.phase = phase;
      propsRef.current.onPhaseChange?.(phase);
    };

    const spawn = (x: number, y: number, smoke: boolean, spread = 1) => {
      const i = pI;
      pI = (pI + 1) % MAX_PARTICLES;
      const p =
        st.particles[i] ??
        (st.particles[i] = { x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, r: 2, smoke });
      p.x = x + (Math.random() - 0.5) * 30 * spread;
      p.y = y + (Math.random() - 0.5) * 14 * spread;
      if (smoke) {
        p.vx = (Math.random() - 0.5) * 14 - 6;
        p.vy = -(26 + Math.random() * 30);
        p.maxLife = 1.7 + Math.random() * 1.3;
        p.r = 6 + Math.random() * 8;
      } else {
        p.vx = (Math.random() - 0.5) * 190;
        p.vy = -(20 + Math.random() * 70);
        p.maxLife = 0.7 + Math.random() * 0.5;
        p.r = 4 + Math.random() * 6;
      }
      p.smoke = smoke;
      p.life = p.maxLife;
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.033, last ? (now - last) / 1000 : 0.016);
      last = now;
      const t = now / 1000;
      const P = propsRef.current;
      const prep = prepRef.current;
      const cv = ropeCvRef.current;
      const group = groupRef.current;
      if (!cv || !group) return;
      const s = Number(cv.dataset.s || 1);
      const dpr = Number(cv.dataset.dpr || 1);
      const ctx = cv.getContext('2d')!;
      const { L: ROPE_L, dy: ropeDy } = ropeL(P.ropeMul);
      const calm = reduce ? 0 : 1;
      let jx = 0;
      let jy = 0;

      /* ------- phase machine ------- */
      if (st.phase === 'flying') {
        // load target = rest; idle float sines drive everything (calm = 1)
        spring(st.loadX, 0, 22, 5.2, dt);
        spring(st.loadY, 0, 22, 6, dt);
        spring(st.bx, 0, 9, 4.2, dt);
        const liftTarget = P.burning ? -14 * st.flame.p : 0;
        spring(st.by, liftTarget, 9, 4.6, dt);
        spring(st.lean, -st.bx.v * 0.0004, 14, 5.5, dt);
        spring(st.flame, P.burning ? 1 : 0, 14, 7, dt);
        spring(st.duck, 0, 12, 6, dt);
        spring(st.envFire, 0, 8, 5, dt);
        spring(st.char, 0, 6, 5, dt);
        spring(st.deflate, 0, 6, 4, dt);
        spring(st.squash, 0, 42, 7, dt);
        if (P.burning) {
          st.burnMs += dt * 1000;
          const frac = st.burnMs / P.burnLimitMs;
          spring(st.scorch, smooth(clamp((frac - 0.55) / 0.45, 0, 1)) * 0.45, 10, 6, dt);
          if (st.burnMs >= P.burnLimitMs) {
            setPhase('igniting');
            st.igniteT = 0;
            if (!st.fired.ignite) {
              st.fired.ignite = true;
              P.onIgnite?.();
            }
          }
        } else {
          st.burnMs = 0;
          spring(st.scorch, 0, 10, 6, dt);
        }
      } else if (st.phase === 'igniting') {
        st.igniteT += dt;
        const k = clamp(st.igniteT / 1.5, 0, 1);
        jx = Math.sin(t * 47) * 3.5 * k * calm;
        jy = Math.cos(t * 39) * 2.6 * k * calm;
        spring(st.by, -90, 8, 4.6, dt); // hot air still lifting — strains upward
        spring(st.bx, 0, 8, 4.2, dt);
        spring(st.lean, Math.sin(t * 9) * 0.06 * k, 10, 4, dt);
        spring(st.flame, 1, 14, 7, dt);
        spring(st.envFire, 1.35, 9, 4.5, dt);
        spring(st.scorch, 0.9, 8, 5, dt);
        spring(st.duck, 1, 12, 6, dt);
        if (st.igniteT >= 1.5) {
          st.side = Math.random() < 0.5 ? -1 : 1;
          st.crashVx = st.side * (16 + Math.random() * 20);
          st.by.v = 40;
          setPhase('crashing');
        }
      } else if (st.phase === 'crashing') {
        spring(st.deflate, 1, 6, 4, dt);
        spring(st.char, 0.85, 5, 5, dt);
        spring(st.scorch, 1, 5, 5, dt);
        spring(st.flame, 0.15, 8, 6, dt);
        st.by.v += 620 * dt * (0.3 + 0.7 * st.deflate.p);
        st.by.v = Math.min(st.by.v, 430);
        st.by.p += st.by.v * dt;
        st.bx.p += st.crashVx * dt;
        st.bx.p = clamp(st.bx.p, -80, 80);
        st.crashVx *= 1 - 0.5 * dt;
        spring(st.lean, st.side * 0.55 + Math.sin(t * 2.6) * 0.12, 6, 3, dt);
        // sandbags are heavy — they drop first
        st.sacks.forEach((sk, i) => {
          const k = SACKS[i];
          if (!sk.grounded) {
            sk.v += 1500 * dt;
            sk.off += sk.v * dt;
            const bottom = k.cy + ropeDy + k.h / 2 + sk.off;
            if (bottom >= GROUND) {
              sk.off = GROUND - (k.cy + ropeDy + k.h / 2);
              if (!sk.bounced) {
                sk.v = -sk.v * 0.22;
                sk.bounced = true;
              } else {
                sk.v = 0;
                sk.grounded = true;
              }
            }
          }
          if (sk.bounced)
            sk.rot += (st.side * (55 + i * 7) - k.rot - sk.rot) * Math.min(1, dt * 8);
        });
        const basketFloor = BASKET_FLOOR_G + st.by.p;
        if (basketFloor >= GROUND) {
          st.by.p = GROUND - BASKET_FLOOR_G;
          st.by.v = 0;
          st.squash.v = 5;
          for (let i = 0; i < 12; i++)
            spawn(BAL.cx + st.bx.p, GROUND - 8, false, 2.4);
          setPhase('crashed');
          if (!st.fired.crash) {
            st.fired.crash = true;
            P.onCrash?.();
          }
        }
      } else {
        st.emberT += dt;
        spring(st.lean, st.side * 0.16, 7, 5, dt);
        spring(st.envFire, st.emberT < 2.5 ? 0.28 : 0.1, 4, 4, dt);
        spring(st.flame, 0, 6, 6, dt);
        spring(st.squash, 0, 42, 7, dt);
        spring(st.deflate, 1.15, 5, 5, dt);
        st.sacks.forEach((sk, i) => {
          const k = SACKS[i];
          sk.rot += (st.side * (55 + i * 7) - k.rot - sk.rot) * Math.min(1, dt * 5);
        });
      }

      /* ------- render (DOM writes only) ------- */
      // idle float (calm = 1 unless reduced motion)
      const bobAmp = 1 + 0.4 * st.flame.p;
      const fx = Math.sin(t * 0.5) * 7 * calm;
      const fy = (Math.sin(t * 0.9) * 10 + Math.sin(t * 0.37) * 5) * calm * bobAmp;
      const fr = Math.sin(t * 0.6 + 0.6) * 0.014 * calm;
      const lfx = Math.sin(t * 0.5 - 0.6) * 7 * calm;
      const lfy = (Math.sin(t * 0.9 - 0.8) * 10 + Math.sin(t * 0.37 - 0.4) * 5) * calm;

      const bcx = BAL.cx + st.bx.p + fx + jx;
      const bcy = BAL.cy + st.by.p + fy + jy;
      const A = (BAL.rot * Math.PI) / 180 + st.lean.p + fr;
      const cs = Math.cos(A);
      const sn = Math.sin(A);
      const bl = (bcx - BAL.w / 2 + BAL.ix - STAGE.x0) * s;
      const bt = (bcy - BAL.h / 2 + BAL.iy - STAGE.y0) * s;
      group.style.transform = `translate3d(${bl.toFixed(1)}px,${bt.toFixed(1)}px,0) rotate(${A.toFixed(4)}rad)`;

      // deflate: squash the upper slice + fx layer toward the mouth line
      const defW = 1 + 0.18 * st.deflate.p;
      const defK = 1 - 0.55 * st.deflate.p;
      const pivotY = ENV_MAX_Y * KY * s;
      const pivotX = (565 / BAL.nw) * BAL.iw * s;
      for (const ref of [upperRef, fxRef]) {
        const el = ref.current;
        if (!el) continue;
        el.style.transformOrigin = `${pivotX}px ${pivotY}px`;
        el.style.transform = `scale(${defW.toFixed(4)},${defK.toFixed(4)})`;
      }
      if (lowerRef.current) {
        const k = 1 - 0.16 * clamp(st.squash.p, -0.6, 1.4);
        lowerRef.current.style.transformOrigin = `50% ${(BAL.nh - ENV_MAX_Y) * KY * s}px`;
        lowerRef.current.style.transform = `scale(1,${k.toFixed(4)})`;
      }
      if (headsRef.current) {
        headsRef.current.style.transform = `translateY(${(st.duck.p * 46 * KY * s).toFixed(1)}px)`;
        headsRef.current.style.opacity = headCount ? '1' : '0';
      }

      // sandbags
      const dx = st.loadX.p + lfx;
      const dy = st.loadY.p + lfy + ropeDy;
      const falling = st.phase === 'crashing' || st.phase === 'crashed';
      SACKS.forEach((k, i) => {
        const el = sackRefs.current[i];
        if (!el) return;
        const sk = st.sacks[i];
        const l = (k.cx - k.w / 2 + dx - STAGE.x0) * s;
        const tp = (k.cy - k.h / 2 + dy + sk.off - STAGE.y0) * s;
        const sw =
          -st.loadX.v * (0.05 + 0.012 * i) +
          Math.sin(t * 1.1 + i * 1.3) * 1.2 * calm +
          st.lean.p * 40;
        const rot = falling ? k.rot + sk.rot : k.rot + clamp(sw, -14, 14);
        el.style.transform = `translate3d(${l.toFixed(1)}px,${tp.toFixed(1)}px,0) rotate(${rot.toFixed(2)}deg)`;
      });

      // fx canvas: scorch/char overlay, burner flame, envelope fire
      const fxc = fxRef.current;
      if (fxc && prep) {
        const fxctx = fxc.getContext('2d')!;
        if (fxc.width !== BAL.nw) {
          fxc.width = BAL.nw;
          fxc.height = BAL.nh;
        }
        fxctx.clearRect(0, 0, BAL.nw, BAL.nh);
        const dark = Math.max(st.scorch.p, st.char.p);
        if (dark > 0.003) {
          fxctx.save();
          fxctx.globalAlpha = clamp(dark, 0, 0.92);
          fxctx.drawImage(prep.mask, 0, 0);
          fxctx.globalCompositeOperation = 'source-in';
          fxctx.fillStyle = st.char.p > 0.4 ? '#120b06' : '#22100a';
          fxctx.fillRect(0, 0, BAL.nw, BAL.nh);
          fxctx.restore();
        }
        // live burner flame
        const fl = st.flame.p;
        if (fl > 0.01) {
          const flick =
            Math.sin(t * 13) * 0.2 + Math.sin(t * 23.7) * 0.1 + Math.sin(t * 5.3) * 0.07;
          const fh = (118 * (1 + flick)) * fl;
          const fw = 34 * fl * (1 - flick * 0.3);
          const baseX = 566 + Math.sin(t * 3.1) * 3 * fl;
          const baseY = 1100;
          fxctx.save();
          fxctx.globalAlpha = clamp(fl * 1.5, 0, 1);
          const grad = fxctx.createRadialGradient(baseX, baseY - fh * 0.4, 2, baseX, baseY - fh * 0.35, fh * 0.7);
          grad.addColorStop(0, 'rgba(255,190,80,.55)');
          grad.addColorStop(1, 'rgba(255,120,20,0)');
          fxctx.fillStyle = grad;
          fxctx.beginPath();
          fxctx.arc(baseX, baseY - fh * 0.4, fh * 0.7, 0, Math.PI * 2);
          fxctx.fill();
          const teardrop = (h: number, w: number, fill: string) => {
            fxctx.beginPath();
            fxctx.moveTo(baseX, baseY);
            fxctx.bezierCurveTo(baseX - w, baseY - h * 0.25, baseX - w * 0.55, baseY - h * 0.75, baseX, baseY - h);
            fxctx.bezierCurveTo(baseX + w * 0.55, baseY - h * 0.75, baseX + w, baseY - h * 0.25, baseX, baseY);
            fxctx.fillStyle = fill;
            fxctx.fill();
          };
          teardrop(fh, fw, '#ff7a1f');
          teardrop(fh * 0.62, fw * 0.55, '#ffc23e');
          teardrop(fh * 0.35, fw * 0.28, '#ffe98a');
          fxctx.restore();
        }
        // envelope fire sprites
        if (st.envFire.p > 0.01) {
          const spots = [
            [522, 1005, -0.3, 0.62],
            [566, 1035, 0, 0.8],
            [610, 1000, 0.3, 0.6],
            [540, 900, -0.2, 0.5],
            [592, 905, 0.2, 0.5],
          ];
          fxctx.save();
          fxctx.globalAlpha = clamp(st.envFire.p, 0, 1);
          spots.forEach((sp, i) => {
            const grow = i < 3 ? 1 : 0.25 + 0.75 * st.deflate.p;
            const fs = Math.max(0.001, st.envFire.p * sp[3] * grow * (0.8 + 0.35 * Math.sin(t * 11 + i * 2.3)));
            const h = 95 * fs;
            const w = 30 * fs;
            const x = sp[0];
            const y = sp[1];
            fxctx.save();
            fxctx.translate(x, y);
            fxctx.rotate(sp[2]);
            fxctx.beginPath();
            fxctx.moveTo(0, 0);
            fxctx.bezierCurveTo(-w, -h * 0.25, -w * 0.5, -h * 0.8, 0, -h);
            fxctx.bezierCurveTo(w * 0.5, -h * 0.8, w, -h * 0.25, 0, 0);
            fxctx.fillStyle = '#ff6d16';
            fxctx.fill();
            fxctx.beginPath();
            fxctx.moveTo(0, 0);
            fxctx.bezierCurveTo(-w * 0.5, -h * 0.15, -w * 0.25, -h * 0.45, 0, -h * 0.55);
            fxctx.bezierCurveTo(w * 0.25, -h * 0.45, w * 0.5, -h * 0.15, 0, 0);
            fxctx.fillStyle = '#ffd23e';
            fxctx.fill();
            fxctx.restore();
          });
          fxctx.restore();
        }
      }

      // smoke/dust emission (group units; scaled by s at draw time)
      const mouthGX = bcx - BAL.w / 2 + BAL.ix + 565 * KX - STAGE.x0;
      const mouthGY = bcy - BAL.h / 2 + BAL.iy + 1030 * KY - STAGE.y0;
      const emitRate =
        st.phase === 'igniting' ? 22 : st.phase === 'crashing' ? 32 : st.phase === 'crashed' && st.emberT < 2.5 ? 5 : 0;
      st.emitAcc += emitRate * dt;
      while (st.emitAcc >= 1) {
        st.emitAcc -= 1;
        spawn(mouthGX, mouthGY, true);
      }
      for (const p of st.particles) {
        if (!p || p.life <= 0) continue;
        p.life -= dt;
        if (p.smoke) {
          p.vy -= 16 * dt;
          p.vx *= 1 - 0.6 * dt;
        } else {
          p.vy += 320 * dt;
          p.vx *= 1 - 3.5 * dt;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }

      // ropes + particles on the big canvas (all in stage px)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, STAGE.w * s, STAGE.h * s);
      const w = Math.max(1.4, 3 * s);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 0; i < 6; i++) {
        const nx = anchorX(i);
        const lx = BAL.ix + nx * KX - BAL.w / 2;
        const ly = BAL.iy + ANCHOR_Y * KY - BAL.h / 2;
        const qx = (bcx + lx * cs - ly * sn - STAGE.x0) * s;
        const qy = (bcy + lx * sn + ly * cs - STAGE.y0) * s;
        const K = KNOTS[i];
        const ki = SACKS.indexOf(K);
        const sk = st.sacks[ki];
        const kx = (K.kx + dx - STAGE.x0) * s;
        const ky = (K.ky + dy + sk.off - STAGE.y0) * s;
        const d = Math.hypot(kx - qx, ky - qy);
        const R = ropes[i];
        catenary(R, qx, qy, kx, ky, clamp(ROPE_L[i] * s, d * 1.002, Math.max(d * EASE_OFF, ROPE_L[i] * s)));
        // 3-stroke rendering from the original rig
        ctx.beginPath();
        ctx.moveTo(R.x[0], R.y[0]);
        for (let j = 1; j < ROPE_N - 1; j++)
          ctx.quadraticCurveTo(R.x[j], R.y[j], (R.x[j] + R.x[j + 1]) / 2, (R.y[j] + R.y[j + 1]) / 2);
        ctx.lineTo(R.x[ROPE_N - 1], R.y[ROPE_N - 1]);
        ctx.strokeStyle = 'rgba(135,69,7,.85)';
        ctx.lineWidth = w + 0.8;
        ctx.stroke();
        ctx.strokeStyle = '#cc8a44';
        ctx.lineWidth = w;
        ctx.stroke();
        ctx.save();
        ctx.translate(-w * 0.12, -w * 0.12);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(250,196,126,.75)';
        ctx.lineWidth = w * 0.38;
        ctx.stroke();
        ctx.restore();
      }
      // particles
      for (const p of st.particles) {
        if (!p || p.life <= 0) continue;
        const f = p.life / p.maxLife;
        ctx.beginPath();
        ctx.arc(p.x * s, p.y * s, p.r * (p.smoke ? 1.6 - f * 0.8 : f) * s, 0, Math.PI * 2);
        ctx.fillStyle = p.smoke ? 'rgba(110,98,88,.5)' : 'rgba(190,160,120,.7)';
        ctx.globalAlpha = f;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, headCount]);

  return (
    <div
      ref={rootRef}
      className={className}
      style={{
        position: 'relative',
        width,
        aspectRatio: `${STAGE.w} / ${STAGE.h}`,
        overflow: 'hidden',
        ...style,
      }}
      role="img"
      aria-label="Hot air balloon"
    >
      <canvas ref={ropeCvRef} style={{ position: 'absolute', left: 0, top: 0 }} />
      <div ref={groupRef} style={{ position: 'absolute', left: 0, top: 0 }}>
        <canvas ref={upperRef} style={{ position: 'absolute', left: 0, top: 0 }} />
        <canvas ref={lowerRef} style={{ position: 'absolute', left: 0 }} />
        <canvas ref={headsRef} />
        <canvas ref={frontRef} />
        <canvas ref={fxRef} style={{ position: 'absolute', left: 0, top: 0 }} />
      </div>
      {SACKS.map((k, i) => (
        <div
          key={i}
          ref={(el) => {
            sackRefs.current[i] = el;
          }}
          style={{ position: 'absolute', left: 0, top: 0, overflow: 'hidden' }}
        >
          <img src={sacksSrc} alt="" style={{ position: 'absolute', top: 0, maxWidth: 'none' }} />
        </div>
      ))}
    </div>
  );
}

export default HotAirBalloon;
