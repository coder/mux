import { useEffect, useRef } from "react";

import typewriterUrl from "@/browser/assets/audio/activate-power-mode/typewriter.wav";
import gunUrl from "@/browser/assets/audio/activate-power-mode/gun.wav";
import type { PowerModeEngine } from "@/browser/utils/powerMode/PowerModeEngine";

export function PowerModeOverlay(props: { engine: PowerModeEngine }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    props.engine.setCanvas(canvas);
    props.engine.setShakeElement(document.getElementById("root"));
    props.engine.setAudio({ typewriterUrl, gunUrl });

    return () => {
      props.engine.setCanvas(null);
      props.engine.setShakeElement(null);
      props.engine.setAudio(null);
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
