import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { SubAgentListItem } from "./SubAgentListItem";

describe("SubAgentListItem", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("draws the elbow from the parent rail into the child status center", () => {
    const view = render(
      <SubAgentListItem
        connectorPosition="single"
        connectorStartsAtParent
        sharedTrunkActiveThroughRow={false}
        sharedTrunkActiveBelowRow={false}
        ancestorTrunks={[]}
        connectorRailX={18}
        childStatusCenterX={26}
        isSelected={false}
        isElbowActive={false}
      >
        <div>row</div>
      </SubAgentListItem>
    );

    const topSegment = view.getByTestId("subagent-connector-top-segment");
    const elbow = view.getByTestId("subagent-connector-elbow");

    expect(topSegment.getAttribute("style")).toContain("left: 18px");
    expect(elbow.getAttribute("style")).toContain("left: 18px");
    expect(elbow.getAttribute("style")).toContain("width: 8px");
    expect(elbow.getAttribute("class")).toContain("border-l");
  });

  test("supports connector elbows that bend back to the left", () => {
    const view = render(
      <SubAgentListItem
        connectorPosition="single"
        connectorStartsAtParent={false}
        sharedTrunkActiveThroughRow={false}
        sharedTrunkActiveBelowRow={false}
        ancestorTrunks={[]}
        connectorRailX={30}
        childStatusCenterX={26}
        isSelected={false}
        isElbowActive={false}
      >
        <div>row</div>
      </SubAgentListItem>
    );

    const elbow = view.getByTestId("subagent-connector-elbow");

    expect(elbow.getAttribute("style")).toContain("left: 26px");
    expect(elbow.getAttribute("style")).toContain("width: 4px");
    expect(elbow.getAttribute("class")).toContain("border-r");
  });
});
