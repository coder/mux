export function LoadingScreen() {
  return (
    <div className="bg-bg-dark flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="border-border-light h-12 w-12 animate-spin rounded-full border-4 border-t-transparent" />
        <p className="text-text-secondary text-sm">Loading workspaces...</p>
      </div>
    </div>
  );
}
