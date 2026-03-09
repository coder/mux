import React from "react";

interface ArchiveIconProps {
  className?: string;
}

/**
 * Simple monochrome archive box icon.
 * Box with a lid and a down-arrow indicating storage.
 */
export const ArchiveIcon: React.FC<ArchiveIconProps> = ({ className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    {/* Box lid */}
    <rect x="2" y="3" width="20" height="5" rx="1" />
    {/* Box body */}
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    {/* Down arrow into box */}
    <path d="M12 12v6" />
    <path d="m9 15 3 3 3-3" />
  </svg>
);

/**
 * Archive restore icon - box with up-arrow indicating retrieval.
 */
export const ArchiveRestoreIcon: React.FC<ArchiveIconProps> = ({ className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    {/* Box lid */}
    <rect x="2" y="3" width="20" height="5" rx="1" />
    {/* Box body */}
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    {/* Up arrow out of box */}
    <path d="M12 18v-6" />
    <path d="m9 15 3-3 3 3" />
  </svg>
);
