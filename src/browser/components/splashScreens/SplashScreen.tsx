import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/browser/components/ui/dialog";
import { Button } from "@/browser/components/ui/button";

interface SplashScreenProps {
  title: string;
  children: React.ReactNode;
  onDismiss: () => void;
  primaryAction?: {
    label: string;
    onClick: () => void;
  };
  dismissLabel?: string; // defaults to "Got it"
}

export function SplashScreen(props: SplashScreenProps) {
  const handlePrimaryAction = () => {
    if (props.primaryAction) {
      props.primaryAction.onClick();
    }
    props.onDismiss();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onDismiss()}>
      <DialogContent maxWidth="500px">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        {props.children}
        <DialogFooter>
          {props.primaryAction && (
            <Button onClick={handlePrimaryAction}>{props.primaryAction.label}</Button>
          )}
          <Button variant="secondary" onClick={props.onDismiss}>
            {props.dismissLabel ?? "Got it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
