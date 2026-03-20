import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export interface HookConfigDiscoveryOptions {
  readonly projectDir?: string
  readonly platform?: string
  readonly homeDir?: string
  readonly appDataDir?: string
  readonly exists?: (filePath: string) => boolean
}

export interface HookConfigPaths {
  readonly global?: string
  readonly project?: string
}

export function resolveHookConfigPaths(options: HookConfigDiscoveryOptions = {}): HookConfigPaths {
  const exists = options.exists ?? existsSync
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? os.homedir()
  const appDataDir = options.appDataDir ?? process.env.APPDATA
  const globalConfigDir = path.join(homeDir, ".config", "opencode", "hook")
  const projectDir = options.projectDir

  const preferredGlobal = path.join(globalConfigDir, "hooks.yaml")

  const appDataGlobal = platform === "win32" && appDataDir
    ? path.join(appDataDir, "opencode", "hook", "hooks.yaml")
    : undefined

  return {
    global: platform === "win32" && appDataGlobal && !exists(preferredGlobal) ? appDataGlobal : preferredGlobal,
    project: projectDir ? path.join(projectDir, ".opencode", "hook", "hooks.yaml") : undefined,
  }
}

export function discoverHookConfigPaths(options: HookConfigDiscoveryOptions = {}): string[] {
  const exists = options.exists ?? existsSync
  const paths = resolveHookConfigPaths(options)

  return [paths.global, paths.project].filter((filePath): filePath is string => Boolean(filePath && exists(filePath)))
}
