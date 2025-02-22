/* global _frameTimestamp */
import { MutableRefObject, useEffect, useRef } from 'react';

import {
  startMapper,
  stopMapper,
  makeRemote,
  requestFrame,
  getTimestamp,
  makeMutable,
} from '../core';
import updateProps, { updatePropsJestWrapper } from '../UpdateProps';
import { initialUpdaterRun, Timestamp } from '../animation';
import NativeReanimated from '../NativeReanimated';
import { useSharedValue } from './useSharedValue';
import {
  buildWorkletsHash,
  canApplyOptimalisation,
  getStyleWithoutAnimations,
  hasColorProps,
  isAnimated,
  parseColors,
  styleDiff,
  validateAnimatedStyles,
} from './utils';
import { DependencyList, Descriptor } from './commonTypes';
import {
  makeViewDescriptorsSet,
  makeViewsRefSet,
  ViewDescriptorsSet,
  ViewRefSet,
} from '../ViewDescriptorsSet';
import { isJest, shouldBeUseWeb } from '../PlatformChecker';
import {
  AdapterWorkletFunction,
  AnimatedStyle,
  BasicWorkletFunction,
  SharedValue,
  WorkletFunction,
} from '../commonTypes';
import {
  Animation,
  AnimationObject,
  PrimitiveValue,
} from '../animation/commonTypes';

export interface AnimatedStyleResult {
  viewDescriptors: ViewDescriptorsSet;
  initial: AnimatedStyle;
  viewsRef: ViewRefSet<any>;
  animatedStyle?: MutableRefObject<AnimatedStyle>;
}

interface AnimatedState {
  last: AnimatedStyle;
  animations: AnimatedStyle;
  isAnimationRunning: boolean;
  isAnimationCancelled: boolean;
}

interface AnimationRef {
  initial: {
    value: AnimatedStyle;
  };
  remoteState: AnimatedState;
  sharableViewDescriptors: SharedValue<Descriptor[]>;
}

function prepareAnimation(
  animatedProp: AnimatedStyle,
  lastAnimation: AnimatedStyle,
  lastValue: AnimatedStyle
): void {
  'worklet';
  if (Array.isArray(animatedProp)) {
    animatedProp.forEach((prop, index) =>
      prepareAnimation(
        prop,
        lastAnimation && lastAnimation[index],
        lastValue && lastValue[index]
      )
    );
    // return animatedProp;
  }
  if (typeof animatedProp === 'object' && animatedProp.onFrame) {
    const animation = animatedProp;

    let value = animation.current;
    if (lastValue !== undefined) {
      if (typeof lastValue === 'object') {
        if (lastValue.value !== undefined) {
          // previously it was a shared value
          value = lastValue.value;
        } else if (lastValue.onFrame !== undefined) {
          if (lastAnimation?.current !== undefined) {
            // it was an animation before, copy its state
            value = lastAnimation.current;
          } else if (lastValue?.current !== undefined) {
            // it was initialized
            value = lastValue.current;
          }
        }
      } else {
        // previously it was a plain value, just set it as starting point
        value = lastValue;
      }
    }

    animation.callStart = (timestamp: Timestamp) => {
      animation.onStart(animation, value, timestamp, lastAnimation);
    };
    animation.callStart(getTimestamp());
    animation.callStart = null;
  } else if (typeof animatedProp === 'object') {
    // it is an object
    Object.keys(animatedProp).forEach((key) =>
      prepareAnimation(
        animatedProp[key],
        lastAnimation && lastAnimation[key],
        lastValue && lastValue[key]
      )
    );
  }
}

function runAnimations(
  animation: AnimatedStyle,
  timestamp: Timestamp,
  key: PrimitiveValue,
  result: AnimatedStyle,
  animationsActive: SharedValue<boolean>
): boolean {
  'worklet';
  if (!animationsActive.value) {
    return true;
  }
  if (Array.isArray(animation)) {
    result[key] = [];
    let allFinished = true;
    animation.forEach((entry, index) => {
      if (
        !runAnimations(entry, timestamp, index, result[key], animationsActive)
      ) {
        allFinished = false;
      }
    });
    return allFinished;
  } else if (typeof animation === 'object' && animation.onFrame) {
    let finished = true;
    if (!animation.finished) {
      if (animation.callStart) {
        animation.callStart(timestamp);
        animation.callStart = null;
      }
      finished = animation.onFrame(animation, timestamp);
      animation.timestamp = timestamp;
      if (finished) {
        animation.finished = true;
        animation.callback && animation.callback(true /* finished */);
      }
    }
    result[key] = animation.current;
    return finished;
  } else if (typeof animation === 'object') {
    result[key] = {};
    let allFinished = true;
    Object.keys(animation).forEach((k) => {
      if (
        !runAnimations(
          animation[k],
          timestamp,
          k,
          result[key],
          animationsActive
        )
      ) {
        allFinished = false;
      }
    });
    return allFinished;
  } else {
    result[key] = animation;
    return true;
  }
}

