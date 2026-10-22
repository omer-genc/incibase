import { isProduction, type BranchInfo } from "@/lib/branch";

/** A red strip across the top on production branches; nothing elsewhere (and for a single app). */
export function ProductionBanner({ branch }: { branch: BranchInfo | null | undefined }) {
  if (!isProduction(branch)) return null;
  return (
    <div
      role="status"
      data-production-banner
      className="border-b border-destructive/40 bg-destructive px-4 py-1.5 text-center text-xs font-medium text-white"
    >
      Production{branch?.label ? `: ${branch.label}` : ""}. Changes here reach real users.
    </div>
  );
}
