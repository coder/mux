import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_IMAGE_DIMENSION } from "@/common/constants/imageAttachments";
import { computeResizedDimensions, resizeImageIfNeeded } from "./imageResize";

interface ToDataUrlCall {
  type: string | undefined;
  quality: number | undefined;
}

let mockImageWidth = 0;
let mockImageHeight = 0;
let createdCanvasCount = 0;
let drawImageCalls: Array<{ width: number; height: number }> = [];
let toDataUrlCalls: ToDataUrlCall[] = [];

const originalImage = globalThis.Image;
const originalDocument = globalThis.document;

class MockImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;

  set src(_value: string) {
    this.naturalWidth = mockImageWidth;
    this.naturalHeight = mockImageHeight;
    queueMicrotask(() => {
      this.onload?.();
    });
  }
}

function createMockCanvas(): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    getContext: (contextType: string) => {
      if (contextType !== "2d") {
        return null;
      }

      return {
        drawImage: (_image: unknown, _x: number, _y: number, width: number, height: number) => {
          drawImageCalls.push({ width, height });
        },
      } as unknown as CanvasRenderingContext2D;
    },
    toDataURL: (type?: string, quality?: number) => {
      toDataUrlCalls.push({ type, quality });
      return `data:${type ?? "image/png"};base64,resized`;
    },
  } as unknown as HTMLCanvasElement;
}

beforeEach(() => {
  mockImageWidth = 0;
  mockImageHeight = 0;
  createdCanvasCount = 0;
  drawImageCalls = [];
  toDataUrlCalls = [];

  Object.defineProperty(globalThis, "Image", {
    value: MockImage,
    configurable: true,
    writable: true,
  });

  Object.defineProperty(globalThis, "document", {
    value: {
      createElement: (tagName: string) => {
        if (tagName !== "canvas") {
          throw new Error(`Unexpected element creation: ${tagName}`);
        }

        createdCanvasCount += 1;
        return createMockCanvas();
      },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (originalImage) {
    Object.defineProperty(globalThis, "Image", {
      value: originalImage,
      configurable: true,
      writable: true,
    });
  } else {
    delete (globalThis as { Image?: typeof Image }).Image;
  }

  if (originalDocument) {
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      configurable: true,
      writable: true,
    });
  } else {
    delete (globalThis as { document?: Document }).document;
  }
});

describe("computeResizedDimensions", () => {
  test("returns null for a small image", () => {
    expect(computeResizedDimensions(100, 100, MAX_IMAGE_DIMENSION)).toBeNull();
  });

  test("resizes a wide landscape image", () => {
    expect(computeResizedDimensions(4000, 2000, MAX_IMAGE_DIMENSION)).toEqual({
      width: 2000,
      height: 1000,
    });
  });

  test("resizes a tall portrait image", () => {
    expect(computeResizedDimensions(1500, 3000, MAX_IMAGE_DIMENSION)).toEqual({
      width: 1000,
      height: 2000,
    });
  });

  test("resizes a square image", () => {
    expect(computeResizedDimensions(3000, 3000, MAX_IMAGE_DIMENSION)).toEqual({
      width: 2000,
      height: 2000,
    });
  });

  test("returns null when exactly at the limit", () => {
    expect(computeResizedDimensions(2000, 1500, MAX_IMAGE_DIMENSION)).toBeNull();
  });

  test("returns null when one dimension is at the limit and the other is below", () => {
    expect(computeResizedDimensions(2000, 500, MAX_IMAGE_DIMENSION)).toBeNull();
  });

  test("supports a custom max dimension", () => {
    expect(computeResizedDimensions(1000, 800, 500)).toEqual({
      width: 500,
      height: 400,
    });
  });

  test("clamps very thin image dimensions to at least 1 pixel", () => {
    expect(computeResizedDimensions(1, 5000, MAX_IMAGE_DIMENSION)).toEqual({
      width: 1,
      height: 2000,
    });
  });

  test("clamps very wide thin image dimensions to at least 1 pixel", () => {
    expect(computeResizedDimensions(5000, 1, MAX_IMAGE_DIMENSION)).toEqual({
      width: 2000,
      height: 1,
    });
  });
});

describe("resizeImageIfNeeded", () => {
  test("preserves JPEG output format for resized JPEG input", async () => {
    mockImageWidth = 4000;
    mockImageHeight = 2000;

    const result = await resizeImageIfNeeded("data:image/jpeg;base64,input", "image/jpeg");

    expect(result).toMatchObject({
      resized: true,
      originalWidth: 4000,
      originalHeight: 2000,
      width: 2000,
      height: 1000,
      dataUrl: "data:image/jpeg;base64,resized",
      mediaType: "image/jpeg",
    });
    expect(toDataUrlCalls).toEqual([{ type: "image/jpeg", quality: 0.9 }]);
  });

  test("uses PNG output format for non-JPEG input", async () => {
    mockImageWidth = 3000;
    mockImageHeight = 3000;

    const result = await resizeImageIfNeeded("data:image/webp;base64,input", "image/webp");

    expect(result.mediaType).toBe("image/png");
    expect(toDataUrlCalls).toEqual([{ type: "image/png", quality: undefined }]);
  });

  test("returns unchanged data when image is already within limits", async () => {
    mockImageWidth = 100;
    mockImageHeight = 100;

    const inputDataUrl = "data:image/png;base64,input";
    const result = await resizeImageIfNeeded(inputDataUrl, "image/png");

    expect(result).toEqual({
      dataUrl: inputDataUrl,
      mediaType: "image/png",
      resized: false,
      originalWidth: 100,
      originalHeight: 100,
      width: 100,
      height: 100,
    });
    expect(createdCanvasCount).toBe(0);
    expect(toDataUrlCalls).toHaveLength(0);
  });

  test("returns resized data and dimensions for oversized images", async () => {
    mockImageWidth = 1500;
    mockImageHeight = 3000;

    const result = await resizeImageIfNeeded("data:image/png;base64,input", "image/png");

    expect(result).toEqual({
      dataUrl: "data:image/png;base64,resized",
      mediaType: "image/png",
      resized: true,
      originalWidth: 1500,
      originalHeight: 3000,
      width: 1000,
      height: 2000,
    });
    expect(drawImageCalls).toEqual([{ width: 1000, height: 2000 }]);
    expect(createdCanvasCount).toBe(1);
  });
});
