import { useState, type ReactNode } from "react";
import {
  DatabaseIcon,
  FunctionSquareIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  ScrollTextIcon,
  ShapesIcon,
  SunIcon,
  TerminalSquareIcon,
  WifiOffIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useServer } from "@/lib/server";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export const NAV = [
  { id: "overview", label: "Overview", icon: LayoutDashboardIcon },
  { id: "data", label: "Data", icon: DatabaseIcon },
  { id: "functions", label: "Functions", icon: FunctionSquareIcon },
  { id: "logs", label: "Logs", icon: ScrollTextIcon },
  { id: "sql", label: "SQL", icon: TerminalSquareIcon },
  { id: "schema", label: "Schema", icon: ShapesIcon },
] as const;

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 font-semibold tracking-tight", className)}>
      <span className="relative size-5 rounded-full bg-indigo-500">
        <span className="absolute top-1 left-1 size-2 rounded-full bg-white/85" />
      </span>
      incibase
    </div>
  );
}

function NavLinks({ page, onNavigate }: { page: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(({ id, label, icon: Icon }) => (
        <a
          key={id}
          href={`#/${id}`}
          onClick={onNavigate}
          aria-current={page === id ? "page" : undefined}
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            page === id && "bg-accent font-medium text-foreground",
          )}
        >
          <Icon className="size-4" />
          {label}
        </a>
      ))}
    </nav>
  );
}

function ThemeMenu() {
  const { theme, setTheme, resolved } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Theme">
          {resolved === "dark" ? <MoonIcon /> : <SunIcon />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          <DropdownMenuRadioItem value="light">
            <SunIcon /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ServerStatus() {
  const { online, version } = useServer();
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className={cn("size-2 shrink-0 rounded-full", online ? "bg-success" : "bg-destructive animate-pulse")} />
      <span className="truncate">
        {location.host}
        {version && <span className="opacity-70"> · v{version}</span>}
      </span>
    </div>
  );
}

function SidebarFooter({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="mt-auto space-y-2 border-t pt-3">
      <ServerStatus />
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" className="-ml-2 h-8 text-muted-foreground" onClick={onSignOut}>
          <LogOutIcon /> Sign out
        </Button>
        <ThemeMenu />
      </div>
    </div>
  );
}

export function AppShell({ page, onSignOut, children }: { page: string; onSignOut: () => void; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { online } = useServer();
  return (
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 flex-col gap-5 border-r bg-card/50 px-3 py-4 md:flex">
        <Logo className="px-2.5" />
        <NavLinks page={page} />
        <SidebarFooter onSignOut={onSignOut} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:hidden">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setMenuOpen(true)} aria-label="Menu">
            <MenuIcon />
          </Button>
          <Logo />
        </header>
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent side="left" className="w-64 gap-5 px-3 py-4">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Dashboard pages</SheetDescription>
            <Logo className="px-2.5" />
            <NavLinks page={page} onNavigate={() => setMenuOpen(false)} />
            <SidebarFooter onSignOut={onSignOut} />
          </SheetContent>
        </Sheet>

        {!online && (
          <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning">
            <WifiOffIcon className="size-4" /> Can't reach the server. Retrying… (it may be restarting)
          </div>
        )}
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
