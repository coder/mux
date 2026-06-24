// Lightweight provider harness for isolated design-sync previews. Renders a
// single component with the contexts it needs WITHOUT the app shell (AppLoader),
// so previews stay thin (no shiki/mermaid/full-app graph). Providers are shimmed
// to window.Mux (barrel exports them) so they share React-context identity with
// the bundled components; the mock client bundles from source (it's data, not
// identity-sensitive). Owned previews in .design-sync/previews/<Name>.tsx import
// this via a relative path.
//
// Only the providers the design bundle can afford under the 5 MB cap are wired:
// theme, API, experiments, policy, settings, tooltip. The workspace/router/
// project chain is intentionally omitted (it pushes the bundle over cap) — a
// component that hard-requires those contexts is handled in its own preview.
import { useRef, type ReactNode } from "react";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { PolicyProvider } from "@/browser/contexts/PolicyContext";
import { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { AboutDialogProvider } from "@/browser/contexts/AboutDialogContext";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

export interface MuxPreviewShellProps {
  /** A configured mock client; defaults to empty mock data. */
  client?: APIClient;
  children: ReactNode;
}

export function MuxPreviewShell(props: MuxPreviewShellProps) {
  const client = useRef(props.client ?? createMockORPCClient({})).current;
  return (
    <ThemeProvider>
      <APIProvider client={client}>
        <ExperimentsProvider>
          <PolicyProvider>
            <RouterProvider>
              <ProjectProvider>
                <SettingsProvider>
                  <AboutDialogProvider>
                    <TooltipProvider>{props.children}</TooltipProvider>
                  </AboutDialogProvider>
                </SettingsProvider>
              </ProjectProvider>
            </RouterProvider>
          </PolicyProvider>
        </ExperimentsProvider>
      </APIProvider>
    </ThemeProvider>
  );
}
