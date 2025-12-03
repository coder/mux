import React, { useState, useEffect, useRef, useCallback } from "react";
import { useAPI } from "@/browser/contexts/API";

interface SSHHostInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}

/**
 * SSH host input with dropdown of hosts from SSH config.
 * Shows dropdown above the input when focused and there are matching hosts.
 */
export function SSHHostInput(props: SSHHostInputProps) {
  const { api } = useAPI();
  const [hosts, setHosts] = useState<string[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Fetch SSH config hosts on mount
  useEffect(() => {
    if (!api) return;
    api.ssh
      .getConfigHosts()
      .then(setHosts)
      .catch(() => setHosts([]));
  }, [api]);

  // Filter hosts based on current input
  const filteredHosts = hosts.filter((host) =>
    host.toLowerCase().includes(props.value.toLowerCase())
  );

  // Handle clicking outside to close dropdown
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const { onChange } = props;
  const selectHost = useCallback(
    (host: string) => {
      onChange(host);
      setShowDropdown(false);
      setHighlightedIndex(-1);
      inputRef.current?.focus();
    },
    [onChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showDropdown || filteredHosts.length === 0) {
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev < filteredHosts.length - 1 ? prev + 1 : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : filteredHosts.length - 1));
          break;
        case "Enter":
          if (highlightedIndex >= 0) {
            e.preventDefault();
            selectHost(filteredHosts[highlightedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          setShowDropdown(false);
          setHighlightedIndex(-1);
          break;
      }
    },
    [showDropdown, filteredHosts, highlightedIndex, selectHost]
  );

  const handleFocus = () => {
    if (filteredHosts.length > 0) {
      setShowDropdown(true);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    props.onChange(e.target.value);
    // Show dropdown when typing if there are matches
    if (hosts.length > 0) {
      setShowDropdown(true);
    }
    setHighlightedIndex(-1);
  };

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex >= 0 && itemRefs.current[highlightedIndex]) {
      itemRefs.current[highlightedIndex]?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [highlightedIndex]);

  // Show dropdown when there are filtered hosts
  const shouldShowDropdown = showDropdown && filteredHosts.length > 0 && !props.disabled;

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={props.value}
        onChange={handleChange}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        placeholder="user@host"
        disabled={props.disabled}
        className="bg-separator text-foreground border-border-medium focus:border-accent w-32 rounded border px-1 py-0.5 text-xs focus:outline-none disabled:opacity-50"
        autoComplete="off"
      />
      {shouldShowDropdown && (
        <div className="bg-separator border-border-light absolute bottom-full left-0 z-[1000] mb-1 max-h-[150px] min-w-32 overflow-y-auto rounded border shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
          {filteredHosts.map((host, index) => (
            <div
              key={host}
              ref={(el) => (itemRefs.current[index] = el)}
              onClick={() => selectHost(host)}
              onMouseEnter={() => setHighlightedIndex(index)}
              className={`cursor-pointer px-2 py-1 text-xs ${
                index === highlightedIndex
                  ? "bg-accent text-white"
                  : "text-foreground hover:bg-border-medium"
              }`}
            >
              {host}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
