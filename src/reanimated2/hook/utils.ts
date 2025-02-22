import { MutableRefObject, useEffect, useRef } from 'react';
import { processColor } from '../Colors';
import { AnimatedStyle, StyleProps, WorkletFunction } from '../commonTypes';
import { colorProps } from '../UpdateProps';
import WorkletEventHandler from '../WorkletEventHandler';
import { DependencyList } from './commonTypes';

export function useEvent<T>(
  handler: (event: T) => void,
  eventNames: string[] = [],
  rebuild = false
): MutableRefObject<WorkletEventHandler | null> {
  const initRef = useRef<WorkletEventHandler | null>(null);
  if (initRef.current === null) {
    initRef.current = new WorkletEventHandler(handler, eventNames);
  } else if (rebuild) {
    initRef.current.updateWorklet(handler);
  }

  useEffect(() => {
    return () => {
      initRef.current = null;
    };
  }, []);

  return initRef;
}

// builds one big hash from multiple worklets' hashes
export function buildWorkletsHash(
  handlers: Record<string, WorkletFunction> | Array<WorkletFunction>
): string {
  return Object.values(handlers).reduce(
    (acc: string, worklet: WorkletFunction) =>
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      acc + worklet.__workletHash!.toString(),
    ''
  );
}

// builds dependencies array for gesture handlers
export function buildDependencies(
  dependencies: DependencyList,
  handlers: Record<string, WorkletFunction | undefined>
): Array<unknown> {
  const handlersList: WorkletFunction[] = Object.values(handlers).filter(
    (handler) => handler !== undefined
  ) as WorkletFunction[];
  if (!dependencies) {
    dependencies = handlersList.map((handler) => {
      return {
        workletHash: handler.__workletHash,
        closure: handler._closure,
      };
    });
  } else {
    dependencies.push(buildWorkletsHash(handlersList));
  }
  return dependencies;
}

// this is supposed to work as useEffect comparison
export function areDependenciesEqual(
  nextDeps: DependencyList,
  prevDeps: DependencyList
): boolean {
  function is(x: number, y: number) {
    /* eslint-disable no-self-compare */
    return (x === y && (x !== 0 || 1 / x === 1 / y)) || (x !== x && y !== y);
    /* eslint-enable no-self-compare */
  }
  const objectIs: (nextDeps: unknown, prevDeps: unknown) => boolean =
    typeof Object.is === 'function' ? Object.is : is;

  function areHookInputsEqual(
    nextDeps: DependencyList,
    prevDeps: DependencyList
  ): boolean {
    if (!nextDeps || !prevDeps || prevDeps.length !== nextDeps.length) {
      return false;
    }
    for (let i = 0; i < prevDeps.length; ++i) {
      if (!objectIs(nextDeps[i], prevDeps[i])) {
        return false;
      }
    }
    return true;
  }

  return areHookInputsEqual(nextDeps, prevDeps);
}

export function hasColorProps(updates: AnimatedStyle): boolean {
  const colorPropsSet = new Set(colorProps);
  for (const key in updates) {
    if (colorPropsSet.has(key)) {
      return true;
    }
  }
  return false;
}

export function parseColors(updates: AnimatedStyle): void {
  'worklet';
  for (const key in updates) {
    if (colorProps.indexOf(key) !== -1) {
      updates[key] = processColor(updates[key]);
    }
  }
}

export function canApplyOptimalisation(upadterFn: WorkletFunction): number {
  const FUNCTIONLESS_FLAG = 0b00000001;
  const STATEMENTLESS_FLAG = 0b00000010;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const optimalization = upadterFn.__optimalization!;
  return (
    optimalization & FUNCTIONLESS_FLAG && optimalization & STATEMENTLESS_FLAG
  );
}

export function isAnimated(prop: AnimatedStyle): boolean {
  'worklet';
  if (Array.isArray(prop)) {
    for (let i = 0; i < prop.length; ++i) {
      const item = prop[i];
      for (const key in item) {
        if (item[key].onFrame !== undefined) {
          return true;
        }
      }
    }
    return false;
  }
  return prop?.onFrame !== undefined;
}

export function styleDiff(
  oldStyle: AnimatedStyle,
  newStyle: AnimatedStyle
): AnimatedStyle {
  'worklet';
  const diff: AnimatedStyle = {};
  Object.keys(oldStyle).forEach((key) => {
    if (newStyle[key] === undefined) {
      diff[key] = null;
    }
  });
  Object.keys(newStyle).forEach((key) => {
    const value = newStyle[key];
    const oldValue = oldStyle[key];

    if (isAnimated(value)) {
      // do nothing
      return;
    }
    if (
      oldValue !== value &&
      JSON.stringify(oldValue) !== JSON.stringify(value)
    ) {
      // I'd use deep equal here but that'd take additional work and this was easier
      diff[key] = value;
    }
  });
  return diff;
}

export function getStyleWithoutAnimations(newStyle: AnimatedStyle): StyleProps {
  'worklet';
  const diff: StyleProps = {};

  for (const key in newStyle) {
    const value = newStyle[key];
    if (isAnimated(value)) {
      continue;
    }
    diff[key] = value;
  }
  return diff;
}

export const validateAnimatedStyles = (styles: AnimatedStyle): void => {
  'worklet';
  if (typeof styles !== 'object') {
    throw new Error(
      `useAnimatedStyle has to return an object, found ${typeof styles} instead`
    );
  } else if (Array.isArray(styles)) {
    throw new Error(
      'useAnimatedStyle has to return an object and cannot return static styles combined with dynamic ones. Please do merging where a component receives props.'
    );
  }
};
