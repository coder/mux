import { useEffect, useRef } from "react";

import type { PowerModeEngine } from "@/browser/utils/powerMode/PowerModeEngine";

export function PowerModeOverlay(props: { engine: PowerModeEngine }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    props.engine.setCanvas(canvas);
    props.engine.setShakeElement(document.getElementById("root"));

    return () => {
      props.engine.setCanvas(null);
      props.engine.setShakeElement(null);
    };
  }, [props.engine]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-[9999] h-full w-full"
      data-component="PowerModeOverlay"
    />
  );
}
