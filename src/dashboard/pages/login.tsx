import { useState, type FormEvent } from "react";
import { EyeIcon, EyeOffIcon, KeyRoundIcon, Loader2Icon } from "lucide-react";
import { ErrorAlert } from "@/components/common";
import { Logo } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { admin, ApiError, setAdminKey } from "@/lib/api";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await admin("admin_overview", {}, trimmed);
      setAdminKey(trimmed);
      onLogin();
    } catch (err) {
      const status = (err as ApiError).status;
      setError(status === 401 || status === 403 ? "That is not the admin key for this server." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-3">
          <Logo />
          <div>
            <CardTitle>Sign in</CardTitle>
            <CardDescription className="mt-1.5">
              Enter this server's admin key. <code className="font-mono text-xs">incibase dev</code> prints it on start, or
              run <code className="font-mono text-xs">incibase admin-key</code> in the project.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="key">Admin key</Label>
              <div className="relative">
                <KeyRoundIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="key"
                  type={show ? "text" : "password"}
                  autoFocus
                  autoComplete="current-password"
                  placeholder="ik_admin_…"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  className="px-8 font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShow(!show)}
                  className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={show ? "Hide key" : "Show key"}
                >
                  {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                </button>
              </div>
            </div>
            {error && <ErrorAlert error={error} />}
            <Button type="submit" className="w-full" disabled={busy || !key.trim()}>
              {busy && <Loader2Icon className="animate-spin" />}
              {busy ? "Checking…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
