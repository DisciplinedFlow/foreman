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
    <main style={{ maxWidth: 360, margin: "10vh auto", padding: 16 }}>
      <h1>Foreman</h1>
      <form onSubmit={submit}>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            style={{ display: "block", width: "100%", margin: "8px 0", padding: 8 }} />
        </label>
        <button type="submit">Log in</button>
      </form>
      {error !== null && <p role="alert">{error}</p>}
    </main>
  );
}
