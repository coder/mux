export const LEFT_SIDEBAR_DEFAULT_WIDTH_PX = 288;
export const LEFT_SIDEBAR_MIN_WIDTH_PX = 200;
export const LEFT_SIDEBAR_MAX_WIDTH_PX = 600;
export const LEFT_SIDEBAR_COLLAPSED_WIDTH_PX = 20;

// When the left sidebar is collapsed, WorkspaceMenuBar still needs extra room for the
// floating reopen affordance so the header content doesn't sit underneath it.
export const WORKSPACE_MENU_BAR_LEFT_SIDEBAR_COLLAPSED_PADDING_PX = 60;
export const CREATION_COLUMN_MAX_WIDTH_CLASS = "max-w-[67rem]";
// Keep composer controls aligned without relying on individual component defaults. The marker class
// is what globals.css uses to give the row's non-button surfaces the same touch height as its
// buttons; see the mobile block there.
export const COMPOSER_CONTROL_HEIGHT_CLASS = "composer-control-surface h-6";

// The composer control row sheds detail in container-query stages as it narrows, widest threshold
// first. Keeping the ladder here rather than inline is what stops two controls in the row from
// disagreeing about when they collapse.
//
// These are tuned so a label only disappears once the row genuinely lacks the space for it. The
// model pill is content-sized (see ChatInput's ModelSelector className), so an over-long model name
// still truncates inside its own 8rem cap rather than forcing these labels out early.
export const COMPOSER_COMPACT_HIDE_CLASS = "[@container(max-width:500px)]:hidden";
export const COMPOSER_ICON_ONLY_HIDE_CLASS = "[@container(max-width:360px)]:hidden";
export const COMPOSER_PRO_HIDE_CLASS = "[@container(max-width:340px)]:hidden";

// Workspace rows also carry the context pill, so the agent label needs more room here than on the
// creation row. A container query cannot measure sibling text, so this is set for the widest
// realistic content (a long agent name next to a long model name at XHIGH) rather than the
// narrowest: the agent label does not shrink, so a threshold set too low shows a label that then
// squeezes its neighbours instead of hiding.
export const COMPOSER_WORKSPACE_ICON_ONLY_HIDE_CLASS = "[@container(max-width:450px)]:hidden";
