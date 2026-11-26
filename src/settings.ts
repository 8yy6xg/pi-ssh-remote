import { registerExtensionSettings } from "@99percentpeople/pi-shared-settings";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SSH_REMOTE_SETTINGS_NAMESPACE,
  type SshRemoteConfig,
} from "./config.ts";
import type { ReconnectJitter, ReconnectPolicy } from "./reconnect.ts";
import type { SshTransportPreference } from "./transport/client.ts";

const TRANSPORT_LABELS: Record<SshTransportPreference, string> = {
  auto: "Auto",
  openssh: "OpenSSH",
  ssh2: "ssh2",
};

interface SshRemoteSettingsController {
  getConfig(): SshRemoteConfig;
  updateConfig(config: SshRemoteConfig, ctx: ExtensionContext): void;
}

function transportForLabel(value: string): SshTransportPreference | undefined {
  return (Object.entries(TRANSPORT_LABELS) as Array<[SshTransportPreference, string]>)
    .find(([, label]) => label === value)?.[0];
}

function booleanForLabel(value: string): boolean | undefined {
  if (value === "On") return true;
  if (value === "Off") return false;
  return undefined;
}

function booleanLabel(value: boolean): string {
  return value ? "On" : "Off";
}

const INITIAL_DELAY_PRESETS_MS = [500, 1_000, 2_000, 5_000] as const;
const MAX_DELAY_PRESETS_MS = [10_000, 30_000, 60_000, 120_000] as const;
const MULTIPLIER_PRESETS = [1.5, 2, 3] as const;
const MAX_ATTEMPTS_PRESETS = [0, 3, 5, 10, 20] as const;
const JITTER_LABELS: Record<ReconnectJitter, string> = {
  full: "Full",
  none: "None",
};

function formatDelayMs(value: number): string {
  if (value % 1000 === 0) return `${value / 1000}s`;
  if (value >= 1000 && value % 100 === 0) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
}

