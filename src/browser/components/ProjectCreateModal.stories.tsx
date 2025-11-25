import type { Meta, StoryObj } from "@storybook/react-vite";
import { action } from "storybook/actions";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useState, useMemo } from "react";
import { ProjectCreateModal } from "./ProjectCreateModal";
import { ORPCProvider, type ORPCClient } from "@/browser/orpc/react";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";

// Mock file tree structure for directory picker
const mockFileTree: FileTreeNode = {
  name: "home",
  path: "/home",
  isDirectory: true,
  children: [
    {
      name: "user",
      path: "/home/user",
      isDirectory: true,
      children: [
        {
          name: "projects",
          path: "/home/user/projects",
          isDirectory: true,
          children: [
            {
              name: "my-app",
              path: "/home/user/projects/my-app",
              isDirectory: true,
              children: [],
            },
            {
              name: "api-server",
              path: "/home/user/projects/api-server",
              isDirectory: true,
              children: [],
            },
          ],
        },
        {
          name: "documents",
          path: "/home/user/documents",
          isDirectory: true,
          children: [],
        },
      ],
    },
  ],
};

// Find a node in the mock tree by path
function findNodeByPath(root: FileTreeNode, targetPath: string): FileTreeNode | null {
  // Normalize paths for comparison
  const normTarget = targetPath.replace(/\/\.\.$/, ""); // Handle parent nav
  if (targetPath.endsWith("/..")) {
    // Navigate to parent
    const parts = normTarget.split("/").filter(Boolean);
    parts.pop();
    const parentPath = "/" + parts.join("/");
    return findNodeByPath(root, parentPath || "/");
  }

  if (root.path === targetPath) return root;
  for (const child of root.children) {
    const found = findNodeByPath(child, targetPath);
    if (found) return found;
  }
  return null;
}

// Create mock ORPC client for stories
function createMockClient(options?: { onProjectCreate?: (path: string) => void }): ORPCClient {
  return {
    projects: {
      list: () => Promise.resolve([]),
      create: (input: { projectPath: string }) => {
        options?.onProjectCreate?.(input.projectPath);
        return Promise.resolve({
          success: true as const,
          data: {
            normalizedPath: input.projectPath,
            projectConfig: { workspaces: [] },
          },
        });
      },
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      pickDirectory: () => Promise.resolve(null),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    },
    general: {
      listDirectory: async (input: { path: string }) => {
        // Simulate async delay
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Handle "." as starting path
        const targetPath = input.path === "." ? "/home/user" : input.path;
        const node = findNodeByPath(mockFileTree, targetPath);

        if (!node) {
          return {
            success: false as const,
            error: `Directory not found: ${input.path}`,
          };
        }
        return { success: true as const, data: node };
      },
    },
  } as unknown as ORPCClient;
}

// Create mock ORPC client that returns validation error
function createValidationErrorClient(): ORPCClient {
  return {
    projects: {
      list: () => Promise.resolve([]),
      create: () =>
        Promise.resolve({
          success: false as const,
          error: "Not a valid git repository",
        }),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      pickDirectory: () => Promise.resolve(null),
      listBranches: () => Promise.resolve({ branches: [], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    },
    general: {
      listDirectory: () => Promise.resolve({ success: true as const, data: mockFileTree }),
    },
  } as unknown as ORPCClient;
}

const meta = {
  title: "Components/ProjectCreateModal",
  component: ProjectCreateModal,
  parameters: {
    layout: "fullscreen",
  },
  tags: ["autodocs"],
  // Stories that need directory picker use custom wrappers with createMockClient()
  // Other stories use the global ORPCProvider from preview.tsx
} satisfies Meta<typeof ProjectCreateModal>;

export default meta;
type Story = StoryObj<typeof meta>;

// Wrapper component for interactive stories
const ProjectCreateModalWrapper: React.FC<{
  onSuccess?: (path: string) => void;
  startOpen?: boolean;
}> = ({ onSuccess, startOpen = true }) => {
  const [isOpen, setIsOpen] = useState(startOpen);

  return (
    <>
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="bg-accent m-4 rounded px-4 py-2 text-white"
        >
          Open Add Project Modal
        </button>
      )}
      <ProjectCreateModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onSuccess={(path, config) => {
          action("project-created")({ path, config });
          onSuccess?.(path);
          setIsOpen(false);
        }}
      />
    </>
  );
};

