export interface Clock {
  left: [number, number];
  startedAt: number | null;
}
export const INITIAL_TIME: number;
export const INCREMENT: number;
export function newClock(startedAt?: number | null): Clock;
export function timeLeft(clock: Clock, player: 1 | 2, now: number): number;
export function freezeClock(clock: Clock, player: 1 | 2, now: number): Clock;
export function moveClock(clock: Clock, player: 1 | 2, now: number): Clock;
