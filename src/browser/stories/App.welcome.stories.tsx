/**
 * Welcome/Empty state stories
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createMockAPI, installMockAPI } from "./mockFactory";

export default {
  ...appMeta,
  title: "App/Welcome",
};

/** Welcome screen shown when no projects exist */
export const WelcomeScreen: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        installMockAPI(
          createMockAPI({
            projects: new Map(),
            workspaces: [],
          })
        );
      }}
    />
  ),
};
