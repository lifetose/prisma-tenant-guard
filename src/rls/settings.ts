import type { Tenancy } from "../tenancy.js";
import type { TenantScopes } from "../types.js";
import { quoteLiteral } from "./naming.js";

export type SettingNamer = (scope: string) => string;

export function defaultSettingName(scope: string): string {
  return `app.${scope}_id`;
}

export interface TenantSetting {
  scope: string;
  name: string;
  value: string;
}

export function tenantSettings(
  tenancy: Pick<Tenancy, "registry" | "current">,
  options: { settingName?: SettingNamer } = {},
): TenantSetting[] {
  const namer = options.settingName ?? defaultSettingName;
  const context = (tenancy.current() ?? {}) as TenantScopes;
  const settings: TenantSetting[] = [];

  for (const scope of tenancy.registry.scopeNames) {
    const value = context[scope];

    if (typeof value === "string" && value) {
      settings.push({ scope, name: namer(scope), value });
    }
  }

  return settings;
}

export function setConfigSql(setting: TenantSetting): string {
  return `SELECT set_config(${quoteLiteral(setting.name)}, ${quoteLiteral(
    setting.value,
  )}, true)`;
}

export function resetConfigSql(
  scope: string,
  options: { settingName?: SettingNamer } = {},
): string {
  const namer = options.settingName ?? defaultSettingName;

  return `SELECT set_config(${quoteLiteral(namer(scope))}, '', true)`;
}
