import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { Layout } from "./components";
import { EventsPage, EventPage, TicketPage } from "./PublicPages";
import {
  DashboardPage,
  EditEventPage,
  LoginPage,
  NewEventPage,
  OrganizerGate,
  OrganizerPage,
} from "./OrganizerPages";
import "./styles.css";

/** Route participant and organizer screens inside the shared application layout. */
function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<EventsPage />} />
          <Route path="/events/:id" element={<EventPage />} />
          <Route path="/tickets/:token" element={<TicketPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/organizer" element={<OrganizerGate />}>
            <Route index element={<OrganizerPage />} />
            <Route path="new" element={<NewEventPage />} />
            <Route path="events/:id" element={<DashboardPage />} />
            <Route path="events/:id/edit" element={<EditEventPage />} />
          </Route>
          <Route
            path="*"
            element={
              <div className="empty-state">
                <h1>Здесь пока пусто.</h1>
                <Link className="button" to="/">
                  К событиям
                </Link>
              </div>
            }
          />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
