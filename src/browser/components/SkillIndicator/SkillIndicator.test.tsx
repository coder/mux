import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { SkillIndicator } from "./SkillIndicator";
import type {
  LoadedSkill,
  SkillLoadError,
} from "@/browser/utils/messages/StreamingMessageAggregator";
import type { AgentSkillDescriptor, AgentSkillIssue } from "@/common/types/agentSkill";

function createAvailableSkills(total: number): AgentSkillDescriptor[] {
  return Array.from({ length: total }, (_, index) => ({
    name: `skill-${index + 1}`,
    description: `Skill ${index + 1}`,
    scope: "project",
  }));
}

function createInvalidSkills(total: number): AgentSkillIssue[] {
  return Array.from({ length: total }, (_, index) => ({
    directoryName: `broken-skill-${index + 1}`,
    scope: "project",
    displayPath: `/.mux/skills/broken-skill-${index + 1}/SKILL.md`,
    message: "Invalid SKILL.md",
  }));
}

function createSkillLoadErrors(total: number): SkillLoadError[] {
  return Array.from({ length: total }, (_, index) => ({
    name: `failed-skill-${index + 1}`,
    error: "Load failed",
  }));
}

type SkillIndicatorProps = React.ComponentProps<typeof SkillIndicator>;

function renderSkillIndicator(overrides: Partial<SkillIndicatorProps> = {}) {
  const availableSkills = overrides.availableSkills ?? createAvailableSkills(5);
  const loadedSkills = overrides.loadedSkills ?? (availableSkills.slice(0, 2) as LoadedSkill[]);

  return render(
    <SkillIndicator
      loadedSkills={loadedSkills}
      availableSkills={availableSkills}
      invalidSkills={overrides.invalidSkills ?? []}
      skillLoadErrors={overrides.skillLoadErrors ?? []}
      className={overrides.className}
    />
  );
}

function getBadge(button: HTMLElement): HTMLSpanElement {
  const badge = button.querySelector("span[title]");
  if (!badge || badge.tagName !== "SPAN") {
    throw new Error("Expected SkillIndicator badge span");
  }
  return badge as HTMLSpanElement;
}

let cleanupDom: (() => void) | null = null;

describe("SkillIndicator", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("shows loaded/total badge text when healthy", () => {
    const { getByLabelText } = renderSkillIndicator();

    const button = getByLabelText("2 of 5 skills loaded");
    const badge = getBadge(button);

    expect(badge.textContent).toBe("2/5");
    expect(badge.getAttribute("title")).toBe("2 of 5 skills loaded");
    expect(badge.className.includes("border-danger")).toBe(false);
  });

  test("shows 0/total when no skills are loaded and no errors", () => {
    const { getByLabelText } = renderSkillIndicator({ loadedSkills: [] });

    const button = getByLabelText("0 of 5 skills loaded");
    const badge = getBadge(button);

    expect(badge.textContent).toBe("0/5");
    expect(badge.getAttribute("title")).toBe("0 of 5 skills loaded");
  });

  test("shows load error count and danger styling when load errors exist", () => {
    const { getByLabelText } = renderSkillIndicator({
      skillLoadErrors: createSkillLoadErrors(1),
    });

    const button = getByLabelText("2 of 5 skills loaded, 1 load error");
    const badge = getBadge(button);

    expect(badge.textContent).toBe("1");
    expect(badge.getAttribute("title")).toBe("1 skill issue");
    expect(badge.className.includes("border-danger")).toBe(true);
  });

  test("shows invalid skill count when invalid skills exist", () => {
    const { getByLabelText } = renderSkillIndicator({
      invalidSkills: createInvalidSkills(2),
    });

    const button = getByLabelText("2 of 5 skills loaded, 2 invalid");
    const badge = getBadge(button);

    expect(badge.textContent).toBe("2");
    expect(badge.getAttribute("title")).toBe("2 skill issues");
  });

  test("shows combined error count when both invalid and load errors exist", () => {
    const { getByLabelText } = renderSkillIndicator({
      invalidSkills: createInvalidSkills(2),
      skillLoadErrors: createSkillLoadErrors(1),
    });

    const button = getByLabelText("2 of 5 skills loaded, 2 invalid, 1 load error");
    const badge = getBadge(button);

    expect(badge.textContent).toBe("3");
    expect(badge.getAttribute("title")).toBe("3 skill issues");
  });

  test("aria-label includes loaded count plus invalid and load error details", () => {
    const { getByLabelText } = renderSkillIndicator({
      availableSkills: createAvailableSkills(3),
      loadedSkills: createAvailableSkills(3).slice(0, 1),
      invalidSkills: createInvalidSkills(1),
      skillLoadErrors: createSkillLoadErrors(2),
    });

    const button = getByLabelText("1 of 3 skills loaded, 1 invalid, 2 load errors");
    expect(button.getAttribute("aria-label")).toBe(
      "1 of 3 skills loaded, 1 invalid, 2 load errors"
    );
  });

  test("returns null when there are no available skills and no errors", () => {
    const { container } = renderSkillIndicator({
      loadedSkills: [],
      availableSkills: [],
      invalidSkills: [],
      skillLoadErrors: [],
    });

    expect(container.innerHTML).toBe("");
  });
});
