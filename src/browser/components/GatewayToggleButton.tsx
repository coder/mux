import { cn } from "@/common/lib/utils";
import { GatewayIcon } from "./icons/GatewayIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface GatewayToggleButtonProps {
  /** Whether gateway is currently enabled for this model */
  active: boolean;
  /** Called when user clicks to toggle */
  onToggle: () => void;
  /** Visual variant */
  variant?: "bordered" | "plain";
  /** Icon size */
  size?: "sm" | "md";
  /** Whether to show tooltip */
  showTooltip?: boolean;
  className?: string;
}

/**
 * Toggle button for enabling/disabling Mux Gateway on a model.
 * Provides consistent hover states across usages:
 * - Active: accent color, dims on hover
 * - Inactive: muted color, brightens on hover (but not to accent)
 */
export function GatewayToggleButton(props: GatewayToggleButtonProps) {
  const { active, onToggle, variant = "plain", size = "md", showTooltip = false } = props;

  const sizeClasses = {
    sm: { container: "h-5 w-5", icon: "h-3 w-3" },
    md: { container: "", icon: "h-3.5 w-3.5" },
  }[size];

  const button = (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        "transition-colors duration-150",
        variant === "bordered" &&
          cn(
            "flex items-center justify-center rounded-sm border",
            sizeClasses.container,
            active
              ? "border-accent/40 text-accent hover:opacity-70"
              : "border-border-light/40 text-muted-light hover:border-muted/60 hover:text-muted"
          ),
        variant === "plain" &&
          cn("p-0.5", active ? "text-accent hover:opacity-70" : "text-muted hover:text-foreground"),
        props.className
      )}
      aria-label={active ? "Disable Mux Gateway" : "Enable Mux Gateway"}
    >
      <GatewayIcon className={sizeClasses.icon} active={active} />
    </button>
  );

  if (!showTooltip) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent align="center">
        {active ? "Using Mux Gateway" : "Use Mux Gateway"}
      </TooltipContent>
    </Tooltip>
  );
}
