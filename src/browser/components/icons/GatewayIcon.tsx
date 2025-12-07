import React from "react";

interface GatewayIconProps extends React.SVGProps<SVGSVGElement> {
  className?: string;
}

/**
 * Gateway icon - represents routing through Mux Gateway.
 * A simplified relay symbol: arrow passing through a central node.
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
      {/* Central diamond/node */}
      <path d="M12 8l4 4-4 4-4-4z" />
      {/* Input line */}
      <path d="M4 12h4" />
      {/* Output arrow */}
      <path d="M16 12h4" />
      <path d="M18 10l2 2-2 2" />
    </svg>
  );
}
