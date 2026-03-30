import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { GitHubPRLinkWithStatus, GitHubPRStatus } from "@/common/types/links";
import { PRLinkBadge } from "./PRLinkBadge";

const meta = {
  ...lightweightMeta,
  title: "App/Header/PRLinkBadge",
  component: PRLinkBadge,
} satisfies Meta<typeof PRLinkBadge>;

export default meta;

type Story = StoryObj<typeof meta>;

function StoryLayout(props: { children: ReactNode }) {
  return (
    <div className="bg-background p-6">
      <div className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border-medium)] bg-[var(--color-card)] p-2">
        {props.children}
      </div>
    </div>
  );
}

function makePRLink(
  number: number,
  statusOverrides: Partial<GitHubPRStatus> = {},
  overrides: Partial<GitHubPRLinkWithStatus> = {}
): GitHubPRLinkWithStatus {
  return {
    type: "github-pr",
    url: `https://github.com/coder/mux/pull/${number}`,
    owner: "coder",
    repo: "mux",
    number,
    detectedAt: 1_700_000_000_000,
    occurrenceCount: 1,
    status: {
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      title: "feat: add first-class link support",
      isDraft: false,
      headRefName: "feature/links",
      baseRefName: "main",
      fetchedAt: 1_700_000_000_000,
      ...statusOverrides,
    },
    ...overrides,
  };
}

/** Single badge in the ready-to-merge state */
export const ReadyToMerge: Story = {
  args: {
    prLink: makePRLink(1623),
  },
  render: (args) => (
    <StoryLayout>
      <PRLinkBadge {...args} />
    </StoryLayout>
  ),
};

/** Gallery of common PR badge statuses from the deleted app-level story */
export const PRStatusBadges: Story = {
  render: () => {
    const badges: Array<{ label: string; prLink: GitHubPRLinkWithStatus }> = [
      {
        label: "Ready to merge",
        prLink: makePRLink(1623, { mergeStateStatus: "CLEAN", title: "feat: add link support" }),
      },
      {
        label: "Checks pending",
        prLink: makePRLink(1624, {
          mergeStateStatus: "BLOCKED",
          title: "fix: resolve flaky test",
          hasPendingChecks: true,
        }),
      },
      {
        label: "Checks failing",
        prLink: makePRLink(1628, {
          mergeStateStatus: "BLOCKED",
          title: "fix: failing checks",
          hasFailedChecks: true,
        }),
      },
      {
        label: "Behind base branch",
        prLink: makePRLink(1625, {
          mergeStateStatus: "BEHIND",
          title: "docs: update README",
        }),
      },
      {
        label: "Draft PR",
        prLink: makePRLink(1627, {
          mergeStateStatus: "DRAFT",
          mergeable: "UNKNOWN",
          isDraft: true,
          title: "WIP: experimental feature",
        }),
      },
      {
        label: "Merged",
        prLink: makePRLink(1620, {
          state: "MERGED",
          mergeStateStatus: "UNKNOWN",
          mergeable: "UNKNOWN",
          title: "feat: previous feature",
        }),
      },
      {
        label: "Closed",
        prLink: makePRLink(1618, {
          state: "CLOSED",
          mergeStateStatus: "UNKNOWN",
          mergeable: "UNKNOWN",
          title: "feat: abandoned approach",
        }),
      },
    ];

    return (
      <div className="bg-background p-6">
        <div className="grid max-w-2xl gap-2 rounded-md border border-[var(--color-border-medium)] bg-[var(--color-card)] p-3">
          {badges.map((badge) => (
            <div key={badge.label} className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground text-xs">{badge.label}</span>
              <PRLinkBadge prLink={badge.prLink} />
            </div>
          ))}
        </div>
      </div>
    );
  },
};

/** PR badge alongside a simple links list to mirror the old links-dropdown context */
export const LinksDropdownContext: Story = {
  render: () => {
    const links = [
      "https://docs.example.com/links",
      "https://api.example.com/v1/docs",
      "https://github.com/coder/mux/issues/1500",
      "https://github.com/coder/mux/actions/runs/12345",
    ];

    return (
      <div className="bg-background p-6">
        <div className="max-w-xl space-y-3 rounded-md border border-[var(--color-border-medium)] bg-[var(--color-card)] p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--color-subtle)]">Workspace links</span>
            <PRLinkBadge
              prLink={makePRLink(1623, {
                mergeStateStatus: "CLEAN",
                title: "feat: add link support",
              })}
            />
          </div>
          <div className="rounded border border-[var(--color-border-light)] p-2">
            <p className="text-muted-foreground mb-1 text-xs">Detected links</p>
            <ul className="space-y-1 text-xs">
              {links.map((link) => (
                <li key={link} className="truncate">
                  <a
                    href={link}
                    target="_blank"
                    rel="noreferrer"
                    className="text-link hover:underline"
                  >
                    {link}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  },
};
