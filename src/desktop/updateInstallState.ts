/**
 * Shared flag so the main-process quit handler can detect an
 * update-driven quit and skip the event.preventDefault() that
 * would otherwise block autoUpdater.quitAndInstall().
 */
let updateInstallInProgress = false;

export function markUpdateInstallInProgress(): void {
  updateInstallInProgress = true;
}

export function clearUpdateInstallInProgress(): void {
  updateInstallInProgress = false;
}

export function isUpdateInstallInProgress(): boolean {
  return updateInstallInProgress;
}
