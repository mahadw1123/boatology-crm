import React from "react";
import ReactDOM from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc, trpcClient } from "@/lib/trpc";
import { showErrorToast } from "@/lib/errors";
import { installGlobalErrorMonitoring } from "@/lib/monitoring";
import App from "./App";
import "./index.css";

installGlobalErrorMonitoring();

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      // Most forms provide a tailored error handler. This catches the few
      // mutations that do not, without showing a duplicate toast when a page
      // already owns the recovery message.
      if (!mutation.options.onError) {
        showErrorToast(error, "The change was not saved. Return to the relevant record, refresh it, and try again.");
      }
    },
  }),
  queryCache: new QueryCache({
    onError: (error, query) => {
      // Query failures otherwise often look like an empty list. Surface the
      // real problem and a recovery action, but do not interrupt pages that
      // still have usable cached data.
      if (query.state.data === undefined) {
        showErrorToast(error, "This page could not load. Retry the page, then contact an administrator if it continues.");
      }
    },
  }),
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  </React.StrictMode>
);
