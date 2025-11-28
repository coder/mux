import { describe, it, expect, beforeEach } from "bun:test";
import { MessageQueue } from "./messageQueue";
import type { MuxFrontendMetadata } from "@/common/types/message";
import type { SendMessageOptions } from "@/common/types/ipc";

describe("MessageQueue", () => {
  let queue: MessageQueue;

  beforeEach(() => {
    queue = new MessageQueue();
  });

  describe("getDisplayText", () => {
    it("should return joined messages for normal messages", () => {
      queue.add("First message");
      queue.add("Second message");

      expect(queue.getDisplayText()).toBe("First message\nSecond message");
    });

    it("should return rawCommand for compaction request", () => {
      const metadata: MuxFrontendMetadata = {
        type: "compaction-request",
        rawCommand: "/compact -t 3000",
        parsed: { maxOutputTokens: 3000 },
      };

      const options: SendMessageOptions = {
        model: "claude-3-5-sonnet-20241022",
        muxMetadata: metadata,
      };

      queue.add("Summarize this conversation into a compact form...", options);

      expect(queue.getDisplayText()).toBe("/compact -t 3000");
    });

    it("should return rawCommand even with multiple messages if last has compaction metadata", () => {
      queue.add("First message");

      const metadata: MuxFrontendMetadata = {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {},
      };

      const options: SendMessageOptions = {
        model: "claude-3-5-sonnet-20241022",
        muxMetadata: metadata,
      };

      queue.add("Summarize this conversation...", options);

      // Should use rawCommand from latest options
      expect(queue.getDisplayText()).toBe("/compact");
    });

    it("should return joined messages when metadata type is not compaction-request", () => {
      const metadata: MuxFrontendMetadata = {
        type: "normal",
      };

      const options: SendMessageOptions = {
        model: "claude-3-5-sonnet-20241022",
        muxMetadata: metadata,
      };

      queue.add("Regular message", options);

      expect(queue.getDisplayText()).toBe("Regular message");
    });

    it("should return empty string for empty queue", () => {
      expect(queue.getDisplayText()).toBe("");
    });

    it("should return joined messages after clearing compaction metadata", () => {
      const metadata: MuxFrontendMetadata = {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {},
      };

      const options: SendMessageOptions = {
        model: "claude-3-5-sonnet-20241022",
        muxMetadata: metadata,
      };

      queue.add("Summarize this...", options);
      queue.clear();
      queue.add("New message");

      expect(queue.getDisplayText()).toBe("New message");
    });
  });

  describe("getMessages", () => {
    it("should return raw messages even for compaction requests", () => {
      const metadata: MuxFrontendMetadata = {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {},
      };

      const options: SendMessageOptions = {
        model: "claude-3-5-sonnet-20241022",
        muxMetadata: metadata,
      };

      queue.add("Summarize this conversation...", options);

      // getMessages should return the actual message text for editing
      expect(queue.getMessages()).toEqual(["Summarize this conversation..."]);
      // getDisplayText should return the slash command
      expect(queue.getDisplayText()).toBe("/compact");
    });
  });

  describe("getImageParts", () => {
    it("should return accumulated images from multiple messages", () => {
      const image1 = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      const image2 = { url: "data:image/jpeg;base64,def", mediaType: "image/jpeg" };
      const image3 = { url: "data:image/gif;base64,ghi", mediaType: "image/gif" };

      queue.add("First message", { model: "gpt-4", imageParts: [image1] });
      queue.add("Second message", { model: "gpt-4", imageParts: [image2, image3] });

      const images = queue.getImageParts();
      expect(images).toEqual([image1, image2, image3]);
    });

    it("should return empty array when no images", () => {
      queue.add("Text only message");
      expect(queue.getImageParts()).toEqual([]);
    });

    it("should return copy of images array", () => {
      const image = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      queue.add("Message", { model: "gpt-4", imageParts: [image] });

      const images1 = queue.getImageParts();
      const images2 = queue.getImageParts();

      expect(images1).toEqual(images2);
      expect(images1).not.toBe(images2); // Different array instances
    });

    it("should clear images when queue is cleared", () => {
      const image = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      queue.add("Message", { model: "gpt-4", imageParts: [image] });

      expect(queue.getImageParts()).toHaveLength(1);

      queue.clear();
      expect(queue.getImageParts()).toEqual([]);
    });
  });

  describe("image-only messages", () => {
    it("should accept image-only messages (empty text with images)", () => {
      const image = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      queue.add("", { model: "gpt-4", imageParts: [image] });

      expect(queue.getMessages()).toEqual([]);
      expect(queue.getImageParts()).toEqual([image]);
      expect(queue.isEmpty()).toBe(false);
    });

    it("should reject messages with empty text and no images", () => {
      queue.add("", { model: "gpt-4" });

      expect(queue.isEmpty()).toBe(true);
      expect(queue.getMessages()).toEqual([]);
      expect(queue.getImageParts()).toEqual([]);
    });

    it("should handle mixed text and image-only messages", () => {
      const image1 = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      const image2 = { url: "data:image/jpeg;base64,def", mediaType: "image/jpeg" };

      queue.add("Text message", { model: "gpt-4", imageParts: [image1] });
      queue.add("", { model: "gpt-4", imageParts: [image2] }); // Image-only

      expect(queue.getMessages()).toEqual(["Text message"]);
      expect(queue.getImageParts()).toEqual([image1, image2]);
      expect(queue.isEmpty()).toBe(false);
    });

    it("should consider queue non-empty when only images present", () => {
      const image = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      queue.add("", { model: "gpt-4", imageParts: [image] });

      expect(queue.isEmpty()).toBe(false);
    });

    it("should produce correct message for image-only queue", () => {
      const image = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      queue.add("", { model: "gpt-4", imageParts: [image] });

      const { message, options } = queue.produceMessage();

      expect(message).toBe("");
      expect(options?.imageParts).toEqual([image]);
      expect(options?.model).toBe("gpt-4");
    });

    it("should return empty string for getDisplayText with image-only", () => {
      const image = { url: "data:image/png;base64,abc", mediaType: "image/png" };
      queue.add("", { model: "gpt-4", imageParts: [image] });

      expect(queue.getDisplayText()).toBe("");
    });
  });
});
