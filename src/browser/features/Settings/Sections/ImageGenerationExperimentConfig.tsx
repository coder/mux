import React, { useEffect, useRef, useState } from "react";

import { Switch } from "@/browser/components/Switch/Switch";
import { Input } from "@/browser/components/Input/Input";
import { useAPI } from "@/browser/contexts/API";
import {
  DEFAULT_IMAGE_GENERATION_MAX_IMAGES,
  DEFAULT_IMAGE_GENERATION_MODEL,
  MAX_IMAGE_GENERATION_MAX_IMAGES,
  MIN_IMAGE_GENERATION_MAX_IMAGES,
  PINNED_IMAGE_GENERATION_MODEL,
  normalizeImageGenerationConfig,
  type ImageGenerationConfig,
} from "@/common/types/imageGeneration";
import { getErrorMessage } from "@/common/utils/errors";

function parseMaxImages(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_IMAGE_GENERATION_MAX_IMAGES ||
    parsed > MAX_IMAGE_GENERATION_MAX_IMAGES
  ) {
    return null;
  }
  return parsed;
}

function normalizeDraft(
  modelDraft: string,
  maxImagesDraft: string,
  allowImageUploadsForEditing: boolean
): ImageGenerationConfig | null {
  const modelString = modelDraft.trim();
  const maxImagesPerCall = parseMaxImages(maxImagesDraft);
  if (!modelString || maxImagesPerCall == null) {
    return null;
  }
  return { modelString, maxImagesPerCall, allowImageUploadsForEditing };
}

function areConfigsEqual(a: ImageGenerationConfig, b: ImageGenerationConfig): boolean {
  return (
    a.modelString === b.modelString &&
    a.maxImagesPerCall === b.maxImagesPerCall &&
    a.allowImageUploadsForEditing === b.allowImageUploadsForEditing
  );
}

interface ImageGenerationExperimentConfigProps {
  enabled?: boolean;
}

