/**
 * Tracks whether a stream attempted validation commands before completion.
 *
 * Validation state is reset whenever a file edit is recorded, so only
 * post-edit validation counts towards the pre-completion guard.
 */
export class StreamVerificationTracker {
  private validationAttempted = false;
  private nudgedBeforeReport = false;

  markValidationAttempt(): void {
    this.validationAttempted = true;
  }

  /** Reset validation state — called when new edits are recorded so that
   *  pre-edit validation doesn't satisfy the post-edit verification guard. */
  resetValidation(): void {
    this.validationAttempted = false;
  }

  hasValidationAttempt(): boolean {
    return this.validationAttempted;
  }

  hasBeenNudged(): boolean {
    return this.nudgedBeforeReport;
  }

  markNudged(): void {
    this.nudgedBeforeReport = true;
  }

  shouldNudgeBeforeAllowingReport(hasEdits: boolean): boolean {
    return hasEdits && !this.validationAttempted && !this.nudgedBeforeReport;
  }
}
