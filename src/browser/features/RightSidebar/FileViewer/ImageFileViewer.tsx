/**
 * ImageFileViewer - Displays image files with zoom controls.
 * Supports scroll wheel zoom with constrained range.
 */

import React from "react";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { cn } from "@/common/lib/utils";

interface ImageFileViewerProps {
  base64: string;
  mimeType: string;
  size: number;
  filePath: string;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10; // 1000%
const ZOOM_STEP = 0.1;
const ZOOM_PRESETS = [10, 25, 50, 75, 100, 200, 300, 400, 500]; // percentages
const BASE_CHECKER_SIZE = 16;

// Returns checkerboard style with size scaled by zoom
// Uses conic-gradient for clean edges (no diagonal seam artifacts)
const getCheckerboardStyle = (zoom: number): React.CSSProperties => {
  const size = BASE_CHECKER_SIZE * zoom;
  return {
    background: `repeating-conic-gradient(
      color-mix(in srgb, var(--color-background) 85%, var(--color-foreground)) 0% 25%,
      var(--color-background) 0% 50%
    ) 0 0 / ${size}px ${size}px`,
  };
};

export const ImageFileViewer: React.FC<ImageFileViewerProps> = (props) => {
  const [zoom, setZoom] = React.useState(1);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = React.useState<{
    width: number;
    height: number;
  } | null>(null);
  const [imageDimensions, setImageDimensions] = React.useState<{
    width: number;
    height: number;
  } | null>(null);

  // Track container size to compute max zoom
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Compute max zoom so image fits within container (with padding)
  const padding = 32;
  const maxZoom = React.useMemo(() => {
    if (!containerSize || !imageDimensions) return MAX_ZOOM;
    const maxZoomX = (containerSize.width - padding) / imageDimensions.width;
    const maxZoomY = (containerSize.height - padding) / imageDimensions.height;
    // Use the smaller ratio so image fits in both dimensions, but at least MIN_ZOOM
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, maxZoomX, maxZoomY));
  }, [containerSize, imageDimensions]);

  // Clamp zoom when maxZoom changes (e.g., container resized)
  React.useEffect(() => {
    setZoom((prev) => Math.min(prev, maxZoom));
  }, [maxZoom]);

  // Format file size for display
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setZoom((prev) => Math.min(maxZoom, Math.max(MIN_ZOOM, prev + delta)));
  };

  const handleZoomIn = () => setZoom((prev) => Math.min(maxZoom, prev + ZOOM_STEP));
  const handleZoomOut = () => setZoom((prev) => Math.max(MIN_ZOOM, prev - ZOOM_STEP));
  // Reset to 100% or maxZoom if the image doesn't fit at 100%
  const handleReset = () => setZoom(Math.min(1, maxZoom));

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
  };

  const dataUrl = `data:${props.mimeType};base64,${props.base64}`;

  return (
    <div data-testid="image-file-viewer" className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="border-border-light flex items-center justify-between border-b px-2 py-1">
        <div className="text-muted-foreground flex min-w-0 flex-1 items-center gap-2 text-xs">
          <span className="min-w-0 truncate">{props.filePath}</span>
          {imageDimensions && (
            <span className="shrink-0">
              {imageDimensions.width} × {imageDimensions.height}
            </span>
          )}
          <span className="shrink-0">{formatSize(props.size)}</span>
          <span className="shrink-0 truncate opacity-60">{props.mimeType}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="text-muted hover:bg-accent/50 hover:text-foreground rounded p-1"
            onClick={handleZoomOut}
            title="Zoom out"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <select
            value={Math.round(zoom * 100)}
            onChange={(e) => setZoom(Number(e.target.value) / 100)}
            className="text-muted-foreground hover:text-foreground bg-background cursor-pointer rounded px-1 py-0.5 text-center text-xs outline-none"
            title="Select zoom level"
          >
            {/* Current zoom if not a preset */}
            {!ZOOM_PRESETS.includes(Math.round(zoom * 100)) && (
              <option value={Math.round(zoom * 100)}>{Math.round(zoom * 100)}%</option>
            )}
            {ZOOM_PRESETS.filter((p) => p / 100 <= maxZoom).map((preset) => (
              <option key={preset} value={preset}>
                {preset}%
              </option>
            ))}
          </select>
          <button
            type="button"
            className="text-muted hover:bg-accent/50 hover:text-foreground rounded p-1"
            onClick={handleZoomIn}
            title="Zoom in"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={cn(
              "text-muted hover:bg-accent/50 hover:text-foreground rounded p-1",
              zoom === 1 && "opacity-50"
            )}
            onClick={handleReset}
            title="Reset zoom"
            disabled={zoom === 1}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Image container - centers the image */}
      <div
        ref={containerRef}
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onWheel={handleWheel}
      >
        {/* Image with checkerboard background */}
        <img
          src={dataUrl}
          alt="File preview"
          onLoad={handleImageLoad}
          style={{
            ...getCheckerboardStyle(zoom),
            ...(imageDimensions
              ? {
                  width: imageDimensions.width * zoom,
                  height: imageDimensions.height * zoom,
                }
              : {}),
          }}
          className="block"
          draggable={false}
        />
      </div>
    </div>
  );
};
