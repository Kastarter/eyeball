"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icon";

type Theme = "dark" | "light";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    if (current === "light" || current === "dark") {
      setTheme(current);
    }
  }, []);

  function toggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem("eyeball-docs-theme", nextTheme);
    setTheme(nextTheme);
  }

  return (
    <button
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      className="icon-button"
      onClick={toggleTheme}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      type="button"
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} size={17} />
    </button>
  );
}
