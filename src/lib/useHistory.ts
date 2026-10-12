import { useCallback, useState } from "react";

interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

const LIMIT = 100;

/** State with undo/redo. `set` records a step; `reset` replaces everything (e.g. opening a new file). */
export function useHistory<T>(initial: T) {
  const [h, setH] = useState<History<T>>({ past: [], present: initial, future: [] });

  const set = useCallback((next: T | ((prev: T) => T)) => {
    setH((cur) => {
      const value = typeof next === "function" ? (next as (prev: T) => T)(cur.present) : next;
      if (Object.is(value, cur.present)) return cur;
      return { past: [...cur.past, cur.present].slice(-LIMIT), present: value, future: [] };
    });
  }, []);

  const reset = useCallback((value: T) => setH({ past: [], present: value, future: [] }), []);

  const undo = useCallback(() => {
    setH((cur) =>
      cur.past.length === 0
        ? cur
        : { past: cur.past.slice(0, -1), present: cur.past[cur.past.length - 1], future: [cur.present, ...cur.future] },
    );
  }, []);

  const redo = useCallback(() => {
    setH((cur) =>
      cur.future.length === 0
        ? cur
        : { past: [...cur.past, cur.present], present: cur.future[0], future: cur.future.slice(1) },
    );
  }, []);

  return {
    state: h.present,
    set,
    reset,
    undo,
    redo,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
  };
}
