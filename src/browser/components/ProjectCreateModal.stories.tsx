import type { Meta, StoryObj } from "@storybook/react-vite";
import { action } from "storybook/actions";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useState } from "react";
import { ProjectCreateModal } from "./ProjectCreateModal";
import type { IPCApi } from "@/common/types/ipc";
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

// Setup mock API with fs.listDirectory support (browser mode)
function setupMockAPI(options?: { onProjectCreate?: (path: string) => void }) {
  const mockApi: Partial<IPCApi> & { platform: string } = {
    platform: "browser", // Enable web directory picker
    fs: {
      listDirectory: async (path: string) => {
        // Simulate async delay
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Handle "." as starting path
        const targetPath = path === "." ? "/home/user" : path;
        const node = findNodeByPath(mockFileTree, targetPath);

        if (!node) {
          return {
            success: false,
            error: `Directory not found: ${path}`,
          } as unknown as FileTreeNode;
        }
        return node;
      },
    },
    projects: {
      list: () => Promise.resolve([]),
      create: (path: string) => {
        options?.onProjectCreate?.(path);
        return Promise.resolve({
          success: true,
          data: {
            normalizedPath: path,
            projectConfig: { workspaces: [] },
          },
        });
      },
      remove: () => Promise.resolve({ success: true, data: undefined }),
      pickDirectory: () => Promise.resolve(null),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true, data: undefined }),
      },
    },
  };

  // @ts-expect-error - Assigning partial mock API to window for Storybook
  window.api = mockApi;
}

const meta = {
  title: "Components/ProjectCreateModal",
  component: ProjectCreateModal,
  parameters: {
    layout: "fullscreen",
  },
  tags: ["autodocs"],
  decorators: [
    (Story) => {
      setupMockAPI();
      return <Story />;
    },
  ],
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
    await waitFor(() => {
      expect(canvas.getByRole("dialog")).toBeInTheDocument();
    });

    // Find and type in the input field
    const input = canvas.getByPlaceholderText("/home/user/projects/my-project");
    await userEvent.type(input, "/home/user/projects/my-app");

    // Verify input value
    expect(input).toHaveValue("/home/user/projects/my-app");
  },
};

export const BrowseButtonOpensDirectoryPicker: Story = {
  args: {
    isOpen: true,
    onClose: action("close"),
    onSuccess: action("success"),
  },
  render: () => <ProjectCreateModalWrapper />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for modal to be visible
    await waitFor(() => {
      expect(canvas.getByRole("dialog")).toBeInTheDocument();
    });

    // Find and click the Browse button
    const browseButton = canvas.getByText("Browse…");
    expect(browseButton).toBeInTheDocument();
    await userEvent.click(browseButton);

    // Wait for DirectoryPickerModal to open (it has title "Select Project Directory")
    await waitFor(() => {
      expect(canvas.getByText("Select Project Directory")).toBeInTheDocument();
    });
  },
};

