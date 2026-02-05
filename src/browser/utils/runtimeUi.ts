import type { ComponentType } from "react";
import type { RuntimeMode } from "@/common/types/runtime";
import {
  SSHIcon,
  WorktreeIcon,
  LocalIcon,
  DockerIcon,
  DevcontainerIcon,
  CoderIcon,
} from "@/browser/components/icons/RuntimeIcons";

export interface RuntimeIconProps {
  size?: number;
  className?: string;
}

export interface RuntimeUiSpec {
  label: string;
  description: string;
  docsPath: string;
  Icon: ComponentType<RuntimeIconProps>;
  button: {
    activeClass: string;
    idleClass: string;
  };
  iconButton: {
    activeClass: string;
    idleClass: string;
  };
  badge: {
    idleClass: string;
    workingClass: string;
  };
}

export type RuntimeChoice = RuntimeMode | "coder";
export type RuntimeBadgeType = RuntimeChoice;

export const RUNTIME_UI = {
  local: {
    label: "Local",
    description: "Work directly in project directory (no isolation)",
    docsPath: "/runtime/local",
    Icon: LocalIcon,
    button: {
      activeClass:
        "bg-[var(--color-runtime-local)]/30 text-foreground border-[var(--color-runtime-local)]/60",
      idleClass:
        "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-local)]/40",
    },
    iconButton: {
      activeClass:
        "bg-[var(--color-runtime-local)]/30 text-foreground border-[var(--color-runtime-local)]/60",
      idleClass:
        "bg-transparent text-muted border-[var(--color-runtime-local)]/30 hover:border-[var(--color-runtime-local)]/50",
    },
    badge: {
      idleClass: "bg-transparent text-muted border-[var(--color-runtime-local)]/50",
      workingClass:
        "bg-[var(--color-runtime-local)]/30 text-[var(--color-runtime-local)] border-[var(--color-runtime-local)]/60 animate-pulse",
    },
  },
  worktree: {
    label: "Worktree",
    description: "Isolated git worktree in ~/.mux/src",
    docsPath: "/runtime/worktree",
    Icon: WorktreeIcon,
    button: {
      activeClass:
        "bg-[var(--color-runtime-worktree)]/20 text-[var(--color-runtime-worktree-text)] border-[var(--color-runtime-worktree)]/60",
      idleClass:
        "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-worktree)]/40",
    },
    iconButton: {
      activeClass:
        "bg-[var(--color-runtime-worktree)]/20 text-[var(--color-runtime-worktree-text)] border-[var(--color-runtime-worktree)]/60",
      idleClass:
        "bg-transparent text-muted border-[var(--color-runtime-worktree)]/30 hover:border-[var(--color-runtime-worktree)]/50",
    },
    badge: {
      idleClass: "bg-transparent text-muted border-[var(--color-runtime-worktree)]/50",
      workingClass:
        "bg-[var(--color-runtime-worktree)]/20 text-[var(--color-runtime-worktree-text)] border-[var(--color-runtime-worktree)]/60 animate-pulse",
    },
  },
  ssh: {
    label: "SSH",
    description: "Remote clone on SSH host",
    docsPath: "/runtime/ssh",
    Icon: SSHIcon,
    button: {
      activeClass:
        "bg-[var(--color-runtime-ssh)]/20 text-[var(--color-runtime-ssh-text)] border-[var(--color-runtime-ssh)]/60",
      idleClass:
        "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-ssh)]/40",
    },
    iconButton: {
      activeClass:
        "bg-[var(--color-runtime-ssh)]/20 text-[var(--color-runtime-ssh-text)] border-[var(--color-runtime-ssh)]/60",
      idleClass:
        "bg-transparent text-muted border-[var(--color-runtime-ssh)]/30 hover:border-[var(--color-runtime-ssh)]/50",
    },
    badge: {
      idleClass: "bg-transparent text-muted border-[var(--color-runtime-ssh)]/50",
      workingClass:
        "bg-[var(--color-runtime-ssh)]/20 text-[var(--color-runtime-ssh-text)] border-[var(--color-runtime-ssh)]/60 animate-pulse",
    },
  },
  docker: {
    label: "Docker",
    description: "Isolated container per workspace",
    docsPath: "/runtime/docker",
    Icon: DockerIcon,
    button: {
      activeClass:
        "bg-[var(--color-runtime-docker)]/20 text-[var(--color-runtime-docker-text)] border-[var(--color-runtime-docker)]/60",
      idleClass:
        "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-docker)]/40",
    },
    iconButton: {
      activeClass:
        "bg-[var(--color-runtime-docker)]/20 text-[var(--color-runtime-docker-text)] border-[var(--color-runtime-docker)]/60",
      idleClass:
        "bg-transparent text-muted border-[var(--color-runtime-docker)]/30 hover:border-[var(--color-runtime-docker)]/50",
    },
    badge: {
      idleClass: "bg-transparent text-muted border-[var(--color-runtime-docker)]/50",
      workingClass:
        "bg-[var(--color-runtime-docker)]/20 text-[var(--color-runtime-docker-text)] border-[var(--color-runtime-docker)]/60 animate-pulse",
    },
  },
  devcontainer: {
    label: "Dev container",
    description: "Uses project's devcontainer.json configuration",
    docsPath: "/runtime/devcontainer",
    Icon: DevcontainerIcon,
    button: {
      activeClass:
        "bg-[var(--color-runtime-devcontainer)]/20 text-[var(--color-runtime-devcontainer-text)] border-[var(--color-runtime-devcontainer)]/60",
      idleClass:
        "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-devcontainer)]/40",
    },
    iconButton: {
      activeClass:
        "bg-[var(--color-runtime-devcontainer)]/20 text-[var(--color-runtime-devcontainer-text)] border-[var(--color-runtime-devcontainer)]/60",
      idleClass:
        "bg-transparent text-muted border-[var(--color-runtime-devcontainer)]/30 hover:border-[var(--color-runtime-devcontainer)]/50",
    },
    badge: {
      idleClass: "bg-transparent text-muted border-[var(--color-runtime-devcontainer)]/50",
      workingClass:
        "bg-[var(--color-runtime-devcontainer)]/20 text-[var(--color-runtime-devcontainer-text)] border-[var(--color-runtime-devcontainer)]/60 animate-pulse",
    },
  },
} satisfies Record<RuntimeMode, RuntimeUiSpec>;

