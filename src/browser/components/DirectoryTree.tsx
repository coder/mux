import React from "react";

interface DirectoryTreeEntry {
  name: string;
  path: string;
}

interface DirectoryTreeProps {
  currentPath: string | null;
  entries: DirectoryTreeEntry[];
  isLoading?: boolean;
  onNavigateTo: (path: string) => void;
  onNavigateParent: () => void;
}

export const DirectoryTree: React.FC<DirectoryTreeProps> = (props) => {
  const { currentPath, entries, isLoading = false, onNavigateTo, onNavigateParent } = props;

  const hasEntries = entries.length > 0;
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [currentPath]);

  return (
    <div ref={containerRef} className="h-full overflow-y-auto p-2 font-mono text-xs">
      {isLoading && !currentPath ? (
        <div className="text-muted py-4 text-center">Loading directories...</div>
      ) : (
        <ul className="m-0 list-none p-0">
          {currentPath && (
            <li
              className="text-muted cursor-pointer rounded px-2 py-1 text-xs hover:bg-white/5"
              onClick={onNavigateParent}
            >
              ...
            </li>
          )}

          {!isLoading && !hasEntries ? (
            <li className="text-muted px-2 py-1 text-xs">No subdirectories found</li>
          ) : null}

          {entries.map((entry) => (
            <li
              key={entry.path}
              className="text-muted cursor-pointer rounded px-2 py-1 text-xs hover:bg-white/5"
              onClick={() => onNavigateTo(entry.path)}
            >
              {entry.name}
            </li>
          ))}

          {isLoading && currentPath && !hasEntries ? (
            <li className="text-muted px-2 py-1 text-xs">Loading directories...</li>
          ) : null}
        </ul>
      )}
    </div>
  );
};
