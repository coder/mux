import { defineManifest } from "mux:extensions";

export const manifest = defineManifest({
  name: "mux-platform-demo",
  displayName: "Mux Platform Demo",
  description:
    "Reference Extension Module that contributes a single advertised skill explaining Mux Extension Modules from inside Mux.",
  capabilities: {
    skills: true,
  },
});

export function activate(ctx: {
  skills: {
    register(input: {
      name: string;
      bodyPath: string;
      displayName?: string;
      description?: string;
      advertise?: boolean;
    }): { dispose(): void };
  };
}): void {
  ctx.skills.register({
    name: "mux-extensions",
    displayName: "Mux Extensions",
    description:
      "Explains how Mux Extension Modules work: roots, trust, enablement, source locks, contributions, and skill precedence.",
    bodyPath: "./SKILL.md",
    advertise: true,
  });
}
