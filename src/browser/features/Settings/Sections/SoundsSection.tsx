import { useEffect, useRef, useState } from "react";

import { Button } from "@/browser/components/Button/Button";
import { Switch } from "@/browser/components/Switch/Switch";
import { useAPI } from "@/browser/contexts/API";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import {
  EVENT_SOUND_KEYS,
  EVENT_SOUND_LABELS,
  type EventSoundKey,
} from "@/common/config/eventSoundTypes";
import type { EventSoundConfig, EventSoundSettings } from "@/common/config/schemas/appConfigOnDisk";

// Browser mode doesn't expose the native file picker bridge from preload.
const isDesktopMode = typeof window !== "undefined" && Boolean(window.api);

function getEventSoundConfig(settings: EventSoundSettings, key: EventSoundKey): EventSoundConfig {
  const config = settings?.[key];
  return {
    enabled: config?.enabled === true,
    filePath:
      typeof config?.filePath === "string" && config.filePath.length > 0 ? config.filePath : null,
  };
}

function updateEventSoundConfig(
  settings: EventSoundSettings,
  key: EventSoundKey,
  config: EventSoundConfig
): EventSoundSettings {
  return {
    ...(settings ?? {}),
    [key]: config,
  };
}

export function SoundsSection() {
  const { api } = useAPI();
  const [eventSoundSettings, setEventSoundSettings] = useState<EventSoundSettings>(undefined);

  const loadNonceRef = useRef(0);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSettingsRef = useRef<{ hasPending: boolean; settings: EventSoundSettings }>({
    hasPending: false,
    settings: undefined,
  });

  useEffect(() => {
    if (!api?.config?.getConfig) {
      return;
    }

    const loadNonce = ++loadNonceRef.current;

    void api.config
      .getConfig()
      .then((config) => {
        if (loadNonce !== loadNonceRef.current) {
          return;
        }

        setEventSoundSettings(config.eventSoundSettings);
      })
      .catch(() => {
        // Best-effort only.
      });
  }, [api]);

  const queueSettingsSave = (nextSettings: EventSoundSettings) => {
    if (!api?.config?.updateEventSoundSettings) {
      return;
    }

    pendingSettingsRef.current.hasPending = true;
    pendingSettingsRef.current.settings = nextSettings;

    // Serialize writes so rapid toggles/file selections cannot persist out-of-order settings.
    saveChainRef.current = saveChainRef.current
      .catch(() => {
        // Best-effort only.
      })
      .then(async () => {
        for (;;) {
          if (!pendingSettingsRef.current.hasPending) {
            return;
          }

          const pendingSettings = pendingSettingsRef.current.settings;
          pendingSettingsRef.current.hasPending = false;

          try {
            await api.config.updateEventSoundSettings({ eventSoundSettings: pendingSettings });
          } catch {
            // Best-effort only.
          }
        }
      });
  };

  const applySettingsUpdate = (updater: (prev: EventSoundSettings) => EventSoundSettings) => {
    // If the user changed a value while initial load is in flight, keep local edits authoritative.
    loadNonceRef.current++;

    setEventSoundSettings((prev) => {
      const next = updater(prev);
      queueSettingsSave(next);
      window.dispatchEvent(
        createCustomEvent(CUSTOM_EVENTS.EVENT_SOUND_SETTINGS_CHANGED, {
          eventSoundSettings: next,
        })
      );
      return next;
    });
  };

  const handleEnabledChange = (key: EventSoundKey, enabled: boolean) => {
    applySettingsUpdate((prev) => {
      const current = getEventSoundConfig(prev, key);
      return updateEventSoundConfig(prev, key, {
        ...current,
        enabled,
      });
    });
  };

  const handleBrowse = async (key: EventSoundKey) => {
    if (!api?.projects?.pickAudioFile) {
      return;
    }

    const result = await api.projects.pickAudioFile({});
    if (result.filePath == null) {
      return;
    }

    applySettingsUpdate((prev) => {
      const current = getEventSoundConfig(prev, key);
      return updateEventSoundConfig(prev, key, {
        ...current,
        filePath: result.filePath,
      });
    });
  };

  const handleClearFile = (key: EventSoundKey) => {
    applySettingsUpdate((prev) => {
      const current = getEventSoundConfig(prev, key);
      return updateEventSoundConfig(prev, key, {
        ...current,
        filePath: null,
      });
    });
  };

  const canPersist = Boolean(api?.config?.updateEventSoundSettings);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-foreground text-sm font-medium">Event sounds</h3>
        <p className="text-muted mt-1 text-xs">
          Configure optional audio alerts for key events in Mux.
        </p>
      </div>

      <div className="border-border-light divide-border-light divide-y rounded-md border">
        {EVENT_SOUND_KEYS.map((key) => {
          const soundConfig = getEventSoundConfig(eventSoundSettings, key);
          const fileLabel = soundConfig.filePath ?? "No file selected";

          return (
            <div key={key} className="space-y-3 px-3 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-foreground text-sm">{EVENT_SOUND_LABELS[key]}</div>
                  <div className="text-muted mt-0.5 truncate text-xs" title={fileLabel}>
                    {fileLabel}
                  </div>
                </div>
                <Switch
                  checked={soundConfig.enabled}
                  onCheckedChange={(checked) => handleEnabledChange(key, checked)}
                  disabled={!canPersist}
                  aria-label={`Toggle sound for ${EVENT_SOUND_LABELS[key]}`}
                />
              </div>

              <div className="flex items-center justify-end gap-2">
                {isDesktopMode ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void handleBrowse(key);
                    }}
                    disabled={!canPersist || !api?.projects?.pickAudioFile}
                  >
                    Browse
                  </Button>
                ) : null}
                {soundConfig.filePath ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleClearFile(key)}
                    disabled={!canPersist}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
