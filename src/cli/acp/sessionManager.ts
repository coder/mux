import type * as acpSchema from "@agentclientprotocol/sdk";
import type { ThinkingLevel } from "@/common/types/thinking";
import assert from "@/common/utils/assert";

export interface PromptResolver {
  resolve: (result: acpSchema.PromptResponse) => void;
  reject: (error: Error) => void;
  messageId: string;
  /**
   * Only bind this resolver to a stream-start whose historySequence is strictly
   * greater than this value. This prevents mis-correlating with pre-existing
   * in-flight streams from other producers.
   */
  minHistorySequence: number;
}

export interface SessionState {
  workspaceId: string;
  projectPath: string;
  agentId: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  /** Active onChat subscription abort controller */
  abortController: AbortController;
  /** Resolves when the current prompt completes */
  promptResolver?: PromptResolver;
  /** Whether we've seen caught-up (initial replay is done) */
  caughtUp: boolean;
  /** Resolves when onChat replay emits caught-up */
  caughtUpPromise: Promise<void>;
  /** Call to resolve caughtUpPromise (set once in createSession) */
  resolveCaughtUp: () => void;
  /** Call to reject caughtUpPromise when replay cannot complete */
  rejectCaughtUp: (error: Error) => void;
  /** Whether the first prompt has been sent (for name generation) */
  firstPromptSent: boolean;
  /** Whether this session was created via newSession (true) or loadSession (false) */
  isNewSession: boolean;
  /** Whether first-prompt auto-naming should run for this session */
  needsAutoName: boolean;
  /** Highest historySequence seen from any stream-start on this session */
  lastSeenHistorySequence: number;
  /** Whether the session's onChat subscription has dropped/failed permanently */
  subscriptionDead: boolean;
}

interface SessionStateInit {
  workspaceId: string;
  projectPath: string;
  agentId: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  isNewSession: boolean;
  needsAutoName: boolean;
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();

  getSession(sessionId: string): SessionState | undefined {
    assert(sessionId.length > 0, "sessionId must be non-empty");
    return this.sessions.get(sessionId);
  }

  createSession(sessionId: string, state: SessionStateInit): SessionState {
    assert(sessionId.length > 0, "sessionId must be non-empty");
    assert(state.workspaceId.length > 0, "workspaceId must be non-empty");
    assert(state.projectPath.length > 0, "projectPath must be non-empty");
    assert(state.agentId.length > 0, "agentId must be non-empty");
    assert(state.model.length > 0, "model must be non-empty");

    this.removeSession(sessionId);

    let resolveCaughtUp: (() => void) | undefined;
    let rejectCaughtUp: ((error: Error) => void) | undefined;
    const caughtUpPromise = new Promise<void>((resolve, reject) => {
      resolveCaughtUp = resolve;
      rejectCaughtUp = reject;
    });
    // Prevent unhandled rejection if markSubscriptionDead rejects before prompt()
    // attaches its Promise.race handler.
    caughtUpPromise.catch(() => undefined);
    assert(resolveCaughtUp != null, "caughtUpPromise resolver must be initialized");
    assert(rejectCaughtUp != null, "caughtUpPromise rejecter must be initialized");

    const nextState: SessionState = {
      ...state,
      abortController: new AbortController(),
      caughtUp: false,
      caughtUpPromise,
      resolveCaughtUp,
      rejectCaughtUp,
      firstPromptSent: false,
      isNewSession: state.isNewSession,
      needsAutoName: state.needsAutoName,
      lastSeenHistorySequence: -1,
      subscriptionDead: false,
    };

    this.sessions.set(sessionId, nextState);
    return nextState;
  }

  removeSession(sessionId: string): void {
    assert(sessionId.length > 0, "sessionId must be non-empty");

    const existing = this.sessions.get(sessionId);
    if (!existing) {
      return;
    }

    existing.abortController.abort();

    // Reject replay waiters so prompts awaiting caughtUpPromise don't hang
    // until their timeout when a session is disposed during replay.
    if (!existing.caughtUp) {
      existing.rejectCaughtUp(new Error(`Session ${sessionId} was disposed during replay`));
    }

    if (existing.promptResolver) {
      existing.promptResolver.reject(new Error(`Session ${sessionId} was disposed`));
      existing.promptResolver = undefined;
    }

    this.sessions.delete(sessionId);
  }

