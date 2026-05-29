import * as path from "path";

export interface MuxProtocolRegistrationContext {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  defaultApp: boolean | undefined;
  argv: string[];
  execPath: string;
}

export interface MuxProtocolRegistrationCommand {
  executable: string;
  args: string[];
}

export function getMuxProtocolClientRegistration(
  context: MuxProtocolRegistrationContext
): MuxProtocolRegistrationCommand | null {
  if (!context.isPackaged && context.defaultApp && context.argv[1]) {
    const appEntryPath = path.resolve(context.argv[1]);

    if (context.platform === "win32") {
      // SECURITY AUDIT: Windows protocol registration appends the mux:// URL after these args.
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

export function getMuxDeepLinksFromArgv(argv: string[]): string[] {
  return argv.filter((arg) => arg.startsWith("mux:"));
}
