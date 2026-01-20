import React from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Beaker,
  Bell,
  BookOpen,
  Check,
  Circle,
  CircleHelp,
  CircleDot,
  Globe,
  Lightbulb,
  Link,
  Loader2,
  Moon,
  Package,
  PenLine,
  RefreshCw,
  Rocket,
  Search,
  Sparkles,
  Square,
  Sun,
  Wrench,
  X,
} from "lucide-react";

function normalizeEmoji(emoji: string): string {
  // Normalize variation selectors so both "⚠" and "⚠️" map consistently.
  return emoji.replaceAll("\uFE0F", "");
}

const EMOJI_TO_ICON: Record<string, LucideIcon> = {
  // Status / activity
  "🔍": Search,
  "📝": PenLine,
  "✏": PenLine,
  "✅": Check,
  "❌": X,
  "🚀": Rocket,
  "⏳": Loader2,
  "🔗": Link,
  "🔄": RefreshCw,
  "🧪": Beaker,

  // Directions
  "➡": ArrowRight,
  "⬅": ArrowLeft,
  "⬆": ArrowUp,
  "⬇": ArrowDown,

  // Weather / misc
  "☀": Sun,

  // Tool-ish / app-ish
  "🔧": Wrench,
  "🔔": Bell,
  "🌐": Globe,
  "📖": BookOpen,
  "⏹": Square,
  "📦": Package,
  "💤": Moon,
  "❓": CircleHelp,

  // Generic glyphs used as UI status icons
  "✓": Check,
  "○": Circle,
  "◎": CircleDot,
  "✗": X,
  "⚠": AlertTriangle,
  "💡": Lightbulb,
};

export function getIconForEmoji(emoji: string): LucideIcon | undefined {
  const normalized = normalizeEmoji(emoji);
  return EMOJI_TO_ICON[normalized];
}

export function EmojiIcon(props: { emoji: string | null | undefined; className?: string }) {
  if (!props.emoji) return null;

  const Icon = getIconForEmoji(props.emoji) ?? Sparkles;

  return <Icon aria-hidden="true" className={props.className} />;
}