  /** Set the prompt resolver for a session (called before sendMessage) */
  setPromptResolver(sessionId: string, resolver: SessionState["promptResolver"]): void {
    assert(sessionId.length > 0, "sessionId must be non-empty");
    assert(resolver != null, "prompt resolver is required");

    const session = this.sessions.get(sessionId);
    assert(session, `Cannot set prompt resolver for unknown session ${sessionId}`);
    assert(
      session.promptResolver == null,
      `Session ${sessionId} already has an active prompt resolver`
    );

    session.promptResolver = resolver;
  }

  /** Clear the prompt resolver */
  clearPromptResolver(sessionId: string): void {
    assert(sessionId.length > 0, "sessionId must be non-empty");

    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.promptResolver = undefined;
  }

  markSubscriptionDead(sessionId: string): void {
    assert(sessionId.length > 0, "sessionId must be non-empty");

    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.subscriptionDead = true;

    // Reject replay waiters immediately when subscription dies so prompt()
    // callers fail fast instead of waiting for the caught-up timeout.
    if (!session.caughtUp) {
      session.rejectCaughtUp(new Error("Chat subscription failed before replay completed"));
    }
  }

  markCaughtUp(sessionId: string): void {
    assert(sessionId.length > 0, "sessionId must be non-empty");

    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.caughtUp = true;
    session.resolveCaughtUp();
  }

  /**
   * Try to bind a stream-start's messageId to the active prompt resolver.
   *
   * Correlation uses two guards:
   *   1. historySequence — only bind if the stream-start's sequence is strictly
   *      greater than the one recorded when the prompt was created, which
   *      filters out pre-existing in-flight streams from other producers.
   *   2. First-write-wins — once a messageId is bound, subsequent stream-starts
   *      don't overwrite it.
   *
   * Known limitation: when multiple producers (for example, editor + Mux UI)
   * target the same workspace concurrently, another producer's stream-start can
   * arrive first and steal the binding. A proper fix requires the server to
   * return a request-scoped correlation token from sendMessage.
   *
   * @see MuxAcpAgent.prompt() TODO in src/cli/acp/MuxAcpAgent.ts
   */
  updatePromptMessageId(sessionId: string, messageId: string, historySequence: number): void {
    assert(sessionId.length > 0, "sessionId must be non-empty");
    assert(messageId.length > 0, "messageId must be non-empty");

    const session = this.sessions.get(sessionId);
    if (!session?.promptResolver) {
      return;
    }

    // First-write-wins: don't overwrite once bound.
    if (session.promptResolver.messageId.length > 0) {
      return;
    }

    // Only bind to stream-starts with a sequence strictly after the prompt
    // was created — this skips pre-existing in-flight streams.
    if (historySequence <= session.promptResolver.minHistorySequence) {
      return;
    }

    session.promptResolver.messageId = messageId;
  }

  /** Track the latest historySequence seen for a session. */
  updateLastSeenHistorySequence(sessionId: string, historySequence: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (historySequence > session.lastSeenHistorySequence) {
      session.lastSeenHistorySequence = historySequence;
    }
  }

  /** Update config for a session */
  updateConfig(
    sessionId: string,
    updates: Partial<Pick<SessionState, "agentId" | "model" | "thinkingLevel">>
  ): void {
    assert(sessionId.length > 0, "sessionId must be non-empty");
    assert(updates != null, "updates are required");

    const session = this.sessions.get(sessionId);
    assert(session, `Cannot update unknown session ${sessionId}`);

    if (updates.agentId != null) {
      assert(updates.agentId.length > 0, "agentId update must be non-empty");
      session.agentId = updates.agentId;
    }

    if (updates.model != null) {
      assert(updates.model.length > 0, "model update must be non-empty");
      session.model = updates.model;
    }

    if (updates.thinkingLevel != null) {
      session.thinkingLevel = updates.thinkingLevel;
    }
  }

  disposeAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.removeSession(sessionId);
    }
  }
}
