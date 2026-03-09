// Auto plan->executor routing can spend up to the router timeout selecting an executor.
// We surface this as a transient sidebar status so users know the handoff is still progressing.
export const PLAN_AUTO_ROUTING_STATUS_EMOJI = "🤔";
export const PLAN_AUTO_ROUTING_STATUS_MESSAGE = "Deciding execution strategy…";
