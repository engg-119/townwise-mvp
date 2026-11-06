import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

// The device's Reduce Motion setting, kept current as it changes. Null until the system answers
// (a frame or two); callers that only animate treat null as reduced. Reads the setting, stores nothing.
export function useReducedMotion(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => { setReduced(value); });
    // A change that arrived first is newer than this answer, so the answer only fills a null.
    // If the system cannot answer, settle on reduced so no caller waits on it.
    AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => { if (live) setReduced((current) => current ?? value); },
      () => { if (live) setReduced((current) => current ?? true); },
    );
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}
