const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const CENTER = 24;
const DISC_RADIUS = 19.7;
const NEWEST_SHARE = 0.06;
const BIRTH_SECONDS = 1.2;
const FADE_SEEDS = 6;

export const SEED_COUNTS = { full: 233, compact: 89 } as const;
export const GROWTH_RATES = { idle: 0.35, busy: 7 } as const;

export type SunflowerDetail = keyof typeof SEED_COUNTS;

type Rgb = readonly [number, number, number];
const NEW_SEED: Rgb = [255, 236, 170];
const BROWN: Rgb = [92, 52, 16];
const AMBER: Rgb = [214, 128, 20];
const GOLD: Rgb = [245, 178, 48];

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const round = (value: number) => Math.round(value * 100) / 100;
const blend = (from: Rgb, to: Rgb, share: number) =>
  `rgb(${from.map((channel, index) => Math.round(channel + ((to[index] as number) - channel) * clamp(share))).join(",")})`;

export interface Seed {
  readonly slot: number;
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly fill: string;
  readonly opacity: number;
  readonly fresh: boolean;
}

export function restingGrowth(detail: SunflowerDetail) {
  return SEED_COUNTS[detail] + 8;
}

export function seedsAt(detail: SunflowerDetail, growth: number): Seed[] {
  const count = SEED_COUNTS[detail];
  const sizeScale = detail === "compact" ? 1.25 : 1;
  const spacing = DISC_RADIUS / Math.sqrt(count);
  const newest = Math.floor(growth);
  return Array.from({ length: count + 2 }, (_, slot) => {
    const order = newest - slot;
    const age = growth - order;
    if (age < 0 || age > count)
      return { slot, cx: CENTER, cy: CENTER, r: 0, fill: "none", opacity: 0, fresh: false };
    const share = age / count;
    const distance = spacing * Math.sqrt(age);
    const angle = order * GOLDEN_ANGLE;
    const born = clamp(age / BIRTH_SECONDS);
    return {
      slot,
      cx: round(CENTER + distance * Math.cos(angle)),
      cy: round(CENTER + distance * Math.sin(angle)),
      r: round((0.43 + 0.72 * Math.sqrt(share)) * sizeScale * born),
      fill:
        share < NEWEST_SHARE
          ? blend(NEW_SEED, NEW_SEED, 0)
          : share < 0.5
            ? blend(BROWN, AMBER, share / 0.5)
            : blend(AMBER, GOLD, (share - 0.5) / 0.5),
      opacity: round(clamp((count - age) / FADE_SEEDS)),
      fresh: share < NEWEST_SHARE,
    };
  });
}