// Wrapper that provides custom ORPC client for directory picker stories
const DirectoryPickerStoryWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const client = useMemo(() => createMockClient(), []);
  return <ORPCProvider client={client}>{children}</ORPCProvider>;
};

export const Default: Story = {
  args: {
    isOpen: true,
    onClose: action("close"),
    onSuccess: action("success"),
  },
};

export const WithTypedPath: Story = {
  args: {
    isOpen: true,
    onClose: action("close"),
    onSuccess: action("success"),
  },
  render: () => <ProjectCreateModalWrapper />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for modal to be visible
    await waitFor(async () => {
      await expect(canvas.getByRole("dialog")).toBeInTheDocument();
    });

    // Find and type in the input field
    const input = canvas.getByPlaceholderText("/home/user/projects/my-project");
    await userEvent.type(input, "/home/user/projects/my-app");

    // Verify input value
    await expect(input).toHaveValue("/home/user/projects/my-app");
  },
};

export const BrowseButtonOpensDirectoryPicker: Story = {
  args: {
    isOpen: true,
    onClose: action("close"),
    onSuccess: action("success"),
  },
  render: () => (
    <DirectoryPickerStoryWrapper>
      <ProjectCreateModalWrapper />
    </DirectoryPickerStoryWrapper>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for modal to be visible
    await waitFor(async () => {
      await expect(canvas.getByRole("dialog")).toBeInTheDocument();
    });

    // Find and click the Browse button
    const browseButton = canvas.getByText("Browse…");
    await expect(browseButton).toBeInTheDocument();
    await userEvent.click(browseButton);

    // Wait for DirectoryPickerModal to open (it has title "Select Project Directory")
    await waitFor(async () => {
      await expect(canvas.getByText("Select Project Directory")).toBeInTheDocument();
    });
  },
};

