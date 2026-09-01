import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api.js";

export function Login() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("/auth/dev-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? "unknown user" : "login failed");
    }
  };

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center",
      background: "radial-gradient(600px 400px at 50% 30%, var(--accSoft), transparent 70%)" }}>
      <div className="stack gap-4" style={{ width: 360 }}>
        <div className="stack gap-2" style={{ alignItems: "center" }}>
          <span className="logo-tile" aria-hidden style={{ width: 40, height: 40, borderRadius: 12, boxShadow: "0 8px 24px rgba(124,92,255,0.4)" }} />
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>Foreman</div>
          <div className="muted" style={{ fontSize: 14 }}>The control plane for your agent fleet.</div>
        </div>
        <div className="card card--pad stack gap-3" style={{ borderRadius: "var(--r-lg)" }}>
          <form onSubmit={submit} className="stack gap-3">
            <label className="stack gap-2" style={{ fontSize: 12, fontWeight: 500 }}>Email
              <input type="email" name="email" autoComplete="email" spellCheck={false}
                value={email} autoFocus placeholder="you@company.com"
                onChange={(e) => setEmail(e.target.value)} /></label>
            <button type="submit" className="btn-primary">Log in</button>
            {error !== null
              ? <p role="alert" className="alert" style={{ margin: 0 }}>{error}</p>
              : <div style={{ textAlign: "center", fontSize: 12, color: "var(--t3)" }}>Dev mode — email only. SSO is on the way.</div>}
          </form>
        </div>
      </div>
    </main>
  );
}
