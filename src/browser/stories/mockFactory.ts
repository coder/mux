/**
 * Compatibility shim for story mock factories.
 *
 * This file intentionally re-exports split feature modules so existing story imports
 * from "./mockFactory" continue to work during incremental migration.
 */

export * from "./mocks/workspaces";
export * from "./mocks/messages";
export * from "./mocks/tools";
export * from "./mocks/chatHandlers";
export * from "./mocks/git";
