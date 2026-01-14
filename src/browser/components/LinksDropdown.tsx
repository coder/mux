/**
 * Dropdown component for displaying detected links from chat.
 */

import { useState } from "react";
import { Link, ExternalLink, ChevronDown, Copy, Check } from "lucide-react";
import type { GenericLink } from "@/common/types/links";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { formatRelativeTime } from "@/browser/utils/ui/dateTime";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { Button } from "./ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";

interface LinksDropdownProps {
  /** Generic (non-PR) links */
  links: GenericLink[];
}

/**
 * Truncate URL for display
 */
function truncateUrl(url: string, maxLength = 60): string {
  // Remove protocol
  const withoutProtocol = url.replace(/^https?:\/\//, "");

  if (withoutProtocol.length <= maxLength) {
    return withoutProtocol;
  }

  return withoutProtocol.slice(0, maxLength - 3) + "...";
}

/**
 * Single link row with copy functionality
 */
function LinkRow({ link, onNavigate }: { link: GenericLink; onNavigate: () => void }) {
  const { copied, copyToClipboard } = useCopyToClipboard();

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void copyToClipboard(link.url);
  };

  const tooltipContent = (
    <div className="flex flex-col gap-1">
      <div className="break-all">{link.url}</div>
      <div className="text-muted-foreground text-xs">
        Seen {link.occurrenceCount} time{link.occurrenceCount !== 1 ? "s" : ""} · Last seen{" "}
        {formatRelativeTime(link.detectedAt)}
      </div>
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="hover:bg-accent group flex items-center gap-2 rounded px-2 py-1.5">
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-w-0 flex-1 items-center gap-2"
            onClick={onNavigate}
          >
            <ExternalLink className="h-3 w-3 shrink-0 opacity-50" />
            <span className="min-w-0 truncate text-xs">{link.title ?? truncateUrl(link.url)}</span>
          </a>
          <button
            onClick={handleCopy}
            className="text-muted hover:text-foreground shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            title="Copy link"
          >
            {copied ? <Check className="text-success h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-md">
        {tooltipContent}
      </TooltipContent>
    </Tooltip>
  );
}

export function LinksDropdown({ links }: LinksDropdownProps) {
  const [open, setOpen] = useState(false);

  if (links.length === 0) {
    return null;
  }

  // Sort links: most recently seen first
  const sortedLinks = [...links].sort((a, b) => b.detectedAt - a.detectedAt);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted hover:text-foreground h-6 gap-1 px-2"
            >
              <Link className="h-3 w-3" />
              <span className="text-xs">{links.length}</span>
              <ChevronDown className="h-3 w-3" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Links found in chat</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-96 p-1">
        <div className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
          {sortedLinks.map((link) => (
            <LinkRow key={link.url} link={link} onNavigate={() => setOpen(false)} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
