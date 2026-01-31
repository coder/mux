import { createLocalFirstBackend } from "@/browser/utils/persistedStateBackend";

interface SettingsValue {
  model: string;
  thinkingLevel: string;
}

test("local-first backend ignores stale remote updates until match", async () => {
  let subscriber: (value: SettingsValue) => void = jest.fn();

  const transport = {
    write: jest.fn().mockResolvedValue({ success: true }),
    subscribe: (_key: string, callback: (value: SettingsValue) => void) => {
      subscriber = callback;
      return () => {
        subscriber = jest.fn();
      };
    },
  };

  const backend = createLocalFirstBackend<SettingsValue>(transport, {
    isEqual: (left, right) =>
      left.model === right.model && left.thinkingLevel === right.thinkingLevel,
  });

  const updates: SettingsValue[] = [];
  backend.subscribe?.("workspaceAiSettings", (value) => {
    updates.push(value);
  });

  const pendingValue = { model: "openai:gpt-5.2", thinkingLevel: "high" };
  await backend.write?.("workspaceAiSettings", pendingValue, undefined);

  subscriber({ model: "anthropic:claude", thinkingLevel: "low" });
  expect(updates).toEqual([]);

  subscriber({ model: "openai:gpt-5.2", thinkingLevel: "high" });
  expect(updates).toEqual([pendingValue]);
});
