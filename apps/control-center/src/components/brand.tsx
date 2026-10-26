const SEED_COUNT = 96;
const SEEDS_PER_RING = 8;
const GOLDEN_ANGLE_DEGREES = 137.508;

const round = (value: number) => Math.round(value * 100) / 100;

export const sunflowerSeeds = Array.from({ length: SEED_COUNT }, (_, index) => {
  const order = index + 1;
  const radius = 2.16 * Math.sqrt(order);
  const angle = (order * GOLDEN_ANGLE_DEGREES * Math.PI) / 180;
  return {
    cx: round(24 + radius * Math.cos(angle)),
    cy: round(24 + radius * Math.sin(angle)),
    r: round(0.82 + (0.78 * order) / SEED_COUNT),
    ring: Math.floor(index / SEEDS_PER_RING),
  };
});

export function SunflowerMark({ busy = false }: { readonly busy?: boolean }) {
  return (
    <svg
      className={busy ? "himawari-mark is-busy" : "himawari-mark"}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
    >
      <g className="seeds">
        {sunflowerSeeds.map((seed) => (
          <circle
            key={`${seed.cx},${seed.cy}`}
            className={`seed-ring-${seed.ring}`}
            cx={seed.cx}
            cy={seed.cy}
            r={seed.r}
          />
        ))}
      </g>
    </svg>
  );
}

export function HimawariBrand({
  wordmark = false,
  busy = false,
}: {
  readonly wordmark?: boolean;
  readonly busy?: boolean;
}) {
  return (
    <span className="himawari-brand">
      <SunflowerMark busy={busy} />
      {wordmark ? <span>himawari</span> : null}
    </span>
  );
}
