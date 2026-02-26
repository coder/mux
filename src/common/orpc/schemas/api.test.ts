import { describe, expect, it } from "bun:test";
import {
  AWSCredentialStatusSchema,
  ProviderConfigInfoSchema,
  ProvidersConfigMapSchema,
} from "./api";
import type { AWSCredentialStatus, ProviderConfigInfo, ProvidersConfigMap } from "../types";

/**
 * Schema conformance tests for provider types.
 *
 * These tests ensure that the Zod schemas preserve all fields when parsing data.
 * oRPC uses these schemas for output validation and strips fields not in the schema,
 * so any field present in the TypeScript type MUST be present in the schema.
 *
 * If these tests fail, it means the schema is missing fields that the backend
 * service returns, which would cause data loss when crossing the IPC boundary.
 */
describe("ProviderConfigInfoSchema conformance", () => {
  it("preserves all AWSCredentialStatus fields", () => {
    const full: AWSCredentialStatus = {
      region: "us-east-1",
      profile: "my-sso-profile",
      bearerTokenSet: true,
      accessKeyIdSet: true,
      secretAccessKeySet: false,
    };

    const parsed = AWSCredentialStatusSchema.parse(full);

    // Verify no fields were stripped
    expect(parsed).toEqual(full);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(full).sort());
  });

  it("preserves all ProviderConfigInfo fields (base case)", () => {
    const full: ProviderConfigInfo = {
      apiKeySet: true,
      isEnabled: true,
      isConfigured: true,
      baseUrl: "https://api.example.com",
      models: ["model-a", "model-b"],
    };

    const parsed = ProviderConfigInfoSchema.parse(full);

    expect(parsed).toEqual(full);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(full).sort());
  });

  it("defaults isEnabled to true when omitted", () => {
    const parsed = ProviderConfigInfoSchema.parse({
      apiKeySet: true,
      isConfigured: true,
    });

    expect(parsed.isEnabled).toBe(true);
  });

  it("preserves all ProviderConfigInfo fields (with AWS/Bedrock)", () => {
    const full: ProviderConfigInfo = {
      apiKeySet: false,
      isEnabled: true,
      isConfigured: false,
      baseUrl: undefined,
      models: [],
      aws: {
        region: "eu-west-1",
        profile: "my-sso-profile",
        bearerTokenSet: false,
        accessKeyIdSet: true,
        secretAccessKeySet: true,
      },
    };

    const parsed = ProviderConfigInfoSchema.parse(full);

    expect(parsed).toEqual(full);
    // Check nested aws object is preserved
    expect(parsed.aws).toEqual(full.aws);
  });

  it("preserves all ProviderConfigInfo fields (with couponCodeSet)", () => {
    const full: ProviderConfigInfo = {
      apiKeySet: true,
      isEnabled: true,
      isConfigured: true,
      couponCodeSet: true,
    };

    const parsed = ProviderConfigInfoSchema.parse(full);

    expect(parsed).toEqual(full);
    expect(parsed.couponCodeSet).toBe(true);
  });

  it("preserves all ProviderConfigInfo fields (full object with all optional fields)", () => {
    // This is the most comprehensive test - includes ALL possible fields
    const full: ProviderConfigInfo = {
      apiKeySet: true,
      isEnabled: true,
      isConfigured: true,
      baseUrl: "https://custom.endpoint.com",
      models: ["claude-3-opus", "claude-3-sonnet"],
      serviceTier: "flex",
      store: false,
      cacheTtl: "1h",
      disableBetaFeatures: true,
      codexOauthSet: true,
      codexOauthDefaultAuth: "apiKey",
      aws: {
        region: "ap-northeast-1",
        profile: "my-sso-profile",
        bearerTokenSet: true,
        accessKeyIdSet: true,
        secretAccessKeySet: true,
      },
      couponCodeSet: true,
    };

    const parsed = ProviderConfigInfoSchema.parse(full);

    // Deep equality check
    expect(parsed).toEqual(full);

    // Explicit field-by-field verification for clarity
    expect(parsed.apiKeySet).toBe(full.apiKeySet);
    expect(parsed.isEnabled).toBe(full.isEnabled);
    expect(parsed.baseUrl).toBe(full.baseUrl);
    expect(parsed.models).toEqual(full.models);
    expect(parsed.serviceTier).toBe(full.serviceTier);
    expect(parsed.store).toBe(full.store);
    expect(parsed.cacheTtl).toBe(full.cacheTtl);
    expect(parsed.disableBetaFeatures).toBe(full.disableBetaFeatures);
    expect(parsed.codexOauthSet).toBe(full.codexOauthSet);
    expect(parsed.codexOauthDefaultAuth).toBe(full.codexOauthDefaultAuth);
    expect(parsed.aws).toEqual(full.aws);
    expect(parsed.couponCodeSet).toBe(full.couponCodeSet);
  });

  it("preserves ProvidersConfigMap with multiple providers", () => {
    const full: ProvidersConfigMap = {
      anthropic: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: ["claude-3-opus"],
      },
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        serviceTier: "auto",
        codexOauthSet: true,
        codexOauthDefaultAuth: "oauth",
      },
      bedrock: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: false,
        aws: {
          region: "us-west-2",
          profile: "my-sso-profile",
          bearerTokenSet: false,
          accessKeyIdSet: true,
          secretAccessKeySet: true,
        },
      },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: false,
        couponCodeSet: true,
        models: ["anthropic/claude-sonnet-4-5"],
      },
    };

    const parsed = ProvidersConfigMapSchema.parse(full);

    expect(parsed).toEqual(full);
    expect(Object.keys(parsed)).toEqual(Object.keys(full));
  });
});