function styleUpdater(
  viewDescriptors: SharedValue<Descriptor[]>,
  updater: BasicWorkletFunction<AnimatedStyle>,
  state: AnimatedState,
  maybeViewRef: ViewRefSet<any> | undefined,
  animationsActive: SharedValue<boolean>
): void {
  'worklet';
  const animations = state.animations ?? {};
  const newValues = updater() ?? {};
  const oldValues = state.last;

  let hasAnimations = false;
  for (const key in newValues) {
    const value = newValues[key];
    if (isAnimated(value)) {
      prepareAnimation(value, animations[key], oldValues[key]);
      animations[key] = value;
      hasAnimations = true;
    } else {
      delete animations[key];
    }
  }

  if (hasAnimations) {
    const frame = (timestamp: Timestamp) => {
      const { animations, last, isAnimationCancelled } = state;
      if (isAnimationCancelled) {
        state.isAnimationRunning = false;
        return;
      }

      const updates: AnimatedStyle = {};
      let allFinished = true;
      for (const propName in animations) {
        const finished = runAnimations(
          animations[propName],
          timestamp,
          propName,
          updates,
          animationsActive
        );
        if (finished) {
          last[propName] = updates[propName];
          delete animations[propName];
        } else {
          allFinished = false;
        }
      }

      if (updates) {
        updateProps(viewDescriptors, updates, maybeViewRef);
      }

      if (!allFinished) {
        requestFrame(frame);
      } else {
        state.isAnimationRunning = false;
      }
    };

    state.animations = animations;
    if (!state.isAnimationRunning) {
      state.isAnimationCancelled = false;
      state.isAnimationRunning = true;
      if (_frameTimestamp) {
        frame(_frameTimestamp);
      } else {
        requestFrame(frame);
      }
    }
    state.last = Object.assign({}, oldValues, newValues);
    const style = getStyleWithoutAnimations(oldValues);
    if (style) {
      updateProps(viewDescriptors, style, maybeViewRef);
    }
  } else {
    state.isAnimationCancelled = true;
    state.animations = [];
    updateProps(viewDescriptors, newValues, maybeViewRef);
  }
}

function jestStyleUpdater(
  viewDescriptors: SharedValue<Descriptor[]>,
  updater: BasicWorkletFunction<AnimatedStyle>,
  state: AnimatedState,
  maybeViewRef: ViewRefSet<any> | undefined,
  animationsActive: SharedValue<boolean>,
  animatedStyle: MutableRefObject<AnimatedStyle>,
  adapters: WorkletFunction[] = []
): void {
  'worklet';
  const animations: AnimatedStyle = state.animations ?? {};
  const newValues = updater() ?? {};
  const oldValues = state.last;

  // extract animated props
  let hasAnimations = false;
  Object.keys(animations).forEach((key) => {
    const value = newValues[key];
    if (!isAnimated(value)) {
      delete animations[key];
    }
  });
  Object.keys(newValues).forEach((key) => {
    const value = newValues[key];
    if (isAnimated(value)) {
      prepareAnimation(value, animations[key], oldValues[key]);
      animations[key] = value;
      hasAnimations = true;
    }
  });

  function frame(timestamp: Timestamp) {
    const { animations, last, isAnimationCancelled } = state;
    if (isAnimationCancelled) {
      state.isAnimationRunning = false;
      return;
    }

    const updates: AnimatedStyle = {};
    let allFinished = true;
    Object.keys(animations).forEach((propName) => {
      const finished = runAnimations(
        animations[propName],
        timestamp,
        propName,
        updates,
        animationsActive
      );
      if (finished) {
        last[propName] = updates[propName];
        delete animations[propName];
      } else {
        allFinished = false;
      }
    });

    if (Object.keys(updates).length) {
      updatePropsJestWrapper(
        viewDescriptors,
        updates,
        maybeViewRef,
        animatedStyle,
        adapters
      );
    }

    if (!allFinished) {
      requestFrame(frame);
    } else {
      state.isAnimationRunning = false;
    }
  }

  if (hasAnimations) {
    state.animations = animations;
    if (!state.isAnimationRunning) {
      state.isAnimationCancelled = false;
      state.isAnimationRunning = true;
      if (_frameTimestamp) {
        frame(_frameTimestamp);
      } else {
        requestFrame(frame);
      }
    }
  } else {
    state.isAnimationCancelled = true;
    state.animations = [];
  }

  // calculate diff
  const diff = styleDiff(oldValues, newValues);
  state.last = Object.assign({}, oldValues, newValues);

  if (Object.keys(diff).length !== 0) {
    updatePropsJestWrapper(
      viewDescriptors,
      diff,
      maybeViewRef,
      animatedStyle,
      adapters
    );
  }
}

