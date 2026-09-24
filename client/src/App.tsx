import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Dashboard from "./pages/Dashboard";
import SongLibrary from "./pages/SongLibrary";
import SongEditor from "./pages/SongEditor";
import SetListBuilder from "./pages/SetListBuilder";
import LiveScreen from "./pages/LiveScreen";
import DjDecks from "./pages/DjDecks";
import Companion from "./pages/Companion";
import LyricCueEditor from "./pages/LyricCueEditor";
import AppLayout from "./components/AppLayout";

// Routes that get the full screen — no sidebar, no nav
const STANDALONE_ROUTES = ["/companion", "/dj", "/live"];

function Router() {
  const [location] = useLocation();
  const isStandalone = STANDALONE_ROUTES.some((r) => location.startsWith(r));

  if (isStandalone) {
    return (
      <Switch>
        <Route path="/companion" component={Companion} />
        <Route path="/dj" component={DjDecks} />
        <Route path="/live" component={LiveScreen} />
      </Switch>
    );
  }

  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/songs/new" component={SongEditor} />
        <Route path="/songs/:id" component={SongEditor} />
        <Route path="/songs" component={SongLibrary} />
        <Route path="/setlists/:id" component={SetListBuilder} />
        <Route path="/setlists" component={SetListBuilder} />
        <Route path="/songs/:id/cues" component={LyricCueEditor} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster
            theme="dark"
            toastOptions={{
              style: {
                background: "var(--md-surface-2)",
                border: "1px solid var(--md-border)",
                color: "var(--md-text)",
                fontFamily: "inherit",
              },
            }}
          />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
