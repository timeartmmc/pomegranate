export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
export function shuffled<T>(values: readonly T[], next: () => number): T[] {
  const order = [...values];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

export function seededSchedule<T>(
  cells: readonly T[],
  rounds: number,
  seed: number,
) {
  const next = random(seed);
  return Array.from({ length: rounds }, (_, round) =>
    shuffled(cells, next).map((cell) => ({ round, cell })),
  ).flat();
}
