import "./dom";
import React from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { APIProvider } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { BackupSection } from "@/browser/features/Settings/Sections/BackupSection";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

type MockOptions = Parameters<typeof createMockORPCClient>[0];

function renderBackupSection(overrides: Partial<NonNullable<MockOptions>> = {}) {
  const client = createMockORPCClient({
    backupSettings: {
      repoUrl: "git@github.com:example/dotfiles.git",
      branch: "main",
      path: "mux/",
    },
    backupValidation: {
      reachable: true,
      empty: false,
      credential: "gh",
    },
    backupPreview: {
      pushChanges: [{ status: "M", path: "mux/preferences.json" }],
      restoreChanges: [{ status: "A", path: "skills/release/SKILL.md" }],
      localOnlyFiles: ["agents/local-only.md"],
      redactions: ["mcp.jsonc: github.headers.Authorization"],
      commandApprovals: [],
    },
    backupRestore: {
      commit: "def5678",
      snapshotPath: "/tmp/mux-backup-snapshot",
      changedFiles: ["preferences.json"],
      localOnlyFiles: ["agents/local.md"],
    },
    ...overrides,
  });

  const view = render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(APIProvider, {
          client,
          children: React.createElement(BackupSection),
        })
      )
    )
  );

  return { client, view };
}

