import { useEffect, useEffectEvent, useRef, useState } from "react";

/**
 * Runs actions in the order they were asked for, even when one of them has to wait for data
 * (Annotate's `M` waiting for Player Tracking): an action that returns a promise holds every
 * later one until it settles, so keys typed meanwhile don't act on the Shot selected before it.
 *
 * Waiting actions run one per render, each with the latest `execute`, so each sees the state the
 * one before it left.
 */
export function useActionQueue<T>(execute: (item: T) => unknown): (item: T) => void {
  const heldRef = useRef(false);
  const waitingRef = useRef<T[]>([]);
  const [tick, setTick] = useState(0);

  const start = (item: T) => {
    const result = execute(item);
    if (!(result instanceof Promise)) return;
    heldRef.current = true;
    const release = () => {
      heldRef.current = false;
      setTick((t) => t + 1);
    };
    result.then(release, release);
  };

  const drain = useEffectEvent((round: number) => {
    if (heldRef.current || round < 0) return;
    const next = waitingRef.current.shift();
    if (next === undefined) return;
    start(next);
    setTick((t) => t + 1);
  });
  useEffect(() => drain(tick), [tick]);

  return (item) => {
    if (heldRef.current || waitingRef.current.length > 0) {
      waitingRef.current.push(item);
      return;
    }
    start(item);
  };
}
