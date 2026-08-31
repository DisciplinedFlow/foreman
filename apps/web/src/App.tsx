import { Routes, Route } from "react-router-dom";
import { Login } from "./pages/Login.js";
import { Projects } from "./pages/Projects.js";
import { ProjectView } from "./pages/ProjectView.js";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Projects />} />
      <Route path="/projects/:id" element={<ProjectView />} />
    </Routes>
  );
}
