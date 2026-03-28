import { assert } from "@/common/utils/assert";
import { log } from "@/node/services/log";
import type { BrowserControlService } from "./BrowserControlService";

export interface PageState {
  type: "page_state";
  url: string | null;
  isLoading: boolean;
  source: "bootstrap" | "command" | "poll";
}

type PageStateSubscriber = (state: PageState) => void;

interface SessionEntry {
  state: PageState;
  generation: number;
  refreshId: number;
  subscribers: Set<PageStateSubscriber>;
  pollTimer: ReturnType<typeof setInterval> | null;
  hasSnapshot: boolean;
  bootstrapPromise: Promise<void> | null;
  pollInFlight: boolean;
  pollRequestId: number;
  commandGeneration: number;
  // Track every in-flight command token so late completions from the same entry can
  // still clear loading state without allowing tokens from a deleted entry lifecycle
  // to mutate the recreated entry.
  outstandingTokens: Set<number>;
}

export interface BrowserSessionStateHubOptions {
  browserControlService: Pick<BrowserControlService, "getUrl">;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;

export class BrowserSessionStateHub {
  private readonly browserControlService: Pick<BrowserControlService, "getUrl">;
  private readonly pollIntervalMs: number;
  private readonly sessionEntries = new Map<string, SessionEntry>();
  private nextCommandToken = 1;

  constructor(options: BrowserSessionStateHubOptions) {
    assert(
      options.browserControlService,
      "BrowserSessionStateHub requires a browserControlService"
    );

    this.browserControlService = options.browserControlService;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    assert(this.pollIntervalMs > 0, "BrowserSessionStateHub pollIntervalMs must be positive");
  }

  public subscribe(
    workspaceId: string,
    sessionName: string,
    callback: PageStateSubscriber
  ): () => void {
    this.assertValidSessionIdentifiers(workspaceId, sessionName);
    assert(typeof callback === "function", "BrowserSessionStateHub subscriber must be a function");

    const sessionKey = this.createSessionKey(workspaceId, sessionName);
    const entry = this.getOrCreateEntry(sessionKey);
    entry.subscribers.add(callback);

    if (entry.subscribers.size === 1) {
      this.startPolling(sessionKey, workspaceId, sessionName, entry);
    }

    if (entry.hasSnapshot) {
      this.notifySubscriber(sessionKey, callback, entry.state);
    } else {
      this.ensureBootstrap(sessionKey, workspaceId, sessionName);
    }

    return () => {
      const currentEntry = this.sessionEntries.get(sessionKey);
      if (!currentEntry) {
        return;
      }

      currentEntry.subscribers.delete(callback);
      if (currentEntry.subscribers.size === 0) {
        this.stopPolling(currentEntry);
        this.sessionEntries.delete(sessionKey);
      }
    };
  }

  public markLoading(workspaceId: string, sessionName: string): number {
    this.assertValidSessionIdentifiers(workspaceId, sessionName);

    const sessionKey = this.createSessionKey(workspaceId, sessionName);
    const entry = this.sessionEntries.get(sessionKey);
    if (!entry) {
      // The last subscriber may have disconnected while the command was being prepared.
      // Do not recreate the session entry, or a later reconnect could observe a reset token state.
      return -1;
    }

    const token = this.nextCommandToken++;
    assert(
      Number.isSafeInteger(token) && token > 0,
      "BrowserSessionStateHub command token must stay a positive safe integer"
    );
    entry.commandGeneration = token;
    entry.outstandingTokens.add(token);
    assert(
      entry.outstandingTokens.has(token),
      "BrowserSessionStateHub must track every in-flight command token"
    );
    entry.generation += 1;
    this.publish(sessionKey, entry, {
      type: "page_state",
      url: entry.hasSnapshot ? entry.state.url : null,
      isLoading: true,
      source: "command",
    });
    return token;
  }

