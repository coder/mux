/**
 * Sentinel key stored in EXPANDED_PROJECTS_KEY for the sidebar's synthetic
 * multi-project workspace section (which is not a real project path).
 */
export const MULTI_PROJECT_SIDEBAR_SECTION_ID = "__multi-project__";

/**
 * Synthetic project key used in config.json to store multi-project workspaces.
 * Multi-project workspaces don't belong to a single project, so they're stored
 * under this key in the projects map.
 */
export const MULTI_PROJECT_CONFIG_KEY = "_multi";
