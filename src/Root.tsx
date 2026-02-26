import { useEffect, useMemo, useState } from "react";
import App from "./App";
import ConfigStudioPage from "./pages/ConfigStudioPage";
import "./Root.css";

type AppRoute = "chat" | "config";

function resolveRoute(hashValue: string): AppRoute {
  const normalized = hashValue.trim().toLowerCase();
  if (normalized.startsWith("#/config")) {
    return "config";
  }
  return "chat";
}

function ensureDefaultHash(): void {
  if (typeof window === "undefined") {
    return;
  }
  if (!window.location.hash) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/chat`);
  }
}

function Root() {
  const [route, setRoute] = useState<AppRoute>(() => {
    if (typeof window === "undefined") {
      return "chat";
    }
    return resolveRoute(window.location.hash);
  });

  useEffect(() => {
    ensureDefaultHash();
    const onHashChange = () => {
      setRoute(resolveRoute(window.location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  const title = useMemo(() => (route === "chat" ? "聊天控制台" : "配置工作台"), [route]);

  return (
    <div className="root-shell">
      {route === "chat" ? <App /> : <ConfigStudioPage />}
      <nav className="route-dock" aria-label="页面切换">
        <span>{title}</span>
        <a href="#/chat" className={route === "chat" ? "active" : ""}>
          聊天
        </a>
        <a href="#/config-studio" className={route === "config" ? "active" : ""}>
          配置
        </a>
      </nav>
    </div>
  );
}

export default Root;
