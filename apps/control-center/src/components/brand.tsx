import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { growthRate, restingGrowth, SEED_COUNT, seedCountFor, seedsAt } from "./brand-seeds.js";

export { growthRate, restingGrowth, SEED_COUNT, seedCountFor, seedsAt };
export type { Seed } from "./brand-seeds.js";

const MAX_FRAME_SECONDS = 0.05;

type Grower = (seconds: number) => void;
const growers = new Set<Grower>();
let frame = 0;
let lastFrameAt: number | undefined;

function advance(now: number) {
  const seconds =
    lastFrameAt === undefined ? 0 : Math.min(MAX_FRAME_SECONDS, (now - lastFrameAt) / 1000);
  lastFrameAt = now;
  for (const grow of growers) grow(seconds);
  frame = growers.size ? requestAnimationFrame(advance) : 0;
  if (!frame) lastFrameAt = undefined;
}

export function joinGrowth(grow: Grower) {
  growers.add(grow);
  if (!frame) frame = requestAnimationFrame(advance);
  return () => {
    growers.delete(grow);
    if (growers.size || !frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
    lastFrameAt = undefined;
  };
}

export function activeGrowers() {
  return growers.size;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(REDUCED_MOTION).matches === true,
  );
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED_MOTION);
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

const SMALLEST_MARK = 24;
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function useSeedCount(mark: RefObject<SVGSVGElement | null>) {
  const [seeds, setSeeds] = useState(() => seedCountFor(SMALLEST_MARK));
  useBrowserLayoutEffect(() => {
    const element = mark.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      const side = Math.min(width, height);
      if (side > 0) setSeeds(seedCountFor(side));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mark]);
  return seeds;
}

export function SunflowerMark({
  busy = false,
  growing = false,
}: {
  readonly busy?: boolean;
  readonly growing?: boolean;
}) {
  const markRef = useRef<SVGSVGElement>(null);
  const seedsRef = useRef<SVGGElement>(null);
  const seeds = useSeedCount(markRef);
  const reducedMotion = usePrefersReducedMotion();
  const rate = busy ? growthRate(seeds, "busy") : growing ? growthRate(seeds, "idle") : 0;
  const animated = rate > 0 && !reducedMotion;
  const growthRef = useRef(restingGrowth(seeds));

  useEffect(() => {
    growthRef.current = restingGrowth(seeds);
  }, [seeds]);

  useEffect(() => {
    if (!animated) return;
    const circles = seedsRef.current?.children;
    if (!circles) return;
    return joinGrowth((seconds) => {
      growthRef.current += seconds * rate;
      seedsAt(growthRef.current, seeds).forEach((seed, index) => {
        const circle = circles[index];
        if (!circle) return;
        circle.setAttribute("cx", String(seed.cx));
        circle.setAttribute("cy", String(seed.cy));
        circle.setAttribute("r", String(seed.r));
        circle.setAttribute("fill", seed.fill);
        circle.setAttribute("opacity", String(seed.opacity));
        circle.setAttribute("class", seed.fresh ? "seed-new" : "");
      });
    });
  }, [animated, rate, seeds]);

  const resting = seedsAt(restingGrowth(seeds), seeds);
  return (
    <svg
      ref={markRef}
      data-seeds={seeds}
      className={busy ? "himawari-mark is-busy" : "himawari-mark"}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
    >
      <g className="seeds" ref={seedsRef}>
        {resting.map((seed) => (
          <circle
            key={seed.slot}
            cx={seed.cx}
            cy={seed.cy}
            r={seed.r}
            fill={seed.fill}
            opacity={seed.opacity}
            className={seed.fresh ? "seed-new" : undefined}
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
      {wordmark ? (
        <span className="himawari-wordmark">
          <span className="himawari-wordmark-latin">Himawari</span>
          <span className="himawari-wordmark-kana" lang="ja">
            ひまわり
          </span>
        </span>
      ) : null}
    </span>
  );
}
