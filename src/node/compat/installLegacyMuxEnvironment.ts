import { installLegacyMuxEnvironmentAliases } from "@/common/compat/legacyMux";

// Process entry points import this first so canonical SHUX_* values and legacy MUX_*
// aliases agree before lazily loaded subcommands or desktop services inspect env.
installLegacyMuxEnvironmentAliases(process.env);
