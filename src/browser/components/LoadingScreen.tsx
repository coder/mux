import { LoadingAnimation } from "./LoadingAnimation";

export function LoadingScreen(props: { statusText?: string }) {
  return (
    <div className="boot-loader" role="status" aria-live="polite" aria-busy="true">
      <div className="boot-loader__inner">
        <LoadingAnimation />
        <p className="boot-loader__text">{props.statusText ?? "Loading workspaces..."}</p>
      </div>
    </div>
  );
}
