import React from "react";

interface IconProps {
  size?: number;
  className?: string;
}

/** Server rack icon for SSH runtime */
export function SSHIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="SSH Runtime"
      className={className}
    >
      <rect x="2" y="2" width="12" height="5" rx="1" />
      <rect x="2" y="9" width="12" height="5" rx="1" />
      <circle cx="5" cy="4.5" r="0.5" fill="currentColor" />
      <circle cx="5" cy="11.5" r="0.5" fill="currentColor" />
    </svg>
  );
}

/** Git branch icon for worktree runtime */
export function WorktreeIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Worktree Runtime"
      className={className}
    >
      {/* Simplified git branch: vertical line with branch off */}
      <circle cx="8" cy="3" r="2" />
      <circle cx="8" cy="13" r="2" />
      <line x1="8" y1="5" x2="8" y2="11" />
      <circle cx="12" cy="7" r="2" />
      <path d="M10 7 L8 9" />
    </svg>
  );
}

/** Folder icon for local project-dir runtime */
export function LocalIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Local Runtime"
      className={className}
    >
      {/* Folder icon */}
      <path d="M2 4 L2 13 L14 13 L14 5 L8 5 L7 3 L2 3 L2 4" />
    </svg>
  );
}

/** Container icon for Docker runtime */
export function DockerIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Docker Runtime"
      className={className}
    >
      {/* Shipping container / cube icon */}
      <path d="M2 5 L8 2 L14 5 L14 11 L8 14 L2 11 Z" />
      <path d="M8 2 L8 14" />
      <path d="M2 5 L8 8 L14 5" />
      <path d="M8 8 L8 14" />
    </svg>
  );
}
