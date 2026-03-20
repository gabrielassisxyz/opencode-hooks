import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export interface HookConfigDiscoveryOptions {
  readonly projectDir?: string
  readonly platform?: NodeJS.Platform
  readonly homeDir?: string
  readonly appDataDir?: string
  readonly exists?: (filePath: string) => boolean
}

export interface HookConfigPaths {
  readonly global?: string
  readonly project?: string
}

export function resolveHookConfigPaths(options: HookConfigDiscoveryOptions = {}): HookConfigPaths {
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? os.homedir()
  const appDataDir = options.appDataDir ?? process.env.APPDATA
  const globalConfigDir = path.join(homeDir, ".config", "opencode", "hook")
  const projectDir = options.projectDir

  const global = platform === "win32" && appDataDir
    ? path.join(globalConfigDir, "hooks.md")
    : path.join(globalConfigDir, "hooks.md")

  const appDataGlobal = platform === "win32" && appDataDir
    ? path.join(appDataDir, "opencode", "hook", "hooks.md")
    : undefined

  return {
    global,
    project: projectDir ? path.join(projectDir, ".opencode", "hook", "hooks.md") : undefined,
    ...(platform === "win32" && !existsSync(global) && appDataGlobal ? { global: appDataGlobal } : {}),
  }
}

export function discoverHookConfigPaths(options: HookConfigDiscoveryOptions = {}): string[] {
  const exists = options.exists ?? existsSync
  const paths = resolveHookConfigPaths(options)

  return [paths.global, paths.project].filter((filePath): filePath is string => Boolean(filePath && exists(filePath)))
}
