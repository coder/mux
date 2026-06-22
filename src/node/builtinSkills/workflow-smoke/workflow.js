export const meta = {
  name: "Workflow Smoke",
  description: "Return a deterministic report from a packaged built-in skill workflow.",
};

export default async function workflow({ args, phase, log }) {
  const message = typeof args?.message === "string" ? args.message : "ok";
  phase("Smoke");
  log("Returning smoke workflow report", { message });
  return { reportMarkdown: `# Workflow Smoke\n\n${message}` };
}
