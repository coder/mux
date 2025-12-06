import React from "react";
import AnthropicIcon from "@/browser/assets/icons/anthropic.svg?react";
import OpenAIIcon from "@/browser/assets/icons/openai.svg?react";
import GoogleIcon from "@/browser/assets/icons/google.svg?react";
import XAIIcon from "@/browser/assets/icons/xai.svg?react";
import AWSIcon from "@/browser/assets/icons/aws.svg?react";
import MuxIcon from "@/browser/assets/icons/mux.svg?react";
import { PROVIDER_DISPLAY_NAMES, type ProviderName } from "@/common/constants/providers";
import { cn } from "@/common/lib/utils";

const PROVIDER_ICONS: Partial<Record<ProviderName, React.FC>> = {
  anthropic: AnthropicIcon,
  openai: OpenAIIcon,
  google: GoogleIcon,
  xai: XAIIcon,
  bedrock: AWSIcon,
  "mux-gateway": MuxIcon,
};

// Providers with bitmap logos that need CSS filters for consistent appearance
const BITMAP_ICON_PROVIDERS = new Set<string>(["mux-gateway"]);

export interface ProviderIconProps {
  provider: string;
  className?: string;
}

/**
 * Renders a provider's icon if one exists, otherwise returns null.
 * Icons are sized to 1em by default to match surrounding text.
 */
export function ProviderIcon(props: ProviderIconProps) {
  const IconComponent = PROVIDER_ICONS[props.provider as keyof typeof PROVIDER_ICONS];
  if (!IconComponent) return null;

  const isBitmap = BITMAP_ICON_PROVIDERS.has(props.provider);

  return (
    <span
      className={cn(
        "inline-block h-[1em] w-[1em] align-[-0.125em] [&_svg]:block [&_svg]:h-full [&_svg]:w-full [&_svg]:fill-current [&_svg_.st0]:fill-current",
        // Bitmap icons (embedded PNGs) need CSS filters to match the monochrome style
        isBitmap && "grayscale brightness-[2] dark:brightness-[10] dark:contrast-[0.5]",
        props.className
      )}
    >
      <IconComponent />
    </span>
  );
}

export interface ProviderWithIconProps {
  provider: string;
  className?: string;
  iconClassName?: string;
  /** Show display name instead of raw provider key */
  displayName?: boolean;
}

/**
 * Renders a provider name with its icon (if available).
 * Falls back to just the name if no icon exists for the provider.
 */
export function ProviderWithIcon(props: ProviderWithIconProps) {
  const name = props.displayName
    ? (PROVIDER_DISPLAY_NAMES[props.provider as ProviderName] ?? props.provider)
    : props.provider;

  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap", props.className)}>
      <ProviderIcon provider={props.provider} className={props.iconClassName} />
      <span>{name}</span>
    </span>
  );
}
