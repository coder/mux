import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { TutorialTooltip, type TutorialStep } from "@/browser/components/TutorialTooltip";
import {
  TUTORIAL_STATE_KEY,
  DEFAULT_TUTORIAL_STATE,
  type TutorialState,
  type TutorialSequence,
} from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";

// Tutorial step definitions for each sequence
const TUTORIAL_SEQUENCES: Record<TutorialSequence, TutorialStep[]> = {
  settings: [
    {
      target: "settings-button",
      title: "Settings",
      content: "Access model configuration, API keys, keyboard shortcuts, and preferences here.",
      position: "bottom",
    },
  ],
  creation: [
    {
      target: "model-selector",
      title: "Choose Your Model",
      content:
        "Select which AI model to use. Different models have different capabilities and costs.",
      position: "bottom",
    },
    {
      target: "mode-selector",
      title: "Exec vs Plan Mode",
      content:
        "Exec mode lets the AI edit files and run commands. Plan mode is read-only—great for exploring ideas safely.",
      position: "top",
    },
    {
      target: "trunk-branch",
      title: "Branch From",
      content:
        "Choose which branch to fork from. Your workspace will be created as a new branch from this starting point.",
      position: "top",
    },
    {
      target: "runtime-selector",
      title: "Runtime Environment",
      content: "Run locally using git worktrees, or connect via SSH to work on a remote machine.",
      position: "top",
    },
  ],
  workspace: [
    {
      target: "terminal-button",
      title: "Terminal Access",
      content:
        "Open a terminal window in your workspace to run commands directly alongside the AI.",
      position: "bottom",
    },
  ],
};

interface TutorialContextValue {
  startSequence: (sequence: TutorialSequence) => void;
  isSequenceCompleted: (sequence: TutorialSequence) => boolean;
  isTutorialDisabled: () => boolean;
}

const TutorialContext = createContext<TutorialContextValue | null>(null);

export function useTutorial(): TutorialContextValue {
  const context = useContext(TutorialContext);
  if (!context) {
    throw new Error("useTutorial must be used within a TutorialProvider");
  }
  return context;
}

interface TutorialProviderProps {
  children: React.ReactNode;
}

export function TutorialProvider({ children }: TutorialProviderProps) {
  const [tutorialState, setTutorialState] = useState<TutorialState>(() =>
    readPersistedState(TUTORIAL_STATE_KEY, DEFAULT_TUTORIAL_STATE)
  );
  const [activeSequence, setActiveSequence] = useState<TutorialSequence | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  // Persist state changes
  useEffect(() => {
    updatePersistedState(TUTORIAL_STATE_KEY, tutorialState);
  }, [tutorialState]);

  const isSequenceCompleted = useCallback(
    (sequence: TutorialSequence): boolean => {
      return tutorialState.completed[sequence] === true;
    },
    [tutorialState.completed]
  );

  const isTutorialDisabled = useCallback((): boolean => {
    return tutorialState.disabled;
  }, [tutorialState.disabled]);

  const startSequence = useCallback(
    (sequence: TutorialSequence) => {
      // Don't start if disabled or already completed
      if (tutorialState.disabled || tutorialState.completed[sequence]) {
        return;
      }
      // Don't start if another sequence is active
      if (activeSequence !== null) {
        return;
      }
      setActiveSequence(sequence);
      setCurrentStepIndex(0);
    },
    [tutorialState.disabled, tutorialState.completed, activeSequence]
  );

  const handleNext = useCallback(() => {
    if (activeSequence === null) return;

    const steps = TUTORIAL_SEQUENCES[activeSequence];
    if (currentStepIndex < steps.length - 1) {
      setCurrentStepIndex((prev) => prev + 1);
    } else {
      // Complete the sequence
      setTutorialState((prev) => ({
        ...prev,
        completed: { ...prev.completed, [activeSequence]: true },
      }));
      setActiveSequence(null);
      setCurrentStepIndex(0);
    }
  }, [activeSequence, currentStepIndex]);

  const handleDismiss = useCallback(() => {
    if (activeSequence === null) return;

    // Mark as completed when dismissed
    setTutorialState((prev) => ({
      ...prev,
      completed: { ...prev.completed, [activeSequence]: true },
    }));
    setActiveSequence(null);
    setCurrentStepIndex(0);
  }, [activeSequence]);

  const handleDisableTutorial = useCallback(() => {
    setTutorialState((prev) => ({
      ...prev,
      disabled: true,
    }));
    setActiveSequence(null);
    setCurrentStepIndex(0);
  }, []);

  const contextValue: TutorialContextValue = {
    startSequence,
    isSequenceCompleted,
    isTutorialDisabled,
  };

  const activeSteps = activeSequence ? TUTORIAL_SEQUENCES[activeSequence] : null;
  const currentStep = activeSteps?.[currentStepIndex];

  return (
    <TutorialContext.Provider value={contextValue}>
      {children}
      {currentStep && activeSteps && (
        <TutorialTooltip
          step={currentStep}
          currentStep={currentStepIndex + 1}
          totalSteps={activeSteps.length}
          onNext={handleNext}
          onDismiss={handleDismiss}
          onDisableTutorial={handleDisableTutorial}
        />
      )}
    </TutorialContext.Provider>
  );
}