  public markLoaded(
    workspaceId: string,
    sessionName: string,
    url: string | null | undefined,
    commandToken?: number
  ): void {
    this.assertValidSessionIdentifiers(workspaceId, sessionName);
    this.assertValidUrl(url);
    assert(
      commandToken === undefined ||
        commandToken === -1 ||
        (Number.isSafeInteger(commandToken) && commandToken > 0),
      "BrowserSessionStateHub commandToken must be -1 or a positive safe integer when provided"
    );

    const sessionKey = this.createSessionKey(workspaceId, sessionName);
    const entry = this.sessionEntries.get(sessionKey);
    if (!entry) {
      // The session was cleaned up after the last subscriber left; ignore late command completion.
      return;
    }

    if (commandToken === -1) {
      // markLoading returns -1 when the session entry disappeared before the command began.
      // Ignore that sentinel so a recreated entry never has its count decremented by mistake.
      return;
    }

    // If a token is no longer outstanding, it belongs to an earlier deleted entry
    // lifecycle and must not change the recreated entry's loading count or URL.
    if (commandToken !== undefined && !entry.outstandingTokens.has(commandToken)) {
      return;
    }

    if (commandToken !== undefined) {
      entry.outstandingTokens.delete(commandToken);
    }

    const isLatestCommand = commandToken !== undefined && commandToken === entry.commandGeneration;
    const resolvedUrl =
      commandToken === undefined
        ? (url ?? entry.state.url)
        : isLatestCommand && url !== undefined
          ? url
          : entry.state.url;
    const isLoading = entry.outstandingTokens.size > 0;
    entry.generation += 1;
    this.publish(sessionKey, entry, {
      type: "page_state",
      url: resolvedUrl,
      isLoading,
      source: "command",
    });
  }

  public dispose(): void {
    for (const entry of this.sessionEntries.values()) {
      this.stopPolling(entry);
    }
    this.sessionEntries.clear();
  }

  private assertValidSessionIdentifiers(workspaceId: string, sessionName: string): void {
    assert(typeof workspaceId === "string", "BrowserSessionStateHub workspaceId must be a string");
    assert(typeof sessionName === "string", "BrowserSessionStateHub sessionName must be a string");
    assert(
      workspaceId.trim().length > 0,
      "BrowserSessionStateHub requires a non-empty workspaceId"
    );
    assert(
      sessionName.trim().length > 0,
      "BrowserSessionStateHub requires a non-empty sessionName"
    );
  }

  private assertValidUrl(url: string | null | undefined): void {
    assert(
      url === undefined || url === null || typeof url === "string",
      "BrowserSessionStateHub page state url must be a string, null, or undefined"
    );
    if (typeof url === "string") {
      assert(url.trim().length > 0, "BrowserSessionStateHub page state url must be non-empty");
    }
  }

  private createSessionKey(workspaceId: string, sessionName: string): string {
    this.assertValidSessionIdentifiers(workspaceId, sessionName);
    return `${workspaceId}:${sessionName}`;
  }

  private getOrCreateEntry(sessionKey: string): SessionEntry {
    const existingEntry = this.sessionEntries.get(sessionKey);
    if (existingEntry) {
      return existingEntry;
    }

    const entry: SessionEntry = {
      state: {
        type: "page_state",
        url: null,
        isLoading: false,
        source: "bootstrap",
      },
      generation: 0,
      refreshId: 0,
      subscribers: new Set(),
      pollTimer: null,
      hasSnapshot: false,
      bootstrapPromise: null,
      pollInFlight: false,
      pollRequestId: 0,
      commandGeneration: 0,
      outstandingTokens: new Set<number>(),
    };
    this.sessionEntries.set(sessionKey, entry);
    return entry;
  }

