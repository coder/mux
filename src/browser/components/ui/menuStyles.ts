import { cn } from "@/common/lib/utils";

export const menuSurfaceClassName = cn(
  "bg-dark text-foreground border border-border shadow-md rounded-md z-[var(--z-dropdown)]"
);

export const menuSeparatorClassName = cn("bg-border -mx-1 my-1 h-px");

export const menuItemBaseClassName = cn(
  "hover:bg-hover focus:bg-hover relative flex cursor-default select-none items-center rounded-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
);
