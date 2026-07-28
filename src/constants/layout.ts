export const LEFT_SIDEBAR_DEFAULT_WIDTH_PX = 288;
export const LEFT_SIDEBAR_MIN_WIDTH_PX = 200;
export const LEFT_SIDEBAR_MAX_WIDTH_PX = 600;
export const LEFT_SIDEBAR_COLLAPSED_WIDTH_PX = 20;

// When the left sidebar is collapsed, WorkspaceMenuBar still needs extra room for the
// floating reopen affordance so the header content doesn't sit underneath it.
export const WORKSPACE_MENU_BAR_LEFT_SIDEBAR_COLLAPSED_PADDING_PX = 60;
export const CREATION_COLUMN_MAX_WIDTH_CLASS = "max-w-[67rem]";
// Keep composer controls aligned without relying on individual component defaults.
export const COMPOSER_CONTROL_HEIGHT_CLASS = "h-6";

// The composer control row sheds detail in two container-query stages as it narrows. Controls in
// the row share these thresholds so they collapse together instead of competing for the width left.
export const COMPOSER_COMPACT_HIDE_CLASS = "[@container(max-width:520px)]:hidden";
export const COMPOSER_ICON_ONLY_HIDE_CLASS = "[@container(max-width:420px)]:hidden";
