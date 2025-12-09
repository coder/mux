import React from "react";
import { Folder, FolderUp } from "lucide-react";

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
    <div ref={containerRef} className="h-full overflow-y-auto p-2 text-sm">
      {isLoading && !currentPath ? (
        <div className="text-muted py-4 text-center">Loading directories...</div>
      ) : (
        <ul className="m-0 list-none p-0">
          {currentPath && (
            <li
              className="text-muted flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-white/5"
              onClick={onNavigateParent}
            >
              <FolderUp size={16} className="text-muted shrink-0" />
              <span>..</span>
            </li>
          )}

          {!isLoading && !hasEntries ? (
            <li className="text-muted px-2 py-1.5">No subdirectories found</li>
          ) : null}

          {entries.map((entry) => (
            <li
              key={entry.path}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-white/5"
              onClick={() => onNavigateTo(entry.path)}
            >
              <Folder size={16} className="shrink-0 text-yellow-500/80" />
              <span className="truncate">{entry.name}</span>
            </li>
          ))}

          {isLoading && currentPath && !hasEntries ? (
            <li className="text-muted px-2 py-1.5">Loading directories...</li>
          ) : null}
        </ul>
      )}
    </div>
  );
};
