import { useEffect, useRef, useState } from "react";

import { Button } from "@/browser/components/Button/Button";
import { Switch } from "@/browser/components/Switch/Switch";
import { useAPI } from "@/browser/contexts/API";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import {
  ALLOWED_AUDIO_EXTENSIONS,
  EVENT_SOUND_KEYS,
  EVENT_SOUND_LABELS,
  MAX_AUDIO_FILE_SIZE_BYTES,
  type EventSoundKey,
} from "@/common/config/eventSoundTypes";
import type { EventSoundConfig, EventSoundSettings } from "@/common/config/schemas/appConfigOnDisk";

// Browser mode doesn't expose the native file picker bridge from preload.
const isDesktopMode = typeof window !== "undefined" && Boolean(window.api);

const AUDIO_UPLOAD_ACCEPT = [
  "audio/*",
  ...ALLOWED_AUDIO_EXTENSIONS.map((extension) => `.${extension}`),
].join(",");

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Failed to read selected file."));
        return;
      }

      const separatorIndex = reader.result.indexOf(",");
      if (separatorIndex < 0) {
        reject(new Error("Failed to parse selected file."));
        return;
      }

      resolve(reader.result.slice(separatorIndex + 1));
    };
    reader.onerror = () => {
      reject(new Error("Failed to read selected file."));
    };
    reader.readAsDataURL(file);
  });
}

function getEventSoundConfig(settings: EventSoundSettings, key: EventSoundKey): EventSoundConfig {
  const config = settings?.[key];
  return {
    enabled: config?.enabled === true,
    source: config?.source ?? null,
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

  // Browser mode uses one hidden file input for all rows, so we track which event key opened it.
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetKeyRef = useRef<EventSoundKey | null>(null);

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
    if (!api?.projects?.pickAudioFile || !api?.eventSounds?.importFromLocalPath) {
      return;
    }

    const result = await api.projects.pickAudioFile({});
    if (result.filePath == null) {
      return;
    }

    const importedAsset = await api.eventSounds.importFromLocalPath({ localPath: result.filePath });

    applySettingsUpdate((prev) => {
      const current = getEventSoundConfig(prev, key);
      return updateEventSoundConfig(prev, key, {
        ...current,
        source: {
          kind: "managed",
          assetId: importedAsset.assetId,
          label: importedAsset.originalName,
        },
      });
    });
  };

  const handleUpload = async (key: EventSoundKey, file: File) => {
    if (!api?.eventSounds?.uploadAsset) {
      return;
    }

    if (file.size > MAX_AUDIO_FILE_SIZE_BYTES) {
      return;
    }

    try {
      const base64 = await readFileAsBase64(file);
      const uploadedAsset = await api.eventSounds.uploadAsset({
        base64,
        originalName: file.name,
        mimeType: file.type,
      });

      applySettingsUpdate((prev) => {
        const current = getEventSoundConfig(prev, key);
        return updateEventSoundConfig(prev, key, {
          ...current,
          source: {
            kind: "managed",
            assetId: uploadedAsset.assetId,
            label: uploadedAsset.originalName,
          },
        });
      });
    } catch {
      // Best-effort only.
    }
  };

  const openUploadPicker = (key: EventSoundKey) => {
    uploadTargetKeyRef.current = key;
    uploadInputRef.current?.click();
  };

  const handleClearFile = (key: EventSoundKey) => {
    applySettingsUpdate((prev) => {
      const current = getEventSoundConfig(prev, key);
      return updateEventSoundConfig(prev, key, {
        ...current,
        source: null,
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

      <input
        ref={uploadInputRef}
        type="file"
        accept={AUDIO_UPLOAD_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const key = uploadTargetKeyRef.current;
          const file = event.target.files?.[0];
          event.target.value = "";

          if (!key || !file) {
            return;
          }

          void handleUpload(key, file);
        }}
      />

      <div className="border-border-light divide-border-light divide-y rounded-md border">
        {EVENT_SOUND_KEYS.map((key) => {
          const soundConfig = getEventSoundConfig(eventSoundSettings, key);
          const fileLabel =
            soundConfig.source?.label ?? soundConfig.source?.assetId ?? "No sound selected";

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
                    disabled={
                      !canPersist ||
                      !api?.projects?.pickAudioFile ||
                      !api?.eventSounds?.importFromLocalPath
                    }
                  >
                    Browse
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openUploadPicker(key)}
                    disabled={!canPersist || !api?.eventSounds?.uploadAsset}
                  >
                    Upload
                  </Button>
                )}
                {soundConfig.source ? (
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
