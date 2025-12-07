import React from "react";

interface GatewayIconProps extends React.SVGProps<SVGSVGElement> {
  className?: string;
}

/**
 * Gateway icon - represents routing through Mux Gateway.
 * A mystic portal: concentric rings with a sparkle at center.
 */
export function GatewayIcon(props: GatewayIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {/* Outer ring */}
      <circle cx="12" cy="12" r="9" />
      {/* Inner ring */}
      <circle cx="12" cy="12" r="5" />
      {/* Center sparkle */}
      <path d="M12 10v4" />
      <path d="M10 12h4" />
    </svg>
  );
}
