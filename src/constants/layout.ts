export const LEFT_SIDEBAR_DEFAULT_WIDTH_PX = 288;
export const LEFT_SIDEBAR_MIN_WIDTH_PX = 200;
export const LEFT_SIDEBAR_MAX_WIDTH_PX = 600;
export const LEFT_SIDEBAR_COLLAPSED_WIDTH_PX = 20;

// When the left sidebar is collapsed, WorkspaceMenuBar still needs extra room for the
// floating reopen affordance so the header content doesn't sit underneath it.
export const WORKSPACE_MENU_BAR_LEFT_SIDEBAR_COLLAPSED_PADDING_PX = 60;
// Creation surfaces (ProjectPage, ScratchPage) share one content column. 1072px matches
// the 1076px prompt box measured in the Review 1.4 "start V2" frame, whose PNG exports
// are 1:1 CSS px (rfc/20260725_review-1.4-layouts.md).
export const CREATION_COLUMN_MAX_WIDTH_CLASS = "max-w-[67rem]";
