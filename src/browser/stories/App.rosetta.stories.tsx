/**
 * Rosetta banner story - demonstrates the warning shown when running under Rosetta 2
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./storyHelpers";
import { STABLE_TIMESTAMP, createUserMessage, createAssistantMessage } from "./mockFactory";

export default {
  ...appMeta,
  title: "App/Rosetta",
};

/** Rosetta banner shown at top of app when running under translation */
export const RosettaBanner: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        // Clear any previously dismissed state
        localStorage.removeItem("rosettaBannerDismissedAt");

        // Set window.api to simulate Rosetta environment
        window.api = {
          platform: "darwin",
          versions: {
            node: "20.0.0",
            chrome: "120.0.0",
            electron: "28.0.0",
          },
          isRosetta: true,
        };

        return setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Hello! Can you help me with my code?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage(
              "msg-2",
              "Of course! I'd be happy to help. What would you like to work on today?",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 50000,
              }
            ),
          ],
        });
      }}
    />
  ),
};
