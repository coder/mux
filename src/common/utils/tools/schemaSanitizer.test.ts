/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { sanitizeToolSchemaForOpenAI, sanitizeMCPToolsForOpenAI } from "./schemaSanitizer";
import type { Tool } from "ai";

// Test helper to access tool parameters
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getParams(tool: Tool): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tool as any).parameters;
}

describe("schemaSanitizer", () => {
  describe("sanitizeToolSchemaForOpenAI", () => {
    it("should strip minLength from string properties", () => {
      const tool = {
        description: "Test tool",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1 },
          },
        },
      } as unknown as Tool;

      const sanitized = sanitizeToolSchemaForOpenAI(tool);
      const params = getParams(sanitized);

      expect(params.properties.content).toEqual({ type: "string" });
      expect(params.properties.content.minLength).toBeUndefined();
    });

    it("should strip multiple unsupported properties", () => {
      const tool = {
        description: "Test tool",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100, pattern: "^[a-z]+$" },
            age: { type: "number", minimum: 0, maximum: 150, default: 25 },
          },
        },
      } as unknown as Tool;

      const sanitized = sanitizeToolSchemaForOpenAI(tool);
      const params = getParams(sanitized);

      expect(params.properties.name).toEqual({ type: "string" });
      expect(params.properties.age).toEqual({ type: "number" });
    });

    it("should handle nested objects", () => {
      const tool = {
        description: "Test tool",
        parameters: {
          type: "object",
          properties: {
            user: {
              type: "object",
              properties: {
                email: { type: "string", format: "email", minLength: 5 },
              },
            },
          },
        },
      } as unknown as Tool;

      const sanitized = sanitizeToolSchemaForOpenAI(tool);
      const params = getParams(sanitized);

      expect(params.properties.user.properties.email).toEqual({ type: "string" });
    });

    it("should handle array items", () => {
      const tool = {
        description: "Test tool",
        parameters: {
          type: "object",
          properties: {
            tags: {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 1,
              maxItems: 10,
            },
          },
        },
      } as unknown as Tool;

      const sanitized = sanitizeToolSchemaForOpenAI(tool);
      const params = getParams(sanitized);

      expect(params.properties.tags.items).toEqual({ type: "string" });
      expect(params.properties.tags.minItems).toBeUndefined();
      expect(params.properties.tags.maxItems).toBeUndefined();
    });

    it("should handle anyOf/oneOf schemas", () => {
      const tool = {
        description: "Test tool",
        parameters: {
          type: "object",
          properties: {
            value: {
              oneOf: [
                { type: "string", minLength: 1 },
                { type: "number", minimum: 0 },
              ],
            },
          },
        },
      } as unknown as Tool;

      const sanitized = sanitizeToolSchemaForOpenAI(tool);
      const params = getParams(sanitized);

      expect(params.properties.value.oneOf[0]).toEqual({ type: "string" });
      expect(params.properties.value.oneOf[1]).toEqual({ type: "number" });
    });

    it("should preserve required and type properties", () => {
      const tool = {
        description: "Test tool",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1 },
          },
          required: ["content"],
        },
      } as unknown as Tool;

      const sanitized = sanitizeToolSchemaForOpenAI(tool);
      const params = getParams(sanitized);

      expect(params.type).toBe("object");
      expect(params.required).toEqual(["content"]);
    });

    it("should return tool as-is if no parameters", () => {
      const tool = {
        description: "Test tool",
      } as unknown as Tool;

      const sanitized = sanitizeToolSchemaForOpenAI(tool);

      expect(sanitized).toEqual(tool);
    });

    it("should not mutate the original tool", () => {
      const tool = {
        description: "Test tool",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1 },
          },
        },
      } as unknown as Tool;

      sanitizeToolSchemaForOpenAI(tool);
      const params = getParams(tool);

      // Original should still have minLength
      expect(params.properties.content.minLength).toBe(1);
    });
  });

  describe("sanitizeMCPToolsForOpenAI", () => {
    it("should sanitize all tools in a record", () => {
      const tools = {
        tool1: {
          description: "Tool 1",
          parameters: {
            type: "object",
            properties: {
              content: { type: "string", minLength: 1 },
            },
          },
        },
        tool2: {
          description: "Tool 2",
          parameters: {
            type: "object",
            properties: {
              count: { type: "number", minimum: 0 },
            },
          },
        },
      } as unknown as Record<string, Tool>;

      const sanitized = sanitizeMCPToolsForOpenAI(tools);

      expect(getParams(sanitized.tool1).properties.content).toEqual({
        type: "string",
      });
      expect(getParams(sanitized.tool2).properties.count).toEqual({
        type: "number",
      });
    });
  });
});
