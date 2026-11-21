export const INITIAL_TIME = 5 * 60 * 1000;
export const INCREMENT = 3000;

export function newClock(startedAt = null) {
  return { left: [INITIAL_TIME, INITIAL_TIME], startedAt };
}

export function timeLeft(clock, player, now) {
  const elapsed = clock.startedAt === null ? 0 : Math.max(0, now - clock.startedAt);
  return Math.max(0, clock.left[player - 1] - elapsed);
}

export function freezeClock(clock, player, now) {
  const left = clock.left.slice();
  left[player - 1] = timeLeft(clock, player, now);
  return { left, startedAt: null };
}

export function moveClock(clock, player, now) {
  const frozen = freezeClock(clock, player, now);
  frozen.left[player - 1] += INCREMENT;
  frozen.startedAt = now;
  return frozen;
}