export function useAnimatedStyle<T extends AnimatedStyle>(
  updater: BasicWorkletFunction<T>,
  dependencies?: DependencyList,
  adapters?: AdapterWorkletFunction | AdapterWorkletFunction[]
): AnimatedStyleResult {
  const viewsRef: ViewRefSet<any> = makeViewsRefSet();
  const viewDescriptors: ViewDescriptorsSet = makeViewDescriptorsSet();
  const initRef = useRef<AnimationRef>();
  const inputs = Object.values(updater._closure ?? {});
  const adaptersArray: AdapterWorkletFunction[] = adapters
    ? Array.isArray(adapters)
      ? adapters
      : [adapters]
    : [];
  const adaptersHash = adapters ? buildWorkletsHash(adaptersArray) : null;
  const animationsActive = useSharedValue<boolean>(true);
  const animatedStyle: MutableRefObject<AnimatedStyle> = useRef<AnimatedStyle>(
    {}
  );

  // build dependencies
  if (!dependencies) {
    dependencies = [...inputs, updater.__workletHash];
  } else {
    dependencies.push(updater.__workletHash);
  }
  adaptersHash && dependencies.push(adaptersHash);

  if (!initRef.current) {
    const initialStyle: AnimatedStyle = initialUpdaterRun(updater);
    validateAnimatedStyles(initialStyle);
    initRef.current = {
      initial: {
        value: initialStyle,
      },
      remoteState: makeRemote({ last: initialStyle }),
      sharableViewDescriptors: makeMutable([]),
    };
    viewDescriptors.rebuildsharableViewDescriptors(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      initRef.current!.sharableViewDescriptors
    );
  }
  dependencies.push(initRef.current?.sharableViewDescriptors.value);

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const { initial, remoteState, sharableViewDescriptors } = initRef.current!;
  const maybeViewRef = NativeReanimated.native ? undefined : viewsRef;

  initial.value = initialUpdaterRun(updater);
  useEffect(() => {
    let fun;
    let upadterFn = updater;
    let optimalization = updater.__optimalization;
    if (adapters) {
      upadterFn = () => {
        'worklet';
        const newValues = updater();
        adaptersArray.forEach((adapter) => {
          adapter(newValues);
        });
        return newValues;
      };
    }

    if (canApplyOptimalisation(upadterFn) && !shouldBeUseWeb()) {
      if (hasColorProps(upadterFn())) {
        upadterFn = () => {
          'worklet';
          const style = upadterFn();
          parseColors(style);
          return style;
        };
      }
    } else if (!shouldBeUseWeb()) {
      optimalization = 0;
      upadterFn = () => {
        'worklet';
        const style = upadterFn();
        parseColors(style);
        return style;
      };
    }
    if (typeof updater.__optimalization !== undefined) {
      upadterFn.__optimalization = optimalization;
    }

    if (isJest()) {
      fun = () => {
        'worklet';
        jestStyleUpdater(
          sharableViewDescriptors,
          updater,
          remoteState,
          maybeViewRef,
          animationsActive,
          animatedStyle,
          adaptersArray
        );
      };
    } else {
      fun = () => {
        'worklet';
        styleUpdater(
          sharableViewDescriptors,
          upadterFn,
          remoteState,
          maybeViewRef,
          animationsActive
        );
      };
    }
    const mapperId = startMapper(
      fun,
      inputs,
      [],
      upadterFn,
      // TODO fix this
      sharableViewDescriptors
    );
    return () => {
      stopMapper(mapperId);
    };
  }, dependencies);

  useEffect(() => {
    animationsActive.value = true;
    return () => {
      // initRef.current = null;
      // viewsRef = null;
      animationsActive.value = false;
    };
  }, []);

  // check for invalid usage of shared values in returned object
  let wrongKey;
  const isObjectValid = (element: AnimationObject, key: string) => {
    const result = typeof element === 'object' && element.value !== undefined;
    if (result) {
      wrongKey = key;
    }
    return !result;
  };
  const isError = Object.keys(initial.value).some((key) => {
    const element = initial.value[key];
    let result = false;
    // a case for transform that has a format of an array of objects
    if (Array.isArray(element)) {
      for (const elementArrayItem of element) {
        // this means unhandled format and it doesn't match the transform format
        if (typeof elementArrayItem !== 'object') {
          break;
        }
        const objectValue: Animation<AnimationObject> = <
          Animation<AnimationObject>
        >Object.values(elementArrayItem)[0];
        result = isObjectValid(objectValue, key);
        if (!result) {
          break;
        }
      }
    } else {
      result = isObjectValid(element, key);
    }
    return !result;
  });
  if (isError && wrongKey !== undefined) {
    throw new Error(
      `invalid value passed to \`${wrongKey}\`, maybe you forgot to use \`.value\`?`
    );
  }

  if (process.env.JEST_WORKER_ID) {
    return { viewDescriptors, initial: initial.value, viewsRef, animatedStyle };
  } else {
    return { viewDescriptors, initial: initial.value, viewsRef };
  }
}
