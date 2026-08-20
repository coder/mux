import * as path from "node:path";
import { SUPPORTED_SHUX_PROTOCOL_SCHEMES } from "@/common/compat/legacyMux";

export interface ShuxProtocolRegistrationContext {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  defaultApp: boolean | undefined;
  argv: string[];
  execPath: string;
}

export interface ShuxProtocolRegistrationCommand {
  executable: string;
  args: string[];
}

export function getShuxProtocolClientRegistration(
  context: ShuxProtocolRegistrationContext
): ShuxProtocolRegistrationCommand | null {
  if (!context.isPackaged && context.defaultApp && context.argv[1]) {
    const appEntryPath = path.resolve(context.argv[1]);

    if (context.platform === "win32") {
      // SECURITY AUDIT: Windows protocol registration appends the shux:// or mux:// URL after these args.
      // Prefix the handoff with `--` so Electron/Chromium stops flag parsing before the app path
      // and attacker-controlled deep link, preserving the existing argv shape for the app itself.
      return {
        executable: context.execPath,
        args: ["--", appEntryPath],
      };
    }

    return {
      executable: context.execPath,
      args: [appEntryPath],
    };
  }

  return null;
}

export function getShuxDeepLinksFromArgv(argv: string[]): string[] {
  return argv.filter((arg) =>
    SUPPORTED_SHUX_PROTOCOL_SCHEMES.some((scheme) => arg.startsWith(`${scheme}:`))
  );
}
