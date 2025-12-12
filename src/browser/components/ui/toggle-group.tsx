import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/common/lib/utils";

const toggleGroupVariants = cva("inline-flex items-center justify-center rounded-md bg-hover p-1", {
  variants: {
    variant: {
      default: "",
    },
    size: {
      default: "h-7",
      sm: "h-6",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

const toggleGroupItemVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-[6px] px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "text-muted data-[state=on]:bg-border-medium data-[state=on]:text-foreground hover:text-foreground",
      },
      size: {
        default: "h-5",
        sm: "h-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root> &
    VariantProps<typeof toggleGroupVariants>
>(({ className, variant, size, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    className={cn(toggleGroupVariants({ variant, size, className }))}
    {...props}
  />
));
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName;

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> &
    VariantProps<typeof toggleGroupItemVariants>
>(({ className, variant, size, ...props }, ref) => (
  <ToggleGroupPrimitive.Item
    ref={ref}
    className={cn(toggleGroupItemVariants({ variant, size, className }))}
    {...props}
  />
));
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName;

export { ToggleGroup, ToggleGroupItem };