const CODER_RUNTIME_UI: RuntimeUiSpec = {
  ...RUNTIME_UI.ssh,
  label: "Coder",
  description: "Coder workspace via the Coder CLI",
  docsPath: "/runtime/coder",
  Icon: CoderIcon,
};

export const RUNTIME_CHOICE_UI = {
  ...RUNTIME_UI,
  coder: CODER_RUNTIME_UI,
} satisfies Record<RuntimeChoice, RuntimeUiSpec>;

export const RUNTIME_BADGE_UI = {
  ssh: {
    Icon: RUNTIME_UI.ssh.Icon,
    badge: RUNTIME_UI.ssh.badge,
  },
  coder: {
    Icon: CODER_RUNTIME_UI.Icon,
    badge: CODER_RUNTIME_UI.badge,
  },
  worktree: {
    Icon: RUNTIME_UI.worktree.Icon,
    badge: RUNTIME_UI.worktree.badge,
  },
  local: {
    Icon: RUNTIME_UI.local.Icon,
    badge: RUNTIME_UI.local.badge,
  },
  docker: {
    Icon: RUNTIME_UI.docker.Icon,
    badge: RUNTIME_UI.docker.badge,
  },
  devcontainer: {
    Icon: RUNTIME_UI.devcontainer.Icon,
    badge: RUNTIME_UI.devcontainer.badge,
  },
} satisfies Record<RuntimeBadgeType, Pick<RuntimeUiSpec, "Icon" | "badge">>;
