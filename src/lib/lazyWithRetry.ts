import { lazy, type ComponentType } from "react";

// After a new version is deployed, a tab that was already open still points at the old page files,
// which no longer exist. Reload once to pick up the new version instead of showing an error page.
export function lazyWithRetry<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      return await factory();
    } catch (error) {
      let alreadyTried = false;
      try {
        const last = Number(sessionStorage.getItem("page-reload-at") || 0);
        alreadyTried = Date.now() - last < 10000;
        if (!alreadyTried) sessionStorage.setItem("page-reload-at", String(Date.now()));
      } catch {
        alreadyTried = true;
      }
      if (alreadyTried) throw error;
      window.location.reload();
      return new Promise<{ default: T }>(() => {});
    }
  });
}
