import { LoadingIndicator } from "@/browser/components/ui/LoadingIndicator";

export function LoadingScreen() {
  return (
    <div className="bg-bg-dark flex h-screen w-screen items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <LoadingIndicator size={48} ariaLabel="Loading workspaces" />
        <p className="text-text-secondary text-sm">Loading workspaces...</p>
      </div>
    </div>
  );
}
