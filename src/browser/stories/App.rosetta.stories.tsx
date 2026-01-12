/**
 * Rosetta banner story - demonstrates the warning shown when running under Rosetta 2
 */

import React from "react";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./storyHelpers";
import { STABLE_TIMESTAMP, createUserMessage, createAssistantMessage } from "./mockFactory";

export default {
  ...appMeta,
  title: "App/Rosetta",
};

/** Rosetta banner shown at top of app when running under translation */
export const RosettaBanner: AppStory = {
  decorators: [
    (Story) => {
      // Save and restore window.api to prevent leaking to other stories
      const originalApiRef = React.useRef(window.api);
      window.api = {
        platform: "darwin",
        versions: {
          node: "20.0.0",
          chrome: "120.0.0",
          electron: "28.0.0",
        },
        isRosetta: true,
      };

      // Cleanup on unmount
      React.useEffect(() => {
        const savedApi = originalApiRef.current;
        return () => {
          window.api = savedApi;
        };
      }, []);

      return <Story />;
    },
  ],
  render: () => (
    <AppWithMocks
      setup={() => {
        // Clear any previously dismissed state
        localStorage.removeItem("rosettaBannerDismissedAt");

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
