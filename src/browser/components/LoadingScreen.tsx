export function LoadingScreen() {
  // Keep the markup/classes in sync with index.html's boot loader so the inline styles
  // apply immediately and we avoid a flash of unstyled / missing spinner before Tailwind/globals.css loads.
  return (
    <div className="boot-loader" role="status" aria-live="polite" aria-busy="true">
      <div className="boot-loader__inner">
        <div className="boot-loader__spinner" aria-hidden="true" />
        <p className="boot-loader__text">Loading workspaces...</p>
      </div>
    </div>
  );
}
