export const LEFT_SIDEBAR_DEFAULT_WIDTH_PX = 288;
export const LEFT_SIDEBAR_MIN_WIDTH_PX = 200;
export const LEFT_SIDEBAR_MAX_WIDTH_PX = 600;
export const LEFT_SIDEBAR_COLLAPSED_WIDTH_PX = 20;

// When the left sidebar is collapsed, WorkspaceMenuBar still needs extra room for the
// floating reopen affordance so the header content doesn't sit underneath it.
export const WORKSPACE_MENU_BAR_LEFT_SIDEBAR_COLLAPSED_PADDING_PX = 60;
// Creation surfaces (ProjectPage, ScratchPage) share one content column, measured from the
// Review 1.4 "start V2" frame (rfc/20260725_review-1.4-layouts.md).
export const CREATION_COLUMN_MAX_WIDTH_CLASS = "max-w-[67rem]";
// The composer's agent, model+thinking, and context controls read as one row of equal-height
// pills in the Review 1.4 start frame, so they share a height instead of sizing to content.
export const COMPOSER_CONTROL_HEIGHT_CLASS = "h-6";
