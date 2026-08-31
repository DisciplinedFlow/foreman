import { useParams } from "react-router-dom";

// Placeholder shell — Gantt and Agent tabs land in Tasks 7-10.
export function ProjectView() {
  const { id } = useParams();
  return (
    <main style={{ padding: 16 }}>
      <h1>Project {id}</h1>
    </main>
  );
}
