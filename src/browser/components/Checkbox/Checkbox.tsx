import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";

import { cn } from "@/common/lib/utils";

// NOTE: `border-primary` / `bg-primary` / `ring-ring` are not real theme tokens
// in this app (see src/browser/styles/globals.css). We use the defined
// `accent` / `foreground` tokens instead so the checkbox actually renders a
// visible border at rest and a filled accent surface when checked, across all
// themes (dark, light, Flexoki).
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      // Sizing & shape: slightly larger than 4x4 so the check is comfortably readable.
      "peer size-[1.05rem] shrink-0 rounded-[5px] transition-colors",
      // Unchecked: visible-but-restrained border with a faint surface, so the
      // affordance reads against any row background (white/5 hover tints,
      // accent/10 selected row tints, etc.).
      "border border-foreground/35 bg-foreground/[0.04]",
      "hover:border-foreground/55 hover:bg-foreground/10",
      // Focus ring uses accent (matches the rest of the form).
      "focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none",
      "disabled:cursor-not-allowed disabled:opacity-50",
      // Checked: filled accent surface with high-contrast check glyph.
      "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground",
      "data-[state=checked]:hover:border-accent-hover data-[state=checked]:hover:bg-accent-hover",
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn("flex items-center justify-center text-current")}>
      <Check className="h-3 w-3" strokeWidth={3} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
