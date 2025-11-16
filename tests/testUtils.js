"use strict";
/**
 * Shared test utilities for integration tests
 *
 * This module handles:
 * - Loading .env configuration for tests
 * - Checking TEST_INTEGRATION flag
 * - Validating required API keys
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldRunIntegrationTests = shouldRunIntegrationTests;
exports.validateApiKeys = validateApiKeys;
exports.getApiKey = getApiKey;
const dotenv_1 = require("dotenv");
const path = __importStar(require("path"));
// Load .env from project root on module import
// This runs once when the module is first imported
(0, dotenv_1.config)({ path: path.resolve(__dirname, "../.env"), quiet: true });
/**
 * Check if integration tests should run
 * Tests are skipped if TEST_INTEGRATION env var is not set
 */
function shouldRunIntegrationTests() {
    return process.env.TEST_INTEGRATION === "1";
}
/**
 * Validate required API keys are present
 * Throws if TEST_INTEGRATION is set but API keys are missing
 */
function validateApiKeys(requiredKeys) {
    if (!shouldRunIntegrationTests()) {
        return; // Skip validation if not running integration tests
    }
    const missing = requiredKeys.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(`Integration tests require the following environment variables: ${missing.join(", ")}\n` +
            `Please set them or unset TEST_INTEGRATION to skip these tests.`);
    }
}
/**
 * Get API key from environment or throw if missing (when TEST_INTEGRATION is set)
 */
function getApiKey(keyName) {
    if (!shouldRunIntegrationTests()) {
        throw new Error("getApiKey should only be called when TEST_INTEGRATION is set");
    }
    const value = process.env[keyName];
    if (!value) {
        throw new Error(`Environment variable ${keyName} is required for integration tests`);
    }
    return value;
}
//# sourceMappingURL=testUtils.js.map