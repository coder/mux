import type { JSX } from "react";
import { useState, useEffect } from "react";
import {
  Modal,
  View,
  TextInput,
  ScrollView,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { Picker } from "@react-native-picker/picker";
import { useTheme } from "../theme";
import { ThemedText } from "./ThemedText";
import {
  RUNTIME_MODE,
  type RuntimeMode,
  buildRuntimeString,
  parseRuntimeModeAndHost,
} from "../types/runtime";
import { loadRuntimePreference } from "../utils/workspacePreferences";

interface NewWorkspaceModalProps {
  visible: boolean;
  projectPath: string;
  projectName: string;
  branches: string[];
  defaultTrunk?: string;
  loadError?: string | null;
  onClose: () => void;
  onCreate: (branchName: string, trunkBranch: string, runtime?: string) => Promise<void>;
}

export function NewWorkspaceModal({
  visible,
  projectPath,
  projectName,
  branches,
  defaultTrunk,
  loadError,
  onClose,
  onCreate,
}: NewWorkspaceModalProps): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;

  const [branchName, setBranchName] = useState("");
  const [trunkBranch, setTrunkBranch] = useState(defaultTrunk ?? branches[0] ?? "");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(RUNTIME_MODE.LOCAL);
  const [sshHost, setSshHost] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasBranches = branches.length > 0;

  // Update trunk branch when branches or defaultTrunk change
  useEffect(() => {
    const fallbackTrunk = defaultTrunk ?? branches[0] ?? "";
    setTrunkBranch((current) => {
      const trimmedCurrent = current.trim();

      if (!hasBranches) {
        return trimmedCurrent.length === 0 ? fallbackTrunk : current;
      }

      if (trimmedCurrent.length === 0 || !branches.includes(trimmedCurrent)) {
        return fallbackTrunk;
      }

      return current;
    });
  }, [branches, defaultTrunk, hasBranches]);

  // Update error when loadError changes
  useEffect(() => {
    setError(loadError ?? null);
  }, [loadError]);

  // Reset form when modal opens and load runtime preference
  useEffect(() => {
    if (visible) {
      setBranchName("");
      setTrunkBranch(defaultTrunk ?? branches[0] ?? "");
      setError(loadError ?? null);

      // Load saved runtime preference asynchronously
      void (async () => {
        try {
          const savedRuntime = await loadRuntimePreference(projectPath);
          if (savedRuntime) {
            const parsed = parseRuntimeModeAndHost(savedRuntime);
            setRuntimeMode(parsed.mode);
            setSshHost(parsed.host);
          } else {
            setRuntimeMode(RUNTIME_MODE.LOCAL);
            setSshHost("");
          }
        } catch (error) {
          console.error("Failed to load runtime preference:", error);
          setRuntimeMode(RUNTIME_MODE.LOCAL);
          setSshHost("");
        }
      })();
    }
  }, [visible, defaultTrunk, branches, loadError, projectPath]);

  const handleCancel = () => {
    setBranchName("");
    setTrunkBranch(defaultTrunk ?? branches[0] ?? "");
    setRuntimeMode(RUNTIME_MODE.LOCAL);
    setSshHost("");
    setError(loadError ?? null);
    onClose();
  };

  const handleCreate = async () => {
    const trimmedBranchName = branchName.trim();
    if (trimmedBranchName.length === 0) {
      setError("Branch name is required");
      return;
    }

    const normalizedTrunkBranch = trunkBranch.trim();
    if (normalizedTrunkBranch.length === 0) {
      setError("Trunk branch is required");
      return;
    }

    // Validate SSH host if SSH runtime selected
    if (runtimeMode === RUNTIME_MODE.SSH) {
      const trimmedHost = sshHost.trim();
      if (trimmedHost.length === 0) {
        setError("SSH host is required (e.g., hostname or user@host)");
        return;
      }
    }

    setIsLoading(true);
    setError(null);

    try {
      const runtime = buildRuntimeString(runtimeMode, sshHost);
      await onCreate(trimmedBranchName, normalizedTrunkBranch, runtime);
      // Reset form on success
      setBranchName("");
      setTrunkBranch(defaultTrunk ?? branches[0] ?? "");
      setRuntimeMode(RUNTIME_MODE.LOCAL);
      setSshHost("");
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create workspace";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={handleCancel}
      presentationStyle="pageSheet"
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
          {/* Header */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: spacing.md,
              paddingTop: spacing.lg,
              paddingBottom: spacing.lg,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.borderSubtle,
            }}
          >
            <TouchableOpacity
              onPress={handleCancel}
              disabled={isLoading}
              style={{ paddingHorizontal: spacing.sm }}
            >
              <ThemedText style={{ fontSize: 17, color: theme.colors.accent }}>Cancel</ThemedText>
            </TouchableOpacity>
            <ThemedText style={{ fontSize: 17, fontWeight: "600" }}>New Workspace</ThemedText>
            <TouchableOpacity
              onPress={() => void handleCreate()}
              disabled={
                isLoading || branchName.trim().length === 0 || trunkBranch.trim().length === 0
              }
              style={{ paddingHorizontal: spacing.sm }}
            >
              <ThemedText
                style={{
                  fontSize: 17,
                  color:
                    isLoading || branchName.trim().length === 0 || trunkBranch.trim().length === 0
                      ? theme.colors.foregroundMuted
                      : theme.colors.accent,
                  fontWeight: "600",
                }}
              >
                {isLoading ? "Creating..." : "Create"}
              </ThemedText>
            </TouchableOpacity>
          </View>

          {/* Project name */}
          <View
            style={{
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.md,
              backgroundColor: theme.colors.surfaceSunken,
            }}
          >
            <ThemedText style={{ fontSize: 13, opacity: 0.7, marginBottom: 2 }}>PROJECT</ThemedText>
            <ThemedText style={{ fontSize: 15 }}>{projectName}</ThemedText>
          </View>

          {/* Form */}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{
              padding: spacing.lg,
            }}
          >
            {/* Workspace Branch Name */}
            <View style={{ marginBottom: spacing.lg }}>
              <ThemedText
                style={{
                  fontSize: 12,
                  opacity: 0.6,
                  marginBottom: spacing.xs,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                Workspace Branch Name
              </ThemedText>
              <TextInput
                value={branchName}
                onChangeText={(value) => {
                  setBranchName(value);
                  setError(null);
                }}
                placeholder="feature-name"
                placeholderTextColor={theme.colors.foregroundMuted}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isLoading}
                style={{
                  backgroundColor: theme.colors.background,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  borderRadius: 8,
                  paddingHorizontal: spacing.md,
                  paddingVertical: 12,
                  fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                  fontSize: 14,
                  color: theme.colors.foregroundPrimary,
                }}
              />
              {error && (
                <ThemedText
                  style={{ fontSize: 13, color: theme.colors.danger, marginTop: spacing.xs }}
                >
                  {error}
                </ThemedText>
              )}
            </View>

            {/* Trunk Branch */}
            <View style={{ marginBottom: spacing.lg }}>
              <ThemedText
                style={{
                  fontSize: 12,
                  opacity: 0.6,
                  marginBottom: spacing.xs,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                Trunk Branch
              </ThemedText>
              {hasBranches ? (
                <View
                  style={{
                    backgroundColor: theme.colors.background,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    borderRadius: 8,
                    overflow: "hidden",
                  }}
                >
                  <Picker
                    selectedValue={trunkBranch}
                    onValueChange={(value) => setTrunkBranch(value)}
                    enabled={!isLoading}
                    style={{
                      color: theme.colors.foregroundPrimary,
                    }}
                    itemStyle={{
                      fontSize: 14,
                      color: theme.colors.foregroundPrimary,
                    }}
                  >
                    {branches.map((branch) => (
                      <Picker.Item key={branch} label={branch} value={branch} />
                    ))}
                  </Picker>
                </View>
              ) : (
                <>
                  <TextInput
                    value={trunkBranch}
                    onChangeText={setTrunkBranch}
                    placeholder="main"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!isLoading}
                    style={{
                      backgroundColor: theme.colors.background,
                      borderWidth: 1,
                      borderColor: theme.colors.border,
                      borderRadius: 8,
                      paddingHorizontal: spacing.md,
                      paddingVertical: 12,
                      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                      fontSize: 14,
                      color: theme.colors.foregroundPrimary,
                    }}
                  />
                  {loadError && (
                    <ThemedText
                      style={{
                        fontSize: 13,
                        color: theme.colors.danger,
                        marginTop: spacing.xs,
                      }}
                    >
                      No branches detected. Enter trunk branch manually.
                    </ThemedText>
                  )}
                </>
              )}
            </View>

            {/* Runtime Mode */}
            <View style={{ marginBottom: spacing.lg }}>
              <ThemedText
                style={{
                  fontSize: 12,
                  opacity: 0.6,
                  marginBottom: spacing.xs,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                Runtime
              </ThemedText>
              <View
                style={{
                  backgroundColor: theme.colors.background,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                <Picker
                  selectedValue={runtimeMode}
                  onValueChange={(value) => {
                    setRuntimeMode(value);
                    setError(null);
                  }}
                  enabled={!isLoading}
                  style={{
                    color: theme.colors.foregroundPrimary,
                  }}
                  itemStyle={{
                    fontSize: 14,
                    color: theme.colors.foregroundPrimary,
                  }}
                >
                  <Picker.Item label="Local" value={RUNTIME_MODE.LOCAL} />
                  <Picker.Item label="SSH Remote" value={RUNTIME_MODE.SSH} />
                </Picker>
              </View>
            </View>

            {/* SSH Host (conditional) */}
            {runtimeMode === RUNTIME_MODE.SSH && (
              <View style={{ marginBottom: spacing.lg }}>
                <ThemedText
                  style={{
                    fontSize: 12,
                    opacity: 0.6,
                    marginBottom: spacing.xs,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  SSH Host
                </ThemedText>
                <TextInput
                  value={sshHost}
                  onChangeText={(value) => {
                    setSshHost(value);
                    setError(null);
                  }}
                  placeholder="hostname or user@hostname"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  editable={!isLoading}
                  style={{
                    backgroundColor: theme.colors.background,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    borderRadius: 8,
                    paddingHorizontal: spacing.md,
                    paddingVertical: 12,
                    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                    fontSize: 14,
                    color: theme.colors.foregroundPrimary,
                  }}
                />
                <ThemedText
                  style={{
                    fontSize: 13,
                    opacity: 0.6,
                    marginTop: spacing.xs,
                  }}
                >
                  Workspace will be created at ~/cmux/{branchName || "<branch-name>"} on remote host
                </ThemedText>
              </View>
            )}

            {/* Loading indicator */}
            {isLoading && (
              <View
                style={{
                  marginTop: spacing.lg,
                  alignItems: "center",
                }}
              >
                <ActivityIndicator size="large" color={theme.colors.accent} />
                <ThemedText
                  style={{
                    fontSize: 13,
                    opacity: 0.7,
                    marginTop: spacing.sm,
                  }}
                >
                  Creating workspace...
                </ThemedText>
              </View>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