export function ImageGenerationExperimentConfig(props: ImageGenerationExperimentConfigProps) {
  const imageToolsEnabled = props.enabled ?? true;
  const { api } = useAPI();
  const [modelDraft, setModelDraft] = useState(DEFAULT_IMAGE_GENERATION_MODEL);
  const [maxImagesDraft, setMaxImagesDraft] = useState(String(DEFAULT_IMAGE_GENERATION_MAX_IMAGES));
  const [allowUploadsDraft, setAllowUploadsDraft] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pendingSaveRef = useRef<ImageGenerationConfig | null>(null);
  const draftRef = useRef({ modelDraft, maxImagesDraft, allowUploadsDraft });
  const lastSyncedRef = useRef<ImageGenerationConfig | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    draftRef.current = { modelDraft, maxImagesDraft, allowUploadsDraft };
  }, [modelDraft, maxImagesDraft, allowUploadsDraft]);

  useEffect(() => {
    if (!api) {
      return;
    }

    let ignore = false;
    setLoaded(false);
    setLoadFailed(false);
    setSaveError(null);

    void api.config
      .getConfig()
      .then((cfg) => {
        if (ignore) return;
        const imageGeneration = normalizeImageGenerationConfig(cfg.imageGeneration);
        setModelDraft(imageGeneration.modelString);
        setAllowUploadsDraft(imageGeneration.allowImageUploadsForEditing);
        setMaxImagesDraft(String(imageGeneration.maxImagesPerCall));
        lastSyncedRef.current = imageGeneration;
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setSaveError(getErrorMessage(error));
        setLoadFailed(true);
        setLoaded(true);
      });

    return () => {
      ignore = true;
    };
  }, [api]);

  useEffect(() => {
    if (!api || !loaded || loadFailed) {
      return;
    }

    const normalizedDraft = normalizeDraft(modelDraft, maxImagesDraft, allowUploadsDraft);
    if (normalizedDraft == null) {
      // Invalid drafts should not flush an older valid payload when Settings closes.
      pendingSaveRef.current = null;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      return;
    }

    const lastSynced = lastSyncedRef.current;
    if (lastSynced && areConfigsEqual(lastSynced, normalizedDraft)) {
      pendingSaveRef.current = null;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      return;
    }

    pendingSaveRef.current = normalizedDraft;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const flush = () => {
      if (savingRef.current) return;
      const payload = pendingSaveRef.current;
      if (!payload) return;

      pendingSaveRef.current = null;
      savingRef.current = true;
      let saveSucceeded = false;
      void api.config
        .updateImageGenerationConfig({ imageGeneration: payload })
        .then(() => {
          saveSucceeded = true;
          lastSyncedRef.current = payload;
          if (isMountedRef.current) {
            setSaveError(null);
          }
        })
        .catch((error: unknown) => {
          const currentDraft = isMountedRef.current
            ? normalizeDraft(
                draftRef.current.modelDraft,
                draftRef.current.maxImagesDraft,
                draftRef.current.allowUploadsDraft
              )
            : null;
          pendingSaveRef.current =
            currentDraft != null &&
            lastSyncedRef.current != null &&
            !areConfigsEqual(lastSyncedRef.current, currentDraft)
              ? currentDraft
              : null;
          if (isMountedRef.current) {
            setSaveError(getErrorMessage(error));
          }
        })
        .finally(() => {
          savingRef.current = false;
          if (!saveSucceeded) {
            return;
          }
          if (!isMountedRef.current) {
            // Preserve edits made while the previous save was in flight; closing Settings
            // should not silently drop the latest valid draft.
            const pendingUnmountSave = pendingSaveRef.current;
            if (pendingUnmountSave != null) {
              pendingSaveRef.current = null;
              savingRef.current = true;
              void api.config
                .updateImageGenerationConfig({ imageGeneration: pendingUnmountSave })
                .catch(() => undefined)
                .finally(() => {
                  savingRef.current = false;
                });
            }
            return;
          }

          const currentDraft = normalizeDraft(
            draftRef.current.modelDraft,
            draftRef.current.maxImagesDraft,
            draftRef.current.allowUploadsDraft
          );
          if (
            currentDraft != null &&
            lastSyncedRef.current != null &&
            !areConfigsEqual(lastSyncedRef.current, currentDraft) &&
            pendingSaveRef.current == null
          ) {
            pendingSaveRef.current = currentDraft;
          }
          if (pendingSaveRef.current != null) {
            flush();
          }
        });
    };

    saveTimerRef.current = setTimeout(flush, 400);
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [api, loaded, loadFailed, modelDraft, maxImagesDraft, allowUploadsDraft]);

  useEffect(() => {
    if (!api || !loaded || loadFailed) {
      return;
    }

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      if (savingRef.current) {
        return;
      }

      const payload = pendingSaveRef.current;
      if (!payload) {
        return;
      }

      // Image generation settings auto-save. If Settings closes during the debounce window,
      // flush the pending valid edit rather than silently dropping the user's change.
      pendingSaveRef.current = null;
      savingRef.current = true;
      void api.config
        .updateImageGenerationConfig({ imageGeneration: payload })
        .catch(() => undefined)
        .finally(() => {
          savingRef.current = false;
        });
    };
  }, [api, loaded, loadFailed]);

  const handleMaxImagesBlur = () => {
    const parsed = parseMaxImages(maxImagesDraft) ?? DEFAULT_IMAGE_GENERATION_MAX_IMAGES;
    setMaxImagesDraft(String(parsed));
  };

  const maxImagesInvalid = parseMaxImages(maxImagesDraft) == null;
  const modelInvalid = modelDraft.trim().length === 0;

  const controlsDisabled = loadFailed || !imageToolsEnabled;

  if (!api) {
    return (
      <div className="bg-background-secondary px-4 py-3">
        <div className="text-muted text-xs">Connect to mux to configure Image Tools.</div>
      </div>
    );
  }

  return (
    <div className="bg-background-secondary space-y-3 px-4 py-3">
      <div className="text-muted text-xs">
        Experimental Image Tools require OpenAI provider credentials. Full images are saved as
        runtime artifacts; copy final assets into the workspace when they matter. Image editing
        uploads source images as-is, including metadata, only when upload consent is enabled.
      </div>
      {!imageToolsEnabled && (
        <div className="text-muted text-xs">
          Turn on Image Tools above to enable image generation settings and upload consent.
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-foreground text-sm">Image model</div>
          <div className="text-muted text-xs">
            {`Default ${DEFAULT_IMAGE_GENERATION_MODEL}; pinned snapshot ${PINNED_IMAGE_GENERATION_MODEL}`}
          </div>
        </div>
        <Input
          value={modelDraft}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setModelDraft(event.target.value)
          }
          placeholder={DEFAULT_IMAGE_GENERATION_MODEL}
          disabled={controlsDisabled}
          className="border-border-medium bg-background-secondary h-9 w-72"
        />
      </div>
      {modelInvalid && <div className="text-error text-xs">Image model is required.</div>}

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-foreground text-sm">Max images per call</div>
          <div className="text-muted text-xs">
            {`${MIN_IMAGE_GENERATION_MAX_IMAGES}-${MAX_IMAGE_GENERATION_MAX_IMAGES}; requests above this fail instead of being silently clamped`}
          </div>
        </div>
        <Input
          value={maxImagesDraft}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setMaxImagesDraft(event.target.value)
          }
          onBlur={handleMaxImagesBlur}
          inputMode="numeric"
          disabled={controlsDisabled}
          className="border-border-medium bg-background-secondary h-9 w-24"
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-foreground text-sm">Allow image uploads for editing</div>
          <div className="text-muted text-xs">
            Enables the image_edit tool. The agent may select any image file the runtime can access;
            source images are uploaded as-is, including embedded metadata.
          </div>
        </div>
        <Switch
          checked={allowUploadsDraft}
          onCheckedChange={setAllowUploadsDraft}
          disabled={controlsDisabled}
          aria-label="Allow image uploads for editing"
        />
      </div>
      {maxImagesInvalid && (
        <div className="text-error text-xs">
          {`Enter a whole number from ${MIN_IMAGE_GENERATION_MAX_IMAGES} to ${MAX_IMAGE_GENERATION_MAX_IMAGES}.`}
        </div>
      )}
      {saveError && <div className="text-error text-xs">{saveError}</div>}
    </div>
  );
}
