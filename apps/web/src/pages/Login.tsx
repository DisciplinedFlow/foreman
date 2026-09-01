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
    <main className="container container--narrow" style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
      <div className="card card--pad stack gap-4" style={{ width: "100%", maxWidth: 380 }}>
        <div className="stack gap-2">
          <h1 style={{ fontSize: "1.6rem" }}>Foreman</h1>
          <p className="muted" style={{ margin: 0 }}>Sign in to your workspace.</p>
        </div>
        <form onSubmit={submit} className="stack gap-3">
          <label className="stack gap-2">
            Email
            <input type="email" name="email" autoComplete="email" spellCheck={false}
              value={email} autoFocus placeholder="you@company.com"
              onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button type="submit" className="btn-primary">Log in</button>
        </form>
        {error !== null && <p role="alert" className="alert" style={{ margin: 0 }}>{error}</p>}
      </div>
    </main>
  );
}