export const DirectoryPickerNavigation: Story = {
  args: {
    isOpen: true,
    onClose: action("close"),
    onSuccess: action("success"),
  },
  render: () => <ProjectCreateModalWrapper />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for modal and click Browse
    await waitFor(() => {
      expect(canvas.getByRole("dialog")).toBeInTheDocument();
    });

    await userEvent.click(canvas.getByText("Browse…"));

    // Wait for DirectoryPickerModal to open and load directories
    await waitFor(() => {
      expect(canvas.getByText("Select Project Directory")).toBeInTheDocument();
    });

    // Wait for directory listing to load (should show subdirectories of /home/user)
    await waitFor(
      () => {
        expect(canvas.getByText("projects")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );

    // Navigate into "projects" directory
    await userEvent.click(canvas.getByText("projects"));

    // Wait for subdirectories to load
    await waitFor(
      () => {
        expect(canvas.getByText("my-app")).toBeInTheDocument();
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
  render: () => <ProjectCreateModalWrapper />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for modal and click Browse
    await waitFor(() => {
      expect(canvas.getByRole("dialog")).toBeInTheDocument();
    });

    await userEvent.click(canvas.getByText("Browse…"));

    // Wait for DirectoryPickerModal
    await waitFor(() => {
      expect(canvas.getByText("Select Project Directory")).toBeInTheDocument();
    });

    // Wait for directory listing to load
    await waitFor(
      () => {
        expect(canvas.getByText("projects")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );

    // Navigate into projects
    await userEvent.click(canvas.getByText("projects"));

    // Wait for subdirectories
    await waitFor(
      () => {
        expect(canvas.getByText("my-app")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );

    // Navigate into my-app
    await userEvent.click(canvas.getByText("my-app"));

    // Wait for path update in subtitle
    await waitFor(
      () => {
        expect(canvas.getByText("/home/user/projects/my-app")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );

    // Click Select button
    await userEvent.click(canvas.getByText("Select"));

    // Directory picker should close and path should be in input
    await waitFor(() => {
      // DirectoryPickerModal should be closed
      expect(canvas.queryByText("Select Project Directory")).not.toBeInTheDocument();
    });

    // Check that the path was populated in the input
    const input = canvas.getByPlaceholderText("/home/user/projects/my-project");
    expect(input).toHaveValue("/home/user/projects/my-app");
  },
};

export const FullFlowWithDirectoryPicker: Story = {
  args: {
    isOpen: true,
    onClose: action("close"),
    onSuccess: action("success"),
  },
  render: () => {
    let createdPath = "";
    setupMockAPI({
      onProjectCreate: (path) => {
        createdPath = path;
      },
    });
    return <ProjectCreateModalWrapper onSuccess={() => action("created")(createdPath)} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for modal
    await waitFor(() => {
      expect(canvas.getByRole("dialog")).toBeInTheDocument();
    });

    // Click Browse
    await userEvent.click(canvas.getByText("Browse…"));

    // Navigate to project directory
    await waitFor(() => {
      expect(canvas.getByText("projects")).toBeInTheDocument();
    });
    await userEvent.click(canvas.getByText("projects"));

    await waitFor(() => {
      expect(canvas.getByText("api-server")).toBeInTheDocument();
    });
    await userEvent.click(canvas.getByText("api-server"));

    // Wait for path update
    await waitFor(() => {
      expect(canvas.getByText("/home/user/projects/api-server")).toBeInTheDocument();
    });

    // Select the directory
    await userEvent.click(canvas.getByText("Select"));

    // Verify path is in input
    await waitFor(() => {
      const input = canvas.getByPlaceholderText("/home/user/projects/my-project");
      expect(input).toHaveValue("/home/user/projects/api-server");
    });

    // Click Add Project to complete the flow
    await userEvent.click(canvas.getByRole("button", { name: "Add Project" }));

    // Modal should close after successful creation
    await waitFor(() => {
      expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
    });
  },
};

export const ValidationError: Story = {
  args: {
    isOpen: true,
    onClose: action("close"),
    onSuccess: action("success"),
  },
  decorators: [
    (Story) => {
      // Setup mock with validation error
      const mockApi: Partial<IPCApi> = {
        fs: {
          listDirectory: () => Promise.resolve(mockFileTree),
        },
        projects: {
          list: () => Promise.resolve([]),
          create: () =>
            Promise.resolve({
              success: false,
              error: "Not a valid git repository",
            }),
          remove: () => Promise.resolve({ success: true, data: undefined }),
          pickDirectory: () => Promise.resolve(null),
          listBranches: () => Promise.resolve({ branches: [], recommendedTrunk: "main" }),
          secrets: {
            get: () => Promise.resolve([]),
            update: () => Promise.resolve({ success: true, data: undefined }),
          },
        },
      };
      // @ts-expect-error - Mock API
      window.api = mockApi;
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Type a path
    const input = canvas.getByPlaceholderText("/home/user/projects/my-project");
    await userEvent.type(input, "/invalid/path");

    // Click Add Project
    await userEvent.click(canvas.getByRole("button", { name: "Add Project" }));

    // Wait for error message
    await waitFor(() => {
      expect(canvas.getByText("Not a valid git repository")).toBeInTheDocument();
    });
  },
};
