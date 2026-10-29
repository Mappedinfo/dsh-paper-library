export interface TransitionSnapshot<T> { owner: T; revision: number; clean: boolean }

/** Reserve synchronously before any await; validate the old editor again before installing. */
export function createTransitionGuard<T>() {
  let reserved = false
  return {
    reserve() { if (reserved) return false; reserved = true; return true },
    release() { reserved = false },
    matches(expected: TransitionSnapshot<T>, current: TransitionSnapshot<T>) {
      return reserved && expected.owner === current.owner && expected.revision === current.revision && current.clean
    },
  }
}
