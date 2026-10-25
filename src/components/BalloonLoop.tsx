'use client';

import { useRef, useState } from 'react';
import { HotAirBalloon } from '@/components/HotAirBalloon';

/**
 * The balloon with its burner always lit on a short fuse — it ignites,
 * crashes, then resets itself and flies again.
 */
export default function BalloonLoop() {
  const [resetKey, setResetKey] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return (
    <HotAirBalloon
      burning
      ropeLength={1}
      people={2}
      burnLimitMs={10_000}
      resetKey={resetKey}
      width={330}
      onCrash={() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setResetKey((k) => k + 1), 4000);
      }}
    />
  );
}
