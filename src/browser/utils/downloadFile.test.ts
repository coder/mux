import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createDownloadRetryCache, downloadBlob } from "./downloadFile";
import { downloadDataUrl } from "./imageActions";

const PNG_DATA_URL = `data:image/png;base64,${btoa("x")}`;

interface AnchorStub {
  href: string;
  download: string;
  click: ReturnType<typeof mock>;
  remove: ReturnType<typeof mock>;
}

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

describe("downloadBlob", () => {
  it("routes through the share sheet in iOS home-screen web apps", async () => {
    const share = mock((_data: { files: File[] }) => Promise.resolve());
    installNavigator({ standalone: true, canShare: () => true, share });

    expect(await downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png")).toBe(true);

    expect(share).toHaveBeenCalledTimes(1);
    const [{ files }] = share.mock.calls[0];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("shot.png");
    expect(files[0].type).toBe("image/png");
    expect(createElement).not.toHaveBeenCalled();
  });

  it("treats a dismissed share sheet as delivered", async () => {
    const share = mock(() => Promise.reject(new DOMException("dismissed", "AbortError")));
    installNavigator({ standalone: true, canShare: () => true, share });

    expect(await downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png")).toBe(true);
    expect(createElement).not.toHaveBeenCalled();
  });

  it("reports a blocked share sheet without falling back to an anchor", async () => {
    // WebKit rejects with NotAllowedError when transient activation expired.
    const share = mock(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    installNavigator({ standalone: true, canShare: () => true, share });

    expect(await downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png")).toBe(false);
    expect(createElement).not.toHaveBeenCalled();
  });

  it("uses an anchor download outside iOS standalone mode even when share is available", async () => {
    const share = mock(() => Promise.resolve());
    installNavigator({ canShare: () => true, share });

    expect(await downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png")).toBe(true);

    expect(share).not.toHaveBeenCalled();
    expect(anchor.href).toBe("blob:test");
    expect(anchor.download).toBe("shot.png");
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });

  it("reports failure instead of an unusable anchor when iOS standalone cannot share the file", async () => {
    const share = mock(() => Promise.resolve());
    installNavigator({ standalone: true, canShare: () => false, share });

    expect(await downloadBlob(new Blob(["x"], { type: "image/png" }), "shot.png")).toBe(false);

    expect(share).not.toHaveBeenCalled();
    expect(anchor.click).not.toHaveBeenCalled();
  });
});

describe("downloadDataUrl", () => {
  it("uses the data URL directly as anchor href outside iOS standalone, without decoding", () => {
    const share = mock(() => Promise.resolve());
    installNavigator({ canShare: () => true, share });

    downloadDataUrl(PNG_DATA_URL, "shot.png");

    expect(share).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(anchor.href).toBe(PNG_DATA_URL);
    expect(anchor.download).toBe("shot.png");
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });

  it("decodes and shares in iOS standalone mode", () => {
    const share = mock((_data: { files: File[] }) => Promise.resolve());
    installNavigator({ standalone: true, canShare: () => true, share });

    downloadDataUrl(PNG_DATA_URL, "shot.png");

    expect(share).toHaveBeenCalledTimes(1);
    expect(anchor.click).not.toHaveBeenCalled();
  });
});

describe("createDownloadRetryCache", () => {
  const fetchedFile = () => ({ blob: new Blob(["x"], { type: "image/png" }), filename: "a.png" });

  it("serves a retry from cache after a blocked share, then clears it once delivered", async () => {
    let shareCalls = 0;
    const share = mock(() => {
      shareCalls += 1;
      return shareCalls === 1
        ? Promise.reject(new DOMException("denied", "NotAllowedError"))
        : Promise.resolve();
    });
    installNavigator({ standalone: true, canShare: () => true, share });
    const fetchFile = mock(() => Promise.resolve(fetchedFile()));
    const downloads = createDownloadRetryCache();

    // First tap: fetch runs, share is blocked, bytes get cached.
    await downloads.download("key", fetchFile);
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(1);

    // Retry tap: shares from cache without refetching.
    await downloads.download("key", fetchFile);
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(2);

    // Delivered, so the cache entry is gone and a new tap refetches.
    await downloads.download("key", fetchFile);
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });

  it("does not cache when the share succeeds immediately", async () => {
    const share = mock(() => Promise.resolve());
    installNavigator({ standalone: true, canShare: () => true, share });
    const fetchFile = mock(() => Promise.resolve(fetchedFile()));
    const downloads = createDownloadRetryCache();

    await downloads.download("key", fetchFile);
    await downloads.download("key", fetchFile);

    expect(fetchFile).toHaveBeenCalledTimes(2);
  });

  it("skips the download when the fetch fails", async () => {
    const share = mock(() => Promise.resolve());
    installNavigator({ standalone: true, canShare: () => true, share });
    const fetchFile = mock(() => Promise.resolve(null));
    const downloads = createDownloadRetryCache();

    await downloads.download("key", fetchFile);

    expect(share).not.toHaveBeenCalled();
    expect(createElement).not.toHaveBeenCalled();
  });
});