export const DirectoryPickerNavigation: Story = {
  args: {
    isOpen: true,
    onClose: action("close"),
    onSuccess: action("success"),
  },
  render: () => (
    <DirectoryPickerStoryWrapper>
      <ProjectCreateModalWrapper />
    </DirectoryPickerStoryWrapper>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for modal and click Browse
    await waitFor(async () => {
      await expect(canvas.getByRole("dialog")).toBeInTheDocument();
    });

    await userEvent.click(canvas.getByText("Browse…"));

    // Wait for DirectoryPickerModal to open and load directories
    await waitFor(async () => {
      await expect(canvas.getByText("Select Project Directory")).toBeInTheDocument();
    });

    // Wait for directory listing to load (should show subdirectories of /home/user)
    await waitFor(
      async () => {
        await expect(canvas.getByText("projects")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );

    // Navigate into "projects" directory
    await userEvent.click(canvas.getByText("projects"));

    // Wait for subdirectories to load
    await waitFor(
      async () => {
        await expect(canvas.getByText("my-app")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  },
};

export const DirectoryPickerSelectsPath: Story = {
  args: {
    isOpen: true,
    onClose: action("close"),
    onSuccess: action("success"),
  },
  render: () => (
    <DirectoryPickerStoryWrapper>
      <ProjectCreateModalWrapper />
    </DirectoryPickerStoryWrapper>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for modal and click Browse
    await waitFor(async () => {
      await expect(canvas.getByRole("dialog")).toBeInTheDocument();
    });

    await userEvent.click(canvas.getByText("Browse…"));

    // Wait for DirectoryPickerModal
    await waitFor(async () => {
      await expect(canvas.getByText("Select Project Directory")).toBeInTheDocument();
    });

    // Wait for directory listing to load
    await waitFor(
      async () => {
        await expect(canvas.getByText("projects")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );

    // Navigate into projects
    await userEvent.click(canvas.getByText("projects"));

    // Wait for subdirectories
    await waitFor(
      async () => {
        await expect(canvas.getByText("my-app")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );

    // Navigate into my-app
    await userEvent.click(canvas.getByText("my-app"));

    // Wait for path update in subtitle
    await waitFor(
      async () => {
        await expect(canvas.getByText("/home/user/projects/my-app")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );

    // Click Select button
    await userEvent.click(canvas.getByText("Select"));

    // Directory picker should close and path should be in input
    await waitFor(async () => {
      // DirectoryPickerModal should be closed
      await expect(canvas.queryByText("Select Project Directory")).not.toBeInTheDocument();
    });

    // Check that the path was populated in the input
    const input = canvas.getByPlaceholderText("/home/user/projects/my-project");
    await expect(input).toHaveValue("/home/user/projects/my-app");
  },
};

// Wrapper for FullFlowWithDirectoryPicker that captures created path
const FullFlowWrapper: React.FC = () => {
  const [createdPath, setCreatedPath] = useState("");
  const client = useMemo(
    () =>
      createMockClient({
        onProjectCreate: (path) => setCreatedPath(path),
      }),
    []
  );

  return (
    <ORPCProvider client={client}>
      <ProjectCreateModalWrapper onSuccess={() => action("created")(createdPath)} />
    </ORPCProvider>
  );
};

export const FullFlowWithDirectoryPicker: Story = {
  args: {
    isOpen: true,
    onClose: action("close"),
    onSuccess: action("success"),
  },
  render: () => <FullFlowWrapper />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for modal
    await waitFor(async () => {
      await expect(canvas.getByRole("dialog")).toBeInTheDocument();
    });

    // Click Browse
    await userEvent.click(canvas.getByText("Browse…"));

    // Navigate to project directory
    await waitFor(async () => {
      await expect(canvas.getByText("projects")).toBeInTheDocument();
    });
    await userEvent.click(canvas.getByText("projects"));

    await waitFor(async () => {
      await expect(canvas.getByText("api-server")).toBeInTheDocument();
    });
    await userEvent.click(canvas.getByText("api-server"));

    // Wait for path update
    await waitFor(async () => {
      await expect(canvas.getByText("/home/user/projects/api-server")).toBeInTheDocument();
    });

    // Select the directory
    await userEvent.click(canvas.getByText("Select"));

    // Verify path is in input
    await waitFor(async () => {
      const input = canvas.getByPlaceholderText("/home/user/projects/my-project");
      await expect(input).toHaveValue("/home/user/projects/api-server");
    });

    // Click Add Project to complete the flow
    await userEvent.click(canvas.getByRole("button", { name: "Add Project" }));

    // Modal should close after successful creation
    await waitFor(async () => {
      await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
    });
  },
};

// Wrapper for ValidationError story with error-returning client
const ValidationErrorWrapper: React.FC = () => {
  const client = useMemo(() => createValidationErrorClient(), []);
  return (
    <ORPCProvider client={client}>
      <ProjectCreateModal isOpen={true} onClose={action("close")} onSuccess={action("success")} />
    </ORPCProvider>
  );
};

export const ValidationError: Story = {
  args: {
    isOpen: true,
    onClose: action("close"),
    onSuccess: action("success"),
  },
  render: () => <ValidationErrorWrapper />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Type a path
    const input = canvas.getByPlaceholderText("/home/user/projects/my-project");
    await userEvent.type(input, "/invalid/path");

    // Click Add Project
    await userEvent.click(canvas.getByRole("button", { name: "Add Project" }));

    // Wait for error message
    await waitFor(async () => {
      await expect(canvas.getByText("Not a valid git repository")).toBeInTheDocument();
    });
  },
};
