import "./dom";
import React from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { APIProvider } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { BackupSection } from "@/browser/features/Settings/Sections/BackupSection";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

function renderBackupSection() {
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
    },
    backupRestore: {
      commit: "def5678",
      snapshotPath: "/tmp/mux-backup-snapshot",
      changedFiles: ["preferences.json"],
      localOnlyFiles: ["agents/local.md"],
    },
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

  test("shows both preview directions, local-only files, redactions, and the override", async () => {
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
    expect(canvas.getByRole("checkbox", { name: "Override secret scan" })).toBeTruthy();
  });

  test("wires keyboard actions through save, validate, preview, backup, override, and restore", async () => {
    const { client, view } = renderBackupSection();
    const canvas = within(view.container);

    await canvas.findByText("Settings backup");
    const repoInput = canvas.getByLabelText("Repository URL");
    fireEvent.keyDown(repoInput, { key: "o", code: "KeyO", ctrlKey: true, altKey: true });
    fireEvent.change(repoInput, { target: { value: "git@github.com:example/new.git" } });

    const saveSettings = jest.spyOn(client.backup, "saveSettings");
    const validate = jest.spyOn(client.backup, "validate");
    const preview = jest.spyOn(client.backup, "preview");
    const push = jest.spyOn(client.backup, "push");
    const restore = jest.spyOn(client.backup, "restore");

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true, altKey: true });
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    await canvas.findByText("Backup settings saved.");

    fireEvent.keyDown(window, { key: "v", code: "KeyV", ctrlKey: true, altKey: true });
    await waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
    await canvas.findByText(/Credential used:/i);

    fireEvent.keyDown(window, { key: "e", code: "KeyE", ctrlKey: true, altKey: true });
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    await canvas.findByText("Backup to repository");

    const override = await canvas.findByRole("checkbox", { name: "Override secret scan" });
    expect(override.getAttribute("data-state")).toBe("unchecked");
    fireEvent.keyDown(window, { key: "o", code: "KeyO", ctrlKey: true, altKey: true });
    await waitFor(() => expect(override.getAttribute("data-state")).toBe("checked"));

    fireEvent.keyDown(window, { key: "b", code: "KeyB", ctrlKey: true, altKey: true });
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith({
        repoUrl: "git@github.com:example/new.git",
        branch: "main",
        path: "mux/",
        allowSecrets: true,
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
    expect(canvas.getByRole("checkbox", { name: "Override secret scan" })).toBeTruthy();
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