describe("BackupSection", () => {
  afterEach(() => {
    cleanup();
  });

  test("shows both preview directions, local-only files, and redactions", async () => {
    const { view } = renderBackupSection();
    const canvas = within(view.container);

    await canvas.findByText("Settings backup");
    fireEvent.click(canvas.getByRole("button", { name: "Preview changes" }));

    await canvas.findByText("Backup to repository");
    expect(canvas.getByText("mux/preferences.json")).toBeTruthy();
    expect(canvas.getByText("Restore to this device")).toBeTruthy();
    expect(canvas.getByText("skills/release/SKILL.md")).toBeTruthy();
    expect(canvas.getByText(/github\.headers\.Authorization/i)).toBeTruthy();
    expect(canvas.getByText("agents/local-only.md")).toBeTruthy();
    // Preview discards the export's secret scan, so an override offered here would let a
    // push publish secrets without ever showing the blocked-file list.
    expect(canvas.queryByRole("checkbox", { name: "Override secret scan" })).toBeNull();
  });

  test("wires keyboard actions through save, validate, preview, backup, and restore", async () => {
    const { client, view } = renderBackupSection();
    const canvas = within(view.container);

    await canvas.findByText("Settings backup");
    const repoInput = canvas.getByLabelText("Repository URL");
    fireEvent.change(repoInput, { target: { value: "git@github.com:example/new.git" } });

    const saveSettings = jest.spyOn(client.backup, "saveSettings");
    const validate = jest.spyOn(client.backup, "validate");
    const preview = jest.spyOn(client.backup, "preview");
    const push = jest.spyOn(client.backup, "push");
    const restore = jest.spyOn(client.backup, "restore");

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true, altKey: true });
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Save settings" }).hasAttribute("disabled")).toBe(
        true
      )
    );

    fireEvent.keyDown(window, { key: "v", code: "KeyV", ctrlKey: true, altKey: true });
    await waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
    await canvas.findByText(/Credential used:/i);

    fireEvent.keyDown(window, { key: "e", code: "KeyE", ctrlKey: true, altKey: true });
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    await canvas.findByText("Backup to repository");

    fireEvent.keyDown(window, { key: "b", code: "KeyB", ctrlKey: true, altKey: true });
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith({
        repoUrl: "git@github.com:example/new.git",
        branch: "main",
        path: "mux/",
        allowSecrets: false,
      })
    );

    fireEvent.keyDown(window, { key: "r", code: "KeyR", ctrlKey: true, altKey: true });
    const dialog = await within(document.body).findByRole("dialog");
    expect(within(dialog).getByText(/safety snapshot/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /Restore settings/i }));
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    await canvas.findByText(/Restored 1 file/i);
  });

  test("exposes the override after a secret-scan block without running a preview first", async () => {
    const { client, view } = renderBackupSection();
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    expect(canvas.queryByRole("checkbox", { name: "Override secret scan" })).toBeNull();

    jest.spyOn(client.backup, "push").mockResolvedValueOnce({
      success: false,
      error: {
        code: "SECRET_DETECTED",
        message: "Potential secrets were found in the backup payload: AGENTS.md",
        files: ["AGENTS.md"],
      },
    });

    fireEvent.click(canvas.getByRole("button", { name: "Back up now" }));

    await canvas.findByText(/Potential secrets were found/i);
    const override = canvas.getByRole("checkbox", { name: "Override secret scan" });
    expect(override.getAttribute("data-state")).toBe("unchecked");

    fireEvent.keyDown(window, { key: "o", code: "KeyO", ctrlKey: true, altKey: true });
    await waitFor(() => expect(override.getAttribute("data-state")).toBe("checked"));
  });

  test("stops sending a secret override once a non-secret failure hides it", async () => {
    const { client, view } = renderBackupSection();
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    const push = jest.spyOn(client.backup, "push").mockResolvedValueOnce({
      success: false,
      error: { code: "SECRET_DETECTED", message: "Potential secrets", files: ["AGENTS.md"] },
    });
    fireEvent.click(canvas.getByRole("button", { name: "Back up now" }));

    const override = await canvas.findByRole("checkbox", { name: "Override secret scan" });
    fireEvent.click(override);
    await waitFor(() => expect(override.getAttribute("data-state")).toBe("checked"));

    push.mockResolvedValueOnce({
      success: false,
      error: { code: "AUTH_FAILED", message: "Could not authenticate" },
    });
    fireEvent.click(canvas.getByRole("button", { name: "Back up now" }));
    await canvas.findByText(/Could not authenticate/i);

    // The control is gone, so no invisible override may survive to authorize a retry.
    expect(canvas.queryByRole("checkbox", { name: "Override secret scan" })).toBeNull();
    fireEvent.click(canvas.getByRole("button", { name: "Back up now" }));
    await waitFor(() =>
      expect(push).toHaveBeenLastCalledWith(expect.objectContaining({ allowSecrets: false }))
    );
  });

  test("requires approving an incoming MCP command before restore sends its token", async () => {
    const approval = {
      path: "servers.notes.command",
      command: "npx -y @modelcontextprotocol/server-filesystem /data",
      token: "token-notes",
    };
    const { client, view } = renderBackupSection({
      backupPreview: {
        pushChanges: [],
        restoreChanges: [{ status: "M", path: "mcp.jsonc" }],
        localOnlyFiles: [],
        redactions: [],
        commandApprovals: [approval],
      },
    });
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    expect(canvas.queryByRole("checkbox", { name: "Approve MCP command changes" })).toBeNull();
    fireEvent.click(canvas.getByRole("button", { name: "Preview changes" }));

    const approve = await canvas.findByRole("checkbox", {
      name: "Approve MCP command changes",
    });
    expect(canvas.getByText(approval.command)).toBeTruthy();

    const restore = jest.spyOn(client.backup, "restore").mockResolvedValueOnce({
      success: false,
      error: {
        code: "COMMAND_APPROVAL_REQUIRED",
        message: "This backup would replace executable MCP commands.",
        files: [`${approval.path}: ${approval.command}`],
      },
    });
    async function confirmRestore() {
      fireEvent.click(canvas.getByRole("button", { name: /^Restore$/ }));
      const dialog = await within(document.body).findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: /Restore settings/i }));
    }

    await confirmRestore();
    await waitFor(() =>
      expect(restore).toHaveBeenLastCalledWith(
        expect.objectContaining({ approvedCommandTokens: [] })
      )
    );

    fireEvent.click(approve);
    await waitFor(() => expect(approve.getAttribute("data-state")).toBe("checked"));
    await confirmRestore();
    await waitFor(() =>
      expect(restore).toHaveBeenLastCalledWith(
        expect.objectContaining({ approvedCommandTokens: [approval.token] })
      )
    );
  });

  test("reports a preferences-only restore as changing no files", async () => {
    const { client, view } = renderBackupSection();
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    jest.spyOn(client.backup, "restore").mockResolvedValueOnce({
      success: true,
      data: {
        commit: "abc1234",
        snapshotPath: "/tmp/mux-backup-snapshot",
        changedFiles: [],
        localOnlyFiles: [],
      },
    });

    fireEvent.click(canvas.getByRole("button", { name: "Restore" }));
    const dialog = await within(document.body).findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Restore settings/i }));

    await canvas.findByText(/no files changed/i);
  });

  test("renders save failures beside the explicit save action", async () => {
    const { client, view } = renderBackupSection();
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    jest.spyOn(client.backup, "saveSettings").mockResolvedValueOnce({
      success: false,
      error: {
        code: "IO_ERROR",
        message: "Could not persist backup settings",
      },
    });

    fireEvent.change(canvas.getByLabelText("Repository URL"), {
      target: { value: "git@github.com:example/other.git" },
    });
    fireEvent.click(canvas.getByRole("button", { name: "Save settings" }));

    await canvas.findByText("Could not persist backup settings");
  });
});
