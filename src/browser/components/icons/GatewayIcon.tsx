import React from "react";

interface GatewayIconProps extends React.SVGProps<SVGSVGElement> {
  className?: string;
}

/**
 * Gateway icon - represents routing through Mux Gateway.
 * A portal symbol: circle with an arrow passing through.
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
      {/* Portal circle */}
      <circle cx="12" cy="12" r="7" />
      {/* Arrow passing through */}
      <path d="M5 12h14" />
      <path d="M15 8l4 4-4 4" />
    </svg>
  );
}
