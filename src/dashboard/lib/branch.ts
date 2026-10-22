// Which branch this dashboard manages, from admin_overview. A host sets the
// label and kind per branch; a single app has neither, and the dashboard
// shows the host it was opened on as before.

export interface BranchInfo {
  /** E.g. `shop/prod`; null for a single app. */
  label: string | null;
  /** E.g. `prod`, `dev` or `preview`; null for a single app. */
  kind: string | null;
}

/** What the sidebar names this server by: the branch label, else the host the dashboard was opened on. */
export function serverName(branch: BranchInfo | null | undefined, host: string): string {
  return branch?.label || host;
}

/** Production branches get a red banner, so a change there is never mistaken for one on dev. */
export function isProduction(branch: BranchInfo | null | undefined): boolean {
  return branch?.kind === "prod";
}

/**
 * The command that adds this server to Claude Code. Built from the origin the
 * dashboard was opened on, which serves `/mcp` with the admin tools (through
 * a tunnel too), rather than from the public URL.
 */
export function mcpCommand(origin: string, adminKey: string | null): string {
  return `claude mcp add --transport http incibase ${origin}/mcp --header "Authorization: Bearer ${adminKey ?? "<admin key>"}"`;
}
