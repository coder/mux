import { cn } from "@/common/lib/utils";
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
  Hourglass,
  Lightbulb,
  Link,
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
  "⏳": Hourglass,
  "⌛": Hourglass,
  "🔗": Link,
  "🔄": RefreshCw,
  "🧪": Beaker,
  // Used by auto-handoff routing status while selecting the executor.
  "🤔": CircleHelp,

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

const SPINNING_EMOJI = new Set([
  // In tool output and agent status, these represent "refreshing".
  "🔄",
]);

export function getIconForEmoji(emoji: string): LucideIcon | undefined {
  const normalized = normalizeEmoji(emoji);
  return EMOJI_TO_ICON[normalized];
}

export function EmojiIcon(props: {
  emoji: string | null | undefined;
  className?: string;
  /**
   * When provided, forces whether the icon should spin.
   *
   * When omitted, we spin only for emojis that semantically represent
   * "working"/"refreshing".
   */
  spin?: boolean;
}) {
  if (!props.emoji) return null;

  const normalizedEmoji = normalizeEmoji(props.emoji);
  const Icon = EMOJI_TO_ICON[normalizedEmoji] ?? Sparkles;
  const shouldSpin = props.spin ?? SPINNING_EMOJI.has(normalizedEmoji);

  return <Icon aria-hidden="true" className={cn(props.className, shouldSpin && "animate-spin")} />;
}
