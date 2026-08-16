import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { downloadBlob } from "./downloadFile";

interface AnchorStub {
  href: string;
  download: string;
  click: ReturnType<typeof mock>;
  remove: ReturnType<typeof mock>;
}

describe("downloadBlob", () => {
  let originalNavigator: typeof globalThis.navigator;
  let originalDocument: typeof globalThis.document;
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;
  let anchor: AnchorStub;
  let createElement: ReturnType<typeof mock>;

  function installNavigator(nav: {
    standalone?: boolean;
    canShare?: (data: { files: File[] }) => boolean;
    share?: (data: { files: File[] }) => Promise<void>;
  }) {
    globalThis.navigator = nav as unknown as Navigator;
  }

  beforeEach(() => {
    originalNavigator = globalThis.navigator;
    originalDocument = globalThis.document;
    originalCreateObjectURL = URL.createObjectURL.bind(URL);
    originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);

    anchor = {
      href: "",
      download: "",
      click: mock(() => undefined),
      remove: mock(() => undefined),
    };
    createElement = mock(() => anchor);
    globalThis.document = {
      createElement,
      body: { appendChild: mock(() => undefined) },
    } as unknown as Document;
    URL.createObjectURL = mock(() => "blob:test");
    URL.revokeObjectURL = mock(() => undefined);
  });

  afterEach(() => {
    globalThis.navigator = originalNavigator;
    globalThis.document = originalDocument;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it("routes through the share sheet in iOS home-screen web apps", () => {
    const share = mock((_data: { files: File[] }) => Promise.resolve());
    installNavigator({ standalone: true, canShare: () => true, share });

    downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png");

    expect(share).toHaveBeenCalledTimes(1);
    const [{ files }] = share.mock.calls[0];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("shot.png");
    expect(files[0].type).toBe("image/png");
    expect(createElement).not.toHaveBeenCalled();
  });

  it("uses an anchor download outside iOS standalone mode even when share is available", () => {
    const share = mock(() => Promise.resolve());
    installNavigator({ canShare: () => true, share });

    downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png");

    expect(share).not.toHaveBeenCalled();
    expect(anchor.href).toBe("blob:test");
    expect(anchor.download).toBe("shot.png");
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });

  it("falls back to an anchor download when the environment cannot share the file", () => {
    const share = mock(() => Promise.resolve());
    installNavigator({ standalone: true, canShare: () => false, share });

    downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png");

    expect(share).not.toHaveBeenCalled();
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });
});
