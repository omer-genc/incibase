/// <reference lib="dom" />
// incibase admin dashboard, served at /_/ as one self-contained HTML file.
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ErrorAlert, PageHeader, TableSkeleton } from "@/components/common";
import { ConfirmProvider } from "@/components/confirm";
import { AppShell, NAV } from "@/components/layout";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getAdminKey, onUnauthorized, setAdminKey } from "@/lib/api";
import { useHashRoute } from "@/lib/hooks";
import { ServerProvider, useServer } from "@/lib/server";
import { ThemeProvider } from "@/lib/theme";
import { DataPage } from "@/pages/data";
import { FunctionsPage } from "@/pages/functions";
import { Login } from "@/pages/login";
import { LogsPage } from "@/pages/logs";
import { Overview } from "@/pages/overview";
import { SchemaPage } from "@/pages/schema";
import { SqlPage } from "@/pages/sql";

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const { page, params, navigate } = useHashRoute();
  const { app, appError, reloadApp } = useServer();
  const known = NAV.some((n) => n.id === page);

  useEffect(() => {
    if (!known) navigate("overview", { replace: true });
  }, [known, navigate]);

  useEffect(() => {
    const label = NAV.find((n) => n.id === page)?.label;
    document.title = label ? `${label} · incibase` : "incibase";
  }, [page]);

  const needsApp = page !== "overview" && page !== "logs";
  let content;
  if (needsApp && !app) {
    content = appError ? (
      <ErrorAlert error={appError} />
    ) : (
      <>
        <PageHeader title={NAV.find((n) => n.id === page)?.label ?? ""} />
        <div className="rounded-xl border bg-card">
          <TableSkeleton />
        </div>
      </>
    );
  } else if (page === "data") content = <DataPage app={app!} table={params[0]} navigate={navigate} reloadApp={reloadApp} />;
  else if (page === "functions") content = <FunctionsPage app={app!} path={params.join("/") || undefined} navigate={navigate} />;
  else if (page === "logs") content = <LogsPage />;
  else if (page === "sql") content = <SqlPage app={app!} />;
  else if (page === "schema") content = <SchemaPage app={app!} />;
  else content = <Overview navigate={navigate} />;

  return (
    <AppShell page={page} onSignOut={onSignOut}>
      {content}
    </AppShell>
  );
}

function App() {
  const [signedIn, setSignedIn] = useState(() => !!getAdminKey());
  const signOut = useCallback(() => {
    setAdminKey(null);
    setSignedIn(false);
  }, []);

  // A rejected key (e.g. another project now runs on this port) returns to sign-in.
  useEffect(() => onUnauthorized(signOut), [signOut]);

  return signedIn ? (
    <ServerProvider>
      <Dashboard onSignOut={signOut} />
    </ServerProvider>
  ) : (
    <Login onLogin={() => setSignedIn(true)} />
  );
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <TooltipProvider delayDuration={300}>
      <ConfirmProvider>
        <App />
        <Toaster position="top-center" />
      </ConfirmProvider>
    </TooltipProvider>
  </ThemeProvider>,
);