  private startPolling(
    sessionKey: string,
    workspaceId: string,
    sessionName: string,
    entry: SessionEntry
  ): void {
    if (entry.pollTimer) {
      return;
    }

    entry.pollTimer = setInterval(() => {
      const currentEntry = this.sessionEntries.get(sessionKey);
      if (!currentEntry || currentEntry.subscribers.size === 0 || currentEntry.pollInFlight) {
        return;
      }

      currentEntry.pollRequestId += 1;
      const pollRequestId = currentEntry.pollRequestId;
      currentEntry.pollInFlight = true;
      const pollTimeout = setTimeout(() => {
        const stalledEntry = this.sessionEntries.get(sessionKey);
        if (!stalledEntry?.pollInFlight || stalledEntry.pollRequestId !== pollRequestId) {
          return;
        }

        log.warn("BrowserSessionStateHub: poll timed out, clearing pollInFlight", {
          workspaceId,
          sessionName,
          sessionKey,
        });
        // Invalidate this request before clearing the flag so a late finally cannot
        // release a newer poll that already reclaimed pollInFlight.
        stalledEntry.pollRequestId += 1;
        stalledEntry.pollInFlight = false;
      }, this.pollIntervalMs * 2);
      pollTimeout.unref?.();

      void this.fetchAndApplyUrl(sessionKey, workspaceId, sessionName, "poll").finally(() => {
        clearTimeout(pollTimeout);
        const settledEntry = this.sessionEntries.get(sessionKey);
        if (settledEntry?.pollRequestId === pollRequestId) {
          settledEntry.pollInFlight = false;
        }
      });
    }, this.pollIntervalMs);
    entry.pollTimer.unref?.();
  }

  private stopPolling(entry: SessionEntry): void {
    if (!entry.pollTimer) {
      return;
    }

    clearInterval(entry.pollTimer);
    entry.pollTimer = null;
  }

  private ensureBootstrap(sessionKey: string, workspaceId: string, sessionName: string): void {
    const entry = this.sessionEntries.get(sessionKey);
    if (!entry || entry.hasSnapshot || entry.bootstrapPromise) {
      return;
    }

    const bootstrapPromise = this.fetchAndApplyUrl(
      sessionKey,
      workspaceId,
      sessionName,
      "bootstrap"
    ).finally(() => {
      const currentEntry = this.sessionEntries.get(sessionKey);
      if (currentEntry?.bootstrapPromise === bootstrapPromise) {
        currentEntry.bootstrapPromise = null;
      }
    });
    entry.bootstrapPromise = bootstrapPromise;
  }

  private async fetchAndApplyUrl(
    sessionKey: string,
    workspaceId: string,
    sessionName: string,
    source: PageState["source"]
  ): Promise<void> {
    const startingEntry = this.sessionEntries.get(sessionKey);
    if (!startingEntry) {
      return;
    }

    const generationAtStart = startingEntry.generation;
    const refreshId = startingEntry.refreshId + 1;
    startingEntry.refreshId = refreshId;
    let urlResult: Awaited<ReturnType<BrowserControlService["getUrl"]>>;
    try {
      urlResult = await this.browserControlService.getUrl(workspaceId, sessionName, {
        skipSessionValidation: true,
      });
    } catch (error) {
      log.warn("BrowserSessionStateHub: getUrl threw while refreshing page state", {
        workspaceId,
        sessionName,
        source,
        error,
      });
      return;
    }

    if (urlResult.error) {
      log.warn("BrowserSessionStateHub: getUrl failed while refreshing page state", {
        workspaceId,
        sessionName,
        source,
        error: urlResult.error,
      });
      return;
    }

    const currentEntry = this.sessionEntries.get(sessionKey);
    if (currentEntry?.generation !== generationAtStart || currentEntry.refreshId !== refreshId) {
      return;
    }

    const isLoading = currentEntry.outstandingTokens.size > 0;
    const shouldPublish =
      !currentEntry.hasSnapshot ||
      currentEntry.state.url !== urlResult.url ||
      currentEntry.state.isLoading !== isLoading;
    if (!shouldPublish) {
      return;
    }

    this.publish(sessionKey, currentEntry, {
      type: "page_state",
      url: urlResult.url,
      isLoading,
      source,
    });
  }

  private publish(sessionKey: string, entry: SessionEntry, state: PageState): void {
    entry.state = state;
    entry.hasSnapshot = true;

    for (const subscriber of entry.subscribers) {
      this.notifySubscriber(sessionKey, subscriber, state);
    }
  }

  private notifySubscriber(
    sessionKey: string,
    subscriber: PageStateSubscriber,
    state: PageState
  ): void {
    try {
      subscriber(state);
    } catch (error) {
      log.warn("BrowserSessionStateHub: subscriber callback failed", { sessionKey, error });
    }
  }
}