function parseDelayMs(value: string): number | undefined {
  const seconds = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(value);
  if (seconds) {
    const ms = Number(seconds[1]) * 1000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  const millis = /^([0-9]+)ms$/.exec(value);
  if (millis) return Number(millis[1]);
  return undefined;
}

function formatMaxAttempts(value: number): string {
  return value === 0 ? "Unlimited" : String(value);
}

function parseMaxAttempts(value: string): number | undefined {
  if (value === "Unlimited") return 0;
  if (!/^[0-9]+$/.test(value)) return undefined;
  return Number(value);
}

function parseMultiplier(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : undefined;
}

function withCurrent(labels: string[], current: string): string[] {
  return labels.includes(current) ? labels : [current, ...labels];
}

function delayLabels(presets: readonly number[], current: number): string[] {
  return withCurrent(presets.map(formatDelayMs), formatDelayMs(current));
}

function jitterForLabel(value: string): ReconnectJitter | undefined {
  if (value === "Full") return "full";
  if (value === "None") return "none";
  return undefined;
}

function updateReconnect(
  config: SshRemoteConfig,
  patch: Partial<ReconnectPolicy>,
): SshRemoteConfig {
  return { ...config, reconnect: { ...config.reconnect, ...patch } };
}

export function registerSshRemoteSettings(
  pi: ExtensionAPI,
  controller: SshRemoteSettingsController,
): void {
  registerExtensionSettings(pi, {
    namespace: SSH_REMOTE_SETTINGS_NAMESPACE,
    title: "SSH Remote",
    settings: () => [{
      id: "transport",
      label: "Transport",
      description: "Auto uses multiplexed OpenSSH on Unix and persistent ssh2 on Windows",
      currentValue: TRANSPORT_LABELS[controller.getConfig().transport],
      values: Object.values(TRANSPORT_LABELS),
    }, {
      id: "passwordPrompt",
      label: "Password prompt",
      description: "Ask for an SSH password in the TUI when key/agent authentication fails",
      currentValue: booleanLabel(controller.getConfig().passwordPrompt),
      values: ["On", "Off"],
    }, {
      id: "persistPasswords",
      label: "Persist passwords",
      description: "Save entered passwords to a restricted secrets file so -r resumes reuse them without re-asking",
      currentValue: booleanLabel(controller.getConfig().persistPasswords),
      values: ["On", "Off"],
    }, {
      id: "aiControlTools",
      label: "AI control tools",
      description: "Let the model connect, exit, inspect, and change the cwd of SSH environments",
      currentValue: booleanLabel(controller.getConfig().aiControlTools),
      values: ["On", "Off"],
    }, {
      id: "aiPasswordAuth",
      label: "AI password auth",
      description: "Allow model-triggered SSH connections to request a password when key authentication fails",
      currentValue: booleanLabel(controller.getConfig().aiPasswordAuth),
      values: ["On", "Off"],
    }, {
      id: "reconnect.enabled",
      label: "Auto-reconnect",
      description: "Automatically reconnect after unexpected SSH connection loss. Does not retry after /ssh-exit, authentication failure, or a host-key change",
      currentValue: booleanLabel(controller.getConfig().reconnect.enabled),
      values: ["On", "Off"],
    }, {
      id: "reconnect.initialDelayMs",
      label: "Reconnect initial delay",
      description: "Wait this long before the first automatic reconnect attempt",
      currentValue: formatDelayMs(controller.getConfig().reconnect.initialDelayMs),
      values: delayLabels(INITIAL_DELAY_PRESETS_MS, controller.getConfig().reconnect.initialDelayMs),
    }, {
      id: "reconnect.multiplier",
      label: "Reconnect backoff multiplier",
      description: "Multiply the delay after each failed automatic reconnect attempt",
      currentValue: String(controller.getConfig().reconnect.multiplier),
      values: withCurrent(
        MULTIPLIER_PRESETS.map(String),
        String(controller.getConfig().reconnect.multiplier),
      ),
    }, {
      id: "reconnect.maxDelayMs",
      label: "Reconnect max delay",
      description: "Cap the automatic reconnect backoff at this interval",
      currentValue: formatDelayMs(controller.getConfig().reconnect.maxDelayMs),
      values: delayLabels(MAX_DELAY_PRESETS_MS, controller.getConfig().reconnect.maxDelayMs),
    }, {
      id: "reconnect.maxAttempts",
      label: "Reconnect max attempts",
      description: "Stop after this many automatic reconnect attempts. Unlimited keeps retrying until the connection returns, you exit, or auto-reconnect is turned off",
      currentValue: formatMaxAttempts(controller.getConfig().reconnect.maxAttempts),
      values: withCurrent(
        MAX_ATTEMPTS_PRESETS.map(formatMaxAttempts),
        formatMaxAttempts(controller.getConfig().reconnect.maxAttempts),
      ),
    }, {
      id: "reconnect.jitter",
      label: "Reconnect jitter",
      description: "Full jitter randomizes each delay between 0 and the current backoff cap to avoid synchronized retries",
      currentValue: JITTER_LABELS[controller.getConfig().reconnect.jitter],
      values: Object.values(JITTER_LABELS),
    }],
    onChange: (id, value, ctx) => {
      const config = controller.getConfig();
      if (id === "transport") {
        const transport = transportForLabel(value);
        if (transport) controller.updateConfig({ ...config, transport }, ctx);
        return;
      }
      if (
        id === "passwordPrompt"
        || id === "persistPasswords"
        || id === "aiControlTools"
        || id === "aiPasswordAuth"
      ) {
        const enabled = booleanForLabel(value);
        if (enabled !== undefined) {
          controller.updateConfig({ ...config, [id]: enabled }, ctx);
        }
        return;
      }
      if (id === "reconnect.enabled") {
        const enabled = booleanForLabel(value);
        if (enabled !== undefined) {
          controller.updateConfig(updateReconnect(config, { enabled }), ctx);
        }
        return;
      }
      if (id === "reconnect.initialDelayMs") {
        const initialDelayMs = parseDelayMs(value);
        if (initialDelayMs !== undefined) {
          controller.updateConfig(updateReconnect(config, { initialDelayMs }), ctx);
        }
        return;
      }
      if (id === "reconnect.multiplier") {
        const multiplier = parseMultiplier(value);
        if (multiplier !== undefined) {
          controller.updateConfig(updateReconnect(config, { multiplier }), ctx);
        }
        return;
      }
      if (id === "reconnect.maxDelayMs") {
        const maxDelayMs = parseDelayMs(value);
        if (maxDelayMs !== undefined) {
          controller.updateConfig(updateReconnect(config, { maxDelayMs }), ctx);
        }
        return;
      }
      if (id === "reconnect.maxAttempts") {
        const maxAttempts = parseMaxAttempts(value);
        if (maxAttempts !== undefined) {
          controller.updateConfig(updateReconnect(config, { maxAttempts }), ctx);
        }
        return;
      }
      if (id === "reconnect.jitter") {
        const jitter = jitterForLabel(value);
        if (jitter) controller.updateConfig(updateReconnect(config, { jitter }), ctx);
      }
    },
  });
}

export { TRANSPORT_LABELS };
