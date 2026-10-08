/**
 * The on/off switch for the integration, read from one environment value
 * (Samskara: `BEADS_INTEGRATION`). ON by default; `0`, `false`, `off` or `no`
 * (any case, surrounding space ignored) turns it off. Any other value is on.
 */
const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

export interface BeadsSetting {
  enabled: boolean;
  /** True when the value was set; false when the default applied. */
  explicit: boolean;
}

export function beadsSetting(raw: string | undefined): BeadsSetting {
  const value = raw?.trim().toLowerCase() ?? '';
  if (!value) return { enabled: true, explicit: false };
  return { enabled: !OFF_VALUES.has(value), explicit: true };
}

/**
 * The one startup line for the switch and the source-control precondition.
 * `variable` is the environment variable's name, so the line says how to
 * change it.
 */
export function beadsStartupLine(setting: BeadsSetting, sourceControlConfigured: boolean, variable = 'BEADS_INTEGRATION'): string {
  if (!setting.enabled) return `[beads] off (${variable} is set to turn it off).`;
  const how = setting.explicit ? `on (${variable} is set)` : 'on by default';
  if (!sourceControlConfigured) {
    return `[beads] ${how}, but the GitHub App is not configured, so the integration is idle. Set ${variable}=0 to turn it off.`;
  }
  return `[beads] ${how}; set ${variable}=0 to turn it off.`;
}
