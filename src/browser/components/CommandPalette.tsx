import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { useCommandRegistry } from "@/browser/contexts/CommandRegistryContext";
import type { CommandAction } from "@/browser/contexts/CommandRegistryContext";
import {
  formatKeybind,
  KEYBINDS,
  isEditableElement,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import { getSlashCommandSuggestions } from "@/browser/utils/slashCommands/suggestions";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { filterCommandsByPrefix } from "@/browser/utils/commandPaletteFiltering";

interface CommandPaletteProps {
  getSlashContext?: () => { providerNames: string[]; workspaceId?: string };
}

type PromptDef = NonNullable<NonNullable<CommandAction["prompt"]>>;
type PromptField = PromptDef["fields"][number];

interface PromptPaletteItem {
  id: string;
  title: string;
  section: string;
  keywords?: string[];
  subtitle?: string;
  shortcutHint?: string;
  run: () => void;
}

type PaletteItem = CommandAction | PromptPaletteItem;

interface PaletteGroup {
  name: string;
  items: PaletteItem[];
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ getSlashContext }) => {
  const { isOpen, close, getActions, addRecent, recent } = useCommandRegistry();
  const [query, setQuery] = useState("");
  const [activePrompt, setActivePrompt] = useState<null | {
    title?: string;
    fields: PromptDef["fields"];
    onSubmit: PromptDef["onSubmit"];
    idx: number;
    values: Record<string, string>;
  }>(null);
  const [promptError, setPromptError] = useState<string | null>(null);

  const resetPaletteState = useCallback(() => {
    setActivePrompt(null);
    setPromptError(null);
    setQuery("");
  }, []);

  // Close palette with Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.CANCEL) && isOpen) {
        e.preventDefault();
        resetPaletteState();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, close, resetPaletteState]);

  // Reset state whenever palette visibility changes
  useEffect(() => {
    if (!isOpen) {
      resetPaletteState();
    } else {
      setPromptError(null);
      setQuery("");
    }
  }, [isOpen, resetPaletteState]);

  const rawActions = getActions();

  const recentIndex = useMemo(() => {
    const idx = new Map<string, number>();
    recent.forEach((id, i) => idx.set(id, i));
    return idx;
  }, [recent]);

  const startPrompt = useCallback((action: CommandAction) => {
    if (!action.prompt) return;
    setPromptError(null);
    setQuery("");
    setActivePrompt({
      title: action.prompt.title ?? action.title,
      fields: action.prompt.fields,
      onSubmit: action.prompt.onSubmit,
      idx: 0,
      values: {},
    });
  }, []);

  // Listen for EXECUTE_COMMAND events
  useEffect(() => {
    const handleExecuteCommand = (e: Event) => {
      const customEvent = e as CustomEvent<{ commandId: string }>;
      const { commandId } = customEvent.detail;

      const action = getActions().find((a) => a.id === commandId);
      if (!action) {
        console.warn(`Command not found: ${commandId}`);
        return;
      }

      // Run the action directly
      void action.run();
      addRecent(action.id);
    };

    window.addEventListener(CUSTOM_EVENTS.EXECUTE_COMMAND, handleExecuteCommand);
    return () => window.removeEventListener(CUSTOM_EVENTS.EXECUTE_COMMAND, handleExecuteCommand);
  }, [getActions, startPrompt, addRecent]);

  const handlePromptValue = useCallback(
    (value: string) => {
      let nextInitial: string | null = null;
      setPromptError(null);
      setActivePrompt((current) => {
        if (!current) return current;
        const field = current.fields[current.idx];
        if (!field) return current;
        const nextValues = { ...current.values, [field.name]: value };
        const nextIdx = current.idx + 1;
        if (nextIdx < current.fields.length) {
          const nextField = current.fields[nextIdx];
          if (nextField.type === "text") {
            nextInitial = nextField.getInitialValue?.(nextValues) ?? nextField.initialValue ?? "";
          } else {
            nextInitial = "";
          }
          return {
            ...current,
            idx: nextIdx,
            values: nextValues,
          };
        }
        const submit = current.onSubmit;
        setTimeout(() => void submit(nextValues), 0);
        close();
        setQuery("");
        return null;
      });
      if (nextInitial !== null) {
        const valueToSet = nextInitial;
        setTimeout(() => setQuery(valueToSet), 0);
      }
    },
    [close]
  );

  const handlePromptTextSubmit = useCallback(() => {
    if (!activePrompt) return;
    const field = activePrompt.fields[activePrompt.idx];
    if (field?.type !== "text") return;
    const trimmed = query.trim();
    const err = field.validate?.(trimmed) ?? null;
    if (err) {
      setPromptError(err);
      return;
    }
    handlePromptValue(trimmed);
  }, [activePrompt, query, handlePromptValue]);

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (activePrompt) {
        setPromptError(null);
      }
    },
    [activePrompt]
  );

  const generalResults = useMemo(() => {
    const q = query.trim();

    if (q.startsWith("/")) {
      const ctx = getSlashContext?.() ?? { providerNames: [] };
      const suggestions = getSlashCommandSuggestions(q, { providerNames: ctx.providerNames });
      const section = "Slash Commands";
      const groups: PaletteGroup[] = [
        {
          name: section,
          items: suggestions.map((s) => ({
            id: `slash:${s.id}`,
            title: s.display,
            subtitle: s.description,
            section,
            shortcutHint: `${formatKeybind(KEYBINDS.SEND_MESSAGE)} to insert`,
            run: () => {
              const text = s.replacement;
              window.dispatchEvent(
                createCustomEvent(CUSTOM_EVENTS.INSERT_TO_CHAT_INPUT, {
                  text,
                  mode: "append",
                })
              );
            },
          })),
        },
      ];
      return {
        groups,
        emptyText: suggestions.length ? undefined : "No command suggestions",
      } satisfies { groups: PaletteGroup[]; emptyText: string | undefined };
    }

    // Filter actions based on prefix (extracted to utility for testing)
    const actionsToShow = filterCommandsByPrefix(q, rawActions);

    const filtered = [...actionsToShow].sort((a, b) => {
      const ai = recentIndex.has(a.id) ? recentIndex.get(a.id)! : 9999;
      const bi = recentIndex.has(b.id) ? recentIndex.get(b.id)! : 9999;
      if (ai !== bi) return ai - bi;
      return a.title.localeCompare(b.title);
    });

    const bySection = new Map<string, CommandAction[]>();
    for (const action of filtered) {
      const sec = action.section || "Other";
      const list = bySection.get(sec) ?? [];
      list.push(action);
      bySection.set(sec, list);
    }

    const groups: PaletteGroup[] = Array.from(bySection.entries()).map(([name, items]) => ({
      name,
      items,
    }));

    return {
      groups,
      emptyText: filtered.length ? undefined : "No results",
    } satisfies { groups: PaletteGroup[]; emptyText: string | undefined };
  }, [query, rawActions, recentIndex, getSlashContext]);

  useEffect(() => {
    if (!activePrompt) return;
    const field = activePrompt.fields[activePrompt.idx];
    if (!field) return;
    if (field.type === "text") {
      const initial = field.getInitialValue?.(activePrompt.values) ?? field.initialValue ?? "";
      setQuery(initial);
    } else {
      setQuery("");
    }
  }, [activePrompt]);

  const [selectOptions, setSelectOptions] = useState<
    Array<{ id: string; label: string; keywords?: string[] }>
  >([]);
  const [isLoadingOptions, setIsLoadingOptions] = useState(false);

  const currentField: PromptField | null = activePrompt
    ? (activePrompt.fields[activePrompt.idx] ?? null)
    : null;

  useEffect(() => {
    // Select prompts can return options synchronously or as a promise. This effect normalizes
    // both flows, keeps the loading state in sync, and bails out early if the prompt switches
    // while a request is in flight.
    let cancelled = false;

    const resetState = () => {
      if (cancelled) return;
      setSelectOptions([]);
      setIsLoadingOptions(false);
    };

    const hydrateSelectOptions = async () => {
      if (currentField?.type !== "select") {
        resetState();
        return;
      }

      setIsLoadingOptions(true);
      try {
        const rawOptions = await Promise.resolve(
          currentField.getOptions(activePrompt?.values ?? {})
        );

        if (!Array.isArray(rawOptions)) {
          throw new Error("Prompt select options must resolve to an array");
        }

        if (!cancelled) {
          setSelectOptions(rawOptions);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to resolve prompt select options", error);
          setSelectOptions([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingOptions(false);
        }
      }
    };

    void hydrateSelectOptions();

    return () => {
      cancelled = true;
    };
  }, [currentField, activePrompt]);

  const isSlashQuery = !currentField && query.trim().startsWith("/");
  const isCommandQuery = !currentField && query.trim().startsWith(">");
  // Enable cmdk filtering for all cases except slash queries (which we handle manually)
  const shouldUseCmdkFilter = currentField ? currentField.type === "select" : !isSlashQuery;

  let groups: PaletteGroup[] = generalResults.groups;
  let emptyText: string | undefined = generalResults.emptyText;

  if (currentField) {
    const promptTitle = activePrompt?.title ?? currentField.label ?? "Provide details";
    if (currentField.type === "select") {
      const options = selectOptions;
      groups = [
        {
          name: promptTitle,
          items: options.map((opt) => ({
            id: `prompt-select:${currentField.name}:${opt.id}`,
            title: opt.label,
            section: promptTitle,
            keywords: opt.keywords,
            run: () => handlePromptValue(opt.id),
          })),
        },
      ];
      emptyText = isLoadingOptions
        ? "Loading options..."
        : options.length
          ? undefined
          : "No options";
    } else {
      const typed = query.trim();
      const fallbackHint = currentField.placeholder ?? "Type value and press Enter";
      const hint =
        promptError ?? (typed.length > 0 ? `Press Enter to use “${typed}”` : fallbackHint);
      groups = [
        {
          name: promptTitle,
          items: [
            {
              id: `prompt-text:${currentField.name}`,
              title: hint,
              section: promptTitle,
              run: handlePromptTextSubmit,
            },
          ],
        },
      ];
      emptyText = undefined;
    }
  }

  if (!isOpen) return null;

  const groupsWithItems = groups.filter((group) => group.items.length > 0);
  const hasAnyItems = groupsWithItems.length > 0;

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-start justify-center bg-black/40 pt-[10vh]"
      onMouseDown={() => {
        resetPaletteState();
        close();
      }}
    >
      <Command
        className="bg-separator border-border text-lighter font-primary w-[min(720px,92vw)] overflow-hidden rounded-lg border shadow-[0_10px_40px_rgba(0,0,0,0.4)]"
        onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
        shouldFilter={shouldUseCmdkFilter}
        filter={(value, search) => {
          // When using ">" prefix, filter using the text after ">"
          if (isCommandQuery && search.startsWith(">")) {
            const actualSearch = search.slice(1).trim().toLowerCase();
            if (!actualSearch) return 1;
            if (value.toLowerCase().includes(actualSearch)) return 1;
            return 0;
          }
          // Default cmdk filtering for other cases
          if (value.toLowerCase().includes(search.toLowerCase())) return 1;
          return 0;
        }}
      >
        <Command.Input
          className="bg-darker text-lighter border-hover w-full border-b border-none px-3.5 py-3 text-sm outline-none"
          value={query}
          onValueChange={handleQueryChange}
          placeholder={
            currentField
              ? currentField.type === "text"
                ? (currentField.placeholder ?? "Type value…")
                : (currentField.placeholder ?? "Search options…")
              : `Switch workspaces or type > for all commands, / for slash commands…`
          }
          autoFocus
          onKeyDown={(e: React.KeyboardEvent) => {
            if (!currentField && isEditableElement(e.target)) return;

            if (currentField) {
              if (e.key === "Enter" && currentField.type === "text") {
                e.preventDefault();
                e.stopPropagation();
                handlePromptTextSubmit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                resetPaletteState();
                close();
              }
              return;
            }
          }}
        />
        <Command.List className="max-h-[420px] overflow-auto">
          {groupsWithItems.map((group) => (
            <Command.Group
              key={group.name}
              heading={group.name}
              className="[&[cmdk-group-heading]]:text-subdued [&[cmdk-group-heading]]:px-2.5 [&[cmdk-group-heading]]:py-1 [&[cmdk-group-heading]]:text-[11px] [&[cmdk-group-heading]]:tracking-[0.08em] [&[cmdk-group-heading]]:uppercase [&[cmdk-group]]:px-1.5 [&[cmdk-group]]:py-2"
            >
              {group.items.map((item) => (
                <Command.Item
                  key={item.id}
                  className="hover:bg-hover aria-selected:bg-hover mx-1 my-0.5 grid cursor-pointer grid-cols-[1fr_auto] items-center gap-2 rounded-md px-3 py-2 text-[13px]"
                  onSelect={() => {
                    if ("prompt" in item && item.prompt) {
                      addRecent(item.id);
                      startPrompt(item);
                      return;
                    }

                    if (currentField) {
                      void item.run();
                      return;
                    }

                    addRecent(item.id);
                    close();
                    setTimeout(() => {
                      void item.run();
                    }, 0);
                  }}
                >
                  <div>
                    {item.title}
                    {"subtitle" in item && item.subtitle && (
                      <>
                        <br />
                        <span className="text-subdued text-xs">{item.subtitle}</span>
                      </>
                    )}
                  </div>
                  {"shortcutHint" in item && item.shortcutHint && (
                    <span className="text-subdued font-monospace text-[11px]">
                      {item.shortcutHint}
                    </span>
                  )}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
          {!hasAnyItems && (
            <div className="text-gray p-4 text-[13px]">{emptyText ?? "No results"}</div>
          )}
        </Command.List>
      </Command>
    </div>
  );
};
