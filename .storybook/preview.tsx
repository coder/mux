import type { Preview } from "@storybook/react-vite";
import "../src/browser/styles/globals.css";

const preview: Preview = {
  decorators: [
    (Story) => (
      <>
        <Story />
      </>
    ),
  ],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
};

export default preview;
