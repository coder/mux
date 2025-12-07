import React from "react";

interface GatewayIconProps extends React.SVGProps<SVGSVGElement> {
  className?: string;
}

/**
 * Gateway icon - represents routing through Mux Gateway.
 * A stylized "relay" symbol showing data passing through a central hub.
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
      {/* Central hexagon hub */}
      <path d="M12 6l5.196 3v6L12 18l-5.196-3V9z" />
      {/* Left incoming arrow */}
      <path d="M2 12h4" />
      <path d="M4 10l2 2-2 2" />
      {/* Right outgoing arrow */}
      <path d="M18 12h4" />
      <path d="M20 10l2 2-2 2" />
    </svg>
  );
}
