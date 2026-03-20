export const MUTATION_TOOL_NAMES = new Set(["write", "edit", "multiedit", "apply_patch"])

export function getToolAffectedPaths(toolName: string, args: Record<string, unknown>): string[] {
  if (!["write", "edit", "multiedit"].includes(toolName)) {
    if (toolName !== "apply_patch") {
      return []
    }

    const patchText = pickString(args.patchText, args.patch, args.diff)
    return patchText ? parsePatchPaths(patchText) : []
  }

  const filePath = pickString(args.filePath, args.file_path, args.path, args.file)
  return filePath ? [filePath] : []
}

function pickString(...values: unknown[]): string | undefined {
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0)
  return typeof value === "string" ? value : undefined
}

function parsePatchPaths(patchText: string): string[] {
  const paths = new Set<string>()

  for (const line of patchText.split("\n")) {
    const match = line.match(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/)
    if (match?.[1]) {
      paths.add(match[1].trim())
    }
  }

  return Array.from(paths)
}
