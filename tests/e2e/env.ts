import {
  assignShuxEnvironmentValue,
  resolveShuxEnvironmentValue,
  type ShuxEnvironment,
} from "../../src/common/compat/shuxEnv";

export function getShuxE2EEnv(
  suffix: string,
  env: ShuxEnvironment = process.env
): string | undefined {
  return resolveShuxEnvironmentValue(suffix, env);
}

export function setShuxE2EEnv(env: ShuxEnvironment, suffix: string, value: string): void {
  assignShuxEnvironmentValue(env, suffix, value);
}
